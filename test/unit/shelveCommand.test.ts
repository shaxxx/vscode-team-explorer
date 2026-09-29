import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { recorder, quickPickAnswers, inputBoxes, workspace, outputChannel, Uri } from '../vscode-mock.js';
import { runShelve, type ShelveDeps } from '../../src/commands/shelve.js';
import type { PendingChange } from '../../src/tf/types.js';
import { S } from '../../src/tf/strings.js';

const ROOT = process.platform === 'win32' ? 'C:\\work\\K' : '/home/u/work/K';
const local = (name: string) => join(ROOT, name);

const change = (name: string, flags: readonly string[] = ['Edit']): PendingChange => ({
  serverItem: `$/K/${name}`,
  localPath: local(name),
  changes: new Set(flags) as never,
  changeFlags: flags.includes('Delete') ? 8 : 2,
  itemType: 'File',
  encoding: 1250,
  version: 7,
  itemId: 1,
  date: '',
});

const KEEP = (items: unknown[]) => items[0];
const UNDO = (items: unknown[]) => items[1];

function setup(over: Partial<ShelveDeps> = {}) {
  let comment: string | undefined;
  const shelve = {
    exists: vi.fn(async () => ({ ok: true as const, value: false })),
    shelve: vi.fn(async (r: { commentPath?: string }) => {
      comment = r.commentPath ? readFileSync(r.commentPath, 'utf8') : undefined;
      return { exitCode: 0 };
    }),
  };
  const deps: ShelveDeps = {
    service: { pathMapper: { toWinePath: (p: string) => p, fromWinePath: (p: string) => p }, requestRefresh: vi.fn() },
    scm: { includedChanges: [change('a.cs'), change('b.cs')], inputBoxValue: '  Fiskalni račun  ' },
    shelve,
    output: outputChannel as never,
    autoCheckout: { reset: vi.fn() },
    rescan: vi.fn(),
    afterShelve: vi.fn(),
    ...over,
  };
  return { deps, shelve, comment: () => comment };
}

beforeEach(() => recorder.reset());

