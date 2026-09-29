import { localKey, type Platform } from '../tf/PathMapper.js';
import type { DirListing } from '../tf/parseDir.js';
import type { InfoItem } from '../tf/parseInfo.js';
import { S } from '../tf/strings.js';
import type { ChangeFlag, OwnedPendingChange } from '../tf/types.js';
import { parseVersionRequest, type VersionRequest } from './getVersion.js';

/**
 * The Source Control Explorer's state, and every decision about it. Pure,
 * like historyModel.ts: the panel only moves data
 * between tf, this model and the page, so all of it is tested with no webview.
 */

export type Latest = 'yes' | 'no' | 'notDownloaded' | 'notMapped' | 'unknown';
export type LoadState = 'loading' | 'ok' | 'failed';
export type SortKey = 'name' | 'pending' | 'user' | 'latest' | 'lastCheckIn';
export interface SortState {
  key: SortKey;
  dir: 'asc' | 'desc';
}
export type ExplorerAction =
  | 'getLatest' | 'getSpecific' | 'checkout' | 'undo' | 'history' | 'compare'
  | 'view' | 'annotate' | 'addItems' | 'rename' | 'delete' | 'map' | 'copyPath' | 'open';

/** Every action: the right-click menu's order, then `open` (the double-click). */
export const ACTIONS: readonly ExplorerAction[] = [
  'getLatest', 'getSpecific', 'checkout', 'undo', 'history', 'compare', 'view', 'annotate', 'addItems',
  'rename', 'delete', 'map', 'copyPath', 'open',
];

export interface ExplorerRow {
  name: string;
  serverPath: string;
  isFolder: boolean;
  /** Your own pending change here, in one of this computer's workspaces, e.g. "edit". '' when none. */
  pending: string;
  /** Everyone with a pending change on it, you first. */
  users: string[];
  /** One hover line per pending change: "Boris (BORIS/BORIS): edit, 2025-11-03". */
  userDetails: string[];
  /** True once `status` has actually loaded (not while loading, and not on failure): Undo needs it to know `pending` is trustworthy. */
  statusKnown: boolean;
  latest: Latest;
  /** The server's `Last modified`, verbatim (X6). '' until info arrives. */
  lastCheckIn: string;
  /** The server's latest changeset: Last Check-in's sort key, and the version View opens. */
  serverChangeset?: number;
  /** The native local path, when the item is mapped. */
  localPath?: string;
}

export interface Crumb {
  name: string;
  path: string;
}

export interface TreeRow {
  path: string;
  name: string;
  depth: number;
  expanded: boolean;
  loading: boolean;
  current: boolean;
}

export interface DialogState {
  /** Bumped whenever the HOST changes the dialog; until then the page keeps its own fields, and the user's typing. */
  rev: number;
  paths: string[];
  recursive: boolean;
  /** The items, named for the dialog's second line. */
  what: string;
  request: VersionRequest;
  error?: string;
}

export interface ExplorerState {
  title: string;
  path: string;
  crumbs: Crumb[];
  tree: TreeRow[];
  rows: ExplorerRow[];
  listState: LoadState;
  listError?: string;
  infoState: LoadState;
  statusState: LoadState;
  footer: string;
  sort: SortState;
  selection: string[];
  /** For the selection: the menu dims the rest (History's D18a: dimmed, never disabled). */
  allowed: ExplorerAction[];
  /** For the open folder: the toolbar. */
  folderAllowed: ExplorerAction[];
  dialog?: DialogState;
  labels: typeof S.sceLabels;
}

export type ExplorerIntent =
  | { type: 'ready' }
  | { type: 'refresh' }
  | { type: 'closeDialog' }
  | { type: 'navigate'; path: string }
  | { type: 'toggle'; path: string }
  | { type: 'sort'; key: SortKey }
  | { type: 'select'; paths: string[] }
  | { type: 'action'; action: ExplorerAction; paths: string[] }
  | { type: 'submitDialog'; request: VersionRequest }
  | { type: 'pickChangeset'; request: VersionRequest };

const key = (path: string): string => path.toLowerCase();
const unique = (xs: readonly string[]): string[] => [...new Set(xs)];

export const childPath = (parent: string, name: string): string => (parent === '$/' ? `$/${name}` : `${parent}/${name}`);

export function parentPath(path: string): string {
  if (path === '$/') return '$/';
  const i = path.lastIndexOf('/');
  return i <= 1 ? '$/' : path.slice(0, i);
}

