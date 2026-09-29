import type { Changeset, HistoryItem } from '../tf/parseHistory.js';
import { S } from '../tf/strings.js';

/**
 * Declared here rather than imported from HistoryService.ts so this module
 * stays independent of it; Task 7 wires the two together and the compiler
 * checks the shapes agree.
 */
export type HistoryMode = 'file' | 'folder';
export interface HistoryPage {
  changesets: Changeset[];
  more: boolean;
}

/** Details rows rendered at most; one changeset in `$/Shop` has hundreds. */
export const DETAILS_CAP = 2000;

export interface VersionPointer {
  serverPath: string;
  changeset: number;
}

export type Resolution<T> = { ok: true; value: T } | { ok: false; message: string };

export interface RowView {
  id: number;
  user: string;
  date: string;
  comment: string;
  firstLine: string;
  canCompare: boolean;
  canView: boolean;
  canGet: boolean;
}

export interface DetailItemView {
  index: number;
  change: string;
  path: string;
  canCompare: boolean;
}

export interface DetailsView {
  id: number;
  user: string;
  date: string;
  comment: string;
  items: DetailItemView[];
  note?: string;
}

export interface HistoryState {
  title: string;
  mode: HistoryMode;
  rows: RowView[];
  selected?: number;
  details?: DetailsView;
  more: boolean;
  loading: boolean;
  /** The page-level failure (banner): a failed `page()`/`mergeNewest` fetch (D18c). */
  error?: string;
  /** The details pane's own failure, independent of the banner (D18c). */
  detailsError?: string;
  empty: boolean;
  labels: typeof S.historyLabels;
}

/** Everything the webview may ask for. */
export type Intent =
  | { type: 'ready' }
  | { type: 'loadMore' }
  | { type: 'select'; id: number }
  | { type: 'compare'; id: number; item?: number }
  | { type: 'view'; id: number; item?: number }
  | { type: 'getVersion'; id: number };

const isId = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0;
const isIndex = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

/**
 * Checks a webview message structurally and rebuilds it from the fields it
 * knows. Nothing else a message carries -- a path, an argv fragment -- ever
 * gets past this.
 */
export function parseIntent(raw: unknown): Intent | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  switch (r.type) {
    case 'ready':
      return { type: 'ready' };
    case 'loadMore':
      return { type: 'loadMore' };
    case 'select':
      return isId(r.id) ? { type: 'select', id: r.id } : undefined;
    case 'getVersion':
      return isId(r.id) && r.item === undefined ? { type: 'getVersion', id: r.id } : undefined;
    case 'compare':
    case 'view':
      if (!isId(r.id)) return undefined;
      if (r.item === undefined) return { type: r.type, id: r.id };
      return isIndex(r.item) ? { type: r.type, id: r.id, item: r.item } : undefined;
    default:
      return undefined;
  }
}

/** A version can have no predecessor: the item began here. */
const BEGINNINGS = ['add', 'branch', 'undelete'];
const has = (change: readonly string[], ...words: string[]): boolean => words.some((w) => change.includes(w));
const samePath = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
const nameOf = (serverPath: string): string => serverPath.slice(serverPath.lastIndexOf('/') + 1);
const ok = <T>(value: T): Resolution<T> => ({ ok: true, value });
const refuse = <T>(message: string): Resolution<T> => ({ ok: false, message });

/**
 * The History tab's state, and every decision about what an action on a row
 * means. Pure, so all of it is tested without a webview (D3).
 */
export class HistoryModel {
  private rows: Changeset[] = [];
  private readonly details = new Map<number, Changeset>();
  more = false;
  loading = false;
  error: string | undefined;
  /** D18c: the details pane's own failure -- kept apart from the page banner above. */
  detailsError: string | undefined;
  selected: number | undefined;

  constructor(
    readonly mode: HistoryMode,
    /** The file or folder this tab is about, under its CURRENT name. */
    readonly serverPath: string,
    readonly name: string,
  ) {}

