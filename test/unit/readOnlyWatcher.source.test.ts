import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReadOnlyWatcher, type ReadOnlyChange } from '../../src/watch/ReadOnlyWatcher.js';
import { Uri, hooks, recorder } from '../vscode-mock.js';

/**
 * The Task 9 spike is decided by reading one word out of a log line, so that
 * word has to be right. If `source` were hard-coded, or set from the wrong
 * branch, the spike would conclude the opposite of the truth and the 2-second
 * poll would be deleted on the strength of a label that meant nothing.
 *
 * Real files, because the decision runs through statSync.
 */

const folder = { uri: Uri.file('C:\\work\\Vesta') };

let dir: string;
let file: string;
let watchers: ReadOnlyWatcher[];

beforeEach(() => {
  recorder.reset();
  watchers = [];
  dir = mkdtempSync(join(tmpdir(), 'tfvc-src-'));
  file = join(dir, 'Form1.vb');
  writeFileSync(file, 'x');
  chmodSync(file, 0o444); // read-only, as a file under TFVC sits
});

afterEach(() => {
  for (const w of watchers) w.dispose();
  try {
    chmodSync(file, 0o644);
  } catch {
    /* already gone */
  }
  rmSync(dir, { recursive: true, force: true });
});

function watcherWith(usePolling: boolean, pollMs?: number) {
  const seen: ReadOnlyChange[] = [];
  const w = new ReadOnlyWatcher(folder as never, usePolling, pollMs);
  watchers.push(w);
  w.onDidChange((c) => seen.push(c));
  w.track(Uri.file(file) as never);
  return { w, seen };
}

describe('which mechanism noticed the change', () => {
  it("labels a FileSystemWatcher event 'watcher'", () => {
    const { seen } = watcherWith(false);

    chmodSync(file, 0o644); // the checkout
    hooks.fsDidChange.emit(Uri.file(file));

    expect(seen).toHaveLength(1);
    expect(seen[0].source).toBe('watcher');
    expect(seen[0].readOnly).toBe(false);
  });

  it("labels a poll tick 'poll'", async () => {
    // Polling only, so nothing but the timer can produce this event.
    const { seen } = watcherWith(true, 20);

    chmodSync(file, 0o644);
    await new Promise((r) => setTimeout(r, 90));

    expect(seen.length, 'the poll never fired').toBeGreaterThan(0);
    expect(seen[0].source).toBe('poll');
    expect(seen[0].readOnly).toBe(false);
  });

  it('the two labels are actually distinguishable', () => {
    // Guards the mutation that matters most: a `source` fixed to one value
    // would pass either test above on its own.
    const a = watcherWith(false);
    chmodSync(file, 0o644);
    hooks.fsDidChange.emit(Uri.file(file));

    chmodSync(file, 0o444);
    const b = watcherWith(true, 20);

    expect(a.seen[0].source).toBe('watcher');
    expect(b.seen.every((c) => c.source === 'poll')).toBe(true);
  });
});

describe('what the spike is actually measuring', () => {
  it('reports a checkout as becoming WRITABLE, not merely as a change', async () => {
    // The direction is the signal. Undo makes a file read-only again and
    // rewrites it, so mtime moves and any watcher sees it; a checkout only
    // clears the bit. Reading `now writable` in the log is what says the
    // attribute-only case was caught.
    const { seen } = watcherWith(true, 20);

    chmodSync(file, 0o644);
    await new Promise((r) => setTimeout(r, 90));
    expect(seen.at(-1)!.readOnly).toBe(false);

    chmodSync(file, 0o444);
    await new Promise((r) => setTimeout(r, 90));
    expect(seen.at(-1)!.readOnly).toBe(true);
  });
});
