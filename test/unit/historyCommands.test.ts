import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerHistory, versionDocument } from '../../src/commands/history.js';
import { VersionStore } from '../../src/history/VersionStore.js';
import { PathMapper, type Platform } from '../../src/tf/PathMapper.js';
import { ServerContentProvider } from '../../src/ui/ServerContentProvider.js';
import type { ChangeFlag } from '../../src/tf/types.js';
import { ENC_BINARY } from '../../src/tf/types.js';
import type { Changeset } from '../../src/tf/parseHistory.js';
import { recorder, outputChannel, createdPanels, executed, shown, progressRuns, Uri } from '../vscode-mock.js';
import { S } from '../../src/tf/strings.js';
import { isReadOnly } from '../../src/watch/readOnly.js';

// SYNTHETIC history for $/T/a.vb: an edit on top of the add.
const HISTORY: Changeset[] = [
  { id: 7, user: 'A', date: 'd7', comment: 'edit', items: [{ change: ['edit'], serverPath: '$/T/a.vb' }] },
  { id: 5, user: 'A', date: 'd5', comment: 'add', items: [{ change: ['add'], serverPath: '$/T/a.vb' }] },
];

let dir: string;
let file: string;

function harness(
  opts: {
    pending?: ChangeFlag[];
    local?: 'readonly' | 'writable' | 'missing';
    /**
     * D16a, the reviewers' scenario 1: a pending rename ELSEWHERE has already
     * moved the file to this new name. `changeFor`/`changeForLocal` are
     * indexed by the item's NEW identity, the way TfvcService really builds
     * them, so a tab still open on the old `$/T/a.vb` finds nothing under
     * that old name -- only the vanished old local file gives it away.
     */
    renamedTo?: string;
    refreshFails?: boolean;
    /** Overrides the fixed `refreshFails` reply, to control WHEN it resolves. */
    refresh?: () => Promise<{ kind: string; originalMessage: string } | undefined>;
    alsoRefresh?: () => void;
    /** No working folder covers `$/T` at all -- `toLocalPath` finds nothing. */
    unmapped?: boolean;
    /**
     * The opened workspace folder `service.workspaceRoot` reports (D18i).
     * Defaults to `dir`, the same folder the PathMapper mapping resolves
     * local paths under, so existing scenarios are unaffected; a test for the
     * outside-folder refusal points it somewhere that does NOT cover `dir`.
     */
    workspaceRoot?: string;
    /** Fakes VersionStore for View This Version (D25); defaults to a text version. */
    versions?: {
      bytesAt: (...a: never[]) => Promise<{ bytes: Buffer; codePage: number | undefined }>;
      codePageAt: (...a: never[]) => Promise<number | undefined>;
    };
    /** Passed through as HistoryDeps.tempDir (D25). */
    tempDir?: string;
  } = {},
) {
  // A temp folder stands in for the workspace mapping: never C:/work.
  const winePath = process.platform === 'win32' ? dir : 'Z:' + dir.split('/').join('\\');
  const mapper = new PathMapper(
    opts.unmapped ? [] : [{ serverItem: '$/T', localPath: winePath }],
    process.platform === 'win32' ? 'win32' : 'linux',
  );
  if (opts.renamedTo) {
    // tf itself renames the file on disk; the OLD local path this tab still
    // knows about (`file`) is left behind, gone.
    writeFileSync(join(dir, opts.renamedTo), 'x');
  } else if (opts.local !== 'missing') {
    writeFileSync(file, 'x');
    if (opts.local !== 'writable') chmodSync(file, 0o444);
  }
  const runs: string[][] = [];
  const client = {
    timeoutMs: 1000,
    run: async (args: string[]) => {
      runs.push(args);
      return { stdout: Buffer.from(''), stderr: Buffer.alloc(0), exitCode: 0, timedOut: false };
    },
  };
  const pending = opts.renamedTo
    ? [{ serverItem: '$/T/' + opts.renamedTo, localPath: mapper.toWinePath(join(dir, opts.renamedTo)), changes: new Set<ChangeFlag>(['Rename']),
         changeFlags: 0, itemType: 'File' as const, encoding: 65001, itemId: 1, date: '' }]
    : opts.pending
    ? [{ serverItem: '$/T/a.vb', localPath: mapper.toWinePath(file), changes: new Set(opts.pending), changeFlags: 0,
         itemType: 'File' as const, encoding: 65001, itemId: 1, date: '' }]
    : [];
  const service = {
    pathMapper: mapper,
    pendingChanges: pending,
    changeFor: (p: string) => pending.find((c) => c.serverItem.toLowerCase() === p.toLowerCase()),
    // Indexed by local path exactly as TfvcService.changeForLocal is: under a
    // pending rename that is the item's NEW local path, not the old one this
    // tab still knows about.
    changeForLocal: (p: string) => pending.find((c) => mapper.fromWinePath(c.localPath).toLowerCase() === p.toLowerCase()),
    requestRefresh() {},
    refresh:
      opts.refresh ??
      (async () => (opts.refreshFails ? { kind: 'timeout' as const, originalMessage: 'status timed out' } : undefined)),
    workspaceRoot: opts.workspaceRoot ?? dir,
    platform: (process.platform === 'win32' ? 'win32' : 'linux') as Platform,
  };
  const pageCalls: unknown[] = [];
  const history = {
    page: async (target: unknown) => {
      pageCalls.push(target);
      return { changesets: HISTORY, more: false };
    },
    changeset: async (id: number) => HISTORY.find((c) => c.id === id)!,
  };
  // D25: View This Version. Defaults to a plain text version, so every
  // scenario above (none of which cares about View) is unaffected.
  const versions =
    opts.versions ??
    {
      bytesAt: async () => ({ bytes: Buffer.from('text'), codePage: 65001 }),
      codePageAt: async () => 65001,
    };
  const context = { subscriptions: [] as { dispose(): void }[], extensionUri: Uri.file('/ext') };
  const views = registerHistory(context as never, {
    client: client as never,
    service: service as never,
    output: outputChannel as never,
    history: history as never,
    alsoRefresh: opts.alsoRefresh,
    versions: versions as never,
    tempDir: opts.tempDir,
  });
  return { runs, pageCalls, views, context };
}