  append(page: HistoryPage): void {
    const known = new Set(this.rows.map((r) => r.id));
    const added: Changeset[] = [];
    for (const c of page.changesets) {
      // A duplicate id can arrive within the SAME page, not just one already held.
      if (known.has(c.id)) continue;
      known.add(c.id);
      added.push(c);
    }
    this.rows = [...this.rows, ...added].sort((a, b) => b.id - a.id);
    this.more = page.more;
  }

  /**
   * D18b: folds a freshly-fetched page 1 into what is already loaded, adding
   * only rows this tab has not seen. Unlike `append`, `more` is left alone --
   * this only learns about rows NEWER than what is loaded, so it says nothing
   * about whether older, not-yet-loaded pages still exist.
   *
   * D20b: when the fresh page shares NO id with what is loaded and it says
   * there is still more beyond it, the two sets are NOT simply unioned -- 50+
   * check-ins between reopens means the rows strictly between the old newest
   * and the new page's oldest were never fetched at all, and silently keeping
   * both halves would leave that gap invisible (Compare on the new oldest row
   * would then pair it with the stale old newest row across it). The loaded
   * rows are replaced by the fresh page instead, and `more` follows it too.
   */
  mergeNewest(page: HistoryPage): void {
    const known = new Set(this.rows.map((r) => r.id));
    const overlaps = page.changesets.some((c) => known.has(c.id));
    if (!overlaps && page.more) {
      const dedup = new Map<number, Changeset>();
      for (const c of page.changesets) dedup.set(c.id, c);
      this.rows = [...dedup.values()].sort((a, b) => b.id - a.id);
      this.more = page.more;
      return;
    }
    const added: Changeset[] = [];
    for (const c of page.changesets) {
      if (known.has(c.id)) continue;
      known.add(c.id);
      added.push(c);
    }
    this.rows = [...this.rows, ...added].sort((a, b) => b.id - a.id);
  }

  get oldest(): number | undefined {
    return this.rows.length > 0 ? this.rows[this.rows.length - 1].id : undefined;
  }

  has(id: number): boolean {
    return this.indexOf(id) >= 0;
  }

  hasDetails(id: number): boolean {
    return this.details.has(id);
  }

  setDetails(cs: Changeset): void {
    this.details.set(cs.id, cs);
  }

  /** Compare on the oldest loaded row needs the next page first: its predecessor is not loaded. */
  needsMoreFor(id: number): boolean {
    return this.mode === 'file' && this.more && this.indexOf(id) === this.rows.length - 1;
  }

  compare(id: number, item?: number): Resolution<{ left: VersionPointer; right: VersionPointer }> {
    if (item !== undefined) return this.compareItem(id, item);
    const row = this.fileRow(id);
    if (!row.ok) return row;
    const { index, item: it } = row.value;
    if (has(it.change, 'delete')) return refuse(S.versionDeleted(id));
    if (has(it.change, ...BEGINNINGS)) return refuse(S.noPreviousVersion(id));
    const prev = this.rows[index + 1];
    if (!prev) {
      // D13: no next row could mean "this is where the file began" OR "the next
      // page holding it just has not arrived" -- those are different messages.
      return refuse(this.more ? S.previousNotLoaded(id) : S.noPreviousVersion(id));
    }
    const prevItem = prev.items[0];
    if (!prevItem || has(prevItem.change, 'delete')) return refuse(S.noPreviousVersion(id));
    // Each side at the path ITS record printed, which is how a rename is followed (F9).
    return ok({
      left: { serverPath: prevItem.serverPath, changeset: prev.id },
      right: { serverPath: it.serverPath, changeset: id },
    });
  }

  view(id: number, item?: number): Resolution<VersionPointer> {
    if (item !== undefined) return this.viewItem(id, item);
    const row = this.fileRow(id);
    if (!row.ok) return row;
    if (has(row.value.item.change, 'delete')) return refuse(S.versionDeleted(id));
    return ok({ serverPath: row.value.item.serverPath, changeset: id });
  }

