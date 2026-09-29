import { describe, it, expect, beforeEach } from 'vitest';
import { registerCommands } from '../../src/commands/index.js';
import { PathMapper } from '../../src/tf/PathMapper.js';
import { recorder, outputChannel, Uri } from '../vscode-mock.js';

/**
 * tf returns a non-zero exit for "I skipped some of that" as well as for "none
 * of that worked". A folder Add that really did pend three items showed a red
 * error and left the panel stale, because the refresh only ran on success.
 *
 * The first fix was a GENERAL rule — non-zero, but tf listed items it touched,
 * so call it partial success. A review drove the real code and proved that
 * downgraded a REFUSED CHECK-IN to an information message, clearing the user's
 * typed comment for a check-in that never happened. `Access Denied`, `401
 * Unauthorized` and `Authentication failed` all classify as `unknown` with no
 * TF##### code, and `scanAffectedItems` treats any line ending in `:` as a
 * directory header, so it manufactured items out of failure text.
 *
 * So the rule is now: `vc add` only, and only when stderr carries tf's own
 * exclusion notice. If tf is ever localized this stops matching and the old
 * fatal behaviour returns, which is the safe direction to fail in.
 *
 * The outputs below are VERBATIM from the live collection on 2026-09-17.
 */

// A folder add where tf pended everything except an excluded file. Exit 1.
const PARTIAL_STDOUT = [
  'work\\Shop:',
  'tfvc-x2',
  '',
  'work\\Shop\\tfvc-x2:',
  'real.txt',
].join('\n');
const PARTIAL_STDERR = 'Items matching the following exclusions were ignored: *.exe';

// A path that matched nothing. Also exit 1, and nothing was done.
const NOTHING_STDOUT = 'Z:\\home\\shax\\work\\Shop\\tfvc-nonexistent: No file matches.';

// A wholly clean add. Exit 0.
const CLEAN_STDOUT = ['work\\Shop:', 'tfvc-x3', '', 'work\\Shop\\tfvc-x3:', 'clean.txt'].join('\n');

