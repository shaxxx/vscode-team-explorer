import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EventEmitter, recorder } from '../vscode-mock.js';
import { ConflictService, INFO_BATCH } from '../../src/conflicts/ConflictService.js';
import { PathMapper } from '../../src/tf/PathMapper.js';
import { S } from '../../src/tf/strings.js';

const fx = (dir: 'windows' | 'fedora', name: string) => readFileSync(join(__dirname, '../fixtures', dir, name));
const flush = () => new Promise((r) => setImmediate(r));

interface Answer {
  stdout?: Buffer | string;
  stderr?: Buffer | string;
  exitCode?: number;
  timedOut?: boolean;
}
interface Call {
  args: string[];
  cwd: string | undefined;
}

function fakeClient(answer: (args: string[]) => Answer | Promise<Answer>) {
  const calls: Call[] = [];
  const buf = (v: Buffer | string | undefined) =>
    typeof v === 'string' ? Buffer.from(v, 'utf8') : (v ?? Buffer.alloc(0));
  return {
    calls,
    client: {
      timeoutMs: 60_000,
      run: async (args: string[], opts: { cwd?: string } = {}) => {
        calls.push({ args, cwd: opts.cwd });
        const a = await answer(args);
        return { stdout: buf(a.stdout), stderr: buf(a.stderr), exitCode: a.exitCode ?? 0, timedOut: a.timedOut ?? false };
      },
    },
  };
}

const WORK = String.raw`C:\work`;
const INSIGHT = String.raw`C:\Users\user1\Downloads\Insight.Database-main\Insight.Database`;
const DEVPC_FOLDERS = [
  { localPath: WORK, serverItem: '$/' },
  { localPath: INSIGHT, serverItem: '$/Vesta/DatabaseFirst/Insight.Database' },
];

function fakeService(opts: {
  folders?: { localPath: string; serverItem: string }[];
  /** Another workspace's mappings: in the shared mapper, never in workspaceFolders. */
  others?: { localPath: string; serverItem: string }[];
  root?: string;
  platform?: 'win32' | 'linux';
} = {}) {
  const changed = new EventEmitter<void>();
  const folders = opts.folders ?? DEVPC_FOLDERS;
  const platform = opts.platform ?? 'win32';
  return {
    changed,
    service: {
      onDidChange: changed.event,
      pathMapper: new PathMapper([...folders, ...(opts.others ?? [])], platform),
      workspaceFolders: folders,
      workspaceRoot: opts.root ?? String.raw`C:\work\Shop`,
      platform,
    },
  };
}

const log: string[] = [];
const make = (client: unknown, service: unknown) =>
  new ConflictService(client as never, service as never, (line) => log.push(line));

const NONE: Answer = { stdout: fx('windows', 'resolve-preview-none.stdout.txt') };
const REAL: Answer = { stderr: fx('windows', 'resolve-preview-real-devpc.stderr.txt'), exitCode: 1 };
const INFO: Answer = { stdout: fx('windows', 'resolve-info-three.txt') };
const CORE = String.raw`C:\work\OPS\OPS2023\CORE.Api\CORE.Api.xml`;

beforeEach(() => {
  recorder.reset();
  log.length = 0;
});

