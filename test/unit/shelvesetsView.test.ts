import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recorder, createdPanels, executed, workspace, window as mockWindow, Uri } from '../vscode-mock.js';
import { ShelvesetsView, SHELVESETS_VIEW_TYPE, type ShelvesetsDeps } from '../../src/ui/ShelvesetsView.js';
import { ServerContentProvider } from '../../src/ui/ServerContentProvider.js';
import { parseShelvedChanges, parseShelvesets } from '../../src/tf/parseShelvesets.js';
import { keyOf, type ShelvesetsState } from '../../src/shelve/shelvesetsModel.js';
import { S } from '../../src/tf/strings.js';

const fixture = (name: string) => readFileSync(join(__dirname, '../fixtures/windows', name));
const LIST = parseShelvesets(fixture('shelvesets-list.xml'));
const MOVED = parseShelvedChanges(fixture('status-shelveset-rename-delete.xml'));
const EF6 = LIST.find((s) => s.name === 'EF6 Migration 9')!;
const COLLEAGUE = LIST.find((s) => s.name === 'Popravak web servisa')!;
const [HELLO, ADDED, RENAME, SMILEY] = MOVED;
const PREFIX = '$/Shop/Shop2023/Enterprise.Till.Server/';
let ROOT = '';

beforeAll(() => {
  // A real folder, so Compare with Workspace Version finds a real file.
  ROOT = mkdtempSync(join(tmpdir(), 'shelvesets-view-'));
  mkdirSync(join(ROOT, 'Web'), { recursive: true });
  writeFileSync(join(ROOT, 'Web', 'hello.html'), '<html></html>');
});
beforeEach(() => recorder.reset());

type Ran = { exitCode: number; message?: string };

function setup(over: Partial<ShelvesetsDeps> = {}) {
  const shelve = {
    list: vi.fn(async (_owner: string) => ({ ok: true as const, value: LIST })),
    contents: vi.fn(async (_name: string, _owner: string): Promise<{ ok: true; value: typeof MOVED } | { ok: false; message: string }> => ({ ok: true, value: MOVED })),
    unshelve: vi.fn(async (_r: unknown): Promise<Ran> => ({ exitCode: 0 })),
    deleteOwn: vi.fn(async (_name: string): Promise<Ran> => ({ exitCode: 0 })),
    pendingIn: vi.fn(async (paths: readonly string[]): Promise<{ ok: true; value: string[] } | { ok: false; message: string }> => ({ ok: true, value: [...paths] })),
  };
  const deps = {
    shelve,
    workspaces: vi.fn(async () => ({
      ok: true as const,
      value: [{ name: 'DEVPC', computer: 'DEVPC', owner: 'Filip', ownerAliases: ['user@example.com', 'Filip'], folders: [] }],
    })),
    mapper: () => ({ toLocalPath: (p: string) => (p.startsWith(PREFIX) ? join(ROOT, ...p.slice(PREFIX.length).split('/')) : undefined) }),
    afterUnshelve: vi.fn(),
    resolveConflicts: vi.fn(async (_paths: string[]) => 0),
    log: vi.fn(),
    ...over,
  };
  return { deps, shelve, view: new ShelvesetsView(() => Uri.file('/ext') as never, deps as unknown as ShelvesetsDeps) };
}

async function open(over: Partial<ShelvesetsDeps> = {}) {
  const s = setup(over);
  await s.view.show();
  const panel = createdPanels[createdPanels.length - 1];
  const state = () => panel.webview.posted[panel.webview.posted.length - 1] as ShelvesetsState;
  return { ...s, panel, state };
}

async function openWithDetails(over: Partial<ShelvesetsDeps> = {}, which = EF6) {
  const o = await open(over);
  await o.panel.receive({ type: 'select', key: keyOf(which) });
  return o;
}

