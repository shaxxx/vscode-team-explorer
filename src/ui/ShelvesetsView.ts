import * as vscode from 'vscode';
import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import type { Loaded, ShelveService } from '../shelve/ShelveService.js';
import { ShelvesetsModel, changeName, keyOf, parseShelvesetsIntent, type FileAction, type ShelvesetsIntent } from '../shelve/shelvesetsModel.js';
import {
  compareUnmodified,
  compareWorkspace,
  keepAfterReadBack,
  keepBeforeReadBack,
  keepWhole,
  ownerProblem,
  ownerQuery,
  passable,
  planUnshelve,
  sameItemSet,
  viewShelved,
  type Keep,
  type Side,
} from '../shelve/shelveRules.js';
import type { Shelveset, ShelvedChange } from '../tf/parseShelvesets.js';
import type { PathMapper } from '../tf/PathMapper.js';
import type { WorkspaceInfo } from '../tf/types.js';
import { historyHtml, makeNonce } from './historyHtml.js';
import { ServerContentProvider } from './ServerContentProvider.js';
import { S } from '../tf/strings.js';
import { scrubSecrets } from '../tf/TfClient.js';

export const SHELVESETS_VIEW_TYPE = 'teamExplorer.shelvesets';

/** Everything the tab asks of the rest of the extension (wired in extension.ts, faked in tests). */
export interface ShelvesetsDeps {
  shelve: Pick<ShelveService, 'list' | 'contents' | 'unshelve' | 'deleteOwn' | 'pendingIn'>;
  /** This computer's workspaces (ExplorerService.workspaces): whose shelvesets are "mine", and the Owner box's first text. */
  workspaces(): Promise<Loaded<WorkspaceInfo[]>>;
  /** TfvcService's PathMapper: whether a server path is mapped here, and where. */
  mapper(): Pick<PathMapper, 'toLocalPath'> | undefined;
  /** After an unshelve: drop cached server copies, refresh the pending changes, re-scan. */
  afterUnshelve(): void;
  /**
   * Phase 5's `teamExplorer.resolveConflicts`: shows any conflicts
   * under these paths and says how many. Rejects when it cannot tell --
   * including when phase 5 is not in this build.
   */
  resolveConflicts(serverPaths: string[]): Promise<number>;
  log(line: string): void;
}

const messageOf = (e: unknown): string => scrubSecrets(e instanceof Error ? e.message : String(e));
const samePath = (a: string, b: string): boolean =>
  process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const panelOptions = (root: vscode.Uri) => ({
  enableScripts: true,
  localResourceRoots: [vscode.Uri.joinPath(root, 'media')],
});

/** What the page saved for a restart, checked like anything else that comes from the page. */
function savedState(saved: unknown): { owner?: string; selected?: string } {
  if (typeof saved !== 'object' || saved === null) return {};
  const s = saved as Record<string, unknown>;
  return {
    ...(typeof s.owner === 'string' && s.owner.length <= 256 && ownerProblem(s.owner) === undefined ? { owner: s.owner } : {}),
    ...(typeof s.selected === 'string' && s.selected.length <= 1024 ? { selected: s.selected } : {}),
  };
}

/** One Shelvesets tab: asking again reveals it. */
export class ShelvesetsView implements vscode.Disposable {
  private panel: ShelvesetsPanel | undefined;

  constructor(
    /** Read when the tab opens, not at activation: tests activate without one. */
    private readonly extensionUri: () => vscode.Uri | undefined,
    private readonly deps: ShelvesetsDeps,
  ) {}

  async show(): Promise<void> {
    if (this.panel && !this.panel.isDisposed) {
      this.panel.reveal();
      return;
    }
    const root = this.extensionUri();
    if (!root) return;
    const webviewPanel = vscode.window.createWebviewPanel(SHELVESETS_VIEW_TYPE, S.shelvesetsTitle, vscode.ViewColumn.Active, {
      ...panelOptions(root),
      // The extension owns the state; the page says "ready" and gets it again.
      retainContextWhenHidden: false,
    });
    this.panel = new ShelvesetsPanel(webviewPanel, root, this.deps);
    await this.panel.open({});
  }

