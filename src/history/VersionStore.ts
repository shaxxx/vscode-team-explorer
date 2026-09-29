import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { classifyError, scrubSecrets, type TfClient } from '../tf/TfClient.js';
import { decodeWithCodePage, parseInfoEncoding, ENC_BINARY } from '../ui/decode.js';
import { messageFor } from '../tf/errorMessage.js';
import { S } from '../tf/strings.js';

/** Cap on the on-disk version cache; past this, least-recently-used entries are evicted first. */
export const VERSION_CACHE_CAP_BYTES = 200 * 1024 * 1024;

export class VersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VersionError';
  }
}

export interface VersionText {
  text: string;
  /** The code page the text was decoded with; ENC_BINARY (-1) for a binary file. */
  codePage: number | undefined;
}

type Client = Pick<TfClient, 'run' | 'timeoutMs'>;

interface Entry {
  file: string;
  size: number;
  /** Last read or write, by Date.now(). Eviction order. */
  usedAt: number;
}

/**
 * A file's content as of one changeset: disk cache first, then `tf vc view`.
 *
 * A checked-in version never changes, so an entry is never invalidated, only
 * evicted, least recently used first, once the folder would exceed the cap.
 * The cache holds copies of source that is already on this disk; nothing from
 * the PAT or the wrapper ever reaches it.
 *
 * One file per version: the code page as decimal text on the first line
 * (empty when unknown), then the raw bytes exactly as `view` returned them.
 * Written to a temp name and renamed, so a reader never sees half an entry --
 * two VS Code windows share this folder.
 */
export class VersionStore {
  private index: Map<string, Entry> | undefined;
  private total = 0;
  private dir: string | undefined;
  /**
   * D19a: shares only the raw `view` BYTES in flight, one fetch per key no
   * matter how many callers join it. Each caller's OWN code page is resolved
   * separately (see `entryAt`) -- sharing the full `{bytes, codePage}` result
   * used to mean only the FIRST caller's `codePage()` callback ever ran for a
   * given key, and if that caller's session had since been aborted (its
   * callback throwing), every OTHER caller sharing the same in-flight fetch
   * -- including one from a brand new session that re-annotated right after
   * Hide -- failed with it, even though its own code page would have resolved
   * fine.
   */
  private readonly inflight = new Map<string, { bytes: Promise<Buffer>; written: boolean }>();
  private readonly codePages = new Map<string, number | undefined>();

  constructor(
    private readonly client: Client,
    /** `undefined` = no disk cache, e.g. when VS Code gives no global storage. */
    dir: string | undefined,
    private readonly log: (line: string) => void = () => {},
    private readonly capBytes = VERSION_CACHE_CAP_BYTES,
  ) {
    this.dir = dir;
  }

  static key(serverPath: string, changeset: number): string {
    // TFVC server paths are case-insensitive.
    return createHash('sha256').update(`${serverPath.toLowerCase()}@${changeset}`).digest('hex');
  }

  /**
   * The text of `serverPath` at `C<changeset>`. `codePage` is called only on a
   * cache miss, and its answer is stored with the bytes.
   */
  async textAt(
    serverPath: string,
    changeset: number,
    codePage: () => Promise<number | undefined>,
  ): Promise<VersionText> {
    const entry = await this.entryAt(serverPath, changeset, codePage);
    return { text: decodeWithCodePage(entry.bytes, entry.codePage), codePage: entry.codePage };
  }

  /**
   * The raw bytes of `serverPath` at `C<changeset>`, with the code page they
   * were tagged with -- ENC_BINARY for a binary file. Same disk cache and
   * same in-flight sharing as `textAt`; View This Version (D25) uses this
   * directly, rather than going through `textAt`'s decode, so it can write a
   * binary version's bytes to disk unchanged instead of refusing it.
   */
  async bytesAt(
    serverPath: string,
    changeset: number,
    codePage: () => Promise<number | undefined>,
  ): Promise<{ bytes: Buffer; codePage: number | undefined }> {
    return this.entryAt(serverPath, changeset, codePage);
  }

