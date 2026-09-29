import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TfClient, SPAWN_DETACHED } from '../../src/tf/TfClient.js';

/**
 * The POSIX half of the timeout guard, which had NO coverage at all: the two
 * existing tree-kill tests live in the `.cmd` wrapper block and skip on Linux.
 *
 * It matters most exactly where it was untested. Under Wine the child is the
 * `tfp` shell script, which `exec`s wine, and wine starts a `wineserver` that
 * outlives it holding the child's inherited descriptors. `child.kill()` sends
 * SIGTERM to the direct child only, so a timed-out command left the rest of
 * the tree running.
 */

const POSIX = process.platform !== 'win32';
let dir: string;
let wrapper: string;
let marker: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'tfvc-killtree-'));
  wrapper = join(dir, 'wrapper.sh');
  marker = join(dir, 'grandchild-alive');

  // Stands in for tfp: starts a long-lived grandchild that would outlive a
  // SIGTERM aimed only at this script, then waits. The grandchild removes the
  // marker on its way out, so the file's presence after the timeout is proof
  // it was never signalled.
  writeFileSync(
    wrapper,
    [
      '#!/bin/sh',
      `touch "${marker}"`,
      `( trap 'rm -f "${marker}"; exit 0' TERM INT; sleep 30 ) &`,
      'sleep 30',
    ].join('\n'),
  );
  chmodSync(wrapper, 0o755);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe.skipIf(!POSIX)('killTree on POSIX', () => {
  it('kills the whole process group, not just the direct child', async () => {
    const client = new TfClient({ wrapperPath: wrapper, timeoutMs: 600 });

    const result = await client.run([]);
    expect(result.timedOut, 'the command did not time out, so nothing was killed').toBe(true);

    // The grandchild traps TERM and deletes the marker. Give the signal a
    // moment to land and the shell a moment to run the trap.
    await new Promise((r) => setTimeout(r, 1500));

    expect(
      existsSync(marker),
      'the grandchild outlived the timeout - only the direct child was signalled',
    ).toBe(false);
  }, 20_000);

  it('is bounded by its own timeout even with a grandchild holding stdio', async () => {
    // The point of the guard: settle on time regardless of what the tree does.
    const client = new TfClient({ wrapperPath: wrapper, timeoutMs: 600 });

    const started = Date.now();
    const result = await client.run([]);

    expect(result.timedOut).toBe(true);
    expect(Date.now() - started, 'outlived its own timeout').toBeLessThan(6000);
  }, 20_000);
});

describe('the group-kill contract', () => {
  it('detached and the group signal are gated on ONE expression', () => {
    // process.kill(-pid) signals a process GROUP. It is safe only because the
    // child was spawned detached and is its own group leader; if the two ever
    // disagreed, that negative pid would be the extension host's own group and
    // VS Code would kill itself cleaning up after a slow tf.
    expect(SPAWN_DETACHED).toBe(process.platform !== 'win32');
  });
});
