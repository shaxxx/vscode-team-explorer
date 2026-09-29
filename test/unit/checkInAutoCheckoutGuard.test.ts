import { describe, it, expect, beforeEach } from 'vitest';
import { registerCheckIn } from '../../src/commands/checkIn.js';
import { PathMapper } from '../../src/tf/PathMapper.js';
import { recorder, outputChannel } from '../vscode-mock.js';
import { S } from '../../src/tf/strings.js';

/**
 * Observed on DEVPC, and it ends at the one dialog CLAUDE.md forbids.
 *
 *   1. NetUtils.cs is edited. Auto-checkout runs and marks it `attempted` -
 *      the guard allows ONE attempt per file per session.
 *   2. The content ends up matching the server, so `tf vc checkin` reports
 *      "The following changes were not checked in because the items were not
 *      modified. Undoing edit: ..." and makes the file read-only again.
 *   3. Nothing clears the guard: registerCheckIn never received AutoCheckout
 *      at all.
 *   4. The next edit hits `attempted` and is skipped. The file stays
 *      read-only, the save fails, and VS Code offers **Overwrite**, which
 *      clears the read-only bit and writes behind TFVC's back.
 *
 * The user did nothing wrong at any step.
 */

function build(opts: { exitCode?: number; included?: { serverItem: string; localPath: string }[] } = {}) {
  const reset: string[] = [];
  const included = opts.included ?? [
    { serverItem: '$/Vesta/A.vb', localPath: 'C:\\work\\Vesta\\A.vb' },
  ];

  const client = {
    timeoutMs: 1000,
    run: async () => ({
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      exitCode: opts.exitCode ?? 0,
      timedOut: false,
    }),
  };

  const service = {
    pathMapper: new PathMapper([{ serverItem: '$/Vesta', localPath: 'C:\\work\\Vesta' }], 'win32'),
    requestRefresh() {},
    refresh: async () => undefined,
  };

  const scm = {
    includedChanges: included,
    inputBoxValue: '',
    cleared: false,
    clearInputBox() {
      this.cleared = true;
    },
  };

  registerCheckIn(
    { subscriptions: [] } as never,
    client as never,
    service as never,
    scm as never,
    outputChannel as never,
    { reset: (p: string) => void reset.push(p) },
  );
  return { reset, scm };
}

beforeEach(() => {
  recorder.reset();
  outputChannel.clear();
});

describe('check-in clears the auto-checkout guard', () => {
  it('after a successful check-in', async () => {
    const { reset } = build();
    recorder.answers.push(S.checkInConfirmYes);

    await recorder.invoke('teamExplorer.checkInFromButton');

    expect(reset).toEqual(['C:\\work\\Vesta\\A.vb']);
  });

  it('after a FAILED one too, which is the case that actually trapped the user', async () => {
    // `tf vc checkin` undoes a pending edit it considers unmodified and then
    // exits non-zero with "There are no remaining changes to check in." The
    // file is read-only again either way, so resetting only on success leaves
    // exactly the trap this exists to prevent.
    const { reset, scm } = build({ exitCode: 100 });
    recorder.answers.push(S.checkInConfirmYes);

    await recorder.invoke('teamExplorer.checkInFromButton');

    expect(reset).toEqual(['C:\\work\\Vesta\\A.vb']);
    expect(scm.cleared, 'a failed check-in must not clear the comment').toBe(false);
  });

  it('for every file submitted, not just the first', async () => {
    const { reset } = build({
      included: [
        { serverItem: '$/Vesta/A.vb', localPath: 'C:\\work\\Vesta\\A.vb' },
        { serverItem: '$/Vesta/B.vb', localPath: 'C:\\work\\Vesta\\B.vb' },
      ],
    });
    recorder.answers.push(S.checkInConfirmYes);

    await recorder.invoke('teamExplorer.checkInFromButton');

    expect(reset).toEqual(['C:\\work\\Vesta\\A.vb', 'C:\\work\\Vesta\\B.vb']);
  });

  it('does NOT clear anything when the user declines the dialog', async () => {
    // Nothing ran, so nothing changed on disk, and the guard still reflects
    // reality. Clearing here would quietly grant an extra checkout attempt.
    const { reset } = build();
    recorder.answers.push(undefined);

    await recorder.invoke('teamExplorer.checkInFromButton');

    expect(reset).toEqual([]);
  });

  it('resets the LOCAL path, since that is what AutoCheckout is keyed on', async () => {
    // AutoCheckout sees vscode.TextDocument.uri.fsPath. Passing the server
    // item, or an untranslated Wine path, would clear nothing at all - and
    // would look exactly like a working fix.
    const { reset } = build();
    recorder.answers.push(S.checkInConfirmYes);

    await recorder.invoke('teamExplorer.checkInFromButton');

    expect(reset[0]).not.toMatch(/^\$\//);
    expect(reset[0]).toBe('C:\\work\\Vesta\\A.vb');
  });
});
