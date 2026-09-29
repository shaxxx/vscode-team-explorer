import * as vscode from 'vscode';
import { localKey, type Platform } from '../tf/PathMapper.js';
import { scrubSecrets } from '../tf/TfClient.js';
import { S } from '../tf/strings.js';
import { historyHtml, makeNonce } from './historyHtml.js';
import type { ConflictService } from '../conflicts/ConflictService.js';
import {
  actionsFor,
  nameAndFolder,
  parseConflictIntent,
  RESOLUTION_OF,
  type Conflict,
  type ConflictAction,
  type ConflictActions,
  type MergeAction,
} from '../conflicts/conflictModel.js';

export const CONFLICTS_VIEW_TYPE = 'teamExplorer.conflicts';

export interface ConflictRow {
  /** The row's identity in messages: the local path, compared the platform's way. */
  key: string;
  name: string;
  folder: string;
  reason: string;
  versions: string;
  actions: ConflictAction[];
  merging: boolean;
}

export interface ConflictsViewState {
  title: string;
  rows: ConflictRow[];
  selected: string | undefined;
  busy: boolean;
  empty: string;
  mergingHint: string;
  labels: Readonly<Record<string, string>>;
  toolbar: { refresh: string; autoMergeAll: string };
}

type Source = Pick<ConflictService, 'conflicts' | 'onDidChange'>;

/**
 * The one Resolve Conflicts tab. The extension owns the rows; the
 * page renders what it is sent and says "ready" whenever VS Code rebuilds it.
 * Not restored after a restart: the Conflicts group is, and reopens it.
 */
export class ConflictsView implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private selected: string | undefined;
  /** Rows in Merge manually's state. The tab's own state, never tf's. */
  /** Rows in the merging state, each with what the user started merging against. */
  private readonly merging = new Map<string, string>();
  /** One resolution at a time: a second click while one runs is dropped, as History's Get This Version does (D18g). */
  private busy = false;
  private readonly subscription: vscode.Disposable;

  constructor(
    /** Read when the tab opens, not at activation: tests activate without one. */
    private readonly extensionUri: () => vscode.Uri | undefined,
    private readonly source: Source,
    private readonly actions: ConflictActions,
    private readonly platform: Platform,
  ) {
    this.subscription = source.onDidChange(() => this.post());
  }

  /** Opens or reveals the tab; `select` is a local path. */
  async show(select?: string): Promise<void> {
    if (select !== undefined) this.selected = this.key(select);
    if (this.panel) {
      this.panel.reveal();
      this.post();
      return;
    }
    const root = this.extensionUri();
    if (!root) return;
    const media = vscode.Uri.joinPath(root, 'media');
    const panel = vscode.window.createWebviewPanel(CONFLICTS_VIEW_TYPE, S.conflictsTitle, vscode.ViewColumn.Active, {
      enableScripts: true,
      localResourceRoots: [media],
      retainContextWhenHidden: false,
    });
    this.panel = panel;
    // historyHtml is the generic empty shell (CSP nonce, one script, one stylesheet).
    panel.webview.html = historyHtml({
      cspSource: panel.webview.cspSource,
      nonce: makeNonce(),
      scriptUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(media, 'conflicts.js')).toString(),
      styleUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(media, 'conflicts.css')).toString(),
      title: S.conflictsTitle,
    });
    panel.webview.onDidReceiveMessage((raw) => this.onMessage(raw));
    panel.onDidDispose(() => {
      this.panel = undefined;
      this.merging.clear();
    });
    this.post();
  }

  private key(localPath: string): string {
    return localKey(localPath, this.platform);
  }

  private find(key: string): Conflict | undefined {
    return this.source.conflicts.find((c) => this.key(c.localPath) === key);
  }

  private mergeTarget(c: Conflict): string {
    return `${c.family}|${c.base}|${c.theirs}`;
  }

  /** Still the conflict the user started merging, and still one a manual merge is for. */
  private stillMerging(key: string, c: Conflict): boolean {
    return this.merging.get(key) === this.mergeTarget(c) && actionsFor(c).includes('mergeManually');
  }

  private state(): ConflictsViewState {
    const conflicts = this.source.conflicts;
    // A merge whose conflict was resolved elsewhere (Visual Studio, a terminal),
    // or replaced by a different one at the same path, is over: its Resolved
    // would run Keep Yours on something the user never merged. The service
    // fires only when the list changed, so a key that went and came back
    // between two posts is caught by what it is, not by its absence.
    for (const k of [...this.merging.keys()]) {
      const c = conflicts.find((x) => this.key(x.localPath) === k);
      if (!c || !this.stillMerging(k, c)) this.merging.delete(k);
    }
    return {
      title: S.conflictsTitle,
      rows: conflicts.map((c) => {
        const key = this.key(c.localPath);
        const { name, folder } = nameAndFolder(c.localPath, this.platform);
        return {
          key,
          name,
          folder,
          reason: c.reason,
          versions: S.conflictsVersions(c.base, c.theirs),
          actions: actionsFor(c),
          merging: this.merging.has(key),
        };
      }),
      selected: this.selected,
      busy: this.busy,
      empty: S.conflictsNone,
      mergingHint: S.conflictsMergingHint,
      labels: S.conflictsLabels,
      toolbar: { refresh: S.conflictsRefresh, autoMergeAll: S.conflictsAutoMergeAll },
    };
  }

  private post(): void {
    if (!this.panel) return;
    void this.panel.webview.postMessage(this.state());
  }

  private async onMessage(raw: unknown): Promise<void> {
    const intent = parseConflictIntent(raw);
    if (!intent) return;
    switch (intent.type) {
      case 'ready':
        return this.post();
      case 'select':
        this.selected = intent.key;
        return;
      case 'refresh':
        return this.guarded(() => this.actions.refresh());
      case 'autoMergeAll':
        return this.guarded(() => this.actions.autoMergeAll());
      case 'act':
        return this.act(intent.key, intent.action);
    }
  }

  private async act(key: string, action: ConflictAction | MergeAction): Promise<void> {
    const c = this.find(key);
    // Resolved meanwhile: the row is about to go, and the page gets the list as it is now.
    if (!c) return this.post();
    this.selected = key;
    if (action === 'cancelMerge') {
      this.merging.delete(key);
      return this.post();
    }
    if (action === 'resolved') {
      if (!this.stillMerging(key, c)) {
        this.merging.delete(key);
        return this.post();
      }
      return this.guarded(async () => {
        if (await this.actions.markMerged(c)) this.merging.delete(key);
      });
    }
    // Only what the row offers: the page can post anything.
    if (!actionsFor(c).includes(action)) return;
    switch (action) {
      case 'compare':
        return this.actions.compare(c);
      case 'compareServerBase':
        return this.actions.compareServerBase(c);
      case 'compareLocalBase':
        return this.actions.compareLocalBase(c);
      case 'mergeManually':
        this.merging.set(key, this.mergeTarget(c));
        this.post();
        return this.actions.compare(c);
      default: {
        const how = RESOLUTION_OF[action];
        if (how) return this.guarded(async () => void (await this.actions.resolve(c, how)));
      }
    }
  }

  private async guarded(work: () => Promise<void>): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.post();
    try {
      await work();
    } catch (e) {
      void vscode.window.showWarningMessage(scrubSecrets(e instanceof Error ? e.message : String(e)));
    } finally {
      this.busy = false;
      this.post();
    }
  }

  dispose(): void {
    this.subscription.dispose();
    this.panel?.dispose();
  }
}