  /** The code page `tf vc info` reports at this version (F14). Kept for the session. */
  async codePageAt(serverPath: string, changeset: number): Promise<number | undefined> {
    const key = VersionStore.key(serverPath, changeset);
    if (this.codePages.has(key)) return this.codePages.get(key);
    const stdout = await this.run(['vc', 'info', serverPath, `/version:C${changeset}`]);
    const codePage = parseInfoEncoding(stdout.toString('utf8'));
    this.codePages.set(key, codePage);
    return codePage;
  }

  private entryAt(
    serverPath: string,
    changeset: number,
    codePage: () => Promise<number | undefined>,
  ): Promise<{ bytes: Buffer; codePage: number | undefined }> {
    const key = VersionStore.key(serverPath, changeset);
    const cached = this.read(key);
    if (cached) return Promise.resolve(cached);

    let fetching = this.inflight.get(key);
    if (!fetching) {
      const bytes = this.run(['vc', 'view', serverPath, '/console', `/version:C${changeset}`]);
      fetching = { bytes, written: false };
      this.inflight.set(key, fetching);
      // Cleared once the shared VIEW settles, independently of how long any
      // caller's own codePage() takes -- a failed view is still never cached
      // and still rejects every waiter (nothing here ever resolves for them).
      bytes.catch(() => {}).finally(() => {
        if (this.inflight.get(key) === fetching) this.inflight.delete(key);
      });
    }

    // D19a: THIS caller's own code page runs CONCURRENTLY with the shared
    // bytes fetch, not after it -- a cold fetch used to cost the view and the
    // info call in sequence for every caller, even though only one `view`
    // ever runs. A callback that throws (e.g. because ITS session was
    // aborted) fails only this caller's own Promise.all, never the shared
    // bytes promise or a sibling awaiting it with its own, healthy callback.
    const shared = fetching;
    const page = codePage();
    return Promise.all([shared.bytes, page]).then(([bytes, resolvedPage]) => {
      // D19a: written once -- the first caller whose OWN codePage() and the
      // shared bytes have BOTH resolved does it; a caller whose callback
      // rejected never reaches here, so it can never race this flag.
      if (!shared.written) {
        shared.written = true;
        this.write(key, bytes, resolvedPage);
      }
      return { bytes, codePage: resolvedPage };
    });
  }

  private async run(args: string[]): Promise<Buffer> {
    let result;
    try {
      result = await this.client.run(args);
    } catch (e) {
      throw new VersionError(scrubSecrets(e instanceof Error ? e.message : String(e)));
    }
    if (result.timedOut) throw new VersionError(S.commandTimedOut(this.client.timeoutMs));

    // D18d: mirrors HistoryService's own guard. A killed tf has no reliable
    // exit code (Node reports a SIGNALLED process as -1, so `classifyError`
    // below would read partial stdout as the error text) and nothing it wrote
    // is trustworthy content. Checked BEFORE classifyError and before stdout
    // is even decoded; only a byte count reaches the log, never the bytes.
    if (result.terminatedBy) {
      this.log(`version: tf was killed by ${result.terminatedBy} after writing ${result.stdout.length} bytes`);
      throw new VersionError(S.viewStopped(result.terminatedBy));
    }

    const error = classifyError(result.exitCode, result.stdout.toString('utf8'), result.stderr.toString('utf8'));
    // D18d: Phase 1's own wording for a classified failure (an expired PAT
    // names the fix) rather than tf's raw text alone.
    if (error) throw new VersionError(messageFor(error));
    return result.stdout;
  }

