import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { WorkspaceService } from '../../src/workspace/WorkspaceService.js';
import type { RunOptions, TfResult } from '../../src/tf/TfClient.js';

const fixture = (name: string) => readFileSync(join(__dirname, '../fixtures', name));
const URL = 'https://acme.visualstudio.com/';
const ok = (stdout: Buffer | string = ''): TfResult => ({
  stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout),
  stderr: Buffer.alloc(0),
  exitCode: 0,
  timedOut: false,
});
const failed = (stderr: string, exitCode = 100): TfResult => ({ stdout: Buffer.alloc(0), stderr: Buffer.from(stderr), exitCode, timedOut: false });

function fakeClient(answers: TfResult[]) {
  const calls: { args: string[]; opts: RunOptions }[] = [];
  return {
    calls,
    client: {
      timeoutMs: 60_000,
      async run(args: string[], opts: RunOptions = {}) {
        calls.push({ args, opts });
        const r = answers.shift() ?? ok();
        if (opts.onStdout && r.stdout.length) {
          opts.onStdout(r.stdout.subarray(0, 20));
          opts.onStdout(r.stdout.subarray(20));
        }
        return r;
      },
    },
  };
}

describe('WorkspaceService', () => {
  it('lists this computer\'s workspaces from the XML', async () => {
    const f = fakeClient([ok(fixture('windows/workspaces.xml'))]);
    const svc = new WorkspaceService(f.client, URL, 'win32');

    const r = await svc.list();

    expect(f.calls[0].args).toEqual(['vc', 'workspaces', `/collection:${URL}`, '/format:xml']);
    expect(r).toMatchObject({ ok: true, value: [{ name: 'DEVPC', owner: 'Filip' }] });
  });

  it('creates a server workspace from the empty folder, then removes tf\'s automatic $/ mapping (P1)', async () => {
    const f = fakeClient([ok(), ok()]);
    const svc = new WorkspaceService(f.client, URL, 'win32');

    const r = await svc.create('NEWPC', 'C:\\Temp\\tfvc-new-ws-1');

    expect(r.ok).toBe(true);
    expect(f.calls[0].args).toEqual(['vc', 'workspace', '/new', 'NEWPC', `/collection:${URL}`, '/location:server']);
    expect(f.calls[0].opts.cwd).toBe('C:\\Temp\\tfvc-new-ws-1');
    expect(f.calls[1].args).toEqual(['vc', 'workfold', '/unmap', 'C:\\Temp\\tfvc-new-ws-1', '/workspace:NEWPC']);
  });

  it('says the workspace exists with a stray $/ mapping when the unmap fails, and stops', async () => {
    const f = fakeClient([ok(), failed('TF14061: The workspace NEWPC does not exist.')]);
    const svc = new WorkspaceService(f.client, URL, 'win32');

    const r = await svc.create('NEWPC', 'C:\\Temp\\x');

    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toContain('$/');
    expect(f.calls).toHaveLength(2);
  });

  it('does not unmap anything when the create itself fails', async () => {
    const f = fakeClient([failed('TF14044: Access denied.')]);
    const svc = new WorkspaceService(f.client, URL, 'win32');

    expect((await svc.create('NEWPC', 'C:\\Temp\\x')).ok).toBe(false);
    expect(f.calls).toHaveLength(1);
  });

  it('still unmaps after an UNKNOWN /new (timed out), and says the workspace may exist (I1)', async () => {
    const f = fakeClient([{ ...ok(), exitCode: -1, timedOut: true }, ok()]);
    const svc = new WorkspaceService(f.client, URL, 'win32');

    const r = await svc.create('NEWPC', 'C:\\Temp\\tfvc-new-ws-1');

    expect(f.calls).toHaveLength(2);
    expect(f.calls[1].args).toEqual(['vc', 'workfold', '/unmap', 'C:\\Temp\\tfvc-new-ws-1', '/workspace:NEWPC']);
    expect(f.calls[1].opts.cwd).toBe('C:\\Temp\\tfvc-new-ws-1');
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toContain('NEWPC');
    expect(!r.ok && r.message).toMatch(/may/i);
  });

  it('still unmaps after an UNKNOWN /new (terminated by signal), reporting the mapping WAS removed', async () => {
    const f = fakeClient([{ ...ok(), exitCode: -1, terminatedBy: 'SIGTERM' }, ok()]);
    const svc = new WorkspaceService(f.client, URL, 'win32');

    const r = await svc.create('NEWPC', 'C:\\Temp\\x');

    expect(f.calls).toHaveLength(2);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).not.toMatch(/could not/i);
  });

  it('still unmaps after a bare exit -1 with no tf text, reporting when the unmap ALSO failed', async () => {
    const f = fakeClient([{ ...ok(), exitCode: -1 }, failed('TF14061: The workspace NEWPC does not exist.')]);
    const svc = new WorkspaceService(f.client, URL, 'win32');

    const r = await svc.create('NEWPC', 'C:\\Temp\\x');

    expect(f.calls).toHaveLength(2);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toMatch(/could not/i);
  });

  it('refuses to create in a temp folder tf cannot pass through the wrapper, and runs nothing (M4)', async () => {
    const f = fakeClient([ok(), ok()]);
    const svc = new WorkspaceService(f.client, URL, 'win32');

    const r = await svc.create('NEWPC', 'C:\\Temp\\bad!name');

    expect(r.ok).toBe(false);
    expect(f.calls).toHaveLength(0);
  });

  it('creates on Linux with tf\'s Z:\\ form, cwd native, and unmaps in tf form too (I3a)', async () => {
    const f = fakeClient([ok(), ok()]);
    const svc = new WorkspaceService(f.client, URL, 'linux');

    const r = await svc.create('X', '/tmp/tfvc-new-ws-1');

    expect(r.ok).toBe(true);
    expect(f.calls[0].args).toEqual(['vc', 'workspace', '/new', 'X', `/collection:${URL}`, '/location:server']);
    expect(f.calls[0].opts.cwd).toBe('/tmp/tfvc-new-ws-1');
    expect(f.calls[1].args).toEqual(['vc', 'workfold', '/unmap', 'Z:\\tmp\\tfvc-new-ws-1', '/workspace:X']);
    expect(f.calls[1].opts.cwd).toBe('/tmp/tfvc-new-ws-1');
  });

  it('runs /new, /map and /unmap with a floor of 120s regardless of the configured timeout (I1 point 2)', async () => {
    const f = fakeClient([ok(), ok()]);
    f.client.timeoutMs = 1_000;
    const svc = new WorkspaceService(f.client, URL, 'win32');

    await svc.create('NEWPC', 'C:\\Temp\\x');

    expect(f.calls[0].opts.timeoutMs).toBe(120_000);
    expect(f.calls[1].opts.timeoutMs).toBe(120_000);
  });

  it('maps with the collection, and unmaps WITHOUT it (P6)', async () => {
    const f = fakeClient([ok(), ok()]);
    const svc = new WorkspaceService(f.client, URL, 'win32');

    await svc.map('DEVPC', '$/Ledger', 'D:\\work\\Ledger');
    await svc.unmap('DEVPC', 'D:\\work\\Ledger');

    expect(f.calls[0].args).toEqual(['vc', 'workfold', '/map', '$/Ledger', 'D:\\work\\Ledger', '/workspace:DEVPC', `/collection:${URL}`]);
    expect(f.calls[1].args).toEqual(['vc', 'workfold', '/unmap', 'D:\\work\\Ledger', '/workspace:DEVPC']);
    expect(f.calls[1].args.some((a) => a.startsWith('/collection'))).toBe(false);
  });

  it('passes local paths to tf in its Z:\\ form on Linux', async () => {
    const f = fakeClient([ok()]);
    const svc = new WorkspaceService(f.client, URL, 'linux');

    await svc.map('Fedora', '$/Ledger', '/home/shax/ledger');

    expect(f.calls[0].args[4]).toBe('Z:\\home\\shax\\ledger');
    expect(svc.fromTf('Z:\\home\\shax\\work')).toBe('/home/shax/work');
  });

  it('runs /map and /unmap with a floor of 120s regardless of the configured timeout (I1 point 2)', async () => {
    const f = fakeClient([ok(), ok()]);
    f.client.timeoutMs = 1_000;
    const svc = new WorkspaceService(f.client, URL, 'win32');

    await svc.map('DEVPC', '$/X', 'C:\\x');
    await svc.unmap('DEVPC', 'C:\\x');

    expect(f.calls[0].opts.timeoutMs).toBe(120_000);
    expect(f.calls[1].opts.timeoutMs).toBe(120_000);
  });

  it('reports a timed-out /map with the standard timeout message, at the timeout actually used (failure() timeout branch)', async () => {
    const f = fakeClient([{ ...ok(), exitCode: -1, timedOut: true }]);
    f.client.timeoutMs = 1_000;
    const svc = new WorkspaceService(f.client, URL, 'win32');

    const r = await svc.map('DEVPC', '$/X', 'C:\\x');

    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toContain('120000');
  });

  it('lists the subfolders of a server folder', async () => {
    const f = fakeClient([ok(fixture('windows/dir-root.txt'))]);
    const svc = new WorkspaceService(f.client, URL, 'win32');

    const r = await svc.folders('$/');

    // With the collection: on a new machine no workspace exists yet for tf to infer it from.
    expect(f.calls[0].args).toEqual(['vc', 'dir', '$/', `/collection:${URL}`]);
    expect(r.ok && r.value).toContain('Partners');
  });

  it('gets with no timeout, counting items for progress', async () => {
    const f = fakeClient([ok(fixture('fedora/get-recursive.txt'))]);
    const svc = new WorkspaceService(f.client, URL, 'win32');
    const seen: number[] = [];

    const r = await svc.get('C:\\work\\Shop', (n) => seen.push(n), new AbortController().signal);

    expect(f.calls[0].args).toEqual(['vc', 'get', 'C:\\work\\Shop', '/recursive']);
    expect(f.calls[0].opts.timeoutMs).toBe('none');
    expect(r).toEqual({ ok: true, value: { items: 3, cancelled: false } });
    expect(seen).toEqual([1, 2, 3]);
  });

  it('gets using tf\'s Z:\\ form on Linux (I3a)', async () => {
    const f = fakeClient([ok(fixture('fedora/get-recursive.txt'))]);
    const svc = new WorkspaceService(f.client, URL, 'linux');

    await svc.get('/tmp/tfvc-probe-ws', () => {}, new AbortController().signal);

    expect(f.calls[0].args).toEqual(['vc', 'get', 'Z:\\tmp\\tfvc-probe-ws', '/recursive']);
  });

  it('passes the caller\'s own abort signal through to run, unchanged (I3b)', async () => {
    const f = fakeClient([ok()]);
    const svc = new WorkspaceService(f.client, URL, 'win32');
    const signal = new AbortController().signal;

    await svc.get('C:\\x', () => {}, signal);

    expect(f.calls[0].opts.signal).toBe(signal);
  });

  it('reports a cancelled get as cancelled, not as a failure', async () => {
    const f = fakeClient([{ ...ok(), exitCode: -1, cancelled: true }]);
    const svc = new WorkspaceService(f.client, URL, 'win32');

    expect(await svc.get('C:\\x', () => {}, new AbortController().signal)).toEqual({ ok: true, value: { items: 0, cancelled: true } });
  });

  it('reports a get that finished (exit 0) as a plain success even if cancel was pressed at the same moment (M1)', async () => {
    const f = fakeClient([{ ...ok(), cancelled: true }]);
    const svc = new WorkspaceService(f.client, URL, 'win32');

    expect(await svc.get('C:\\x', () => {}, new AbortController().signal)).toEqual({ ok: true, value: { items: 0, cancelled: false } });
  });

  it('reports a partial get (non-zero exit, not cancelled) as a failure that keeps the item count and excludes Getting lines (I2)', async () => {
    const stdout = [
      'C:\\work\\Shop:',
      'Getting date.js',
      'Getting smiley.jpg',
      'C:\\work\\Shop\\sub:',
      'Getting other.js',
      'There is a conflict on this item; get specific version to resolve it.',
    ].join('\r\n');
    const f = fakeClient([{ ...ok(stdout), stderr: Buffer.from('TF10142: Some files could not be gotten.'), exitCode: 1 }]);
    const svc = new WorkspaceService(f.client, URL, 'win32');

    const r = await svc.get('C:\\work\\Shop', () => {}, new AbortController().signal);

    expect(r.ok).toBe(false);
    expect(!r.ok && r.items).toBe(3);
    if (!r.ok) {
      expect(r.message).toContain('3');
      expect(r.message).toContain('TF10142');
      expect(r.message).toContain('conflict');
      expect(r.message).not.toContain('Getting date.js');
      expect(r.message).not.toContain('Getting smiley.jpg');
      expect(r.message).not.toContain('Getting other.js');
    }
  });

  it('logs the full partial-get problem text through the optional log callback (I2)', async () => {
    const stdout = ['C:\\x:', 'Getting a.txt', 'A problem line.'].join('\r\n');
    const f = fakeClient([{ ...ok(stdout), stderr: Buffer.alloc(0), exitCode: 1 }]);
    const logged: string[] = [];
    const svc = new WorkspaceService(f.client, URL, 'win32', (line) => logged.push(line));

    await svc.get('C:\\x', () => {}, new AbortController().signal);

    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain('A problem line.');
  });

  it('turns a tf failure into a message', async () => {
    const f = fakeClient([failed('TF10122: The path $/Nope is not found.')]);
    const svc = new WorkspaceService(f.client, URL, 'win32');

    const r = await svc.folders('$/Nope');

    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toContain('TF10122');
  });
});