describe('the Shelvesets tab', () => {
  it("opens one tab listing the user's own under their display name, and reveals it when asked again", async () => {
    const { view, panel, shelve, state } = await open();
    expect(panel.viewType).toBe(SHELVESETS_VIEW_TYPE);
    expect(panel.webview.html).toContain('shelvesets.js');
    expect(shelve.list).toHaveBeenCalledWith('');
    expect(state().owner).toBe('Filip');
    expect(state().rows).toHaveLength(LIST.length);
    const panels = createdPanels.length;
    await view.show();
    expect(createdPanels.length).toBe(panels);
    expect(panel.revealed).toBe(1);
  });

  it("finds another owner's shelvesets, and refuses an owner that cannot reach tf", async () => {
    const { panel, shelve, state } = await open();
    await panel.receive({ type: 'find', owner: ' Nika Blaškova ' });
    expect(shelve.list).toHaveBeenLastCalledWith('Nika Blaškova');
    shelve.list.mockClear();
    await panel.receive({ type: 'find', owner: '100%' });
    expect(shelve.list).not.toHaveBeenCalled();
    expect(state().ownerError).toBe(S.shelvesetsBadOwner);
    // The refused owner was never stored: a Refresh still lists the last good one.
    await panel.receive({ type: 'refresh' });
    expect(shelve.list).toHaveBeenLastCalledWith('Nika Blaškova');
  });

  it('loads a shelveset by name;owner, with every change ticked', async () => {
    const { shelve, state } = await openWithDetails();
    expect(shelve.contents).toHaveBeenCalledWith('EF6 Migration 9', 'user@example.com');
    expect(state().details!.changes.every((c) => c.ticked)).toBe(true);
  });

  it('says a shelveset whose name cannot reach tf cannot be opened, without running tf', async () => {
    const odd = { ...EF6, name: '100% done' };
    const { panel, shelve, state } = await open();
    shelve.list.mockResolvedValueOnce({ ok: true, value: [...LIST, odd] });
    await panel.receive({ type: 'refresh' });
    await panel.receive({ type: 'select', key: keyOf(odd) });
    expect(shelve.contents).not.toHaveBeenCalled();
    expect(state().details).toMatchObject({ state: 'failed', error: S.shelvesetUnpassable('100% done') });
  });

  it('ignores, and logs, a malformed message', async () => {
    const { panel, deps } = await open();
    await panel.receive({ type: 'checkout', paths: ['$/K/a.cs'] });
    expect(deps.log).toHaveBeenCalledWith('shelvesets: ignored a malformed message from the page');
  });
});

describe('file actions', () => {
  const shelvedUri = (serverPath: string, codePage: number) =>
    String(ServerContentProvider.shelvedUri({ serverPath, shelveset: 'EF6 Migration 9', owner: 'user@example.com', date: EF6.date, codePage }));

  it('compares a rename with unmodified: the OLD path at its version against the shelved content', async () => {
    const { panel } = await openWithDetails();
    await panel.receive({ type: 'file', action: 'compareUnmodified', path: RENAME.serverItem });
    const diff = executed.find((e) => e.id === 'vscode.diff')!;
    expect(String(diff.args[0])).toBe(String(ServerContentProvider.versionUri(RENAME.sourceItem!, 18312)));
    expect(String(diff.args[1])).toBe(shelvedUri(RENAME.serverItem, 65001));
  });

  it('compares with the workspace version: the local file against the shelved content', async () => {
    const { panel } = await openWithDetails();
    await panel.receive({ type: 'file', action: 'compareWorkspace', path: HELLO.serverItem });
    const diff = executed.find((e) => e.id === 'vscode.diff')!;
    expect((diff.args[0] as Uri).fsPath).toBe(join(ROOT, 'Web', 'hello.html'));
    expect(String(diff.args[1])).toBe(shelvedUri(HELLO.serverItem, 1250));
  });

  it('views the shelved content, decoded with its own code page', async () => {
    const { panel } = await openWithDetails();
    await panel.receive({ type: 'file', action: 'viewShelved', path: HELLO.serverItem });
    expect(String(executed.find((e) => e.id === 'vscode.open')!.args[0])).toBe(shelvedUri(HELLO.serverItem, 1250));
  });

  it('says why instead of opening a binary, or a change it no longer lists', async () => {
    const { panel } = await openWithDetails();
    await panel.receive({ type: 'file', action: 'compareUnmodified', path: SMILEY.serverItem });
    await panel.receive({ type: 'file', action: 'viewShelved', path: '$/Not/listed.cs' });
    expect(executed.filter((e) => e.id === 'vscode.diff' || e.id === 'vscode.open')).toEqual([]);
    expect(recorder.shown).toEqual([S.compareBinary('smiley.jpg'), S.shelvesetsStale]);
  });
});

