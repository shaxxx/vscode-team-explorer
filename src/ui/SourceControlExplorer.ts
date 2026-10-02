import * as vscode from 'vscode';
import { existsSync } from 'node:fs';
import { relative } from 'node:path';
import type { ExplorerService, Loaded } from '../explorer/ExplorerService.js';
import type { DirListing } from '../tf/parseDir.js';
import {
  ExplorerModel,
  childPath,
  crumbs,
  isServerPath,
  nameOf,
  parentPath,
  parseExplorerIntent,
  refusal,
  SELECTION_ONLY,
  type ExplorerAction,
  type ExplorerIntent,
  type ExplorerRow,
} from '../explorer/explorerModel.js';
import { getLatestArgs, getVersionArgs, needsOverwriteConfirm, type VersionRequest } from '../explorer/getVersion.js';
import type { PathMapper } from '../tf/PathMapper.js';
import { isPendingAdd, type PendingChange, type WorkspaceInfo } from '../tf/types.js';
import { historyHtml, makeNonce } from './historyHtml.js';
import { S } from '../tf/strings.js';
import { scrubSecrets } from '../tf/TfClient.js';
import { lookForConflictsAfterGet } from '../conflicts/afterGet.js';

export const EXPLORER_VIEW_TYPE = 'teamExplorer.sourceControlExplorer';
/** A checkout or an undo fires TfvcService's change event more than once; one reload per burst. */
export const RELOAD_DELAY_MS = 500;

export interface RecentChangeset {
  id: number;
  user: string;
  date: string;
  comment: string;
}

/** Everything the explorer asks of the rest of the extension (wired in extension.ts, faked in tests). */
export interface ExplorerDeps {
  explorer: Pick<ExplorerService, 'list' | 'details' | 'status' | 'workspaces' | 'cachedListing' | 'forget' | 'get'>;
  /** TfvcService's PathMapper: every mapping on this computer. */
  mapper(): Pick<PathMapper, 'toLocalPath'> | undefined;
  showHistory(target: { mode: 'file' | 'folder'; serverPath: string; name: string }): Promise<void>;
  recentChangesets(serverPath: string, folder: boolean): Promise<RecentChangeset[]>;
  /** Part 1's Add Mapping, with this server path already chosen. */
  mapServerFolder(serverPath: string): Promise<void>;
  /** Phase 1's scan: files under this native folder that are not in source control. */
  unversionedUnder(nativeFolder: string): string[];
  /** TfvcService's: the opened folder's pending changes, the same array until the next refresh. */
  pendingChanges(): readonly PendingChange[];
  /** After a Get: what Phase 1's Get Latest does -- drop cached server copies, refresh, re-scan. */
  afterGet(): void;
  log(line: string): void;
}

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
const messageOf = (e: unknown): string => scrubSecrets(e instanceof Error ? e.message : String(e));
/** `HH:MM:SS`: when status was last loaded, for the footer. */
const clock = (d = new Date()): string =>
  [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');

const panelOptions = (root: vscode.Uri) => ({
  enableScripts: true,
  localResourceRoots: [vscode.Uri.joinPath(root, 'media')],
});

/** One Source Control Explorer tab: asking again reveals it. */
export class SourceControlExplorer implements vscode.Disposable {
  private panel: ExplorerPanel | undefined;
  private reloadTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    /** Read when the tab opens, not at activation: tests activate without one. */
    private readonly extensionUri: () => vscode.Uri | undefined,
    private readonly deps: ExplorerDeps,
  ) {}

  async show(path = '$/', select?: string): Promise<void> {
    // Review (phase 3 part 2): callers hand this a path translated from a
    // real local filesystem path (openExplorer, showInExplorer) -- and a real
    // local folder literally named `*` or `;` is legal on Fedora's ext4, so
    // the result is not necessarily a valid server path. `restore()` already
    // guards its own saved path the same way; `show()` had no such guard, and
    // an unchecked path reaches the model as the current folder, where
    // folderRow() would offer it as a Get target.
    const safePath = isServerPath(path) ? path : '$/';
    if (safePath !== path) this.deps.log(`explorer: show() ignored an invalid path: ${JSON.stringify(path)}`);
    const safeSelect = select !== undefined && isServerPath(select) ? select : undefined;
    if (!this.panel || this.panel.isDisposed) {
      const root = this.extensionUri();
      if (!root) return;
      const webviewPanel = vscode.window.createWebviewPanel(EXPLORER_VIEW_TYPE, S.sceTitle, vscode.ViewColumn.Active, {
        ...panelOptions(root),
        // The extension owns the state; the page says "ready" and gets it again
        // whenever VS Code rebuilds it, as the History tab does.
        retainContextWhenHidden: false,
      });
      this.panel = new ExplorerPanel(webviewPanel, root, this.deps);
    } else {
      this.panel.reveal();
    }
    await this.panel.open(safePath, safeSelect);
  }

  /** VS Code reopening the tab after a restart: the page saved its folder with setState. */
  async restore(webviewPanel: vscode.WebviewPanel, saved: unknown): Promise<void> {
    const root = this.extensionUri();
    if (!root) {
      webviewPanel.dispose();
      return;
    }
    const savedPath = typeof saved === 'object' && saved !== null ? (saved as { path?: unknown }).path : undefined;
    webviewPanel.webview.options = panelOptions(root);
    this.panel?.dispose();
    this.panel = new ExplorerPanel(webviewPanel, root, this.deps);
    await this.panel.open(isServerPath(savedPath) ? savedPath : '$/');
  }

  /** TfvcService changed (a checkout, an undo, a refresh): reload the open folder's status, once per burst. */
  scheduleReload(): void {
    if (!this.panel || this.panel.isDisposed) return;
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(() => {
      this.reloadTimer = undefined;
      void this.panel?.reloadDetails();
    }, RELOAD_DELAY_MS);
  }

  dispose(): void {
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.panel?.dispose();
  }
}

