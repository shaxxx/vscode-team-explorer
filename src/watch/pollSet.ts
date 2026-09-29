/**
 * The bounded set of paths whose read-only bit is worth watching.
 *
 * Named for the poll it was built for. Since the Task 9 spike closed, the
 * production call site passes `usePolling: false` and this set bounds the
 * WATCHER's work instead — `check()` rejects any path that is not in here, so
 * membership is still what keeps a `**\/*` watcher over an 80,000-item tree
 * affordable. The measurements below describe the poll, which no longer runs.
 *
 * Two problems this exists to prevent, both measured:
 *
 * 1. UNBOUNDED GROWTH. The watcher previously recorded a path for every
 *    filesystem event from a `**\/*` watcher over the workspace root, and never
 *    removed one. Running the extension's own Get Latest Version, or any build
 *    writing bin/ and obj/, added thousands of entries permanently.
 *
 * 2. A SYNCHRONOUS POLL over that set every 2 seconds. Measured on a warm
 *    cache: 1,000 entries = 16 ms, 5,000 = 83 ms, 20,000 = 244 ms. At the
 *    ~70,000 a seeded status cache would reach, that is roughly 850 ms of
 *    blocked extension-host thread out of every 2,000 — and the extension host
 *    is shared with every other extension.
 *
 * So membership is deliberate (only what `track()` is told about — the status
 * cache and the open documents) and capped, evicting least-recently-tracked
 * first. Deliberately `vscode`-free so it can be unit-tested.
 */
export const DEFAULT_MAX_TRACKED = 2000;

export class PollSet {
  /** Insertion-ordered, which is what makes eviction least-recent-first. */
  private readonly entries = new Map<string, boolean>();

  constructor(private readonly max: number = DEFAULT_MAX_TRACKED) {}

  /**
   * The bound, so a caller can avoid preparing entries that would only be
   * evicted. Seeding used to stat every one of ~80,000 pending changes and
   * then discard all but the last 2,000.
   */
  get capacity(): number {
    return this.max;
  }

  get size(): number {
    return this.entries.size;
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  get(key: string): boolean | undefined {
    return this.entries.get(key);
  }

  /** Adds or refreshes a path, evicting the oldest if that exceeds the cap. */
  track(key: string, readOnly: boolean): void {
    // Re-inserting moves it to the end, so anything actively refreshed is the
    // last thing evicted.
    this.entries.delete(key);
    this.entries.set(key, readOnly);

    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }

  /**
   * Records a new value for an ALREADY-TRACKED path and reports whether it
   * changed. Returns false for an untracked path without adding it — that is
   * the bound: arbitrary filesystem events cannot grow the set.
   */
  update(key: string, readOnly: boolean): boolean {
    const previous = this.entries.get(key);
    if (previous === undefined) return false;
    this.entries.set(key, readOnly);
    return previous !== readOnly;
  }

  forget(key: string): void {
    this.entries.delete(key);
  }

  keys(): string[] {
    return [...this.entries.keys()];
  }

  clear(): void {
    this.entries.clear();
  }
}
