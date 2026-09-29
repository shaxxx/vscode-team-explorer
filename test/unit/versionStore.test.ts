import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, readdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VersionStore, VersionError, versionTextFrom } from '../../src/history/VersionStore.js';
import { ENC_BINARY } from '../../src/ui/decode.js';
import { S } from '../../src/tf/strings.js';

// "kača" in windows-1250: 0xE8 is č there, and invalid on its own in UTF-8.
const CP1250_BYTES = Buffer.from([0x6b, 0x61, 0xe8, 0x61]);

interface Reply {
  stdout?: Buffer | string;
  stderr?: string;
  exitCode?: number;
  timedOut?: boolean;
  /** The signal that killed tf, when the reply simulates one (D18d). */
  terminatedBy?: NodeJS.Signals;
}

function fakeClient(reply: (args: string[]) => Reply) {
  const runs: string[][] = [];
  const client = {
    timeoutMs: 777,
    run: async (args: string[]) => {
      runs.push(args);
      const r = reply(args);
      return {
        stdout: Buffer.isBuffer(r.stdout) ? r.stdout : Buffer.from(r.stdout ?? '', 'utf8'),
        stderr: Buffer.from(r.stderr ?? '', 'utf8'),
        exitCode: r.exitCode ?? 0,
        timedOut: r.timedOut ?? false,
        terminatedBy: r.terminatedBy,
      };
    },
  };
  return { client, runs };
}

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'tfvc-versions-'));
  dirs.push(d);
  return d;
}