export const nameOf = (path: string): string => (path === '$/' ? '$/' : path.slice(path.lastIndexOf('/') + 1));

export function crumbs(path: string): Crumb[] {
  if (path === '$/') return [{ name: '$/', path: '$/' }];
  const parts = path.slice(2).split('/');
  return [{ name: '$/', path: '$/' }, ...parts.map((p, i) => ({ name: p, path: '$/' + parts.slice(0, i + 1).join('/') }))];
}

/**
 * What the page may name: a `$/` path of sane length, with no control
 * characters, no tf wildcard or itemspec syntax (`* ? ;`), and no empty, `.`
 * or `..` segment -- any of which `folderRow()`/`rowsFor()` would otherwise
 * turn into an action target with no listing behind it (review finding 3).
 * Only the bare root may end in a slash.
 */
export const isServerPath = (v: unknown): v is string => {
  if (typeof v !== 'string' || v.length > 4096 || !v.startsWith('$/')) return false;
  if (/[\u0000-\u001f*?;]/.test(v)) return false;
  if (v === '$/') return true;
  if (v.endsWith('/')) return false;
  return v
    .slice(2)
    .split('/')
    .every((segment) => segment !== '' && segment !== '.' && segment !== '..');
};

const MAX_PATHS = 5000;
const isPathList = (v: unknown): v is string[] => Array.isArray(v) && v.length <= MAX_PATHS && v.every(isServerPath);
const SORT_KEYS: readonly SortKey[] = ['name', 'pending', 'user', 'latest', 'lastCheckIn'];

const WORDS: Partial<Record<ChangeFlag, string>> = { SourceRename: 'rename' };

/** "edit", "add, edit": Encoding rides along with an Add and is only named when it is all there is. */
export function changeLabel(changes: ReadonlySet<ChangeFlag>): string {
  const flags = [...changes];
  const shown = flags.length > 1 ? flags.filter((f) => f !== 'Encoding') : flags;
  return unique(shown.map((f) => WORDS[f] ?? f.toLowerCase())).join(', ');
}

export interface RowInputs {
  listing: DirListing;
  /** Undefined while loading, or when it failed. */
  info: InfoItem[] | undefined;
  /** Undefined while loading, or when it failed. */
  status: OwnedPendingChange[] | undefined;
  isMine: (c: OwnedPendingChange) => boolean;
  /** PathMapper.toLocalPath: undefined outside every mapping (Q8). */
  localPathOf: (serverPath: string) => string | undefined;
}

export function buildRows(i: RowInputs): ExplorerRow[] {
  const infoBy = new Map((i.info ?? []).map((it) => [key(it.serverPath), it] as const));
  const changesBy = new Map<string, OwnedPendingChange[]>();
  for (const c of i.status ?? []) {
    const k = key(c.serverItem);
    const list = changesBy.get(k);
    if (list) list.push(c);
    else changesBy.set(k, [c]);
  }
  // Undefined while loading or on failure (RowInputs.status), same as info: not yet ok to trust an empty `pending`.
  const statusKnown = i.status !== undefined;

  const make = (name: string, isFolder: boolean): ExplorerRow => {
    const serverPath = childPath(i.listing.path, name);
    const it = infoBy.get(key(serverPath));
    const changes = changesBy.get(key(serverPath)) ?? [];
    const mine = changes.filter(i.isMine);
    const ordered = [...mine, ...changes.filter((c) => !i.isMine(c))];
    const localPath = i.localPathOf(serverPath);
    const row: ExplorerRow = {
      name,
      serverPath,
      isFolder,
      pending: unique(mine.map((c) => changeLabel(c.changes))).join(', '),
      users: unique(ordered.map((c) => c.owner)),
      userDetails: ordered.map((c) => `${c.owner} (${c.computer}/${c.workspace}): ${changeLabel(c.changes)}, ${c.date.slice(0, 10)}`),
      statusKnown,
      latest: latestOf(localPath, i.info, it),
      lastCheckIn: it?.lastModified ?? '',
    };
    if (it) row.serverChangeset = it.serverChangeset;
    if (localPath !== undefined) row.localPath = localPath;
    return row;
  };

  return [...i.listing.folders.map((f) => make(f, true)), ...i.listing.files.map((f) => make(f, false))];
}