  getVersion(id: number): Resolution<VersionPointer> {
    const row = this.fileRow(id);
    if (!row.ok) return row;
    const it = row.value.item;
    if (has(it.change, 'delete')) return refuse(S.versionDeleted(id));
    // D1: `get $/old/name` would put a second file on disk under the old name.
    if (!samePath(it.serverPath, this.serverPath)) return refuse(S.getVersionRenamed);
    return ok({ serverPath: this.serverPath, changeset: id });
  }

  state(): HistoryState {
    return {
      title: S.historyTitle(this.name),
      mode: this.mode,
      rows: this.rows.map((cs, i) => this.rowView(cs, i)),
      selected: this.selected,
      details: this.selected === undefined ? undefined : this.detailsView(this.selected),
      more: this.more,
      loading: this.loading,
      error: this.error,
      detailsError: this.detailsError,
      empty: !this.loading && this.error === undefined && this.rows.length === 0,
      labels: S.historyLabels,
    };
  }

  private indexOf(id: number): number {
    return this.rows.findIndex((r) => r.id === id);
  }

  private fileRow(id: number): Resolution<{ index: number; item: HistoryItem }> {
    const index = this.indexOf(id);
    if (index < 0) return refuse(S.historyStale);
    if (this.mode === 'folder') return refuse(S.folderRowAction);
    // An /itemmode record lists exactly one item: this file, under its name then.
    const item = this.rows[index].items[0];
    return item ? ok({ index, item }) : refuse(S.historyStale);
  }

  private detailItem(id: number, index: number): HistoryItem | undefined {
    // D13: the details map is keyed independently of `rows`, so without this an
    // id that scrolled out of the loaded rows (or was never one) still resolved.
    if (!this.has(id) || index >= DETAILS_CAP) return undefined;
    return this.details.get(id)?.items[index];
  }

  private compareItem(id: number, index: number): Resolution<{ left: VersionPointer; right: VersionPointer }> {
    const it = this.detailItem(id, index);
    if (!it) return refuse(S.historyStale);
    // D9: the previous version is under a name this changeset's text cannot pair with it.
    if (has(it.change, 'rename')) return refuse(S.compareRenamedItem(nameOf(it.serverPath)));
    if (has(it.change, 'delete')) return refuse(S.versionDeleted(id));
    if (has(it.change, ...BEGINNINGS)) return refuse(S.noPreviousVersion(id));
    return ok({
      left: { serverPath: it.serverPath, changeset: id - 1 },
      right: { serverPath: it.serverPath, changeset: id },
    });
  }

  private viewItem(id: number, index: number): Resolution<VersionPointer> {
    const it = this.detailItem(id, index);
    if (!it) return refuse(S.historyStale);
    // A deleted item has no content at C<n>; show the last content it had.
    return ok({ serverPath: it.serverPath, changeset: has(it.change, 'delete') ? id - 1 : id });
  }

  private rowView(cs: Changeset, index: number): RowView {
    const it = cs.items[0];
    const file = this.mode === 'file' && it !== undefined;
    const comparable =
      file && !has(it.change, 'delete', ...BEGINNINGS) && (index + 1 < this.rows.length || this.more);
    return {
      id: cs.id,
      user: cs.user,
      date: cs.date,
      comment: cs.comment,
      firstLine: cs.comment.split('\n')[0],
      canCompare: comparable,
      canView: file && !has(it.change, 'delete'),
      canGet: this.getVersion(cs.id).ok,
    };
  }

  private detailsView(id: number): DetailsView | undefined {
    const cs = this.details.get(id);
    if (!cs) return undefined;
    return {
      id,
      user: cs.user,
      date: cs.date,
      comment: cs.comment,
      items: cs.items.slice(0, DETAILS_CAP).map((it, index) => ({
        index,
        change: it.change.join(', '),
        path: it.serverPath,
        canCompare: this.compareItem(id, index).ok,
      })),
      note: cs.items.length > DETAILS_CAP ? S.historyShowingOf(DETAILS_CAP, cs.items.length) : undefined,
    };
  }
}
