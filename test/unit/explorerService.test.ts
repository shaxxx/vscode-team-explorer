import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ExplorerService, childrenSpec } from '../../src/explorer/ExplorerService.js';
import type { RunOptions, TfResult } from '../../src/tf/TfClient.js';
import { S } from '../../src/tf/strings.js';

const URL = 'https://acme.visualstudio.com/';
const fixture = (name: string) => readFileSync(join(__dirname, '../fixtures', name));

type Reply = Partial<TfResult> | (() => Promise<Partial<TfResult>>);

/** Answers by the argv's verb; records every call. */
function fakeClient(replies: Record<string, Reply>) {
  const calls: { args: string[]; opts?: RunOptions }[] = [];
  return {
    calls,
    timeoutMs: 1000,
    async run(args: string[], opts?: RunOptions): Promise<TfResult> {
      calls.push({ args, opts });
      const reply = replies[args[1]] ?? {};
      const r = typeof reply === 'function' ? await reply() : reply;
      return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0, timedOut: false, ...r };
    },
  };
}

const DIR = Buffer.from('$/Shop:\r\n$Shop2023\r\nreadme.txt\r\n\r\n2 item(s)\r\n');

describe('ExplorerService', () => {
  it('lists a folder with dir and the collection, and caches it (design Q1)', async () => {
    const client = fakeClient({ dir: { stdout: DIR } });
    const s = new ExplorerService(client, URL);
    const r = await s.list('$/Shop');
    expect(r).toEqual({ ok: true, value: { path: '$/Shop', folders: ['Shop2023'], files: ['readme.txt'] } });
    expect(client.calls[0].args).toEqual(['vc', 'dir', '$/Shop', `/collection:${URL}`]);
    await s.list('$/shop');
    expect(client.calls).toHaveLength(1);
    expect(s.cachedListing('$/SHOP')?.folders).toEqual(['Shop2023']);
    await s.list('$/Shop', true);
    expect(client.calls).toHaveLength(2);
  });

  it("runs info and everyone's status for the folder's children in parallel (X2, Q2, Q5)", async () => {
    let releaseInfo!: () => void;
    const infoGate = new Promise<void>((r) => (releaseInfo = r));
    const client = fakeClient({
      info: async () => {
        await infoGate;
        return { stdout: fixture('windows/info-folder-star.txt') };
      },
      status: { stdout: fixture('windows/status-folder-star-allusers.xml'), stderr: Buffer.from('Changes from local workspaces will not be displayed...') },
    });
    const s = new ExplorerService(client, URL);
    const pending = s.details('$/Shop/Shop2023/Enterprise.Till.Server');
    await Promise.resolve();
    // status started while info is still held: they run side by side.
    expect(client.calls.map((c) => c.args[1])).toEqual(['info', 'status']);
    releaseInfo();
    const { info, status } = await pending;
    expect(client.calls[0].args).toEqual(['vc', 'info', '$/Shop/Shop2023/Enterprise.Till.Server/*']);
    expect(client.calls[1].args).toEqual(['vc', 'status', '$/Shop/Shop2023/Enterprise.Till.Server/*', '/user:*', '/format:xml']);
    expect(info.ok && info.value).toHaveLength(23);
    expect(status.ok && status.value.map((c) => c.owner)).toContain('Boris');
  });

  it('names $/ itself as $/*', () => {
    expect(childrenSpec('$/')).toBe('$/*');
    expect(childrenSpec('$/Shop')).toBe('$/Shop/*');
  });

  it('keeps a failure in one call from spoiling the other', async () => {
    const client = fakeClient({
      info: { exitCode: 100, stderr: Buffer.from('TF14061: The workspace does not exist.') },
      status: { stdout: Buffer.from('<Status />') },
    });
    const { info, status } = await new ExplorerService(client, URL).details('$/Shop');
    expect(info.ok).toBe(false);
    expect(status).toEqual({ ok: true, value: [] });
  });

  it('says so when a call timed out', async () => {
    const client = fakeClient({ dir: { timedOut: true, exitCode: 1 } });
    expect(await new ExplorerService(client, URL).list('$/Shop')).toEqual({ ok: false, message: S.commandTimedOut(1000) });
  });

  it("asks for this computer's workspaces once, until forget() (fixtures finding 18)", async () => {
    const client = fakeClient({ workspaces: { stdout: fixture('windows/workspaces.xml') } });
    const s = new ExplorerService(client, URL);
    const first = await s.workspaces();
    await s.workspaces();
    expect(first.ok).toBe(true);
    expect(client.calls.filter((c) => c.args[1] === 'workspaces')).toHaveLength(1);
    expect(client.calls[0].args).toEqual(['vc', 'workspaces', `/collection:${URL}`, '/format:xml']);
    s.forget();
    await s.workspaces();
    expect(client.calls.filter((c) => c.args[1] === 'workspaces')).toHaveLength(2);
  });

  it('does not cache a failed workspaces() read, so the next call retries it (review finding 2)', async () => {
    let calls = 0;
    const client = fakeClient({
      workspaces: async () => {
        calls += 1;
        if (calls === 1) return { exitCode: 100, stderr: Buffer.from('TF14061: The workspace does not exist.') };
        return { stdout: fixture('windows/workspaces.xml') };
      },
    });
    const s = new ExplorerService(client, URL);
    const first = await s.workspaces();
    expect(first.ok).toBe(false);
    const second = await s.workspaces();
    expect(second.ok).toBe(true);
    expect(client.calls.filter((c) => c.args[1] === 'workspaces')).toHaveLength(2);
  });

  it('forget(path) drops that listing only', async () => {
    const client = fakeClient({ dir: { stdout: DIR } });
    const s = new ExplorerService(client, URL);
    await s.list('$/Shop');
    s.forget('$/Shop');
    expect(s.cachedListing('$/Shop')).toBeUndefined();
  });

  it('a listing in flight when Refresh forgets everything does not repopulate the cache (review finding 1)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const client = fakeClient({
      dir: async () => {
        await gate;
        return { stdout: DIR };
      },
    });
    const s = new ExplorerService(client, URL);
    const pending = s.list('$/Shop');
    s.forget();
    release();
    await pending;
    expect(s.cachedListing('$/Shop')).toBeUndefined();
  });

  it('an older list resolving after a newer one does not overwrite the cache (review finding 1)', async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((r) => (releaseFirst = r));
    let dirCalls = 0;
    const client = fakeClient({
      dir: async () => {
        dirCalls += 1;
        if (dirCalls === 1) {
          await firstGate;
          return { stdout: Buffer.from('$/Shop:\r\n$Old\r\n\r\n1 item(s)\r\n') };
        }
        return { stdout: Buffer.from('$/Shop:\r\n$New\r\n\r\n1 item(s)\r\n') };
      },
    });
    const s = new ExplorerService(client, URL);
    const first = s.list('$/Shop', true);
    const second = s.list('$/Shop', true);
    await second;
    expect(s.cachedListing('$/Shop')?.folders).toEqual(['New']);
    releaseFirst();
    await first;
    expect(s.cachedListing('$/Shop')?.folders).toEqual(['New']);
  });

  it('streams a Get with no timeout (part 1 W5)', async () => {
    const client = fakeClient({ get: { stdout: Buffer.from('Getting a.txt\r\n') } });
    const r = await new ExplorerService(client, URL).get(['vc', 'get', '$/Shop/a.txt', '/recursive'], () => {}, new AbortController().signal);
    expect(r.cancelled).toBe(false);
    expect(client.calls[0].args).toEqual(['vc', 'get', '$/Shop/a.txt', '/recursive']);
    expect(client.calls[0].opts?.timeoutMs).toBe('none');
  });

  it('get() refuses any verb but vc get, and never touches the client (review finding 3)', async () => {
    const client = fakeClient({});
    const r = await new ExplorerService(client, URL).get(['vc', 'checkin', '$/X'], () => {}, new AbortController().signal);
    expect(client.calls).toHaveLength(0);
    expect(r.failure).not.toBeUndefined();
  });
});
