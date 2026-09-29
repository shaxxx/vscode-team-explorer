import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { manageWorkspace, mapServerFolder, type WorkspaceDeps, type WorkspaceUi } from '../../src/commands/workspace.js';
import type { WorkspaceInfo } from '../../src/tf/types.js';
import { S } from '../../src/tf/strings.js';

const DEVPC: WorkspaceInfo = { name: 'DEVPC', computer: 'DEVPC', owner: 'Filip', folders: [{ serverItem: '$/', localPath: 'C:\\work' }] };
const DEVPC_EMPTY: WorkspaceInfo = { ...DEVPC, folders: [] };
/** Ledger already has an explicit OVERRIDE mapping, elsewhere from where `$/` would naturally put it. */
const WITH_OVERRIDE: WorkspaceInfo = { ...DEVPC, folders: [...DEVPC.folders, { serverItem: '$/Ledger', localPath: 'D:\\work\\Ledger' }] };
/** Someone else moved Ledger to yet another place, between the confirm and the re-check. */
const CHANGED_ELSEWHERE: WorkspaceInfo = { ...DEVPC, folders: [...DEVPC.folders, { serverItem: '$/Ledger', localPath: 'E:\\elsewhere' }] };
/** A second, unrelated mapping (`$/Extra`) that must be left alone by a `$/Ledger` map. */
const WS_WITH_EXTRA: WorkspaceInfo = { ...DEVPC, folders: [...DEVPC.folders, { serverItem: '$/Extra', localPath: 'C:\\work\\Extra' }] };
const WS_EXTRA_CHANGED: WorkspaceInfo = {
  ...DEVPC,
  folders: [{ serverItem: '$/', localPath: 'C:\\work' }, { serverItem: '$/Extra', localPath: 'C:\\elsewhere\\Extra' }, { serverItem: '$/Ledger', localPath: 'D:\\work\\Ledger' }],
};

const LEDGER_FOLDERS = { '$/': ['Ledger', 'Shop'], '$/Ledger': [] };

/**
 * The "gets only the ticked subfolders" tests below (`offerGet` in
 * src/commands/workspace.ts) build `expected = toTf(join(local, f))`, joining
 * the NATIVE local path with the HOST's own `join`. `DEVPC`'s `C:\work` is
 * only a valid native path on Windows; on Linux the harness's identity
 * `toTf`/`fromTf` would leave it as a bogus mixed-separator string once run
 * through a real (posix) `join` -- a test artefact, not a product bug
 * (production's `local` is always a genuine host path and `PathMapper`
 * converts it). So on Linux only, those tests use a real POSIX native root
 * under a Wine-style `toTf`/`fromTf`, exactly as `PathMapper.toWinePath`/
 * `fromWinePath` do; `isWin` degrades both to identity, so Windows is
 * byte-for-byte unchanged.
 */