  /** VS Code reopening the tab after a restart: the page saved its owner and selection. */
  async restore(webviewPanel: vscode.WebviewPanel, saved: unknown): Promise<void> {
    const root = this.extensionUri();
    if (!root) {
      webviewPanel.dispose();
      return;
    }
    webviewPanel.webview.options = panelOptions(root);
    this.panel?.dispose();
    this.panel = new ShelvesetsPanel(webviewPanel, root, this.deps);
    await this.panel.open(savedState(saved));
  }

  /** After Shelve: the new shelveset appears without a Refresh. */
  refreshIfOpen(): void {
    if (this.panel && !this.panel.isDisposed) void this.panel.loadList();
  }

  dispose(): void {
    this.panel?.dispose();
  }
}

class ShelvesetsPanel {
  private readonly model: ShelvesetsModel;
  private disposed = false;
  /** The workspace owner's aliases: what makes a shelveset "mine". None known means none is. */
  private aliases: string[] = [];
  /** Bumped per load; an answer for an older one is dropped. */
  private listGeneration = 0;
  private detailsGeneration = 0;
  /** An unshelve or a delete is running: a second click must not run tf twice. */
  private running = false;

  get isDisposed(): boolean {
    return this.disposed;
  }

  constructor(
    private readonly panel: vscode.WebviewPanel,
    root: vscode.Uri,
    private readonly deps: ShelvesetsDeps,
  ) {
    this.model = new ShelvesetsModel(() => this.aliases);
    const media = vscode.Uri.joinPath(root, 'media');
    const webview = panel.webview;
    // historyHtml is the generic empty shell (CSP nonce, one script, one stylesheet).
    webview.html = historyHtml({
      cspSource: webview.cspSource,
      nonce: makeNonce(),
      scriptUri: webview.asWebviewUri(vscode.Uri.joinPath(media, 'shelvesets.js')).toString(),
      styleUri: webview.asWebviewUri(vscode.Uri.joinPath(media, 'shelvesets.css')).toString(),
      title: S.shelvesetsTitle,
    });
    webview.onDidReceiveMessage((raw) => this.onMessage(raw));
    panel.onDidDispose(() => {
      this.disposed = true;
    });
  }

  reveal(): void {
    this.panel.reveal();
  }

  dispose(): void {
    this.panel.dispose();
  }

  /** Learns who "me" is, then lists. */
  async open(saved: { owner?: string; selected?: string }): Promise<void> {
    const ws = await this.deps.workspaces();
    if (this.disposed) return;
    if (ws.ok) {
      this.aliases = ws.value.flatMap((w) => w.ownerAliases ?? []);
      this.model.owner = saved.owner ?? ws.value.find((w) => w.owner)?.owner ?? '';
    } else {
      // Nothing counts as mine then, so Delete is refused everywhere: the safe side.
      this.deps.log(`shelvesets: could not read this computer's workspaces: ${scrubSecrets(ws.message)}`);
      this.model.owner = saved.owner ?? '';
    }
    await this.loadList(saved.selected);
  }

  async loadList(select?: string): Promise<void> {
    const gen = ++this.listGeneration;
    // `select` absent means this is a Refresh's own implicit re-select of the
    // shelveset already open, not an explicit one (a row click, the Retry
    // button, a saved selection on open) -- `select()` below keeps the
    // user's choices only for that case.
    const explicit = select !== undefined;
    const reselect = select ?? (this.model.selected ? keyOf(this.model.selected) : undefined);
    this.model.loadingList();
    this.post();
    const r = await this.deps.shelve.list(ownerQuery(this.model.owner, this.aliases));
    if (this.disposed || gen !== this.listGeneration) return;
    if (!r.ok) {
      this.model.failList(r.message);
      this.post();
      return;
    }
    this.model.setList(r.value);
    this.post();
    if (reselect !== undefined && this.model.find(reselect)) await this.select(reselect, !explicit);
  }

