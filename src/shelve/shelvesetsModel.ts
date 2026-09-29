import type { Shelveset, ShelvedChange } from '../tf/parseShelvesets.js';
import { S } from '../tf/strings.js';
import { changeLabel, nameOf, parentPath } from '../explorer/explorerModel.js';
import { isMine, newestFirst } from './shelveRules.js';

export type LoadState = 'loading' | 'ok' | 'failed';
export type FileAction = 'compareUnmodified' | 'compareWorkspace' | 'viewShelved';
export const FILE_ACTIONS: readonly FileAction[] = ['compareUnmodified', 'compareWorkspace', 'viewShelved'];

/** A shelveset's key on the page. A name cannot hold `;`, so `name;owner` is unique -- and is tf's own itemspec (S18). */
export const keyOf = (s: Pick<Shelveset, 'name' | 'ownerUnique'>): string => `${s.name};${s.ownerUnique}`;

export interface ShelvesetRow {
  key: string;
  name: string;
  owner: string;
  date: string;
  /** The comment's first line; the details show all of it. */
  comment: string;
  mine: boolean;
  /** Why a dimmed Delete is dimmed, for the page to show on hover. Absent when `mine`. */
  deleteTitle?: string;
}

export interface ChangeRow {
  serverPath: string;
  /** The file name; a rename reads `old → new`. */
  name: string;
  folder: string;
  change: string;
  ticked: boolean;
}

export interface DetailsState {
  key: string;
  name: string;
  owner: string;
  date: string;
  comment: string;
  mine: boolean;
  /** Why a dimmed Delete is dimmed, for the page to show on hover. Absent when `mine`. */
  deleteTitle?: string;
  state: LoadState;
  error?: string;
  changes: ChangeRow[];
  preserve: boolean;
  /** An unshelve is running: the page shows it, the view ignores a second one. */
  busy: boolean;
}

/** Everything the page draws, posted whole on every change. */
export interface ShelvesetsState {
  owner: string;
  ownerError?: string;
  listState: LoadState;
  listError?: string;
  rows: ShelvesetRow[];
  selected?: string;
  details?: DetailsState;
  labels: typeof S.shelvesetsLabels;
}

export type ShelvesetsIntent =
  | { type: 'ready' }
  | { type: 'refresh' }
  | { type: 'unshelve' }
  | { type: 'find'; owner: string }
  | { type: 'select'; key: string }
  | { type: 'delete'; key: string }
  | { type: 'tick'; paths: string[]; ticked: boolean }
  | { type: 'preserve'; value: boolean }
  | { type: 'file'; action: FileAction; path: string };

/** `YYYY-MM-DD HH:MM` in local time, from tf's ISO date; one that does not parse is shown as tf wrote it. */
export function displayDate(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const MAX_PATHS = 5000;
const isKey = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 1024 && !/[\x00-\x1f]/.test(v);
/** A server path the page may name: no wildcard, no `;` itemspec syntax, no control character. */
const isItem = (v: unknown): v is string =>
  typeof v === 'string' && v.startsWith('$/') && v.length <= 4096 && !/[\x00-\x1f*?;]/.test(v);

/** The only messages the page may send; anything else is dropped and logged by the view. */
export function parseShelvesetsIntent(raw: unknown): ShelvesetsIntent | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  switch (r.type) {
    case 'ready':
      return { type: 'ready' };
    case 'refresh':
      return { type: 'refresh' };
    case 'unshelve':
      return { type: 'unshelve' };
    case 'find':
      return typeof r.owner === 'string' && r.owner.length <= 256 ? { type: 'find', owner: r.owner } : undefined;
    case 'select':
      return isKey(r.key) ? { type: 'select', key: r.key } : undefined;
    case 'delete':
      return isKey(r.key) ? { type: 'delete', key: r.key } : undefined;
    case 'tick':
      return Array.isArray(r.paths) && r.paths.length <= MAX_PATHS && r.paths.every(isItem) && typeof r.ticked === 'boolean'
        ? { type: 'tick', paths: r.paths as string[], ticked: r.ticked }
        : undefined;
    case 'preserve':
      return typeof r.value === 'boolean' ? { type: 'preserve', value: r.value } : undefined;
    case 'file':
      return FILE_ACTIONS.includes(r.action as FileAction) && isItem(r.path)
        ? { type: 'file', action: r.action as FileAction, path: r.path }
        : undefined;
    default:
      return undefined;
  }
}

