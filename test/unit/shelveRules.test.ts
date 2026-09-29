import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseShelvedChanges, parseShelvesets, type Shelveset, type ShelvedChange } from '../../src/tf/parseShelvesets.js';
import {
  MAX_SHELVESET_NAME,
  compareUnmodified,
  compareWorkspace,
  isMine,
  keepAfterReadBack,
  keepBeforeReadBack,
  keepWhole,
  nameProblem,
  newestFirst,
  ownerProblem,
  ownerQuery,
  passable,
  planUnshelve,
  viewShelved,
} from '../../src/shelve/shelveRules.js';
import { S } from '../../src/tf/strings.js';

const fixture = (name: string) => readFileSync(join(__dirname, '../fixtures/windows', name));
const LIST = parseShelvesets(fixture('shelvesets-list.xml'));
const [STARTUP, HELLO, ADDED] = parseShelvedChanges(fixture('status-shelveset.xml'));
const MOVED = parseShelvedChanges(fixture('status-shelveset-rename-delete.xml'));
const EDIT2 = MOVED.find((c) => c.changes.has('Edit') && !c.changes.has('Add'))!;
const RENAME = MOVED.find((c) => c.changes.has('Rename'))!;
const BINARY_DELETE = MOVED.find((c) => c.changes.has('Delete'))!;
const ALIASES = ['user@example.com', 'Filip'];
const shelveset = (name: string) => LIST.find((s) => s.name === name)!;

describe('nameProblem', () => {
  it('accepts ordinary names, Croatian letters and exactly 64 characters', () => {
    for (const ok of ['fiskal-datum', 'Assignments 2', 'EF6 Migration 9', 'x'.repeat(MAX_SHELVESET_NAME), '  trimmed  ']) {
      expect(nameProblem(ok), ok).toBeUndefined();
    }
  });

  it('refuses every character tf, the itemspec or cmd.exe cannot take', () => {
    for (const c of ['"', '/', ':', '<', '>', '\\', '|', '*', '?', ';', '%', '^', '!', '\t', '\n']) {
      expect(nameProblem(`a${c}b`), JSON.stringify(c)).toBe(S.shelveBadNameChars);
    }
  });

  it('refuses an empty name, a leading dash and 65 characters', () => {
    expect(nameProblem('   ')).toBe(S.shelveBadNameEmpty);
    expect(nameProblem('-x')).toBe(S.shelveBadNameDash);
    expect(nameProblem('x'.repeat(MAX_SHELVESET_NAME + 1))).toBe(S.shelveBadNameLong);
  });
});