beforeEach(() => {
  recorder.reset();
  dir = mkdtempSync(join(tmpdir(), 'tfvc-history-'));
  file = join(dir, 'a.vb');
});

afterEach(() => {
  try {
    chmodSync(file, 0o644);
  } catch {
    // no file was created
  }
  rmSync(dir, { recursive: true, force: true });
});

const openFileHistory = async (h: ReturnType<typeof harness>) => {
  await h.views.show({ mode: 'file', serverPath: '$/T/a.vb', name: 'a.vb' });
  return createdPanels[createdPanels.length - 1];
};

describe('Get This Version (D1)', () => {
  it('refuses a file with a pending change, without running tf', async () => {
    const h = harness({ pending: ['Edit'] });
    await (await openFileHistory(h)).receive({ type: 'getVersion', id: 5 });
    expect(recorder.shown).toContain(S.getVersionPending('a.vb'));
    expect(h.runs).toEqual([]);
  });

  it('refuses a writable file: tf would overwrite edits TFVC cannot see', async () => {
    const h = harness({ local: 'writable' });
    await (await openFileHistory(h)).receive({ type: 'getVersion', id: 5 });
    expect(recorder.shown).toContain(S.getVersionWritable('a.vb'));
    expect(h.runs).toEqual([]);
  });

  it('asks first, modally, and does nothing unless the answer is yes', async () => {
    const h = harness();
    recorder.answers.push(undefined);
    await (await openFileHistory(h)).receive({ type: 'getVersion', id: 5 });
    const ask = recorder.messages.find((m) => m.modal);
    expect(ask?.message).toBe(`${S.getVersionConfirmTitle('a.vb', 5)}\n${S.getVersionConfirmDetail}`);
    expect(ask?.items).toEqual([S.getVersionConfirmYes]);
    expect(h.runs).toEqual([]);
  });

  it('runs exactly get <server path> /version:C<n> once confirmed', async () => {
    const h = harness();
    recorder.answers.push(S.getVersionConfirmYes);
    await (await openFileHistory(h)).receive({ type: 'getVersion', id: 5 });
    expect(h.runs).toEqual([['vc', 'get', '$/T/a.vb', '/version:C5']]);
  });

  // D16a: a tab left open across a rename now refuses instead of running
  // `get $/T/a.vb`, which used to leave a version conflict in Pending Changes.
  // The local file TFVC actually moved is what gives both scenarios away.
  it("refuses when the file is simply gone, no pending change involved (reviewers' scenario 2: rename checked in elsewhere)", async () => {
    const h = harness({ local: 'missing' });
    recorder.answers.push(S.getVersionConfirmYes);
    await (await openFileHistory(h)).receive({ type: 'getVersion', id: 7 });
    expect(recorder.shown).toContain(S.getVersionMissing('a.vb'));
    expect(h.runs).toEqual([]);
  });

  it("refuses when a pending rename elsewhere has moved the file (reviewers' scenario 1)", async () => {
    const h = harness({ renamedTo: 'b.vb' });
    recorder.answers.push(S.getVersionConfirmYes);
    await (await openFileHistory(h)).receive({ type: 'getVersion', id: 7 });
    expect(recorder.shown).toContain(S.getVersionMissing('a.vb'));
    expect(h.runs).toEqual([]);
  });

  it('refuses when status cannot be read, without asking or running tf', async () => {
    const h = harness({ refreshFails: true });
    recorder.answers.push(S.getVersionConfirmYes);
    await (await openFileHistory(h)).receive({ type: 'getVersion', id: 5 });
    expect(recorder.shown).toContain(S.getVersionStatusUnknown('a.vb'));
    expect(recorder.messages.some((m) => m.modal)).toBe(false);
    expect(h.runs).toEqual([]);
  });

  it('awaits refresh() before the confirm: no confirm and no run while status is still unknown', async () => {
    let resolveRefresh!: () => void;
    const gate = new Promise<undefined>((r) => {
      resolveRefresh = () => r(undefined);
    });
    const h = harness({ refresh: () => gate });
    recorder.answers.push(S.getVersionConfirmYes);
    const panel = await openFileHistory(h);
    const received = panel.receive({ type: 'getVersion', id: 5 });
    // Let the microtask queue settle up to (and including) `await service.refresh()`.
    await Promise.resolve();
    await Promise.resolve();
    expect(recorder.messages.some((m) => m.modal)).toBe(false);
    expect(h.runs).toEqual([]);
    resolveRefresh();
    await received;
    expect(h.runs).toEqual([['vc', 'get', '$/T/a.vb', '/version:C5']]);
  });

  it('runs the status refresh (alsoRefresh) after a successful Get, as Get Latest does', async () => {
    const rescans: number[] = [];
    const h = harness({ alsoRefresh: () => rescans.push(1) });
    recorder.answers.push(S.getVersionConfirmYes);
    await (await openFileHistory(h)).receive({ type: 'getVersion', id: 5 });
    expect(h.runs).toEqual([['vc', 'get', '$/T/a.vb', '/version:C5']]);
    expect(rescans).toEqual([1]);
  });

  it('shows a window progress message while re-checking pending changes (D18g)', async () => {
    const h = harness();
    recorder.answers.push(S.getVersionConfirmYes);
    await (await openFileHistory(h)).receive({ type: 'getVersion', id: 5 });
    expect(progressRuns.some((r) => r.options.title === S.getVersionChecking('a.vb'))).toBe(true);
  });

  it('ignores a second Get This Version click while one is still running for this panel (D18g)', async () => {
    let resolveRefresh!: () => void;
    const gate = new Promise<undefined>((r) => {
      resolveRefresh = () => r(undefined);
    });
    const h = harness({ refresh: () => gate });
    recorder.answers.push(S.getVersionConfirmYes);
    const panel = await openFileHistory(h);
    const first = panel.receive({ type: 'getVersion', id: 5 });
    await Promise.resolve();
    await Promise.resolve();
    await panel.receive({ type: 'getVersion', id: 5 }); // arrives while the first is still awaiting refresh()
    resolveRefresh();
    await first;
    // Exactly one confirm dialog and one `vc get`, not two.
    expect(recorder.messages.filter((m) => m.modal)).toHaveLength(1);
    expect(h.runs).toEqual([['vc', 'get', '$/T/a.vb', '/version:C5']]);
  });

  it('refuses a file outside the opened workspace folder, before the pending-change check (D18i)', async () => {
    // The opened folder covers only a SUBFOLDER of where the mapping (and the
    // file) actually live -- vc status above never scanned dir/a.vb, so a
    // pending lock or merge there would be invisible to that cache.
    const h = harness({ workspaceRoot: join(dir, 'sub'), pending: ['Edit'] });
    await (await openFileHistory(h)).receive({ type: 'getVersion', id: 5 });
    expect(recorder.shown).toContain(S.getVersionOutsideFolder('a.vb'));
    expect(recorder.shown).not.toContain(S.getVersionPending('a.vb'));
    expect(recorder.messages.some((m) => m.modal)).toBe(false);
    expect(h.runs).toEqual([]);
  });

  it('refuses an unmapped path without asking or running tf', async () => {
    // No working folder covers `$/T`, so `pathMapper.toLocalPath` finds
    // nothing even though the row itself matches the tab's own item.
    const h = harness({ unmapped: true });
    await h.views.show({ mode: 'file', serverPath: '$/T/a.vb', name: 'a.vb' });
    const panel = createdPanels[createdPanels.length - 1];
    recorder.answers.push(S.getVersionConfirmYes);
    await panel.receive({ type: 'getVersion', id: 5 });
    expect(recorder.shown).toContain(S.noWorkspaceMapping);
    expect(recorder.messages.some((m) => m.modal)).toBe(false);
    expect(h.runs).toEqual([]);
  });

  it('allows a normal file plainly inside the opened folder, and refuses one under a wholly unmapped, unrelated root (D20f)', async () => {
    // "Inside" is exercised by every other test above (default workspaceRoot
    // = dir); this pins the other half -- a workspaceRoot that shares no
    // mapping at all with the file's own server path.
    const h = harness({ workspaceRoot: mkdtempSync(join(tmpdir(), 'tfvc-elsewhere-')) });
    recorder.answers.push(S.getVersionConfirmYes);
    await (await openFileHistory(h)).receive({ type: 'getVersion', id: 5 });
    expect(recorder.shown).toContain(S.getVersionOutsideFolder('a.vb'));
    expect(h.runs).toEqual([]);
  });

  it("D20f: compares SERVER paths, not local ones -- a nested mapping's local folder does not fool it (R6)", async () => {
    // $/Lib is mapped to a LOCAL folder physically nested inside $/Proj's own
    // local folder (a second working folder can do this), but it is a wholly
    // different, unrelated server subtree: `vc status $/Proj /recursive`
    // never scans it. The OLD local-path containment check said "inside".
    const projLocal = mkdtempSync(join(tmpdir(), 'tfvc-proj-'));
    const libLocal = join(projLocal, 'lib');
    mkdirSync(libLocal);
    const libFile = join(libLocal, 'x.cs');
    writeFileSync(libFile, 'x');
    chmodSync(libFile, 0o444); // checked out for edit read-only, like every other passing scenario here
    const mapper = new PathMapper(
      [
        { serverItem: '$/Proj', localPath: process.platform === 'win32' ? projLocal : 'Z:' + projLocal.split('/').join('\\') },
        { serverItem: '$/Lib', localPath: process.platform === 'win32' ? libLocal : 'Z:' + libLocal.split('/').join('\\') },
      ] as never,
      process.platform === 'win32' ? 'win32' : 'linux',
    );
    const runs: string[][] = [];
    const client = {
      timeoutMs: 1000,
      run: async (args: string[]) => {
        runs.push(args);
        return { stdout: Buffer.from(''), stderr: Buffer.alloc(0), exitCode: 0, timedOut: false };
      },
    };
    const service = {
      pathMapper: mapper,
      pendingChanges: [],
      changeFor: () => undefined,
      changeForLocal: () => undefined,
      requestRefresh() {},
      refresh: async () => undefined,
      workspaceRoot: projLocal, // the OPENED folder is $/Proj's local folder
      platform: (process.platform === 'win32' ? 'win32' : 'linux') as Platform,
    };
    const libHistory: Changeset[] = [{ id: 9, user: 'A', date: 'd9', comment: 'add', items: [{ change: ['add'], serverPath: '$/Lib/x.cs' }] }];
    const history = {
      page: async () => ({ changesets: libHistory, more: false }),
      changeset: async (id: number) => libHistory.find((c) => c.id === id)!,
    };
    const context = { subscriptions: [] as { dispose(): void }[], extensionUri: Uri.file('/ext') };
    const views = registerHistory(context as never, {
      client: client as never,
      service: service as never,
      output: outputChannel as never,
      history: history as never,
      versions: { bytesAt: async () => ({ bytes: Buffer.alloc(0), codePage: 65001 }), codePageAt: async () => 65001 } as never,
    });
    await views.show({ mode: 'file', serverPath: '$/Lib/x.cs', name: 'x.cs' });
    const panel = createdPanels[createdPanels.length - 1];
    recorder.answers.push(S.getVersionConfirmYes);
    await panel.receive({ type: 'getVersion', id: 9 });
    expect(recorder.shown).toContain(S.getVersionOutsideFolder('x.cs'));
    expect(runs).toEqual([]);
    try {
      chmodSync(libFile, 0o644);
    } finally {
      rmSync(projLocal, { recursive: true, force: true });
    }
  });
});