const isWin = process.platform === 'win32';
const toWineTf = (p: string): string => (isWin ? p : 'Z:' + p.replace(/\//g, '\\'));
const fromWineTf = (p: string): string => (isWin ? p : p.replace(/^Z:/i, '').replace(/\\/g, '/'));
const GET_LOCAL = isWin ? 'C:\\work' : '/home/u/work';
const GET_TF_ROOT = isWin ? 'C:\\work' : 'Z:\\home\\u\\work';
const GET_DEVPC: WorkspaceInfo = { name: 'DEVPC', computer: 'DEVPC', owner: 'Filip', folders: [{ serverItem: '$/', localPath: GET_TF_ROOT }] };
/** Another mapping under the SAME Wine root -- a `D:` drive (as `WITH_CHILD_OVERRIDE` uses) does
 *  not exist under Wine, which only ever exposes `Z:` (design: `PathMapper.toWinePath`). */
const GET_SHOP_OVERRIDE_TF = isWin ? 'D:\\override\\Shop' : 'Z:\\home\\u\\override\\Shop';
const GET_WITH_CHILD_OVERRIDE: WorkspaceInfo = { ...GET_DEVPC, folders: [...GET_DEVPC.folders, { serverItem: '$/Shop', localPath: GET_SHOP_OVERRIDE_TF }] };
const GET_SHOP_OVERRIDE_LOCAL = fromWineTf(GET_SHOP_OVERRIDE_TF);

/** Scripted user: each picker call takes the next answer; a function answer chooses from the offered items. */
function harness(opts: {
  workspaces: WorkspaceInfo[][];
  answers: unknown[];
  folders?: Record<string, string[]>;
  folderFailures?: Record<string, string>;
  getFailures?: Record<string, { message: string; items: number }>;
  bypassNameValidation?: boolean;
  toTf?: (p: string) => string;
  fromTf?: (p: string) => string;
}) {
  const answers = [...opts.answers];
  const shown: string[] = [];
  const confirms: { message: string; detail: string }[] = [];
  const calls: string[] = [];
  /** Every confirm (as `confirm: <message>`) plus every side-effecting call, IN ORDER -
   *  proves confirm-before-tf and re-check-before-tf without changing what `calls` means. */
  const trail: string[] = [];
  const lists = [...opts.workspaces];
  let afterChange = 0;
  const next = <T>(items?: { label: string; value: T }[]): T | undefined => {
    const a = answers.shift();
    if (typeof a === 'function') return (a as (i: typeof items) => T)(items);
    return a as T | undefined;
  };
  const record = (s: string) => {
    calls.push(s);
    trail.push(s);
  };
  const ui: WorkspaceUi = {
    pick: async (_t, items) => next(items),
    pickMany: async (_t, items) => next(items) as never,
    input: async (_t, value, validate) => {
      const a = next<string>();
      if (a === undefined) return undefined;
      const v = a === '' ? value : a;
      if (opts.bypassNameValidation) return v;
      return validate(v) === undefined ? v : undefined;
    },
    pickLocalFolder: async () => next<string>(),
    confirm: async (message, detail) => {
      confirms.push({ message, detail });
      trail.push(`confirm: ${message}`);
      return next<boolean>() ?? false;
    },
    info: (m) => void shown.push(m),
    warn: (m) => void shown.push(m),
    progress: async (_title, task) => task(() => {}, new AbortController().signal),
  };
  const deps: WorkspaceDeps = {
    ui,
    collectionUrl: 'https://acme.visualstudio.com/',
    computerName: 'NEWPC',
    makeEmptyDir: () => 'C:\\Temp\\tfvc-new-ws-1',
    ensureDir: (p) => record(`mkdir ${p}`),
    afterChange: async () => void afterChange++,
    log: () => {},
    service: {
      toTf: opts.toTf ?? ((p: string) => p),
      fromTf: opts.fromTf ?? ((p: string) => p),
      list: async () => {
        trail.push('list');
        return { ok: true, value: lists.length > 1 ? lists.shift()! : lists[0] };
      },
      create: async (name, dir) => (record(`create ${name} ${dir}`), { ok: true, value: undefined }),
      map: async (ws, s, l) => (record(`map ${ws} ${s} ${l}`), { ok: true, value: undefined }),
      unmap: async (ws, l) => (record(`unmap ${ws} ${l}`), { ok: true, value: undefined }),
      folders: async (p) => {
        const failure = opts.folderFailures?.[p];
        if (failure) return { ok: false, message: failure };
        return { ok: true, value: opts.folders?.[p] ?? [] };
      },
      get: async (l, progress) => {
        const failure = opts.getFailures?.[l];
        record(`get ${l}`);
        if (failure) return { ok: false, message: failure.message, items: failure.items };
        progress(1, 'Getting a');
        return { ok: true, value: { items: 1, cancelled: false } };
      },
    },
  };
  return { deps, shown, confirms, calls, trail, afterChangeCount: () => afterChange };
}

const choose = (predicate: (label: string) => boolean) => (items: { label: string; value: unknown }[]) =>
  items.find((i) => predicate(i.label))?.value;

describe('Manage Workspace', () => {
  it('creates a workspace when this computer has none, then removes nothing else and offers a mapping', async () => {
    const h = harness({
      workspaces: [[], [{ name: 'NEWPC', computer: 'NEWPC', folders: [] }]],
      answers: [choose((l) => l === S.wsCreateItem), '', true, undefined],
    });

    await manageWorkspace(h.deps);

    expect(h.calls).toEqual(['create NEWPC C:\\Temp\\tfvc-new-ws-1']);
    expect(h.confirms[0].message).toBe(S.wsCreateConfirm('NEWPC'));
    expect(h.afterChangeCount()).toBe(1);
  });

  it('creates nothing when the confirm is declined', async () => {
    const h = harness({ workspaces: [[]], answers: [choose((l) => l === S.wsCreateItem), '', false] });

    await manageWorkspace(h.deps);

    expect(h.calls).toEqual([]);
  });

  it('with exactly one workspace, goes straight to its mapping list (no extra pick), with Create as that list\'s last row', async () => {
    let offered: { label: string; description?: string }[] = [];
    const h = harness({
      workspaces: [[DEVPC], [DEVPC, { name: 'NEWWS', computer: 'NEWPC', folders: [] }]],
      answers: [
        (items: { label: string; description?: string; value: unknown }[]) => {
          offered = items;
          return items.find((i) => i.label === S.wsCreateItem)?.value;
        },
        'NEWWS',
        true,
        undefined,
      ],
    });

    await manageWorkspace(h.deps);

    // Straight to DEVPC's own row list (its one mapping, then Add Mapping) with Create appended
    // as the last row -- no separate "choose a workspace" pick, unlike the 2+ workspaces case.
    expect(offered.map((i) => i.label)).toEqual(['$/', S.wsAddMappingItem, S.wsCreateItem]);
    // Picking Create runs the ordinary create-workspace flow.
    expect(h.calls).toEqual(['create NEWWS C:\\Temp\\tfvc-new-ws-1']);
    expect(h.confirms[0].message).toBe(S.wsCreateConfirm('NEWWS'));
  });

  it('with two workspaces on this computer, the picker lists both plus Create, and picking Create runs the create-workspace flow', async () => {
    const OLD_VS: WorkspaceInfo = { name: 'OLDVS', computer: 'NEWPC', owner: 'Filip', folders: [] };
    const TOOL_MADE: WorkspaceInfo = { name: 'TOOLMADE', computer: 'NEWPC', folders: [] };
    const NEW_WS: WorkspaceInfo = { name: 'NEWWS', computer: 'NEWPC', folders: [] };
    let offered: { label: string; description?: string }[] = [];
    const h = harness({
      workspaces: [[OLD_VS, TOOL_MADE], [OLD_VS, TOOL_MADE, NEW_WS]],
      answers: [
        (items: { label: string; description?: string; value: unknown }[]) => {
          offered = items;
          return items.find((i) => i.label === S.wsCreateItem)?.value;
        },
        'NEWWS',
        true,
        undefined,
      ],
    });

    await manageWorkspace(h.deps);

    expect(offered.map((i) => i.label)).toEqual(['OLDVS', 'TOOLMADE', S.wsCreateItem]);
    expect(h.calls).toEqual(['create NEWWS C:\\Temp\\tfvc-new-ws-1']);
    expect(h.confirms[0].message).toBe(S.wsCreateConfirm('NEWWS'));
  });

  it('refuses an empty name and one with characters tf rejects', async () => {
    const h = harness({ workspaces: [[]], answers: [choose((l) => l === S.wsCreateItem), 'a;b'] });

    await manageWorkspace(h.deps);

    expect(h.calls).toEqual([]);
    expect(h.confirms).toEqual([]);
  });

  it('refuses a leading -, ! % ^, and a name over 64 characters, at the UI validator', async () => {
    const bad = ['-abc', 'ab^c', 'ab%c', 'ab!c', 'a'.repeat(65)];
    for (const name of bad) {
      const h = harness({ workspaces: [[]], answers: [choose((l) => l === S.wsCreateItem), name] });
      await manageWorkspace(h.deps);
      expect(h.calls, name).toEqual([]);
      expect(h.confirms, name).toEqual([]);
    }
  });

  it('refuses the same bad names in createWorkspace itself, even when the UI validator is bypassed (M5 defense in depth)', async () => {
    const cases: [string, string][] = [
      ['-abc', S.wsNameLeadingDash],
      ['ab^c', S.wsNameBadChars],
      ['a'.repeat(65), S.wsNameTooLong],
      ['a;b', S.wsNameInvalid],
    ];
    for (const [name, message] of cases) {
      const h = harness({ workspaces: [[]], answers: [choose((l) => l === S.wsCreateItem), name], bypassNameValidation: true });
      await manageWorkspace(h.deps);
      expect(h.calls, name).toEqual([]);
      expect(h.confirms, name).toEqual([]);
      expect(h.shown, name).toContain(message);
    }
  });

  it('refuses the default name when it collides case-insensitively with an existing workspace on this computer, even when the UI validator is bypassed (M5 defense in depth)', async () => {
    // The default name offered by the input box is d.computerName ('NEWPC' in this harness);
    // this computer already has a workspace named 'newpc' -- different case, same name (e.g.
    // one made by Visual Studio), which the duplicate check must still catch.
    const h = harness({
      workspaces: [[{ name: 'newpc', computer: 'NEWPC', folders: [] }]],
      answers: [choose((l) => l === S.wsCreateItem), ''],
      bypassNameValidation: true,
    });

    await manageWorkspace(h.deps);

    expect(h.calls).toEqual([]);
    expect(h.confirms).toEqual([]);
    expect(h.shown).toContain(S.wsNameDuplicate('NEWPC'));
  });

  it('refuses that same duplicate at the input box\'s own inline validator, without needing the M5 recheck', async () => {
    const h = harness({
      workspaces: [[{ name: 'newpc', computer: 'NEWPC', folders: [] }]],
      answers: [choose((l) => l === S.wsCreateItem), ''],
      // bypassNameValidation is NOT set: the harness's `input()` calls the real `validate`
      // callback manageWorkspace/createWorkspace wired up, exactly as the VS Code input box
      // would. If that callback does not see this computer's existing names, this name would
      // be accepted and `create` would run.
    });

    await manageWorkspace(h.deps);

    expect(h.calls).toEqual([]);
    expect(h.confirms).toEqual([]);
  });

  it('maps a project to its own folder after a confirm that says Visual Studio shares the workspace', async () => {
    const after: WorkspaceInfo = { ...DEVPC, folders: [...DEVPC.folders, { serverItem: '$/Ledger', localPath: 'D:\\work\\Ledger' }] };
    const h = harness({
      workspaces: [[DEVPC], [DEVPC], [after]],
      folders: LEDGER_FOLDERS,
      answers: [
        choose((l) => l === S.wsAddMappingItem),
        choose((l) => l.includes('Ledger')),
        choose((l) => l === S.wsUseThisFolder('$/Ledger')),
        'D:\\work\\Ledger',
        true,
        false,
      ],
    });

    await manageWorkspace(h.deps);

    // DEVPC's $/Ledger is a MOVE (already covered through the $/ parent, task 4 fix I3):
    // the confirm must name where it is now, where it would go, and (in the detail) the
    // workspace, and must say a Get afterwards moves the files (P11) and that Visual
    // Studio will only find them at the new place.
    expect(h.confirms[0].message).toBe(S.wsMoveConfirm('$/Ledger', 'C:\\work\\Ledger', 'D:\\work\\Ledger'));
    expect(h.confirms[0].detail).toBe(S.wsMoveDetail('DEVPC', '$/Ledger', 'C:\\work\\Ledger', 'D:\\work\\Ledger'));
    expect(h.calls).toEqual(['mkdir D:\\work\\Ledger', 'map DEVPC $/Ledger D:\\work\\Ledger']);
    expect(h.afterChangeCount()).toBe(1);
    // Confirm-before-tf, in order.
    expect(h.trail).toEqual([
      'list',
      `confirm: ${S.wsMoveConfirm('$/Ledger', 'C:\\work\\Ledger', 'D:\\work\\Ledger')}`,
      'list',
      'mkdir D:\\work\\Ledger',
      'map DEVPC $/Ledger D:\\work\\Ledger',
      'list',
      `confirm: ${S.wsGetNowConfirmMoved('$/Ledger', 'C:\\work\\Ledger', 'D:\\work\\Ledger')}`,
    ]);
  });

  it('declines a move confirm and does nothing: no mkdir, no map', async () => {
    const h = harness({
      workspaces: [[DEVPC]],
      folders: LEDGER_FOLDERS,
      answers: [
        choose((l) => l === S.wsAddMappingItem),
        choose((l) => l.includes('Ledger')),
        choose((l) => l === S.wsUseThisFolder('$/Ledger')),
        'D:\\work\\Ledger',
        false,
      ],
    });

    await manageWorkspace(h.deps);

    expect(h.calls).toEqual([]);
  });

  it('moving a mapping back to where its parent naturally puts it does not false-warn (P4 dropped as redundant)', async () => {
    const h = harness({
      workspaces: [[WITH_OVERRIDE], [WITH_OVERRIDE], [DEVPC]],
      folders: LEDGER_FOLDERS,
      answers: [
        choose((l) => l === S.wsAddMappingItem),
        choose((l) => l.includes('Ledger')),
        choose((l) => l === S.wsUseThisFolder('$/Ledger')),
        'C:\\work\\Ledger',
        true,
        false,
      ],
    });

    await manageWorkspace(h.deps);

    expect(h.confirms[0].message).toBe(S.wsMoveConfirm('$/Ledger', 'D:\\work\\Ledger', 'C:\\work\\Ledger'));
    expect(h.calls).toEqual(['mkdir C:\\work\\Ledger', 'map DEVPC $/Ledger C:\\work\\Ledger']);
    expect(h.shown.some((m) => m.includes('tf reported success'))).toBe(false);
  });

  it('re-checks right before /map and stops, without calling tf, if the mapping changed underneath', async () => {
    const h = harness({
      workspaces: [[DEVPC], [CHANGED_ELSEWHERE]],
      folders: LEDGER_FOLDERS,
      answers: [
        choose((l) => l === S.wsAddMappingItem),
        choose((l) => l.includes('Ledger')),
        choose((l) => l === S.wsUseThisFolder('$/Ledger')),
        'D:\\work\\Ledger',
        true,
      ],
    });

    await manageWorkspace(h.deps);

    expect(h.calls).toEqual([]);
    expect(h.shown).toContain(S.wsMapChangedBeforeApply('$/Ledger', 'DEVPC'));
  });

  it('warns with the exact difference when tf also changed a mapping nobody asked to change', async () => {
    const h = harness({
      workspaces: [[WS_WITH_EXTRA], [WS_WITH_EXTRA], [WS_EXTRA_CHANGED]],
      folders: LEDGER_FOLDERS,
      answers: [
        choose((l) => l === S.wsAddMappingItem),
        choose((l) => l.includes('Ledger')),
        choose((l) => l === S.wsUseThisFolder('$/Ledger')),
        'D:\\work\\Ledger',
        true,
        false,
      ],
    });

    await manageWorkspace(h.deps);

    expect(h.shown.some((m) => m.includes('$/Extra') && m.includes('C:\\elsewhere\\Extra'))).toBe(true);
  });

  it('refuses a different project inside a mapped folder without calling tf (R3)', async () => {
    const h = harness({
      workspaces: [[DEVPC]],
      folders: { '$/': ['Ledger'] },
      answers: [
        choose((l) => l === S.wsAddMappingItem),
        choose((l) => l.includes('Ledger')),
        choose((l) => l === S.wsUseThisFolder('$/Ledger')),
        'C:\\work\\Other',
      ],
    });

    await manageWorkspace(h.deps);

    expect(h.calls).toEqual([]);
    expect(h.shown).toContain(S.wsMapInsideOther('C:\\work\\Other', 'C:\\work', '$/', 'DEVPC'));
  });

  it('says a redundant child changes nothing (R4)', async () => {
    const h = harness({
      workspaces: [[DEVPC]],
      folders: { '$/': ['Shop'] },
      answers: [
        choose((l) => l === S.wsAddMappingItem),
        choose((l) => l.includes('Shop')),
        choose((l) => l === S.wsUseThisFolder('$/Shop')),
        'C:\\work\\Shop',
      ],
    });

    await manageWorkspace(h.deps);

    expect(h.calls).toEqual([]);
    expect(h.shown).toContain(S.wsMapRedundant('$/Shop', '$/', 'C:\\work'));
  });

  it('says the exact pair is already mapped, without naming the mapping as its own parent', async () => {
    // FEDORA acceptance item 6: re-mapping assets -> A read "already mapped there,
    // through $/…/assets → A" -- the same mapping named as the one it goes through.
    const h = harness({
      workspaces: [[DEVPC]],
      folders: { '$/': ['Shop'] },
      answers: [
        choose((l) => l === S.wsAddMappingItem),
        choose((l) => l === S.wsUseThisFolder('$/')),
        'C:\\work',
      ],
    });

    await manageWorkspace(h.deps);

    expect(h.calls).toEqual([]);
    expect(h.shown).toContain(S.wsMapAlreadyThere('$/', 'C:\\work'));
  });

  it('warns when the workspace does not show the pair tf said it mapped', async () => {
    const h = harness({
      workspaces: [[DEVPC], [DEVPC], [DEVPC]],
      folders: LEDGER_FOLDERS,
      answers: [
        choose((l) => l === S.wsAddMappingItem),
        choose((l) => l.includes('Ledger')),
        choose((l) => l === S.wsUseThisFolder('$/Ledger')),
        'D:\\work\\Ledger',
        true,
      ],
    });

    await manageWorkspace(h.deps);

    expect(h.shown).toContain(S.wsMapNotAsAsked('$/Ledger', 'D:\\work\\Ledger'));
  });

  it('removes a mapping only after its confirm, and says the files stay', async () => {
    const h = harness({
      workspaces: [[DEVPC], [DEVPC], [DEVPC_EMPTY]],
      answers: [choose((l) => l === '$/'), choose((l) => l === S.wsRemoveItem), true],
    });

    await manageWorkspace(h.deps);

    expect(h.confirms[0].detail).toBe(S.wsUnmapDetail);
    expect(h.calls).toEqual(['unmap DEVPC C:\\work']);
    expect(h.trail).toEqual(['list', `confirm: ${S.wsUnmapConfirm('DEVPC', '$/', 'C:\\work')}`, 'list', 'unmap DEVPC C:\\work', 'list']);
  });

  it('does not remove anything when the confirm is declined', async () => {
    const h = harness({
      workspaces: [[DEVPC]],
      answers: [choose((l) => l === '$/'), choose((l) => l === S.wsRemoveItem), false],
    });

    await manageWorkspace(h.deps);

    expect(h.calls).toEqual([]);
  });

  it("removing an override says the next Get of the parent moves the files back, and re-checks before /unmap", async () => {
    const h = harness({
      workspaces: [[WITH_OVERRIDE], [WITH_OVERRIDE], [DEVPC]],
      answers: [choose((l) => l === '$/Ledger'), choose((l) => l === S.wsRemoveItem), true],
    });

    await manageWorkspace(h.deps);

    expect(h.confirms[0].detail).toBe(S.wsUnmapMovesBack('$/', 'C:\\work\\Ledger'));
    expect(h.calls).toEqual(['unmap DEVPC D:\\work\\Ledger']);
    expect(h.shown).toContain(S.wsUnmappedMovesBack('$/Ledger', '$/', 'C:\\work\\Ledger'));
  });

  it('re-checks right before /unmap and stops, without calling tf, if the pair is already gone', async () => {
    const h = harness({
      workspaces: [[DEVPC], [DEVPC_EMPTY]],
      answers: [choose((l) => l === '$/'), choose((l) => l === S.wsRemoveItem), true],
    });

    await manageWorkspace(h.deps);

    expect(h.calls).toEqual([]);
    expect(h.shown).toContain(S.wsUnmapChangedBeforeApply('$/', 'DEVPC'));
  });

  it('gets only the ticked subfolders, each in its own local folder', async () => {
    const h = harness({
      workspaces: [[GET_DEVPC]],
      folders: { '$/': ['Shop', 'Ledger'] },
      answers: [choose((l) => l === '$/'), choose((l) => l === S.wsGetItem), () => ['Ledger']],
      toTf: toWineTf,
      fromTf: fromWineTf,
    });

    await manageWorkspace(h.deps);

    expect(h.calls).toEqual([`get ${join(GET_LOCAL, 'Ledger')}`]);
    expect(h.shown).toContain(S.wsGetDone('$/Ledger', 1));
  });

  it('looks for conflicts under what it got, after Team Explorer has been reinitialised (phase 5)', async () => {
    const h = harness({
      workspaces: [[GET_DEVPC]],
      folders: { '$/': ['Shop', 'Ledger'] },
      answers: [choose((l) => l === '$/'), choose((l) => l === S.wsGetItem), () => ['Ledger']],
      toTf: toWineTf,
      fromTf: fromWineTf,
    });
    const looked: { paths: string[]; afterChanges: number }[] = [];
    h.deps.lookForConflicts = (paths) => void looked.push({ paths: [...paths], afterChanges: h.afterChangeCount() });

    await manageWorkspace(h.deps);

    expect(looked).toEqual([{ paths: ['$/Ledger'], afterChanges: 1 }]);
  });

  it('gets nothing when the checklist is dismissed', async () => {
    const h = harness({
      workspaces: [[DEVPC]],
      folders: { '$/': ['Shop'] },
      answers: [choose((l) => l === '$/'), choose((l) => l === S.wsGetItem), undefined],
    });

    await manageWorkspace(h.deps);

    expect(h.calls).toEqual([]);
  });

  it('skips a ticked subfolder that a more specific mapping sends elsewhere, and does not Get it', async () => {
    const h = harness({
      workspaces: [[GET_WITH_CHILD_OVERRIDE]],
      folders: { '$/': ['Shop', 'Ledger'] },
      answers: [choose((l) => l === '$/'), choose((l) => l === S.wsGetItem), () => ['Shop', 'Ledger']],
      toTf: toWineTf,
      fromTf: fromWineTf,
    });

    await manageWorkspace(h.deps);

    expect(h.calls).toEqual([`get ${join(GET_LOCAL, 'Ledger')}`]);
    expect(h.shown).toContain(S.wsGetElsewhere('$/Shop', GET_SHOP_OVERRIDE_LOCAL));
  });

  it('a folders() failure stops Get: never falls back to a whole-tree Get', async () => {
    const h = harness({
      workspaces: [[DEVPC]],
      folderFailures: { '$/': 'tf could not read $/.' },
      answers: [choose((l) => l === '$/'), choose((l) => l === S.wsGetItem)],
    });

    await manageWorkspace(h.deps);

    expect(h.calls).toEqual([]);
    expect(h.shown).toContain('tf could not read $/.');
  });

  it('a partial Get shows its item count and says which ticked folders were not attempted', async () => {
    const h = harness({
      workspaces: [[GET_DEVPC]],
      folders: { '$/': ['A', 'B'] },
      getFailures: { [join(GET_LOCAL, 'A')]: { message: S.wsGetPartial(3, 'boom'), items: 3 } },
      answers: [choose((l) => l === '$/'), choose((l) => l === S.wsGetItem), () => ['A', 'B']],
      toTf: toWineTf,
      fromTf: fromWineTf,
    });

    await manageWorkspace(h.deps);

    expect(h.calls).toEqual([`get ${join(GET_LOCAL, 'A')}`]);
    expect(h.shown.some((m) => m.includes(S.wsGetPartial(3, 'boom')) && m.includes(S.wsGetNotAttempted('$/B')))).toBe(true);
  });
});

describe('phase 3 part 2: mapServerFolder (the explorer\'s Map to Local Folder)', () => {
  it('starts at the local folder picker with the server path already chosen, and confirms before mapping', async () => {
    const h = harness({
      workspaces: [[{ ...DEVPC, folders: [] }], [{ ...DEVPC, folders: [] }], [{ ...DEVPC, folders: [{ serverItem: '$/Other', localPath: 'D:\\work\\Other' }] }]],
      answers: ['D:\\work\\Other', true],
    });

    await mapServerFolder(h.deps, '$/Other');

    // Never browses the server: the caller already chose the path.
    expect(h.calls.some((c) => c.startsWith('map '))).toBe(true);
    expect(JSON.stringify(h.calls)).toContain('$/Other');
    // The current test would pass even if the confirm were skipped -- prove
    // it actually ran, and BEFORE the map, via the shared trail.
    const confirmIndex = h.trail.findIndex((t) => t.startsWith('confirm:'));
    const mapIndex = h.trail.findIndex((t) => t.startsWith('map '));
    expect(confirmIndex).toBeGreaterThanOrEqual(0);
    expect(mapIndex).toBeGreaterThan(confirmIndex);
  });

  it('says so when this computer has no workspace', async () => {
    const h = harness({ workspaces: [[]], answers: [] });

    await mapServerFolder(h.deps, '$/Other');

    expect(h.shown).toContain(S.wsNoWorkspaceForMap);
    expect(h.calls).toEqual([]);
  });

  // Review: the explorer's Map to Local Folder may never MOVE an existing
  // mapping -- only Manage Workspace's own Add Mapping, which the user
  // reaches deliberately, keeps that behaviour. Before the fix, `preset`
  // skipped only `browseServer`; `checkMapping` could still return `move` and
  // `addMapping` would show the move confirm, then run `/map`, silently
  // relocating a mapping the user never asked to touch.
  it('refuses a preset path that is already mapped directly elsewhere, without a confirm or a map call', async () => {
    const h = harness({
      workspaces: [[WITH_OVERRIDE]],
      answers: ['C:\\work\\Ledger'],
    });

    await mapServerFolder(h.deps, '$/Ledger');

    expect(h.shown).toContain(S.sceAlreadyMapped('Ledger', 'D:\\work\\Ledger'));
    expect(h.confirms).toEqual([]);
    expect(h.calls).toEqual([]);
  });

  it('refuses a preset path that is already mapped through a parent, without a confirm or a map call', async () => {
    const h = harness({
      workspaces: [[DEVPC]],
      answers: ['D:\\work\\Other'],
    });

    await mapServerFolder(h.deps, '$/Other');

    // $/Other naturally resolves through $/ to C:\work\Other; picking a
    // different local folder would MOVE it, exactly like the direct case.
    expect(h.shown).toContain(S.sceAlreadyMapped('Other', 'C:\\work\\Other'));
    expect(h.confirms).toEqual([]);
    expect(h.calls).toEqual([]);
  });
});
