import { describe, it, expect, beforeEach, vi } from 'vitest';
import { commands as vscodeCommands, executed, recorder, Uri, workspace } from '../vscode-mock.js';
import { createConflictActions, registerConflictCommands } from '../../src/commands/conflicts.js';
import { lookForConflictsAfterGet } from '../../src/conflicts/afterGet.js';
import type { Conflict } from '../../src/conflicts/conflictModel.js';
import { ServerContentProvider } from '../../src/ui/ServerContentProvider.js';
import { S } from '../../src/tf/strings.js';

const VERSION: Conflict = {
  localPath: String.raw`C:\work\Shop\Startup.cs`,
  tfPath: String.raw`C:\work\Shop\Startup.cs`,
  serverPath: '$/Shop/Startup.cs',
  reason: 'You have a conflicting pending change.',
  family: 'version',
  base: 18319,
  theirs: 18325,
  binary: false,
};
const BLOCKED: Conflict = {
  localPath: String.raw`C:\work\OPS\Program.cs`,
  tfPath: String.raw`C:\work\OPS\Program.cs`,
  serverPath: '$/OPS/Program.cs',
  reason: 'A non version controlled file or writable file by the same name already exists locally.',
  family: 'blocked',
  base: undefined,
  theirs: 14353,
  binary: false,
};

function fakeConflicts(start: Conflict[] = [VERSION, BLOCKED], outcome = { ok: true, detail: '' }) {
  let list = start;
  const resolved: [string, string][] = [];
  return {
    resolved,
    conflicts: {
      get conflicts() {
        return list;
      },
      check: async () => list,
      resolve: async (c: Conflict, how: string) => {
        resolved.push([c.localPath, how]);
        return outcome;
      },
      autoMergeAll: async () => {
        list = list.slice(1);
        return { ok: false, detail: 'Startup.cs: 0 local, 4 server, 0 both, and 1 conflicting' };
      },
    },
  };
}

function actions(
  f = fakeConflicts(),
  versionDocument?: (serverPath: string, changeset: number) => Promise<Uri>,
) {
  let after = 0;
  const fetched: [string, number][] = [];
  const a = createConflictActions({
    conflicts: f.conflicts as never,
    afterAction: () => void after++,
    platform: 'win32',
    versionDocument: (versionDocument ??
      (async (serverPath: string, changeset: number) => {
        fetched.push([serverPath, changeset]);
        return Uri.file(`/versions/C${changeset}/${serverPath.slice(serverPath.lastIndexOf('/') + 1)}`);
      })) as never,
  });
  return { a, f, fetched, afterCount: () => after };
}

const openDoc = (path: string, isDirty: boolean, saves = true) => {
  const doc = { uri: Uri.file(path), isDirty, saved: 0, save: async () => (doc.saved++, saves) };
  (workspace.textDocuments as unknown[]).push(doc);
  return doc;
};

beforeEach(() => recorder.reset());

