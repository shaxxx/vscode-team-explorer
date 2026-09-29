import { describe, it, expect, vi, beforeEach } from 'vitest';
import { killTree } from '../../src/tf/TfClient.js';

/**
 * killTree runs on the timeout path, which is the worst place for a crash:
 * the user is already waiting on a command that went wrong.
 *
 * `spawn` is mocked so the test can see WHETHER taskkill was launched. Asserting
 * only on child.kill() is blind on Windows, where the whole point is that
 * taskkill runs instead — an earlier version of this test passed happily with
 * the already-exited guard deleted.
 */
// vi.hoisted, not a plain const: the mock factory runs while TfClient is being
// imported, which is before a normal const at this scope is initialized.
const h = vi.hoisted(() => ({
  spawned: [] as { cmd: string; args: readonly string[] }[],
  nextSpawnFails: false,
}));

vi.mock('node:child_process', () => ({
  spawn: (cmd: string, args: readonly string[]) => {
    h.spawned.push({ cmd, args });
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { EventEmitter } = require('node:events');
    const emitter = new EventEmitter() as import('node:events').EventEmitter & { pid: number };
    emitter.pid = 9999;
    if (h.nextSpawnFails) {
      // ENOENT arrives on the NEXT tick, as a real spawn reports it. An
      // EventEmitter with no 'error' listener THROWS when one is emitted —
      // which is exactly how this crashes the extension host in production.
      setTimeout(() => emitter.emit('error', new Error('spawn taskkill ENOENT')), 0);
    }
    return emitter;
  },
}));

const spawned = h.spawned;

/**
 * `getpgid` is POSIX-only and not on the Process type, but killTree uses it to
 * verify the child leads its own group before sending a negative pid.
 */
type PosixProcess = { getpgid?: (pid: number) => number };
const proc = process as unknown as PosixProcess;

function fakeChild(over: Partial<Parameters<typeof killTree>[0]> = {}) {
  let killed = 0;
  const child = {
    pid: 4242,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    kill: () => {
      killed++;
    },
    ...over,
  };
  return { child, killedCount: () => killed };
}

beforeEach(() => {
  spawned.length = 0;
  h.nextSpawnFails = false;
});

describe('killTree', () => {
  it('does NOT touch a child that has already exited', () => {
    // Windows reuses PIDs, and child.pid keeps its value after exit. Signalling
    // it can hit an unrelated process — and taskkill /T takes that process's
    // children down with it.
    const { child, killedCount } = fakeChild({ exitCode: 0 });

    killTree(child);

    expect(spawned, 'taskkill must not be launched against a stale PID').toEqual([]);
    expect(killedCount()).toBe(0);
  });

  it('does NOT touch a child already killed by a signal', () => {
    const { child, killedCount } = fakeChild({ signalCode: 'SIGTERM' });

    killTree(child);

    expect(spawned).toEqual([]);
    expect(killedCount()).toBe(0);
  });

  it('kills the whole tree of a live child', () => {
    const { child, killedCount } = fakeChild();

    // `process.kill` MUST be stubbed on POSIX. Unstubbed, this test sent a
    // real SIGTERM — and 500 ms later a real SIGKILL — to process group 4242
    // on whatever machine ran it. On the Fedora box that is a boot-time
    // systemd unit, and systemd setsid()s every service, so `-4242` resolves
    // to a real group. `npx vitest run` could take down a system service.
    //
    // It also made the assertion meaningless: `killedCount() === 1` could only
    // pass if the group signal THREW and control fell through to child.kill(),
    // so on Linux it was asserting the fix did not work. Deleting the whole
    // POSIX branch left it green.
    const signals: Array<[number, string | number | undefined]> = [];
    const realKill = process.kill.bind(process);
    const realGetpgid = proc.getpgid;
    process.kill = ((pid: number, sig?: string | number) => {
      signals.push([pid, sig]);
      return true;
    }) as typeof process.kill;
    // killTree now verifies the child leads its own group before sending a
    // negative pid. Without this stub the fake pid fails that check and falls
    // through to child.kill() -- which is the correct, safe behaviour, and is
    // asserted separately below.
    if (realGetpgid) proc.getpgid = (pid: number) => pid;

    try {
      killTree(child);
    } finally {
      process.kill = realKill;
      if (realGetpgid) proc.getpgid = realGetpgid;
    }

    if (process.platform === 'win32') {
      expect(spawned).toHaveLength(1);
      expect(spawned[0].cmd).toBe('taskkill');
      // /T is the reason this exists: tf.exe is a GRANDCHILD of cmd.exe.
      expect(spawned[0].args).toEqual(['/PID', '4242', '/T', '/F']);
      expect(signals, 'Windows must not use the POSIX group path').toEqual([]);
    } else {
      // The NEGATIVE pid is the whole point: it signals the group, which is
      // what `wineserver` is in. A plain `child.kill()` reaches only the
      // direct child.
      expect(signals).toEqual([[-4242, 'SIGTERM']]);
      expect(killedCount(), 'the group signal succeeded, so no direct kill').toBe(0);
    }
  });


  it('refuses the group signal for a child that does NOT lead its own group', () => {
    // The invariant that keeps `process.kill(-pid)` from signalling the
    // extension host's own group. The old guard was `expect(SPAWN_DETACHED)
    // .toBe(process.platform !== 'win32')` -- the constant's own definition,
    // which cannot fail and would not have caught a caller passing a child
    // spawned without `detached`.
    if (process.platform === 'win32') return;

    const { child, killedCount } = fakeChild();
    const signals: number[] = [];
    const realKill = process.kill.bind(process);
    const realGetpgid = proc.getpgid;
    process.kill = ((pid: number) => {
      signals.push(pid);
      return true;
    }) as typeof process.kill;
    // Its group leader is somebody else: exactly the unsafe case.
    proc.getpgid = (pid: number) => pid + 1;

    try {
      killTree(child);
    } finally {
      process.kill = realKill;
      if (realGetpgid) proc.getpgid = realGetpgid;
    }

    expect(signals, 'signalled a group it does not lead').toEqual([]);
    expect(killedCount(), 'should fall back to the plain kill').toBe(1);
  });

  it('survives a taskkill that cannot be spawned, and still kills the child', async () => {
    if (process.platform !== 'win32') return;

    const seen: unknown[] = [];
    const onUncaught = (e: unknown) => seen.push(e);
    process.on('uncaughtException', onUncaught);

    h.nextSpawnFails = true;
    const { child, killedCount } = fakeChild();
    try {
      killTree(child);
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      process.off('uncaughtException', onUncaught);
    }

    expect(seen, 'an uncaught error here takes down the extension host').toEqual([]);
    // And the fallback must still run, or the timeout bounds nothing.
    expect(killedCount()).toBe(1);
  });
});
