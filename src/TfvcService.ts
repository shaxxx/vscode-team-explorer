import * as vscode from 'vscode';
import { TfClient, classifyError, type TfError } from './tf/TfClient.js';
import { PathMapper, localKey, type Platform } from './tf/PathMapper.js';
import { parseStatus, parseWorkspaces } from './tf/parse.js';
import type { PendingChange, WorkingFolder } from './tf/types.js';
import { ReadOnlyWatcher } from './watch/ReadOnlyWatcher.js';
import { S } from './tf/strings.js';

export class TfvcService implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;

  private cache: PendingChange[] = [];
  private index = new Map<string, PendingChange>();
  private localIndex = new Map<string, PendingChange>();
  /**
   * Derived once. `PathMapper` needs it, and so does `localKey` -- and reading
   * it off the mapper made one expression serve as both "is there a mapper"
   * and "which platform", which is how the two got confused.
   */
  readonly platform: Platform = process.platform === 'win32' ? 'win32' : 'linux';
  private mapper: PathMapper | undefined;
  /** See `workspaceFolders`. */
  private ownFolders: readonly WorkingFolder[] = [];
  private debounce: NodeJS.Timeout | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private watcher: ReadOnlyWatcher | undefined;
  /** Disposables owned by the current watcher, replaced whenever it is. */
  private readonly watchDisposables: vscode.Disposable[] = [];

  constructor(
    private readonly client: TfClient,
    private readonly folder: vscode.WorkspaceFolder,
    private readonly collectionUrl: string,
    private readonly output: vscode.OutputChannel,
  ) {
    // A checkout done in Visual Studio changes only the read-only attribute of
    // a file that is, in the normal case, neither pending nor open in this
    // window. seedWatcher therefore never tracked it, and ReadOnlyWatcher
    // ignores filesystem events for untracked paths by design - so nothing
    // here was watching it at all, and the panel stayed stale indefinitely.
    // Observed on DEVPC: a file checked out in Visual Studio never appeared.
    //
    // Refreshing when the window regains focus catches the case that actually
    // produces this: the user works in Visual Studio and alt-tabs back. It is
    // one `status` per focus change, coalesced by the same 300 ms debounce as
    // every other trigger, and it costs nothing while the window is not used.
    //
    // It does NOT cover both windows being visible at once on two monitors
    // with no focus change between them. That needs a periodic status poll,
    // which has an ongoing cost on a workspace this size and is a separate
    // decision.
    this.disposables.push(
      vscode.window.onDidChangeWindowState((state) => {
        if (!state.focused) return;
        if (this.focusRefreshTooSoon()) {
          this.output.appendLine(
            `window focused - skipping refresh, the last status took ${this.lastRefreshMs}ms`,
          );
          return;
        }
        this.output.appendLine('window focused - refreshing');
        this.requestRefresh();
      }),
    );
  }

  get pendingChanges(): readonly PendingChange[] {
    return this.cache;
  }

  get pathMapper(): PathMapper | undefined {
    return this.mapper;
  }

  /**
   * Every mapping of the ONE workspace the opened folder belongs to, in tf's
   * own form (`Z:\…` under Wine); cloaks are never in it (they have no local
   * folder). Phase 5 asks `resolve` about exactly these. The
   * mapper above spans every workspace on this computer -- a throwaway
   * `TFVC-ACCEPT-*` one included -- and one `resolve` over two workspaces'
   * folders is not something tf was ever shown to do.
   */
  get workspaceFolders(): readonly WorkingFolder[] {
    return this.ownFolders;
  }

  /**
   * The opened workspace folder whose `vc status` this service's pending-change
   * cache covers (D18i) -- the same path `doRefresh` maps to `scope` and the
   * same one passed to `PathMapper`/`DecorationProvider` throughout
   * extension.ts. A path outside it has no pending-change answer here at all.
   */
  get workspaceRoot(): string {
    return this.folder.uri.fsPath;
  }

  /**
   * Seeds PathMapper from `workspaces` XML, then fills the cache.
   *
   * I3: a workspace change (Manage Workspace) or a Set PAT retry re-runs
   * this, and a FAILURE here must not leave the SCM panel showing the
   * previous status's pending set and Check In button -- observed after
   * Remove Mapping of the opened folder's own mapping, which fails the
   * mapping check below and used to leave the stale cache on screen
   * indefinitely, with nothing re-rendering it. `doInitialize` carries the
   * unchanged logic; this wrapper is the one place every one of its early
   * returns passes through.
   */
  async initialize(): Promise<TfError | undefined> {
    const error = await this.doInitialize();
    if (error) {
      this.cache = [];
      this.index = new Map();
      this.localIndex = new Map();
      this.changed.fire();
    }
    return error;
  }

  private async doInitialize(): Promise<TfError | undefined> {
    const result = await this.client.run([
      'vc', 'workspaces', `/collection:${this.collectionUrl}`, '/format:xml',
    ]);

    if (result.timedOut) {
      return { kind: 'timeout', originalMessage: S.commandTimedOut(this.client.timeoutMs) };
    }

    const error = classifyError(
      result.exitCode,
      result.stdout.toString('utf8'),
      result.stderr.toString('utf8'),
    );
    if (error) return error;

    let folders: WorkingFolder[];
    let own: WorkingFolder[] = [];
    try {
      const workspaces = parseWorkspaces(result.stdout);
      folders = workspaces.flatMap((w) => w.folders);
      own =
        workspaces.find(
          (w) => new PathMapper(w.folders, this.platform).toServerPath(this.folder.uri.fsPath) !== undefined,
        )?.folders ?? [];
    } catch (e) {
      return {
        kind: 'unknown',
        originalMessage: `Could not parse the workspaces output: ${(e as Error).message}`,
      };
    }

    const mapper = new PathMapper(folders, this.platform);

    // Assign ONLY on success. This used to set this.mapper first and return the
    // error without unsetting it, which left the extension in its worst state:
    // doRefresh returns undefined — success — forever, because `scope` is
    // undefined, so the panel is permanently empty and no status ever runs;
    // but AutoCheckout is already registered and consults service.pathMapper,
    // which was live. Every C:\work file edited in another root of a
    // multi-root workspace was then checked out and pended INVISIBLY, with no
    // way to see or undo it from the extension. That is the exact shape that
    // produced the 79,883 stray Adds.
    if (!mapper.toServerPath(this.folder.uri.fsPath)) {
      this.mapper = undefined;
      this.ownFolders = [];
      return { kind: 'unknown', originalMessage: S.noWorkspaceMapping };
    }

    this.mapper = mapper;
    this.ownFolders = own;

    // usePolling is FALSE since the Task 9 spike ran on both machines
    // (2026-09-17). It had defaulted to true to fail safe while the question
    // was open. VS Code's FileSystemWatcher does report an attribute-only
    // change -- a checkout, which leaves content and mtime untouched -- on
    // Windows and on Linux alike:
    //
    //   DEVPC   event 15:20:40.346, panel correct 15:20:41.332, focus 15:20:54.986
    //   FEDORA  event 15:16:51.992, panel correct 15:16:53.284, focus 15:16:58.447
    //
    // The focus refresh arriving 6 and 14 seconds later is what rules out the
    // alternative explanation; the label alone would not.
    //
    // The polling code stays, and stays tested, because this is one argument
    // away from coming back. Two known gaps make that worth keeping cheap:
    // `files.watcherExclude` hides paths from the watcher entirely, and an
    // event can be coalesced or dropped under load. Both degrade to a stale
    // panel until the next refresh rather than to anything lost, and the
    // window-focus refresh already covers that.
    //
    // initialize() runs a SECOND time after the Set PAT retry. Without this,
    // that retry left the first watcher running — two pollers on the same tree,
    // each firing requestRefresh, and the old one never reachable to stop
    // before dispose() at shutdown. Watcher-owned disposables are kept apart
    // from the rest so they can be torn down without touching anything else.
    for (const d of this.watchDisposables.splice(0)) d.dispose();

    const watcher = new ReadOnlyWatcher(this.folder, /* usePolling */ false);
    this.watcher = watcher;
    this.watchDisposables.push(watcher);
    this.watchDisposables.push(
      watcher.onDidChange((change) => {
        // Kept after the Task 9 spike rather than removed with it. `via
        // watcher` is now the expected value on both machines, so a `via poll`
        // line would mean polling had been switched back on, and its absence
        // when a checkout is made elsewhere is the first thing to look for if
        // the panel ever goes stale again. It is one line per checkout.
        this.output.appendLine(
          `read-only change: ${change.readOnly ? 'now read-only' : 'now writable'} ` +
            `via ${change.source} — ${change.uri.fsPath}`,
        );
        this.requestRefresh();
      }),
    );
    this.watchDisposables.push(
      vscode.workspace.onDidOpenTextDocument((doc) => {
        if (doc.uri.scheme === 'file') watcher.track(doc.uri);
      }),
    );

    // Return the first refresh's result rather than discarding it. Without
    // this, a failing initial `status` - PAT rejected, access denied, timeout -
    // reports success, so extension.ts never shows the error and never offers
    // the Set PAT retry. The panel just sits empty, indistinguishable from a
    // clean workspace.
    return await this.refresh();
  }

  /** Coalesces bursts of triggers into one status call. */
  requestRefresh(): void {
    // An in-flight auto-checkout cannot be cancelled by dispose(), so it
    // resolves after teardown and calls this. Without the guard that armed a
    // fresh timer AFTER dispose, spawning a 12 s recursive `status` the
    // extension no longer owns, re-seeding a disposed watcher and firing a
    // disposed emitter.
    if (this.disposed) return;
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => void this.refresh(), 300);
  }

  private inFlight: Promise<TfError | undefined> | undefined;
  private rerun = false;
  private disposed = false;

  async refresh(): Promise<TfError | undefined> {
    if (this.disposed) return undefined;
    // A second status must never run concurrently with the first: the slow
    // case is 12 s, and the later-finishing result would win regardless of age.
    if (this.inFlight) {
      this.rerun = true;
      return this.inFlight;
    }
    this.inFlight = this.doRefresh();
    try {
      return await this.inFlight;
    } finally {
      this.inFlight = undefined;
      if (this.rerun && !this.disposed) {
        this.rerun = false;
        void this.refresh();
      }
    }
  }

  /** When the last `status` finished, and how long it took. */
  private lastRefreshEndedAt = 0;
  private lastRefreshMs = 0;

  /**
   * Rate-limits the window-focus refresh to what the machine can afford.
   *
   * Measured on FEDORA when this was written: `status $/ /recursive` over
   * 4,369 files took ~5.2 s under Wine, against ~800 ms on Windows, and one
   * run took 9 s. Most of that was wineserver holding the stderr pipe, since
   * fixed in TfClient (stderr goes to a file); re-measured 2026-09-21 the same
   * status takes 0.8-1.3 s on FEDORA. Focus events arrive in bursts as the
   * user moves between windows, so at the old cost the extension spent most
   * of its life running `tf` - and a focus arriving mid-status set `rerun`,
   * which fired a second one the moment the first returned.
   *
   * The interval is the duration of the last status rather than a constant, so
   * it tunes itself to whatever the machine costs today, without a
   * per-platform number to keep in sync. Clamped so a one-off spike cannot
   * silence the refresh for minutes.
   *
   * This only gates the FOCUS path. An explicit refresh, a checkout, an undo
   * and the watcher are all unaffected - they follow something the user just
   * did, and are worth paying for.
   */
  private focusRefreshTooSoon(): boolean {
    if (this.lastRefreshEndedAt === 0) return false;
    const quiet = Math.min(Math.max(this.lastRefreshMs, 1000), 30_000);
    return Date.now() - this.lastRefreshEndedAt < quiet;
  }

  private async doRefresh(): Promise<TfError | undefined> {
    // Captured ONCE, deliberately. `initialize()` sets `this.mapper =
    // undefined` on its mapping-check failure, and that is reachable
    // concurrently -- extension.ts re-runs initialize() from the post-"Set
    // PAT" recovery while a debounced or focus-triggered refresh is sitting on
    // the await below. Re-reading `this.mapper` after that await would key
    // localIndex by raw Wine paths while every caller looks up POSIX, and on
    // FEDORA every lookup would then miss, silently, until the next successful
    // refresh. Windows is unaffected: fromWinePath is the identity there.
    const mapper = this.mapper;
    if (!mapper) return undefined;
    const scope = mapper.toServerPath(this.folder.uri.fsPath);
    if (!scope) return undefined;

    // Timed here rather than in TfClient because what the focus limiter needs
    // is the cost of THIS command specifically, and recorded in a `finally` so
    // a failure or a timeout still counts - those are the expensive ones.
    const startedAt = Date.now();
    let result;
    try {
      result = await this.client.run(['vc', 'status', scope, '/recursive', '/format:xml']);
    } finally {
      this.lastRefreshMs = Date.now() - startedAt;
      this.lastRefreshEndedAt = Date.now();
    }

    if (result.timedOut) {
      return { kind: 'timeout', originalMessage: S.commandTimedOut(this.client.timeoutMs) };
    }

    // `status` exits 0 even when nothing is pending, so emptiness comes from
    // the XML, never the exit code.
    const error = classifyError(
      result.exitCode,
      result.stdout.toString('utf8'),
      result.stderr.toString('utf8'),
    );
    if (error) {
      this.output.appendLine(`status failed: ${error.originalMessage}`);
      return error;
    }

    try {
      this.cache = parseStatus(result.stdout);
    } catch (e) {
      return {
        kind: 'unknown',
        originalMessage: `Could not parse the status output: ${(e as Error).message}`,
      };
    }
    // TFVC is case-insensitive; index on lower case so a lookup coming from
    // toServerPath hits regardless of how tf happened to case the path.
    this.index = new Map(this.cache.map((c) => [c.serverItem.toLowerCase(), c]));
    // The same cache keyed the other way round. A FileDecorationProvider will
    // be handed a local Uri once per visible row (Task 5), and answering that
    // by walking the cache is O(n) against a list that has held 79,929
    // entries; building it costs 22 ms at 79,929 entries and 0.9 ms at 4,369
    // (synthetic benchmark on DEVPC, 2026-09-17).
    this.localIndex = new Map(
      this.cache.map((c) => [localKey(mapper.fromWinePath(c.localPath), this.platform), c]),
    );
    // The byte count TfClient logs says nothing about what was understood.
    // A panel that disagrees with `tfp vc status` in a terminal is otherwise
    // indistinguishable from one that never refreshed at all.
    this.output.appendLine(`status: ${this.cache.length} pending change(s)`);
    this.seedWatcher(mapper);
    this.changed.fire();
    return undefined;
  }

  /**
   * The poll set is the status cache UNION the open documents.
   *
   * Note what that does NOT include: a file that is neither pending nor open.
   * An earlier version of this comment claimed the union covered "a file
   * checked out externally that is not pending yet"; it covers such a file
   * only while it is open in an editor. A checkout performed in Visual Studio
   * on any other file is invisible to both the poll and the filesystem
   * watcher, and the window-focus refresh in the constructor exists because of
   * it.
   *
   * @param mapper the mapper THIS refresh was built with, not `this.mapper` --
   *   the two can differ. `doRefresh` captures it before its await precisely so
   *   the index and the watcher seed cannot end up keyed differently, and
   *   reading the field again here would reopen that gap on the watcher side.
   */
  private seedWatcher(mapper: PathMapper): void {
    if (!this.watcher) return;

    // Seed at most what the poll set can HOLD. track() performs a synchronous
    // statSync per path, so looping the whole cache did ~80,000 blocking stats
    // on the extension-host thread — measured 15.3 ms per 1,000, so ~1.2 s of
    // frozen window — and then immediately evicted all but the last 2,000.
    // PollSet bounds membership; it cannot bound work the caller does before
    // handing a path over. Capping here is what makes the bound mean anything.
    //
    // Open documents are seeded LAST and are the ones the user is actually
    // looking at, so they survive eviction.
    const open = [...vscode.workspace.textDocuments].filter((d) => d.uri.scheme === 'file');
    const room = Math.max(0, this.watcher.capacity - open.length);

    for (const change of this.cache.slice(0, room)) {
      const local = mapper.fromWinePath(change.localPath);
      this.watcher.track(vscode.Uri.file(local));
    }
    for (const doc of open) this.watcher.track(doc.uri);
  }

  /**
   * The pending change for a LOCAL path, or undefined.
   *
   * Answers only while a mapper is live. Nothing clears `localIndex` when the
   * mapper goes away -- a failed re-initialize leaves it populated and STALE --
   * so this guard, not an empty map, is what stops a stale answer.
   */
  changeForLocal(localPath: string): PendingChange | undefined {
    if (!this.mapper) return undefined;
    return this.localIndex.get(localKey(localPath, this.platform));
  }

  /** Indexed, not scanned -- see localIndex. */
  isPending(localPath: string): boolean {
    return this.changeForLocal(localPath) !== undefined;
  }

  /** Indexed lookup — the cache can hold tens of thousands of entries. */
  changeFor(serverItem: string): PendingChange | undefined {
    return this.index.get(serverItem.toLowerCase());
  }

  dispose(): void {
    // Stop the in-flight run's `finally` from firing a trailing rerun after
    // teardown, which would spawn a tf process the extension can no longer own.
    this.disposed = true;
    this.rerun = false;
    if (this.debounce) clearTimeout(this.debounce);
    this.changed.dispose();
    for (const d of this.watchDisposables.splice(0)) d.dispose();
    for (const d of this.disposables) d.dispose();
  }
}