  /**
   * `reopening` is true only for the implicit re-select `loadList` makes of
   * the currently open shelveset on a Refresh: the model then keeps the
   * user's ticks and Preserve when the reload finds the SAME shelveset
   * An explicit select -- a row click, the Retry button, a
   * saved selection on open -- always starts fresh, as today.
   */
  private async select(key: string, reopening = false): Promise<void> {
    const s = reopening ? this.model.reopen(key) : this.model.select(key);
    if (!s) {
      void vscode.window.showWarningMessage(S.shelvesetsStale);
      return;
    }
    this.post();
    if (!passable(s)) {
      this.model.failChanges(key, S.shelvesetUnpassable(s.name));
      this.post();
      return;
    }
    const gen = ++this.detailsGeneration;
    const r = await this.deps.shelve.contents(s.name, s.ownerUnique);
    if (this.disposed || gen !== this.detailsGeneration) return;
    if (r.ok) this.model.setChanges(key, r.value);
    else this.model.failChanges(key, r.message);
    this.post();
  }

  private post(): void {
    if (this.disposed) return;
    void this.panel.webview.postMessage(this.model.state());
  }

  private async onMessage(raw: unknown): Promise<void> {
    const intent = parseShelvesetsIntent(raw);
    if (!intent) {
      this.deps.log('shelvesets: ignored a malformed message from the page');
      return;
    }
    try {
      await this.handle(intent);
    } catch (e) {
      const message = messageOf(e);
      this.deps.log(`shelvesets: ${message}`);
      void vscode.window.showErrorMessage(message);
    }
  }

  private async handle(intent: ShelvesetsIntent): Promise<void> {
    switch (intent.type) {
      case 'ready':
        return this.post();
      case 'refresh':
        return this.loadList();
      case 'find':
        // Checked BEFORE it is stored: a refused owner must never reach a later Refresh (Task 5 review).
        this.model.ownerError = ownerProblem(intent.owner);
        if (this.model.ownerError !== undefined) return this.post();
        this.model.owner = intent.owner.trim();
        return this.loadList();
      case 'select':
        return this.select(intent.key);
      case 'tick':
        this.model.tick(intent.paths, intent.ticked);
        return this.post();
      case 'preserve':
        this.model.setPreserve(intent.value);
        return this.post();
      case 'file':
        return this.openFile(intent.action, intent.path);
      case 'unshelve':
        return this.unshelve();
      case 'delete':
        return this.remove(intent.key);
    }
  }

  private async openFile(action: FileAction, serverPath: string): Promise<void> {
    const s = this.model.selected;
    const c = this.model.change(serverPath);
    if (!s || !c) {
      void vscode.window.showWarningMessage(S.shelvesetsStale);
      return;
    }
    if (action === 'viewShelved') {
      const viewed = viewShelved(c);
      if (!viewed.ok) {
        void vscode.window.showInformationMessage(viewed.message);
        return;
      }
      await vscode.commands.executeCommand('vscode.open', this.uriOf(viewed.side, s, c));
      return;
    }
    const mapper = this.deps.mapper();
    const opened =
      action === 'compareUnmodified'
        ? compareUnmodified(c, s.name)
        : compareWorkspace(c, s.name, (p) => mapper?.toLocalPath(p), (local) => existsSync(local));
    if (!opened.ok) {
      void vscode.window.showInformationMessage(opened.message);
      return;
    }
    await vscode.commands.executeCommand('vscode.diff', this.uriOf(opened.left, s, c), this.uriOf(opened.right, s, c), opened.title);
  }

  private uriOf(side: Side, s: Shelveset, c: ShelvedChange): vscode.Uri {
    switch (side.kind) {
      case 'version':
        return ServerContentProvider.versionUri(side.serverPath, side.changeset);
      case 'empty':
        return ServerContentProvider.emptyUri(side.serverPath);
      case 'local':
        return vscode.Uri.file(side.localPath);
      case 'shelved':
        return ServerContentProvider.shelvedUri({
          serverPath: side.serverPath,
          shelveset: s.name,
          owner: s.ownerUnique,
          date: s.date,
          // A real code page is positive: -1 (binary) never reaches here, -3 is a folder.
          ...(c.encoding > 0 ? { codePage: c.encoding } : {}),
        });
    }
  }