describe('ConflictService.check', () => {
  it('asks resolve about every mapping of the workspace, from the opened folder, and stops there when there are none', async () => {
    const { calls, client } = fakeClient(() => NONE);
    const s = make(client, fakeService().service);
    expect(await s.check()).toEqual([]);
    expect(calls).toEqual([{ args: ['vc', 'resolve', WORK, INSIGHT, '/recursive', '/preview'], cwd: String.raw`C:\work\Shop` }]);
    s.dispose();
  });

  it('describes the real DEVPC conflict from info: Binary, yours from C15451, server at C21004 (C19)', async () => {
    const { calls, client } = fakeClient((args) => (args[1] === 'resolve' ? REAL : INFO));
    const s = make(client, fakeService().service);
    expect(await s.check()).toEqual([
      {
        localPath: CORE,
        tfPath: CORE,
        serverPath: '$/OPS/OPS2023/CORE.Api/CORE.Api.xml',
        reason: 'You have a conflicting pending change.',
        family: 'version',
        base: 15451,
        theirs: 21004,
        binary: true,
      },
    ]);
    expect(calls[1]).toEqual({ args: ['vc', 'info', CORE], cwd: String.raw`C:\work\Shop` });
    s.dispose();
  });

  it('joins a relative path to the working directory it ran in (C7)', async () => {
    const root = String.raw`C:\work\Shop\Shop2023\Enterprise.Till.Server`;
    const { client } = fakeClient((args) =>
      args[1] === 'resolve' ? { stderr: fx('windows', 'resolve-preview-relative.stderr.txt'), exitCode: 1 } : { stdout: '' },
    );
    const s = make(client, fakeService({ root }).service);
    const list = await s.check();
    expect(list.map((c) => [c.localPath, c.tfPath, c.serverPath])).toEqual([
      [`${root}\\Program.cs`, `${root}\\Program.cs`, '$/Shop/Shop2023/Enterprise.Till.Server/Program.cs'],
      [`${root}\\Startup.cs`, `${root}\\Startup.cs`, '$/Shop/Shop2023/Enterprise.Till.Server/Startup.cs'],
    ]);
    s.dispose();
  });

  it("reads FEDORA's Z: paths back to Linux ones, and a never-downloaded file as blocked (C5, C7)", async () => {
    const folders = [{ localPath: String.raw`Z:\home\shax\p5-Urudžbeni zapisnik`, serverItem: '$/Urudžbeni zapisnik' }];
    const cases = [
      ['resolve-preview-absolute-croatian.stderr.txt', '/home/shax'],
      ['resolve-preview-relative-croatian.stderr.txt', '/home/shax/p5-Urudžbeni zapisnik'],
    ] as const;
    for (const [name, root] of cases) {
      const { calls, client } = fakeClient((args) =>
        args[1] === 'resolve' ? { stderr: fx('fedora', name), exitCode: 1 } : { stdout: fx('fedora', 'resolve-info-blocked.txt') },
      );
      const s = make(client, fakeService({ folders, root, platform: 'linux' }).service);
      const [c] = await s.check();
      expect(c.localPath, name).toBe('/home/shax/p5-Urudžbeni zapisnik/Urudzbeni.sln');
      expect(c.tfPath, name).toBe(String.raw`Z:\home\shax\p5-Urudžbeni zapisnik\Urudzbeni.sln`);
      expect(c.serverPath, name).toBe('$/Urudžbeni zapisnik/Urudzbeni.sln');
      expect([c.family, c.base, c.theirs, c.binary], name).toEqual(['blocked', undefined, 14353, false]);
      expect(calls[0].cwd, name).toBe(root);
      s.dispose();
    }
  });

  it('places a conflict tf names by server path where the workspace maps it (no local item)', async () => {
    const { client } = fakeClient((args) =>
      args[1] === 'resolve' ? { stderr: '$/Shop/Shop2023/gone.cs: something about it\r\n', exitCode: 1 } : { stdout: '' },
    );
    const s = make(client, fakeService().service);
    const [c] = await s.check();
    expect([c.localPath, c.tfPath, c.serverPath]).toEqual([
      String.raw`C:\work\Shop\Shop2023\gone.cs`,
      String.raw`C:\work\Shop\Shop2023\gone.cs`,
      '$/Shop/Shop2023/gone.cs',
    ]);
    // No local item, so an empty local half in info says nothing: never "blocked".
    expect(c.family).toBe('unknown');
    s.dispose();
  });

  it("places a server path with THIS workspace's mappings, never another workspace's closer one", async () => {
    const accept = String.raw`C:\Temp\TFVC-ACCEPT-P5`;
    const { client } = fakeClient((args) =>
      args[1] === 'resolve' ? { stderr: '$/Shop/Shop2023/gone.cs: reason\r\n', exitCode: 1 } : { stdout: '' },
    );
    const s = make(client, fakeService({ others: [{ localPath: accept, serverItem: '$/Shop/Shop2023' }] }).service);
    const [c] = await s.check();
    expect([c.localPath, c.tfPath]).toEqual([String.raw`C:\work\Shop\Shop2023\gone.cs`, String.raw`C:\work\Shop\Shop2023\gone.cs`]);
    s.dispose();
  });

  it('leaves out a server path this workspace does not map, and lists the rest', async () => {
    const { client } = fakeClient((args) =>
      args[1] === 'resolve'
        ? { stderr: `$/Elsewhere/a.cs: reason\r\n${String.raw`C:\work\b.cs`}: other\r\n`, exitCode: 1 }
        : { stdout: '' },
    );
    const s = make(client, fakeService({ folders: [{ localPath: WORK, serverItem: '$/Shop' }] }).service);
    expect((await s.check()).map((c) => c.localPath)).toEqual([String.raw`C:\work\b.cs`]);
    expect(log.some((l) => l.includes('$/Elsewhere/a.cs'))).toBe(true);
    s.dispose();
  });

  it('keeps the list it had when tf fails, and says why', async () => {
    let fail = false;
    const { client } = fakeClient((args) => {
      if (fail) return { stderr: 'TF30063: You are not authorized to access https://acme.visualstudio.com/.', exitCode: 100 };
      return args[1] === 'resolve' ? REAL : INFO;
    });
    const s = make(client, fakeService().service);
    let fired = 0;
    s.onDidChange(() => fired++);
    await s.check();
    fail = true;
    await expect(s.check()).rejects.toThrow(/TF30063/);
    expect(s.conflicts).toHaveLength(1);
    expect(fired).toBe(1);
    expect(log.some((l) => l.includes('TF30063'))).toBe(true);
    s.dispose();
  });

  it('treats a TF code on exit 1 as a failure, never as a conflict named TF30063', async () => {
    const { client } = fakeClient(() => ({ stderr: 'TF30063: You are not authorized.', exitCode: 1 }));
    const s = make(client, fakeService().service);
    await expect(s.check()).rejects.toThrow(/TF30063/);
    expect(s.conflicts).toEqual([]);
    s.dispose();
  });

  it('keeps the list it had when it does not understand the output', async () => {
    let odd = false;
    const { client } = fakeClient((args) => {
      if (odd) return { stdout: 'odd', stderr: 'a.cs: reason', exitCode: 1 };
      return args[1] === 'resolve' ? REAL : INFO;
    });
    const s = make(client, fakeService().service);
    let fired = 0;
    s.onDidChange(() => fired++);
    await s.check();
    odd = true;
    await expect(s.check()).rejects.toThrow(S.conflictsNotUnderstood(''));
    expect(s.conflicts).toHaveLength(1);
    expect(fired).toBe(1);
    s.dispose();
  });

  it('says a timeout is a timeout', async () => {
    const { client } = fakeClient(() => ({ timedOut: true, exitCode: -1 }));
    const s = make(client, fakeService().service);
    await expect(s.check()).rejects.toThrow(S.commandTimedOut(60_000));
    s.dispose();
  });

  it('asks nothing when the opened folder has no workspace', async () => {
    const { calls, client } = fakeClient(() => NONE);
    const s = make(client, fakeService({ folders: [] }).service);
    await expect(s.check()).rejects.toThrow(S.noWorkspaceMapping);
    expect(calls).toEqual([]);
    s.dispose();
  });

  it('forgets its conflicts when the folder stops having a workspace: a definite answer, not a failure', async () => {
    const { client } = fakeClient((args) => (args[1] === 'resolve' ? REAL : INFO));
    const { service } = fakeService();
    const s = make(client, service);
    let fired = 0;
    s.onDidChange(() => fired++);
    await s.check();
    expect(s.conflicts).toHaveLength(1);
    service.workspaceFolders = [];
    await expect(s.check()).rejects.toThrow(S.noWorkspaceMapping);
    expect(s.conflicts).toEqual([]);
    expect(fired).toBe(2);
    s.dispose();
  });

  it('asks info in batches, never one command line for a thousand paths', async () => {
    const lines = Array.from({ length: INFO_BATCH + 1 }, (_, i) => `${WORK}\\f${i}.cs: You have a conflicting pending change.`);
    const { calls, client } = fakeClient((args) =>
      args[1] === 'resolve' ? { stderr: lines.join('\r\n'), exitCode: 1 } : { stdout: '' },
    );
    const s = make(client, fakeService().service);
    expect(await s.check()).toHaveLength(INFO_BATCH + 1);
    const infos = calls.filter((c) => c.args[1] === 'info');
    expect(infos.map((c) => c.args.length - 2)).toEqual([INFO_BATCH, 1]);
    s.dispose();
  });

  it('tells its listeners only when the list changed', async () => {
    const { client } = fakeClient((args) => (args[1] === 'resolve' ? REAL : INFO));
    const s = make(client, fakeService().service);
    let fired = 0;
    s.onDidChange(() => fired++);
    await s.check();
    await s.check();
    expect(fired).toBe(1);
    s.dispose();
  });

  it('runs one check at a time, and everyone who asks during one gets the NEXT one', async () => {
    const gates: (() => void)[] = [];
    const { calls, client } = fakeClient(() => new Promise<Answer>((resolve) => gates.push(() => resolve(NONE))));
    const s = make(client, fakeService().service);
    const first = s.check();
    const second = s.check();
    const third = s.check();
    expect(second).toBe(third);
    expect(calls).toHaveLength(1);
    gates.shift()!();
    await first;
    await flush();
    expect(calls).toHaveLength(2);
    gates.shift()!();
    await second;
    expect(calls).toHaveLength(2);
    s.dispose();
  });

  it('looks again after every pending-changes refresh (U3)', async () => {
    const { calls, client } = fakeClient(() => NONE);
    const { changed, service } = fakeService();
    const s = make(client, service);
    changed.fire();
    await flush();
    expect(calls).toHaveLength(1);
    s.dispose();
  });

  it('drops a result that lands after dispose', async () => {
    let open: (() => void) | undefined;
    const { client } = fakeClient((args) =>
      args[1] === 'resolve' ? new Promise<Answer>((resolve) => (open = () => resolve(REAL))) : INFO,
    );
    const s = make(client, fakeService().service);
    let fired = 0;
    s.onDidChange(() => fired++);
    const pending = s.check();
    s.dispose();
    open!();
    await pending;
    expect(fired).toBe(0);
    expect(s.conflicts).toEqual([]);
  });

  it('drops a result whose info lands after dispose', async () => {
    let open: (() => void) | undefined;
    let asked = false;
    const { client } = fakeClient((args) => {
      if (args[1] === 'resolve') return REAL;
      asked = true;
      return new Promise<Answer>((resolve) => (open = () => resolve(INFO)));
    });
    const s = make(client, fakeService().service);
    let fired = 0;
    s.onDidChange(() => fired++);
    const pending = s.check();
    while (!asked) await flush();
    s.dispose();
    open!();
    await pending;
    expect(fired).toBe(0);
    expect(s.conflicts).toEqual([]);
  });
});