describe('the confirms', () => {
  it('Take Theirs asks first, names the loss, and does nothing when dismissed', async () => {
    const { a, f, afterCount } = actions();
    expect(await a.resolve(VERSION, 'TakeTheirs')).toBe(false);
    expect(recorder.messages.at(-1)).toEqual({
      kind: 'warning',
      message: `${S.conflictsTakeTheirsConfirm('Startup.cs')}\n${S.conflictsTakeTheirsDetail}`,
      modal: true,
      items: [S.conflictsTakeTheirsYes],
    });
    expect(f.resolved).toEqual([]);
    expect(afterCount()).toBe(0);

    recorder.answers.push(S.conflictsTakeTheirsYes);
    expect(await a.resolve(VERSION, 'TakeTheirs')).toBe(true);
    expect(f.resolved).toEqual([[VERSION.localPath, 'TakeTheirs']]);
    expect(afterCount()).toBe(1);
  });

  it('Keep Yours says Check In will overwrite what the server has up to C<theirs> (C14)', async () => {
    const { a, f } = actions();
    recorder.answers.push(S.conflictsKeepYoursYes);
    await a.resolve(VERSION, 'KeepYours');
    expect(recorder.messages.at(-1)!.message).toBe(`${S.conflictsKeepYoursConfirm('Startup.cs')}\n${S.conflictsKeepYoursDetail(18325)}`);
    expect(f.resolved).toEqual([[VERSION.localPath, 'KeepYours']]);
  });

  it('Overwrite says the local file is lost', async () => {
    const { a, f } = actions();
    recorder.answers.push(S.conflictsOverwriteYes);
    await a.resolve(BLOCKED, 'OverwriteLocal');
    expect(recorder.messages.at(-1)!.message).toBe(`${S.conflictsOverwriteConfirm('Program.cs')}\n${S.conflictsOverwriteDetail}`);
    expect(f.resolved).toEqual([[BLOCKED.localPath, 'OverwriteLocal']]);
  });

  it("asks plainly about a conflict of no known family, with tf's reason: who 'theirs' is is not known", async () => {
    const { a, f } = actions();
    const UNKNOWN: Conflict = { ...VERSION, family: 'unknown', reason: 'The workspace and shelveset both have changes.' };
    for (const [how, yes] of [
      ['TakeTheirs', S.conflictsTakeTheirsYes],
      ['KeepYours', S.conflictsKeepYoursYes],
      ['OverwriteLocal', S.conflictsOverwriteYes],
    ] as const) {
      recorder.answers.push(yes);
      await a.resolve(UNKNOWN, how);
      expect(recorder.messages.at(-1), how).toMatchObject({
        message: `${S.conflictsUnknownConfirm(yes, 'Startup.cs')}\n${S.conflictsUnknownDetail(UNKNOWN.reason)}`,
        modal: true,
        items: [yes],
      });
    }
    expect(f.resolved.map(([, how]) => how)).toEqual(['TakeTheirs', 'KeepYours', 'OverwriteLocal']);
  });

  it('Auto-merge asks nothing: tf changes nothing it cannot merge (C12)', async () => {
    const { a, f } = actions();
    await a.resolve(VERSION, 'AutoMerge');
    expect(recorder.messages.filter((m) => m.modal)).toEqual([]);
    expect(f.resolved).toEqual([[VERSION.localPath, 'AutoMerge']]);
  });

  it("refuses while an editor holds unsaved changes to the file, before any question", async () => {
    const { a, f } = actions();
    for (const how of ['AutoMerge', 'TakeTheirs', 'KeepYours', 'OverwriteLocal'] as const) {
      recorder.reset();
      openDoc(VERSION.localPath.toLowerCase(), true);
      // An answer is queued: were a question asked, it would be answered yes.
      recorder.answers.push(S.conflictsTakeTheirsYes, S.conflictsKeepYoursYes, S.conflictsOverwriteYes);
      expect(await a.resolve(VERSION, how), how).toBe(false);
      expect(recorder.messages, how).toEqual([
        { kind: 'warning', message: S.conflictsUnsaved('Startup.cs'), modal: false, items: [] },
      ]);
    }
    expect(f.resolved).toEqual([]);
  });

  it("shows tf's own words when it did not resolve", async () => {
    const { a } = actions(fakeConflicts(undefined, { ok: false, detail: 'tf said no' }));
    await a.resolve(VERSION, 'AutoMerge');
    expect(recorder.shown).toContain(S.conflictsActionFailed('Startup.cs', 'tf said no'));
  });
});

describe('Merge manually: Resolved', () => {
  it('saves an unsaved file first, then asks, then keeps yours', async () => {
    const { a, f } = actions();
    const doc = openDoc(VERSION.localPath, true);
    recorder.answers.push(S.conflictsResolvedYes);
    expect(await a.markMerged(VERSION)).toBe(true);
    expect(doc.saved).toBe(1);
    expect(recorder.messages.at(-1)!.message).toBe(`${S.conflictsResolvedConfirm('Startup.cs')}\n${S.conflictsResolvedDetail}`);
    expect(f.resolved).toEqual([[VERSION.localPath, 'KeepYours']]);
  });

  it('stops when the save fails', async () => {
    const { a, f } = actions();
    openDoc(VERSION.localPath, true, false);
    expect(await a.markMerged(VERSION)).toBe(false);
    expect(recorder.shown).toContain(S.conflictsSaveFailed('Startup.cs'));
    expect(f.resolved).toEqual([]);
  });

  it('does nothing when the question is dismissed', async () => {
    const { a, f } = actions();
    expect(await a.markMerged(VERSION)).toBe(false);
    expect(f.resolved).toEqual([]);
  });
});