  /** Phase 5 resolves what tf leaves in conflict; this never refuses on a pending change of the user's own. */
  private async unshelve(): Promise<void> {
    if (this.running) return;
    const s = this.model.selected;
    if (!s) {
      void vscode.window.showWarningMessage(S.shelvesetsStale);
      return;
    }
    if (!passable(s)) {
      void vscode.window.showInformationMessage(S.shelvesetUnpassable(s.name));
      return;
    }
    const mapper = this.deps.mapper();
    const plan = planUnshelve(this.model.changes, this.model.ticked, (p) => mapper?.toLocalPath(p) !== undefined);
    if (!plan.ok) {
      void vscode.window.showInformationMessage(plan.message);
      return;
    }
    // Captured before the first await, alongside `s` (coordinator review I1,
    // I2): the tab stays live while tf runs, and a Preserve toggle or a new
    // selection on ANOTHER row must not reach back into this unshelve, which
    // is why every one of these is read once here rather than off `this.model`
    // later on.
    this.running = true;
    let preserve = this.model.preserve;
    const mine = this.model.isMine(s);
    const loaded = this.model.changes.map((c) => c.serverItem);
    let deleted = false;
    // Set only when the warning below is answered with Delete: it skips
    // `keepWhole`'s partial check alone, further down, after the delete has
    // been earned by every other check (exit code, conflicts, read-back).
    let partialConsented = false;
    try {
      const chosenPaths = plan.chosen.map((c) => c.serverItem);
      // Ask BEFORE tf runs (WANTED, 2026-09-23): tf's own `unshelve /move`
      // and Visual Studio silently delete the shelveset even when unticked
      // changes exist only there. This never fires when Preserve is ticked,
      // the shelveset is not the user's, or nothing was left unticked.
      if (!preserve && mine && !sameItemSet(chosenPaths, loaded)) {
        const chosenSet = new Set(chosenPaths);
        const unticked = this.model.changes.filter((c) => !chosenSet.has(c.serverItem)).map((c) => changeName(c));
        const answer = await vscode.window.showWarningMessage(
          S.unshelvePartialConfirm(s.name, plan.chosen.length, loaded.length),
          { modal: true, detail: S.unshelvePartialDetail(unticked) },
          S.unshelvePartialKeep,
          S.unshelvePartialDelete,
        );
        if (answer === undefined) return;
        if (answer === S.unshelvePartialKeep) preserve = true;
        else partialConsented = true;
      }
      if (!(await this.saveDirty(plan.chosen, mapper))) return;
      this.model.setBusy(true);
      this.post();
      const ran = await this.deps.shelve.unshelve({ name: s.name, ownerUnique: s.ownerUnique, ...(plan.items ? { items: plan.items } : {}) });
      // Whatever the exit code: an unshelve can pend changes and still exit 1 (S14).
      this.deps.afterUnshelve();
      if (ran.exitCode !== 0) {
        this.deps.log(`unshelve ${s.name}: ${ran.message ?? `exit ${ran.exitCode}`}`);
        void vscode.window.showWarningMessage(S.unshelveFailed(s.name, ran.message ?? ''));
      }
      let conflicts: number | 'unknown';
      try {
        const n = await this.deps.resolveConflicts(plan.scope);
        // A count that is not a whole number >= 0 cannot mean anything real
        // (coordinator review, addition): treat it exactly like a failed
        // check rather than let a NaN/negative/fractional value reach the
        // `> 0` comparison below or `keepBeforeReadBack`'s conflict-count check.
        if (Number.isInteger(n) && n >= 0) {
          conflicts = n;
        } else {
          conflicts = 'unknown';
          this.deps.log(`unshelve ${s.name}: resolveConflicts returned an invalid count (${n})`);
        }
      } catch (e) {
        conflicts = 'unknown';
        this.deps.log(`unshelve ${s.name}: could not check for conflicts: ${messageOf(e)}`);
      }
      let keep: Keep = keepBeforeReadBack({ preserve, mine, exitCode: ran.exitCode, conflicts });
      if (!keep.keep) {
        const expected = plan.chosen.map((c) => c.serverItem);
        const pending = await this.deps.shelve.pendingIn(expected);
        if (!pending.ok) this.deps.log(`unshelve ${s.name}: could not read the pending changes back: ${pending.message}`);
        keep = keepAfterReadBack(expected, pending.ok ? pending.value : undefined);
      }
      if (!keep.keep) {
        // The very last check (coordinator review I1): one whose shelveset
        // was replaced from elsewhere while the tab had it open must never be
        // deleted, consent or not -- so it is read back FRESH, right before
        // the delete, rather than trusting `loaded` alone. A partial unshelve
        // itself is only reached here once the warning above has been
        // answered with Delete (`partialConsented`); `keepWhole` still checks
        // this fresh read against the full `loaded` set.
        const reread = await this.deps.shelve.contents(s.name, s.ownerUnique);
        if (!reread.ok) this.deps.log(`unshelve ${s.name}: could not re-read the shelveset before deleting it: ${reread.message}`);
        keep = keepWhole(loaded, plan.chosen.map((c) => c.serverItem), reread.ok ? reread.value.map((c) => c.serverItem) : undefined, partialConsented);
      }
      if (!keep.keep) {
        const removed = await this.deps.shelve.deleteOwn(s.name);
        deleted = removed.exitCode === 0;
        if (deleted) void vscode.window.showInformationMessage(S.unshelveDoneDeleted(s.name));
        else void vscode.window.showWarningMessage(S.shelvesetDeleteFailed(s.name, removed.message ?? ''));
        return;
      }
      if (conflicts === 'unknown') void vscode.window.showWarningMessage(S.unshelveConflictsUnknown(s.name));
      else if (conflicts > 0) void vscode.window.showInformationMessage(S.unshelveConflicts(s.name, conflicts));
      else if (ran.exitCode === 0) void vscode.window.showInformationMessage(S.unshelveDone(s.name));
      if (keep.why !== undefined) void vscode.window.showInformationMessage(S.unshelveKept(s.name, keep.why));
    } finally {
      this.running = false;
      this.model.setBusy(false);
      this.post();
      if (deleted) await this.loadList();
    }
  }

