import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerCommands } from '../../src/commands/index.js';
import { PathMapper } from '../../src/tf/PathMapper.js';
import { recorder, outputChannel, Uri, workspace, executed } from '../vscode-mock.js';
import { S } from '../../src/tf/strings.js';
import type { PendingChange } from '../../src/tf/types.js';

/**
 * Check Out and Undo on a FOLDER. Both were hidden from the explorer menu by
 * `!explorerResourceIsFolder`, the same clause that hid Add — and like Add,
 * neither sent `/recursive`, so reaching them from the palette would have
 * stopped at the folder's own children.
 *
 * Undo is the dangerous half and needed more than the menu change. Its warning
 * counted the SELECTION, so one folder read "1 item" while discarding every
 * edit underneath, and its buffer revert was handed the folder, which matches
 * no open document — leaving typed characters in an editor whose file had just
 * gone read-only again. That is the Overwrite path.
 */

const ON_WINDOWS = process.platform === 'win32';
const PLATFORM = ON_WINDOWS ? 'win32' : 'linux';
const toWine = (p: string) => (ON_WINDOWS ? p : 'Z:' + p.replace(/\//g, '\\'));

let root: string;
let folder: string;
let fileA: string;
let fileB: string;
let outsider: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'tfvc-folder-'));
  folder = join(root, 'probe');
  mkdirSync(join(folder, 'nested'), { recursive: true });
  fileA = join(folder, 'a.vb');
  fileB = join(folder, 'nested', 'b.vb');
  outsider = join(root, 'outside.vb');
  for (const f of [fileA, fileB, outsider]) writeFileSync(f, 'x');
});

afterAll(() => {
  for (const f of [fileA, fileB, outsider]) {
    try {
      chmodSync(f, 0o644);
    } catch {
      /* already gone */
    }
  }
  rmSync(root, { recursive: true, force: true });
});

/** What `tf vc undo` prints. The revert set now comes from this, not the cache. */
const undoOutput = (dir: string, ...names: string[]) =>
  [`${dir}:`, ...names.map((n) => `Undoing edit: ${n}`)].join('\n');

function change(
  serverItem: string,
  localPath: string,
  itemType: 'File' | 'Folder' = 'File',
): PendingChange {
  return {
    serverItem,
    // `localPath` is often '' here, meaning "fill in the real path once the
    // temp dir exists" (see `harness`'s `c.localPath || toWine(...)` below).
    // On Linux `toWine('')` returns `'Z:'`, which is truthy -- that would
    // defeat the fallback and leave every such entry pointing at `'Z:'`
    // itself. Keep '' falsy so the fallback still runs; on Windows `toWine`
    // is the identity, so this is unchanged either way.
    localPath: localPath ? toWine(localPath) : localPath,
    changes: new Set(['Edit' as const]),
    changeFlags: 2,
    itemType,
    encoding: 1252,
    itemId: 1,
    date: '2026-09-17T00:00:00Z',
  };
}

/** The panel's contents: two files under the folder, one outside, one folder. */
const PENDING: PendingChange[] = [
  change('$/Probe/probe/a.vb', ''),
  change('$/Probe/probe/nested/b.vb', ''),
  change('$/Probe/outside.vb', ''),
  change('$/Probe/probe/nested', '', 'Folder'),
];

function harness(pending: PendingChange[] = PENDING, stdout = '') {
  const runs: string[][] = [];
  const mapper = new PathMapper([{ serverItem: '$/Probe', localPath: toWine(root) }], PLATFORM);

  // Fill in the local paths now that the temp dir exists.
  const withPaths = pending.map((c) => ({
    ...c,
    localPath:
      c.localPath ||
      toWine(
        c.serverItem === '$/Probe/probe/a.vb'
          ? fileA
          : c.serverItem === '$/Probe/probe/nested/b.vb'
            ? fileB
            : c.serverItem === '$/Probe/outside.vb'
              ? outsider
              : join(folder, 'nested'),
      ),
  }));

  const client = {
    timeoutMs: 1000,
    run: async (args: string[]) => {
      runs.push(args);
      return { stdout: Buffer.from(stdout), stderr: Buffer.from(''), exitCode: 0, timedOut: false };
    },
  };
  const service = {
    pathMapper: mapper,
    pendingChanges: withPaths,
    requestRefresh() {},
    refresh: async () => undefined,
  };

  registerCommands(
    { subscriptions: [] } as never,
    client as never,
    service as never,
    { setExcluded: async () => {} } as never,
    outputChannel as never,
    undefined,
    { invalidate: () => {} },
  );

  return { runs };
}

beforeEach(() => {
  recorder.reset();
  outputChannel.clear();
  workspace.textDocuments = [] as never;
});

describe('Check Out on a folder', () => {
  it('sends /recursive, so subfolders are not left read-only', async () => {
    const { runs } = harness();

    await recorder.invoke('teamExplorer.checkout', Uri.file(folder));

    expect(runs).toHaveLength(1);
    expect(runs[0]).toEqual(['vc', 'checkout', '$/Probe/probe', '/recursive']);
  });

  it('does not confirm, because checking out destroys nothing', async () => {
    // Deliberately asymmetric with Undo. Checkout only makes files editable.
    const { runs } = harness();

    await recorder.invoke('teamExplorer.checkout', Uri.file(folder));

    expect(recorder.messages).toHaveLength(0);
    expect(runs).toHaveLength(1);
  });

  it('a file target keeps exactly the command it always sent', async () => {
    const { runs } = harness([change('$/Probe/outside.vb', '')]);

    await recorder.invoke('teamExplorer.checkout', Uri.file(fileA));

    expect(runs[0]).toEqual(['vc', 'checkout', '$/Probe/probe/a.vb']);
  });

  it('runs even on a cached Edit when the file is actually read-only: a checkout undone outside the extension leaves the cache stale', async () => {
    const { runs } = harness();
    chmodSync(fileA, 0o444);
    try {
      await recorder.invoke('teamExplorer.checkout', Uri.file(fileA));

      expect(runs).toHaveLength(1);
      expect(runs[0]).toEqual(['vc', 'checkout', '$/Probe/probe/a.vb']);
    } finally {
      chmodSync(fileA, 0o644);
    }
  });
});