describe('Shelve', () => {
  it('says so, and asks nothing, when nothing is included', async () => {
    const { deps, shelve } = setup({ scm: { includedChanges: [], inputBoxValue: '' } });
    await runShelve(deps);
    expect(recorder.shown).toEqual([S.shelveNothingIncluded]);
    expect(inputBoxes).toHaveLength(0);
    expect(shelve.shelve).not.toHaveBeenCalled();
  });

  it('shelves the included changes under the typed name, with the comment, keeping them', async () => {
    const { deps, shelve, comment } = setup();
    recorder.answers.push('  fiskal  ');
    quickPickAnswers.push(KEEP);
    await runShelve(deps);
    expect(shelve.exists).toHaveBeenCalledWith('fiskal');
    expect(shelve.shelve).toHaveBeenCalledWith(expect.objectContaining({
      name: 'fiskal', paths: [local('a.cs'), local('b.cs')], replace: false, move: false,
    }));
    const written = comment()!;
    expect(written.charCodeAt(0)).toBe(0xfeff);
    expect(written.slice(1)).toBe('Fiskalni račun');
    expect(deps.service.requestRefresh).toHaveBeenCalled();
    expect(deps.rescan).not.toHaveBeenCalled();
    expect(deps.afterShelve).toHaveBeenCalled();
    expect(recorder.shown).toContain(S.shelveDone('fiskal', 2));
  });

  it("checks the name as the user types it", async () => {
    const { deps } = setup();
    recorder.answers.push(undefined);
    await runShelve(deps);
    const validate = inputBoxes[0].options.validateInput as (v: string) => string | null;
    expect(validate('a;b')).toBe(S.shelveBadNameChars);
    expect(validate('100%')).toBe(S.shelveBadNameChars);
    expect(validate('fiskal')).toBeNull();
  });

  it('runs nothing when the name or the mode is cancelled', async () => {
    const first = setup();
    recorder.answers.push(undefined);
    await runShelve(first.deps);
    expect(first.shelve.exists).not.toHaveBeenCalled();
    const second = setup();
    recorder.answers.push('fiskal');
    quickPickAnswers.push(undefined);
    await runShelve(second.deps);
    expect(second.shelve.exists).not.toHaveBeenCalled();
    expect(second.shelve.shelve).not.toHaveBeenCalled();
  });

  it('shelves and undoes: /move, the auto-checkout guard reset for each file, and a re-scan', async () => {
    const { deps, shelve } = setup();
    recorder.answers.push('fiskal');
    quickPickAnswers.push(UNDO);
    await runShelve(deps);
    expect(shelve.shelve).toHaveBeenCalledWith(expect.objectContaining({ move: true }));
    expect(deps.autoCheckout!.reset).toHaveBeenCalledWith(local('a.cs'));
    expect(deps.autoCheckout!.reset).toHaveBeenCalledWith(local('b.cs'));
    expect(deps.rescan).toHaveBeenCalled();
    expect(recorder.shown).toContain(S.shelveDoneUndone('fiskal', 2));
  });

  it('asks before replacing a shelveset the user already has, and runs nothing on No', async () => {
    const yes = setup();
    yes.shelve.exists.mockResolvedValueOnce({ ok: true, value: true });
    recorder.answers.push('fiskal', S.shelveReplaceYes);
    quickPickAnswers.push(KEEP);
    await runShelve(yes.deps);
    const asked = recorder.messages.find((m) => m.message.startsWith(S.shelveReplaceConfirm('fiskal')))!;
    expect(asked.modal).toBe(true);
    expect(yes.shelve.shelve).toHaveBeenCalledWith(expect.objectContaining({ replace: true }));

    recorder.reset();
    const no = setup();
    no.shelve.exists.mockResolvedValueOnce({ ok: true, value: true });
    recorder.answers.push('fiskal', undefined);
    quickPickAnswers.push(KEEP);
    await runShelve(no.deps);
    expect(no.shelve.shelve).not.toHaveBeenCalled();
  });

  it('runs nothing when it cannot tell whether the name is taken', async () => {
    const { deps, shelve } = setup();
    shelve.exists.mockResolvedValueOnce({ ok: false, message: 'TF30063' } as never);
    recorder.answers.push('fiskal');
    quickPickAnswers.push(KEEP);
    await runShelve(deps);
    expect(shelve.shelve).not.toHaveBeenCalled();
    expect(recorder.shown).toContain(S.shelveLookupFailed('TF30063'));
  });

  it('saves unsaved editors of included files first, and runs nothing if the user declines', async () => {
    const save = vi.fn(async () => true);
    workspace.textDocuments = [{ uri: Uri.file(local('a.cs')), isDirty: true, save } as never];
    const declined = setup();
    recorder.answers.push(undefined);
    await runShelve(declined.deps);
    expect(save).not.toHaveBeenCalled();
    expect(inputBoxes).toHaveLength(0);

    recorder.reset();
    workspace.textDocuments = [{ uri: Uri.file(local('a.cs')), isDirty: true, save } as never];
    const accepted = setup();
    recorder.answers.push(S.shelveSaveYes, 'fiskal');
    quickPickAnswers.push(KEEP);
    await runShelve(accepted.deps);
    expect(save).toHaveBeenCalledTimes(1);
    expect(accepted.shelve.shelve).toHaveBeenCalled();
  });

  it('stops when a save fails', async () => {
    workspace.textDocuments = [{ uri: Uri.file(local('b.cs')), isDirty: true, save: vi.fn(async () => false) } as never];
    const { deps, shelve } = setup();
    recorder.answers.push(S.shelveSaveYes);
    await runShelve(deps);
    expect(shelve.shelve).not.toHaveBeenCalled();
    expect(recorder.shown).toContain(S.shelveSaveFailed('b.cs'));
    // Proves the stop is a real early return, not an empty answer queue: no
    // name prompt was ever shown and the taken-name lookup was never reached.
    expect(inputBoxes).toHaveLength(0);
    expect(shelve.exists).not.toHaveBeenCalled();
  });

  it('does not prompt to save, or touch, a dirty editor for a file that is not included', async () => {
    const save = vi.fn(async () => true);
    workspace.textDocuments = [{ uri: Uri.file(local('other.cs')), isDirty: true, save } as never];
    const { deps, shelve } = setup();
    // Only the name answer is queued. If the save-first modal wrongly fired,
    // it would consume this as ITS answer (not S.shelveSaveYes) and return
    // early, so shelve() would never be called -- the assertion below is
    // self-checking.
    recorder.answers.push('fiskal');
    quickPickAnswers.push(KEEP);
    await runShelve(deps);
    expect(save).not.toHaveBeenCalled();
    expect(shelve.shelve).toHaveBeenCalled();
  });

  it('does not offer to save a dirty editor for a file it is about to delete', async () => {
    // "Save and Shelve" calls TextDocument.save(), which writes the editor's
    // buffer back to disk -- for a pending Delete that RECREATES the file tf
    // is about to remove. The prompt must never fire for it.
    const del = change('gone.cs', ['Delete']);
    const save = vi.fn(async () => true);
    workspace.textDocuments = [{ uri: Uri.file(local('gone.cs')), isDirty: true, save } as never];
    const { deps, shelve } = setup({ scm: { includedChanges: [del], inputBoxValue: '' } });
    // Only the name answer is queued -- see the note above.
    recorder.answers.push('fiskal');
    quickPickAnswers.push(KEEP);
    await runShelve(deps);
    expect(save).not.toHaveBeenCalled();
    expect(shelve.shelve).toHaveBeenCalledWith(expect.objectContaining({ paths: [local('gone.cs')] }));
  });

  it("shows tf's own text on a failure, and still refreshes", async () => {
    const { deps, shelve } = setup();
    shelve.shelve.mockResolvedValueOnce({ exitCode: 100, message: 'TF10141: nothing to shelve.' } as never);
    recorder.answers.push('fiskal');
    quickPickAnswers.push(KEEP);
    await runShelve(deps);
    expect(recorder.shown).toContain(S.shelveFailed('fiskal', 'TF10141: nothing to shelve.'));
    expect(deps.service.requestRefresh).toHaveBeenCalled();
  });

  it('passes no comment file when the comment box is empty', async () => {
    const { deps, shelve } = setup({ scm: { includedChanges: [change('a.cs')], inputBoxValue: '   ' } });
    recorder.answers.push('fiskal');
    quickPickAnswers.push(KEEP);
    await runShelve(deps);
    expect(shelve.shelve.mock.calls[0][0]).not.toHaveProperty('commentPath');
  });

  it('deletes the comment file after a clean success', async () => {
    const { deps, shelve } = setup();
    let commentPath: string | undefined;
    shelve.shelve.mockImplementationOnce(async (r: { commentPath?: string }) => {
      commentPath = r.commentPath;
      return { exitCode: 0 };
    });
    recorder.answers.push('fiskal');
    quickPickAnswers.push(KEEP);
    await runShelve(deps);
    expect(commentPath).toBeDefined();
    expect(existsSync(dirname(commentPath!))).toBe(false);
  });

  it('deletes the comment file after tf exits non-zero', async () => {
    const { deps, shelve } = setup();
    let commentPath: string | undefined;
    shelve.shelve.mockImplementationOnce(async (r: { commentPath?: string }) => {
      commentPath = r.commentPath;
      return { exitCode: 100, message: 'TF10141: nothing to shelve.' };
    });
    recorder.answers.push('fiskal');
    quickPickAnswers.push(KEEP);
    await runShelve(deps);
    expect(commentPath).toBeDefined();
    expect(existsSync(dirname(commentPath!))).toBe(false);
  });

  it('reports a rejected exists() without throwing, and never calls shelve()', async () => {
    const { deps, shelve } = setup();
    shelve.exists.mockRejectedValueOnce(new Error('spawn EPERM'));
    recorder.answers.push('fiskal');
    quickPickAnswers.push(KEEP);
    await runShelve(deps);
    expect(shelve.shelve).not.toHaveBeenCalled();
    expect(recorder.shown).toContain(S.commandFailed('spawn EPERM'));
  });

  it('reports a rejected shelve() without throwing, and still disposes the comment file', async () => {
    const { deps, shelve } = setup();
    let commentPath: string | undefined;
    shelve.shelve.mockImplementationOnce(async (r: { commentPath?: string }) => {
      commentPath = r.commentPath;
      throw new Error('spawn EPERM');
    });
    recorder.answers.push('fiskal');
    quickPickAnswers.push(KEEP);
    await runShelve(deps);
    expect(recorder.shown).toContain(S.commandFailed('spawn EPERM'));
    expect(commentPath).toBeDefined();
    expect(existsSync(dirname(commentPath!))).toBe(false);
  });

  it('sends tf-native (Wine) paths to shelve, and uses the HOST path for the dirty-editor match and auto-checkout reset', async () => {
    // A Fedora workspace: tf.exe under Wine sees the disk as Z:, so `localPath`
    // in the status XML is already `Z:\...`, but the editor and autoCheckout
    // both work in HOST terms (`/home/...`).
    const HOST_ROOT = '/home/u/ws';
    const hostPath = (name: string) => `${HOST_ROOT}/${name}`;
    const toWine = (p: string) => `Z:${p.replace(/\//g, '\\')}`;
    const fromWine = (p: string) => p.replace(/^Z:/, '').replace(/\\/g, '/');
    const wineChange = (name: string): PendingChange => ({
      serverItem: `$/K/${name}`,
      localPath: toWine(hostPath(name)),
      changes: new Set(['Edit']),
      changeFlags: 2,
      itemType: 'File',
      encoding: 1250,
      version: 7,
      itemId: 1,
      date: '',
    });

    const save = vi.fn(async () => true);
    workspace.textDocuments = [{ uri: Uri.file(hostPath('a.cs')), isDirty: true, save } as never];

    const { deps, shelve } = setup({
      service: { pathMapper: { toWinePath: toWine, fromWinePath: fromWine }, requestRefresh: vi.fn() },
      scm: { includedChanges: [wineChange('a.cs')], inputBoxValue: 'note' },
      autoCheckout: { reset: vi.fn() },
    });
    // The default setup() mock reads the real file at `commentPath`; here that
    // path is a fabricated `Z:\...` string, so this test supplies its own.
    shelve.shelve.mockImplementation(async () => ({ exitCode: 0 }));

    recorder.answers.push(S.shelveSaveYes, 'fiskal');
    quickPickAnswers.push(UNDO);
    await runShelve(deps);

    // The dirty-editor match and the save both fired, so the HOST uri was
    // correctly matched against the Wine-form `localPath`.
    expect(save).toHaveBeenCalledTimes(1);

    const call = shelve.shelve.mock.calls[0][0] as { paths: string[]; commentPath?: string };
    // tf gets its OWN paths verbatim -- no translation, since they already came from tf's status XML.
    expect(call.paths).toEqual([toWine(hostPath('a.cs'))]);
    // The comment file is a real host temp file, translated for tf. (The temp
    // path itself is whatever this OS's tmpdir gives -- Windows-form when this
    // suite runs on Windows -- so only the Wine prefix is asserted.)
    expect(call.commentPath).toMatch(/^Z:/);
    expect(call.commentPath).not.toBe(undefined);
    // /move was chosen: the reset must name the HOST path, not the Wine one.
    expect(deps.autoCheckout!.reset).toHaveBeenCalledWith(hostPath('a.cs'));
  });

  it('still resets auto-checkout and re-scans after a failed /move', async () => {
    const { deps, shelve } = setup();
    shelve.shelve.mockResolvedValueOnce({ exitCode: 1, message: 'TF14061: could not undo.' } as never);
    recorder.answers.push('fiskal');
    quickPickAnswers.push(UNDO);
    await runShelve(deps);
    expect(deps.autoCheckout!.reset).toHaveBeenCalledWith(local('a.cs'));
    expect(deps.autoCheckout!.reset).toHaveBeenCalledWith(local('b.cs'));
    expect(deps.rescan).toHaveBeenCalled();
    expect(deps.service.requestRefresh).toHaveBeenCalled();
    expect(recorder.shown).toContain(S.shelveFailed('fiskal', 'TF14061: could not undo.'));
  });
});