describe("Compare, Visual Studio's drop-down", () => {
  it('Local and Server: the server version at theirs against the real, editable file', async () => {
    const { a } = actions();
    await a.compare(VERSION);
    expect(executed.at(-1)).toEqual({
      id: 'vscode.diff',
      args: [ServerContentProvider.versionUri('$/Shop/Startup.cs', 18325), Uri.file(VERSION.localPath), S.conflictsCompareTitle('Startup.cs', 18325)],
    });
  });

  it('Server and Base: base against theirs, both read-only', async () => {
    const { a } = actions();
    await a.compareServerBase(VERSION);
    expect(executed.at(-1)).toEqual({
      id: 'vscode.diff',
      args: [
        ServerContentProvider.versionUri('$/Shop/Startup.cs', 18319),
        ServerContentProvider.versionUri('$/Shop/Startup.cs', 18325),
        S.conflictsCompareServerBaseTitle('Startup.cs', 18319, 18325),
      ],
    });
  });

  it('Local and Base: base against the real file', async () => {
    const { a } = actions();
    await a.compareLocalBase(VERSION);
    expect(executed.at(-1)).toEqual({
      id: 'vscode.diff',
      args: [
        ServerContentProvider.versionUri('$/Shop/Startup.cs', 18319),
        Uri.file(VERSION.localPath),
        S.conflictsCompareLocalBaseTitle('Startup.cs', 18319),
      ],
    });
  });

  it('does nothing without the changesets it needs', async () => {
    const { a } = actions();
    await a.compare({ ...VERSION, theirs: undefined });
    await a.compareServerBase({ ...VERSION, base: undefined });
    await a.compareLocalBase({ ...VERSION, base: undefined });
    expect(executed).toEqual([]);
  });

  it('compares a file TFVC calls binary through copies on disk, which VS Code diffs as text when they are', async () => {
    const { a, fetched } = actions();
    const BIN = { ...VERSION, binary: true };
    await a.compare(BIN);
    expect(executed.at(-1)).toEqual({
      id: 'vscode.diff',
      args: [Uri.file('/versions/C18325/Startup.cs'), Uri.file(VERSION.localPath), S.conflictsCompareTitle('Startup.cs', 18325)],
    });
    await a.compareServerBase(BIN);
    expect(executed.at(-1)).toEqual({
      id: 'vscode.diff',
      args: [
        Uri.file('/versions/C18319/Startup.cs'),
        Uri.file('/versions/C18325/Startup.cs'),
        S.conflictsCompareServerBaseTitle('Startup.cs', 18319, 18325),
      ],
    });
    await a.compareLocalBase(BIN);
    expect(executed.at(-1)).toEqual({
      id: 'vscode.diff',
      args: [Uri.file('/versions/C18319/Startup.cs'), Uri.file(VERSION.localPath), S.conflictsCompareLocalBaseTitle('Startup.cs', 18319)],
    });
    expect(fetched).toEqual([
      ['$/Shop/Startup.cs', 18325],
      ['$/Shop/Startup.cs', 18319],
      ['$/Shop/Startup.cs', 18325],
      ['$/Shop/Startup.cs', 18319],
    ]);
  });

  it('says why when a binary version cannot be fetched, and opens nothing', async () => {
    const { a } = actions(fakeConflicts(), async () => {
      throw new Error('tf could not get it');
    });
    await a.compare({ ...VERSION, binary: true });
    expect(executed).toEqual([]);
    expect(recorder.shown).toContain('tf could not get it');
  });
});

