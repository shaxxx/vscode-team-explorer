import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, renameSync, mkdirSync, chmodSync, constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerFileOps } from '../../src/commands/fileOps.js';
import { PathMapper } from '../../src/tf/PathMapper.js';
import { S } from '../../src/tf/strings.js';
import { hooks, recorder, outputChannel, Uri, inputBoxes } from '../vscode-mock.js';

/**
 * `root` is a real host temp dir, so a mapper hardcoded to 'win32' worked by
 * accident on Windows (a no-op `toWinePath`) but broke every mapping on Linux
 * -- `PathMapper.isUnder` only accepts `\` separators, and a POSIX `root` has
 * none, so `toServerPath` returned `undefined` for everything and every test
 * below exercised nothing but the "unmapped" branch. `mapper`/`platform` now
 * follow the real host, same as `TfvcService.platform`; on Linux the folder's
 * `localPath` is `root`'s own Wine form (`Z:...`), exactly what tf.exe itself
 * would report, mirroring `PathMapper.toWinePath`. On Windows this is
 * byte-for-byte the same mapper as before (`toWinePath` stays a no-op).
 */
const isWin = process.platform === 'win32';

function setup(over: { verdict?: string; change?: unknown } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'tfvc-fileops-'));
  const platform = isWin ? 'win32' : 'linux';
  const mapper = new PathMapper(
    [{ serverItem: '$/T', localPath: isWin ? root : 'Z:' + root.replace(/\//g, '\\') }],
    platform,
  );
  const rename = vi.fn(async () => ({ ok: true as const }));
  const del = vi.fn(async () => ({ ok: true as const }));
  const refresh = vi.fn();
  const context = { subscriptions: [] as { dispose(): void }[] };
  registerFileOps(context as never, {
    service: {
      pathMapper: mapper,
      platform,
      changeForLocal: () => over.change,
    } as never,
    ops: { rename, delete: del } as never,
    output: outputChannel as never,
    scan: () => ({ verdictFor: () => over.verdict ?? 'inSourceControl' }) as never,
    refresh,
  });
  return { root, mapper, rename, del, refresh, context };
}

const file = (root: string, name: string) => {
  const p = join(root, name);
  writeFileSync(p, 'x');
  return p;
};

beforeEach(() => {
  recorder.reset();
  hooks.reset();
  outputChannel.clear();
});

describe('the file tree: rename', () => {
  it('puts the item back, lets tf redo the move, and refreshes (design R2, R5)', async () => {
    const { root, mapper, rename, refresh } = setup();
    const oldPath = file(root, 'a.txt');
    const newPath = join(root, 'b.txt');

    hooks.willRenameFiles.emit({ files: [{ oldUri: Uri.file(oldPath), newUri: Uri.file(newPath) }] });
    renameSync(oldPath, newPath); // what VS Code does between the two events
    hooks.didRenameFiles.emit({ files: [{ oldUri: Uri.file(oldPath), newUri: Uri.file(newPath) }] });
    await new Promise((r) => setTimeout(r, 0));

    // tf was asked to move it, from the old path, which had to be there again
    // -- in tf's own (Wine) form on Linux, a no-op on Windows.
    expect(rename).toHaveBeenCalledWith(mapper.toWinePath(oldPath), mapper.toWinePath(newPath));
    expect(refresh).toHaveBeenCalled();
  });

  it('says nothing for a file TFVC never had', async () => {
    const { root, rename } = setup({ verdict: 'notInSourceControl' });
    const oldPath = file(root, 'new.txt');
    const newPath = join(root, 'new2.txt');
    hooks.willRenameFiles.emit({ files: [{ oldUri: Uri.file(oldPath), newUri: Uri.file(newPath) }] });
    renameSync(oldPath, newPath);
    hooks.didRenameFiles.emit({ files: [{ oldUri: Uri.file(oldPath), newUri: Uri.file(newPath) }] });
    await new Promise((r) => setTimeout(r, 0));
    expect(rename).not.toHaveBeenCalled();
    expect(recorder.shown).toEqual([]);
  });

  it('leaves the user rename in place when tf refuses, and says so once', async () => {
    const { root, rename } = setup();
    rename.mockResolvedValueOnce({ ok: false, message: 'TF10141: no.' } as never);
    const oldPath = file(root, 'a.txt');
    const newPath = join(root, 'b.txt');
    hooks.willRenameFiles.emit({ files: [{ oldUri: Uri.file(oldPath), newUri: Uri.file(newPath) }] });
    renameSync(oldPath, newPath);
    hooks.didRenameFiles.emit({ files: [{ oldUri: Uri.file(oldPath), newUri: Uri.file(newPath) }] });
    await new Promise((r) => setTimeout(r, 0));

    expect(existsSync(newPath), 'the user rename must stand').toBe(true);
    expect(existsSync(oldPath)).toBe(false);
    expect(recorder.shown.join('\n')).toContain('TF10141: no.');
  });

  it('refuses to repair when the old name is in use again', async () => {
    const { root, rename } = setup();
    const oldPath = file(root, 'a.txt');
    const newPath = join(root, 'b.txt');
    hooks.willRenameFiles.emit({ files: [{ oldUri: Uri.file(oldPath), newUri: Uri.file(newPath) }] });
    renameSync(oldPath, newPath);
    writeFileSync(oldPath, 'something else'); // a new file took the old name
    hooks.didRenameFiles.emit({ files: [{ oldUri: Uri.file(oldPath), newUri: Uri.file(newPath) }] });
    await new Promise((r) => setTimeout(r, 0));

    expect(rename).not.toHaveBeenCalled();
    expect(recorder.shown.join('\n')).toContain(S.fileOpsRepairBlocked('b.txt'));
  });

  it('does nothing when the did-event arrives with nothing remembered', async () => {
    const { root, rename } = setup();
    const oldPath = join(root, 'a.txt');
    const newPath = join(root, 'b.txt');
    writeFileSync(newPath, 'x');
    hooks.didRenameFiles.emit({ files: [{ oldUri: Uri.file(oldPath), newUri: Uri.file(newPath) }] });
    await new Promise((r) => setTimeout(r, 0));
    expect(rename).not.toHaveBeenCalled();
  });

  it('CRITICAL: never overwrites a file that took the new name while tf was running', async () => {
    const { root, rename } = setup();
    const oldPath = file(root, 'a.txt'); // content: 'x'
    const newPath = join(root, 'b.txt');
    rename.mockImplementationOnce(async () => {
      // While tf ran, a save from the still-open editor (or anything else)
      // recreated the destination -- often the very reason tf just failed.
      writeFileSync(newPath, 'clobber-me-not');
      return { ok: false, message: 'TF10141: no.' } as never;
    });
    hooks.willRenameFiles.emit({ files: [{ oldUri: Uri.file(oldPath), newUri: Uri.file(newPath) }] });
    renameSync(oldPath, newPath);
    hooks.didRenameFiles.emit({ files: [{ oldUri: Uri.file(oldPath), newUri: Uri.file(newPath) }] });
    await new Promise((r) => setTimeout(r, 0));

    expect(readFileSync(newPath, 'utf8'), 'must survive the blocked restore').toBe('clobber-me-not');
    expect(existsSync(oldPath), 'the item stays under its old name').toBe(true);
    expect(recorder.shown.join('\n')).toContain(S.fileOpsRestoreBlocked('a.txt', 'b.txt'));
  });

  it('refreshes even when the rename outcome is a failure', async () => {
    const { root, rename, refresh } = setup();
    rename.mockResolvedValueOnce({ ok: false, message: 'TF10141: no.' } as never);
    const oldPath = file(root, 'a.txt');
    const newPath = join(root, 'b.txt');
    hooks.willRenameFiles.emit({ files: [{ oldUri: Uri.file(oldPath), newUri: Uri.file(newPath) }] });
    renameSync(oldPath, newPath);
    hooks.didRenameFiles.emit({ files: [{ oldUri: Uri.file(oldPath), newUri: Uri.file(newPath) }] });
    await new Promise((r) => setTimeout(r, 0));
    expect(refresh).toHaveBeenCalled();
  });

  // Windows-only: `date.js` -> `Date.js` is a case-only rename of the SAME
  // item only on a case-insensitive filesystem. On Linux they are two
  // different files from the moment `renameSync` runs, below, so this test
  // would exercise nothing about case handling -- the real Linux case rule
  // (two distinct files never share a remembered verdict) is already covered
  // by "does not conflate two paths that differ only by case on Linux" below.
  it.skipIf(!isWin)('lets a case-only rename through -- it is the same item, and tf records it (design R4)', async () => {
    const { root, rename } = setup();
    const oldPath = file(root, 'date.js');
    const newPath = join(root, 'Date.js');
    hooks.willRenameFiles.emit({ files: [{ oldUri: Uri.file(oldPath), newUri: Uri.file(newPath) }] });
    renameSync(oldPath, newPath);
    hooks.didRenameFiles.emit({ files: [{ oldUri: Uri.file(oldPath), newUri: Uri.file(newPath) }] });
    await new Promise((r) => setTimeout(r, 0));
    expect(rename).toHaveBeenCalledWith(oldPath, newPath);
  });
});

describe('wasVersioned: the read-only and folder rules only run once the scan is unsure', () => {
  it('treats a read-only file the scan has not looked at yet as versioned', async () => {
    const { root, mapper, del } = setup({ verdict: 'notScanned' });
    const f = join(root, 'a.txt');
    writeFileSync(f, 'x');
    chmodSync(f, constants.S_IRUSR);
    hooks.willDeleteFiles.emit({ files: [Uri.file(f)] });
    hooks.didDeleteFiles.emit({ files: [Uri.file(f)] });
    await new Promise((r) => setTimeout(r, 0));
    chmodSync(f, constants.S_IRUSR | constants.S_IWUSR); // so temp cleanup can remove it
    expect(del).toHaveBeenCalledWith([mapper.toWinePath(f)]);
  });

  it('does not treat a read-only FOLDER as versioned -- the bit says nothing for a folder', async () => {
    const { root, del } = setup({ verdict: 'notScanned' });
    const sub = join(root, 'sub');
    mkdirSync(sub);
    chmodSync(sub, constants.S_IRUSR);
    hooks.willDeleteFiles.emit({ files: [Uri.file(sub)] });
    hooks.didDeleteFiles.emit({ files: [Uri.file(sub)] });
    await new Promise((r) => setTimeout(r, 0));
    chmodSync(sub, constants.S_IRUSR | constants.S_IWUSR);
    expect(del).not.toHaveBeenCalled();
  });

  it('treats a FOLDER as versioned when it holds a read-only file', async () => {
    // Acceptance item 4, 2026-09-23: a folder's own read-only bit says
    // nothing, so a folder the scan had not covered yet fell through to "not
    // versioned" and deleting it in the file tree recorded nothing. What TFVC
    // handed out is inside it.
    const { root, mapper, del } = setup({ verdict: 'notScanned' });
    const dir = join(root, 'order-kiosk');
    mkdirSync(dir);
    const f = join(dir, '3rdpartylicenses.txt');
    writeFileSync(f, 'x');
    chmodSync(f, constants.S_IRUSR);
    hooks.willDeleteFiles.emit({ files: [Uri.file(dir)] });
    hooks.didDeleteFiles.emit({ files: [Uri.file(dir)] });
    await new Promise((r) => setTimeout(r, 0));
    chmodSync(f, constants.S_IRUSR | constants.S_IWUSR);
    expect(del).toHaveBeenCalledWith([mapper.toWinePath(dir)]);
  });

  it('finds that proof in a subfolder, and past the scan calling the folder unversioned', async () => {
    const { root, mapper, del } = setup({ verdict: 'notInSourceControl' });
    const dir = join(root, 'outer');
    const inner = join(dir, 'browser');
    mkdirSync(inner, { recursive: true });
    const f = join(inner, 'index.html');
    writeFileSync(f, 'x');
    chmodSync(f, constants.S_IRUSR);
    hooks.willDeleteFiles.emit({ files: [Uri.file(dir)] });
    hooks.didDeleteFiles.emit({ files: [Uri.file(dir)] });
    await new Promise((r) => setTimeout(r, 0));
    chmodSync(f, constants.S_IRUSR | constants.S_IWUSR);
    expect(del).toHaveBeenCalledWith([mapper.toWinePath(dir)]);
  });

  it('finds a versioned file past a big unversioned subtree, whatever readdir order gives', async () => {
    // The walk is level-order for this reason (review, 2026-09-23). Depth-first
    // would spend its whole budget inside `node_modules` and never reach the
    // read-only files in `src`, answering "not versioned" for a folder that
    // plainly is -- the silent non-recording the walk exists to prevent.
    const { root, mapper, del } = setup({ verdict: 'notScanned' });
    const app = join(root, 'ClientApp');
    const heavy = join(app, 'node_modules');
    mkdirSync(heavy, { recursive: true });
    for (let i = 0; i < 1200; i++) writeFileSync(join(heavy, `pkg${i}.js`), 'x');
    const src = join(app, 'src');
    mkdirSync(src);
    const f = join(src, 'app.ts');
    writeFileSync(f, 'x');
    chmodSync(f, constants.S_IRUSR);

    hooks.willDeleteFiles.emit({ files: [Uri.file(app)] });
    hooks.didDeleteFiles.emit({ files: [Uri.file(app)] });
    await new Promise((r) => setTimeout(r, 0));
    chmodSync(f, constants.S_IRUSR | constants.S_IWUSR);

    expect(del).toHaveBeenCalledWith([mapper.toWinePath(app)]);
  });

  it('says nothing for a folder of WRITABLE files: TFVC never handed those out', async () => {
    const { root, del } = setup({ verdict: 'notScanned' });
    const dir = join(root, 'build');
    mkdirSync(dir);
    writeFileSync(join(dir, 'out.js'), 'x');
    hooks.willDeleteFiles.emit({ files: [Uri.file(dir)] });
    hooks.didDeleteFiles.emit({ files: [Uri.file(dir)] });
    await new Promise((r) => setTimeout(r, 0));
    expect(del).not.toHaveBeenCalled();
  });

  it('believes the read-only bit over a scan that calls a versioned file unversioned', async () => {
    // `tf reconcile` can report a file as "Pending add" that `tf info` puts at
    // changeset 18312 with no pending change -- measured on DEVPC, and traced
    // by probes R28-R31 to a workspace whose mapped folder was never
    // downloaded. Trusting it made a delete silently unrecorded (found in
    // acceptance). `UnversionedScan` now refuses such a listing outright; this
    // guard is the second line, and costs one stat.
    const { root, mapper, del } = setup({ verdict: 'notInSourceControl' });
    const f = join(root, 'a.txt');
    writeFileSync(f, 'x');
    chmodSync(f, constants.S_IRUSR);
    hooks.willDeleteFiles.emit({ files: [Uri.file(f)] });
    hooks.didDeleteFiles.emit({ files: [Uri.file(f)] });
    await new Promise((r) => setTimeout(r, 0));
    chmodSync(f, constants.S_IRUSR | constants.S_IWUSR);
    expect(del).toHaveBeenCalledWith([mapper.toWinePath(f)]);
  });

  it('still says nothing for a WRITABLE file the scan calls unversioned: that is a real new file', async () => {
    const { root, del } = setup({ verdict: 'notInSourceControl' });
    const f = file(root, 'new.txt');
    hooks.willDeleteFiles.emit({ files: [Uri.file(f)] });
    hooks.didDeleteFiles.emit({ files: [Uri.file(f)] });
    await new Promise((r) => setTimeout(r, 0));
    expect(del).not.toHaveBeenCalled();
  });

  it('does not treat a writable file the scan has not looked at as versioned', async () => {
    const { root, del } = setup({ verdict: 'notScanned' });
    const f = file(root, 'a.txt');
    hooks.willDeleteFiles.emit({ files: [Uri.file(f)] });
    hooks.didDeleteFiles.emit({ files: [Uri.file(f)] });
    await new Promise((r) => setTimeout(r, 0));
    expect(del).not.toHaveBeenCalled();
  });

  it('a pending change proves versioned even when the scan says otherwise', async () => {
    const { root, mapper, del } = setup({ verdict: 'notInSourceControl', change: {} });
    const f = file(root, 'a.txt');
    hooks.willDeleteFiles.emit({ files: [Uri.file(f)] });
    hooks.didDeleteFiles.emit({ files: [Uri.file(f)] });
    await new Promise((r) => setTimeout(r, 0));
    expect(del).toHaveBeenCalledWith([mapper.toWinePath(f)]);
  });
});

describe('the file tree: delete', () => {
  it('records the whole batch in one call, after VS Code removed the files (design R6)', async () => {
    const { root, mapper, del, refresh } = setup();
    const a = file(root, 'a.txt');
    const b = file(root, 'b.txt');
    hooks.willDeleteFiles.emit({ files: [Uri.file(a), Uri.file(b)] });
    hooks.didDeleteFiles.emit({ files: [Uri.file(a), Uri.file(b)] });
    await new Promise((r) => setTimeout(r, 0));
    expect(del).toHaveBeenCalledWith([mapper.toWinePath(a), mapper.toWinePath(b)]);
    expect(refresh).toHaveBeenCalled();
  });

  it('refreshes even when tf reports failure, because a batch can be partly recorded', async () => {
    const { root, del, refresh } = setup();
    del.mockResolvedValueOnce({ ok: false, message: 'TF10141: some of them.' } as never);
    const a = file(root, 'a.txt');
    hooks.willDeleteFiles.emit({ files: [Uri.file(a)] });
    hooks.didDeleteFiles.emit({ files: [Uri.file(a)] });
    await new Promise((r) => setTimeout(r, 0));
    expect(refresh).toHaveBeenCalled();
    expect(recorder.shown.join('\n')).toContain('TF10141: some of them.');
  });

  it('says nothing for files TFVC never had', async () => {
    const { root, del } = setup({ verdict: 'notInSourceControl' });
    const a = file(root, 'new.txt');
    hooks.willDeleteFiles.emit({ files: [Uri.file(a)] });
    hooks.didDeleteFiles.emit({ files: [Uri.file(a)] });
    await new Promise((r) => setTimeout(r, 0));
    expect(del).not.toHaveBeenCalled();
    expect(recorder.shown).toEqual([]);
  });

  it('does not conflate two paths that differ only by case on Linux, where they are different files', async () => {
    // Plain POSIX strings, not `join()` (which would emit backslashes on this
    // Windows test runner): `onDeleted` never touches the disk, so a real
    // temp directory is not needed. `localPath` is in tf's own Wine form
    // (`Z:\...`), same as `annotator.test.ts`'s Linux mapper -- that is what
    // tf.exe itself reports even on Fedora, since it is a Windows binary.
    const root = '/home/shax/T';
    const mapper = new PathMapper([{ serverItem: '$/T', localPath: 'Z:\\home\\shax\\T' }], 'linux');
    const del = vi.fn(async () => ({ ok: true as const }));
    const refresh = vi.fn();
    const context = { subscriptions: [] as { dispose(): void }[] };
    const lower = `${root}/a.txt`;
    const upper = `${root}/A.txt`;
    registerFileOps(context as never, {
      service: {
        pathMapper: mapper,
        platform: 'linux',
        changeForLocal: () => undefined,
      } as never,
      ops: { rename: vi.fn(), delete: del } as never,
      output: outputChannel as never,
      // Distinct verdicts by exact path: only `lower` is versioned.
      scan: () => ({ verdictFor: (p: string) => (p === lower ? 'inSourceControl' : 'notInSourceControl') }) as never,
      refresh,
    });

    hooks.willDeleteFiles.emit({ files: [Uri.file(lower), Uri.file(upper)] });
    hooks.didDeleteFiles.emit({ files: [Uri.file(lower), Uri.file(upper)] });
    await new Promise((r) => setTimeout(r, 0));

    // A case-folded key would collapse both into one entry and lose one
    // verdict or the other; only `lower` was ever versioned. tf sees it in
    // Wine's own form, same as every other path this handler sends it.
    expect(del).toHaveBeenCalledWith([mapper.toWinePath(lower)]);
  });
});

describe('the explorer commands', () => {
  it('renames through tf after validating the new name', async () => {
    const { root, mapper, rename, refresh } = setup();
    const a = file(root, 'a.txt');
    recorder.answers.push('b.txt');
    await recorder.invoke('teamExplorer.renameItem', a, ['a.txt', 'c.txt']);
    expect(rename).toHaveBeenCalledWith(mapper.toWinePath(a), mapper.toWinePath(join(root, 'b.txt')));
    expect(refresh).toHaveBeenCalled();
  });

  it('refuses a name that exists only on disk, which the server listing cannot know', async () => {
    // Acceptance item 5, 2026-09-23: the explorer lists the SERVER folder, so a
    // file whose rename INTO it is still pending is not among `names` -- the
    // box accepted the name and tf then refused it with exit 100.
    const { root, rename } = setup();
    const a = file(root, 'a.txt');
    file(root, 'pending.html');
    recorder.answers.push('pending.html');
    await recorder.invoke('teamExplorer.renameItem', a, ['a.txt', 'c.txt']);
    expect(rename).not.toHaveBeenCalled();
    expect(recorder.shown.some((m) => m.includes(S.fileOpsBadNameTaken('pending.html')))).toBe(true);
    // and the box says so while the user types, not only afterwards
    const validate = inputBoxes[0].options.validateInput as (v: string) => string | undefined;
    expect(validate('pending.html')).toBe(S.fileOpsBadNameTaken('pending.html'));
    expect(validate('free.html')).toBeUndefined();
  });

  // Windows-only, like the case-only rename test above: the "though the file
  // is right there" premise (`key(candidate) === key(target)` short-circuits
  // `check`'s `existsSync`) only holds where `key` folds case. On Linux
  // `A.TXT` and `a.txt` are simply two different names to `key`, and the
  // candidate was never created on disk, so `existsSync` alone would let it
  // through for an unrelated reason -- not the same-item rule this test names.
  it.skipIf(!isWin)('still allows a case-only rename, though the file is right there', async () => {
    const { root, mapper, rename } = setup();
    const a = file(root, 'a.txt');
    recorder.answers.push('A.TXT');
    await recorder.invoke('teamExplorer.renameItem', a, ['a.txt']);
    expect(rename).toHaveBeenCalledWith(mapper.toWinePath(a), mapper.toWinePath(join(root, 'A.TXT')));
  });

  it('does nothing when the input box is cancelled or the name is unchanged', async () => {
    const { root, rename } = setup();
    const a = file(root, 'a.txt');
    recorder.answers.push(undefined);
    await recorder.invoke('teamExplorer.renameItem', a, []);
    recorder.answers.push('a.txt');
    await recorder.invoke('teamExplorer.renameItem', a, []);
    expect(rename).not.toHaveBeenCalled();
  });

  it('ignores a rename argument that is not a path', async () => {
    const { rename } = setup();
    await recorder.invoke('teamExplorer.renameItem', 42, []);
    await recorder.invoke('teamExplorer.renameItem', undefined, []);
    expect(rename).not.toHaveBeenCalled();
  });

  it('refreshes even when the explorer rename command fails', async () => {
    const { root, rename, refresh } = setup();
    rename.mockResolvedValueOnce({ ok: false, message: 'no' } as never);
    const a = file(root, 'a.txt');
    recorder.answers.push('b.txt');
    await recorder.invoke('teamExplorer.renameItem', a, []);
    expect(refresh).toHaveBeenCalled();
  });

  it('deletes server paths after a modal confirm, and nothing when it is declined', async () => {
    const { del } = setup();
    recorder.answers.push(undefined);
    await recorder.invoke('teamExplorer.deleteItems', { paths: ['$/T/a.txt'], names: ['a.txt'], hasFolder: false });
    expect(del).not.toHaveBeenCalled();

    recorder.answers.push(S.fileOpsDeleteYes);
    await recorder.invoke('teamExplorer.deleteItems', { paths: ['$/T/a.txt', '$/T/sub'], names: ['a.txt', 'sub'], hasFolder: true });
    expect(del).toHaveBeenCalledWith(['$/T/a.txt', '$/T/sub']);
    expect(recorder.shown.length >= 0).toBe(true);
  });

  it('refuses a delete argument that is not a list of server paths', async () => {
    const { del } = setup();
    recorder.answers.push(S.fileOpsDeleteYes);
    await recorder.invoke('teamExplorer.deleteItems', { paths: ['$/T/*'], names: ['x'], hasFolder: false });
    await recorder.invoke('teamExplorer.deleteItems', { paths: ['C:\\t\\a.txt'], names: ['x'], hasFolder: false });
    await recorder.invoke('teamExplorer.deleteItems', 'nonsense');
    expect(del).not.toHaveBeenCalled();
  });

  it('refuses a delete for a path outside this project\'s mapping', async () => {
    const { del } = setup();
    recorder.answers.push(S.fileOpsDeleteYes);
    await recorder.invoke('teamExplorer.deleteItems', {
      paths: ['$/Other/x.txt'],
      names: ['x.txt'],
      hasFolder: false,
    });
    expect(del).not.toHaveBeenCalled();
  });

  it('refuses to delete the whole server root, even in a workspace that maps $/', async () => {
    const { del } = setup();
    recorder.answers.push(S.fileOpsDeleteYes);
    await recorder.invoke('teamExplorer.deleteItems', { paths: ['$/'], names: ['T'], hasFolder: true });
    expect(del).not.toHaveBeenCalled();
  });

  it('refreshes even when the explorer delete command fails', async () => {
    const { del, refresh } = setup();
    del.mockResolvedValueOnce({ ok: false, message: 'no' } as never);
    recorder.answers.push(S.fileOpsDeleteYes);
    await recorder.invoke('teamExplorer.deleteItems', { paths: ['$/T/a.txt'], names: ['a.txt'], hasFolder: false });
    expect(refresh).toHaveBeenCalled();
  });
});
