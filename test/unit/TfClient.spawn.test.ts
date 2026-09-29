import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  TfClient,
  quoteForCmd,
  buildCmdLine,
  cmdLineBudget,
  CMD_LINE_LIMIT,
  TOO_MANY_ITEMS_PREFIX,
  WRAPPER_NOT_FOUND_PREFIX,
  classifyError,
} from '../../src/tf/TfClient.js';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Use node itself as a stand-in for the wrapper, so these tests spawn a real
// process without needing tf.exe, Wine, or the network.
const nodeExe = process.execPath;

describe('TfClient.run', () => {
  it('captures stdout as a Buffer, preserving non-UTF-8 bytes', async () => {
    const client = new TfClient({
      wrapperPath: nodeExe,
      timeoutMs: 10_000,
      argsPrefix: ['-e', 'process.stdout.write(Buffer.from([0x9e,0x0d,0x0a]))'],
    });

    const result = await client.run([]);

    expect(Buffer.isBuffer(result.stdout)).toBe(true);
    expect([...result.stdout]).toEqual([0x9e, 0x0d, 0x0a]);
    expect(result.exitCode).toBe(0);
  });

  it('reports a non-zero exit code', async () => {
    const client = new TfClient({
      wrapperPath: nodeExe,
      timeoutMs: 10_000,
      argsPrefix: ['-e', 'process.exit(100)'],
    });

    expect((await client.run([])).exitCode).toBe(100);
  });

  it('times out and kills the process', async () => {
    const client = new TfClient({
      wrapperPath: nodeExe,
      timeoutMs: 200,
      argsPrefix: ['-e', 'setTimeout(()=>{}, 30000)'],
    });

    const result = await client.run([]);
    expect(result.timedOut).toBe(true);
  });

  it('passes an argument containing spaces as ONE argument', async () => {
    const client = new TfClient({
      wrapperPath: nodeExe,
      timeoutMs: 10_000,
      argsPrefix: ['-e', 'console.log(JSON.stringify(process.argv.slice(1)))'],
    });

    const result = await client.run(['$/Warehouses/vbpWarehouses/Form1.vb']);

    expect(JSON.parse(result.stdout.toString('utf8')))
      .toEqual(['$/Warehouses/vbpWarehouses/Form1.vb']);
  });

  it('does not execute shell metacharacters in an argument', async () => {
    const client = new TfClient({
      wrapperPath: nodeExe,
      timeoutMs: 10_000,
      argsPrefix: ['-e', 'console.log(JSON.stringify(process.argv.slice(1)))'],
    });

    const evil = '/comment:fixed A&echo INJECTED&rem B';
    const result = await client.run([evil]);
    const lines = result.stdout.toString('utf8').trim().split(/\r?\n/);

    // Exactly one line means nothing else ran: had the `&` been interpreted,
    // `echo` would have produced a second line of its own. Asserting on the
    // absence of "INJECTED" cannot work here — it is a substring of the very
    // payload the other assertion requires to survive intact.
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual([evil]);
  });

  it('does NOT report a command that finished as having timed out', async () => {
    // The timer sets timedOut and only then kills. A child already closing
    // delivers its real exit code afterwards, which used to resolve as
    // {exitCode: 0, timedOut: true} — measured 150/150 when the child exits at
    // exactly timeoutMs. Every consumer checks timedOut FIRST, so a check-in
    // that committed was reported as a timeout: the files stayed in the panel,
    // the comment stayed in the box, and the next click repeated an operation
    // that cannot be undone.
    const client = new TfClient({
      wrapperPath: nodeExe,
      timeoutMs: 120,
      argsPrefix: ['-e', 'setTimeout(()=>{process.stdout.write("DONE")}, 120)'],
    });

    const result = await client.run([]);

    if (result.exitCode === 0) {
      expect(result.timedOut, 'exit 0 means it finished, whatever the clock said').toBe(false);
      expect(result.stdout.toString('utf8')).toBe('DONE');
    } else {
      // It really was killed before finishing — then timedOut is correct.
      expect(result.timedOut).toBe(true);
    }
  }, 20_000);

  it('still reports a genuine timeout, so the fix is not a blanket suppression', async () => {
    const client = new TfClient({
      wrapperPath: nodeExe,
      timeoutMs: 200,
      argsPrefix: ['-e', 'setTimeout(()=>{}, 30000)'],
    });

    const result = await client.run([]);

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
  }, 20_000);

  it('surfaces the reason when the wrapper cannot be spawned', async () => {
    // A BARE name, not an absolute path: the wrapper-exists refusal (see "a
    // wrapper that does not exist" below) only checks an absolute path --
    // `isAbsolute` is posix on Linux, so an absolute Windows-shaped path like
    // `C:\...` is NOT absolute there, and would silently skip the refusal on
    // one platform but not the other. A bare name is left to PATH lookup on
    // every platform, which only the spawn itself can do, so this always
    // reaches Node's 'error' event -- the discarded-reason bug this test
    // exists to pin -- and never the refusal above.
    const client = new TfClient({
      wrapperPath: 'tfvc-definitely-not-a-command',
      timeoutMs: 5_000,
    });

    const result = await client.run(['vc', 'status']);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString('utf8')).toContain('ENOENT');
  });

  describe('the reconcile / /preview guard (S2)', () => {
    // Ordinary two-token `-e <script>` prefix, not a flag-shaped single
    // token: the guard is checked against `args` alone (see TfClient.ts), so
    // this prefix's bare script text -- which is not `vc` and does not start
    // with `/` or `-` -- must not be able to pass for the verb.
    const echoArgv = ['-e', 'console.log(JSON.stringify(process.argv.slice(1)))'];

    it('refuses a reconcile with no /preview, and never spawns it', async () => {
      // Defence in depth for the one property the unversioned-files scan
      // rests on: /preview is what makes `tf vc reconcile /promote /adds`
      // list changes instead of PENDING them. A missing /preview, added to a
      // second call site that no other test caught, once pended 79,929
      // changes against a real workspace. If this were spawned, the argsPrefix
      // script below would print something; asserting empty stdout is what
      // proves it never ran.
      const client = new TfClient({
        wrapperPath: nodeExe,
        timeoutMs: 10_000,
        argsPrefix: echoArgv,
      });

      const result = await client.run(['vc', 'reconcile', '/promote', '/adds']);

      expect(result.exitCode).toBe(-1);
      expect(result.stdout.toString('utf8')).toBe('');
      expect(result.stderr.toString('utf8')).toContain('/preview');
    });

    it('does not refuse a reconcile that includes /preview', async () => {
      const client = new TfClient({
        wrapperPath: nodeExe,
        timeoutMs: 10_000,
        argsPrefix: echoArgv,
      });

      const result = await client.run(['vc', 'reconcile', '/promote', '/adds', '/preview']);

      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout.toString('utf8')))
        .toEqual(['vc', 'reconcile', '/promote', '/adds', '/preview']);
    });

    it('is case-insensitive about both the verb and /preview', async () => {
      const client = new TfClient({
        wrapperPath: nodeExe,
        timeoutMs: 10_000,
        argsPrefix: echoArgv,
      });

      // Refused: RECONCILE with no /preview anywhere.
      const refused = await client.run(['VC', 'RECONCILE', '/promote']);
      expect(refused.exitCode).toBe(-1);

      // Allowed: the verb and /preview spelled differently than the scan spells them.
      const allowed = await client.run(['vc', 'Reconcile', '/PREVIEW']);
      expect(allowed.exitCode).toBe(0);
    });

    it('refuses a reconcile with no /preview even with no leading "vc"', async () => {
      // TF.exe accepts a verb with no `vc` at all (tfp's own usage: `tfp
      // checkout ...`, `tfp status /recursive`), so the guard must not key on
      // `vc` being present.
      const client = new TfClient({
        wrapperPath: nodeExe,
        timeoutMs: 10_000,
        argsPrefix: echoArgv,
      });

      const result = await client.run(['reconcile', '/promote', '/adds', 'C:\\x']);

      expect(result.exitCode).toBe(-1);
      expect(result.stdout.toString('utf8')).toBe('');
      expect(result.stderr.toString('utf8')).toContain('/preview');
    });

    it('allows a reconcile with /preview and no leading "vc"', async () => {
      const client = new TfClient({
        wrapperPath: nodeExe,
        timeoutMs: 10_000,
        argsPrefix: echoArgv,
      });

      const result = await client.run(['reconcile', '/preview', '/promote', '/adds', 'C:\\x']);

      expect(result.exitCode).toBe(0);
    });
  });
});

