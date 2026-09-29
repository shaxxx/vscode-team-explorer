import { describe, it, expect } from 'vitest';
import { streamedGet } from '../../src/tf/streamedGet.js';
import type { RunOptions, TfResult } from '../../src/tf/TfClient.js';

/** Streams `chunks` to onStdout, then resolves with `result` over a zero-exit default. */
function fakeClient(chunks: string[], result: Partial<TfResult> = {}) {
  const calls: { args: string[]; opts?: RunOptions }[] = [];
  return {
    calls,
    async run(args: string[], opts?: RunOptions): Promise<TfResult> {
      calls.push({ args, opts });
      for (const c of chunks) opts?.onStdout?.(Buffer.from(c, 'utf8'));
      return { stdout: Buffer.from(chunks.join(''), 'utf8'), stderr: Buffer.alloc(0), exitCode: 0, timedOut: false, ...result };
    },
  };
}

describe('streamedGet', () => {
  it('counts Getting, Replacing and Deleting lines, and Deleting on its own (design Q10)', async () => {
    const client = fakeClient([
      'C:\\t\\assets:\r\nGetting date.js\r\nReplacing smiley.jpg\r\n',
      'Deleting C:\\t\\assets\\old.txt\r\n',
    ]);
    const progress: number[] = [];
    const r = await streamedGet(client, ['vc', 'get', '$/X', '/recursive'], (n) => progress.push(n), new AbortController().signal);
    expect(r).toEqual({ items: 3, deleted: 1, cancelled: false });
    expect(progress).toEqual([1, 2, 3]);
  });

  it('sends the argv untouched, with no timeout and the abort signal (part 1 W5)', async () => {
    const client = fakeClient(['All files are up to date.\r\n']);
    const signal = new AbortController().signal;
    await streamedGet(client, ['vc', 'get', '$/X', '/version:C5'], () => {}, signal);
    expect(client.calls[0].args).toEqual(['vc', 'get', '$/X', '/version:C5']);
    expect(client.calls[0].opts?.timeoutMs).toBe('none');
    expect(client.calls[0].opts?.signal).toBe(signal);
  });

  it('reports a cancel only when tf did not finish anyway (part 1 M1)', async () => {
    const cancelled = await streamedGet(fakeClient(['Getting a\r\n'], { cancelled: true, exitCode: 1 }), ['vc', 'get', '$/X'], () => {}, new AbortController().signal);
    expect(cancelled).toEqual({ items: 1, deleted: 0, cancelled: true });
    const finished = await streamedGet(fakeClient(['Getting a\r\n'], { cancelled: true, exitCode: 0 }), ['vc', 'get', '$/X'], () => {}, new AbortController().signal);
    expect(finished).toEqual({ items: 1, deleted: 0, cancelled: false });
  });

  it('keeps the count on a failure and says why: stderr plus the lines that are not progress', async () => {
    const client = fakeClient(
      ['Getting a.txt\r\n', 'Conflict b.txt - Unable to perform the get operation because the file already exists locally\r\n'],
      { exitCode: 1, stderr: Buffer.from('TF10201: something went wrong.\r\n') },
    );
    const r = await streamedGet(client, ['vc', 'get', '$/X'], () => {}, new AbortController().signal);
    expect(r.items).toBe(1);
    expect(r.cancelled).toBe(false);
    expect(r.failure).toContain('TF10201');
    expect(r.failure).toContain('Conflict b.txt');
    expect(r.failure).not.toContain('Getting a.txt');
  });
});