describe('Unshelve', () => {
  it('unshelves the whole shelveset, refreshes, asks phase 5 about both ends of a rename, and keeps the shelveset by default', async () => {
    const { panel, shelve, deps } = await openWithDetails();
    await panel.receive({ type: 'unshelve' });
    expect(shelve.unshelve).toHaveBeenCalledWith({ name: 'EF6 Migration 9', ownerUnique: 'user@example.com' });
    expect(deps.afterUnshelve).toHaveBeenCalled();
    expect(deps.resolveConflicts).toHaveBeenCalledWith(expect.arrayContaining([RENAME.serverItem, RENAME.sourceItem]));
    expect(shelve.deleteOwn).not.toHaveBeenCalled();
    expect(recorder.shown).toEqual([S.unshelveDone('EF6 Migration 9')]);
  });

  it('with Preserve unticked and nothing in doubt: reads the changes back, re-reads the shelveset itself, deletes it, re-lists', async () => {
    const { panel, shelve } = await openWithDetails();
    await panel.receive({ type: 'preserve', value: false });
    const listed = shelve.list.mock.calls.length;
    // The re-read before the delete (coordinator review I1) compares
    // case-insensitively: the same items, differently cased, must not read
    // as "changed on the server" and block the delete.
    shelve.contents.mockResolvedValueOnce({ ok: true, value: MOVED.map((c) => ({ ...c, serverItem: c.serverItem.toUpperCase() })) });
    await panel.receive({ type: 'unshelve' });
    expect(shelve.pendingIn).toHaveBeenCalledWith(MOVED.map((c) => c.serverItem));
    expect(shelve.contents).toHaveBeenCalledWith('EF6 Migration 9', 'user@example.com');
    expect(shelve.deleteOwn).toHaveBeenCalledWith('EF6 Migration 9');
    expect(recorder.shown).toEqual([S.unshelveDoneDeleted('EF6 Migration 9')]);
    expect(shelve.list.mock.calls.length).toBe(listed + 1);
  });

  it('keeps the shelveset when it changed on the server after the tab opened it, even though nothing else says to keep it (coordinator review I1)', async () => {
    const { panel, shelve } = await openWithDetails();
    await panel.receive({ type: 'preserve', value: false });
    // Everything is still ticked and the read-back is clean, but a fresh
    // item now exists in the shelveset that was never loaded here -- the
    // shelveset was `/replace`d from another machine while the tab was open.
    shelve.contents.mockResolvedValueOnce({ ok: true, value: [...MOVED, { ...HELLO, serverItem: `${PREFIX}Web/extra.cs` }] });
    await panel.receive({ type: 'unshelve' });
    expect(shelve.deleteOwn).not.toHaveBeenCalled();
    expect(recorder.shown).toContain(S.unshelveKept('EF6 Migration 9', S.unshelveKeptChanged));
  });

  it('a dismissed partial-unshelve warning stops everything: no save prompt even with a dirty ticked file, and clears `running` so a second Unshelve still runs', async () => {
    const { panel, shelve } = await openWithDetails();
    await panel.receive({ type: 'preserve', value: false });
    await panel.receive({ type: 'tick', paths: [SMILEY.serverItem], ticked: false });
    // HELLO stays ticked (only SMILEY was unticked), so if the flow reached
    // saveDirty this file's unsaved edit would trigger its own modal.
    const save = vi.fn(async () => true);
    workspace.textDocuments = [{ uri: Uri.file(join(ROOT, 'Web', 'hello.html')), isDirty: true, save } as never];
    recorder.answers.push(undefined);
    await panel.receive({ type: 'unshelve' });
    expect(recorder.messages).toEqual([
      {
        kind: 'warning',
        modal: true,
        message: `${S.unshelvePartialConfirm('EF6 Migration 9', 3, 4)}\n${S.unshelvePartialDetail(['smiley.jpg'])}`,
        items: [S.unshelvePartialKeep, S.unshelvePartialDelete],
      },
    ]);
    expect(save).not.toHaveBeenCalled();
    expect(shelve.unshelve).not.toHaveBeenCalled();
    expect(shelve.deleteOwn).not.toHaveBeenCalled();

    // A second Unshelve still runs at all -- proving `running` was cleared on
    // the dismissed path, exactly as it is on every other early return.
    recorder.answers.push(undefined);
    await panel.receive({ type: 'unshelve' });
    expect(recorder.messages).toHaveLength(2);
    expect(save).not.toHaveBeenCalled();
    expect(shelve.unshelve).not.toHaveBeenCalled();
  });

  it('says "That change" and "it" (not the plural) when exactly one change is unticked', async () => {
    const { panel } = await openWithDetails();
    await panel.receive({ type: 'preserve', value: false });
    await panel.receive({ type: 'tick', paths: [SMILEY.serverItem], ticked: false });
    recorder.answers.push(undefined);
    await panel.receive({ type: 'unshelve' });
    expect(recorder.messages[0].message).toContain(
      'Not ticked: smiley.jpg. That change exists only in this shelveset: deleting it loses it for good. Unshelve and Keep leaves the shelveset on the server.',
    );
  });

  it('says "These changes" and "them" when more than one change is unticked', async () => {
    const { panel } = await openWithDetails();
    await panel.receive({ type: 'preserve', value: false });
    await panel.receive({ type: 'tick', paths: [SMILEY.serverItem, ADDED.serverItem], ticked: false });
    recorder.answers.push(undefined);
    await panel.receive({ type: 'unshelve' });
    expect(recorder.messages[0].message).toContain(
      'These changes exist only in this shelveset: deleting it loses them for good.',
    );
  });

  it('names an unticked rename as "old → new", the same label the page\'s own rows use', async () => {
    const { panel } = await openWithDetails();
    await panel.receive({ type: 'preserve', value: false });
    await panel.receive({ type: 'tick', paths: [RENAME.serverItem], ticked: false });
    recorder.answers.push(undefined);
    await panel.receive({ type: 'unshelve' });
    expect(recorder.messages[0].message).toContain('Not ticked: date.js → date2.js.');
  });

  it('"Unshelve and Keep" runs the partial unshelve as if Preserve were ticked: no delete, no kept-warning', async () => {
    const { panel, shelve } = await openWithDetails();
    await panel.receive({ type: 'preserve', value: false });
    await panel.receive({ type: 'tick', paths: [SMILEY.serverItem], ticked: false });
    recorder.answers.push(S.unshelvePartialKeep);
    await panel.receive({ type: 'unshelve' });
    expect(shelve.unshelve).toHaveBeenCalledWith({
      name: 'EF6 Migration 9',
      ownerUnique: 'user@example.com',
      items: [HELLO.serverItem, ADDED.serverItem, RENAME.serverItem],
    });
    expect(shelve.deleteOwn).not.toHaveBeenCalled();
    // "as if Preserve were ticked": the normal done message, no "kept" warning.
    expect(recorder.shown).toContain(S.unshelveDone('EF6 Migration 9'));
    expect(recorder.shown.some((m) => m.includes('was kept on the server'))).toBe(false);
  });

  it('"Unshelve and Delete" runs the partial unshelve and deletes the shelveset when the read-back stays the whole, loaded set', async () => {
    const { panel, shelve } = await openWithDetails();
    await panel.receive({ type: 'preserve', value: false });
    await panel.receive({ type: 'tick', paths: [SMILEY.serverItem], ticked: false });
    recorder.answers.push(S.unshelvePartialDelete);
    await panel.receive({ type: 'unshelve' });
    expect(shelve.unshelve).toHaveBeenCalledWith({
      name: 'EF6 Migration 9',
      ownerUnique: 'user@example.com',
      items: [HELLO.serverItem, ADDED.serverItem, RENAME.serverItem],
    });
    // pendingIn checks the CHOSEN three arrived pending; it's the shelveset's
    // own re-read just below, via contents(), that must still match the whole
    // LOADED set (all four) before the delete goes ahead.
    expect(shelve.pendingIn).toHaveBeenCalledWith([HELLO.serverItem, ADDED.serverItem, RENAME.serverItem]);
    expect(shelve.contents).toHaveBeenLastCalledWith('EF6 Migration 9', 'user@example.com');
    expect(shelve.deleteOwn).toHaveBeenCalledTimes(1);
    expect(shelve.deleteOwn).toHaveBeenCalledWith('EF6 Migration 9');
    expect(recorder.shown).toContain(S.unshelveDoneDeleted('EF6 Migration 9'));
  });

  it('"Unshelve and Delete" still keeps the shelveset when it changed on the server before the delete', async () => {
    const { panel, shelve } = await openWithDetails();
    await panel.receive({ type: 'preserve', value: false });
    await panel.receive({ type: 'tick', paths: [SMILEY.serverItem], ticked: false });
    // The FIRST contents() call already happened for the initial select; this
    // is the re-read right before the delete, showing a shelveset replaced
    // from elsewhere while the tab had it open.
    shelve.contents.mockResolvedValueOnce({ ok: true, value: [...MOVED, { ...HELLO, serverItem: `${PREFIX}Web/extra.cs` }] });
    recorder.answers.push(S.unshelvePartialDelete);
    await panel.receive({ type: 'unshelve' });
    expect(shelve.deleteOwn).not.toHaveBeenCalled();
    expect(recorder.shown).toContain(S.unshelveKept('EF6 Migration 9', S.unshelveKeptChanged));
  });

  // Consenting to the partial check (partialConsented) must not short-circuit
  // any of the OTHER gates before a delete: tf's exit code, the conflict
  // count and the pending read-back still have to pass, same as an ordinary
  // whole-shelveset unshelve.
  it('"Unshelve and Delete" still keeps it when phase 5 found a conflict', async () => {
    const { panel, shelve } = await openWithDetails({ resolveConflicts: vi.fn(async () => 1) });
    await panel.receive({ type: 'preserve', value: false });
    await panel.receive({ type: 'tick', paths: [SMILEY.serverItem], ticked: false });
    recorder.answers.push(S.unshelvePartialDelete);
    await panel.receive({ type: 'unshelve' });
    expect(shelve.deleteOwn).not.toHaveBeenCalled();
    expect(recorder.shown).toContain(S.unshelveKept('EF6 Migration 9', S.unshelveKeptConflicts));
  });

  it('"Unshelve and Delete" still keeps it when the conflict check itself failed', async () => {
    const missing = vi.fn(async (): Promise<number> => {
      throw new Error("command 'teamExplorer.resolveConflicts' not found");
    });
    const { panel, shelve } = await openWithDetails({ resolveConflicts: missing });
    await panel.receive({ type: 'preserve', value: false });
    await panel.receive({ type: 'tick', paths: [SMILEY.serverItem], ticked: false });
    recorder.answers.push(S.unshelvePartialDelete);
    await panel.receive({ type: 'unshelve' });
    expect(shelve.deleteOwn).not.toHaveBeenCalled();
    expect(recorder.shown).toContain(S.unshelveKept('EF6 Migration 9', S.unshelveKeptUnknown));
  });

  it('"Unshelve and Delete" still keeps it when tf exits non-zero', async () => {
    const { panel, shelve } = await openWithDetails();
    shelve.unshelve.mockResolvedValueOnce({ exitCode: 1, message: 'a writable file by the same name exists locally.' });
    await panel.receive({ type: 'preserve', value: false });
    await panel.receive({ type: 'tick', paths: [SMILEY.serverItem], ticked: false });
    recorder.answers.push(S.unshelvePartialDelete);
    await panel.receive({ type: 'unshelve' });
    expect(shelve.deleteOwn).not.toHaveBeenCalled();
    expect(recorder.shown).toContain(S.unshelveKept('EF6 Migration 9', S.unshelveKeptExit));
  });

  it('"Unshelve and Delete" still reads the pending changes back before deleting: one missing keeps it', async () => {
    const { panel, shelve } = await openWithDetails();
    await panel.receive({ type: 'preserve', value: false });
    await panel.receive({ type: 'tick', paths: [SMILEY.serverItem], ticked: false });
    // RENAME.serverItem (date2.js) is one of the three chosen items but did not arrive pending.
    shelve.pendingIn.mockResolvedValueOnce({ ok: true, value: [HELLO.serverItem, ADDED.serverItem] });
    recorder.answers.push(S.unshelvePartialDelete);
    await panel.receive({ type: 'unshelve' });
    expect(shelve.deleteOwn).not.toHaveBeenCalled();
    expect(recorder.shown).toContain(S.unshelveKept('EF6 Migration 9', S.unshelveKeptMissing(['date2.js'])));
  });

  it('does not ask when every change is ticked, even with Preserve off', async () => {
    const { panel, shelve } = await openWithDetails();
    await panel.receive({ type: 'preserve', value: false });
    await panel.receive({ type: 'unshelve' });
    expect(recorder.messages.some((m) => m.items.includes(S.unshelvePartialKeep))).toBe(false);
    expect(shelve.deleteOwn).toHaveBeenCalledWith('EF6 Migration 9');
  });

  it('does not ask for a partial unshelve when Preserve is ticked', async () => {
    const { panel, shelve } = await openWithDetails();
    await panel.receive({ type: 'tick', paths: [SMILEY.serverItem], ticked: false });
    await panel.receive({ type: 'unshelve' });
    expect(recorder.messages.some((m) => m.items.includes(S.unshelvePartialKeep))).toBe(false);
    expect(shelve.deleteOwn).not.toHaveBeenCalled();
  });

  it('does not ask for a partial unshelve of a shelveset that is not the user\'s', async () => {
    const { panel, shelve } = await openWithDetails({}, COLLEAGUE);
    await panel.receive({ type: 'preserve', value: false });
    await panel.receive({ type: 'tick', paths: [SMILEY.serverItem], ticked: false });
    await panel.receive({ type: 'unshelve' });
    expect(recorder.messages.some((m) => m.items.includes(S.unshelvePartialKeep))).toBe(false);
    expect(shelve.deleteOwn).not.toHaveBeenCalled();
  });

  it('keeps the shelveset when the re-read before deleting it fails', async () => {
    const { panel, shelve } = await openWithDetails();
    await panel.receive({ type: 'preserve', value: false });
    shelve.contents.mockResolvedValueOnce({ ok: false, message: 'TF30063' });
    await panel.receive({ type: 'unshelve' });
    expect(shelve.deleteOwn).not.toHaveBeenCalled();
    expect(recorder.shown).toContain(S.unshelveKept('EF6 Migration 9', S.unshelveKeptReread));
  });

  it('keeps the shelveset when phase 5 found conflicts, and says both', async () => {
    const { panel, shelve } = await openWithDetails({ resolveConflicts: vi.fn(async () => 2) });
    await panel.receive({ type: 'preserve', value: false });
    await panel.receive({ type: 'unshelve' });
    expect(shelve.deleteOwn).not.toHaveBeenCalled();
    expect(recorder.shown).toEqual([
      S.unshelveConflicts('EF6 Migration 9', 2),
      S.unshelveKept('EF6 Migration 9', S.unshelveKeptConflicts),
    ]);
  });

  it.each([NaN, -1, 1.5])('treats a conflict count of %p as unknown, never as a real number of conflicts (coordinator addition)', async (bad) => {
    const { panel, shelve } = await openWithDetails({ resolveConflicts: vi.fn(async () => bad) });
    await panel.receive({ type: 'preserve', value: false });
    await panel.receive({ type: 'unshelve' });
    expect(shelve.pendingIn).not.toHaveBeenCalled();
    expect(shelve.deleteOwn).not.toHaveBeenCalled();
    expect(recorder.shown).toEqual([
      S.unshelveConflictsUnknown('EF6 Migration 9'),
      S.unshelveKept('EF6 Migration 9', S.unshelveKeptUnknown),
    ]);
  });

  it('keeps it, and warns, when conflicts could not be checked (phase 5 not merged, or failing)', async () => {
    const missing = vi.fn(async (): Promise<number> => {
      throw new Error("command 'teamExplorer.resolveConflicts' not found");
    });
    const { panel, shelve } = await openWithDetails({ resolveConflicts: missing });
    await panel.receive({ type: 'preserve', value: false });
    await panel.receive({ type: 'unshelve' });
    expect(shelve.pendingIn).not.toHaveBeenCalled();
    expect(shelve.deleteOwn).not.toHaveBeenCalled();
    expect(recorder.shown).toEqual([
      S.unshelveConflictsUnknown('EF6 Migration 9'),
      S.unshelveKept('EF6 Migration 9', S.unshelveKeptUnknown),
    ]);
  });

  it('refreshes and asks phase 5 even when tf exits non-zero (S14), then keeps the shelveset', async () => {
    const { panel, shelve, deps } = await openWithDetails();
    shelve.unshelve.mockResolvedValueOnce({ exitCode: 1, message: 'a writable file by the same name exists locally.' });
    await panel.receive({ type: 'preserve', value: false });
    await panel.receive({ type: 'unshelve' });
    expect(deps.afterUnshelve).toHaveBeenCalled();
    expect(deps.resolveConflicts).toHaveBeenCalled();
    expect(shelve.deleteOwn).not.toHaveBeenCalled();
    expect(recorder.shown[0]).toBe(S.unshelveFailed('EF6 Migration 9', 'a writable file by the same name exists locally.'));
  });

  it('keeps it when a change did not arrive as a pending change', async () => {
    const { panel, shelve } = await openWithDetails();
    shelve.pendingIn.mockResolvedValueOnce({ ok: true, value: [HELLO.serverItem] });
    await panel.receive({ type: 'preserve', value: false });
    await panel.receive({ type: 'unshelve' });
    expect(shelve.deleteOwn).not.toHaveBeenCalled();
    expect(recorder.shown).toContain(S.unshelveKept('EF6 Migration 9', S.unshelveKeptMissing(['probe-new2.txt', 'date2.js', 'smiley.jpg'])));
  });

  it('keeps it when the pending-changes read-back itself fails, rather than reading the failure as "all present"', async () => {
    const { panel, shelve } = await openWithDetails();
    shelve.pendingIn.mockResolvedValueOnce({ ok: false, message: 'TF10176' });
    await panel.receive({ type: 'preserve', value: false });
    await panel.receive({ type: 'unshelve' });
    expect(shelve.deleteOwn).not.toHaveBeenCalled();
    expect(recorder.shown).toContain(S.unshelveKept('EF6 Migration 9', S.unshelveKeptLookup));
  });

  it('keeps deleting the originally unshelved shelveset, with its own Preserve setting, even if the user selects another row and changes Preserve on it while tf is still running', async () => {
    const { panel, shelve } = await openWithDetails();
    await panel.receive({ type: 'preserve', value: false });
    let release!: (r: Ran) => void;
    shelve.unshelve.mockImplementationOnce(() => new Promise<Ran>((r) => { release = r; }));
    const started = panel.receive({ type: 'unshelve' });
    await vi.waitFor(() => expect(shelve.unshelve).toHaveBeenCalledTimes(1));
    const other = LIST.find((x) => x.name === 'TFVC-PROBE-P4-1')!;
    await panel.receive({ type: 'select', key: keyOf(other) });
    await panel.receive({ type: 'preserve', value: true });
    release({ exitCode: 0 });
    await started;
    expect(shelve.deleteOwn).toHaveBeenCalledTimes(1);
    expect(shelve.deleteOwn).toHaveBeenCalledWith('EF6 Migration 9');
  });

  it("never deletes a colleague's shelveset, and unshelves it by its owner", async () => {
    const { panel, shelve } = await openWithDetails({}, COLLEAGUE);
    await panel.receive({ type: 'preserve', value: false });
    await panel.receive({ type: 'unshelve' });
    expect(shelve.unshelve).toHaveBeenCalledWith({ name: 'Popravak web servisa', ownerUnique: 'colleague@example.com' });
    expect(shelve.deleteOwn).not.toHaveBeenCalled();
    expect(recorder.shown).toContain(S.unshelveKept('Popravak web servisa', S.unshelveKeptNotYours));
  });

  it('names only the ticked changes', async () => {
    const { panel, shelve } = await openWithDetails();
    await panel.receive({ type: 'tick', paths: [SMILEY.serverItem, ADDED.serverItem], ticked: false });
    await panel.receive({ type: 'unshelve' });
    expect(shelve.unshelve).toHaveBeenCalledWith({
      name: 'EF6 Migration 9',
      ownerUnique: 'user@example.com',
      items: [HELLO.serverItem, RENAME.serverItem],
    });
  });

  it('refuses, by name, a ticked change not mapped here, and runs nothing', async () => {
    const mapper = () => ({ toLocalPath: (p: string) => (p.endsWith('smiley.jpg') ? undefined : join(ROOT, 'x')) });
    const { panel, shelve } = await openWithDetails({ mapper });
    await panel.receive({ type: 'unshelve' });
    expect(shelve.unshelve).not.toHaveBeenCalled();
    expect(recorder.shown).toEqual([S.unshelveUnmapped(['smiley.jpg'])]);
  });

  it('asks to save an unsaved editor of an unshelved file first, and runs nothing if declined', async () => {
    const save = vi.fn(async () => true);
    const { panel, shelve } = await openWithDetails();
    workspace.textDocuments = [{ uri: Uri.file(join(ROOT, 'Web', 'hello.html')), isDirty: true, save } as never];
    recorder.answers.push(undefined);
    await panel.receive({ type: 'unshelve' });
    expect(shelve.unshelve).not.toHaveBeenCalled();
    recorder.answers.push(S.unshelveSaveYes);
    await panel.receive({ type: 'unshelve' });
    expect(save).toHaveBeenCalledTimes(1);
    expect(shelve.unshelve).toHaveBeenCalledTimes(1);
  });

  it('runs one unshelve at a time', async () => {
    const { panel, shelve } = await openWithDetails();
    let release!: (r: Ran) => void;
    shelve.unshelve.mockImplementationOnce(() => new Promise<Ran>((r) => { release = r; }));
    const first = panel.receive({ type: 'unshelve' });
    await panel.receive({ type: 'unshelve' });
    await vi.waitFor(() => expect(shelve.unshelve).toHaveBeenCalledTimes(1));
    release({ exitCode: 0 });
    await first;
    expect(shelve.unshelve).toHaveBeenCalledTimes(1);
  });
});