describe('View History', () => {
  it('refuses a pending Add', async () => {
    const h = harness({ pending: ['Add'] });
    await recorder.invoke('teamExplorer.viewHistory', Uri.file(file));
    expect(recorder.shown).toContain(S.historyPendingAdd('a.vb'));
    expect(createdPanels).toHaveLength(0);
    expect(h.pageCalls).toEqual([]);
  });

  it('refuses a pending rename', async () => {
    harness({ pending: ['Rename'] });
    await recorder.invoke('teamExplorer.viewHistory', Uri.file(file));
    expect(recorder.shown).toContain(S.historyPendingRename('a.vb'));
  });

  it('refuses a pending SourceRename exactly like a pending Rename (D16h)', async () => {
    harness({ pending: ['SourceRename'] });
    await recorder.invoke('teamExplorer.viewHistory', Uri.file(file));
    expect(recorder.shown).toContain(S.historyPendingRename('a.vb'));
  });

  it('says so for a path outside the workspace', async () => {
    harness();
    await recorder.invoke('teamExplorer.viewHistory', Uri.file(join(tmpdir(), 'elsewhere.vb')));
    expect(recorder.shown).toContain(S.noWorkspaceMapping);
  });

  it('opens a file history for a file and a folder history for a folder', async () => {
    const h = harness();
    await recorder.invoke('teamExplorer.viewHistory', Uri.file(file));
    mkdirSync(join(dir, 'sub'));
    await recorder.invoke('teamExplorer.viewHistory', Uri.file(join(dir, 'sub')));
    expect(h.pageCalls).toEqual([
      { mode: 'file', itemspec: '$/T/a.vb' },
      { mode: 'folder', itemspec: '$/T/sub' },
    ]);
  });
});