describe('owners', () => {
  it('accepts a display name, an email and *, and refuses what cannot cross cmd.exe', () => {
    for (const ok of ['Nika Blaškova', 'colleague@example.com', '*', '']) expect(ownerProblem(ok), ok).toBeUndefined();
    for (const bad of ['a"b', 'a;b', '100%', 'a^b', 'hey!', 'a\nb']) expect(ownerProblem(bad), bad).toBe(S.shelvesetsBadOwner);
  });

  it("sends no /owner for an empty box or one of the user's own names", () => {
    expect(ownerQuery('', ALIASES)).toBe('');
    expect(ownerQuery('  filip ', ALIASES)).toBe('');
    expect(ownerQuery('USER@example.com', ALIASES)).toBe('');
    expect(ownerQuery(' Nika Blaškova ', ALIASES)).toBe('Nika Blaškova');
    expect(ownerQuery('*', ALIASES)).toBe('*');
  });

  it("knows the user's own shelvesets by any alias, ignoring case, and nothing without aliases", () => {
    expect(isMine(shelveset('EF6 Migration 9'), ALIASES)).toBe(true);
    expect(isMine(shelveset('EF6 Migration 9'), ['USER@EXAMPLE.COM'])).toBe(true);
    expect(isMine(shelveset('Popravak web servisa'), ALIASES)).toBe(false);
    expect(isMine(shelveset('EF6 Migration 9'), [])).toBe(false);
    // The empty-alias filter itself, not the shelveset's non-empty owner, must be what makes this false.
    expect(isMine({ owner: '', ownerUnique: '' }, [''])).toBe(false);
  });

  it('is not fooled by a colleague who shares the display name "Filip" (display names are not unique)', () => {
    expect(
      isMine({ owner: 'filip.horvat@example.com', ownerUnique: 'filip.horvat@example.com', ownerDisplay: 'Filip' } as Shelveset, ALIASES),
    ).toBe(false);
  });

  it('lets through every real name, and refuses one that cannot be named to tf', () => {
    for (const s of LIST) expect(passable(s), s.name).toBe(true);
    expect(passable({ name: '100% done', ownerUnique: 'a' })).toBe(false);
    expect(passable({ name: 'a;b', ownerUnique: 'a' })).toBe(false);
    expect(passable({ name: '-x', ownerUnique: 'a' })).toBe(false);
    expect(passable({ name: 'x', ownerUnique: '' })).toBe(false);
  });

  it('sorts newest first, and a date that does not parse last', () => {
    const odd = { ...LIST[0], name: 'odd', date: 'not a date' };
    expect(newestFirst([...LIST, odd]).map((s) => s.name)).toEqual([
      'TFVC-PROBE-P4-1', 'EF6 Migration 9', 'Popravak web servisa', 'Assignments uređivanje zaglavlja',
      'CodeReview_2023-12-21_03.15.49.7918', '__tf_clean_wksp_metadata', 'odd',
    ]);
  });
});

describe('Compare with Unmodified', () => {
  it('an edit: its base version against the shelved content', () => {
    const r = compareUnmodified(STARTUP, 'P');
    expect(r).toEqual({
      ok: true,
      left: { kind: 'version', serverPath: STARTUP.serverItem, changeset: 18319 },
      right: { kind: 'shelved', serverPath: STARTUP.serverItem },
      title: S.shelvedCompareTitle('Startup.cs', 'C18319', 'shelveset "P"'),
    });
  });

  it('an add: empty against the shelved content', () => {
    const r = compareUnmodified(ADDED, 'P');
    expect(r.ok && r.left).toEqual({ kind: 'empty', serverPath: ADDED.serverItem });
    expect(r.ok && r.right).toEqual({ kind: 'shelved', serverPath: ADDED.serverItem });
  });

  it('a rename: the OLD path at its version against the shelved content under the new name', () => {
    const r = compareUnmodified(RENAME, 'P');
    expect(r.ok && r.left).toEqual({ kind: 'version', serverPath: RENAME.sourceItem, changeset: 18312 });
    expect(r.ok && r.right).toEqual({ kind: 'shelved', serverPath: RENAME.serverItem });
  });

  it('a text delete: the base against empty', () => {
    const del: ShelvedChange = { ...BINARY_DELETE, encoding: 1250 };
    const r = compareUnmodified(del, 'P');
    expect(r.ok && r.left).toEqual({ kind: 'version', serverPath: del.serverItem, changeset: 18312 });
    expect(r.ok && r.right).toEqual({ kind: 'empty', serverPath: del.serverItem });
    expect(r.ok && r.title).toBe(S.shelvedCompareTitle('smiley.jpg', 'C18312', 'deleted in "P"'));
  });

  it('refuses a binary item, and an edit with no base', () => {
    expect(compareUnmodified(BINARY_DELETE, 'P')).toEqual({ ok: false, message: S.compareBinary('smiley.jpg') });
    const noBase: ShelvedChange = { ...HELLO, version: undefined };
    expect(compareUnmodified(noBase, 'P')).toEqual({ ok: false, message: S.shelvedNoBase('hello.html') });
  });

  it('refuses a folder, whether it was added or merely edited -- Visual Studio disables Compare on folders too', () => {
    const folderAdd: ShelvedChange = { ...ADDED, itemType: 'Folder', serverItem: '$/Shop/Shop2023/Enterprise.Till.Server/Web/NewFolder' };
    const folderEdit: ShelvedChange = { ...STARTUP, itemType: 'Folder', serverItem: '$/Shop/Shop2023/Enterprise.Till.Server/SomeFolder' };
    expect(compareUnmodified(folderAdd, 'P')).toEqual({ ok: false, message: S.shelvedIsFolder('NewFolder') });
    expect(compareUnmodified(folderEdit, 'P')).toEqual({ ok: false, message: S.shelvedIsFolder('SomeFolder') });
  });
});