function latestOf(localPath: string | undefined, info: InfoItem[] | undefined, it: InfoItem | undefined): Latest {
  if (localPath === undefined) return 'notMapped';
  if (info === undefined || it === undefined) return 'unknown';
  if (it.localChangeset === undefined) return 'notDownloaded';
  return it.localChangeset === it.serverChangeset ? 'yes' : 'no';
}

const LATEST_ORDER: Record<Latest, number> = { no: 0, notDownloaded: 1, yes: 2, notMapped: 3, unknown: 4 };
const byName = (a: ExplorerRow, b: ExplorerRow): number => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
const BY_KEY: Record<SortKey, (a: ExplorerRow, b: ExplorerRow) => number> = {
  name: byName,
  pending: (a, b) => a.pending.localeCompare(b.pending),
  user: (a, b) => a.users.join(', ').localeCompare(b.users.join(', ')),
  latest: (a, b) => LATEST_ORDER[a.latest] - LATEST_ORDER[b.latest],
  // X6: by changeset, never by the localized date text.
  lastCheckIn: (a, b) => (a.serverChangeset ?? -1) - (b.serverChangeset ?? -1),
};

/** Folders first in either direction, as Visual Studio does; ties by name. */
export function sortRows(rows: readonly ExplorerRow[], sort: SortState): ExplorerRow[] {
  const sign = sort.dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
    return sign * BY_KEY[sort.key](a, b) || byName(a, b);
  });
}

const SINGLE_ONLY: ReadonlySet<ExplorerAction> = new Set(['open', 'history', 'compare', 'view', 'annotate', 'addItems', 'rename', 'map']);

/** Destructive: they need an item the user picked, never the folder being browsed. */
export const SELECTION_ONLY: ReadonlySet<ExplorerAction> = new Set(['rename', 'delete']);

/** A local copy is needed: never downloaded, or not known yet, is a refusal. */
function downloadedProblem(rows: readonly ExplorerRow[]): string | undefined {
  const notDown = rows.find((r) => r.latest === 'notDownloaded');
  if (notDown) return S.sceNotDownloaded(notDown.name);
  const unknown = rows.find((r) => r.latest === 'unknown');
  return unknown ? S.sceNotLoaded(unknown.name) : undefined;
}

/**
 * Undo is recursive on a folder, so a folder is always allowed regardless of
 * its own (never tracked) pending state. A file needs status loaded, and
 * something of MINE pending on it -- someone else's change, or none at all,
 * is not something Undo here can act on.
 */
function undoProblem(rows: readonly ExplorerRow[]): string | undefined {
  const files = rows.filter((r) => !r.isFolder);
  if (files.length === 0) return undefined;
  const notLoaded = files.find((r) => !r.statusKnown);
  if (notLoaded) return S.sceNotLoaded(notLoaded.name);
  const nothingPending = files.filter((r) => r.pending === '');
  return nothingPending.length > 0 ? S.nothingPendingOn(nothingPending.map((r) => r.name)) : undefined;
}

/** Why `action` cannot run on `rows`, in the user's words; undefined when it can. */
export function refusal(action: ExplorerAction, rows: readonly ExplorerRow[]): string | undefined {
  if (rows.length === 0) return S.sceNeedsSelection;
  if (SINGLE_ONLY.has(action) && rows.length !== 1) return S.sceNeedsOne;
  const first = rows[0];
  const unmapped = rows.find((r) => r.latest === 'notMapped');

  // Server-side only: these work on anything the server has.
  switch (action) {
    case 'open':
    case 'history':
    case 'copyPath':
      return undefined;
    case 'view':
      if (first.isFolder) return S.sceNotAFile(first.name);
      return first.serverChangeset === undefined ? S.sceNotLoaded(first.name) : undefined;
    case 'map':
      // Only where nothing is mapped yet: changing an existing mapping moves
      // files out of Visual Studio's tree on the next Get (part 1 P11), and
      // that belongs in Manage Workspace with its own confirms.
      return unmapped ? undefined : S.sceAlreadyMapped(first.name, first.localPath ?? '');
    default:
      break;
  }

  if (unmapped) return S.sceNotMappedAction(unmapped.name);
  switch (action) {
    case 'getLatest':
    case 'getSpecific':
      return undefined;
    case 'undo':
      return undoProblem(rows);
    case 'addItems':
      if (!first.isFolder) return S.sceNotAFolder(first.name);
      return first.latest === 'notDownloaded' ? S.sceNotDownloaded(first.name) : undefined;
    case 'compare':
    case 'annotate':
      if (first.isFolder) return S.sceNotAFile(first.name);
      return downloadedProblem(rows);
    case 'checkout':
      return downloadedProblem(rows);
    case 'rename':
      // R13: tf moves the item itself, so it needs the local copy. Delete does
      // not (R15), which is why only this half refuses here.
      if (first.latest === 'notDownloaded') return S.sceNotDownloaded(first.name);
      return first.latest === 'unknown' ? S.sceNotLoaded(first.name) : undefined;
    case 'delete':
      return undefined;
  }
  return undefined;
}