/**
 * The tests above spawn `process.execPath`, a .exe, which never enters the
 * .cmd branch where the quoting and the process-tree kill live — so they would
 * pass even with those bugs present. These drive a real .cmd wrapper, which is
 * the only way to exercise that path. Windows-only by nature.
 */
describe.skipIf(process.platform !== 'win32')('TfClient.run against a real .cmd wrapper', () => {
  let dir: string;
  let wrapper: string;
  let slowWrapper: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'tfclient-cmd-'));

    wrapper = join(dir, 'echoargs.cmd');
    // FAITHFUL to the real tfp.cmd: setlocal enabledelayedexpansion, and a
    // `!var!` on the SAME line as `%*` (real: !TFSPAT!, here: !FAKETOKEN!) --
    // see CMD_UNSAFE's doc comment for why, and the "PINS the caret-stripping
    // premise" test below for what breaks without FAKETOKEN.
    writeFileSync(
      wrapper,
      [
        '@echo off',
        'setlocal enabledelayedexpansion',
        'set "FAKETOKEN=faketokenvalue"',
        'node -e "console.log(JSON.stringify(process.argv.slice(1)))" %* /noprompt /login:.,!FAKETOKEN!',
        '',
      ].join('\r\n'),
    );

    // Launches a long-lived GRANDCHILD that inherits cmd.exe's stdout handle.
    slowWrapper = join(dir, 'slow.cmd');
    writeFileSync(
      slowWrapper,
      ['@echo off', 'node -e "setTimeout(()=>{}, 15000)"', ''].join('\r\n'),
    );
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('PINS the caret-stripping premise this file rests on, bypassing TfClient entirely', () => {
    // No other test here exercises the WRAPPER's own caret-stripping
    // behaviour: TfClient's CMD_UNSAFE guard refuses a caret before anything
    // is spawned, so removing FAKETOKEN from the wrapper above would leave
    // every other test in this describe block green. This spawns the
    // wrapper directly -- the same way TfClient.run() does, via
    // buildCmdLine and windowsVerbatimArguments -- with no guard in the way,
    // so THIS test is what would notice if the wrapper's real-world shape
    // ever stopped producing this. See CMD_UNSAFE's doc comment for why.
    const commandLine = buildCmdLine(wrapper, ['caret ^ literal.cs', 'caret ^^ literal.cs']);
    // spawnSync blocks the event loop, so vitest's own test timeout cannot
    // fire while it runs -- a `timeout` here is the only thing that bounds
    // it if the wrapper ever hangs.
    const result = spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', commandLine], {
      windowsHide: true,
      windowsVerbatimArguments: true,
      encoding: 'utf8',
      timeout: 20_000,
    });

    // Fail on the spawn itself first, with cmd's own diagnosis, rather than
    // a confusing JSON.parse error on empty or partial stdout.
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);

    const argv = JSON.parse(result.stdout!.trim().split(/\r?\n/)[0]);
    expect(argv[0]).toBe('caret  literal.cs');
    expect(argv[1]).toBe('caret ^ literal.cs');
  });

  it('keeps a server path containing a space as ONE argument', async () => {
    const client = new TfClient({ wrapperPath: wrapper, timeoutMs: 20_000 });

    // $/ maps to C:\work, and C:\work\Warehouses is a real mapped folder in
    // this collection, so this is a path hit on day one — not a corner case.
    const result = await client.run(['vc', 'checkout', '$/Warehouses/vbpWarehouses/Form1.vb']);
    const lines = result.stdout.toString('utf8').trim().split(/\r?\n/);

    // slice(0, 3): the faithful wrapper appends its own /noprompt and
    // /login:.,<token> after %*, exactly as the real tfp.cmd does. What
    // matters is that OUR three arguments arrive as three, with the
    // space-bearing path still whole.
    expect(JSON.parse(lines[0]).slice(0, 3))
      .toEqual(['vc', 'checkout', '$/Warehouses/vbpWarehouses/Form1.vb']);
  });

  it('does not let & in a check-in comment execute, AND delivers it intact', async () => {
    const client = new TfClient({ wrapperPath: wrapper, timeoutMs: 20_000 });

    const sent = '/comment:fixed A&echo INJECTED&rem B';
    const result = await client.run([sent]);
    const lines = result.stdout.toString('utf8').trim().split(/\r?\n/);

    // One line means `echo` never ran as a separate command...
    expect(lines).toHaveLength(1);
    // ...and the argument must arrive UNCHANGED. Asserting only the line count
    // was vacuous: it passed just as happily when the escaping mangled the
    // comment into `A^&echo ...`, which is what shipped into check-in history.
    expect(JSON.parse(lines[0])[0]).toBe(sent);
  });

  it('delivers ordinary path punctuation unmangled', async () => {
    const client = new TfClient({ wrapperPath: wrapper, timeoutMs: 20_000 });

    // All of these were corrupted by the caret ESCAPING that quoteForCmd used
    // to do. None is exotic, and all are legal in a TFVC server path. A caret
    // itself is not in this list -- CMD_UNSAFE refuses it before it gets here
    // (see the refusal test below and CMD_UNSAFE's own doc comment).
    for (const sent of [
      '$/Vesta/R&D/merge.cs',
      '$/Vesta/a > b.cs',
      '$/Vesta/fix | cleanup.cs',
      '$/Warehouses/vbpWarehouses/Form1.vb',
    ]) {
      const result = await client.run([sent]);
      const lines = result.stdout.toString('utf8').trim().split(/\r?\n/);
      expect(lines, `extra output for ${sent}`).toHaveLength(1);
      expect(JSON.parse(lines[0])[0], `mangled: ${sent}`).toBe(sent);
    }
  }, 60_000);

  it('REFUSES !, % or ^ rather than acting on a different file', async () => {
    const client = new TfClient({ wrapperPath: wrapper, timeoutMs: 20_000 });

    // See CMD_UNSAFE's doc comment for the mechanism; this just pins refusal.
    for (const bad of ['$/Vesta/Foo!bar!.cs', '$/Vesta/%OS%.cs', '$/Vesta/caret ^ literal.cs']) {
      const result = await client.run(['vc', 'checkout', bad]);

      expect(result.exitCode, `should not have run: ${bad}`).not.toBe(0);
      expect(result.stdout.toString('utf8')).toBe('');
      expect(result.stderr.toString('utf8')).toContain(bad);
      expect(result.stderr.toString('utf8')).toContain('[tfvc]');
    }
  }, 30_000);

  it('keeps a directory path ending in a backslash intact', async () => {
    const client = new TfClient({ wrapperPath: wrapper, timeoutMs: 20_000 });

    // A lone backslash before the closing quote escapes it, so this argument
    // used to arrive as `C:\work\Warehouses"` with every later argument
    // boundary shifted. A bare directory passed to a recursive tf command
    // hits exactly this.
    const dirArg = 'C:\\work\\Warehouses\\';
    const result = await client.run([dirArg]);
    const lines = result.stdout.toString('utf8').trim().split(/\r?\n/);

    expect(JSON.parse(lines[0])[0]).toBe(dirArg);
  });

  it('REFUSES a command line over the cmd limit instead of letting cmd fail', async () => {
    const client = new TfClient({ wrapperPath: wrapper, timeoutMs: 20_000 });

    // ~58 chars each, typical for this collection. Measured: 137 of these ran,
    // 138 produced cmd.exe's own "The command line is too long." and exit 1.
    const many = Array.from(
      { length: 400 },
      (_, i) => `$/Warehouses/vbpWarehouses/Podmoduli/Obracun/Form${String(i).padStart(4, '0')}.vb`,
    );

    const result = await client.run(['vc', 'checkin', ...many]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout.toString('utf8')).toBe('');
    const err = result.stderr.toString('utf8');
    // Ours, not cmd.exe's — and it must say how many and what to do next.
    // Starts with the exported prefix: UnversionedScan recognises this refusal by it.
    expect(err.startsWith(TOO_MANY_ITEMS_PREFIX)).toBe(true);
    expect(err).toContain('[tfvc]');
    expect(err).toContain('400 items');
    expect(err).not.toContain('The command line is too long');
    expect(err).toContain('nothing was changed on the server');
  }, 30_000);

  it('still runs a batch that fits, so the guard is not over-eager', async () => {
    const client = new TfClient({ wrapperPath: wrapper, timeoutMs: 20_000 });

    const items = Array.from(
      { length: 100 },
      (_, i) => `$/Warehouses/vbpWarehouses/Podmoduli/Obracun/Form${String(i).padStart(4, '0')}.vb`,
    );

    const result = await client.run(['vc', 'checkin', ...items]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.toString('utf8').trim()).slice(0, 102))
      .toEqual(['vc', 'checkin', ...items]);
  }, 30_000);

  it('keeps a backslash before a quote from collapsing the argument boundary', async () => {
    const client = new TfClient({ wrapperPath: wrapper, timeoutMs: 20_000 });

    // Windows doubles a backslash run only when a quote follows it. Doubling
    // ONLY the trailing run emitted "a\""b": the \" became a literal quote,
    // the next " closed the quoted region, and every later argument — plus the
    // wrapper's own /noprompt and /login:.,<PAT> — was absorbed into this one.
    const nasty = 'a\\"b';
    const result = await client.run(['vc', 'checkin', nasty, '$/Vesta/B.cs']);
    const argv = JSON.parse(result.stdout.toString('utf8').trim().split(/\r?\n/)[0]);

    expect(argv.slice(0, 4)).toEqual(['vc', 'checkin', nasty, '$/Vesta/B.cs']);
    // The wrapper's own options must still be separate arguments, not swallowed.
    expect(argv).toContain('/noprompt');
  }, 30_000);

  it('REFUSES a newline or carriage return, which swallow the rest of the line', async () => {
    const client = new TfClient({ wrapperPath: wrapper, timeoutMs: 20_000 });

    for (const bad of ['/comment:line1\nline2', '$/Vesta/a\rb.cs']) {
      const result = await client.run(['vc', 'checkin', bad]);
      expect(result.exitCode, `should not have run: ${JSON.stringify(bad)}`).not.toBe(0);
      expect(result.stdout.toString('utf8')).toBe('');
      expect(result.stderr.toString('utf8')).toContain('[tfvc]');
    }
  }, 30_000);

  it('actually kills the grandchild, not just the shell that spawned it', async () => {
    // The timeout test below does NOT guard killTree on its own: with killTree
    // reverted to child.kill() it still passes, because the grace settle
    // resolves the promise either way -- while the real tf.exe keeps running,
    // holding a server workspace lock. Measured: the grandchild lived a full
    // 15 s after the promise said "timed out".
    //
    // So assert on the PROCESS, not on the promise. The grandchild writes a
    // file 3 s in; if it was reaped, that file never appears.
    const marker = join(dir, 'survived.txt');
    const killWrapper = join(dir, 'kill.cmd');
    writeFileSync(
      killWrapper,
      [
        '@echo off',
        `node -e "setTimeout(()=>require('fs').writeFileSync('${marker.replace(/\\/g, '/')}','alive'),3000)"`,
        '',
      ].join('\r\n'),
    );

    const client = new TfClient({ wrapperPath: killWrapper, timeoutMs: 500 });
    const result = await client.run([]);
    expect(result.timedOut).toBe(true);

    await new Promise((r) => setTimeout(r, 4500));
    expect(existsSync(marker), 'grandchild outlived the timeout').toBe(false);
  }, 20_000);

  it('is bounded by its own timeout even when a grandchild outlives the shell', async () => {
    // cmd.exe is the child; the node process it launches is a grandchild
    // holding the same inherited stdout handle. child.kill() reaps only
    // cmd.exe, so without killTree plus the grace settle this promise ran for
    // 6 s against a 300 ms limit — the timeout bounded nothing.
    const client = new TfClient({ wrapperPath: slowWrapper, timeoutMs: 500 });

    const started = Date.now();
    const result = await client.run([]);
    const elapsed = Date.now() - started;

    expect(result.timedOut).toBe(true);
    expect(elapsed).toBeLessThan(4000);
  }, 20_000);

  it('does NOT report a command that already finished as cancelled, when abort lands in the exit-to-close gap', async () => {
    // cmd.exe itself exits 0 almost at once, but the background grandchild it
    // starts inherits the same stdout handle and keeps it open for seconds
    // after -- the same exit-before-close gap the timedOut guard above
    // protects (see "does NOT report a command that finished as having timed
    // out" in the describe above). onAbort's own kill-then-settle then fires
    // 2 s after the abort with the exit code cmd.exe already reported (0),
    // and that must not be reported as cancelled just because an abort
    // happened to land in that gap.
    const finishedWrapper = join(dir, 'finished.cmd');
    writeFileSync(
      finishedWrapper,
      [
        '@echo off',
        'echo get finished',
        'start "" /b node -e "setTimeout(()=>{},6000)"',
        'exit /b 0',
        '',
      ].join('\r\n'),
    );

    const client = new TfClient({ wrapperPath: finishedWrapper, timeoutMs: 20_000 });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 800);

    const result = await client.run([], { signal: controller.signal, timeoutMs: 'none' });

    expect(result.exitCode).toBe(0);
    expect(result.cancelled).toBeFalsy();
  }, 10_000);
});