describe('Compare with Workspace Version and View Shelved Version', () => {
  const localOf = (p: string) => (p.startsWith('$/Shop/') ? 'C:\\work\\' + p.slice(2).split('/').join('\\') : undefined);
  const onDisk = (l: string) => !l.endsWith('Startup.cs');

  it('the local file against the shelved content; a rename uses the OLD local path', () => {
    const r = compareWorkspace(HELLO, 'P', localOf, onDisk);
    expect(r.ok && r.left).toEqual({ kind: 'local', localPath: 'C:\\work\\Shop\\Shop2023\\Enterprise.Till.Server\\Web\\hello.html' });
    expect(r.ok && r.right).toEqual({ kind: 'shelved', serverPath: HELLO.serverItem });
    const moved = compareWorkspace(RENAME, 'P', localOf, onDisk);
    expect(moved.ok && moved.left).toEqual({ kind: 'local', localPath: 'C:\\work\\Shop\\Shop2023\\Enterprise.Till.Server\\Web\\assets\\date.js' });
  });

  it('refuses unmapped, missing, deleted and binary items', () => {
    expect(compareWorkspace({ ...HELLO, serverItem: '$/Other/x.txt' }, 'P', localOf, onDisk)).toEqual({ ok: false, message: S.shelvedNotMapped('x.txt') });
    expect(compareWorkspace(STARTUP, 'P', localOf, onDisk)).toEqual({ ok: false, message: S.shelvedNotOnDisk('Startup.cs') });
    expect(compareWorkspace({ ...BINARY_DELETE, encoding: 1250 }, 'P', localOf, onDisk)).toEqual({ ok: false, message: S.shelvedIsDelete('smiley.jpg') });
    expect(compareWorkspace({ ...EDIT2, encoding: -1 }, 'P', localOf, onDisk)).toEqual({ ok: false, message: S.compareBinary('hello.html') });
  });

  it('views the shelved content, never of a delete or a binary', () => {
    expect(viewShelved(ADDED)).toEqual({ ok: true, side: { kind: 'shelved', serverPath: ADDED.serverItem } });
    expect(viewShelved({ ...BINARY_DELETE, encoding: 1250 })).toEqual({ ok: false, message: S.shelvedIsDelete('smiley.jpg') });
    expect(viewShelved({ ...HELLO, encoding: -1 })).toEqual({ ok: false, message: S.compareBinary('hello.html') });
  });

  it('refuses a folder for both Compare with Workspace and View Shelved -- before the mapped/on-disk checks', () => {
    const folderAdd: ShelvedChange = { ...ADDED, itemType: 'Folder', serverItem: '$/Shop/Shop2023/Enterprise.Till.Server/Web/NewFolder' };
    const folderEdit: ShelvedChange = { ...HELLO, itemType: 'Folder', serverItem: '$/Shop/Shop2023/Enterprise.Till.Server/SomeFolder' };
    expect(compareWorkspace(folderAdd, 'P', localOf, onDisk)).toEqual({ ok: false, message: S.shelvedIsFolder('NewFolder') });
    expect(compareWorkspace(folderEdit, 'P', localOf, onDisk)).toEqual({ ok: false, message: S.shelvedIsFolder('SomeFolder') });
    expect(viewShelved(folderAdd)).toEqual({ ok: false, message: S.shelvedIsFolder('NewFolder') });
    expect(viewShelved(folderEdit)).toEqual({ ok: false, message: S.shelvedIsFolder('SomeFolder') });
  });
});