export function allowedActions(rows: readonly ExplorerRow[]): ExplorerAction[] {
  return ACTIONS.filter((a) => refusal(a, rows) === undefined);
}

/** The left pane: `$/` and the children of every expanded folder, as indented rows. */
export function treeRows(
  expanded: ReadonlySet<string>,
  childrenOf: (path: string) => string[] | undefined,
  current: string,
): TreeRow[] {
  const out: TreeRow[] = [];
  const walk = (path: string, depth: number): void => {
    const open = expanded.has(key(path));
    const kids = childrenOf(path);
    out.push({ path, name: nameOf(path), depth, expanded: open, loading: open && kids === undefined, current: key(path) === key(current) });
    if (open && kids) for (const k of kids) walk(childPath(path, k), depth + 1);
  };
  walk('$/', 0);
  return out;
}

/** Add Items to Folder: the scan's unversioned files that lie under `folder` (Phase 1 scan). */
export function filesUnder(paths: readonly string[], folder: string, platform: Platform): string[] {
  const sep = platform === 'win32' ? '\\' : '/';
  const root = localKey(folder, platform).replace(/[\\/]+$/, '') + sep;
  return paths.filter((p) => localKey(p, platform).startsWith(root));
}

/** Holds a page message to exactly one of the intents above; undefined for anything else. */
export function parseExplorerIntent(raw: unknown): ExplorerIntent | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  switch (r.type) {
    case 'ready':
      return { type: 'ready' };
    case 'refresh':
      return { type: 'refresh' };
    case 'closeDialog':
      return { type: 'closeDialog' };
    case 'navigate':
      return isServerPath(r.path) ? { type: 'navigate', path: r.path } : undefined;
    case 'toggle':
      return isServerPath(r.path) ? { type: 'toggle', path: r.path } : undefined;
    case 'sort':
      return SORT_KEYS.includes(r.key as SortKey) ? { type: 'sort', key: r.key as SortKey } : undefined;
    case 'select':
      return isPathList(r.paths) ? { type: 'select', paths: r.paths } : undefined;
    case 'action':
      return ACTIONS.includes(r.action as ExplorerAction) && isPathList(r.paths)
        ? { type: 'action', action: r.action as ExplorerAction, paths: r.paths }
        : undefined;
    case 'submitDialog':
    case 'pickChangeset': {
      const request = parseVersionRequest(r.request);
      if (!request) return undefined;
      return r.type === 'submitDialog' ? { type: 'submitDialog', request } : { type: 'pickChangeset', request };
    }
    default:
      return undefined;
  }
}

export interface ModelDeps {
  isMine(c: OwnedPendingChange): boolean;
  localPathOf(serverPath: string): string | undefined;
  /** A folder's subfolders, when its listing is cached; undefined when it is not (yet). */
  childrenOf(serverPath: string): string[] | undefined;
}

export class ExplorerModel {
  path = '$/';
  sort: SortState = { key: 'name', dir: 'asc' };
  selection: string[] = [];
  listing: DirListing | undefined;
  listState: LoadState = 'loading';
  listError: string | undefined;
  info: InfoItem[] | undefined;
  infoState: LoadState = 'loading';
  status: OwnedPendingChange[] | undefined;
  statusState: LoadState = 'loading';
  /** `HH:MM:SS` of the last info+status load, for the footer. */
  loadedAt: string | undefined;
  dialog: DialogState | undefined;
  private readonly expanded = new Set<string>(['$/']);
  private dialogRev = 0;

  constructor(private readonly deps: ModelDeps) {}