afterEach(() => {
  vi.useRealTimers();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const views = (runs: string[][]) => runs.filter((a) => a[1] === 'view');

describe('VersionStore.textAt', () => {
  it('runs view at exactly that changeset and decodes with the code page it is given', async () => {
    const { client, runs } = fakeClient(() => ({ stdout: CP1250_BYTES }));
    const store = new VersionStore(client, tempDir());
    const got = await store.textAt('$/A/b.vb', 7, async () => 1250);
    expect(got).toEqual({ text: 'kača', codePage: 1250 });
    expect(runs).toEqual([['vc', 'view', '$/A/b.vb', '/console', '/version:C7']]);
  });

  it('serves a second read from the cache, without tf and without asking for the code page', async () => {
    const { client, runs } = fakeClient(() => ({ stdout: CP1250_BYTES }));
    const store = new VersionStore(client, tempDir());
    await store.textAt('$/A/b.vb', 7, async () => 1250);
    const codePage = vi.fn(async () => 1250);
    expect((await store.textAt('$/A/b.vb', 7, codePage)).text).toBe('kača');
    expect(views(runs)).toHaveLength(1);
    expect(codePage).not.toHaveBeenCalled();
  });

  it('survives a restart: a new store on the same folder reads the disk, code page included', async () => {
    const dir = tempDir();
    const first = fakeClient(() => ({ stdout: CP1250_BYTES }));
    await new VersionStore(first.client, dir).textAt('$/A/b.vb', 7, async () => 1250);

    const second = fakeClient(() => ({ stdout: 'WRONG' }));
    const got = await new VersionStore(second.client, dir).textAt('$/A/b.vb', 7, async () => 65001);
    expect(got).toEqual({ text: 'kača', codePage: 1250 });
    expect(second.runs).toEqual([]);
  });

  it('treats server paths case-insensitively, as TFVC does', async () => {
    const { client, runs } = fakeClient(() => ({ stdout: 'x' }));
    const store = new VersionStore(client, tempDir());
    await store.textAt('$/A/B.vb', 7, async () => 65001);
    await store.textAt('$/a/b.VB', 7, async () => 65001);
    expect(views(runs)).toHaveLength(1);
  });

  it('never caches a failure: the next read asks tf again', async () => {
    let fail = true;
    const { client, runs } = fakeClient(() =>
      fail ? { exitCode: 1, stderr: '$/A/b.vb: No file matches.' } : { stdout: 'ok' },
    );
    const store = new VersionStore(client, tempDir());
    const failure = store.textAt('$/A/b.vb', 7, async () => 65001);
    await expect(failure).rejects.toBeInstanceOf(VersionError);
    await expect(failure).rejects.toThrow('No file matches.');
    fail = false;
    expect((await store.textAt('$/A/b.vb', 7, async () => 65001)).text).toBe('ok');
    expect(views(runs)).toHaveLength(2);
  });

  it('says so on a timeout', async () => {
    const { client } = fakeClient(() => ({ timedOut: true, exitCode: -1 }));
    await expect(new VersionStore(client, tempDir()).textAt('$/A', 1, async () => 65001)).rejects.toThrow(
      S.commandTimedOut(777),
    );
  });

  it('reports a killed tf as viewStopped, never with its partial output as the message, and logs a byte count (D18d)', async () => {
    const log: string[] = [];
    const partial = 'x'.repeat(1000); // bytes tf had already written before something killed it
    const { client } = fakeClient(() => ({ stdout: partial, exitCode: -1, terminatedBy: 'SIGTERM' }));
    const store = new VersionStore(client, tempDir(), (l) => log.push(l));
    let caught: unknown;
    try {
      await store.textAt('$/A', 1, async () => 65001);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(VersionError);
    expect((caught as Error).message).toBe(S.viewStopped('SIGTERM'));
    const logText = log.join('\n');
    expect(logText).toContain('SIGTERM');
    expect(logText).toContain(`${Buffer.byteLength(partial, 'utf8')} bytes`);
    expect(logText).not.toContain(partial);
  });

  it("words a classified failure with Phase 1's own wording, not tf's raw text alone (D18d)", async () => {
    // TF30063 is classified as a rejected PAT (src/tf/TfClient.ts).
    const { client } = fakeClient(() => ({ exitCode: 100, stderr: 'TF30063: not authorized' }));
    const failure = new VersionStore(client, tempDir()).textAt('$/A', 1, async () => 65001);
    await expect(failure).rejects.toThrow(S.patExpired);
    await expect(failure).rejects.toThrow('TF30063');
  });

  it('runs tf once for two concurrent reads of the same version', async () => {
    const { client, runs } = fakeClient(() => ({ stdout: 'x' }));
    const store = new VersionStore(client, tempDir());
    await Promise.all([store.textAt('$/A', 3, async () => 65001), store.textAt('$/A', 3, async () => 65001)]);
    expect(views(runs)).toHaveLength(1);
  });

  // D19a: only the raw `view` bytes are shared in flight; each caller's own
  // codePage() callback runs concurrently with it, not sequentially after the
  // shared promise as a whole resolves.
  it("starts a caller's own code-page callback at once, without waiting for the view to resolve first", async () => {
    let releaseView: () => void = () => {};
    const viewHeld = new Promise<void>((r) => (releaseView = r));
    const client = {
      timeoutMs: 777,
      run: async (args: string[]) => {
        if (args[1] === 'view') await viewHeld;
        return { stdout: Buffer.from('x'), stderr: Buffer.alloc(0), exitCode: 0, timedOut: false };
      },
    };
    const store = new VersionStore(client, tempDir());
    let pageCalled = false;
    const codePage = async () => {
      pageCalled = true;
      return 65001;
    };
    const pending = store.textAt('$/A', 1, codePage);
    await new Promise((r) => setImmediate(r)); // let microtasks run while the view is still held
    // Old code awaited the view fully before ever calling codePage(); with the
    // view held forever, `pageCalled` would still be false here.
    expect(pageCalled).toBe(true);
    releaseView();
    expect((await pending).text).toBe('x');
  });

  // D19a: this is the bug the final Annotate review found through the
  // Annotator (a re-annotate right after Hide) -- reproduced here directly at
  // the VersionStore level. Old code shared the FULL {bytes, codePage} result,
  // so the FIRST caller's callback was the only one that ever ran for a given
  // key; if it threw, every sibling sharing that fetch failed with it too,
  // even one with its own perfectly healthy callback.
  it('a joiner whose own code-page callback rejects lets a sibling caller still succeed, from the same shared fetch', async () => {
    const { client, runs } = fakeClient(() => ({ stdout: 'x' }));
    const store = new VersionStore(client, tempDir());
    const failing = async (): Promise<number | undefined> => {
      throw new Error('aborted');
    };
    const [a, b] = await Promise.allSettled([store.textAt('$/A', 1, failing), store.textAt('$/A', 1, async () => 65001)]);
    expect(a.status).toBe('rejected');
    expect(b.status).toBe('fulfilled');
    expect((b as PromiseFulfilledResult<{ text: string }>).value.text).toBe('x');
    expect(views(runs)).toHaveLength(1); // one shared view fetch, not one per caller

    // Written once, by the successful caller: a later read is served from
    // disk, without a third call to codePage or to tf.
    const thirdPage = vi.fn(async () => 65001);
    expect((await store.textAt('$/A', 1, thirdPage)).text).toBe('x');
    expect(thirdPage).not.toHaveBeenCalled();
    expect(views(runs)).toHaveLength(1);
  });

  it('evicts the least recently used entry once the cap would be exceeded', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const dir = tempDir();
    const { client, runs } = fakeClient((args) => ({ stdout: 'x'.repeat(40) + args[4] }));
    // Each entry is about 50 bytes on disk (header + 40 + the version suffix).
    const store = new VersionStore(client, dir, () => {}, 120);

    vi.setSystemTime(1000);
    await store.textAt('$/A', 1, async () => 65001);
    vi.setSystemTime(2000);
    await store.textAt('$/A', 2, async () => 65001);
    vi.setSystemTime(3000);
    await store.textAt('$/A', 1, async () => 65001); // touch 1: now 2 is the oldest
    vi.setSystemTime(4000);
    await store.textAt('$/A', 3, async () => 65001); // must evict one: 2

    expect(readdirSync(dir).filter((f) => f.endsWith('.bin'))).toHaveLength(2);
    const before = views(runs).length;
    await store.textAt('$/A', 1, async () => 65001);
    expect(views(runs).length, 'the recently used entry was evicted').toBe(before);
    await store.textAt('$/A', 2, async () => 65001);
    expect(views(runs).length, 'the least recently used entry was kept').toBe(before + 1);
  });

  it('returns but does not cache a version larger than the whole cap', async () => {
    const { client, runs } = fakeClient(() => ({ stdout: 'y'.repeat(500) }));
    const store = new VersionStore(client, tempDir(), () => {}, 100);
    expect((await store.textAt('$/A', 1, async () => 65001)).text).toHaveLength(500);
    await store.textAt('$/A', 1, async () => 65001);
    expect(views(runs)).toHaveLength(2);
  });

  it('works with no cache folder at all', async () => {
    const { client, runs } = fakeClient(() => ({ stdout: 'z' }));
    const store = new VersionStore(client, undefined);
    expect((await store.textAt('$/A', 1, async () => 65001)).text).toBe('z');
    await store.textAt('$/A', 1, async () => 65001);
    expect(views(runs)).toHaveLength(2);
  });

  it('refetches an entry whose header is not a code page', async () => {
    const dir = tempDir();
    const { client, runs } = fakeClient(() => ({ stdout: 'fresh' }));
    await new VersionStore(client, dir).textAt('$/A', 1, async () => 65001);
    const [file] = readdirSync(dir).filter((f) => f.endsWith('.bin'));
    writeFileSync(join(dir, file), Buffer.from('garbage\nstale', 'utf8'));
    expect((await new VersionStore(client, dir).textAt('$/A', 1, async () => 65001)).text).toBe('fresh');
    expect(views(runs)).toHaveLength(2);
    expect(readFileSync(join(dir, file), 'utf8')).toBe('65001\nfresh');
  });
});

describe('VersionStore disk cache resilience', () => {
  it('creates a missing, nested cache folder on first use, so a fresh profile still caches', async () => {
    const base = tempDir();
    const dir = join(base, 'gs', 'versions');

    const first = fakeClient(() => ({ stdout: CP1250_BYTES }));
    await new VersionStore(first.client, dir).textAt('$/A/b.vb', 7, async () => 1250);
    expect(views(first.runs)).toHaveLength(1);

    const second = fakeClient(() => ({ stdout: 'WRONG' }));
    const got = await new VersionStore(second.client, dir).textAt('$/A/b.vb', 7, async () => 65001);
    expect(got).toEqual({ text: 'kača', codePage: 1250 });
    expect(second.runs).toEqual([]);
  });

  it('falls back without disk caching, and logs it, when the folder path is actually a file', async () => {
    const base = tempDir();
    const dir = join(base, 'not-a-dir');
    writeFileSync(dir, 'oops');

    const log = vi.fn();
    const { client } = fakeClient(() => ({ stdout: 'x' }));
    const store = new VersionStore(client, dir, log);
    expect((await store.textAt('$/A', 1, async () => 65001)).text).toBe('x');
    expect(log).toHaveBeenCalled();
  });

  it('keeps working, and logs it, when the cache folder disappears mid-session', async () => {
    const dir = tempDir();
    const log = vi.fn();
    const { client } = fakeClient((args) => ({ stdout: args[4] === '/version:C1' ? 'one' : 'two' }));
    const store = new VersionStore(client, dir, log);

    expect((await store.textAt('$/A', 1, async () => 65001)).text).toBe('one');
    rmSync(dir, { recursive: true, force: true });

    expect((await store.textAt('$/A', 2, async () => 65001)).text).toBe('two');
    expect(log).toHaveBeenCalled();
  });

  it('carries the on-disk total across a restart, so the cap is enforced immediately', async () => {
    const dir = tempDir();
    // Same sizing as the eviction test above: ~57 bytes/entry, cap 120 fits two, not three.
    const { client } = fakeClient((args) => ({ stdout: 'x'.repeat(40) + args[4] }));

    const storeA = new VersionStore(client, dir, () => {}, 120);
    await storeA.textAt('$/A', 1, async () => 65001);
    await storeA.textAt('$/A', 2, async () => 65001);
    expect(readdirSync(dir).filter((f) => f.endsWith('.bin'))).toHaveLength(2);

    const storeB = new VersionStore(client, dir, () => {}, 120);
    await storeB.textAt('$/A', 3, async () => 65001);
    expect(readdirSync(dir).filter((f) => f.endsWith('.bin'))).toHaveLength(2);
  });

  it("scrubs a secret-looking bare token out of a spawn failure's message", async () => {
    // 40+ letters/digits with no separators, as scrubSecrets' bare-token rule targets.
    const secret = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2'; // gitleaks:allow (made up)
    const client = {
      timeoutMs: 777,
      run: async () => {
        throw new Error(`'${secret}' is not recognized as an internal or external command`);
      },
    };
    const store = new VersionStore(client, tempDir());

    let caught: unknown;
    try {
      await store.textAt('$/A', 1, async () => 65001);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(VersionError);
    expect((caught as Error).message).not.toContain(secret);
  });

  it('does not cache when the code-page callback throws, and asks tf again next time', async () => {
    const dir = tempDir();
    const { client, runs } = fakeClient(() => ({ stdout: 'x' }));
    const store = new VersionStore(client, dir);
    const failingCodePage = async (): Promise<number | undefined> => {
      throw new Error('info failed');
    };

    await expect(store.textAt('$/A', 1, failingCodePage)).rejects.toThrow('info failed');
    expect(readdirSync(dir).filter((f) => f.endsWith('.bin'))).toHaveLength(0);

    expect((await store.textAt('$/A', 1, async () => 65001)).text).toBe('x');
    expect(views(runs)).toHaveLength(2);
  });
});

describe('VersionStore.codePageAt', () => {
  it('asks tf vc info at that version and reads File type (F14)', async () => {
    const info = readFileSync(join(__dirname, '../fixtures/windows/info-at-version.txt'));
    const { client, runs } = fakeClient(() => ({ stdout: info }));
    const store = new VersionStore(client, undefined);
    expect(await store.codePageAt('$/Shop/Shop2023/Distribution/Forms/frmInvoice.vb', 20545)).toBe(65001);
    expect(await store.codePageAt('$/Shop/Shop2023/Distribution/Forms/frmInvoice.vb', 20545)).toBe(65001);
    expect(runs).toEqual([['vc', 'info', '$/Shop/Shop2023/Distribution/Forms/frmInvoice.vb', '/version:C20545']]);
  });

  it("surfaces tf's message when info fails", async () => {
    const { client } = fakeClient(() => ({ exitCode: 100, stderr: 'TF10167: no such item' }));
    await expect(new VersionStore(client, undefined).codePageAt('$/A', 3)).rejects.toThrow('TF10167');
  });
});

describe('versionTextFrom (D14: refuse a binary version)', () => {
  it('refuses a binary version, naming the file from its server path', async () => {
    const store = {
      textAt: async () => ({ text: 'megabytes of U+FFFD, ignored', codePage: ENC_BINARY }),
      codePageAt: async () => ENC_BINARY,
    };
    await expect(versionTextFrom(store)('$/A/x.dll', 7)).rejects.toThrow(S.compareBinary('x.dll'));
  });

  it('asks codePageAt for exactly the same path and changeset as the view', async () => {
    const textAtCalls: [string, number][] = [];
    const codePageAtCalls: [string, number][] = [];
    const store = {
      textAt: async (serverPath: string, changeset: number, codePage: () => Promise<number | undefined>) => {
        textAtCalls.push([serverPath, changeset]);
        return { text: 'x', codePage: await codePage() };
      },
      codePageAt: async (serverPath: string, changeset: number) => {
        codePageAtCalls.push([serverPath, changeset]);
        return 65001;
      },
    };
    await versionTextFrom(store)('$/A/b.vb', 9);
    expect(textAtCalls).toEqual([['$/A/b.vb', 9]]);
    expect(codePageAtCalls).toEqual([['$/A/b.vb', 9]]);
  });

  it('decodes a windows-1250 version correctly, over a real VersionStore and fake client', async () => {
    // Synthetic `tf vc info` reply, in the exact format of
    // test/fixtures/windows/info-at-version.txt (which is utf-8), but for a
    // windows-1250 file -- built inline per the phase 2 rules against
    // modifying or fabricating a fixture file.
    const info = [
      'Local information:',
      '  Local path : C:\\work\\A\\b.vb',
      '  Server path: $/A/b.vb',
      '  Changeset  : 10',
      '  Change     : none',
      '  Type       : file',
      'Server information:',
      '  Server path  : $/A/b.vb',
      '  Changeset    : 5',
      '  Deletion ID  : 0',
      '  Lock         : none',
      '  Lock owner   : ',
      '  Last modified: 1. sijecnja 2026. 0:00:00',
      '  Type         : file',
      '  File type    : windows-1250',
      '  Size         : 3',
      '',
    ].join('\n');
    // "čćž" in windows-1250.
    const CP1250_CCZ = Buffer.from([0xe8, 0xe6, 0x9e]);
    const { client, runs } = fakeClient((args) =>
      args[1] === 'view' ? { stdout: CP1250_CCZ } : { stdout: info },
    );
    const store = new VersionStore(client, undefined);
    expect(await versionTextFrom(store)('$/A/b.vb', 5)).toBe('čćž');
    expect(views(runs)).toEqual([['vc', 'view', '$/A/b.vb', '/console', '/version:C5']]);
    expect(runs.filter((a) => a[1] === 'info')).toEqual([['vc', 'info', '$/A/b.vb', '/version:C5']]);
  });
});