describe('planUnshelve', () => {
  const all = [EDIT2, RENAME, BINARY_DELETE];
  const mapped = (p: string) => p.startsWith('$/Shop/');

  it('refuses when nothing is ticked', () => {
    expect(planUnshelve(all, new Set(), mapped)).toEqual({ ok: false, message: S.unshelveNothingTicked });
  });

  it('names no items when every change is ticked, so tf takes the whole shelveset', () => {
    const r = planUnshelve(all, new Set(all.map((c) => c.serverItem)), mapped);
    expect(r.ok && r.items).toBeUndefined();
    expect(r.ok && r.chosen).toHaveLength(3);
  });

  it('names exactly the ticked items otherwise, and asks about both ends of a rename', () => {
    const r = planUnshelve(all, new Set([RENAME.serverItem]), mapped);
    expect(r.ok && r.items).toEqual([RENAME.serverItem]);
    expect(r.ok && r.scope).toEqual([RENAME.serverItem, RENAME.sourceItem]);
  });

  it('refuses, by name, a ticked item not mapped here -- including a rename whose source is not', () => {
    const outside: ShelvedChange = { ...EDIT2, serverItem: '$/Other/a.txt' };
    const fromOutside: ShelvedChange = { ...RENAME, sourceItem: '$/Other/old.js' };
    expect(planUnshelve([outside, EDIT2], new Set([outside.serverItem, EDIT2.serverItem]), mapped)).toEqual({ ok: false, message: S.unshelveUnmapped(['a.txt']) });
    expect(planUnshelve([fromOutside], new Set([fromOutside.serverItem]), mapped)).toEqual({ ok: false, message: S.unshelveUnmapped(['date2.js']) });
  });
});

describe('keep or delete after an unshelve', () => {
  const clean = { preserve: false, mine: true, exitCode: 0, conflicts: 0 as number | 'unknown' };

  it('keeps it, silently, when the user asked to preserve it', () => {
    expect(keepBeforeReadBack({ ...clean, preserve: true })).toEqual({ keep: true });
  });

  it('keeps it, saying why, for each reason alone', () => {
    expect(keepBeforeReadBack({ ...clean, mine: false })).toEqual({ keep: true, why: S.unshelveKeptNotYours });
    expect(keepBeforeReadBack({ ...clean, exitCode: 1 })).toEqual({ keep: true, why: S.unshelveKeptExit });
    expect(keepBeforeReadBack({ ...clean, conflicts: 'unknown' })).toEqual({ keep: true, why: S.unshelveKeptUnknown });
    expect(keepBeforeReadBack({ ...clean, conflicts: 2 })).toEqual({ keep: true, why: S.unshelveKeptConflicts });
  });

  it('keeps it on any non-zero conflict count, not just a positive one -- the contract is exactly zero', () => {
    expect(keepBeforeReadBack({ ...clean, conflicts: 1 })).toEqual({ keep: true, why: S.unshelveKeptConflicts });
    expect(keepBeforeReadBack({ ...clean, conflicts: -1 })).toEqual({ keep: true, why: S.unshelveKeptConflicts });
    expect(keepBeforeReadBack({ ...clean, conflicts: NaN })).toEqual({ keep: true, why: S.unshelveKeptConflicts });
  });

  it('lets the read-back decide only when everything else allows the delete', () => {
    expect(keepBeforeReadBack(clean)).toEqual({ keep: false });
    expect(keepAfterReadBack(['$/K/a.cs'], undefined)).toEqual({ keep: true, why: S.unshelveKeptLookup });
    expect(keepAfterReadBack(['$/K/a.cs', '$/K/b.cs'], ['$/K/A.cs'])).toEqual({ keep: true, why: S.unshelveKeptMissing(['b.cs']) });
    expect(keepAfterReadBack(['$/K/a.cs'], ['$/k/a.cs', '$/K/other.cs'])).toEqual({ keep: false });
  });

  it('keeps it when nothing was named, rather than reading an empty read-back as "all present"', () => {
    expect(keepAfterReadBack([], ['$/K/a.cs'])).toEqual({ keep: true, why: S.unshelveKeptLookup });
    expect(keepAfterReadBack([], [])).toEqual({ keep: true, why: S.unshelveKeptLookup });
  });
});

