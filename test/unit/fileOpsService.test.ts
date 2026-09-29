import { describe, it, expect } from 'vitest';
import { FileOpsService } from '../../src/fileops/FileOpsService.js';
import type { RunOptions, TfResult } from '../../src/tf/TfClient.js';
import { S } from '../../src/tf/strings.js';

function fakeClient(result: Partial<TfResult> = {}) {
  const calls: string[][] = [];
  return {
    calls,
    timeoutMs: 60000,
    async run(args: string[], _opts?: RunOptions): Promise<TfResult> {
      calls.push(args);
      return {
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        exitCode: 0,
        timedOut: false,
        ...result,
      };
    },
  };
}

describe('FileOpsService', () => {
  it('renames with the two local paths, in tf order (design R1, R5)', async () => {
    const client = fakeClient();
    const r = await new FileOpsService(client).rename('C:\\t\\a.txt', 'C:\\t\\b.txt');
    expect(r).toEqual({ ok: true });
    expect(client.calls).toEqual([['vc', 'rename', 'C:\\t\\a.txt', 'C:\\t\\b.txt']]);
  });

  it('deletes a whole batch in one call (design R11)', async () => {
    const client = fakeClient();
    const r = await new FileOpsService(client).delete(['C:\\t\\a.txt', '$/T/b.txt']);
    expect(r).toEqual({ ok: true });
    expect(client.calls).toEqual([['vc', 'delete', 'C:\\t\\a.txt', '$/T/b.txt']]);
  });

  it('refuses a path tf could read as a switch or a wildcard, or an empty batch, and spawns nothing', async () => {
    const client = fakeClient();
    const service = new FileOpsService(client);
    for (const bad of [
      [],
      ['/recursive'],
      [''],
      ['-x'],
      ['C:\\t\\a.txt', '/force'],
      ['C:\\t\\*'],
      ['$/T/*'],
      ['$/T/a?.txt'],
    ]) {
      const r = await service.delete(bad);
      expect(r.ok).toBe(false);
    }
    expect(await (await service.rename('/force', 'C:\\t\\b.txt')).ok).toBe(false);
    expect(await (await service.rename('C:\\t\\a.txt', '')).ok).toBe(false);
    expect(await (await service.rename('C:\\t\\*.txt', 'C:\\t\\b.txt')).ok).toBe(false);
    expect(await (await service.rename('C:\\t\\a.txt', 'C:\\t\\*.txt')).ok).toBe(false);
    expect(client.calls).toEqual([]);
  });

  it('reports tf failure with tf words, and a timeout as a timeout', async () => {
    const failed = fakeClient({
      exitCode: 100,
      stderr: Buffer.from('The file C:\\t\\b.txt already exists.\r\n', 'utf8'),
    });
    const r = await new FileOpsService(failed).rename('C:\\t\\a.txt', 'C:\\t\\b.txt');
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.message).toContain('already exists');

    const timedOut = fakeClient({ timedOut: true, exitCode: 1 });
    const t = await new FileOpsService(timedOut).delete(['C:\\t\\a.txt']);
    expect(t).toEqual({ ok: false, message: S.commandTimedOut(60000) });
  });

  it('a partly-successful batch still reports failure with tf\'s own text, never pretending success (partial-success contract)', async () => {
    // tf pended C:\t\a.txt fine and skipped C:\t\b.txt -- exit 1 either way.
    // The caller must refresh regardless of {ok}; this only pins that the
    // outcome never lies about it by reporting ok:true.
    const partial = fakeClient({
      exitCode: 1,
      stdout: Buffer.from('C:\\t\\a.txt\n', 'utf8'),
      stderr: Buffer.from(
        'C:\\t\\b.txt: The item could not be found in your workspace, or you do not have permission to access it.\r\n',
        'utf8',
      ),
    });
    const r = await new FileOpsService(partial).delete(['C:\\t\\a.txt', 'C:\\t\\b.txt']);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.message).toContain('could not be found');
  });
});
