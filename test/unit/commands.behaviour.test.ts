import { describe, it, expect, beforeEach } from 'vitest';
import { registerCommands, runMutation } from '../../src/commands/index.js';
import { PathMapper } from '../../src/tf/PathMapper.js';
import { recorder, outputChannel, Uri, workspace, executed, shown } from '../vscode-mock.js';
import { S } from '../../src/tf/strings.js';
import type { ChangeFlag } from '../../src/tf/types.js';

/**
 * These drive the real command handlers through the vscode mock. Until now
 * this layer was covered only by tests that read the source as text — which
 * cannot tell whether Undo actually asks before destroying edits.
 */

interface Run {
  args: string[];
}

function harness(opts: {
  platform?: 'win32' | 'linux';
  runFails?: Error;
  exitCode?: number;
  stdout?: string;
  terminatedBy?: NodeJS.Signals;
  alsoRefresh?: () => void;
  /** File names in the mapped folder with a pending change, and its flags. */
  pending?: Record<string, ChangeFlag[]>;
  /** Called as each tf command starts. */
  onRun?: () => void;
  /** The directory tf runs in, which its checkout/undo output is relative to. */
  cwd?: string;
} = {}) {
  const runs: Run[] = [];
  const platform = opts.platform ?? 'win32';

  const mapper = new PathMapper(
    platform === 'win32'
      ? [{ serverItem: '$/Vesta', localPath: 'C:\\work\\Vesta' }]
      : [{ serverItem: '$/Vesta', localPath: 'Z:\\home\\shax\\work\\Vesta' }],
    platform,
  );

  const client = {
    timeoutMs: 1000,
    cwd: opts.cwd,
    run: async (args: string[]) => {
      opts.onRun?.();
      if (opts.runFails) throw opts.runFails;
      runs.push({ args });
      return {
        stdout: Buffer.from(opts.stdout ?? ''),
        stderr: Buffer.from(''),
        exitCode: opts.exitCode ?? 0,
        timedOut: false,
        terminatedBy: opts.terminatedBy,
      };
    },
  };

  const localOf = (name: string) =>
    platform === 'win32' ? winFile(name).fsPath : `/home/shax/work/Vesta/${name}`;
  const pendingChanges = Object.entries(opts.pending ?? {}).map(([name, flags]) => ({
    serverItem: `$/Vesta/${name}`,
    localPath: mapper.toWinePath(localOf(name)),
    changes: new Set(flags),
    changeFlags: 0,
    itemType: 'File' as const,
    encoding: 1250,
    itemId: 1,
    date: '',
  }));

  const service = {
    pathMapper: mapper,
    pendingChanges,
    requestRefresh() {},
    refresh: async () => undefined,
  };
  /** Every setExcludedMany call, in order. */
  const excludedCalls: [string[], boolean][] = [];
  const scm = {
    setExcludedMany: async (items: readonly string[], exclude: boolean) =>
      void excludedCalls.push([[...items], exclude]),
  };
  const context = { subscriptions: [] as { dispose(): void }[] };
  /** Server items whose cached copy was dropped, in order. */
  const invalidated: (string | undefined)[] = [];

  registerCommands(
    context as never,
    client as never,
    service as never,
    scm as never,
    outputChannel as never,
    undefined,
    { invalidate: (item?: string) => void invalidated.push(item) },
    opts.alsoRefresh,
  );

  return { runs, mapper, invalidated, excludedCalls };
}

// What `tf vc undo` actually prints. The revert set is taken from THIS now,
// not from the selection: tf is the only authority on what it undid.
const undoOutput = (dir: string, ...names: string[]) =>
  [`${dir}:`, ...names.map((n) => `Undoing edit: ${n}`)].join('\n');

const winFile = (name: string) => Uri.file(`C:\\work\\Vesta\\${name}`);

beforeEach(() => {
  recorder.reset();
  outputChannel.clear();
});

