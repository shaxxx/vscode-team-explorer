import { diffArrays } from 'diff';

/**
 * Bounds on every jsdiff call in the blame engine (D11). An unbounded diff of
 * a fully rewritten large file can block the extension host for tens of
 * seconds; jsdiff returns `undefined` instead of a result once either limit
 * is hit. Exported as a typed value (not inlined) so tests can pass smaller
 * limits to exercise the give-up path without huge fixtures.
 */
export interface DiffLimits {
  maxEditLength: number;
  timeout: number;
}

export const DIFF_LIMITS: DiffLimits = { maxEditLength: 2000, timeout: 300 };

/**
 * Who a line of the newest version belongs to.
 *
 * `pending`: the walk has not reached the version that introduced it yet.
 * `atOrBefore`: the walk stopped (cancel, a failed fetch) while the line still
 * existed at changeset `id`, so it came from `id` or earlier.
 * `local`: only ever produced by remap(), for a line the user changed.
 */
export type Owner =
  | { kind: 'changeset'; id: number }
  | { kind: 'pending' }
  | { kind: 'atOrBefore'; id: number }
  | { kind: 'local' };

/** VS Code's own line breaks: CRLF, LF and a lone CR each end a line. */
export function splitLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

/**
 * Blame by walking BACKWARDS from the newest version.
 *
 * Fed newest first, one older version at a time. Diffing each older version
 * against the one before it, every line that exists in the newer version but
 * not the older one was introduced by the newer changeset. Walking backwards
 * rather than forwards is what makes the result usable before the walk ends:
 * the most recent changes -- the ones a reader usually wants -- are known
 * first, and everything not yet reached is honestly `pending`.
 */
export class BlameWalk {
  /** Per newest-version line: the changeset that introduced it, once known. */
  private readonly owner: (number | undefined)[];
  /** Per line of the version fed last: which newest-version line it is, or -1. */
  private map: number[];
  private lines: string[];
  private currentId: number;
  private state: 'walking' | 'finished' | 'stopped' = 'walking';

  constructor(newest: { id: number; lines: string[] }) {
    this.owner = newest.lines.map(() => undefined);
    this.map = newest.lines.map((_, i) => i);
    this.lines = newest.lines;
    this.currentId = newest.id;
  }

  get done(): boolean {
    return this.state !== 'walking';
  }

  /**
   * Folds in the next OLDER version. Returns `false` when the diff exceeded
   * `limits` and gave up (jsdiff returns `undefined` rather than guessing):
   * the walk then stops here, with unowned lines reading `atOrBefore` the
   * NEWER version -- `currentId`, which this call never advances past --
   * because that much is still truthfully known.
   */
  step(older: { id: number; lines: string[] }, limits: DiffLimits = DIFF_LIMITS): boolean {
    if (this.done) return false;
    const parts = diffArrays(older.lines, this.lines, limits);
    if (parts === undefined) {
      this.stop();
      return false;
    }
    const next: number[] = [];
    let at = 0;
    for (const part of parts) {
      const n = part.value.length;
      if (part.added) {
        // Only in the newer version: introduced by the newer changeset.
        for (let k = 0; k < n; k++, at++) this.claim(at, this.currentId);
      } else if (part.removed) {
        // Only in the older version: a line deleted later, not a newest-version line.
        for (let k = 0; k < n; k++) next.push(-1);
      } else {
        for (let k = 0; k < n; k++, at++) next.push(this.map[at]);
      }
    }
    this.map = next;
    this.lines = older.lines;
    this.currentId = older.id;
    return true;
  }

  /** The item's first version was reached: every line still unowned came from it. */
  finish(): void {
    if (this.done) return;
    for (let i = 0; i < this.lines.length; i++) this.claim(i, this.currentId);
    this.state = 'finished';
  }

  /** Stopped early. Unowned lines existed at the last version fed. */
  stop(): void {
    if (!this.done) this.state = 'stopped';
  }

  owners(): Owner[] {
    return this.owner.map((id): Owner => {
      if (id !== undefined) return { kind: 'changeset', id };
      return this.state === 'stopped' ? { kind: 'atOrBefore', id: this.currentId } : { kind: 'pending' };
    });
  }

  private claim(line: number, id: number): void {
    const newest = this.map[line];
    if (newest >= 0 && this.owner[newest] === undefined) this.owner[newest] = id;
  }
}