describe('the hover commands (D7, tightened by D16g)', () => {
  it('showChangeset opens the file history with that changeset selected, and ignores bad arguments', async () => {
    harness();
    await recorder.invoke('teamExplorer.showChangeset', '$/T/a.vb', '5');
    await recorder.invoke('teamExplorer.showChangeset', 42, 5);
    await recorder.invoke('teamExplorer.showChangeset', 'C:\\work\\a.vb', 5);
    expect(createdPanels).toHaveLength(0);
    await recorder.invoke('teamExplorer.showChangeset', '$/T/a.vb', 5);
    expect(createdPanels).toHaveLength(1);
    const states = createdPanels[0].webview.posted as { state: { selected?: number } }[];
    expect(states[states.length - 1].state.selected).toBe(5);
  });

  // D16g: showChangeset/compareVersions are held to D14's own rules for a
  // versioned URI (ServerContentProvider.parseVersionUri) -- the wildcard, the
  // int32 cap, and the exponential notation VS Code's own arg decoding could
  // hand a command are exactly the shapes that check exists to catch.
  it('showChangeset ignores a wildcard path, a changeset above int32, a non-digit number, and a non-string id (D16g)', async () => {
    harness();
    await recorder.invoke('teamExplorer.showChangeset', '$/Shop/*', 5);
    await recorder.invoke('teamExplorer.showChangeset', '$/T/a.vb', 2147483648);
    await recorder.invoke('teamExplorer.showChangeset', '$/T/a.vb', 1e21);
    await recorder.invoke('teamExplorer.showChangeset', '$/T/a.vb', '5');
    expect(createdPanels).toHaveLength(0);
  });

  it('compareVersions opens the native diff between two versioned URIs, and ignores bad arguments', async () => {
    harness();
    await recorder.invoke('teamExplorer.compareVersions', '$/T/a.vb', 5, '$/T/a.vb', '7');
    expect(executed.filter((e) => e.id === 'vscode.diff')).toEqual([]);
    await recorder.invoke('teamExplorer.compareVersions', '$/T/a.vb', 5, '$/T/a.vb', 7);
    const diff = executed.find((e) => e.id === 'vscode.diff')!;
    expect(diff.args[0]).toEqual(ServerContentProvider.versionUri('$/T/a.vb', 5));
    expect(diff.args[1]).toEqual(ServerContentProvider.versionUri('$/T/a.vb', 7));
    expect(diff.args[2]).toBe(S.compareVersionsTitle('a.vb', 5, 7));
  });

  it('compareVersions applies the same D14 rules to either side (D16g)', async () => {
    harness();
    await recorder.invoke('teamExplorer.compareVersions', '$/Shop/*', 5, '$/T/a.vb', 7);
    await recorder.invoke('teamExplorer.compareVersions', '$/T/a.vb', 5, '$/Shop/*', 7);
    await recorder.invoke('teamExplorer.compareVersions', '$/T/a.vb', 2147483648, '$/T/a.vb', 7);
    await recorder.invoke('teamExplorer.compareVersions', '$/T/a.vb', 5, '$/T/a.vb', 1e21);
    expect(executed.filter((e) => e.id === 'vscode.diff')).toEqual([]);
  });

  it('View This Version opens the versioned URI', async () => {
    const h = harness();
    await (await openFileHistory(h)).receive({ type: 'view', id: 5 });
    expect(shown).toEqual([ServerContentProvider.versionUri('$/T/a.vb', 5)]);
  });
});

