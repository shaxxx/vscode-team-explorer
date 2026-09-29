import { describe, it, expect } from 'vitest';
import { readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { TfClient, STDERR_GRACE_MS } from '../../src/tf/TfClient.js';

/**
 * Measured on FEDORA, and it is why that machine looked six times slower than
 * Windows for a whole afternoon:
 *
 *   exit       = 1241 ms     <- tf finished here
 *   stdout end = 1241 ms
 *   stderr end = 5310 ms     <- wineserver finally let go
 *   close      = 5310 ms     <- what TfClient waited for
 *
 * `close` fires only when EVERY writer has released the child's stdio, and
 * under Wine that is not the child: `wineserver` inherits the stderr pipe and
 * holds it for its persistence timeout, ~3 s by default, long after `tf` has
 * exited. `tf` itself costs ~1.2 s, exactly what it costs from a plain shell.
 *
 * Reproduced here without Wine: a child that writes its output, spawns a
 * DETACHED grandchild holding stderr, and exits.
 */

const nodeExe = process.execPath;

/**
 * Child script: write to stdout and stderr, leave a detached grandchild
 * holding the inherited stderr, then exit immediately.
 */
const LINGERING = `
const { spawn } = require('node:child_process');
process.stdout.write('<Status />');
process.stderr.write('a warning from tf itself');
// stdio 2 is inherited, so this grandchild keeps the parent's stderr pipe
// open after we exit - exactly what wineserver does.
spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 3000)'], {
  detached: true,
  stdio: ['ignore', 'ignore', 'inherit'],
}).unref();
process.exit(0);
`;

describe('a child that leaves stderr held open', () => {
  it('settles when the process exits, not when the pipe is finally released', async () => {
    const client = new TfClient({
      wrapperPath: nodeExe,
      timeoutMs: 30_000,
      argsPrefix: ['-e', LINGERING],
    });

    const started = Date.now();
    const result = await client.run([]);
    const elapsed = Date.now() - started;

    expect(result.exitCode).toBe(0);
    // The grandchild holds the inherited stderr for 3 s. Anything near that
    // means stderr is a pipe again and 'close' is waiting on the grandchild.
    expect(elapsed, `waited ${elapsed}ms for a process that exited immediately`).toBeLessThan(2000);
  }, 20_000);

  it('still captures stdout in full', async () => {
    // Settling early must not cost us the XML we exist to parse.
    const client = new TfClient({
      wrapperPath: nodeExe,
      timeoutMs: 30_000,
      argsPrefix: ['-e', LINGERING],
    });

    const result = await client.run([]);

    expect(result.stdout.toString('utf8')).toBe('<Status />');
  }, 20_000);

  it("still captures what the child ITSELF wrote to stderr", async () => {
    // stderr now arrives via a file, so a grandchild holding the descriptor
    // cannot cost us anything: tf's own diagnostics are all there, and
    // classifyError reads them to tell a rejected PAT from a missing
    // workspace.
    const client = new TfClient({
      wrapperPath: nodeExe,
      timeoutMs: 30_000,
      argsPrefix: ['-e', LINGERING],
    });

    const result = await client.run([]);

    expect(result.stderr.toString('utf8')).toContain('a warning from tf itself');
  }, 20_000);

  it('captures a LARGE stderr that cannot already have been read at exit', async () => {
    // More than a pipe buffer holds. Through a pipe this is the case where
    // abandoning stderr early truncates it; through a file the size is simply
    // irrelevant, which is the point of the change.
    const BIG = `
const { spawn } = require('node:child_process');
process.stdout.write('<Status />');
process.stderr.write('E'.repeat(400000));
spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 3000)'], {
  detached: true,
  stdio: ['ignore', 'ignore', 'inherit'],
}).unref();
`;
    const client = new TfClient({
      wrapperPath: nodeExe,
      timeoutMs: 30_000,
      argsPrefix: ['-e', BIG],
    });

    const result = await client.run([]);

    expect(result.stderr.length, 'stderr was truncated').toBe(400000);
  }, 20_000);

  it('a well-behaved child is not delayed by the grace period', async () => {
    // The common case: nothing holds anything, so this must not pay for the
    // machinery that exists for the case where something does.
    const client = new TfClient({
      wrapperPath: nodeExe,
      timeoutMs: 30_000,
      argsPrefix: ['-e', "process.stdout.write('ok')"],
    });

    const started = Date.now();
    const result = await client.run([]);
    const elapsed = Date.now() - started;

    expect(result.stdout.toString('utf8')).toBe('ok');
    expect(elapsed, 'paid the stderr grace period on a clean exit').toBeLessThan(
      1000 + STDERR_GRACE_MS,
    );
  }, 20_000);
});


describe('the stderr temp file', () => {
  // Scoped to THIS process. vitest runs files in parallel workers, each
  // creating `tfvc-stderr-*` in the same shared tmpdir, so counting the
  // prefix alone counted other workers' files and this test failed roughly
  // one run in three — including one unexplained failure recorded on
  // 2026-09-17 that twelve reruns could not reproduce, because it only
  // happens when another worker happens to be mid-command.
  //
  // TfClient already embeds the pid in the name, so the fix is to use it.
  const strays = () =>
    readdirSync(tmpdir()).filter((f) => f.startsWith(`tfvc-stderr-${process.pid}-`));

  it('is removed after every run, however the run ended', async () => {
    // One file per tf command, and the extension runs a status on every focus
    // change and every checkout. Leaking them fills the temp directory over a
    // working day.
    const before = strays().length;

    for (const script of [
      "process.stdout.write('ok')",
      "process.stderr.write('boom'); process.exit(3)",
    ]) {
      const client = new TfClient({
        wrapperPath: nodeExe,
        timeoutMs: 30_000,
        argsPrefix: ['-e', script],
      });
      await client.run([]);
    }

    expect(strays().length, 'temp stderr files were left behind').toBe(before);
  }, 20_000);

  it('is cleaned up when the command TIMES OUT', async () => {
    // The timeout path kills the child mid-run, which is exactly where a
    // cleanup that only runs on the happy path would leak.
    const before = strays().length;

    const client = new TfClient({
      wrapperPath: nodeExe,
      timeoutMs: 300,
      argsPrefix: ['-e', 'setTimeout(() => {}, 10000)'],
    });
    const result = await client.run([]);

    expect(result.timedOut).toBe(true);
    expect(strays().length, 'a timed-out command leaked its temp file').toBe(before);
  }, 20_000);

  it('carries stderr through the file, not a pipe', async () => {
    // The whole point of the change: nothing downstream can hold a file
    // descriptor open the way wineserver holds a pipe.
    const client = new TfClient({
      wrapperPath: nodeExe,
      timeoutMs: 30_000,
      argsPrefix: ['-e', "process.stderr.write('TF30063: not authorized')"],
    });

    const result = await client.run([]);

    expect(result.stderr.toString('utf8')).toBe('TF30063: not authorized');
  }, 20_000);
});
