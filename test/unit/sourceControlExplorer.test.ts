import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  recorder,
  createdPanels,
  executed,
  progressRuns,
  quickPickAnswers,
  quickPicks,
  clipboard,
  window as mockWindow,
  Uri,
  type MockWebviewPanel,
} from '../vscode-mock.js';
import { SourceControlExplorer, EXPLORER_VIEW_TYPE, RELOAD_DELAY_MS, type ExplorerDeps } from '../../src/ui/SourceControlExplorer.js';
import type { ExplorerState } from '../../src/explorer/explorerModel.js';
import type { DirListing } from '../../src/tf/parseDir.js';
import type { InfoItem } from '../../src/tf/parseInfo.js';
import { S } from '../../src/tf/strings.js';

const LISTINGS: Record<string, DirListing> = {
  '$/': { path: '$/', folders: ['Shop', 'Other'], files: [] },
  '$/Shop': { path: '$/Shop', folders: ['Shop2023'], files: ['readme.txt'] },
  '$/Other': { path: '$/Other', folders: ['Sub'], files: [] },
};
const INFO: Record<string, InfoItem[]> = {
  '$/': [
    { serverPath: '$/Shop', type: 'folder', localPath: 'C:\\work\\Shop', localChangeset: 9, localChange: 'none', serverChangeset: 9, lock: 'none', lastModified: 'x' },
    { serverPath: '$/Other', type: 'folder', localChange: '', serverChangeset: 3, lock: 'none', lastModified: 'y' },
  ],
  '$/Shop': [
    { serverPath: '$/Shop/Shop2023', type: 'folder', localPath: 'C:\\work\\Shop\\Shop2023', localChangeset: 5, localChange: 'none', serverChangeset: 5, lock: 'none', lastModified: 'a' },
    { serverPath: '$/Shop/readme.txt', type: 'file', localPath: 'C:\\work\\Shop\\readme.txt', localChangeset: 4, localChange: 'none', serverChangeset: 6, lock: 'none', lastModified: 'b' },
  ],
};
/** `$/Shop/readme.txt`: the fixture's one downloaded file row (mapped, with a local copy). */
const FILE = '$/Shop/readme.txt';

/**
 * `explorerOver` replaces individual methods of the fake `ExplorerService`
 * (e.g. a `get` that hangs until the test resolves it, or a `details` that
 * never lands for one path). Defaults mirror the REAL contract closely enough
 * for these tests: `dir` listings are genuinely cached until `forget()`
 * clears them -- a static always-cached stand-in would hide bugs
 * like review finding 2, where Refresh must really re-list an expanded
 * branch it just forgot.
 */
function setup(over: Partial<ExplorerDeps> = {}, explorerOver: Partial<ExplorerDeps['explorer']> = {}) {
  const getCalls: string[][] = [];
  const detailsCalls: string[] = [];
  const cache = new Map<string, DirListing>();
  const explorer = {
    list: vi.fn(async (path: string, fresh = false) => {
      if (!fresh && cache.has(path)) return { ok: true as const, value: cache.get(path)! };
      if (!LISTINGS[path]) return { ok: false as const, message: 'TF14061 no such folder' };
      cache.set(path, LISTINGS[path]);
      return { ok: true as const, value: LISTINGS[path] };
    }),
    cachedListing: (path: string) => cache.get(path),
    status: vi.fn(async () => ({ ok: true as const, value: [] })),
    details: vi.fn(async (path: string) => {
      detailsCalls.push(path);
      return { info: { ok: true as const, value: INFO[path] ?? [] }, status: { ok: true as const, value: [] } };
    }),
    workspaces: vi.fn(async () => ({ ok: true as const, value: [{ name: 'DEVPC', computer: 'DEVPC', folders: [] }] })),
    forget: vi.fn(() => cache.clear()),
    get: vi.fn(async (args: string[]) => {
      getCalls.push(args);
      return { items: 2, deleted: 0, cancelled: false };
    }),
  };
  // A separate assignment, not an inline spread: spreading `explorerOver`
  // into the literal above would union its plain-function types into every
  // property's inferred type, losing `.mock` on the ones no test overrides.
  Object.assign(explorer, explorerOver);
  const deps: ExplorerDeps = {
    explorer,
    // `$/Shop` is mapped to C:\work\Shop; `$/Other` is mapped nowhere.
    mapper: () => ({ toLocalPath: (p: string) => (p === '$/Shop' || p.startsWith('$/Shop/') ? 'C:\\work\\' + p.slice(2).split('/').join('\\') : undefined) }),
    showHistory: vi.fn(async () => {}),
    recentChangesets: vi.fn(async () => [{ id: 16730, user: 'Filip', date: 'd', comment: 'fix\nmore' }]),
    mapServerFolder: vi.fn(async () => {}),
    pendingChanges: () => [],
    unversionedUnder: vi.fn(() => ['C:\\work\\Shop\\Shop2023\\new.txt']),
    afterGet: vi.fn(),
    log: vi.fn(),
    ...over,
  };
  const sce = new SourceControlExplorer(() => Uri.file('/ext') as never, deps);
  return { sce, deps, explorer, getCalls, detailsCalls };
}