  /** Loads the index once. A folder that cannot be used turns the cache off, never the feature. */
  private load(): Map<string, Entry> | undefined {
    if (this.dir === undefined) return undefined;
    if (this.index) return this.index;
    const index = new Map<string, Entry>();
    let total = 0;
    try {
      mkdirSync(this.dir, { recursive: true });
      for (const name of readdirSync(this.dir)) {
        if (!name.endsWith('.bin')) continue;
        const file = join(this.dir, name);
        try {
          const st = statSync(file);
          index.set(name.slice(0, -'.bin'.length), { file, size: st.size, usedAt: st.mtimeMs });
          total += st.size;
        } catch {
          // Deleted by another window between readdir and stat.
        }
      }
    } catch (e) {
      this.log(`version cache unavailable, fetching without it: ${scrubSecrets(String(e))}`);
      this.dir = undefined;
      return undefined;
    }
    this.index = index;
    this.total = total;
    return index;
  }

  private read(key: string): { bytes: Buffer; codePage: number | undefined } | undefined {
    const entry = this.load()?.get(key);
    if (!entry) return undefined;
    let raw: Buffer;
    try {
      raw = readFileSync(entry.file);
    } catch {
      this.forget(key);
      return undefined;
    }
    const newline = raw.indexOf(10);
    const header = newline < 0 ? '' : raw.subarray(0, newline).toString('ascii');
    const codePage = header === '' ? undefined : Number(header);
    if (newline < 0 || (codePage !== undefined && !Number.isInteger(codePage))) {
      // Not an entry this code wrote. Fetch again rather than guess.
      this.forget(key);
      return undefined;
    }
    entry.usedAt = Date.now();
    return { bytes: raw.subarray(newline + 1), codePage };
  }

  private write(key: string, bytes: Buffer, codePage: number | undefined): void {
    const index = this.load();
    if (!index || this.dir === undefined) return;
    const data = Buffer.concat([Buffer.from(`${codePage ?? ''}\n`, 'ascii'), bytes]);
    if (data.length > this.capBytes) return;

    this.forget(key);
    const byAge = [...index.entries()].sort((a, b) => a[1].usedAt - b[1].usedAt);
    while (this.total + data.length > this.capBytes && byAge.length > 0) {
      const [oldKey] = byAge.shift()!;
      this.forget(oldKey);
    }

    const file = join(this.dir, `${key}.bin`);
    const temp = join(this.dir, `${key}.${randomBytes(4).toString('hex')}.tmp`);
    try {
      writeFileSync(temp, data);
      renameSync(temp, file);
    } catch (e) {
      this.log(`version cache write failed, continuing without it: ${scrubSecrets(String(e))}`);
      try {
        unlinkSync(temp);
      } catch {
        // Nothing was written.
      }
      return;
    }
    index.set(key, { file, size: data.length, usedAt: Date.now() });
    this.total += data.length;
  }

  private forget(key: string): void {
    const entry = this.index?.get(key);
    if (!entry) return;
    this.index!.delete(key);
    this.total -= entry.size;
    try {
      unlinkSync(entry.file);
    } catch {
      // Already gone: another window evicted it.
    }
  }
}

/**
 * D14: the versioned route's content source, refusing a binary version rather
 * than handing back its bytes decoded as text.
 *
 * View or Compare on an old version of a `.dll` or `.png` used to decode the
 * bytes as UTF-8 and open an editor full of U+FFFD -- megabytes of it, for a
 * large binary. `textAt` already threads the per-version code page through
 * from `tf vc info` (D6/D8) precisely so this refusal would not need another
 * call; this was the one call site that never used it.
 *
 * `Pick<VersionStore, 'textAt' | 'codePageAt'>` keeps this function testable
 * with a plain fake store and keeps it out of ServerContentProvider, which
 * would otherwise need to know what ENC_BINARY means.
 */
export function versionTextFrom(
  store: Pick<VersionStore, 'textAt' | 'codePageAt'>,
): (serverPath: string, changeset: number) => Promise<string> {
  return async (serverPath: string, changeset: number): Promise<string> => {
    const { text, codePage } = await store.textAt(serverPath, changeset, () =>
      store.codePageAt(serverPath, changeset),
    );
    if (codePage === ENC_BINARY) {
      const name = serverPath.slice(serverPath.lastIndexOf('/') + 1);
      throw new Error(S.compareBinary(name));
    }
    return text;
  };
}