describe('Delete', () => {
  it("asks, modally, then deletes the user's own shelveset and re-lists", async () => {
    const { panel, shelve } = await open();
    recorder.answers.push(S.shelvesetDeleteYes);
    await panel.receive({ type: 'delete', key: keyOf(EF6) });
    expect(recorder.messages[0]).toMatchObject({ modal: true, message: `${S.shelvesetDeleteConfirm('EF6 Migration 9')}\n${S.shelvesetDeleteDetail}` });
    expect(shelve.deleteOwn).toHaveBeenCalledWith('EF6 Migration 9');
    expect(recorder.shown).toContain(S.shelvesetDeleted('EF6 Migration 9'));
    expect(shelve.list).toHaveBeenCalledTimes(2);
  });

  it('runs nothing when the user says no', async () => {
    const { panel, shelve } = await open();
    recorder.answers.push(undefined);
    await panel.receive({ type: 'delete', key: keyOf(EF6) });
    expect(shelve.deleteOwn).not.toHaveBeenCalled();
  });

  it("refuses a colleague's without asking", async () => {
    const { panel, shelve } = await open();
    await panel.receive({ type: 'delete', key: keyOf(COLLEAGUE) });
    expect(shelve.deleteOwn).not.toHaveBeenCalled();
    expect(recorder.messages).toEqual([expect.objectContaining({ modal: false, message: S.shelvesetDeleteNotYours('Popravak web servisa') })]);
  });

  it("counts nothing as the user's when the workspace list could not be read", async () => {
    const { panel, shelve } = await open({ workspaces: vi.fn(async () => ({ ok: false as const, message: 'TF30063' })) });
    // Queued so that IF a modal were shown (a bug: it should never be, since
    // nothing counts as "mine" here), it would answer Yes -- proving the
    // assertion below is not vacuously true because nothing was ever asked.
    recorder.answers.push(S.shelvesetDeleteYes);
    await panel.receive({ type: 'delete', key: keyOf(EF6) });
    expect(recorder.messages).toEqual([expect.objectContaining({ modal: false, message: S.shelvesetDeleteNotYours('EF6 Migration 9') })]);
    expect(shelve.deleteOwn).not.toHaveBeenCalled();
  });

  it("shows tf's text when the delete fails", async () => {
    const { panel, shelve } = await open();
    shelve.deleteOwn.mockResolvedValueOnce({ exitCode: 100, message: 'could not be found' });
    recorder.answers.push(S.shelvesetDeleteYes);
    await panel.receive({ type: 'delete', key: keyOf(EF6) });
    expect(recorder.shown).toContain(S.shelvesetDeleteFailed('EF6 Migration 9', 'could not be found'));
  });
});

