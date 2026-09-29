import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ReadOnlyWatcher } from '../../src/watch/ReadOnlyWatcher.js';
import { Uri, hooks, recorder } from '../vscode-mock.js';

/**
 * The cost of the watcher is measured in SYSCALLS, and no assertion about the
 * tracked set can see them: `update()` refuses an untracked path whether or
 * not the caller already stat'd it, so a test on trackedCount passes happily
 * with the stat storm still present. Count statSync instead.
 */
const h = vi.hoisted(() => ({ stats: [] as string[] }));

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  return {
    ...real,
    statSync: (p: string, ...rest: unknown[]) => {
      h.stats.push(String(p));
      return (real.statSync as (...a: unknown[]) => unknown)(p, ...rest);
    },
  };
});

const folder = { uri: Uri.file('C:\\work\\Vesta') };

beforeEach(() => {
  recorder.reset();
  h.stats.length = 0;
});

describe('ReadOnlyWatcher syscall cost', () => {
  it('does NOT stat a filesystem event for an untracked path', () => {
    // A `tf vc get`, or an ordinary build writing bin/ and obj/, fires
    // thousands of create/change events. isReadOnly was evaluated as an
    // ARGUMENT to update(), so every one of them cost a blocking statSync on
    // the extension-host thread for a path that was then discarded — and a
    // second statSync when it did fire.
    const watcher = new ReadOnlyWatcher(folder as never, false);
    h.stats.length = 0;

    for (let i = 0; i < 500; i++) {
      hooks.fsDidChange.emit(Uri.file(`C:\\work\\Vesta\\obj\\Debug\\gen${i}.dll`));
    }

    expect(h.stats, 'untracked events must cost nothing').toEqual([]);
    watcher.dispose();
  });

  it('stats a tracked path exactly once per event', () => {
    const watcher = new ReadOnlyWatcher(folder as never, false);
    const tracked = Uri.file('C:\\work\\Vesta\\Form1.vb');
    watcher.track(tracked as never);
    h.stats.length = 0;

    hooks.fsDidChange.emit(tracked);

    // Once, not twice: the old code stat'd to decide, then stat'd again to
    // build the event payload.
    expect(h.stats.filter((p) => p === tracked.fsPath)).toHaveLength(1);
    watcher.dispose();
  });
});