/**
 * D25 (acceptance item 25): View This Version on a binary must open the
 * bytes in VS Code's own viewer rather than refuse them the way Compare
 * does. `bytesAt` is called first regardless of the outcome -- that is what
 * warms the SAME disk cache `versionTextFrom` reads for the content
 * provider, so a text version costs no extra `tf` call.
 */
describe('View This Version on a binary file (D25, acceptance item 25)', () => {
  let viewTempDir: string;

  beforeEach(() => {
    viewTempDir = mkdtempSync(join(tmpdir(), 'tfvc-view-'));
  });

  afterEach(() => {
    rmSync(viewTempDir, { recursive: true, force: true });
  });

  it('writes the bytes to <tempDir>/C<n>-<hash8>/<name>, makes the file read-only, and opens it with vscode.open -- not showTextDocument', async () => {
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    const calls: unknown[] = [];
    const h = harness({
      tempDir: viewTempDir,
      versions: {
        bytesAt: async (...args: never[]) => {
          calls.push(args);
          return { bytes, codePage: ENC_BINARY };
        },
        codePageAt: async () => ENC_BINARY,
      },
    });
    await (await openFileHistory(h)).receive({ type: 'view', id: 5 });

    const hash = VersionStore.key('$/T/a.vb', 5).slice(0, 8);
    const file = join(viewTempDir, `C5-${hash}`, 'a.vb');
    expect(readFileSync(file)).toEqual(bytes);
    expect(isReadOnly(file)).toBe(true);
    expect(executed).toContainEqual({ id: 'vscode.open', args: [Uri.file(file), { preview: true }] });
    expect(shown).toEqual([]);
    // bytesAt is what warms the cache -- called even though the version turns
    // out to be binary, so the content provider never needs its own `tf` call.
    expect(calls).toHaveLength(1);
  });

  it('versionDocument: a binary version as a file VS Code can diff, a text one through the content provider (phase 5 Compare)', async () => {
    const bytes = Buffer.from('<?xml version="1.0"?>\r\n<doc />\r\n');
    const binary = { bytesAt: async () => ({ bytes, codePage: ENC_BINARY }), codePageAt: async () => ENC_BINARY };
    const uri = await versionDocument(binary, viewTempDir, { serverPath: '$/T/a.xml', changeset: 5 });
    const file = join(viewTempDir, `C5-${VersionStore.key('$/T/a.xml', 5).slice(0, 8)}`, 'a.xml');
    expect(uri).toEqual(Uri.file(file));
    expect(readFileSync(file)).toEqual(bytes);
    expect(isReadOnly(file)).toBe(true);

    const text = { bytesAt: async () => ({ bytes, codePage: 65001 }), codePageAt: async () => 65001 };
    expect(await versionDocument(text, viewTempDir, { serverPath: '$/T/a.vb', changeset: 5 })).toEqual(
      ServerContentProvider.versionUri('$/T/a.vb', 5),
    );
  });

  it('a text version is unaffected: showTextDocument runs exactly as before, and nothing is written to tempDir', async () => {
    const h = harness({
      tempDir: viewTempDir,
      versions: {
        bytesAt: async () => ({ bytes: Buffer.from('hello'), codePage: 65001 }),
        codePageAt: async () => 65001,
      },
    });
    await (await openFileHistory(h)).receive({ type: 'view', id: 5 });
    expect(shown).toEqual([ServerContentProvider.versionUri('$/T/a.vb', 5)]);
    expect(executed.filter((e) => e.id === 'vscode.open')).toEqual([]);
    expect(readdirSync(viewTempDir)).toEqual([]);
  });

  it('a second View of the same binary reuses the file instead of erroring on the read-only copy', async () => {
    const bytes = Buffer.from([1, 2, 3, 4]);
    const h = harness({
      tempDir: viewTempDir,
      versions: {
        bytesAt: async () => ({ bytes, codePage: ENC_BINARY }),
        codePageAt: async () => ENC_BINARY,
      },
    });
    const panel = await openFileHistory(h);
    await panel.receive({ type: 'view', id: 5 });
    await panel.receive({ type: 'view', id: 5 }); // must not throw on the now-read-only file

    const hash = VersionStore.key('$/T/a.vb', 5).slice(0, 8);
    const file = join(viewTempDir, `C5-${hash}`, 'a.vb');
    expect(readFileSync(file)).toEqual(bytes);
    expect(isReadOnly(file)).toBe(true);
    expect(executed.filter((e) => e.id === 'vscode.open')).toHaveLength(2);
  });

  it('shows the bytesAt failure as a warning and opens nothing', async () => {
    const h = harness({
      tempDir: viewTempDir,
      versions: {
        bytesAt: async () => {
          throw new Error('TF400813: not authorized');
        },
        codePageAt: async () => 65001,
      },
    });
    await (await openFileHistory(h)).receive({ type: 'view', id: 5 });
    expect(recorder.shown).toContain('TF400813: not authorized');
    expect(shown).toEqual([]);
    expect(executed.filter((e) => e.id === 'vscode.open')).toEqual([]);
  });
});

describe('phase 3 part 2: viewVersion (the Source Control Explorer\'s View)', () => {
  it('opens the server version the way View This Version does, and ignores bad arguments', async () => {
    const asked: string[] = [];
    harness({
      versions: {
        bytesAt: (async (serverPath: string, changeset: number) => {
          asked.push(`${serverPath}@${changeset}`);
          return { bytes: Buffer.from('text'), codePage: 65001 };
        }) as never,
        codePageAt: (async () => 65001) as never,
      },
    });
    await recorder.invoke('teamExplorer.viewVersion', '$/T/a.vb', '5');
    await recorder.invoke('teamExplorer.viewVersion', '$/Shop/*', 5);
    await recorder.invoke('teamExplorer.viewVersion', 42, 5);
    expect(asked).toEqual([]);
    await recorder.invoke('teamExplorer.viewVersion', '$/T/a.vb', 5);
    expect(asked).toEqual(['$/T/a.vb@5']);
  });
});
