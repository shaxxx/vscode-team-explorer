import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { registerCheckIn } from '../../src/commands/checkIn.js';
import { PathMapper } from '../../src/tf/PathMapper.js';
import { recorder, outputChannel, Uri } from '../vscode-mock.js';
import { S } from '../../src/tf/strings.js';

/**
 * The most dangerous path in the extension had no behavioural coverage at all:
 * the only test read the SOURCE as text. Nothing verified that the modal is
 * shown before tf runs, that declining runs nothing, that the confirmed count
 * matches what is actually sent, or that the input box survives a failure.
 */

type Change = { serverItem: string; localPath?: string };

function build(
  opts: { included?: Change[]; comment?: string; exitCode?: number; rescan?: () => void } = {},
) {
  const runs: string[][] = [];
  const included =
    opts.included ?? [{ serverItem: '$/Vesta/A.vb', localPath: 'C:\\work\\Vesta\\A.vb' }];
  /** Paths whose auto-checkout one-shot guard was cleared. */
  const reset: string[] = [];
  // The comment file is deleted in a `finally` as soon as the command returns
  // — correctly — so its contents must be captured WHILE tf would be reading
  // them, not afterwards.
  const commentSeen: string[] = [];

  const client = {
    timeoutMs: 1000,
    run: async (args: string[]) => {
      runs.push(args);
      const arg = args.find((a) => a.startsWith('/comment:@'));
      if (arg) commentSeen.push(readFileSync(arg.slice('/comment:@'.length), 'utf8'));
      return {
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        exitCode: opts.exitCode ?? 0,
        timedOut: false,
      };
    },
  };

  const mapper = new PathMapper(
    [{ serverItem: '$/Vesta', localPath: 'C:\\work\\Vesta' }],
    'win32',
  );
  const service = { pathMapper: mapper, requestRefresh() {}, refresh: async () => undefined };

  const scm = {
    includedChanges: included,
    inputBoxValue: opts.comment ?? '',
    cleared: false,
    clearInputBox() {
      this.cleared = true;
    },
  };

  const context = { subscriptions: [] as { dispose(): void }[] };
  registerCheckIn(
    context as never,
    client as never,
    service as never,
    scm as never,
    outputChannel as never,
    { reset: (p: string) => void reset.push(p) },
    undefined,
    opts.rescan,
  );
  return { runs, scm, commentSeen, reset };
}

beforeEach(() => {
  recorder.reset();
  outputChannel.clear();
});

describe('Check In', () => {
  it('runs NOTHING until the modal is confirmed', async () => {
    const { runs, scm } = build({ comment: 'fix' });
    recorder.answers.push(undefined); // dismissed

    await recorder.invoke('teamExplorer.checkInFromButton');

    expect(runs, 'tf ran without confirmation').toEqual([]);
    expect(scm.cleared).toBe(false);
    const dialog = recorder.messages.at(-1)!;
    expect(dialog.modal).toBe(true);
    expect(dialog.items).toContain(S.checkInConfirmYes);
    expect(dialog.message).toContain('cannot be undone');
  });

  it('sends exactly the items the dialog counted', async () => {
    const included = [
      { serverItem: '$/Vesta/A.vb' },
      { serverItem: '$/Vesta/B.vb' },
      { serverItem: '$/Vesta/C.vb' },
    ];
    const { runs } = build({ included });
    recorder.answers.push(S.checkInConfirmYes);

    await recorder.invoke('teamExplorer.checkInFromButton');

    expect(recorder.messages.at(-1)!.message).toContain('3 items');
    const items = runs[0].filter((a) => a.startsWith('$/'));
    expect(items).toEqual(included.map((c) => c.serverItem));
  });

  it('passes the comment as @file, never on the command line', async () => {
    // A command-line comment is still subject to %VAR% expansion, so `%PATH%`
    // would land expanded in permanent TFVC history, and a newline truncates.
    const { runs, commentSeen } = build({ comment: 'fixed %PATH% and 100% of it' });
    recorder.answers.push(S.checkInConfirmYes);

    await recorder.invoke('teamExplorer.checkInFromButton');

    const commentArg = runs[0].find((a) => a.startsWith('/comment:'))!;
    expect(commentArg.startsWith('/comment:@')).toBe(true);
    expect(commentArg).not.toContain('%PATH%');

    // Written WITH a BOM: tf.exe is .NET and detects one, which is what keeps
    // \u010D \u0107 \u017E \u0161 \u0111 intact in a comment. This is the inverse of the pat.txt rule.
    expect(commentSeen).toEqual(['\uFEFFfixed %PATH% and 100% of it']);
  });

  it('sends no comment argument when the box is empty', async () => {
    const { runs } = build({ comment: '   ' });
    recorder.answers.push(S.checkInConfirmYes);

    await recorder.invoke('teamExplorer.checkInFromButton');

    expect(runs[0].some((a) => a.startsWith('/comment:'))).toBe(false);
  });

  it('clears the input box only on success', async () => {
    const ok = build({ comment: 'fix' });
    recorder.answers.push(S.checkInConfirmYes);
    await recorder.invoke('teamExplorer.checkInFromButton');
    expect(ok.scm.cleared).toBe(true);

    recorder.reset();
    const failed = build({ comment: 'fix', exitCode: 100 });
    recorder.answers.push(S.checkInConfirmYes);
    await recorder.invoke('teamExplorer.checkInFromButton');
    expect(failed.scm.cleared, 'a failed check-in must keep the comment').toBe(false);
  });

  it('does nothing at all when there is nothing included', async () => {
    const { runs } = build({ included: [] });

    await recorder.invoke('teamExplorer.checkInFromButton');

    expect(runs).toEqual([]);
    expect(recorder.messages.filter((m) => m.modal)).toEqual([]);
  });

  it('never leaves the comment file behind', async () => {
    const { runs } = build({ comment: 'fix' });
    recorder.answers.push(S.checkInConfirmYes);

    await recorder.invoke('teamExplorer.checkInFromButton');

    const path = runs[0].find((a) => a.startsWith('/comment:@'))!.slice('/comment:@'.length);
    expect(() => readFileSync(path, 'utf8')).toThrow();
  });

  describe('the re-scan callback (Task 5)', () => {
    it('runs once after a successful check-in', async () => {
      const rescans: number[] = [];
      build({ comment: 'fix', rescan: () => rescans.push(1) });
      recorder.answers.push(S.checkInConfirmYes);

      await recorder.invoke('teamExplorer.checkInFromButton');

      expect(rescans).toHaveLength(1);
    });

    it('does not run after a failed check-in', async () => {
      const rescans: number[] = [];
      build({ comment: 'fix', exitCode: 100, rescan: () => rescans.push(1) });
      recorder.answers.push(S.checkInConfirmYes);

      await recorder.invoke('teamExplorer.checkInFromButton');

      expect(rescans).toHaveLength(0);
    });

    it('does not run when the confirmation was declined', async () => {
      const rescans: number[] = [];
      build({ comment: 'fix', rescan: () => rescans.push(1) });
      recorder.answers.push(undefined);

      await recorder.invoke('teamExplorer.checkInFromButton');

      expect(rescans).toHaveLength(0);
    });
  });
});