const lastState = (panel: MockWebviewPanel) => panel.webview.posted[panel.webview.posted.length - 1] as ExplorerState;

beforeEach(() => {
  recorder.reset();
  createdPanels.length = 0;
  progressRuns.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('SourceControlExplorer: the tab', () => {
  it('opens one tab, shows the folder with its status, and reveals it when asked again', async () => {
    const { sce } = setup();
    await sce.show('$/Shop');
    expect(createdPanels).toHaveLength(1);
    const panel = createdPanels[0];
    expect(panel.viewType).toBe(EXPLORER_VIEW_TYPE);
    expect(panel.webview.html).toContain('explorer.js');
    const state = lastState(panel);
    expect(state.path).toBe('$/Shop');
    expect(state.rows.map((r) => r.name)).toEqual(['Shop2023', 'readme.txt']);
    expect(state.rows[1].latest).toBe('no');
    expect(state.infoState).toBe('ok');
    await sce.show('$/Shop');
    expect(createdPanels).toHaveLength(1);
    expect(panel.revealed).toBe(1);
  });

  it('selects the item it was asked to show (Show in Source Control Explorer)', async () => {
    const { sce } = setup();
    await sce.show('$/Shop', '$/Shop/readme.txt');
    expect(lastState(createdPanels[0]).selection).toEqual(['$/Shop/readme.txt']);
  });

  it('shows a failed listing as an error, not a crash', async () => {
    const { sce } = setup();
    await sce.show('$/Nowhere');
    const s = lastState(createdPanels[0]);
    expect(s.listState).toBe('failed');
    expect(s.listError).toBe('TF14061 no such folder');
  });

  it('reopens where it was after a restart, and at $/ for anything that is not a server path', async () => {
    const { sce } = setup();
    const restored = mockWindow.createWebviewPanel(EXPLORER_VIEW_TYPE, 'x', -1, {});
    await sce.restore(restored as never, { path: '$/Shop' });
    expect(lastState(restored).path).toBe('$/Shop');
    expect(restored.webview.options).toMatchObject({ enableScripts: true });
    const again = mockWindow.createWebviewPanel(EXPLORER_VIEW_TYPE, 'x', -1, {});
    await sce.restore(again as never, { path: 'C:\\work' });
    expect(lastState(again).path).toBe('$/');
  });

  it('falls back to $/ on a saved path that only looks like a server path, or is not one at all, and runs nothing (review finding 3)', async () => {
    const { sce, getCalls } = setup();
    const junk: unknown[] = [
      // Real server-looking strings a compromised page could setState() with:
      // tf wildcard/itemspec syntax and a `..` segment `getLatestArgs` itself
      // would not have caught (it only checks the `$/` prefix).
      { path: '$/Shop/*' },
      { path: '$/Shop/Shop2023/..' },
      { path: '$/Shop/X;C1' },
      // Not even the right shape.
      'not an object',
      42,
      null,
    ];
    for (const saved of junk) {
      const panel = mockWindow.createWebviewPanel(EXPLORER_VIEW_TYPE, 'x', -1, {});
      await sce.restore(panel as never, saved);
      expect(lastState(panel).path).toBe('$/');
    }
    expect(executed).toEqual([]);
    expect(getCalls).toEqual([]);
  });

  // Review (phase 3 part 2): show() is reachable from teamExplorer.openExplorer
  // (a mapped local path, translated through the pathMapper) and from
  // showInExplorer (ditto), but nothing before this stopped a crafted or
  // merely unlucky path -- a real local folder literally named `*` or `;` is
  // legal on Fedora's ext4, and PathMapper.toServerPath would happily turn it
  // into `$/Shop/*` -- from reaching the model unchecked, where folderRow()
  // would offer it as a Get target.
  it('falls back to $/ on an invalid path passed to show(), and never lists it (review)', async () => {
    const { sce, explorer } = setup();
    await sce.show('$/Shop/*');
    expect(lastState(createdPanels[0]).path).toBe('$/');
    expect(explorer.list).not.toHaveBeenCalledWith('$/Shop/*', true);
  });

  it('drops an invalid select passed to show(), keeping the (valid) path', async () => {
    const { sce } = setup();
    await sce.show('$/Shop', '$/Shop/*');
    const state = lastState(createdPanels[0]);
    expect(state.path).toBe('$/Shop');
    expect(state.selection).toEqual([]);
  });

  it('reloads status once per burst of change events', async () => {
    const { sce, detailsCalls } = setup();
    await sce.show('$/Shop');
    detailsCalls.length = 0;
    vi.useFakeTimers();
    sce.scheduleReload();
    sce.scheduleReload();
    sce.scheduleReload();
    await vi.advanceTimersByTimeAsync(RELOAD_DELAY_MS);
    expect(detailsCalls).toEqual(['$/Shop']);
  });

  it('reloads an expanded tree branch that Refresh just forgot, not only the current path (review finding 2)', async () => {
    const { sce } = setup();
    await sce.show('$/Shop');
    const panel = createdPanels[0];
    // $/Other is a sibling of the open folder, not one of its ancestors --
    // loadAncestors() alone would never revisit it.
    await panel.receive({ type: 'toggle', path: '$/Other' });
    expect(lastState(panel).tree.find((t) => t.path === '$/Other')).toMatchObject({ expanded: true, loading: false });
    expect(lastState(panel).tree.some((t) => t.path === '$/Other/Sub')).toBe(true);

    await panel.receive({ type: 'refresh' });
    const tree = lastState(panel).tree;
    expect(tree.find((t) => t.path === '$/Other')).toMatchObject({ expanded: true, loading: false });
    expect(tree.some((t) => t.path === '$/Other/Sub')).toBe(true);
  });
});

describe('SourceControlExplorer: messages', () => {
  it('ignores a malformed message and an unknown folder, running nothing', async () => {
    const { sce, deps, explorer } = setup();
    await sce.show('$/Shop');
    const panel = createdPanels[0];
    const listCalls = explorer.list.mock.calls.length;
    await panel.receive({ type: 'action', action: 'destroy', paths: [] });
    await panel.receive({ type: 'navigate', path: '$/Secret' });
    expect(explorer.list.mock.calls.length).toBe(listCalls);
    expect(executed).toEqual([]);
    expect(deps.log).toHaveBeenCalled();
  });

  it('refuses an action on a row it never listed', async () => {
    const { sce } = setup();
    await sce.show('$/Shop');
    await createdPanels[0].receive({ type: 'action', action: 'checkout', paths: ['$/Shop/secret.txt'] });
    expect(executed).toEqual([]);
    expect(recorder.shown).toContain(S.sceUnknownPath);
  });

  it("answers with the model's refusal, and runs nothing", async () => {
    const { sce } = setup();
    await sce.show('$/');
    await createdPanels[0].receive({ type: 'action', action: 'checkout', paths: ['$/Other'] });
    expect(recorder.shown).toContain(S.sceNotMappedAction('Other'));
    expect(executed).toEqual([]);
  });
});

describe('SourceControlExplorer: actions', () => {
  it('asks before checking out a folder; declined runs nothing, accepted runs Phase 1 checkout on local paths', async () => {
    const { sce } = setup();
    await sce.show('$/Shop');
    const panel = createdPanels[0];
    recorder.answers.push(undefined);
    await panel.receive({ type: 'action', action: 'checkout', paths: ['$/Shop/Shop2023'] });
    expect(recorder.messages.at(-1)!.modal).toBe(true);
    expect(executed.filter((e) => e.id === 'teamExplorer.checkout')).toEqual([]);
    recorder.answers.push(S.sceCheckoutFolderYes);
    await panel.receive({ type: 'action', action: 'checkout', paths: ['$/Shop/Shop2023'] });
    const call = executed.find((e) => e.id === 'teamExplorer.checkout')!;
    expect((call.args[0] as Uri).fsPath).toBe('C:\\work\\Shop\\Shop2023');
    expect((call.args[1] as Uri[]).map((u) => u.fsPath)).toEqual(['C:\\work\\Shop\\Shop2023']);
  });

  it('checks out a file without asking', async () => {
    const { sce } = setup();
    await sce.show('$/Shop');
    await createdPanels[0].receive({ type: 'action', action: 'checkout', paths: ['$/Shop/readme.txt'] });
    expect(recorder.messages.filter((m) => m.modal)).toEqual([]);
    expect(executed.find((e) => e.id === 'teamExplorer.checkout')).toBeDefined();
  });

  it('gets the selection with a cancellable progress notification, then says what it did and refreshes (part 1 W5)', async () => {
    const { sce, deps, getCalls } = setup();
    await sce.show('$/Shop');
    await createdPanels[0].receive({ type: 'action', action: 'getLatest', paths: ['$/Shop/readme.txt'] });
    expect(getCalls[0]).toEqual(['vc', 'get', '$/Shop/readme.txt', '/recursive']);
    expect(progressRuns.at(-1)!.options.cancellable).toBe(true);
    expect(recorder.shown).toContain(S.sceGetDone('readme.txt', 2, 0));
    expect(deps.afterGet).toHaveBeenCalled();
  });

  it('looks for conflicts under what it got, once the get is done, even when it failed (phase 5, C1)', async () => {
    let lookedBeforeGet: boolean | undefined;
    const { sce } = setup({}, {
      get: vi.fn(async () => {
        lookedBeforeGet = executed.some((e) => e.id === 'teamExplorer.resolveConflicts');
        return { items: 1, deleted: 0, cancelled: false, failure: 'Conflict readme.txt - Unable to perform the get operation' };
      }),
    });
    await sce.show('$/Shop');
    await createdPanels[0].receive({ type: 'action', action: 'getLatest', paths: ['$/Shop/readme.txt'] });
    expect(lookedBeforeGet).toBe(false);
    expect(executed.filter((e) => e.id === 'teamExplorer.resolveConflicts')).toEqual([
      { id: 'teamExplorer.resolveConflicts', args: [['$/Shop/readme.txt']] },
    ]);
  });

  it('shows the cancelled message when the notification\'s Cancel button is actually pressed (review finding 4)', async () => {
    const { sce } = setup({}, {
      // Hangs until the abort signal fires, so the test controls exactly when
      // the "process" stops -- proving Cancel is wired to the signal `get()`
      // receives, not just to the `cancellable: true` option.
      get: (_args: string[], _onProgress: (n: number) => void, signal: AbortSignal) =>
        new Promise((resolve) => {
          signal.addEventListener('abort', () => resolve({ items: 1, deleted: 0, cancelled: true }), { once: true });
        }),
    });
    await sce.show('$/Shop');
    const action = createdPanels[0].receive({ type: 'action', action: 'getLatest', paths: ['$/Shop/readme.txt'] });
    progressRuns.at(-1)!.cancel();
    await action;
    expect(recorder.shown).toContain(S.sceGetCancelled('readme.txt', 1));
    expect(recorder.shown).not.toContain(S.sceGetDone('readme.txt', 1, 0));
  });

  it('shows a failed Get by its item count, even when failure is an empty string (review finding 4: never `if (r.failure)`)', async () => {
    const { sce: sceA } = setup({}, { get: async () => ({ items: 3, deleted: 0, cancelled: false, failure: 'TF14061: locked' }) });
    await sceA.show('$/Shop');
    await createdPanels[0].receive({ type: 'action', action: 'getLatest', paths: ['$/Shop/readme.txt'] });
    expect(recorder.shown).toContain(S.sceGetFailed('readme.txt', 3, 'TF14061: locked'));
    expect(recorder.shown).not.toContain(S.sceGetDone('readme.txt', 3, 0));

    const { sce: sceB } = setup({}, { get: async () => ({ items: 0, deleted: 0, cancelled: false, failure: '' }) });
    await sceB.show('$/Shop');
    await createdPanels[1].receive({ type: 'action', action: 'getLatest', paths: ['$/Shop/readme.txt'] });
    expect(recorder.shown).toContain(S.sceGetFailed('readme.txt', 0, ''));
    expect(recorder.shown).not.toContain(S.sceGetDone('readme.txt', 0, 0));
  });

  it('gets the open folder from the toolbar (an empty selection)', async () => {
    const { sce, getCalls } = setup();
    await sce.show('$/Shop');
    await createdPanels[0].receive({ type: 'action', action: 'getLatest', paths: [] });
    expect(getCalls[0]).toEqual(['vc', 'get', '$/Shop', '/recursive']);
  });

  it("runs a toolbar action on the folder a navigate just switched to, even with no await between them (media/explorer.js sends them back to back, review finding 1)", async () => {
    const { sce, getCalls } = setup();
    await sce.show('$/Shop');
    const panel = createdPanels[0];
    // $/Shop/Shop2023 is a row of $/Shop's own listing, so `knows()` allows
    // the navigate without a `dir` for it ever having run.
    const a = panel.receive({ type: 'navigate', path: '$/Shop/Shop2023' });
    const b = panel.receive({ type: 'action', action: 'getLatest', paths: [] });
    await Promise.all([a, b]);
    expect(getCalls[0]).toEqual(['vc', 'get', '$/Shop/Shop2023', '/recursive']);
  });

  it('opens the dialog, refuses a bad value, and asks again before either overwrite flag (X3)', async () => {
    const { sce, getCalls } = setup();
    await sce.show('$/Shop');
    const panel = createdPanels[0];
    await panel.receive({ type: 'action', action: 'getSpecific', paths: ['$/Shop/readme.txt'] });
    const rev = lastState(panel).dialog!.rev;
    expect(lastState(panel).dialog!.paths).toEqual(['$/Shop/readme.txt']);

    await panel.receive({ type: 'submitDialog', request: { kind: 'changeset', value: 'abc', overwriteWritable: false, getAll: false } });
    expect(lastState(panel).dialog!.error).toBe(S.gsvBadChangeset);
    expect(lastState(panel).dialog!.rev).toBeGreaterThan(rev);
    expect(getCalls).toEqual([]);

    const overwrite = { kind: 'changeset', value: '16730', overwriteWritable: true, getAll: false };
    recorder.answers.push(undefined);
    await panel.receive({ type: 'submitDialog', request: overwrite });
    expect(recorder.messages.at(-1)!.modal).toBe(true);
    expect(recorder.messages.at(-1)!.message).toContain(S.sceOverwriteWritableDetail);
    expect(getCalls).toEqual([]);
    expect(lastState(panel).dialog).toBeDefined();

    recorder.answers.push(S.sceOverwriteYes);
    await panel.receive({ type: 'submitDialog', request: overwrite });
    expect(getCalls[0]).toEqual(['vc', 'get', '$/Shop/readme.txt', '/version:C16730', '/overwrite']);
    expect(lastState(panel).dialog).toBeUndefined();

    // The OTHER overwrite flag (review finding 4): getAll asks too, with its
    // own detail, and the confirm shows before anything runs.
    await panel.receive({ type: 'action', action: 'getSpecific', paths: ['$/Shop/readme.txt'] });
    const getAll = { kind: 'changeset', value: '16730', overwriteWritable: false, getAll: true };
    recorder.answers.push(undefined);
    await panel.receive({ type: 'submitDialog', request: getAll });
    expect(recorder.messages.at(-1)!.modal).toBe(true);
    expect(recorder.messages.at(-1)!.message).toContain(S.sceOverwriteAllDetail);
    expect(getCalls).toHaveLength(1);
    expect(lastState(panel).dialog).toBeDefined();

    recorder.answers.push(S.sceOverwriteYes);
    await panel.receive({ type: 'submitDialog', request: getAll });
    expect(getCalls[1]).toEqual(['vc', 'get', '$/Shop/readme.txt', '/version:C16730', '/all']);
    expect(lastState(panel).dialog).toBeUndefined();
  });

  it('runs a plain Get Specific Version with no second question', async () => {
    const { sce, getCalls } = setup();
    await sce.show('$/Shop');
    const panel = createdPanels[0];
    await panel.receive({ type: 'action', action: 'getSpecific', paths: ['$/Shop/Shop2023'] });
    await panel.receive({ type: 'submitDialog', request: { kind: 'date', value: '2026-01-01', overwriteWritable: false, getAll: false } });
    expect(recorder.messages.filter((m) => m.modal)).toEqual([]);
    expect(getCalls[0]).toEqual(['vc', 'get', '$/Shop/Shop2023', '/version:D2026-01-01T00:00', '/recursive']);
  });

  it("fills the changeset from the item's history, keeping the ticked boxes", async () => {
    const { sce } = setup();
    await sce.show('$/Shop');
    const panel = createdPanels[0];
    await panel.receive({ type: 'action', action: 'getSpecific', paths: ['$/Shop/readme.txt'] });
    quickPickAnswers.push((items: { id: number }[]) => items[0]);
    await panel.receive({ type: 'pickChangeset', request: { kind: 'date', value: '', overwriteWritable: true, getAll: false } });
    expect(quickPicks[0].items).toHaveLength(1);
    expect(lastState(panel).dialog!.request).toEqual({ kind: 'changeset', value: '16730', overwriteWritable: true, getAll: false });
  });

  it('maps an unmapped folder through part 1, then reloads', async () => {
    const { sce, deps } = setup();
    await sce.show('$/');
    await createdPanels[0].receive({ type: 'action', action: 'map', paths: ['$/Other'] });
    expect(deps.mapServerFolder).toHaveBeenCalledWith('$/Other');
  });

  it('opens History, View and the local file through the existing commands', async () => {
    const { sce, deps } = setup();
    await sce.show('$/Shop');
    const panel = createdPanels[0];
    await panel.receive({ type: 'action', action: 'history', paths: ['$/Shop/Shop2023'] });
    expect(deps.showHistory).toHaveBeenCalledWith({ mode: 'folder', serverPath: '$/Shop/Shop2023', name: 'Shop2023' });
    await panel.receive({ type: 'action', action: 'view', paths: ['$/Shop/readme.txt'] });
    expect(executed.find((e) => e.id === 'teamExplorer.viewVersion')!.args).toEqual(['$/Shop/readme.txt', 6]);
    await panel.receive({ type: 'action', action: 'open', paths: ['$/Shop/Shop2023'] });
    expect(lastState(panel).path).toBe('$/Shop/Shop2023');
  });

  it('adds the picked files that are not in source control, through Phase 1 Add', async () => {
    const { sce } = setup();
    await sce.show('$/Shop');
    quickPickAnswers.push((items: unknown[]) => items);
    await createdPanels[0].receive({ type: 'action', action: 'addItems', paths: ['$/Shop/Shop2023'] });
    const add = executed.find((e) => e.id === 'teamExplorer.add')!;
    expect((add.args[1] as Uri[]).map((u) => u.fsPath)).toEqual(['C:\\work\\Shop\\Shop2023\\new.txt']);
  });

  it('copies the server paths', async () => {
    const { sce } = setup();
    await sce.show('$/Shop');
    await createdPanels[0].receive({ type: 'action', action: 'copyPath', paths: ['$/Shop/Shop2023', '$/Shop/readme.txt'] });
    expect(clipboard.text).toBe('$/Shop/Shop2023\n$/Shop/readme.txt');
    expect(recorder.shown).toContain(S.sceCopied(2));
  });

  it('sends Rename to the command with the local path and the folder names (phase 3 part 3)', async () => {
    const { sce } = setup();
    await sce.show('$/Shop');
    const panel = createdPanels[0];
    await panel.receive({ type: 'ready' });
    await panel.receive({ type: 'action', action: 'rename', paths: [FILE] });
    const call = executed.find((e) => e.id === 'teamExplorer.renameItem');
    expect(call, 'renameItem was not invoked').toBeDefined();
    // The LOCAL path, never the server path (FILE itself) -- tf needs the
    // local copy to move it (R13), and a wrong-but-still-string argument
    // (e.g. the server path) would pass a looser `typeof === 'string'` check.
    expect(call!.args[0]).toBe('C:\\work\\Shop\\readme.txt');
    expect(call!.args[1]).toEqual(['Shop2023', 'readme.txt']);
  });

  it('refuses Rename and Delete for the folder being browsed, which is what `paths: []` means', async () => {
    const { sce } = setup();
    await sce.show('$/Shop');
    const panel = createdPanels[0];
    await panel.receive({ type: 'ready' });
    await panel.receive({ type: 'action', action: 'delete', paths: [] });
    await panel.receive({ type: 'action', action: 'rename', paths: [] });
    expect(executed.find((e) => e.id === 'teamExplorer.deleteItems')).toBeUndefined();
    expect(executed.find((e) => e.id === 'teamExplorer.renameItem')).toBeUndefined();
  });

  it('sends Delete to the command as server paths (phase 3 part 3)', async () => {
    const { sce } = setup();
    await sce.show('$/Shop');
    const panel = createdPanels[0];
    await panel.receive({ type: 'ready' });
    await panel.receive({ type: 'action', action: 'delete', paths: [FILE] });
    const call = executed.find((e) => e.id === 'teamExplorer.deleteItems');
    expect(call, 'deleteItems was not invoked').toBeDefined();
    const arg = call!.args[0] as { paths: string[]; names: string[]; hasFolder: boolean };
    expect(arg.paths).toEqual([FILE]);
    expect(arg.names).toEqual(['readme.txt']);
    expect(arg.hasFolder).toBe(false);
  });
});

describe('SourceControlExplorer: staleness and disposal (review finding 4)', () => {
  it("drops a slow details() for the folder navigated away from, so it never overwrites what's now shown", async () => {
    type Details = { info: { ok: true; value: InfoItem[] }; status: { ok: true; value: [] } };
    let resolveShopDetails!: (v: Details) => void;
    const details = vi.fn((path: string): Promise<Details> => {
      if (path === '$/Shop') return new Promise<Details>((resolve) => { resolveShopDetails = resolve; });
      return Promise.resolve({ info: { ok: true as const, value: INFO[path] ?? [] }, status: { ok: true as const, value: [] } });
    });
    const { sce } = setup({}, { details });
    await sce.show('$/'); // completes fully -- workspaces are loaded, so the
    // next navigate below needs only one `list()` await before it reaches
    // the (hung) `details()` call.
    const panel = createdPanels[0];
    const navShop = panel.receive({ type: 'navigate', path: '$/Shop' });
    await Promise.resolve();
    await Promise.resolve();
    await panel.receive({ type: 'navigate', path: '$/Other' }); // a real, fully-resolving folder
    resolveShopDetails({ info: { ok: true, value: INFO['$/Shop'] }, status: { ok: true, value: [] } });
    await navShop;
    expect(lastState(panel).path).toBe('$/Other');
    expect(lastState(panel).rows.map((r) => r.name)).toEqual(['Sub']);
    expect(lastState(panel).infoState).toBe('ok');
  });

  it('finishes a Get after the panel is disposed without throwing (the mock postMessage throws after dispose)', async () => {
    let resolveGet!: (v: { items: number; deleted: number; cancelled: boolean }) => void;
    const { sce } = setup({}, { get: () => new Promise((resolve) => { resolveGet = resolve; }) });
    await sce.show('$/Shop');
    const panel = createdPanels[0];
    const action = panel.receive({ type: 'action', action: 'getLatest', paths: ['$/Shop/readme.txt'] });
    panel.dispose();
    resolveGet({ items: 1, deleted: 0, cancelled: false });
    await expect(action).resolves.toBeUndefined();
  });
});

describe('SourceControlExplorer: a folder the server has nothing in', () => {
  it('still asks status, so a file you added there shows', async () => {
    // The empty-listing shortcut skipped status along with info, so a pending
    // Add in a folder that is empty on the server never appeared.
    const add = {
      serverItem: '$/Shop/Empty/New.vb', localPath: 'C:\\work\\Shop\\Empty\\New.vb', changes: new Set(['Add', 'Edit', 'Encoding']),
      changeFlags: 7, itemType: 'File', encoding: 65001, itemId: -5, date: '2026-10-02T08:42:59+02:00',
      owner: 'Filip', computer: 'DEVPC', workspace: 'DEVPC',
    };
    const status = vi.fn(async () => ({ ok: true as const, value: [add] }));
    const details = vi.fn();
    const { sce } = setup({}, {
      list: vi.fn(async (path: string) => ({ ok: true as const, value: { path, folders: [], files: [] } })),
      status: status as never,
      details: details as never,
    });
    await sce.show('$/Shop/Empty');
    const s = lastState(createdPanels[0]);
    expect(details).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith('$/Shop/Empty');
    expect(s.rows.map((r) => [r.name, r.pending, r.added])).toEqual([['New.vb', 'add', true]]);
    expect(s.statusState).toBe('ok');
    expect(s.infoState).toBe('ok');
  });
});

describe('SourceControlExplorer: a folder you added', () => {
  // Measured on DEVPC with a real pending Add folder: `dir` on it answers
  // "No items match" (exit 1), while `status <folder>/*` lists its contents,
  // files and subfolders alike.
  const mine = (serverItem: string, itemType: 'File' | 'Folder') => ({
    serverItem, localPath: 'C:\\work\\' + serverItem.slice(2).split('/').join('\\'), itemType,
    changes: new Set(itemType === 'File' ? ['Add', 'Edit', 'Encoding'] : ['Add', 'Encoding']), changeFlags: itemType === 'File' ? 7 : 5,
    encoding: itemType === 'File' ? 65001 : -3, itemId: -1, date: '2026-10-02T09:34:01+02:00', owner: 'Filip', computer: 'DEVPC', workspace: 'DEVPC',
  });
  const STATUS: Record<string, ReturnType<typeof mine>[]> = {
    '$/Shop': [mine('$/Shop/New', 'Folder')],
    '$/Shop/New': [mine('$/Shop/New/a.vb', 'File'), mine('$/Shop/New/Sub', 'Folder')],
  };
  const status = () => vi.fn(async (path: string) => ({ ok: true as const, value: STATUS[path] ?? [] }));
  const details = (path: string) => ({ info: { ok: true as const, value: INFO[path] ?? [] }, status: { ok: true as const, value: STATUS[path] ?? [] } });

  it('opens one the workspace knows, when dir cannot list it, from status', async () => {
    // `dir` is still asked first: once the folder is checked in it lists, and
    // no stale knowledge of an Add can hide what the server has.
    const s = status();
    const { sce, explorer } = setup({ pendingChanges: () => [mine('$/Shop/New', 'Folder'), mine('$/Shop/New/Sub', 'Folder')] as never }, { status: s as never });
    await sce.show('$/Shop/New');
    const state = lastState(createdPanels[0]);
    expect(explorer.list).toHaveBeenCalledWith('$/Shop/New', true);
    expect(state.listState).toBe('ok');
    expect(state.rows.map((r) => [r.name, r.isFolder, r.added])).toEqual([['Sub', true, true], ['a.vb', false, true]]);
    // The toolbar acts on the folder itself, which the server does not have either.
    expect(state.folderAllowed).not.toContain('getLatest');
    expect(state.folderAllowed).not.toContain('history');
    expect(state.folderAllowed).toContain('undo');
    // In the tree, under its parent, marked; and open, not stuck loading.
    const tree = state.tree.map((t) => [t.path, t.added ?? false, t.loading]);
    expect(tree).toContainEqual(['$/Shop/New', true, false]);
    expect(tree).toContainEqual(['$/Shop/New/Sub', true, false]);
    expect(tree).toContainEqual(['$/Shop/Shop2023', false, false]);
  });

  it('opens one only a listing showed as added, falling back when dir cannot list it', async () => {
    // Outside the opened folder the workspace's pending changes do not reach;
    // the parent's status is what said it was yours.
    const { sce, panel } = await (async () => {
      const r = setup({}, { status: status() as never, details: vi.fn(async (p: string) => details(p)) as never });
      await r.sce.show('$/Shop');
      return { sce: r.sce, panel: createdPanels[0] };
    })();
    expect(lastState(panel).rows.find((r) => r.name === 'New')).toMatchObject({ isFolder: true, added: true });
    await sce.show('$/Shop/New');
    const state = lastState(panel);
    expect(state.listState).toBe('ok');
    expect(state.rows.map((r) => r.name)).toEqual(['Sub', 'a.vb']);
  });

  it('shows a new folder that only a file you added implies, since tf pends no Add for it', async () => {
    // Measured on DEVPC: adding test\test1.txt pended an Add for the file
    // alone; `info` and `dir` on `$/Shop/test` both say "No items
    // match", and `status <parent>/*` does not reach a grandchild.
    const file = mine('$/Shop/test/test1.txt', 'File');
    const STATUS2: Record<string, ReturnType<typeof mine>[]> = { '$/Shop/test': [file] };
    const { sce } = setup(
      { pendingChanges: () => [file] as never },
      { status: vi.fn(async (p: string) => ({ ok: true as const, value: STATUS2[p] ?? [] })) as never },
    );
    await sce.show('$/Shop');
    const panel = createdPanels[0];
    let state = lastState(panel);
    // As Visual Studio shows it: +, Latest Yes, and no Pending Change or User,
    // since the folder has no change of its own.
    expect(state.rows.map((r) => [r.name, r.isFolder, r.added, r.pending, r.users, r.latest])).toEqual([
      ['Shop2023', true, undefined, '', [], 'yes'],
      ['test', true, true, '', [], 'yes'],
      ['readme.txt', false, undefined, '', [], 'no'],
    ]);
    expect(state.tree.map((t) => [t.path, t.added ?? false])).toContainEqual(['$/Shop/test', true]);

    await sce.show('$/Shop/test');
    state = lastState(panel);
    expect(state.listState).toBe('ok');
    expect(state.rows.map((r) => [r.name, r.added])).toEqual([['test1.txt', true]]);
    expect(state.folderAllowed).not.toContain('getLatest');
  });

  it('marks no folder the server has, though a file you added lies under it', async () => {
    const { sce } = setup({ pendingChanges: () => [mine('$/Shop/Shop2023/x.vb', 'File')] as never });
    await sce.show('$/Shop');
    const state = lastState(createdPanels[0]);
    expect(state.rows.map((r) => r.name)).toEqual(['Shop2023', 'readme.txt']);
    expect(state.rows.some((r) => r.added)).toBe(false);
    expect(state.tree.some((t) => t.added)).toBe(false);
  });

  it('still reports a folder that is neither listed nor yours', async () => {
    const { sce } = setup({ pendingChanges: () => [] }, { status: status() as never });
    await sce.show('$/Shop/Gone');
    expect(lastState(createdPanels[0]).listState).toBe('failed');
  });
});