function harness(opts: {
  stdout: string;
  stderr?: string;
  exitCode: number;
  terminatedBy?: NodeJS.Signals;
}) {
  let refreshes = 0;
  const mapper = new PathMapper([{ serverItem: '$/Vesta', localPath: 'C:\\work\\Vesta' }], 'win32');

  const client = {
    timeoutMs: 1000,
    run: async () => ({
      stdout: Buffer.from(opts.stdout),
      stderr: Buffer.from(opts.stderr ?? ''),
      exitCode: opts.exitCode,
      timedOut: false,
      terminatedBy: opts.terminatedBy,
    }),
  };
  const service = {
    pathMapper: mapper,
    requestRefresh() {
      refreshes++;
    },
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

  return { refreshes: () => refreshes };
}

const file = (name: string) => Uri.file(`C:\\work\\Vesta\\${name}`);

beforeEach(() => {
  recorder.reset();
  outputChannel.clear();
});

describe('a non-zero exit that still did real work', () => {
  it('refreshes the panel, which is the whole bug', async () => {
    // Without this the panel kept showing the pre-add state and the user
    // reasonably concluded the Add had done nothing.
    const h = harness({ stdout: PARTIAL_STDOUT, stderr: PARTIAL_STDERR, exitCode: 1 });

    await recorder.invoke('teamExplorer.add', file('New.vb'));

    expect(h.refreshes(), 'the panel was never told anything changed').toBe(1);
  });

  it('does not cry failure over it', async () => {
    const h = harness({ stdout: PARTIAL_STDOUT, stderr: PARTIAL_STDERR, exitCode: 1 });

    await recorder.invoke('teamExplorer.add', file('New.vb'));

    expect(recorder.messages.filter((m) => m.kind === 'error')).toHaveLength(0);
  });

  it("passes on tf's own account of what it skipped", async () => {
    // The user needs to know the .exe did not go in. Saying nothing would be
    // the opposite failure to shouting.
    const h = harness({ stdout: PARTIAL_STDOUT, stderr: PARTIAL_STDERR, exitCode: 1 });

    await recorder.invoke('teamExplorer.add', file('New.vb'));

    const info = recorder.messages.filter((m) => m.kind === 'info');
    expect(info).toHaveLength(1);
    expect(info[0].message).toContain('*.exe');
  });
});

describe('a non-zero exit that did nothing at all', () => {
  it('is still reported as an error, and does NOT refresh', async () => {
    // Same exit code as the partial case. Only the output distinguishes them:
    // "No file matches." carries no directory header, so no item is counted.
    const h = harness({ stdout: NOTHING_STDOUT, exitCode: 1 });

    await recorder.invoke('teamExplorer.add', file('New.vb'));

    expect(recorder.messages.filter((m) => m.kind === 'error')).toHaveLength(1);
    expect(h.refreshes(), 'refreshed after a command that did nothing').toBe(0);
  });
});

describe('the downgrade is add-only', () => {
  it('never applies to a check-in, whatever tf printed', async () => {
    // The finding that forced the rule to narrow. `Access Denied: ... needs
    // Check in permission(s)` carries no TF##### code, so the general rule
    // classified it `unknown`, saw items in stdout, and returned success --
    // which cleared the comment box for a check-in that did not happen.
    const h = harness({
      stdout: PARTIAL_STDOUT,
      stderr: 'Access Denied: Filip needs Check in permission(s) for $/Vesta.',
      exitCode: 1,
    });

    await recorder.invoke('teamExplorer.add', file('New.vb'));

    expect(recorder.messages.filter((m) => m.kind === 'error')).toHaveLength(1);
    expect(recorder.messages.filter((m) => m.kind === 'info')).toHaveLength(0);
    expect(h.refreshes()).toBe(0);
  });

  it('never applies to an auth failure that carries no TF code', async () => {
    const h = harness({
      stdout: PARTIAL_STDOUT,
      stderr: 'The remote server returned an error: (401) Unauthorized.',
      exitCode: 1,
    });

    await recorder.invoke('teamExplorer.add', file('New.vb'));

    expect(recorder.messages.filter((m) => m.kind === 'error')).toHaveLength(1);
    expect(h.refreshes()).toBe(0);
  });

  it('shows the exclusion notice, not whatever Wine printed first', async () => {
    // Under Wine, stderr's first line is routinely fixme: noise, which the
    // first version surfaced while suppressing the line that mattered.
    harness({
      stdout: PARTIAL_STDOUT,
      stderr: 'fixme:ntdll:NtQuerySystemInformation info_class 8\n' + PARTIAL_STDERR,
      exitCode: 1,
    });

    await recorder.invoke('teamExplorer.add', file('New.vb'));

    const info = recorder.messages.filter((m) => m.kind === 'info');
    expect(info).toHaveLength(1);
    expect(info[0].message).toContain('*.exe');
    expect(info[0].message).not.toContain('fixme');
  });
});

describe('a recognised failure', () => {
  it('stays fatal even when tf printed a file list first', async () => {
    // The downgrade is for unrecognised errors only. A TF##### code or an auth
    // failure must not be softened into an information message because some
    // earlier item happened to succeed — that is how a rejected PAT would come
    // to look like a normal day.
    const h = harness({
      stdout: PARTIAL_STDOUT,
      stderr: 'TF30063: You are not authorized to access https://acme.visualstudio.com/.',
      exitCode: 1,
    });

    await recorder.invoke('teamExplorer.add', file('New.vb'));

    expect(recorder.messages.filter((m) => m.kind === 'error')).toHaveLength(1);
    expect(h.refreshes()).toBe(0);
  });
});

describe('a clean run', () => {
  it('refreshes and says nothing at all', async () => {
    const h = harness({ stdout: CLEAN_STDOUT, exitCode: 0 });

    await recorder.invoke('teamExplorer.add', file('New.vb'));

    expect(h.refreshes()).toBe(1);
    expect(recorder.messages, 'a silent success should stay silent').toHaveLength(0);
  });
});

describe('a command that was KILLED rather than exiting', () => {
  /**
   * Observed on FEDORA, 2026-09-18, during acceptance item 22. A checkout that
   * had already made the file writable and written its success listing came
   * back as `exit -1` and was shown as a red error whose entire text was tf's
   * own SUCCESS output:
   *
   *     CardGatewayTool\CardGatewayTool:
   *     IMessageHandler.cs
   *
   * Node reports a signalled child as `code === null`; the handler recorded
   * `code ?? -1` and dropped the signal, so "killed" and "returned -1" became
   * indistinguishable. It took 2237 ms, the slowest command in that log by
   * 600 ms, and did not reproduce in seven attempts -- it is a race, which is
   * exactly why it needs a test rather than a repro.
   */
  it('says the outcome is unknown, not that it failed', async () => {
    const h = harness({ stdout: CLEAN_STDOUT, exitCode: -1, terminatedBy: 'SIGTERM' });

    await recorder.invoke('teamExplorer.add', file('New.vb'));

    expect(recorder.messages.filter((m) => m.kind === 'error')).toHaveLength(0);
    const warnings = recorder.messages.filter((m) => m.kind === 'warning');
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain('stopped');
    expect(warnings[0].message).toContain('SIGTERM');
  });

  it('refreshes anyway, because status is what actually knows', async () => {
    const h = harness({ stdout: CLEAN_STDOUT, exitCode: -1, terminatedBy: 'SIGTERM' });

    await recorder.invoke('teamExplorer.add', file('New.vb'));

    expect(h.refreshes()).toBe(1);
  });

  it('never shows tf output as if it were an error message', async () => {
    // The specific harm: the user saw a success listing in a red dialog, and
    // for a mutation "it failed" invites a retry. For checkin, retrying an
    // operation that may already have committed is the one thing that must
    // not happen.
    const h = harness({ stdout: CLEAN_STDOUT, exitCode: -1, terminatedBy: 'SIGKILL' });

    await recorder.invoke('teamExplorer.add', file('New.vb'));

    expect(recorder.messages.filter((m) => m.kind === 'error')).toHaveLength(0);
    expect(recorder.shown.join(' ')).not.toContain('clean.txt');
  });
});