describe('ConflictService.resolve and autoMergeAll', () => {
  async function withOne(answer: (args: string[]) => Answer) {
    const { calls, client } = fakeClient((args) =>
      args.some((a) => a.startsWith('/auto:')) ? answer(args) : args[1] === 'resolve' ? REAL : INFO,
    );
    const s = make(client, fakeService().service);
    const [c] = await s.check();
    calls.length = 0;
    return { s, c, calls };
  }

  it('names one item and one /auto:, then looks again', async () => {
    const { s, c, calls } = await withOne(() => ({ stdout: fx('windows', 'resolve-keepyours.stdout.txt') }));
    expect(await s.resolve(c, 'KeepYours')).toEqual({ ok: true, detail: expect.any(String) });
    expect(calls[0]).toEqual({ args: ['vc', 'resolve', CORE, '/auto:KeepYours'], cwd: String.raw`C:\work\Shop` });
    expect(calls[1].args.at(-1)).toBe('/preview');
    s.dispose();
  });

  it("reports tf's own words when it did not resolve (C12)", async () => {
    const { s, c } = await withOne(() => ({
      stdout: fx('windows', 'resolve-automerge-refused.stdout.txt'),
      stderr: fx('windows', 'resolve-automerge-refused.stderr.txt'),
      exitCode: 1,
    }));
    const outcome = await s.resolve(c, 'AutoMerge');
    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain('1 conflicting');
    expect(outcome.detail).toContain('You have a conflicting pending change.');
    s.dispose();
  });

  it('auto-merges every mapping root at once', async () => {
    const { s, calls } = await withOne(() => ({ stdout: '' }));
    await s.autoMergeAll();
    expect(calls[0].args).toEqual(['vc', 'resolve', WORK, INSIGHT, '/recursive', '/auto:AutoMerge']);
    s.dispose();
  });

  it('never throws when tf cannot even start', async () => {
    const { client } = fakeClient(() => {
      throw new Error('spawn EINVAL');
    });
    const s = make(client, fakeService().service);
    const c = { localPath: CORE, tfPath: CORE, serverPath: undefined, reason: 'r', family: 'unknown' as const, base: undefined, theirs: undefined, binary: false };
    expect(await s.resolve(c, 'TakeTheirs')).toEqual({ ok: false, detail: 'spawn EINVAL' });
    s.dispose();
  });
});