describe('keepWhole: the last check before a delete', () => {
  const loaded = ['$/K/a.cs', '$/K/b.cs'];

  it('keeps it when the unshelve itself was partial -- fewer items chosen than were loaded', () => {
    expect(keepWhole(loaded, ['$/K/a.cs'], loaded, false)).toEqual({ keep: true, why: S.unshelveKeptPartial });
  });

  it('a partial unshelve is caught even when the re-read has not happened yet (undefined)', () => {
    // Partial-ness is checked first: a bad re-read must not mask it behind "could not be checked".
    expect(keepWhole(loaded, ['$/K/a.cs'], undefined, false)).toEqual({ keep: true, why: S.unshelveKeptPartial });
  });

  it('keeps it, as unshelveKeptReread, when the re-read of the shelveset itself failed', () => {
    expect(keepWhole(loaded, loaded, undefined, false)).toEqual({ keep: true, why: S.unshelveKeptReread });
  });

  it('keeps it, as unshelveKeptLookup, when nothing was loaded to compare against -- even if the re-read succeeded or also failed', () => {
    expect(keepWhole([], [], ['$/K/a.cs'], false)).toEqual({ keep: true, why: S.unshelveKeptLookup });
    expect(keepWhole([], [], undefined, false)).toEqual({ keep: true, why: S.unshelveKeptLookup });
  });

  it('keeps it when the shelveset on the server now differs from what was loaded', () => {
    expect(keepWhole(loaded, loaded, ['$/K/a.cs', '$/K/c.cs'], false)).toEqual({ keep: true, why: S.unshelveKeptChanged });
    expect(keepWhole(loaded, loaded, ['$/K/a.cs'], false)).toEqual({ keep: true, why: S.unshelveKeptChanged });
  });

  it('allows the delete only when the whole, unchanged shelveset came back, case-insensitively', () => {
    expect(keepWhole(loaded, loaded, ['$/k/A.cs', '$/K/B.cs'], false)).toEqual({ keep: false });
  });
});

describe('keepWhole with partialConsented (WANTED, 2026-09-23): the view has already warned and the user chose to delete anyway', () => {
  const loaded = ['$/K/a.cs', '$/K/b.cs'];

  it('deletes a partial unshelve once consented, as long as the re-read is still the whole, unchanged set', () => {
    expect(keepWhole(loaded, ['$/K/a.cs'], loaded, true)).toEqual({ keep: false });
  });

  it('still keeps it when the shelveset changed on the server, consented or not', () => {
    expect(keepWhole(loaded, ['$/K/a.cs'], ['$/K/a.cs', '$/K/c.cs'], true)).toEqual({ keep: true, why: S.unshelveKeptChanged });
  });

  it('still keeps it when the re-read before the delete failed, consented or not', () => {
    expect(keepWhole(loaded, ['$/K/a.cs'], undefined, true)).toEqual({ keep: true, why: S.unshelveKeptReread });
  });

  it('without consent, a partial unshelve is still kept as unshelveKeptPartial -- e.g. if the view is ever called without asking', () => {
    expect(keepWhole(loaded, ['$/K/a.cs'], loaded, false)).toEqual({ keep: true, why: S.unshelveKeptPartial });
  });
});