describe('quoteForCmd', () => {
  it('wraps in quotes and leaves metacharacters alone', () => {
    expect(quoteForCmd('$/Warehouses/x.vb')).toBe('"$/Warehouses/x.vb"');
    // Inside double quotes cmd does not treat these as special, so escaping
    // them only delivers a literal caret. This previously asserted '"a^&b"',
    // locking the corruption in as the expected behaviour.
    expect(quoteForCmd('a&b')).toBe('"a&b"');
    expect(quoteForCmd('a|b')).toBe('"a|b"');
    expect(quoteForCmd('a<b>c')).toBe('"a<b>c"');
  });

  it('doubles an embedded quote', () => {
    expect(quoteForCmd('say "hi"')).toBe('"say ""hi"""');
  });

  it('doubles a trailing backslash run so it cannot escape the closing quote', () => {
    expect(quoteForCmd('C:\\dir\\')).toBe('"C:\\dir\\\\"');
    expect(quoteForCmd('C:\\dir\\\\')).toBe('"C:\\dir\\\\\\\\"');
    // A backslash that is not at the end needs no doubling.
    expect(quoteForCmd('C:\\dir\\file.vb')).toBe('"C:\\dir\\file.vb"');
  });
});

describe('the cmd command-line budget', () => {
  it('leaves room for the shell prefix and the wrapper appended options', () => {
    // Built from a char code, not a literal: this was written as
    // 'C:\WINDOWS\system32\cmd.exe', where \W \s \c are not escapes, so it
    // evaluated to 'C:WINDOWSsystem32cmd.exe' — 24 characters instead of 27,
    // making the assertion 3 characters more permissive than reality.
    const BS = String.fromCharCode(92);
    const shell = `C:${BS}WINDOWS${BS}system32${BS}cmd.exe`;
    expect(shell).toHaveLength(27);
    // Measured boundary: our line at 8102 ran, at 8160 it did not. The total
    // includes `<shell> /d /s /c `, and the wrapper then appends /noprompt,
    // /loginType and /login:.,<PAT> to its own line, which we never see.
    expect(cmdLineBudget(shell)).toBeLessThan(8102);
    expect(cmdLineBudget(shell)).toBeGreaterThan(7000);
    expect(CMD_LINE_LIMIT).toBe(8191);
  });

  it('measures the line cmd actually receives, quoting included', () => {
    // This was written as 'C:\tools\tfp.cmd' — where \t is a TAB — so it was
    // really 'C:<TAB>ools<TAB>fp.cmd' on BOTH sides of the assertion. It
    // passed while never containing a backslash at all, which is the one thing
    // a wrapper path is guaranteed to contain.
    const wrapper = 'C:\\tools\\tfp.cmd';
    expect(wrapper).toContain(String.fromCharCode(92));

    const line = buildCmdLine(wrapper, ['vc', 'checkout', '$/a b/c.vb']);
    expect(line).toBe('""C:\\tools\\tfp.cmd" "vc" "checkout" "$/a b/c.vb""');
  });
});

describe('a wrapper that does not exist', () => {
  it('is refused before spawning, with a message naming the path', async () => {
    const missing = join(tmpdir(), `tfvc-no-such-wrapper-${process.pid}`);
    const client = new TfClient({ wrapperPath: missing, timeoutMs: 5000, cwd: tmpdir() });

    const r = await client.run(['vc', 'status']);

    expect(r.exitCode).toBe(-1);
    expect(r.stderr.toString('utf8')).toBe(`${WRAPPER_NOT_FOUND_PREFIX}: ${missing}`);
    expect(classifyError(r.exitCode, '', r.stderr.toString('utf8'))?.kind).toBe('wrapperMissing');
  });

  it('leaves a bare command name to PATH lookup instead of refusing it', async () => {
    const client = new TfClient({ wrapperPath: 'tfvc-definitely-not-a-command', timeoutMs: 5000, cwd: tmpdir() });

    const r = await client.run(['vc', 'status']);

    expect(r.stderr.toString('utf8')).not.toContain(WRAPPER_NOT_FOUND_PREFIX);
  });
});