  /** Opens `path`: drops what belonged to the old folder, and expands every ancestor in the tree. */
  navigate(path: string): void {
    this.path = path;
    this.selection = [];
    this.listing = undefined;
    this.listState = 'loading';
    this.listError = undefined;
    this.info = undefined;
    this.infoState = 'loading';
    this.status = undefined;
    this.statusState = 'loading';
    this.loadedAt = undefined;
    this.dialog = undefined;
    for (const c of crumbs(path)) this.expanded.add(key(c.path));
  }

  isExpanded(path: string): boolean {
    return this.expanded.has(key(path));
  }

  toggle(path: string): void {
    const k = key(path);
    if (this.expanded.has(k)) this.expanded.delete(k);
    else this.expanded.add(k);
  }

  sortBy(k: SortKey): void {
    this.sort = this.sort.key === k ? { key: k, dir: this.sort.dir === 'asc' ? 'desc' : 'asc' } : { key: k, dir: 'asc' };
  }

  rows(): ExplorerRow[] {
    if (!this.listing) return [];
    return sortRows(
      buildRows({ listing: this.listing, info: this.info, status: this.status, isMine: (c) => this.deps.isMine(c), localPathOf: (p) => this.deps.localPathOf(p) }),
      this.sort,
    );
  }

  /** The rows `paths` name, or undefined when any is not listed: the host acts only on rows it loaded. */
  rowsFor(paths: readonly string[]): ExplorerRow[] | undefined {
    const all = new Map(this.rows().map((r) => [key(r.serverPath), r] as const));
    const out: ExplorerRow[] = [];
    for (const p of paths) {
      const r = all.get(key(p));
      if (!r) return undefined;
      out.push(r);
    }
    return out;
  }

  /** The open folder as a row: what the toolbar acts on. Its own Latest is not known (its info block is empty, Q2). */
  folderRow(): ExplorerRow {
    const localPath = this.deps.localPathOf(this.path);
    const row: ExplorerRow = {
      name: nameOf(this.path),
      serverPath: this.path,
      isFolder: true,
      pending: '',
      users: [],
      userDetails: [],
      // Never tracked for the open folder itself (Q2); irrelevant anyway since undoProblem skips folders.
      statusKnown: false,
      latest: localPath === undefined ? 'notMapped' : 'unknown',
      lastCheckIn: '',
    };
    if (localPath !== undefined) row.localPath = localPath;
    return row;
  }

  /** Whether an intent may open `path`: `$/`, the crumbs, the tree, or a listed folder. */
  knows(path: string): boolean {
    const k = key(path);
    if (k === '$/' || k === key(this.path)) return true;
    if (crumbs(this.path).some((c) => key(c.path) === k)) return true;
    if (treeRows(this.expanded, (p) => this.deps.childrenOf(p), this.path).some((t) => key(t.path) === k)) return true;
    return this.rows().some((r) => r.isFolder && key(r.serverPath) === k);
  }

  openDialog(rows: readonly ExplorerRow[]): void {
    this.dialog = {
      rev: ++this.dialogRev,
      paths: rows.map((r) => r.serverPath),
      recursive: rows.some((r) => r.isFolder),
      what: S.sceWhat(rows.map((r) => r.name)),
      request: { kind: 'changeset', value: '', overwriteWritable: false, getAll: false },
    };
  }

  updateDialog(change: { request?: VersionRequest; error?: string }): void {
    if (!this.dialog) return;
    this.dialog = { ...this.dialog, ...change, rev: ++this.dialogRev };
  }

  closeDialog(): void {
    this.dialog = undefined;
  }

  state(): ExplorerState {
    const rows = this.rows();
    const state: ExplorerState = {
      title: S.sceTitle,
      path: this.path,
      crumbs: crumbs(this.path),
      tree: treeRows(this.expanded, (p) => this.deps.childrenOf(p), this.path),
      rows,
      listState: this.listState,
      infoState: this.infoState,
      statusState: this.statusState,
      footer: this.listState === 'ok' ? S.sceFooter(rows.length, this.loadedAt) : '',
      sort: this.sort,
      selection: this.selection,
      allowed: allowedActions(this.rowsFor(this.selection) ?? []),
      folderAllowed: allowedActions([this.folderRow()]).filter((a) => !SELECTION_ONLY.has(a)),
      labels: S.sceLabels,
    };
    if (this.listError !== undefined) state.listError = this.listError;
    if (this.dialog) state.dialog = this.dialog;
    return state;
  }
}