  /** Unshelving writes these files; an unsaved edit in one is saved first, as Visual Studio asks. */
  private async saveDirty(chosen: readonly ShelvedChange[], mapper: Pick<PathMapper, 'toLocalPath'> | undefined): Promise<boolean> {
    const locals = chosen
      .flatMap((c) => (c.sourceItem !== undefined ? [c.serverItem, c.sourceItem] : [c.serverItem]))
      .map((p) => mapper?.toLocalPath(p))
      .filter((p): p is string => p !== undefined);
    const dirty = vscode.workspace.textDocuments.filter((d) => d.isDirty && locals.some((l) => samePath(l, d.uri.fsPath)));
    if (dirty.length === 0) return true;
    const yes = await vscode.window.showWarningMessage(
      S.unshelveSaveFirst(dirty.map((d) => basename(d.uri.fsPath))),
      { modal: true, detail: S.unshelveSaveFirstDetail },
      S.unshelveSaveYes,
    );
    if (yes !== S.unshelveSaveYes) return false;
    for (const d of dirty) {
      if (!(await d.save())) {
        void vscode.window.showErrorMessage(S.unshelveSaveFailed(basename(d.uri.fsPath)));
        return false;
      }
    }
    return true;
  }

  /** The user's own shelvesets only, after a modal confirm. */
  private async remove(key: string): Promise<void> {
    if (this.running) return;
    const s = this.model.find(key);
    if (!s) {
      void vscode.window.showWarningMessage(S.shelvesetsStale);
      return;
    }
    if (!this.model.isMine(s)) {
      void vscode.window.showInformationMessage(S.shelvesetDeleteNotYours(s.name));
      return;
    }
    this.running = true;
    try {
      const yes = await vscode.window.showWarningMessage(
        S.shelvesetDeleteConfirm(s.name),
        { modal: true, detail: S.shelvesetDeleteDetail },
        S.shelvesetDeleteYes,
      );
      if (yes !== S.shelvesetDeleteYes) return;
      const r = await this.deps.shelve.deleteOwn(s.name);
      if (r.exitCode !== 0) {
        void vscode.window.showErrorMessage(S.shelvesetDeleteFailed(s.name, r.message ?? ''));
        return;
      }
      void vscode.window.showInformationMessage(S.shelvesetDeleted(s.name));
    } finally {
      this.running = false;
    }
    await this.loadList();
  }
}
