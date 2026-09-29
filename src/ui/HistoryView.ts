import * as vscode from 'vscode';
import type { HistoryService } from '../history/HistoryService.js';
import {
  HistoryModel,
  parseIntent,
  type HistoryMode,
  type Intent,
  type VersionPointer,
} from '../history/historyModel.js';
import { historyHtml, makeNonce } from './historyHtml.js';
import { S } from '../tf/strings.js';
import { scrubSecrets } from '../tf/TfClient.js';

export const HISTORY_VIEW_TYPE = 'teamExplorer.history';

/**
 * How long a selection must stay put before its details are fetched (D16d).
 *
 * Holding Down in the grid moves `selected` once per keystroke; without a
 * delay each of those started its own `tf vc history` before the previous one
 * -- for the row the user was only passing through -- even returned.
 */
export const DETAILS_DELAY_MS = 200;

export interface HistoryTargetInfo {
  mode: HistoryMode;
  /** Under its CURRENT name. */
  serverPath: string;
  name: string;
}

/** What a row action does. Supplied by commands/history.ts, which owns tf and the dialogs. */
export interface HistoryActions {
  compare(left: VersionPointer, right: VersionPointer, name: string): Promise<void>;
  view(version: VersionPointer): Promise<void>;
  getVersion(version: VersionPointer, name: string): Promise<void>;
}

type History = Pick<HistoryService, 'page' | 'changeset'>;

const messageOf = (e: unknown): string => scrubSecrets(e instanceof Error ? e.message : String(e));
const nameOf = (serverPath: string): string => serverPath.slice(serverPath.lastIndexOf('/') + 1);

/** One History tab per file or folder: asking again reveals it. */
export class HistoryViews implements vscode.Disposable {
  private readonly panels = new Map<string, HistoryPanel>();

  constructor(
    /** Read when a tab opens, not at activation: tests activate without one. */
    private readonly extensionUri: () => vscode.Uri | undefined,
    private readonly history: History,
    private readonly actions: HistoryActions,
    private readonly log: (line: string) => void,
  ) {}

  async show(target: HistoryTargetInfo, select?: number): Promise<void> {
    const key = `${target.mode}:${target.serverPath.toLowerCase()}`;
    let panel = this.panels.get(key);
    if (panel) {
      panel.reveal();
      // D16c/D18b: a tab whose first page failed (or was still empty when
      // the panel closed) is otherwise dead -- there is no other way back to
      // it than closing the tab and reopening; a tab that already has rows
      // instead re-fetches page 1 and folds in whatever is newer, so View
      // History again (or a hover's Changeset details) on an already-open
      // tab is not a no-op.
      await panel.reopen();
    } else {
      const root = this.extensionUri();
      if (!root) return;
      panel = new HistoryPanel(target, root, this.history, this.actions, this.log, () => this.panels.delete(key));
      this.panels.set(key, panel);
      await panel.loadFirstPage();
    }
    // D18f: `reopen()`/`loadFirstPage()` can outlive the panel if the tab is
    // closed while either awaits tf; a `select()` afterward would otherwise
    // start a details timer nothing will ever clear.
    if (select !== undefined && !panel.isDisposed) await panel.select(select, true);
  }

  dispose(): void {
    for (const panel of [...this.panels.values()]) panel.dispose();
    this.panels.clear();
  }
}

class HistoryPanel {
  private readonly model: HistoryModel;
  private readonly panel: vscode.WebviewPanel;
  private disposed = false;
  /** D16f: a select() that arrived while a page was loading, for once it lands. */
  private pendingSelect: { id: number; untilFound: boolean } | undefined;
  /** D16d: the debounce timer for the current selection's details fetch. */
  private detailsTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * D20c: one promise chain serializes every page load -- a page-1 merge, Load
   * more, Compare's own next-page fetch, select-until-found, and the very
   * first page. A request arriving mid-load now waits its turn instead of
   * being refused outright (`reopen()` used to just return when `model.loading`
   * was true, so a hover's "Changeset details" during a Load More silently
   * never merged -- R2) or racing it via a single shared field that only
   * covered fetches, not merges (R3). Each queued job re-checks whatever it
   * needs FRESH, at its own turn rather than when it was queued, which is how
   * two near-simultaneous Compare clicks on the same row still cost one tf
   * call, not two (D18f): by the second click's turn, the first's fetch has
   * already landed and `needsMoreFor` is no longer true. Detail fetches are
   * NOT page loads and never go through this (they are debounced separately).
   */
  private queue: Promise<unknown> = Promise.resolve();
  /** D18g: ignored while true -- Get This Version does not overlap itself. */
  private gettingVersion = false;