describe('owner vs ownerUnique: tf, and the shelved URI, are always given ownerUnique, never the display-ish owner', () => {
  // The fixture list has owner === ownerUnique for every row, so a swap of the
  // two would pass every other test unnoticed. This one differs, the way tf's
  // own `owner`/`owneruniq` attributes can for a real account -- and it is
  // still "mine" via ownerUnique, so the flow reaches all four call sites,
  // including the ones only an owned, deletable shelveset reaches.
  const DIFF = { ...EF6, name: 'Owner Diff Case', owner: 'Filip Something Else', ownerDisplay: 'Filip Something Else', ownerUnique: 'user@example.com' };

  it('passes ownerUnique to contents, the shelved URI, unshelve, and the re-read before delete', async () => {
    const { panel, shelve } = await open();
    shelve.list.mockResolvedValue({ ok: true, value: [...LIST, DIFF] });
    await panel.receive({ type: 'refresh' });
    await panel.receive({ type: 'select', key: keyOf(DIFF) });
    expect(shelve.contents).toHaveBeenLastCalledWith(DIFF.name, DIFF.ownerUnique);

    await panel.receive({ type: 'file', action: 'viewShelved', path: HELLO.serverItem });
    const opened = executed.find((e) => e.id === 'vscode.open')!;
    expect(String(opened.args[0])).toBe(
      String(ServerContentProvider.shelvedUri({ serverPath: HELLO.serverItem, shelveset: DIFF.name, owner: DIFF.ownerUnique, date: DIFF.date, codePage: 1250 })),
    );

    await panel.receive({ type: 'preserve', value: false });
    await panel.receive({ type: 'unshelve' });
    expect(shelve.unshelve).toHaveBeenCalledWith(expect.objectContaining({ name: DIFF.name, ownerUnique: DIFF.ownerUnique }));
    // The re-read right before the delete (coordinator review I1).
    expect(shelve.contents).toHaveBeenLastCalledWith(DIFF.name, DIFF.ownerUnique);
    expect(shelve.deleteOwn).toHaveBeenCalledWith(DIFF.name);
  });
});