interface Details {
  key: string;
  state: LoadState;
  error?: string;
  changes: ShelvedChange[];
  ticked: Set<string>;
  preserve: boolean;
  busy: boolean;
  /**
   * The shelveset's date when these details were (re)opened. `reopen` compares it against the
   * list's current date for the same key, to tell a Refresh of the SAME shelveset (keep the
   * user's choices) from one replaced elsewhere, e.g. `/replace`d from another machine (start
   * fresh).
   */
  date: string;
}

/** The Shelvesets tab's state. Pure: ShelvesetsView feeds it tf's answers and posts `state()`. */
export class ShelvesetsModel {
  /** The Owner box's text, as the user typed it. */
  owner = '';
  ownerError: string | undefined;
  listState: LoadState = 'loading';
  listError: string | undefined;
  private list: Shelveset[] = [];
  private details: Details | undefined;

  /** `aliases` is read on every call: the workspace list arrives after the tab opens. */
  constructor(private readonly aliases: () => readonly string[]) {}

  loadingList(): void {
    this.listState = 'loading';
    this.listError = undefined;
  }

  setList(list: readonly Shelveset[]): void {
    this.list = newestFirst(list);
    this.listState = 'ok';
    this.listError = undefined;
    if (this.details && !this.find(this.details.key)) this.details = undefined;
  }

  failList(message: string): void {
    this.list = [];
    this.listState = 'failed';
    this.listError = message;
    this.details = undefined;
  }

  find(key: string): Shelveset | undefined {
    return this.list.find((s) => keyOf(s) === key);
  }

  get selected(): Shelveset | undefined {
    return this.details ? this.find(this.details.key) : undefined;
  }

  /** Starts loading a shelveset's changes, fresh. Preserve starts ticked, as in Visual Studio. */
  select(key: string): Shelveset | undefined {
    const s = this.find(key);
    if (!s) return undefined;
    this.details = { key, state: 'loading', changes: [], ticked: new Set(), preserve: true, busy: false, date: s.date };
    return s;
  }

  /**
   * The implicit re-select a Refresh makes of the currently open shelveset: when
   * the reload finds the SAME shelveset -- same key, same date -- the user's choices are carried
   * into the reload (Preserve, and each still-listed change's tick; `setChanges` ticks a change
   * new to the reload and drops one no longer listed). A different date means it was replaced
   * (e.g. `/replace`d from another machine) while the tab had it open: starts fresh, exactly like
   * `select`.
   */
  reopen(key: string): Shelveset | undefined {
    const s = this.find(key);
    if (!s) return undefined;
    const prior = this.details;
    this.details =
      prior && prior.key === key && prior.date === s.date
        ? { key, state: 'loading', changes: prior.changes, ticked: new Set(prior.ticked), preserve: prior.preserve, busy: false, date: s.date }
        : { key, state: 'loading', changes: [], ticked: new Set(), preserve: true, busy: false, date: s.date };
    return s;
  }