  get isDisposed(): boolean {
    return this.disposed;
  }

  constructor(
    private readonly target: HistoryTargetInfo,
    root: vscode.Uri,
    private readonly history: History,
    private readonly actions: HistoryActions,
    private readonly log: (line: string) => void,
    onDisposed: () => void,
  ) {
    this.model = new HistoryModel(target.mode, target.serverPath, target.name);
    const media = vscode.Uri.joinPath(root, 'media');
    this.panel = vscode.window.createWebviewPanel(
      HISTORY_VIEW_TYPE,
      S.historyTitle(target.name),
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        localResourceRoots: [media],
        // The extension owns the rows; the page is a renderer that says
        // "ready" and gets them again whenever VS Code rebuilds it.
        retainContextWhenHidden: false,
      },
    );
    const webview = this.panel.webview;
    webview.html = historyHtml({
      cspSource: webview.cspSource,
      nonce: makeNonce(),
      scriptUri: webview.asWebviewUri(vscode.Uri.joinPath(media, 'history.js')).toString(),
      styleUri: webview.asWebviewUri(vscode.Uri.joinPath(media, 'history.css')).toString(),
      title: S.historyTitle(target.name),
    });
    webview.onDidReceiveMessage((raw) => this.onMessage(raw));
    this.panel.onDidDispose(() => {
      this.disposed = true;
      // D16d: an in-flight `history.changeset()` still resolves after this;
      // its own `if (this.disposed) return` guard covers that, but the timer
      // itself must stop firing or a debounced fetch would start after close.
      if (this.detailsTimer) {
        clearTimeout(this.detailsTimer);
        this.detailsTimer = undefined;
      }
      onDisposed();
    });
  }

  reveal(): void {
    this.panel.reveal();
  }

  dispose(): void {
    this.panel.dispose();
  }

  async loadFirstPage(): Promise<void> {
    await this.settleSelect(await this.queuePageLoad(() => this.runFetch({})));
  }

  /**
   * What "asking for History again" does on a tab that already exists
   * (D16c, extended by D18b, D20c).
   *
   * A tab with no rows and nothing in flight is otherwise dead -- there is no
   * other way back to it than closing and reopening -- so it gets its first
   * page again; a fetch already running for that same empty tab is left
   * alone rather than joined (it will populate the rows on its own, and there
   * is nothing this call could usefully wait for). A tab that already HAS
   * rows instead re-fetches page 1 and folds in whatever is newer
   * (`mergeNewest`), without disturbing `more` or the rows already paged in
   * -- queued behind whatever page load is already running (D20c/R2) rather
   * than refused outright, which used to make this a silent no-op while a
   * Load More was in flight.
   */
  async reopen(): Promise<void> {
    if (this.model.oldest === undefined) {
      if (this.model.loading) return;
      this.model.error = undefined;
      await this.settleSelect(await this.queuePageLoad(() => this.runFetch({})));
    } else {
      await this.settleSelect(await this.queuePageLoad(() => this.runMergeNewestPage()));
    }
  }

  /** D18b: the page-1 fetch `reopen()` folds into what is already loaded. */
  private async runMergeNewestPage(): Promise<boolean> {
    this.model.loading = true;
    this.post();
    try {
      const page = await this.history.page({ mode: this.target.mode, itemspec: this.target.serverPath }, {});
      this.model.mergeNewest(page);
      this.model.error = undefined;
      return true;
    } catch (e) {
      this.model.error = messageOf(e);
      return false;
    } finally {
      this.model.loading = false;
      this.post();
    }
  }

  /**
   * D16f: applies a select() that arrived while the page we just finished was
   * loading -- unless that page FAILED (D18f), in which case it is dropped
   * rather than replayed against a fetch that never landed.
   */
  private async settleSelect(fetchSucceeded: boolean): Promise<void> {
    const pending = this.pendingSelect;
    if (!pending) return;
    this.pendingSelect = undefined;
    if (!fetchSucceeded) return;
    await this.select(pending.id, pending.untilFound);
  }

  /** `untilFound`: page back until the changeset is listed -- the Annotate hover's "Changeset details". */
  async select(id: number, untilFound = false): Promise<void> {
    // D18f: nothing starts after the tab is closed -- in particular no details timer.
    if (this.disposed) return;
    // D20c/R3: a PLAIN select (not until-found) for a row that is already
    // loaded needs nothing from the queue and applies at once, even while an
    // unrelated page load (a merge, another select's own paging) is running
    // -- the old code deferred every select whenever anything was loading,
    // whether or not the row it named was already sitting right there, which
    // is what let an unrelated fetch's later failure drop it.
    if (!untilFound && !this.model.has(id)) {
      // Not loaded yet, and this is not an until-found chase: a page load
      // already in flight might bring it in on its own (D16f) -- remember it
      // for `settleSelect()` rather than starting a redundant fetch or
      // losing the request outright. Nothing running means nothing ever will
      // bring it in, so there is nothing to remember.
      if (this.model.loading) this.pendingSelect = { id, untilFound };
      return;
    }
    while (
      untilFound &&
      !this.model.has(id) &&
      this.model.more &&
      !this.disposed &&
      // Pages only go OLDER. Once the oldest loaded row is already below the
      // id being sought and it still is not listed, no further page can ever
      // hold it -- paging on would just keep fetching real, but irrelevant,
      // older history forever.
      !(this.model.oldest !== undefined && id > this.model.oldest)
    ) {
      // A failed page leaves `more` set; stop rather than ask again forever.
      const ok = await this.queuePageLoad(() => this.runFetch({ before: this.model.oldest }));
      if (!ok) return;
      // A newer select arrived while that page was loading (D16f): it
      // supersedes whichever id this loop was chasing.
      if (this.pendingSelect) return this.settleSelect(true);
    }
    if (!this.model.has(id)) return;
    this.model.selected = id;
    // D20e: without this, a failed details fetch for the PREVIOUS selection
    // stayed visible under the new one until its own fetch settled -- while
    // debouncing/in flight, `model.loading` (the PAGE banner's flag) is false,
    // so the details pane fell through to showing the old row's stale error
    // instead of "Loading…" (R4).
    this.model.detailsError = undefined;
    this.post();
    this.scheduleDetails(id);
  }

  /** D16d: fetch a selection's details only once it has stayed selected a moment. */
  private scheduleDetails(id: number): void {
    // D18f: nothing starts after the tab is closed.
    if (this.disposed) return;
    if (this.detailsTimer) clearTimeout(this.detailsTimer);
    this.detailsTimer = undefined;
    if (this.model.hasDetails(id)) return;
    this.detailsTimer = setTimeout(() => {
      this.detailsTimer = undefined;
      void this.loadDetails(id);
    }, DETAILS_DELAY_MS);
  }

  private async loadDetails(id: number): Promise<void> {
    try {
      const cs = await this.history.changeset(id);
      if (this.disposed) return;
      // Cached regardless of which row is selected now -- it is correct
      // content for `id` whenever it is looked at again.
      this.model.setDetails(cs);
      // D16d/D18c: a result for a row the user has since left never touches
      // `model.detailsError`, which by now may belong to whatever IS selected.
      if (this.model.selected !== id) return;
      this.model.detailsError = undefined;
    } catch (e) {
      if (this.disposed || this.model.selected !== id) return;
      // D18c: the details pane's own failure, kept apart from the page banner.
      this.model.detailsError = messageOf(e);
    }
    this.post();
  }

  /**
   * D20c: queues `job` behind whatever page load is already running (or
   * queued), so it runs at most one at a time. `job` is only invoked once it
   * is its own turn, never eagerly -- which is what lets a decision like
   * `needsMoreFor` be made fresh, right before it matters, rather than back
   * when the request first arrived: a second Compare click on the same row
   * (D18f) enqueues a job just like the first, but by the time ITS turn
   * comes the first click's fetch has already landed, so `needsMoreFor` is
   * no longer true and it costs no second tf call.
   *
   * The chain is reset to an always-resolved promise after each job so one
   * rejection (`job` itself never throws; this only guards a genuine bug)
   * cannot wedge every later page load behind it forever.
   */
  private queuePageLoad<T>(job: () => Promise<T> | T): Promise<T> {
    const run = this.queue.then(job, job);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async runFetch(options: { before?: number }): Promise<boolean> {
    this.model.loading = true;
    this.post();
    try {
      this.model.append(await this.history.page({ mode: this.target.mode, itemspec: this.target.serverPath }, options));
      this.model.error = undefined;
      return true;
    } catch (e) {
      this.model.error = messageOf(e);
      return false;
    } finally {
      this.model.loading = false;
      this.post();
    }
  }

  private async onMessage(raw: unknown): Promise<void> {
    const intent = parseIntent(raw);
    if (!intent) {
      this.log('history: dropped a message the History tab may not send');
      return;
    }
    try {
      await this.handle(intent);
    } catch (e) {
      void vscode.window.showErrorMessage(messageOf(e));
    }
  }

  private async handle(intent: Intent): Promise<void> {
    if (intent.type === 'ready') return this.post();
    if (intent.type === 'loadMore') {
      // D20c: the "is there more?" check moves INSIDE the queued job, so it
      // runs at the job's own turn rather than now -- if something else
      // already queued brought in everything there was, this costs no tf call.
      await this.settleSelect(await this.queuePageLoad(() => (this.model.more ? this.runFetch({ before: this.model.oldest }) : true)));
      return;
    }
    if (intent.type === 'select') return this.select(intent.id);

    // Every remaining intent names a row, and it must be one this extension listed.
    if (!this.model.has(intent.id)) {
      this.log(`history: ignored an action on changeset ${intent.id}, which is not in this list`);
      return;
    }
    if (intent.type === 'compare') {
      if (intent.item === undefined) {
        // D18f/D20c: `needsMoreFor` is re-checked at the job's own turn, not
        // now -- a second Compare click queued right behind the first's own
        // fetch finds the row already satisfied by it and fetches nothing.
        await this.settleSelect(
          await this.queuePageLoad(() => (this.model.needsMoreFor(intent.id) ? this.runFetch({ before: this.model.oldest }) : true)),
        );
      }
      const r = this.model.compare(intent.id, intent.item);
      if (!r.ok) return this.tell(r.message);
      await this.actions.compare(r.value.left, r.value.right, nameOf(r.value.right.serverPath));
    } else if (intent.type === 'view') {
      const r = this.model.view(intent.id, intent.item);
      if (!r.ok) return this.tell(r.message);
      await this.actions.view(r.value);
    } else {
      // D18g: a Get This Version already running for this panel absorbs a
      // second click rather than starting a second confirm/get over it.
      if (this.gettingVersion) return;
      const r = this.model.getVersion(intent.id);
      if (!r.ok) return this.tell(r.message);
      this.gettingVersion = true;
      try {
        await this.actions.getVersion(r.value, this.target.name);
      } finally {
        this.gettingVersion = false;
      }
    }
  }

  private tell(message: string): void {
    void vscode.window.showInformationMessage(message);
  }

  private post(): void {
    if (this.disposed) return;
    void this.panel.webview.postMessage({ type: 'state', state: this.model.state() });
  }
}
