import * as vscode from 'vscode';
import { isReadOnly } from './readOnly.js';
import { PollSet } from './pollSet.js';

export { isReadOnly } from './readOnly.js';

/**
 * Which mechanism noticed the change.
 *
 * This settled the Task 9 spike — VS Code's FileSystemWatcher DOES report an
 * attribute-only change on both machines — and is kept as a diagnostic. With
 * `usePolling` false, `'poll'` is unreachable in production, so a `via poll`
 * line means polling has been switched back on.
 */
export type ReadOnlyChange = {
  uri: vscode.Uri;
  readOnly: boolean;
  source: 'watcher' | 'poll';
};

/** How many paths to stat per tick before yielding the thread. */
const POLL_CHUNK = 250;

/**
 * Detects a file becoming writable (checked out) or read-only again (undone).
 *
 * Checkout changes ONLY the attribute — mtime is untouched — so a plain
 * content watcher could miss it. It does not: the Task 9 spike measured the
 * watcher reporting a checkout on Windows and Linux alike, and the production
 * call site now passes `usePolling: false`.
 *
 * The polling path below is therefore DORMANT, not dead. It stays, and stays
 * tested, because it is one argument from returning: `files.watcherExclude`
 * hides paths from the watcher outright, VS Code stops watching a folder
 * entirely once `fs.inotify.max_user_watches` is exhausted, and a coalesced or
 * dropped event is now permanent for that file rather than corrected on the
 * next tick.
 *
 * Two things kept polling affordable, both of which were previously missing:
 *
 *   - The tracked set is BOUNDED and membership is deliberate. Filesystem
 *     events only ever UPDATE an already-tracked path; they never add one.
 *     Previously every create/change added an entry that was never removed, so
 *     a Get Latest or an ordinary build grew it by thousands, permanently.
 *   - The poll is CHUNKED and yields between batches. Previously it stat'd the
 *     whole set synchronously on the extension-host thread every 2 s: measured
 *     244 ms at 20,000 entries, extrapolating to ~850 ms per 2 s at 70,000.
 */
export class ReadOnlyWatcher implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<ReadOnlyChange>();
  readonly onDidChange = this.emitter.event;

  private readonly disposables: vscode.Disposable[] = [];
  private readonly known = new PollSet();
  private timer: NodeJS.Timeout | undefined;
  private polling = false;
  private disposed = false;

  constructor(
    folder: vscode.WorkspaceFolder,
    usePolling: boolean,
    private readonly pollMs = 2000,
  ) {
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(folder, '**/*'),
    );
    this.disposables.push(watcher);
    this.disposables.push(watcher.onDidChange((uri) => this.check(uri)));
    this.disposables.push(watcher.onDidCreate((uri) => this.check(uri)));
    this.disposables.push(watcher.onDidDelete((uri) => this.known.forget(uri.fsPath)));

    if (usePolling) {
      this.timer = setInterval(() => void this.pollKnown(), pollMs);
    }
  }

  /** Register a file to be watched. This is the ONLY way the set grows. */
  track(uri: vscode.Uri): void {
    this.known.track(uri.fsPath, isReadOnly(uri.fsPath));
  }

  /** How many paths are currently polled. Exposed for diagnostics. */
  get trackedCount(): number {
    return this.known.size;
  }

  /** How many paths this watcher can hold, so callers can avoid wasted stats. */
  get capacity(): number {
    return this.known.capacity;
  }

  /**
   * A filesystem event updates a tracked path but never adds one — an
   * untracked path is ignored entirely, which is what bounds the set.
   */
  private check(uri: vscode.Uri): void {
    // Reject BEFORE stat-ing. isReadOnly was evaluated as an argument, so it
    // ran even for untracked paths -- the bound protected memory, not CPU, and
    // a `tf vc get` or an ordinary build writing bin/ and obj/ fires thousands
    // of events, each costing a blocking statSync on the extension-host thread
    // for a path that was then discarded. It also stat'd a SECOND time to
    // build the event.
    if (!this.known.has(uri.fsPath)) return;

    const readOnly = isReadOnly(uri.fsPath);
    if (this.known.update(uri.fsPath, readOnly)) {
      this.emitter.fire({ uri, readOnly, source: 'watcher' });
    }
  }

  /**
   * Stats the tracked set in chunks, yielding between them so a large set
   * cannot block the extension host. Overlapping ticks are skipped rather than
   * queued — if a pass is slower than the interval, running two is worse.
   */
  private async pollKnown(): Promise<void> {
    if (this.polling || this.disposed) return;
    this.polling = true;
    try {
      const paths = this.known.keys();
      for (let i = 0; i < paths.length; i += POLL_CHUNK) {
        if (this.disposed) return;
        for (const fsPath of paths.slice(i, i + POLL_CHUNK)) {
          const now = isReadOnly(fsPath);
          if (this.known.update(fsPath, now)) {
            this.emitter.fire({ uri: vscode.Uri.file(fsPath), readOnly: now, source: 'poll' });
          }
        }
        if (i + POLL_CHUNK < paths.length) {
          await new Promise((resolve) => setImmediate(resolve));
        }
      }
    } finally {
      this.polling = false;
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    this.known.clear();
    this.emitter.dispose();
    for (const d of this.disposables) d.dispose();
  }
}