  /** An answer for a shelveset that is no longer selected is dropped. */
  setChanges(key: string, changes: readonly ShelvedChange[]): void {
    if (!this.details || this.details.key !== key) return;
    const priorItems = new Set(this.details.changes.map((c) => c.serverItem));
    const priorTicked = this.details.ticked;
    this.details.state = 'ok';
    this.details.error = undefined;
    this.details.changes = [...changes];
    // Visual Studio opens a shelveset with every change ticked; `reopen` seeds `priorItems` /
    // `priorTicked` from what was already open, so a same-shelveset Refresh keeps the user's
    // ticks instead -- a change already ticked, or new to this load, ends ticked.
    this.details.ticked = new Set(
      changes.filter((c) => priorTicked.has(c.serverItem) || !priorItems.has(c.serverItem)).map((c) => c.serverItem),
    );
  }

  failChanges(key: string, message: string): void {
    if (!this.details || this.details.key !== key) return;
    this.details.state = 'failed';
    this.details.error = message;
    this.details.changes = [];
    this.details.ticked = new Set();
  }

  tick(paths: readonly string[], on: boolean): void {
    const d = this.details;
    if (!d || d.state !== 'ok') return;
    for (const p of paths) {
      if (!d.changes.some((c) => c.serverItem === p)) continue;
      if (on) d.ticked.add(p);
      else d.ticked.delete(p);
    }
  }

  setPreserve(value: boolean): void {
    if (this.details) this.details.preserve = value;
  }

  setBusy(value: boolean): void {
    if (this.details) this.details.busy = value;
  }

  get changes(): readonly ShelvedChange[] {
    return this.details?.changes ?? [];
  }

  get ticked(): ReadonlySet<string> {
    return this.details?.ticked ?? new Set();
  }

  get preserve(): boolean {
    return this.details?.preserve ?? true;
  }

  get busy(): boolean {
    return this.details?.busy ?? false;
  }

  change(serverPath: string): ShelvedChange | undefined {
    return this.details?.changes.find((c) => c.serverItem === serverPath);
  }

  isMine(s: Shelveset): boolean {
    return isMine(s, this.aliases());
  }

  state(): ShelvesetsState {
    const s = this.selected;
    const d = this.details;
    return {
      owner: this.owner,
      ...(this.ownerError !== undefined ? { ownerError: this.ownerError } : {}),
      listState: this.listState,
      ...(this.listError !== undefined ? { listError: this.listError } : {}),
      rows: this.list.map((x) => {
        const mine = this.isMine(x);
        return {
          key: keyOf(x),
          name: x.name,
          owner: x.ownerDisplay || x.owner,
          date: displayDate(x.date),
          comment: x.comment.split('\n')[0],
          mine,
          // The page shows this on hover, before the click, for a dimmed Delete.
          ...(mine ? {} : { deleteTitle: S.shelvesetDeleteNotYours(x.name) }),
        };
      }),
      ...(s && d
        ? {
            selected: d.key,
            details: {
              key: d.key,
              name: s.name,
              owner: s.ownerDisplay || s.owner,
              date: displayDate(s.date),
              comment: s.comment,
              mine: this.isMine(s),
              ...(this.isMine(s) ? {} : { deleteTitle: S.shelvesetDeleteNotYours(s.name) }),
              state: d.state,
              ...(d.error !== undefined ? { error: d.error } : {}),
              changes: d.changes.map((c) => changeRow(c, d.ticked.has(c.serverItem))),
              preserve: d.preserve,
              busy: d.busy,
            },
          }
        : {}),
      labels: S.shelvesetsLabels,
    };
  }
}

/** The file name a change row shows: a rename reads `old → new`, like Visual Studio's. */
export function changeName(c: Pick<ShelvedChange, 'serverItem' | 'sourceItem'>): string {
  const renamed = c.sourceItem !== undefined && nameOf(c.sourceItem) !== nameOf(c.serverItem);
  return renamed ? `${nameOf(c.sourceItem as string)} → ${nameOf(c.serverItem)}` : nameOf(c.serverItem);
}

function changeRow(c: ShelvedChange, ticked: boolean): ChangeRow {
  return {
    serverPath: c.serverItem,
    name: changeName(c),
    folder: parentPath(c.serverItem),
    change: changeLabel(c.changes),
    ticked,
  };
}