describe('Auto-merge all', () => {
  it('counts what it resolved', async () => {
    const { a, afterCount } = actions();
    await a.autoMergeAll();
    expect(recorder.shown).toContain(S.conflictsAutoMergeAllResult(1, 2));
    expect(afterCount()).toBe(1);
  });

  it("says it resolved nothing, in tf's words, when nothing went", async () => {
    const f = fakeConflicts();
    f.conflicts.autoMergeAll = async () => ({ ok: false, detail: 'why' });
    const { a } = actions(f);
    await a.autoMergeAll();
    expect(recorder.shown).toContain(S.conflictsAutoMergeAllNone('why'));
  });

  it('refuses while an editor holds unsaved changes to any conflicted file, as one row does', async () => {
    const f = fakeConflicts();
    let ran = 0;
    f.conflicts.autoMergeAll = async () => (ran++, { ok: true, detail: '' });
    const { a, afterCount } = actions(f);
    openDoc(BLOCKED.localPath, true);
    await a.autoMergeAll();
    expect(ran).toBe(0);
    expect(afterCount()).toBe(0);
    expect(recorder.messages).toEqual([
      { kind: 'warning', message: S.conflictsUnsaved('Program.cs'), modal: false, items: [] },
    ]);
  });
});

describe('the two commands', () => {
  function register(list: Conflict[], fail?: Error) {
    const tabs: (string | undefined)[] = [];
    registerConflictCommands({ subscriptions: [] } as never, {
      conflicts: {
        check: async () => {
          if (fail) throw fail;
          return list;
        },
      } as never,
      showTab: async (select) => void tabs.push(select),
    });
    return tabs;
  }

  it('resolveConflicts counts the conflicts at or under the paths, and opens the tab only when there are some', async () => {
    const tabs = register([VERSION, BLOCKED]);
    expect(await recorder.invoke('teamExplorer.resolveConflicts', ['$/Other'])).toBe(0);
    expect(tabs).toEqual([]);
    expect(await recorder.invoke('teamExplorer.resolveConflicts', ['$/Shop'])).toBe(1);
    expect(tabs).toEqual([VERSION.localPath]);
    expect(await recorder.invoke('teamExplorer.resolveConflicts')).toBe(2);
    expect(await recorder.invoke('teamExplorer.resolveConflicts', [])).toBe(2);
  });

  it('resolveConflicts rejects anything but $/ paths, never answering 0 or "everything" for it', async () => {
    const tabs = register([VERSION, BLOCKED]);
    for (const bad of ['$/Shop', [123], [String.raw`C:\work\Shop`], ['$/Shop', 'Shop'], [String.raw`$\Shop`], null]) {
      await expect(recorder.invoke('teamExplorer.resolveConflicts', bad), JSON.stringify(bad)).rejects.toThrow(/\$\/ server paths/);
    }
    expect(tabs).toEqual([]);
  });

  it('resolveConflicts rejects when it could not find out, so phase 4 keeps the shelveset', async () => {
    const tabs = register([], new Error('boom'));
    await expect(recorder.invoke('teamExplorer.resolveConflicts', ['$/Shop'])).rejects.toThrow('boom');
    expect(tabs).toEqual([]);
  });

  it('showConflicts always opens the tab, selecting what it was given', async () => {
    const tabs = register([]);
    await recorder.invoke('teamExplorer.showConflicts');
    await recorder.invoke('teamExplorer.showConflicts', VERSION.localPath);
    await recorder.invoke('teamExplorer.showConflicts', { resourceUri: Uri.file(BLOCKED.localPath) });
    expect(tabs).toEqual([undefined, VERSION.localPath, BLOCKED.localPath]);
  });

  it('showConflicts says so when it could not look', async () => {
    const tabs = register([], new Error('boom'));
    await recorder.invoke('teamExplorer.showConflicts');
    expect(tabs).toEqual([undefined]);
    expect(recorder.shown).toContain(S.conflictsCheckFailed('boom'));
  });
});

describe('lookForConflictsAfterGet', () => {
  it('asks resolveConflicts about what was got, and nothing when nothing was', async () => {
    lookForConflictsAfterGet([]);
    lookForConflictsAfterGet(['$/Shop/a.cs']);
    expect(executed).toEqual([{ id: 'teamExplorer.resolveConflicts', args: [['$/Shop/a.cs']] }]);
  });

  it('swallows a rejection: the Get already reported, and the check logs its own failure', async () => {
    const spy = vi.spyOn(vscodeCommands, 'executeCommand').mockReturnValueOnce(Promise.reject(new Error('not registered')));
    lookForConflictsAfterGet(['$/Shop/a.cs']);
    await new Promise((r) => setImmediate(r));
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});
