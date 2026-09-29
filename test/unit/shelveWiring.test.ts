import { describe, it, expect, vi } from 'vitest';
import { countConflicts, shelvedTextFrom } from '../../src/extension.js';
import { S } from '../../src/tf/strings.js';
import type { ShelvedRef } from '../../src/ui/ServerContentProvider.js';
import type { ShelveService } from '../../src/shelve/ShelveService.js';

/**
 * Task 8 review I1: nothing exercised the one behaviour ShelvesetsView's
 * delete logic actually depends on -- "phase 5 is not in this build" must
 * never be read as "zero conflicts". The mock `vscode.commands.executeCommand`
 * used everywhere else in this suite resolves `undefined` for any command id,
 * which already happens to fail the `typeof found !== 'number'` check -- so a
 * mutation that swallowed a REJECTION into 0, or read a non-number as 0
 * instead of throwing, passed the whole suite. `execute` is injected here
 * precisely so a real VS Code rejection ("command ... not found") can be
 * driven directly, without a webview or a real command registry.
 */
describe('countConflicts (task 8 review I1)', () => {
  it('rejects when execute rejects -- the real shape of "phase 5 is not in this build"', async () => {
    const execute = vi.fn().mockRejectedValue(new Error("command 'teamExplorer.resolveConflicts' not found"));
    await expect(countConflicts(execute, ['$/a'])).rejects.toThrow(
      "command 'teamExplorer.resolveConflicts' not found",
    );
  });

  it.each([undefined, null, '0', {}])('rejects for a non-number answer: %j', async (value) => {
    const execute = vi.fn().mockResolvedValue(value);
    await expect(countConflicts(execute, ['$/a'])).rejects.toThrow(S.unshelveConflictCheckUnavailable);
  });

  it.each([0, 3])('returns a real count unchanged: %d', async (n) => {
    const execute = vi.fn().mockResolvedValue(n);
    await expect(countConflicts(execute, ['$/a'])).resolves.toBe(n);
  });

  it('calls execute exactly once, with the command id and the paths', async () => {
    const execute = vi.fn().mockResolvedValue(2);
    const paths = ['$/a/one.txt', '$/a/two.txt'];

    await countConflicts(execute, paths);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith('teamExplorer.resolveConflicts', paths);
  });
});

/**
 * Task 8 review I2: the shelved-text resolver had no test of its own. Two
 * mutations pass the whole suite unless this exists: `if (!r.ok) return ''`
 * (a failed fetch reads as an empty file -- and this codebase already gives
 * `''` a real meaning, the empty side of a compare, so the diff would say
 * "this shelveset deletes the whole file" instead of showing the fetch
 * error) and decoding with an undefined code page (every windows-1250
 * shelved file would show U+FFFD instead of its Croatian letters).
 */
describe('shelvedTextFrom (task 8 review I2)', () => {
  const ref: ShelvedRef = {
    serverPath: '$/Shop/report.sql',
    shelveset: 'my-shelveset',
    owner: 'DOMAIN\\filip',
    date: '2026-09-23T12:00:00Z',
    codePage: 1250,
  };

  it('rejects with the failure message rather than returning an empty string', async () => {
    const shelve: Pick<ShelveService, 'view'> = {
      view: vi.fn().mockResolvedValue({ ok: false, message: 'TF14045: The identity x is not a recognized identity.' }),
    };

    await expect(shelvedTextFrom(shelve)(ref)).rejects.toThrow(
      'TF14045: The identity x is not a recognized identity.',
    );
  });

  it('decodes with the code page the shelveset recorded (CP1250 0xE8 -> č)', async () => {
    const shelve: Pick<ShelveService, 'view'> = {
      view: vi.fn().mockResolvedValue({ ok: true, value: Buffer.from([0xe8]) }),
    };

    await expect(shelvedTextFrom(shelve)(ref)).resolves.toBe('č');
  });

  it('calls view(name, ownerUnique, serverPath) exactly once, nothing else', async () => {
    const view = vi.fn().mockResolvedValue({ ok: true, value: Buffer.from('hello', 'utf8') });
    const shelve: Pick<ShelveService, 'view'> = { view };

    await shelvedTextFrom(shelve)(ref);

    expect(view).toHaveBeenCalledTimes(1);
    expect(view).toHaveBeenCalledWith(ref.shelveset, ref.owner, ref.serverPath);
  });
});
