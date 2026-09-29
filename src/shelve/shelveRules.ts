import type { Shelveset, ShelvedChange } from '../tf/parseShelvesets.js';
import { ENC_BINARY } from '../tf/types.js';
import { S } from '../tf/strings.js';
import { nameOf } from '../explorer/explorerModel.js';

/** tf's own limit on a shelveset name; its refusal stays the backstop for anything these rules miss. */
export const MAX_SHELVESET_NAME = 64;

/**
 * What a shelveset name may not hold: tf's forbidden characters,
 * `;` (it would split a `name;owner` itemspec) and `% ^ !`, which the tfp
 * wrapper's cmd.exe expands or strips -- TfClient refuses those on Windows
 * anyway, but only after the user has typed a name and picked a mode.
 */
const NAME_FORBIDDEN = /["/:<>\\|*?;%^!\x00-\x1f\x7f]/;

/** What an owner, or a LISTED shelveset's name, must not carry into a tf argument. */
const ARG_FORBIDDEN = /[";%^!\x00-\x1f\x7f]/;

export function nameProblem(raw: string): string | undefined {
  const name = raw.trim();
  if (name === '') return S.shelveBadNameEmpty;
  if (NAME_FORBIDDEN.test(name)) return S.shelveBadNameChars;
  // tf reads an argument that starts with `-` as an option, like one starting with `/`.
  if (name.startsWith('-')) return S.shelveBadNameDash;
  if (name.length > MAX_SHELVESET_NAME) return S.shelveBadNameLong;
  return undefined;
}

export function ownerProblem(raw: string): string | undefined {
  return ARG_FORBIDDEN.test(raw.trim()) ? S.shelvesetsBadOwner : undefined;
}

/**
 * Whether a shelveset from the LIST can be named to tf at all. A
 * colleague may have made a name that our own Shelve would refuse.
 */
export function passable(s: Pick<Shelveset, 'name' | 'ownerUnique'>): boolean {
  if (s.name === '' || s.ownerUnique === '') return false;
  if (s.name.startsWith('-') || s.name.startsWith('/')) return false;
  return !ARG_FORBIDDEN.test(s.name) && !ARG_FORBIDDEN.test(s.ownerUnique);
}

/** The user's own shelveset: its owner is one of the workspace owner's aliases. */
export function isMine(s: Pick<Shelveset, 'owner' | 'ownerUnique'>, aliases: readonly string[]): boolean {
  const known = new Set(aliases.map((a) => a.toLowerCase()).filter((a) => a !== ''));
  return known.has(s.owner.toLowerCase()) || known.has(s.ownerUnique.toLowerCase());
}

/**
 * The `/owner:` value for the Owner box's text: '' -- no `/owner`, which
 * lists the caller's own (S2) -- for an empty box or one of the user's own names.
 */
export function ownerQuery(text: string, aliases: readonly string[]): string {
  const t = text.trim();
  if (t === '' || aliases.some((a) => a.toLowerCase() === t.toLowerCase())) return '';
  return t;
}

/** Newest first. tf's dates are ISO with an offset; one that does not parse sorts last. */
export function newestFirst(list: readonly Shelveset[]): Shelveset[] {
  const at = (s: Shelveset) => {
    const t = Date.parse(s.date);
    return Number.isNaN(t) ? -Infinity : t;
  };
  return [...list].sort((a, b) => at(b) - at(a));
}

/** One side of a compare, before it becomes a URI (ShelvesetsView does that). */
export type Side =
  | { kind: 'version'; serverPath: string; changeset: number }
  | { kind: 'shelved'; serverPath: string }
  | { kind: 'empty'; serverPath: string }
  | { kind: 'local'; localPath: string };

export type Opened = { ok: true; left: Side; right: Side; title: string } | { ok: false; message: string };
export type Viewed = { ok: true; side: Side } | { ok: false; message: string };

const isBinary = (c: ShelvedChange) => c.encoding === ENC_BINARY;
const isFolder = (c: ShelvedChange) => c.itemType === 'Folder';

/** Compare with Unmodified: the version it was shelved from against what was shelved. */
export function compareUnmodified(c: ShelvedChange, shelveset: string): Opened {
  const name = nameOf(c.serverItem);
  // Visual Studio disables Compare on a folder; `vc view` on one would fail anyway.
  if (isFolder(c)) return { ok: false, message: S.shelvedIsFolder(name) };
  if (isBinary(c)) return { ok: false, message: S.compareBinary(name) };
  const shelved: Side = { kind: 'shelved', serverPath: c.serverItem };
  if (c.changes.has('Add')) {
    return { ok: true, left: { kind: 'empty', serverPath: c.serverItem }, right: shelved, title: S.shelvedCompareTitle(name, S.shelvedLeftNone, S.shelvedRight(shelveset)) };
  }
  if (c.version === undefined) return { ok: false, message: S.shelvedNoBase(name) };
  // A rename's base lives under its OLD path at that version.
  const base: Side = { kind: 'version', serverPath: c.sourceItem ?? c.serverItem, changeset: c.version };
  if (c.changes.has('Delete')) {
    return { ok: true, left: base, right: { kind: 'empty', serverPath: c.serverItem }, title: S.shelvedCompareTitle(name, S.shelvedLeftVersion(c.version), S.shelvedRightDeleted(shelveset)) };
  }
  return { ok: true, left: base, right: shelved, title: S.shelvedCompareTitle(name, S.shelvedLeftVersion(c.version), S.shelvedRight(shelveset)) };
}

/** Compare with Workspace Version: the local file against what was shelved. */
export function compareWorkspace(
  c: ShelvedChange,
  shelveset: string,
  localOf: (serverPath: string) => string | undefined,
  onDisk: (localPath: string) => boolean,
): Opened {
  const name = nameOf(c.serverItem);
  if (isFolder(c)) return { ok: false, message: S.shelvedIsFolder(name) };
  if (isBinary(c)) return { ok: false, message: S.compareBinary(name) };
  if (c.changes.has('Delete')) return { ok: false, message: S.shelvedIsDelete(name) };
  // Here the file is still under its OLD name, unless it was renamed here too.
  const local = localOf(c.sourceItem ?? c.serverItem);
  if (local === undefined) return { ok: false, message: S.shelvedNotMapped(name) };
  if (!onDisk(local)) return { ok: false, message: S.shelvedNotOnDisk(name) };
  return { ok: true, left: { kind: 'local', localPath: local }, right: { kind: 'shelved', serverPath: c.serverItem }, title: S.shelvedCompareTitle(name, S.shelvedLeftWorkspace, S.shelvedRight(shelveset)) };
}

export function viewShelved(c: ShelvedChange): Viewed {
  const name = nameOf(c.serverItem);
  if (isFolder(c)) return { ok: false, message: S.shelvedIsFolder(name) };
  if (c.changes.has('Delete')) return { ok: false, message: S.shelvedIsDelete(name) };
  if (isBinary(c)) return { ok: false, message: S.compareBinary(name) };
  return { ok: true, side: { kind: 'shelved', serverPath: c.serverItem } };
}

export type UnshelvePlan =
  | {
      ok: true;
      chosen: ShelvedChange[];
      /** The server paths to name to tf; undefined when every change is ticked, so tf takes the whole shelveset. */
      items: string[] | undefined;
      /** What phase 5 is asked about afterwards: both ends of a rename. */
      scope: string[];
    }
  | { ok: false; message: string };

/**
 * What Unshelve will run. Refuses an item not mapped in this
 * workspace, by name, so the user can untick it; never refuses an item with
 * its own pending change or a writable copy -- tf makes a conflict of that,
 * and phase 5 resolves it (U4).
 */
export function planUnshelve(
  all: readonly ShelvedChange[],
  ticked: ReadonlySet<string>,
  isMapped: (serverPath: string) => boolean,
): UnshelvePlan {
  const chosen = all.filter((c) => ticked.has(c.serverItem));
  if (chosen.length === 0) return { ok: false, message: S.unshelveNothingTicked };
  const unmapped = chosen.filter((c) => !isMapped(c.serverItem) || (c.sourceItem !== undefined && !isMapped(c.sourceItem)));
  if (unmapped.length > 0) return { ok: false, message: S.unshelveUnmapped(unmapped.map((c) => nameOf(c.serverItem))) };
  const items = chosen.length === all.length ? undefined : chosen.map((c) => c.serverItem);
  const scope = [...new Set(chosen.flatMap((c) => (c.sourceItem !== undefined ? [c.serverItem, c.sourceItem] : [c.serverItem])))];
  return { ok: true, chosen, items, scope };
}

export type Keep = { keep: true; why?: string } | { keep: false };

/**
 * Whether the shelveset must stay after an unshelve, before the
 * last check. tf's own `unshelve /move` deletes it even when a conflict still
 * refers to it (S9), so the extension deletes it itself, and only when nothing
 * at all is in doubt. `why` is absent when the user simply asked to keep it.
 */
export function keepBeforeReadBack(a: { preserve: boolean; mine: boolean; exitCode: number; conflicts: number | 'unknown' }): Keep {
  if (a.preserve) return { keep: true };
  if (!a.mine) return { keep: true, why: S.unshelveKeptNotYours };
  if (a.exitCode !== 0) return { keep: true, why: S.unshelveKeptExit };
  if (a.conflicts === 'unknown') return { keep: true, why: S.unshelveKeptUnknown };
  if (a.conflicts !== 0) return { keep: true, why: S.unshelveKeptConflicts };
  return { keep: false };
}

/** The last check: every unshelved item is now pending here. `pendingNow` undefined means the read failed. */
export function keepAfterReadBack(expected: readonly string[], pendingNow: readonly string[] | undefined): Keep {
  // Nothing was named, so a "still pending" read-back can never confirm anything -- treat it like a failed lookup.
  if (expected.length === 0) return { keep: true, why: S.unshelveKeptLookup };
  if (pendingNow === undefined) return { keep: true, why: S.unshelveKeptLookup };
  const now = new Set(pendingNow.map((p) => p.toLowerCase()));
  const missing = expected.filter((p) => !now.has(p.toLowerCase()));
  if (missing.length > 0) return { keep: true, why: S.unshelveKeptMissing(missing.map(nameOf)) };
  return { keep: false };
}

/** Server paths (item specs) compared as sets, case-insensitively -- TFVC's own rule for item names. */
export const sameItemSet = (a: readonly string[], b: readonly string[]): boolean => {
  const as = new Set(a.map((p) => p.toLowerCase()));
  const bs = new Set(b.map((p) => p.toLowerCase()));
  return as.size === bs.size && [...as].every((p) => bs.has(p));
};

/**
 * The very last check, after `keepAfterReadBack` says the read-back is
 * clean: whether the WHOLE shelveset -- not a partial unshelve, and not one
 * `/replace`d from elsewhere since the tab loaded it -- is what is about to
 * be deleted (coordinator review I1). tf's own `unshelve /move` deletes the
 * shelveset even for a partial unshelve, which is why the view never uses it
 * and confirms the shape itself instead.
 *
 * `loaded`, `chosen` and `onServerNow` are server paths (item specs), compared
 * case-insensitively -- TFVC's own rule for item names. `loaded` empty means
 * there was nothing captured to compare against (should not happen once a
 * shelveset has been opened, but is treated as "cannot confirm" rather than
 * "nothing to lose") -- checked first, so it wins over a merely-undefined
 * `onServerNow` too. Otherwise `onServerNow` undefined means the re-read of
 * the shelveset itself, right before the delete, failed.
 *
 * `partialConsented` is true once the view has warned that the unticked
 * changes exist only in this shelveset and the user chose to delete it
 * anyway (WANTED, 2026-09-23): it skips only the partial check below. The
 * re-read must still come back as the untouched, fully-loaded shelveset --
 * one changed on the server since it was opened is still kept, consent or
 * not.
 */
export function keepWhole(loaded: readonly string[], chosen: readonly string[], onServerNow: readonly string[] | undefined, partialConsented: boolean): Keep {
  if (!partialConsented && !sameItemSet(chosen, loaded)) return { keep: true, why: S.unshelveKeptPartial };
  if (loaded.length === 0) return { keep: true, why: S.unshelveKeptLookup };
  if (onServerNow === undefined) return { keep: true, why: S.unshelveKeptReread };
  if (!sameItemSet(onServerNow, loaded)) return { keep: true, why: S.unshelveKeptChanged };
  return { keep: false };
}
