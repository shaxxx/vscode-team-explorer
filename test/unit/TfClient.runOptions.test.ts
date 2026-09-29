import { describe, it, expect } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TfClient } from '../../src/tf/TfClient.js';

// node itself stands in for the wrapper, as in TfClient.spawn.test.ts.
const nodeExe = process.execPath;
const clientFor = (script: string, timeoutMs = 10_000) =>
  new TfClient({ wrapperPath: nodeExe, timeoutMs, argsPrefix: ['-e', script] });

/** Signal 0 only probes for existence; it never actually signals the process. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('TfClient.run per-call options', () => {
  it('hands each stdout chunk to onStdout as it arrives, well before the call resolves', async () => {
    // A single end-of-run callback with the whole buffer would also satisfy a
    // weaker assertion here, so this proves TIMING: the first chunk must be
    // seen a good margin before the second write and the final resolution,
    // not just before the promise settles.
    const seen: { text: string; at: number }[] = [];
    const started = Date.now();
    const client = clientFor("process.stdout.write('a\\n'); setTimeout(() => process.stdout.write('b\\n'), 400)");

    const result = await client.run([], {
      onStdout: (b) => seen.push({ text: b.toString('utf8'), at: Date.now() - started }),
    });
    const finishedAfter = Date.now() - started;

    expect(seen[0]?.text).toBe('a\n');
    expect(finishedAfter - seen[0].at).toBeGreaterThan(300);
    expect(result.stdout.toString('utf8')).toBe('a\nb\n');
  });

  it("does not time out with timeoutMs: 'none', even past the client's own limit", async () => {
    const client = clientFor('setTimeout(() => process.exit(0), 400)', 100);

    const result = await client.run([], { timeoutMs: 'none' });

    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
  });

  it("still uses the client's timeout when no option is given", async () => {
    const client = clientFor('setTimeout(() => {}, 30000)', 150);

    expect((await client.run([])).timedOut).toBe(true);
  });

  it('kills the process on abort and reports cancelled', async () => {
    // With killTree(child) removed from onAbort, every assertion below still
    // passed: the 2 s kill-then-settle grace timer resolves the promise
    // regardless of whether anything was actually killed (measured 2116 ms,
    // comfortably under a 5 s bound). So this asserts on the PROCESS, not
    // just the promise: the child prints its own pid before sleeping, and
    // afterwards that pid must be gone. The tightened time bound (real code:
    // ~170 ms) is what would catch a regression to the no-op grace-settle path.
    const client = clientFor("process.stdout.write(String(process.pid)); setTimeout(() => {}, 30000)");
    const controller = new AbortController();
    const started = Date.now();
    setTimeout(() => controller.abort(), 100);

    const result = await client.run([], { signal: controller.signal, timeoutMs: 'none' });

    expect(result.cancelled).toBe(true);
    expect(result.exitCode).not.toBe(0);
    expect(Date.now() - started).toBeLessThan(1_500);

    const pid = Number(result.stdout.toString('utf8'));
    expect(Number.isInteger(pid)).toBe(true);
    await expect.poll(() => isAlive(pid), { timeout: 2_000, interval: 50 }).toBe(false);
  });

  it('does not spawn at all when the signal is already aborted', async () => {
    const client = clientFor("process.stdout.write('ran')");
    const controller = new AbortController();
    controller.abort();

    const result = await client.run([], { signal: controller.signal });

    expect(result.cancelled).toBe(true);
    expect(result.stdout.length).toBe(0);
  });

  it('runs in the per-call cwd instead of the client one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tfvc-cwd-'));
    try {
      const client = clientFor('process.stdout.write(process.cwd())');
      const result = await client.run([], { cwd: dir });
      expect(realpathSync(result.stdout.toString('utf8'))).toBe(realpathSync(dir));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('survives an onStdout callback that throws', async () => {
    const client = clientFor("process.stdout.write('x')");

    const result = await client.run([], {
      onStdout: () => {
        throw new Error('boom');
      },
    });

    expect(result.stdout.toString('utf8')).toBe('x');
    expect(result.exitCode).toBe(0);
  });

  it("treats a non-finite timeoutMs as no timeout, rather than firing almost immediately", async () => {
    const client = clientFor('setTimeout(() => {}, 300)');

    const result = await client.run([], { timeoutMs: Infinity });

    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
  });
});