describe('restart and refresh', () => {
  it('restores the saved owner and selection', async () => {
    const { view, shelve } = setup();
    const panel = mockWindow.createWebviewPanel(SHELVESETS_VIEW_TYPE, 'x', undefined);
    await view.restore(panel as never, { owner: 'Nika Blaškova', selected: keyOf(EF6) });
    expect(shelve.list).toHaveBeenCalledWith('Nika Blaškova');
    expect(shelve.contents).toHaveBeenCalledWith('EF6 Migration 9', 'user@example.com');
  });

  it('ignores a saved owner it would refuse', async () => {
    const { view, shelve } = setup();
    const panel = mockWindow.createWebviewPanel(SHELVESETS_VIEW_TYPE, 'x', undefined);
    await view.restore(panel as never, { owner: '100%' });
    expect(shelve.list).toHaveBeenCalledWith('');
  });

  it('refreshes an open tab after a Shelve, and does nothing when none is open', async () => {
    const closed = setup();
    closed.view.refreshIfOpen();
    expect(closed.shelve.list).not.toHaveBeenCalled();
    const { view, shelve } = await open();
    view.refreshIfOpen();
    await vi.waitFor(() => expect(shelve.list).toHaveBeenCalledTimes(2));
  });

  it("a Refresh keeps the open shelveset's ticks and Preserve when the reload finds the SAME shelveset", async () => {
    const { panel, shelve, view, state } = await openWithDetails();
    await panel.receive({ type: 'preserve', value: false });
    await panel.receive({ type: 'tick', paths: [HELLO.serverItem], ticked: false });
    expect(state().details).toMatchObject({ preserve: false });
    expect(state().details!.changes.find((c) => c.serverPath === HELLO.serverItem)).toMatchObject({ ticked: false });
    // shelve.list and shelve.contents keep returning the very same EF6 (same date): a Refresh
    // reloading the shelveset the tab already has open, unchanged.
    view.refreshIfOpen();
    await vi.waitFor(() => expect(shelve.list).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(shelve.contents).toHaveBeenCalledTimes(2));
    const d = state().details!;
    expect(d.preserve).toBe(false);
    expect(d.changes.find((c) => c.serverPath === HELLO.serverItem)).toMatchObject({ ticked: false });
  });

  it('starts fresh -- every change ticked, Preserve back on -- when the reload finds the shelveset with a DIFFERENT date (it was replaced)', async () => {
    const { panel, shelve, view, state } = await openWithDetails();
    await panel.receive({ type: 'preserve', value: false });
    await panel.receive({ type: 'tick', paths: [HELLO.serverItem], ticked: false });
    const replaced = LIST.map((s) => (s === EF6 ? { ...s, date: '2027-01-01T00:00:00+02:00' } : s));
    shelve.list.mockResolvedValueOnce({ ok: true, value: replaced });
    view.refreshIfOpen();
    await vi.waitFor(() => expect(shelve.contents).toHaveBeenCalledTimes(2));
    const d = state().details!;
    expect(d.preserve).toBe(true);
    expect(d.changes.every((c) => c.ticked)).toBe(true);
  });

  it('an explicit select of a different row always starts fresh, even right after a Refresh would have kept choices', async () => {
    const { panel, shelve, state } = await openWithDetails();
    await panel.receive({ type: 'preserve', value: false });
    await panel.receive({ type: 'tick', paths: [HELLO.serverItem], ticked: false });
    const other = LIST.find((x) => x.name === 'TFVC-PROBE-P4-1')!;
    await panel.receive({ type: 'select', key: keyOf(other) });
    expect(state().details).toMatchObject({ preserve: true, key: keyOf(other) });
    expect(state().details!.changes.every((c) => c.ticked)).toBe(true);
    expect(shelve.contents).toHaveBeenLastCalledWith(other.name, other.ownerUnique);
  });
});