describe('teamExplorer.undo', () => {
  it('asks before destroying edits, and does NOTHING if the user says no', async () => {
    const { runs } = harness({ pending: { 'Form1.vb': ['Edit'] } });
    recorder.answers.push(undefined); // user dismissed the dialog

    await recorder.invoke('teamExplorer.undo', winFile('Form1.vb'));

    expect(runs).toHaveLength(0);
    const dialog = recorder.messages.at(-1)!;
    expect(dialog.modal, 'a non-modal warning is dismissible by ignoring it').toBe(true);
    expect(dialog.items).toContain(S.undoConfirmYes);
    // The dialog must say what is at stake, not just "are you sure".
    expect(dialog.message).toContain('cannot be recovered');
  });

  it('runs tf vc undo once the user confirms', async () => {
    const { runs } = harness({ pending: { 'Form1.vb': ['Edit'] } });
    recorder.answers.push(S.undoConfirmYes);

    await recorder.invoke('teamExplorer.undo', winFile('Form1.vb'));

    expect(runs).toHaveLength(1);
    expect(runs[0].args).toEqual(['vc', 'undo', '$/Vesta/Form1.vb']);
  });

  it('counts the items it is about to discard', async () => {
    const { runs } = harness({ pending: { 'A.vb': ['Edit'], 'B.vb': ['Edit'] } });
    recorder.answers.push(S.undoConfirmYes);

    await recorder.invoke('teamExplorer.undo', winFile('A.vb'), [winFile('A.vb'), winFile('B.vb')]);

    expect(recorder.messages.at(-1)!.message).toContain('2 items');
    expect(runs[0].args).toEqual(['vc', 'undo', '$/Vesta/A.vb', '$/Vesta/B.vb']);
  });
});

describe('teamExplorer.add', () => {
  it('sends a LOCAL path, because tf add cannot resolve a server path', async () => {
    const { runs } = harness();

    await recorder.invoke('teamExplorer.add', winFile('New.vb'));

    expect(runs[0].args).toEqual(['vc', 'add', 'C:\\work\\Vesta\\New.vb']);
    // The item does not exist on the server yet, so $/... has nothing to
    // resolve against. Sending one meant Add could never work.
    expect(runs[0].args.some((a) => a.startsWith('$/'))).toBe(false);
  });

  it('on Linux sends the path tf.exe sees under Wine, not the Linux path', async () => {
    const { runs } = harness({ platform: 'linux' });

    await recorder.invoke('teamExplorer.add', Uri.file('/home/shax/work/Vesta/New.vb'));

    expect(runs[0].args).toEqual(['vc', 'add', 'Z:\\home\\shax\\work\\Vesta\\New.vb']);
  });

  it('warns rather than silently skipping a file outside the workspace', async () => {
    const { runs } = harness();

    await recorder.invoke('teamExplorer.add', Uri.file('C:\\elsewhere\\Stray.vb'));

    expect(runs).toHaveLength(0);
    expect(recorder.shown.join('\n')).toContain(S.noWorkspaceMapping);
  });
});