class ExplorerPanel {
  private readonly model: ExplorerModel;
  private disposed = false;
  /** This computer's workspaces: a pending change in one of them is "mine". */
  private mine: WorkspaceInfo[] = [];
  private workspacesLoaded = false;
  /** Bumped by every navigation; a load that finishes for an older one is dropped. */
  private generation = 0;
  /**
   * Folders a `status` here showed as your pending Adds, by lower-cased path:
   * outside the opened folder, TfvcService's pending changes do not reach
   * them. Opening one still asks `dir` first, so a checked-in folder lists
   * normally; an entry goes once `dir` lists it or its parent's status reloads.
   */
  private readonly seenAdded = new Map<string, string>();
  /** The opened folder's pending Adds, rebuilt when TfvcService's array changes. */
  private workspaceAdds: { from: readonly PendingChange[]; adds: { path: string; isFolder: boolean }[] } | undefined;

  get isDisposed(): boolean {
    return this.disposed;
  }

  constructor(
    private readonly panel: vscode.WebviewPanel,
    root: vscode.Uri,
    private readonly deps: ExplorerDeps,
  ) {
    this.model = new ExplorerModel({
      isMine: (c) => this.mine.some((w) => same(w.name, c.workspace) && same(w.computer, c.computer)),
      localPathOf: (p) => this.deps.mapper()?.toLocalPath(p),
      childrenOf: (p) => this.childrenOf(p),
      isAdded: (p) => this.isAddedFolder(p),
      addedFoldersIn: (p, listed) => this.addedFoldersIn(p, listed),
    });
    const media = vscode.Uri.joinPath(root, 'media');
    const webview = panel.webview;
    // historyHtml is the generic empty shell (CSP nonce, one script, one stylesheet).
    webview.html = historyHtml({
      cspSource: webview.cspSource,
      nonce: makeNonce(),
      scriptUri: webview.asWebviewUri(vscode.Uri.joinPath(media, 'explorer.js')).toString(),
      styleUri: webview.asWebviewUri(vscode.Uri.joinPath(media, 'explorer.css')).toString(),
      title: S.sceTitle,
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

  async open(path: string, select?: string): Promise<void> {
    const gen = ++this.generation;
    this.model.navigate(path);
    this.post();
    if (!this.workspacesLoaded) {
      const ws = await this.deps.explorer.workspaces();
      if (ws.ok) this.mine = ws.value;
      else this.deps.log(`explorer: could not list this computer's workspaces: ${ws.message}`);
      this.workspacesLoaded = true;
      if (this.stale(gen)) return;
    }
    // `dir` lists the server, which has no folder you added ("No items
    // match"): then start it empty, and loadDetails' `status` lists its
    // contents, all pending Adds too. `dir` is asked first even so: once the
    // folder is checked in it lists, whatever was known of the Add.
    let listed: Loaded<DirListing> = await this.deps.explorer.list(path, true);
    if (this.stale(gen)) return;
    if (!listed.ok && this.holdsYourAdd(path)) listed = { ok: true, value: { path, folders: [], files: [] } };
    else if (listed.ok) this.seenAdded.delete(path.toLowerCase());
    if (!listed.ok) {
      this.model.listState = 'failed';
      this.model.listError = listed.message;
      this.post();
      return;
    }
    this.model.listing = listed.value;
    this.model.listState = 'ok';
    if (select !== undefined && this.model.rowsFor([select])) this.model.selection = [select];
    this.post();
    // Names first (X2); then the columns, the tree's ancestors, and any other
    // still-expanded branch, side by side.
    await Promise.all([this.loadDetails(gen), this.loadAncestors(path, gen), this.loadExpandedFolders(gen)]);
  }

  async reloadDetails(): Promise<void> {
    if (this.disposed || this.model.listState !== 'ok') return;
    await this.loadDetails(this.generation);
  }

  private stale(gen: number): boolean {
    return this.disposed || gen !== this.generation;
  }

  private async loadAncestors(path: string, gen: number): Promise<void> {
    for (const c of crumbs(path).slice(0, -1)) {
      if (this.deps.explorer.cachedListing(c.path)) continue;
      const r = await this.deps.explorer.list(c.path);
      if (this.stale(gen)) return;
      if (r.ok) this.post();
    }
  }

  /**
   * Refresh (`forget()`) drops every cached listing, including one behind an
   * expanded tree branch that is not on the CURRENT path's ancestor chain
   * (e.g. a sibling folder the tree was left open on) -- loadAncestors only
   * revisits this path's own ancestors, so without this that branch stayed
   * stuck on "…" until toggled closed and open again.
   *
   * Walks the tree in rounds: listing one folder can reveal a deeper one that
   * is ALSO expanded (its row only appears once its parent's children are
   * known), so a single pass is not enough. `attempted` makes a failed
   * listing count as done -- it is never retried within this call -- so one
   * folder that will never list again cannot loop this forever.
   */
  private async loadExpandedFolders(gen: number): Promise<void> {
    const attempted = new Set<string>();
    for (;;) {
      if (this.stale(gen)) return;
      const missing = this.model.state().tree.filter((t) => t.loading && !attempted.has(t.path.toLowerCase()));
      if (missing.length === 0) return;
      for (const t of missing) {
        attempted.add(t.path.toLowerCase());
        const r = await this.deps.explorer.list(t.path);
        if (this.stale(gen)) return;
        if (r.ok) this.post();
      }
    }
  }

  private async loadDetails(gen: number): Promise<void> {
    const listing = this.model.listing;
    if (!listing) return;
    // Nothing on the server here, so `info` has nothing to say; `status` still
    // does, since a file you added here is not on the server yet.
    const empty = listing.folders.length + listing.files.length === 0;
    const { info, status } = empty
      ? { info: { ok: true as const, value: [] }, status: await this.deps.explorer.status(this.model.path) }
      : await this.deps.explorer.details(this.model.path);
    if (this.stale(gen)) return;
    if (info.ok) {
      this.model.info = info.value;
      this.model.infoState = 'ok';
    } else {
      this.model.info = undefined;
      this.model.infoState = 'failed';
      this.deps.log(`explorer: info failed: ${info.message}`);
    }
    if (status.ok) {
      this.model.status = status.value;
      this.model.statusState = 'ok';
      this.rememberAdded();
    } else {
      this.model.status = undefined;
      this.model.statusState = 'failed';
      this.deps.log(`explorer: status failed: ${status.message}`);
    }
    this.model.loadedAt = clock();
    this.post();
  }

  /** What this folder's `status` says about its added subfolders, replacing what an earlier one said. */
  private rememberAdded(): void {
    const here = this.model.path;
    for (const [k, p] of this.seenAdded) if (same(parentPath(p), here)) this.seenAdded.delete(k);
    for (const r of this.model.rows()) if (r.added && r.isFolder) this.seenAdded.set(r.serverPath.toLowerCase(), r.serverPath);
  }

  private addsInWorkspace(): { path: string; isFolder: boolean }[] {
    const pending = this.deps.pendingChanges();
    if (this.workspaceAdds?.from !== pending) {
      const adds = pending.filter(isPendingAdd).map((c) => ({ path: c.serverItem, isFolder: c.itemType === 'Folder' }));
      this.workspaceAdds = { from: pending, adds };
    }
    return this.workspaceAdds.adds;
  }

  /**
   * Your added folders directly under `parent` and not among `listed`: one
   * you added, or one only an Add deeper down implies -- tf pends no Add for
   * a new file's new folder (measured: test\test1.txt alone, no `test`).
   */
  private addedFoldersIn(parent: string, listed: readonly string[]): string[] {
    const prefix = (parent === '$/' ? '$/' : `${parent}/`).toLowerCase();
    const out = new Map<string, string>();
    const take = (path: string, isFolder: boolean): void => {
      if (!path.toLowerCase().startsWith(prefix)) return;
      const rest = path.slice(prefix.length);
      const slash = rest.indexOf('/');
      // A file right here is a row from `status`, not a folder.
      if (slash < 0 && !isFolder) return;
      const name = slash < 0 ? rest : rest.slice(0, slash);
      if (name === '' || listed.some((l) => same(l, name))) return;
      out.set(name.toLowerCase(), childPath(parent, name));
    };
    for (const a of this.addsInWorkspace()) take(a.path, a.isFolder);
    for (const p of this.seenAdded.values()) take(p, true);
    return [...out.values()];
  }

  /** The subfolders `dir` listed, none for a folder you added; undefined while not known. */
  private listedFolders(path: string): string[] | undefined {
    return this.deps.explorer.cachedListing(path)?.folders ?? (this.isAddedFolder(path) ? [] : undefined);
  }

  /** Whether the server lacks this folder and an Add of yours makes it: decided against its parent's listing. */
  private isAddedFolder(path: string): boolean {
    if (path === '$/') return false;
    const parent = parentPath(path);
    const listed = this.listedFolders(parent);
    return listed !== undefined && this.addedFoldersIn(parent, listed).some((p) => same(p, path));
  }

  /** After `dir` could not list `path`: an Add of yours at or under it, which makes it a folder you added. */
  private holdsYourAdd(path: string): boolean {
    const k = path.toLowerCase();
    return [...this.addsInWorkspace().map((a) => a.path), ...this.seenAdded.values()].some(
      (p) => p.toLowerCase() === k || p.toLowerCase().startsWith(`${k}/`),
    );
  }

  /** `dir`'s subfolders plus your added ones, which `dir` cannot list; an added folder has only those. */
  private childrenOf(path: string): string[] | undefined {
    const listed = this.listedFolders(path);
    if (listed === undefined) return undefined;
    const added = this.addedFoldersIn(path, listed).map(nameOf);
    if (added.length === 0) return listed;
    return [...listed, ...added].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  }

  private post(): void {
    if (this.disposed) return;
    void this.panel.webview.postMessage(this.model.state());
  }

  private async onMessage(raw: unknown): Promise<void> {
    const intent = parseExplorerIntent(raw);
    if (!intent) {
      this.deps.log('explorer: ignored a malformed message from the page');
      return;
    }
    try {
      await this.handle(intent);
    } catch (e) {
      const message = messageOf(e);
      this.deps.log(`explorer: ${message}`);
      void vscode.window.showErrorMessage(message);
    }
  }

  private async handle(intent: ExplorerIntent): Promise<void> {
    switch (intent.type) {
      case 'ready':
        return this.post();
      case 'navigate':
        if (!this.model.knows(intent.path)) return this.deps.log('explorer: ignored a folder it never listed');
        return this.open(intent.path);
      case 'toggle': {
        if (!this.model.knows(intent.path)) return this.deps.log('explorer: ignored a folder it never listed');
        this.model.toggle(intent.path);
        this.post();
        if (this.model.isExpanded(intent.path) && !this.deps.explorer.cachedListing(intent.path)) {
          const r = await this.deps.explorer.list(intent.path);
          if (!r.ok) void vscode.window.showWarningMessage(r.message);
          this.post();
        }
        return;
      }
      case 'refresh':
        this.deps.explorer.forget();
        this.workspacesLoaded = false;
        return this.open(this.model.path);
      case 'sort':
        this.model.sortBy(intent.key);
        return this.post();
      case 'select':
        this.model.selection = this.model.rowsFor(intent.paths) ? intent.paths : [];
        return this.post();
      case 'closeDialog':
        this.model.closeDialog();
        return this.post();
      case 'pickChangeset':
        return this.pickChangeset(intent.request);
      case 'submitDialog':
        return this.submitDialog(intent.request);
      case 'action':
        return this.act(intent.action, intent.paths);
    }
  }

  private async act(action: ExplorerAction, paths: string[]): Promise<void> {
    // Rename and Delete need an item the user picked. `paths: []` means the
    // folder being browsed, and a folder delete is recursive, so at `$/` that
    // would be the whole tree from one menu click.
    if (paths.length === 0 && SELECTION_ONLY.has(action)) {
      this.deps.log(`explorer: refused ${action} on the folder being browsed (paths: [])`);
      void vscode.window.showInformationMessage(S.sceNeedsSelection);
      return;
    }
    // An empty selection is the toolbar: the open folder itself.
    const rows = paths.length === 0 ? [this.model.folderRow()] : this.model.rowsFor(paths);
    if (!rows) {
      void vscode.window.showWarningMessage(S.sceUnknownPath);
      return;
    }
    const problem = refusal(action, rows);
    if (problem) {
      void vscode.window.showInformationMessage(problem);
      return;
    }
    const first = rows[0];
    // refusal() has already refused every unmapped row for the actions that use these.
    const uris = (): vscode.Uri[] => rows.map((r) => vscode.Uri.file(r.localPath as string));

    switch (action) {
      case 'open':
        if (first.isFolder) return this.open(first.serverPath);
        if (first.localPath && existsSync(first.localPath)) {
          await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(first.localPath));
          return;
        }
        if (first.serverChangeset !== undefined) {
          await vscode.commands.executeCommand('teamExplorer.viewVersion', first.serverPath, first.serverChangeset);
          return;
        }
        void vscode.window.showInformationMessage(S.sceNotLoaded(first.name));
        return;
      case 'history':
        return this.deps.showHistory({ mode: first.isFolder ? 'folder' : 'file', serverPath: first.serverPath, name: first.name });
      case 'view':
        await vscode.commands.executeCommand('teamExplorer.viewVersion', first.serverPath, first.serverChangeset);
        return;
      case 'compare':
        await vscode.commands.executeCommand('teamExplorer.compareWithLatest', vscode.Uri.file(first.localPath as string));
        return;
      case 'annotate':
        await vscode.commands.executeCommand('teamExplorer.annotate', vscode.Uri.file(first.localPath as string));
        return;
      case 'checkout': {
        const folders = rows.filter((r) => r.isFolder);
        if (folders.length > 0) {
          const yes = await vscode.window.showWarningMessage(
            S.sceCheckoutFolderConfirm(folders.map((r) => r.name)),
            { modal: true, detail: S.sceCheckoutFolderDetail },
            S.sceCheckoutFolderYes,
          );
          if (yes !== S.sceCheckoutFolderYes) return;
        }
        const u = uris();
        await vscode.commands.executeCommand('teamExplorer.checkout', u[0], u);
        return;
      }
      case 'undo': {
        // Phase 1's Undo confirms, and lists what it will undo.
        const u = uris();
        await vscode.commands.executeCommand('teamExplorer.undo', u[0], u);
        return;
      }
      case 'getLatest':
        return this.runGet(getLatestArgs(rows.map((r) => r.serverPath)), S.sceWhat(rows.map((r) => r.name)));
      case 'getSpecific':
        this.model.openDialog(rows);
        return this.post();
      case 'addItems':
        return this.addItems(first);
      case 'rename':
        await vscode.commands.executeCommand(
          'teamExplorer.renameItem',
          first.localPath,
          this.model.rows().map((r) => r.name),
        );
        return this.open(this.model.path);
      case 'delete':
        await vscode.commands.executeCommand('teamExplorer.deleteItems', {
          paths: rows.map((r) => r.serverPath),
          names: rows.map((r) => r.name),
          hasFolder: rows.some((r) => r.isFolder),
        });
        return this.open(this.model.path);
      case 'map':
        await this.deps.mapServerFolder(first.serverPath);
        return this.open(this.model.path);
      case 'copyPath':
        await vscode.env.clipboard.writeText(rows.map((r) => r.serverPath).join('\n'));
        void vscode.window.showInformationMessage(S.sceCopied(rows.length));
        return;
    }
  }

  private async runGet(args: string[], what: string): Promise<void> {
    const r = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: S.sceGetting(what), cancellable: true },
      (progress, token) => {
        const abort = new AbortController();
        token.onCancellationRequested(() => abort.abort());
        return this.deps.explorer.get(args, (n) => progress.report({ message: S.sceGettingCount(n) }), abort.signal);
      },
    );
    this.deps.afterGet();
    // Phase 5. The server paths are the argv's `$/` items; every
    // option getVersion.ts builds starts with `/`.
    lookForConflictsAfterGet(args.filter((a) => a.startsWith('$/')));
    if (r.cancelled) {
      void vscode.window.showInformationMessage(S.sceGetCancelled(what, r.items));
    } else if (r.failure !== undefined) {
      const detail = scrubSecrets(r.failure);
      this.deps.log(detail);
      void vscode.window.showWarningMessage(S.sceGetFailed(what, r.items, detail));
    } else {
      void vscode.window.showInformationMessage(S.sceGetDone(what, r.items, r.deleted));
    }
    await this.reloadDetails();
  }

