import type { Changeset } from '../tf/parseHistory.js';
import { BlameWalk, splitLines, DIFF_LIMITS, type DiffLimits, type Owner } from './blame.js';
import { S } from '../tf/strings.js';

/** Fetches run four at a time. */
export const FETCH_CONCURRENCY = 4;

export interface VersionRef {
  id: number;
  /** The path this record printed: the name the file had THEN (F9). */
  serverPath: string;
  change: readonly string[];
}

/**
 * One version per record of an `/itemmode` file history, newest first.
 *
 * A record where the file was deleted has no content at that changeset
 * (`view` fails), so it is skipped; the walk goes straight to the version
 * before the delete.
 */
export function versionsOf(changesets: readonly Changeset[]): VersionRef[] {
  const out: VersionRef[] = [];
  for (const cs of changesets) {
    const item = cs.items[0];
    if (!item || item.change.includes('delete')) continue;
    out.push({ id: cs.id, serverPath: item.serverPath, change: item.change });
  }
  return out;
}

/**
 * Which versions need their own `vc info` for a code page (D8). The newest
 * always does. Versions at or newer than the newest `encoding` change share
 * its code page; older ones may differ.
 */
export function needsOwnCodePage(versions: readonly VersionRef[]): boolean[] {
  const newestEncoding = versions.findIndex((v) => v.change.includes('encoding'));
  return versions.map((_, i) => i === 0 || (newestEncoding !== -1 && i > newestEncoding));
}

export interface BlameProgress {
  owners: Owner[];
  /** The newest version's lines: what `owners` is indexed by. */
  baseLines: string[];
  /** Versions folded in so far. */
  done: number;
  total: number;
}

export interface BlameResult extends BlameProgress {
  /** Why the walk ended early, when it did. */
  stoppedBy?: 'cancelled' | Error;
}

export interface RunBlameOptions {
  /** Newest first; `versions[0]` is the base the owners describe. */
  versions: readonly VersionRef[];
  textOf: (version: VersionRef) => Promise<string>;
  signal?: AbortSignal;
  onProgress?: (progress: BlameProgress) => void;
  concurrency?: number;
  /** Bounds every fold's diff (D11). Defaults to `DIFF_LIMITS`. */
  limits?: DiffLimits;
}

/**
 * Fetches versions `concurrency` at a time but folds them strictly in order,
 * reporting after each one so the margin fills in progressively.
 *
 * Rejects only when the newest version itself cannot be read -- then there is
 * nothing to show. Any later failure, an abort, or a fold whose diff exceeded
 * `limits` ends the walk with what it has and says why.
 */
export async function runBlame(options: RunBlameOptions): Promise<BlameResult> {
  const { versions, textOf, signal, onProgress } = options;
  const concurrency = Math.max(1, options.concurrency ?? FETCH_CONCURRENCY);
  const limits = options.limits ?? DIFF_LIMITS;
  const total = versions.length;
  const fetches: Promise<string>[] = [];

  const start = (i: number): void => {
    if (i >= total || fetches[i] !== undefined) return;
    const fetching = textOf(versions[i]);
    // Awaited in order below. This only keeps a fetch that an early stop
    // abandoned from surfacing as an unhandled rejection.
    fetching.catch(() => {});
    fetches[i] = fetching;
  };

  let walk: BlameWalk | undefined;
  let baseLines: string[] = [];
  const snapshot = (done: number): BlameProgress => ({
    owners: walk ? walk.owners() : [],
    baseLines,
    done,
    total,
  });
  const stop = (done: number, why: 'cancelled' | Error): BlameResult => {
    walk?.stop();
    return { ...snapshot(done), stoppedBy: why };
  };

  // Raced against every fetch so a pending fetch can never delay a Cancel
  // click (D11). Typed `Promise<never>` so it never wins on VALUE, only on
  // timing -- `Promise.race([fetches[i], aborted])` stays a `Promise<string>`.
  let onAbort: (() => void) | undefined;
  const aborted: Promise<never> = new Promise((resolve) => {
    if (!signal) return;
    onAbort = () => resolve(undefined as never);
    signal.addEventListener('abort', onAbort);
  });

  try {
    if (signal?.aborted) return stop(0, 'cancelled');
    for (let i = 0; i < Math.min(concurrency, total); i++) start(i);

    for (let i = 0; i < total; i++) {
      if (signal?.aborted) return stop(i, 'cancelled');

      let text: string;
      try {
        text = await Promise.race([fetches[i], aborted]);
      } catch (e) {
        // An abort can race a genuine rejection from the same fetch; a
        // cancel always wins the report, never a rejection over nothing.
        if (signal?.aborted) return stop(i, 'cancelled');
        if (!walk) throw e;
        return stop(i, e instanceof Error ? e : new Error(String(e)));
      }
      // `aborted` only ever resolves after the signal fires, so this is the
      // one check that can catch it (Promise.race gave no other signal).
      if (signal?.aborted) return stop(i, 'cancelled');
      start(i + concurrency);

      const lines = splitLines(text);
      if (walk) {
        const folded = walk.step({ id: versions[i].id, lines }, limits);
        if (!folded) return stop(i, new Error(S.annotateTooDifferent(versions[i - 1].id)));
      } else {
        walk = new BlameWalk({ id: versions[i].id, lines });
        baseLines = lines;
      }
      onProgress?.(snapshot(i + 1));
      // Yields a macrotask so a Cancel click lands even when every fetch
      // above is a cache hit and the loop would otherwise never idle (D11).
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    walk?.finish();
    const result = snapshot(total);
    onProgress?.(result);
    return result;
  } finally {
    if (onAbort) signal?.removeEventListener('abort', onAbort);
  }
}