describe('a command that cannot even start', () => {
  it('tells the user instead of rejecting into the void', async () => {
    const { runs } = harness({ runFails: new Error('spawn ENOENT') });
    recorder.answers.push(S.undoConfirmYes);

    // Must not reject: an unhandled rejection in a registerCommand handler is
    // logged where the user never looks, so the command appears to do nothing.
    await expect(recorder.invoke('teamExplorer.checkout', winFile('Form1.vb'))).resolves.toBeUndefined();

    expect(runs).toHaveLength(0);
    const errors = recorder.messages.filter((m) => m.kind === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('spawn ENOENT');
  });

  it('never lets a token reach the message or the log', async () => {
    harness({ runFails: new Error('failed: /login:.,SECRETPATVALUE') });

    await recorder.invoke('teamExplorer.checkout', winFile('Form1.vb'));

    const everything = [...recorder.shown, ...outputChannel.lines].join('\n');
    expect(everything).not.toContain('SECRETPATVALUE');
    expect(everything).toContain('/login:***');
  });
});

describe('Undo and the editor buffer', () => {
  const dirtyDoc = (fsPath: string) => ({ uri: Uri.file(fsPath), isDirty: true, fileName: fsPath });

  it('discards a DIRTY buffer, because the dialog promised exactly that', async () => {
    // `tf vc undo` rewrites the file on disk, but a dirty editor keeps the
    // typed characters in memory — so the confirmation said "your edits will
    // be discarded and cannot be recovered" and then visibly did not discard
    // them. Saving afterwards fails (the file is read-only again) and VS Code
    // answers with an Overwrite action that force-clears the read-only bit:
    // chmod u+w instead of checking out, offered by the editor itself.
    const { runs } = harness({
      stdout: undoOutput('C:\\work\\Vesta', 'Form1.vb'),
      pending: { 'Form1.vb': ['Edit'] },
    });
    workspace.textDocuments = [dirtyDoc(winFile('Form1.vb').fsPath)] as never;
    recorder.answers.push(S.undoConfirmYes);

    await recorder.invoke('teamExplorer.undo', winFile('Form1.vb'));

    expect(runs[0].args).toEqual(['vc', 'undo', '$/Vesta/Form1.vb']);
    expect(executed.map((e) => e.id)).toContain('workbench.action.files.revert');
    expect(shown).toHaveLength(1);
  });

  it('still reverts the buffer even when the re-scan callback throws (hardening)', async () => {
    // A throwing `alsoRefresh` must not turn `runMutation`'s promise into a
    // rejection: this handler `await`s it and only reverts buffers
    // afterwards, so a rejection here would silently skip
    // revertOpenBuffers -- leaving the dialog's promise ("your edits will be
    // discarded") broken exactly the way this describe block exists to catch.
    const { runs } = harness({
      stdout: undoOutput('C:\\work\\Vesta', 'Form1.vb'),
      alsoRefresh: () => {
        throw new Error('boom');
      },
      pending: { 'Form1.vb': ['Edit'] },
    });
    workspace.textDocuments = [dirtyDoc(winFile('Form1.vb').fsPath)] as never;
    recorder.answers.push(S.undoConfirmYes);

    await recorder.invoke('teamExplorer.undo', winFile('Form1.vb'));

    expect(runs[0].args).toEqual(['vc', 'undo', '$/Vesta/Form1.vb']);
    expect(executed.map((e) => e.id)).toContain('workbench.action.files.revert');
  });

  it('leaves a CLEAN buffer alone — VS Code reloads those itself', async () => {
    const { runs } = harness({ pending: { 'Form1.vb': ['Edit'] } });
    workspace.textDocuments = [
      { uri: winFile('Form1.vb'), isDirty: false },
    ] as never;
    recorder.answers.push(S.undoConfirmYes);

    await recorder.invoke('teamExplorer.undo', winFile('Form1.vb'));

    expect(runs).toHaveLength(1);
    expect(executed.map((e) => e.id)).not.toContain('workbench.action.files.revert');
  });

  it('does not revert anything when the undo FAILED', async () => {
    // Reverting after a failed undo would destroy edits the server still has
    // as a pending change.
    const { runs } = harness({ exitCode: 100, pending: { 'Form1.vb': ['Edit'] } });
    workspace.textDocuments = [dirtyDoc(winFile('Form1.vb').fsPath)] as never;
    recorder.answers.push(S.undoConfirmYes);

    await recorder.invoke('teamExplorer.undo', winFile('Form1.vb'));

    expect(runs).toHaveLength(1);
    expect(executed.map((e) => e.id)).not.toContain('workbench.action.files.revert');
  });

  // tf prints the folder relative to the directory it runs in (the opened
  // folder), and no folder at all for a file directly in it. Read as absolute,
  // `Integrator.Standard.POSIntegration\PayDevice:` became
  // `\Integrator.Standard.POSIntegration\PayDevice\TLVParser.cs`, matched no
  // editor, and the typed edit stayed on screen over a read-only file with no
  // pending change (observed 2026-09-29, `(1 dirty document(s) open)`).
  it('reverts when tf names the folder relative to the directory it ran in', async () => {
    harness({
      cwd: 'C:\\work',
      stdout: undoOutput('Vesta', 'Form1.vb'),
      pending: { 'Form1.vb': ['Edit'] },
    });
    workspace.textDocuments = [dirtyDoc(winFile('Form1.vb').fsPath)] as never;
    recorder.answers.push(S.undoConfirmYes);

    await recorder.invoke('teamExplorer.undo', winFile('Form1.vb'));

    expect(executed.map((e) => e.id)).toContain('workbench.action.files.revert');
    expect(outputChannel.lines.join('\n')).not.toContain('no dirty editor to revert');
  });

  it('reverts when tf names no folder, because the file is in the directory it ran in', async () => {
    harness({
      cwd: 'C:\\work\\Vesta',
      stdout: 'Undoing edit: Form1.vb\n',
      pending: { 'Form1.vb': ['Edit'] },
    });
    workspace.textDocuments = [dirtyDoc(winFile('Form1.vb').fsPath)] as never;
    recorder.answers.push(S.undoConfirmYes);

    await recorder.invoke('teamExplorer.undo', winFile('Form1.vb'));

    expect(executed.map((e) => e.id)).toContain('workbench.action.files.revert');
  });

  it('on Linux resolves the relative folder against the Wine form of the directory', async () => {
    harness({
      platform: 'linux',
      cwd: '/home/shax/work',
      stdout: undoOutput('Vesta', 'Form1.vb'),
      pending: { 'Form1.vb': ['Edit'] },
    });
    const local = '/home/shax/work/Vesta/Form1.vb';
    workspace.textDocuments = [dirtyDoc(local)] as never;
    recorder.answers.push(S.undoConfirmYes);

    await recorder.invoke('teamExplorer.undo', Uri.file(local));

    expect(executed.map((e) => e.id)).toContain('workbench.action.files.revert');
  });
});

describe('Undo buffer matching is case-insensitive on Windows', () => {
  // Windows only, and deliberately. revertOpenBuffers compares paths
  // case-insensitively ONLY on win32, because a Linux path is case-sensitive:
  // there, `c:\work\x` and `C:\work\x` would be two different files and
  // reverting one for the other would be the bug rather than the fix. Skipped
  // rather than adapted, because there is no equivalent to assert.
  it.skipIf(process.platform !== 'win32')(
    'reverts even when tf reports a different drive-letter case',
    async () => {
    // tf mixed C:\work and c:\work in one real capture. An exact compare
    // matched nothing, so the revert silently did nothing and the typed
    // characters stayed in the editor.
    const { runs } = harness({
      stdout: undoOutput('C:\\work\\Vesta', 'Form1.vb'),
      pending: { 'Form1.vb': ['Edit'] },
    });
    const lowered = winFile('Form1.vb').fsPath.replace(/^C:/, 'c:');
    workspace.textDocuments = [
      { uri: Uri.file(lowered), isDirty: true, fileName: lowered },
    ] as never;
    recorder.answers.push(S.undoConfirmYes);

    await recorder.invoke('teamExplorer.undo', winFile('Form1.vb'));

      expect(runs).toHaveLength(1);
      expect(executed.map((e) => e.id)).toContain('workbench.action.files.revert');
    },
  );

  it('says so in the log when there is nothing to revert', async () => {
    const { runs } = harness({
      stdout: undoOutput('C:\\work\\Vesta', 'Form1.vb'),
      pending: { 'Form1.vb': ['Edit'] },
    });
    workspace.textDocuments = [] as never;
    recorder.answers.push(S.undoConfirmYes);

    await recorder.invoke('teamExplorer.undo', winFile('Form1.vb'));

    expect(runs).toHaveLength(1);
    expect(outputChannel.lines.join('\n')).toContain('no dirty editor to revert');
  });
});


describe('Get Latest and the cached server copies', () => {
  it('drops the whole content cache BEFORE running the get', async () => {
    // A get only changes anything when somebody else has checked in, which is
    // exactly the event that changes what `view /version:T` returns. Without
    // this, a diff opened afterwards compares the freshly updated local file
    // against a server copy cached up to 60 s ago and invents differences.
    const { runs, invalidated } = harness();

    await recorder.invoke('teamExplorer.getLatest', winFile('Form1.vb'));

    expect(runs[0].args).toEqual(['vc', 'get', '$/Vesta/Form1.vb', '/recursive']);
    // Everything, not just the named item: /recursive updates files that were
    // never named here.
    expect(invalidated).toEqual([undefined]);
  });

  it('does not touch the cache when nothing is mapped', async () => {
    const { runs, invalidated } = harness();

    await recorder.invoke('teamExplorer.getLatest', Uri.file('C:\elsewhere\Stray.vb'));

    expect(runs).toHaveLength(0);
    expect(invalidated).toEqual([]);
  });

  it('looks for conflicts under what it got, once the get is done, even when tf exits 1 (phase 5, C1)', async () => {
    let lookedBeforeGet: boolean | undefined;
    harness({
      exitCode: 1,
      onRun: () => (lookedBeforeGet = executed.some((e) => e.id === 'teamExplorer.resolveConflicts')),
    });

    await recorder.invoke('teamExplorer.getLatest', winFile('Form1.vb'));

    expect(lookedBeforeGet).toBe(false);
    expect(executed.filter((e) => e.id === 'teamExplorer.resolveConflicts')).toEqual([
      { id: 'teamExplorer.resolveConflicts', args: [['$/Vesta/Form1.vb']] },
    ]);
  });
});

describe('the re-scan callback (Task 5: add/undo/getLatest re-scan, checkout does not)', () => {
  it('runs once after a successful add', async () => {
    const rescans: number[] = [];
    harness({ alsoRefresh: () => rescans.push(1) });

    await recorder.invoke('teamExplorer.add', winFile('New.vb'));

    expect(rescans).toHaveLength(1);
  });

  it('does not run after a failed add', async () => {
    const rescans: number[] = [];
    harness({ alsoRefresh: () => rescans.push(1), exitCode: 100 });

    await recorder.invoke('teamExplorer.add', winFile('New.vb'));

    expect(rescans).toHaveLength(0);
  });

  it('runs once after a successful undo', async () => {
    const rescans: number[] = [];
    harness({ alsoRefresh: () => rescans.push(1), pending: { 'Form1.vb': ['Edit'] } });
    recorder.answers.push(S.undoConfirmYes);

    await recorder.invoke('teamExplorer.undo', winFile('Form1.vb'));

    expect(rescans).toHaveLength(1);
  });

  it('does not run after a failed undo', async () => {
    const rescans: number[] = [];
    harness({ alsoRefresh: () => rescans.push(1), exitCode: 100, pending: { 'Form1.vb': ['Edit'] } });
    recorder.answers.push(S.undoConfirmYes);

    await recorder.invoke('teamExplorer.undo', winFile('Form1.vb'));

    expect(rescans).toHaveLength(0);
  });

  it('does not run when the undo was declined', async () => {
    const rescans: number[] = [];
    harness({ alsoRefresh: () => rescans.push(1), pending: { 'Form1.vb': ['Edit'] } });
    recorder.answers.push(undefined);

    await recorder.invoke('teamExplorer.undo', winFile('Form1.vb'));

    expect(rescans).toHaveLength(0);
  });

  it('runs once after a successful getLatest', async () => {
    const rescans: number[] = [];
    harness({ alsoRefresh: () => rescans.push(1) });

    await recorder.invoke('teamExplorer.getLatest', winFile('Form1.vb'));

    expect(rescans).toHaveLength(1);
  });

  it('does not run after a failed getLatest', async () => {
    const rescans: number[] = [];
    harness({ alsoRefresh: () => rescans.push(1), exitCode: 100 });

    await recorder.invoke('teamExplorer.getLatest', winFile('Form1.vb'));

    expect(rescans).toHaveLength(0);
  });

  it('never runs after checkout, successful or not -- a checkout changes nothing about what is versioned', async () => {
    const rescans: number[] = [];
    const ok = harness({ alsoRefresh: () => rescans.push(1) });
    await recorder.invoke('teamExplorer.checkout', winFile('Form1.vb'));
    expect(ok.runs).toHaveLength(1);
    expect(rescans).toHaveLength(0);

    recorder.reset();
    const failed = harness({ alsoRefresh: () => rescans.push(1), exitCode: 100 });
    await recorder.invoke('teamExplorer.checkout', winFile('Form1.vb'));
    expect(failed.runs).toHaveLength(1);
    expect(rescans).toHaveLength(0);
  });

  it('also runs on the killed (outcome-unknown) path, not only on a clean success', async () => {
    // A signalled child reports exitCode -1 with no way to tell success from
    // failure -- runMutation treats this as FAILED but still refreshes,
    // because a status is what resolves the ambiguity. The re-scan callback
    // follows the same rule: it is refreshing to find out, not celebrating.
    const rescans: number[] = [];
    harness({ alsoRefresh: () => rescans.push(1), terminatedBy: 'SIGTERM' });

    await recorder.invoke('teamExplorer.add', winFile('New.vb'));

    expect(rescans).toHaveLength(1);
  });
});

describe('runMutation: the afterSuccess contract directly (Task 5, requirement 1)', () => {
  function fakeClient(result: {
    stdout?: string;
    exitCode?: number;
    timedOut?: boolean;
    terminatedBy?: NodeJS.Signals;
    rejects?: Error;
  }) {
    return {
      timeoutMs: 1000,
      run: async () => {
        if (result.rejects) throw result.rejects;
        return {
          stdout: Buffer.from(result.stdout ?? ''),
          stderr: Buffer.from(''),
          exitCode: result.exitCode ?? 0,
          timedOut: result.timedOut ?? false,
          terminatedBy: result.terminatedBy,
        };
      },
    };
  }

  function fakeServiceRecordingOrder(order: string[]) {
    return {
      pendingChanges: [],
      requestRefresh: () => order.push('requestRefresh'),
      refresh: async () => undefined,
    };
  }

  it('calls afterSuccess exactly once, AFTER requestRefresh, on a clean success', async () => {
    const order: string[] = [];
    const service = fakeServiceRecordingOrder(order);

    const result = await runMutation(
      fakeClient({}) as never,
      service as never,
      outputChannel as never,
      ['vc', 'add', 'x'],
      () => order.push('afterSuccess'),
    );

    expect(result.ok).toBe(true);
    expect(order).toEqual(['requestRefresh', 'afterSuccess']);
  });

  it('calls afterSuccess exactly once, AFTER requestRefresh, on the killed (outcome-unknown) path', async () => {
    const order: string[] = [];
    const service = fakeServiceRecordingOrder(order);

    const result = await runMutation(
      fakeClient({ terminatedBy: 'SIGTERM' }) as never,
      service as never,
      outputChannel as never,
      ['vc', 'undo', 'x'],
      () => order.push('afterSuccess'),
    );

    expect(result.ok).toBe(false);
    expect(order).toEqual(['requestRefresh', 'afterSuccess']);
  });

  it('never calls afterSuccess on a plain failure', async () => {
    let called = false;
    const service = { pendingChanges: [], requestRefresh: () => {}, refresh: async () => undefined };

    await runMutation(
      fakeClient({ exitCode: 100 }) as never,
      service as never,
      outputChannel as never,
      ['vc', 'undo', 'x'],
      () => { called = true; },
    );

    expect(called).toBe(false);
  });

  it('never calls afterSuccess on a timeout', async () => {
    let called = false;
    const service = { pendingChanges: [], requestRefresh: () => {}, refresh: async () => undefined };

    await runMutation(
      fakeClient({ timedOut: true, exitCode: -1 }) as never,
      service as never,
      outputChannel as never,
      ['vc', 'undo', 'x'],
      () => { called = true; },
    );

    expect(called).toBe(false);
  });

  it('never calls afterSuccess when the spawn itself rejects', async () => {
    let called = false;
    const service = { pendingChanges: [], requestRefresh: () => {}, refresh: async () => undefined };

    await runMutation(
      fakeClient({ rejects: new Error('spawn ENOENT') }) as never,
      service as never,
      outputChannel as never,
      ['vc', 'undo', 'x'],
      () => { called = true; },
    );

    expect(called).toBe(false);
  });

  it('is optional: omitting it changes nothing about an otherwise successful run', async () => {
    const service = { pendingChanges: [], requestRefresh: () => {}, refresh: async () => undefined };

    const result = await runMutation(
      fakeClient({}) as never,
      service as never,
      outputChannel as never,
      ['vc', 'add', 'x'],
    );

    expect(result.ok).toBe(true);
  });

  it('never lets a throwing afterSuccess turn a successful run into a rejection (hardening)', async () => {
    // A rejection here would propagate out of `runMutation`'s own promise, and
    // every caller `await`s it BEFORE its own follow-up work -- Undo's
    // revertOpenBuffers, Check In's cache invalidation and auto-checkout
    // reset. The re-scan callback is a courtesy, not part of the mutation
    // that already succeeded, and must never be able to skip any of that.
    const service = { pendingChanges: [], requestRefresh: () => {}, refresh: async () => undefined };

    const result = await runMutation(
      fakeClient({}) as never,
      service as never,
      outputChannel as never,
      ['vc', 'add', 'x'],
      () => {
        throw new Error('afterSuccess boom');
      },
    );

    expect(result.ok).toBe(true);
    expect(outputChannel.lines.join('\n')).toContain('afterSuccess boom');
  });
});

describe('plan 3: commands that cannot know whether they apply', () => {
  it('Undo on a file with nothing pending says so, asks nothing and runs nothing', async () => {
    const { runs } = harness();

    await recorder.invoke('teamExplorer.undo', winFile('Clean.vb'));

    expect(runs).toHaveLength(0);
    expect(recorder.messages).toEqual([
      { kind: 'info', message: S.nothingPendingOn(['Clean.vb']), modal: false, items: [] },
    ]);
  });

  it('Undo on a selection spanning an untracked row undoes only the pending file', async () => {
    // VS Code hands the command the whole selection, whichever row was
    // right-clicked, and does not filter it by group.
    const { runs } = harness({ pending: { 'Form1.vb': ['Edit'] } });
    // The mock hands one queued answer to every message it shows, the
    // "nothing pending" information message included, and that one is shown
    // first -- so it needs an answer of its own ahead of the confirm's.
    recorder.answers.push(undefined, S.undoConfirmYes);

    await recorder.invoke('teamExplorer.undo', winFile('Form1.vb'), [winFile('Form1.vb'), winFile('New.vb')]);

    expect(recorder.shown).toContain(S.nothingPendingOn(['New.vb']));
    expect(recorder.messages.find((m) => m.modal)!.message).toContain('1 item ');
    expect(runs[0].args).toEqual(['vc', 'undo', '$/Vesta/Form1.vb']);
  });

  it("Undo's idle check matches the pending cache case-insensitively", async () => {
    // tf's own casing on the server side need not match the casing of the
    // path on disk -- `covers()` lowercases both sides for this reason
    // everywhere else in this file, and the idle check must not be the one
    // place that forgets to.
    const { runs } = harness({ pending: { 'FORM1.VB': ['Edit'] } });
    recorder.answers.push(S.undoConfirmYes);

    await recorder.invoke('teamExplorer.undo', winFile('Form1.vb'));

    expect(recorder.shown).not.toContain(S.nothingPendingOn(['Form1.vb']));
    expect(runs[0].args).toEqual(['vc', 'undo', '$/Vesta/Form1.vb']);
  });

  it('Check Out on a file already checked out says so and runs nothing', async () => {
    const { runs } = harness({ pending: { 'Form1.vb': ['Edit'] } });

    await recorder.invoke('teamExplorer.checkout', winFile('Form1.vb'));

    expect(runs).toHaveLength(0);
    expect(recorder.shown).toEqual([S.alreadyCheckedOut(['Form1.vb'])]);
  });

  it('Check Out still runs on a pending rename, which leaves the file read-only', async () => {
    const { runs } = harness({ pending: { 'Moved.vb': ['Rename'] } });

    await recorder.invoke('teamExplorer.checkout', winFile('Moved.vb'));

    expect(runs[0].args).toEqual(['vc', 'checkout', '$/Vesta/Moved.vb']);
  });

  it('Add on a file with a pending Edit says it is already in source control', async () => {
    // Judged from the pending cache, not the unversioned-files scan: the scan
    // (`reconcile /adds /preview`) never lists a file that already has a
    // pending change, so it cannot be asked here at all.
    const { runs } = harness({ pending: { 'Form1.vb': ['Edit'] } });

    await recorder.invoke('teamExplorer.add', winFile('Form1.vb'));

    expect(runs).toHaveLength(0);
    expect(recorder.shown).toEqual([S.alreadyInSourceControl(['Form1.vb'])]);
  });

  it('Add on a file with a pending Add says it is already added, not checked in yet', async () => {
    const { runs } = harness({ pending: { 'New.vb': ['Add'] } });

    await recorder.invoke('teamExplorer.add', winFile('New.vb'));

    expect(runs).toHaveLength(0);
    expect(recorder.shown).toEqual([S.alreadyAdded(['New.vb'])]);
  });

  it('Add on a pending Rename or a pending Delete says already in source control', async () => {
    const { runs } = harness({
      pending: { 'Moved.vb': ['Rename'], 'Gone.vb': ['Delete'] },
    });

    await recorder.invoke('teamExplorer.add', winFile('Moved.vb'), [
      winFile('Moved.vb'),
      winFile('Gone.vb'),
    ]);

    expect(runs).toHaveLength(0);
    expect(recorder.shown).toEqual([S.alreadyInSourceControl(['Moved.vb', 'Gone.vb'])]);
  });

  it('Add still runs on a file with nothing pending, however the scan reads it', async () => {
    // A Windows copy of a checked-in file keeps the read-only bit, and the
    // scan may be stale in the other direction too (see the comment on
    // `known` in commands/index.ts) -- only the pending cache can refuse Add,
    // and it has nothing to say about a copy nobody ever added.
    const { runs } = harness();

    await recorder.invoke('teamExplorer.add', winFile('Form1 - Copy.vb'));

    expect(runs[0].args).toEqual(['vc', 'add', winFile('Form1 - Copy.vb').fsPath]);
  });

  it('Add on a mixed selection adds only the file with nothing pending', async () => {
    const { runs } = harness({ pending: { 'Form1.vb': ['Edit'] } });

    await recorder.invoke('teamExplorer.add', winFile('Form1.vb'), [winFile('Form1.vb'), winFile('Fresh.vb')]);

    expect(recorder.shown).toEqual([S.alreadyInSourceControl(['Form1.vb'])]);
    expect(runs[0].args).toEqual(['vc', 'add', winFile('Fresh.vb').fsPath]);
  });

  it('Exclude and Include keep only items with a pending change', async () => {
    const { excludedCalls } = harness({ pending: { 'Form1.vb': ['Edit'] } });

    await recorder.invoke('teamExplorer.exclude', winFile('Form1.vb'), [winFile('Form1.vb'), winFile('New.vb')]);
    await recorder.invoke('teamExplorer.include', winFile('Form1.vb'), [winFile('Form1.vb'), winFile('New.vb')]);

    expect(excludedCalls).toEqual([
      [['$/Vesta/Form1.vb'], true],
      [['$/Vesta/Form1.vb'], false],
    ]);
  });

  it('names at most three files, then how many more', () => {
    expect(S.nothingPendingOn(['a', 'b', 'c', 'd', 'e'])).toBe('Nothing is pending on a, b, c and 2 more.');
    expect(S.alreadyCheckedOut(['a', 'b'])).toBe('a, b are already checked out.');
  });
});