  private async submitDialog(request: VersionRequest): Promise<void> {
    const dialog = this.model.dialog;
    if (!dialog) return;
    const built = getVersionArgs(dialog.paths, request, dialog.recursive);
    if (!built.ok) {
      this.model.updateDialog({ request, error: built.message });
      return this.post();
    }
    if (needsOverwriteConfirm(request)) {
      // S is `as const`, so its properties are string literal types; widen to
      // `string` explicitly so the filter's type predicate can narrow it back.
      const parts: (string | undefined)[] = [
        request.overwriteWritable ? S.sceOverwriteWritableDetail : undefined,
        request.getAll ? S.sceOverwriteAllDetail : undefined,
      ];
      const detail = parts.filter((d): d is string => d !== undefined).join('\n\n');
      const yes = await vscode.window.showWarningMessage(
        S.sceOverwriteConfirm(dialog.paths.length),
        { modal: true, detail },
        S.sceOverwriteYes,
      );
      if (yes !== S.sceOverwriteYes) {
        this.model.updateDialog({ request, error: undefined });
        return this.post();
      }
    }
    this.model.closeDialog();
    this.post();
    await this.runGet(built.args, dialog.what);
  }

  /** The dialog's "…": the item's recent changesets (Phase 2's HistoryService), picked in a native list. */
  private async pickChangeset(draft: VersionRequest): Promise<void> {
    const dialog = this.model.dialog;
    if (!dialog) return;
    const target = dialog.paths[0];
    const listed = this.model.rowsFor([target]);
    const folder = listed ? listed[0].isFolder : true; // the toolbar's own folder is not a row
    let changesets: RecentChangeset[];
    try {
      changesets = await this.deps.recentChangesets(target, folder);
    } catch (e) {
      void vscode.window.showWarningMessage(messageOf(e));
      return;
    }
    if (changesets.length === 0) {
      void vscode.window.showInformationMessage(S.sceNoChangesets(nameOf(target)));
      return;
    }
    const picked = await vscode.window.showQuickPick(
      changesets.map((c) => ({ label: String(c.id), description: `${c.user}  ${c.date}`, detail: c.comment.split('\n')[0], id: c.id })),
      { title: S.scePickChangeset(nameOf(target)), matchOnDescription: true, matchOnDetail: true },
    );
    if (!picked || !this.model.dialog) return;
    this.model.updateDialog({ request: { ...draft, kind: 'changeset', value: String(picked.id) }, error: undefined });
    this.post();
  }

  private async addItems(folder: ExplorerRow): Promise<void> {
    const local = folder.localPath as string;
    const files = this.deps.unversionedUnder(local);
    if (files.length === 0) {
      void vscode.window.showInformationMessage(S.sceNoUnversioned(folder.name));
      return;
    }
    const picked = await vscode.window.showQuickPick(
      files.map((f) => ({ label: relative(local, f), path: f })),
      { title: S.scePickUnversioned(folder.name), canPickMany: true },
    );
    if (!picked || picked.length === 0) return;
    const u = picked.map((p) => vscode.Uri.file(p.path));
    await vscode.commands.executeCommand('teamExplorer.add', u[0], u);
  }
}