describe('Undo on a folder', () => {
  it('counts the pending files UNDERNEATH, not the one thing selected', async () => {
    // The whole point. One folder is one URI; saying "1 item" while discarding
    // two files is worse than showing no number at all.
    harness();
    recorder.answers.push(undefined);

    await recorder.invoke('teamExplorer.undo', Uri.file(folder));

    expect(recorder.messages.at(-1)!.message).toContain('2 items');
  });

  it('counts files only, and only ones actually under the folder', async () => {
    // outside.vb is pending but elsewhere; nested is a pending FOLDER, which
    // tf reports as a change but the panel does not show as a row.
    harness();
    recorder.answers.push(undefined);

    await recorder.invoke('teamExplorer.undo', Uri.file(folder));

    const detail = recorder.messages.at(-1)!.message;
    expect(detail).not.toContain('3 items');
    expect(detail).not.toContain('4 items');
  });

  it('sends /recursive once confirmed', async () => {
    const { runs } = harness();
    recorder.answers.push(S.undoConfirmYes);

    await recorder.invoke('teamExplorer.undo', Uri.file(folder));

    expect(runs[0]).toEqual(['vc', 'undo', '$/Probe/probe', '/recursive']);
  });

  it('reverts a dirty editor for a file UNDER the folder', async () => {
    // revertOpenBuffers was handed the selection. A folder matches no open
    // document, so the typed characters stayed in the editor while the file
    // went read-only again — and the failed save offers Overwrite, which
    // clears the read-only bit behind TFVC's back.
    const { runs } = harness(
      PENDING,
      undoOutput(toWine(join(folder, 'nested')), 'b.vb'),
    );
    // What `tf vc undo` leaves behind. The revert now refuses a file that is
    // still writable, because tf's text output can name an item it never
    // touched and discarding edits on one of those would be gratuitous.
    chmodSync(fileB, 0o444);
    workspace.textDocuments = [
      { uri: Uri.file(fileB), isDirty: true, fileName: fileB },
    ] as never;
    recorder.answers.push(S.undoConfirmYes);

    await recorder.invoke('teamExplorer.undo', Uri.file(folder));

    expect(runs).toHaveLength(1);
    expect(executed.map((e) => e.id)).toContain('workbench.action.files.revert');
  });

  it('runs nothing, and does not even ask, when nothing is pending under it', async () => {
    const { runs } = harness([change('$/Probe/outside.vb', '')]);
    await recorder.invoke('teamExplorer.undo', Uri.file(folder));

    expect(runs).toHaveLength(0);
    const info = recorder.messages.filter((m) => m.kind === 'info');
    expect(info.at(-1)!.message).toBe(S.undoNothingPending);
    expect(recorder.messages.some((m) => m.modal)).toBe(false);
  });

  it('a file target still counts the selection, not the cache', async () => {
    // Both files are pending, so both are counted from the selection. A file
    // with nothing pending is dropped before the count (plan 3) -- see
    // commands.behaviour.test.ts.
    const { runs } = harness();
    recorder.answers.push(S.undoConfirmYes);

    await recorder.invoke('teamExplorer.undo', Uri.file(fileA), [Uri.file(fileA), Uri.file(outsider)]);

    expect(recorder.messages.at(-1)!.message).toContain('2 items');
    expect(runs[0]).toEqual(['vc', 'undo', '$/Probe/probe/a.vb', '$/Probe/outside.vb']);
  });
});

describe('Add on a folder', () => {
  it('never refuses a folder, even with a pending Add on it: Add is how a partly versioned tree gets its new files in', async () => {
    const folderAdd: PendingChange = {
      serverItem: '$/Probe/probe',
      localPath: toWine(folder),
      changes: new Set(['Add' as const]),
      changeFlags: 1,
      itemType: 'Folder',
      encoding: 1252,
      itemId: 1,
      date: '2026-09-17T00:00:00Z',
    };
    const { runs } = harness([folderAdd]);
    recorder.answers.push(S.addFolderConfirmYes);

    await recorder.invoke('teamExplorer.add', Uri.file(folder));

    expect(recorder.messages.filter((m) => m.kind === 'info')).toHaveLength(0);
    expect(runs[0]).toEqual(['vc', 'add', toWine(folder), '/recursive']);
  });
});

describe('the explorer menu', () => {
  it('no longer hides anything on folders', () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf8')) as {
      contributes: { menus: Record<string, { command: string; when?: string }[]> };
    };
    const entries = pkg.contributes.menus['teamExplorer.explorer'];
    for (const command of ['teamExplorer.add', 'teamExplorer.checkout', 'teamExplorer.undo']) {
      const entry = entries.find((e) => e.command === command);
      expect(entry, `${command} is not in the Team Explorer submenu`).toBeDefined();
      expect(entry!.when ?? '', `${command} still hides on folders`).not.toContain(
        'explorerResourceIsFolder',
      );
    }
  });
});
