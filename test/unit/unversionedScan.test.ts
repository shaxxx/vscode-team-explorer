import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { UnversionedScan } from '../../src/scan/UnversionedScan.js';
import { IgnoreMatcher, DEFAULT_IGNORE, TF_BUILTIN_EXCLUSIONS } from '../../src/ignore/IgnoreMatcher.js';
import { TOO_MANY_ITEMS_PREFIX } from '../../src/tf/TfClient.js';
import type { Platform } from '../../src/tf/PathMapper.js';
import { recorder, createdEmitters } from '../vscode-mock.js';
import { resolveFileState } from '../../src/state/FileState.js';

const fixture = (name: string) =>
  readFileSync(join(__dirname, '../fixtures/windows', name));

/** What one call to the fake client's run() answers with. */
interface FakeResult {
  stdout: Buffer;
  stderr?: Buffer;
  exitCode?: number;
  timedOut?: boolean;
  terminatedBy?: NodeJS.Signals;
}

/**
 * The scan asks `vc info` about its own folder before it reconciles, because
 * `reconcile` calls every file new until the mapping itself has been
 * downloaded (probes R28-R31). Every double below answers that probe from the
 * REAL capture of a downloaded folder and keeps it out of `calls`, so each
 * test still reads `calls[0]` as the reconcile it is about; the probe's own
 * arguments go to `infoCalls`, which the tests that care assert on.
 */
/** tf HAS this file at changeset 240 -- so calling it new is the contradiction. */
const INFO_VERSIONED = readFileSync(join(__dirname, '../fixtures/windows', 'info.txt'));
/**
 * One block, no local half: what tf says about an item it has never handed
 * out. (`fedora/info-not-downloaded.txt` is the same shape but SEVEN blocks,
 * from an `info <folder>/*` call, which this probe reads as "cannot say".)
 */
const INFO_NEW = readFileSync(
  join(__dirname, '../fixtures/windows', 'info-root-never-fetched.txt'),
);
const isInfoProbe = (args: readonly string[]): boolean => args[0] === 'vc' && args[1] === 'info';

/**
 * Answers the reconcile at once and leaves the `vc info` probe hanging, so a
 * test can `dispose()` while the scan is suspended at its SECOND await. Every
 * other double answers the probe synchronously, which is why none of them can
 * reach that state.
 */
function deferredInfoClient(reconcile: Buffer) {
  let resolveInfo!: (r: RunResult) => void;
  const pending = new Promise<RunResult>((res) => {
    resolveInfo = res;
  });
  return {
    run: async (args: string[]) => (isInfoProbe(args) ? pending : full(ok(reconcile))),
    resolveInfo: (r: FakeResult) => resolveInfo(full(r)),
  };
}

/** A `FakeResult` filled out into what `TfClient.run()` actually resolves with. */
function full(r: FakeResult) {
  return {
    stdout: r.stdout,
    stderr: r.stderr ?? Buffer.from(''),
    exitCode: r.exitCode ?? 0,
    timedOut: r.timedOut ?? false,
    terminatedBy: r.terminatedBy,
  };
}

const ok = (stdout: Buffer, exitCode = 0): FakeResult => ({ stdout, exitCode });
const killed = (signal: NodeJS.Signals): FakeResult => ({
  stdout: Buffer.from(''),
  exitCode: -1,
  terminatedBy: signal,
});
const timedOutResult = (): FakeResult => ({ stdout: Buffer.from(''), exitCode: -1, timedOut: true });

/**
 * A TfClient stand-in that answers a queue of results, one per call, sticking
 * on the last once the queue is down to it. This is what "a success then a
 * failure on one instance" needs, and it replaces `setClientForTest` -- a
 * public mutator that existed on `UnversionedScan` only so a test could swap
 * the whole client mid-scenario, and forced `client` to be non-`readonly` on
 * the one class in this codebase that spawns tf.
 */
function fakeClient(...results: FakeResult[]) {
  const calls: string[][] = [];
  const infoCalls: string[][] = [];
  const queue = [...results];
  let info: FakeResult = ok(INFO_NEW);
  return {
    calls,
    infoCalls,
    /** What the `vc info` precondition answers; the default is a downloaded folder. */
    answerInfoWith(r: FakeResult) {
      info = r;
    },
    run: async (args: string[]) => {
      if (isInfoProbe(args)) {
        infoCalls.push(args);
        return full(info);
      }
      calls.push(args);
      return full(queue.length > 1 ? queue.shift()! : queue[0]);
    },
  };
}

/** The common case: one call, one result. */
function client(stdout: Buffer, exitCode = 0) {
  return fakeClient(ok(stdout, exitCode));
}

/** What TfClient.run() itself resolves with. */
interface RunResult {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number;
  timedOut: boolean;
  terminatedBy?: NodeJS.Signals;
}

/** A run() that never resolves until the test says so -- five lines. */
function deferredClient() {
  const calls: string[][] = [];
  let resolveRun!: (r: RunResult) => void;
  const pending = new Promise<RunResult>((res) => {
    resolveRun = res;
  });
  return {
    calls,
    run: async (args: string[]) => {
      if (isInfoProbe(args)) return full(ok(INFO_NEW));
      calls.push(args);
      return pending;
    },
    resolveRun: (r: RunResult) => resolveRun(r),
  };
}

/**
 * Like `deferredClient`, but a FRESH pending promise per call, resolved in
 * call order -- needed for a test that runs the scan twice and controls each
 * run's landing independently. `deferredClient` reuses one promise for every
 * call, so a second `run()` after the first resolved would resolve instantly
 * with the first call's own answer.
 */
function twoStageDeferredClient() {
  const calls: string[][] = [];
  const resolvers: Array<(r: RunResult) => void> = [];
  return {
    calls,
    run: async (args: string[]) => {
      if (isInfoProbe(args)) return full(ok(INFO_NEW));
      calls.push(args);
      return new Promise<RunResult>((res) => resolvers.push(res));
    },
    resolveNext: (r: RunResult) => {
      const res = resolvers.shift();
      if (!res) throw new Error('twoStageDeferredClient: no pending call to resolve');
      res(r);
    },
  };
}

/**
 * The platform the temp dir actually lives on: those tests stat a REAL path,
 * so joining it with the other platform's separator would hide the header on
 * Fedora for the wrong reason.
 */
const NATIVE: Platform = process.platform === 'win32' ? 'win32' : 'linux';

/**
 * A fresh temp dir under `os.tmpdir()` for the tests that need the REAL
 * default `folderExists` (real `statSync`, not a fake). Removed afterwards
 * regardless of outcome.
 */
async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'tfvc-scan-'));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Lines the scan wrote to the output channel, for the log assertions. */
let logged: string[] = [];

function scan(
  c: ReturnType<typeof client>,
  patterns: readonly string[] = DEFAULT_IGNORE,
  opts: {
    platform?: Platform;
    toTfPath?: (localPath: string) => string;
    root?: string;
    folderExists?: (absolutePath: string) => boolean;
  } = {},
) {
  return new UnversionedScan(
    c as never,
    opts.root ?? 'C:/work/Personnel',
    opts.platform ?? 'win32',
    () => new IgnoreMatcher(patterns),
    { appendLine: (l: string) => logged.push(l) } as never,
    opts.toTfPath ?? ((p) => p),
    // Every fixture with a header names a directory that does not exist on
    // this machine -- () => true keeps these tests off the real filesystem,
    // the same way the fake client keeps them off real tf.
    opts.folderExists ?? (() => true),
  );
}

beforeEach(() => {
  recorder.reset();
  logged = [];
});

describe('tf contradicting itself about what is new (probes R28-R31)', () => {
  // `tf reconcile /promote /adds /preview` reports EVERY local file as
  // "Pending add" until the mapping itself has been fetched -- measured on
  // DEVPC, identical 20 seconds apart, and cleared by one `vc get` of the
  // mapping, while `tf info` put those same files at real changesets. Believing
  // it cost every versioned file its lock badge and put the whole tree in "Not
  // in source control" (found while accepting phase 3 part 3).
  //
  // What the scan checks is that CONTRADICTION, not the cause: asking `info`
  // about the mapped folder instead would switch the feature off on the real
  // Fedora workspace, which is mapped at `$/` and so has an empty local half
  // for its root however complete it is (measured, 2026-09-23).

  it('does not believe the listing, reports nothing, and says why', async () => {
    const c = client(fixture('reconcile-adds.txt'));
    c.answerInfoWith(ok(INFO_VERSIONED));
    const s = scan(c, DEFAULT_IGNORE, { root: 'C:/work/Personnel' });
    let fired = 0;
    s.onDidChange(() => { fired++; });

    await s.run();

    expect(s.result.verdictFor('C:/work/Personnel/anything.cs')).toBe('notScanned');
    expect(s.result.unversionedPaths()).toEqual([]);
    expect(fired, 'nothing changed, so nothing should redraw').toBe(0);
    expect(logged.join(String.fromCharCode(10))).toContain('also has at a changeset');
  });

  it('tells the user once, however many scans run', async () => {
    const c = client(fixture('reconcile-adds.txt'));
    c.answerInfoWith(ok(INFO_VERSIONED));
    const s = scan(c);

    await s.run();
    await s.run();
    await s.run();

    const about = recorder.shown.filter((m) => m.includes('Get Latest Version'));
    expect(about, 'one message, not one per scan').toHaveLength(1);
    // Still ASKED every time: the condition clears when the user acts, and
    // only a fresh answer can notice that.
    expect(c.infoCalls.length).toBeGreaterThan(1);
  });

  it('asks about the item tf just called new, not about the workspace folder', async () => {
    // The distinction that matters: a workspace mapped at `$/` has an empty
    // local half for its own root even when it is perfectly complete, so the
    // folder is the one thing this must never ask about.
    const c = client(fixture('reconcile-adds.txt'));
    const s = scan(c, DEFAULT_IGNORE, { root: 'C:/work' });
    await s.run();
    expect(c.infoCalls).toHaveLength(1);
    const asked = c.infoCalls[0][2];
    expect(asked).not.toBe('C:/work');
    expect(asked.length).toBeGreaterThan('C:/work'.length);
  });

  it('says it again when the user presses Refresh, having said it once already', async () => {
    // Once per session is right for scans nobody asked for -- activation, a
    // watcher event, a settings change. It is wrong for the one action a
    // puzzled user takes: they dismissed the notice, noticed the list is
    // empty, and hit Refresh to find out why.
    const c = client(fixture('reconcile-adds.txt'));
    c.answerInfoWith(ok(INFO_VERSIONED));
    const s = scan(c);

    await s.run();
    await s.run();
    expect(recorder.shown, 'unasked-for scans stay quiet after the first').toHaveLength(1);

    await s.run({ userAsked: true });
    expect(recorder.shown, 'but Refresh is the user asking').toHaveLength(2);
  });

  it('asks nothing at all when the listing is empty: there is nothing to distrust', async () => {
    const c = client(fixture('reconcile-empty.txt'));
    const s = scan(c);
    await s.run();
    expect(c.infoCalls, 'a healthy steady state must cost no extra tf call').toEqual([]);
  });

  it('asks once and then remembers, when tf agrees the item is new', async () => {
    const c = client(fixture('reconcile-adds.txt'));
    const s = scan(c); // the default answer agrees: genuinely new
    await s.run();
    await s.run();
    expect(c.infoCalls, 'a listing tf has vouched for is not re-checked').toHaveLength(1);
    expect(s.result.unversionedPaths().length).toBeGreaterThan(0);
  });

  it('runs as before when tf cannot say: only a clear "no" switches this off', async () => {
    const c = client(fixture('reconcile-adds.txt'));
    c.answerInfoWith({ stdout: Buffer.from(''), stderr: Buffer.from('TF30063'), exitCode: 100 });
    const s = scan(c);
    await s.run();
    expect(s.result.unversionedPaths().length, 'a failing probe must not hide new files').toBeGreaterThan(0);
  });

  it('lets the user recover: once tf stops contradicting itself, the listing is believed', async () => {
    // Why the negative answer is never cached. The user reads the message, runs
    // Get Latest Version, and the next scan must act on the new answer.
    const c = client(fixture('reconcile-adds.txt'));
    c.answerInfoWith(ok(INFO_VERSIONED));
    const s = scan(c);

    await s.run();
    expect(s.result.unversionedPaths(), 'scan 1 stands down').toEqual([]);

    c.answerInfoWith(ok(INFO_NEW));
    await s.run();
    expect(s.result.unversionedPaths().length, 'scan 2 believes the listing').toBeGreaterThan(0);
  });

  it('does not cache "cannot say" as a yes: a later clear "no" still stands the scan down', async () => {
    const c = client(fixture('reconcile-adds.txt'));
    // Output this parser cannot read at all: not an answer either way. (A
    // non-zero exit is NOT this case -- tf refusing to describe an item is
    // what a file it has never heard of looks like, and the reconcile that
    // just succeeded rules out auth and connectivity.)
    c.answerInfoWith(ok(Buffer.from('tf: something entirely unexpected')));
    const s = scan(c);

    await s.run();
    expect(s.result.unversionedPaths().length, 'unknown proceeds').toBeGreaterThan(0);

    c.answerInfoWith(ok(INFO_VERSIONED));
    await s.run();
    expect(s.result.unversionedPaths(), 'and the answer is re-asked, not remembered').toEqual([]);
  });

  it('a dispose() DURING the probe lands nothing: no result, no message, no event', async () => {
    // The scan's second await needs its own disposed check, exactly like the
    // first one (which has its own pinning test below). Without it, a window
    // closed mid-probe still gets a warning toast and a redraw.
    const c = deferredInfoClient(fixture('reconcile-adds.txt'));
    const s = scan(c as never);
    let fired = 0;
    s.onDidChange(() => { fired++; });

    const running = s.run();
    await new Promise((r) => setTimeout(r, 0));
    s.dispose();
    c.resolveInfo(ok(INFO_VERSIONED));
    await running;

    expect(s.result.verdictFor('C:/work/Personnel/x.cs')).toBe('notScanned');
    expect(recorder.shown, 'a disposed scan must not talk to the user').toEqual([]);
    expect(fired, 'nor redraw anything').toBe(0);
  });
});

describe('the command it runs', () => {
  it('is preview-only, and that is not negotiable', async () => {
    // /preview is the ONLY thing between this feature and a repeat of the
    // 79,929-pending-change incident. The full command line, including
    // /noignore below, was verified inert three times against the live
    // workspace: pending count 49 before and after, every run (finding 19).
    const c = client(fixture('reconcile-empty.txt'));
    await scan(c).run();

    expect(c.calls[0]).toContain('/preview');
    expect(c.calls[0]).toContain('/promote');
    expect(c.calls[0]).toContain('/adds');
    expect(c.calls[0]).toContain('/recursive');
  });

  it('always passes /noignore, so tf applying a rule we cannot see never reads as "versioned"', async () => {
    // Without /noignore, tf silently obeys a subfolder .tfignore and hidden
    // defaults (*.vssscc, *.vspscc, *.dbmdl) that are not in its own printed
    // list of 22 -- see test/fixtures/README.md finding 19. /exclude: still
    // applies under /noignore, which is what makes passing every exclusion
    // ourselves (below) the exact substitute for tf's own rules.
    const c = client(fixture('reconcile-empty.txt'));
    await scan(c).run();
    expect(c.calls[0]).toContain('/noignore');
  });

  it('passes the ignore patterns to tf, so it never walks them', async () => {
    const c = client(fixture('reconcile-empty.txt'));
    await scan(c).run();
    const exclude = c.calls[0].find((a) => a.startsWith('/exclude:'));
    expect(exclude).toBeDefined();
    expect(exclude).toContain('node_modules');
    // Without this the whole-collection scan exits 100 on three files named
    // `nul`, and one project fails TF10122 on a `$$deepEqual` path.
    expect(exclude).toContain('nul');
  });

  it('still passes /exclude: when the ignorer contributes no patterns of its own', async () => {
    // TF_BUILTIN_EXCLUSIONS is never empty, so /exclude: is now ALWAYS
    // present, even when the ignorer (a user's `teamExplorer.ignore: []`)
    // contributes nothing -- unlike before /noignore, when tf's own 22
    // covered this case for free.
    const c = client(fixture('reconcile-empty.txt'));
    await scan(c, []).run();
    const exclude = c.calls[0].find((a) => a.startsWith('/exclude:'));
    expect(exclude).toBeDefined();
    expect(exclude).toContain('bin'); // one of TF_BUILTIN_EXCLUSIONS
    expect(c.calls[0]).toContain('/preview');
  });

  it('sends the exact args, in order: /noignore, builtins first, a user pattern after, duplicates collapsed', async () => {
    // Names the mutant: any reordering of /preview, /noignore, /recursive or
    // /exclude:, or a de-dup that keeps the WRONG spelling, changes this
    // array. 'BIN' duplicates the builtin 'bin' case-insensitively -- the
    // builtin's own spelling must win, since it comes first in the list.
    const c = client(fixture('reconcile-empty.txt'));
    await scan(c, ['BIN', 'myfolder']).run();
    const expectedExclude = `/exclude:${[...TF_BUILTIN_EXCLUSIONS, 'myfolder'].join(',')}`;
    expect(c.calls[0]).toEqual([
      'vc',
      'reconcile',
      '/promote',
      '/adds',
      '/preview',
      '/noignore',
      '/recursive',
      expectedExclude,
      'C:/work/Personnel',
    ]);
  });
});

describe("a root whose own folder name matches the scan's own exclusion patterns", () => {
  it('keeps a previous successful result, never calls client.run again, and logs why', async () => {
    // Kills a mutant that drops this guard entirely: 'dist' is in
    // DEFAULT_IGNORE, and what tf does with a self-excluded itemspec is
    // unverified, so not running it is the safe answer. The ignorer's
    // patterns can change between calls (this is what makes a
    // `teamExplorer.ignore` change take effect -- see extension.ts), so a
    // root that was fine on scan 1 can become self-excluded on scan 2; the
    // PREVIOUS result must survive that, not be thrown away.
    let call = 0;
    const patternsPerCall = [DEFAULT_IGNORE.filter((p) => p !== 'dist'), DEFAULT_IGNORE];
    const c = client(fixture('reconcile-cwd-is-root.txt'));
    const s = new UnversionedScan(
      c as never,
      'C:/work/dist',
      'win32',
      () => new IgnoreMatcher(patternsPerCall[Math.min(call++, patternsPerCall.length - 1)]),
      { appendLine: (l: string) => logged.push(l) } as never,
      (p) => p,
      () => true,
    );

    await s.run(); // scan 1: 'dist' is not excluded yet, so this runs and succeeds
    expect(c.calls).toHaveLength(1);
    const before = s.result.verdictFor('C:/work/dist/Personnel.Data');
    expect(before).toBe('notInSourceControl');

    await s.run(); // scan 2: now 'dist' IS excluded
    expect(c.calls).toHaveLength(1); // no second tf call
    expect(s.result.verdictFor('C:/work/dist/Personnel.Data')).toBe(before);
    expect(logged.some((l) => l.includes('C:/work/dist'))).toBe(true);
    expect(logged.some((l) => l.includes("excluded by the scan's own patterns"))).toBe(true);
  });

  it('uses the platform-appropriate basename on a NATIVE, backslash-only root', async () => {
    // Kills a `path.posix.basename` mutant: every other test in this file
    // spells its root with `/`, which posix.basename ALSO splits on, so it
    // cannot tell the two implementations apart. A native win32 path has no
    // `/` at all -- path.posix.basename('C:\\work\\dist') returns the WHOLE
    // string, which never matches 'dist', so a mutant using it would call
    // client.run instead of skipping.
    const c = client(fixture('reconcile-empty.txt'));
    const s = scan(c, DEFAULT_IGNORE, { root: 'C:\\work\\dist' });
    await s.run();
    expect(c.calls).toHaveLength(0);
  });

  it('checks against the built-ins too, not just the ignorer', async () => {
    // 'Release' is one of TF_BUILTIN_EXCLUSIONS, never in DEFAULT_IGNORE --
    // kills a mutant that checks `ignore.matches(rootName)` (the ignorer
    // alone) instead of `exclusion.matches(rootName)` (built-ins included).
    const c = client(fixture('reconcile-empty.txt'));
    const s = scan(c, DEFAULT_IGNORE, { root: 'C:/work/Release' });
    await s.run();
    expect(c.calls).toHaveLength(0);
  });
});

describe('the itemspec sent to tf', () => {
  it('is translated by toTfPath before being sent (Fedora/Wine)', async () => {
    // Mimics PathMapper.toWinePath (src/tf/PathMapper.ts:44) without
    // importing it -- this class is required to stay Wine-blind, so this
    // proves only that whatever function is handed in is called on the root
    // and its result becomes the itemspec, not that this class knows Wine
    // exists.
    const toTfPath = (p: string) => 'Z:' + p.replace(/\//g, '\\');
    const c = client(fixture('reconcile-empty.txt'));
    await scan(c, DEFAULT_IGNORE, {
      platform: 'linux',
      toTfPath,
      root: '/home/shax/work/Personnel',
    }).run();
    const args = c.calls[0];
    expect(args[args.length - 1]).toBe('Z:\\home\\shax\\work\\Personnel');
  });

  it('keeps the native path as the itemspec when the translation is identity (win32)', async () => {
    const c = client(fixture('reconcile-empty.txt'));
    await scan(c, DEFAULT_IGNORE, { platform: 'win32', toTfPath: (p) => p }).run();
    const args = c.calls[0];
    expect(args[args.length - 1]).toBe('C:/work/Personnel');
  });
});

describe('what it does with the answer', () => {
  it('reports the items it found', async () => {
    const s = scan(client(fixture('reconcile-cwd-is-root.txt')));
    await s.run();
    expect(s.result.verdictFor('C:/work/Personnel/Personnel.Data')).toBe('notInSourceControl');
  });

  it('says in-source-control for a covered path it did not list', async () => {
    const s = scan(client(fixture('reconcile-cwd-is-root.txt')));
    await s.run();
    expect(s.result.verdictFor('C:/work/Personnel/Program.vb')).toBe('inSourceControl');
  });

  it("keeps ScanResult's coverage in sync with the list tf was actually given", async () => {
    // Kills three mutants at the ScanResult construction call: swapping the
    // (exclusion, ignore) argument order; passing (ignore, ignore); and
    // passing only `ignore.excludePatterns()` (drops the built-ins). 'bin' is
    // a built-in ONLY, never in DEFAULT_IGNORE, so all three would leave it
    // covered and unlisted -- answering `inSourceControl`, the false `!` this
    // whole feature exists to avoid. node_modules is the other half: it comes
    // only from the ignorer, so building the exclusion from the built-ins
    // alone would leave it covered.
    const s = scan(client(fixture('reconcile-empty.txt')));
    await s.run();
    expect(s.result.verdictFor('C:/work/Personnel/bin/App.dll')).toBe('notScanned');
    expect(s.result.verdictFor('C:/work/Personnel/node_modules/x.js')).toBe('notScanned');
  });

  it('finds the .vspscc file a default-mode scan silently hid (finding 19)', async () => {
    // reconcile-noignore-vspscc.txt: a real /noignore capture, cwd C:/work/Shop.
    // A data pin, not a mutant-killer: the fake client returns this fixture
    // regardless of args, so this only pins that the scan resolves a real
    // capture's nested-backslash header into the right verdict. The tests
    // "always passes /noignore..." and "sends the exact args..." above are
    // what actually kill a "drops /noignore" mutant.
    const s = scan(client(fixture('reconcile-noignore-vspscc.txt')), DEFAULT_IGNORE, {
      root: 'C:/work/Shop',
    });
    await s.run();
    expect(
      s.result.verdictFor(
        'C:/work/Shop/CardGatewayTool/CardGatewayTool/CardGatewayTool.csproj.vspscc',
      ),
    ).toBe('notInSourceControl');
  });

  it('fires once when a scan lands', async () => {
    const s = scan(client(fixture('reconcile-empty.txt')));
    const seen: unknown[] = [];
    s.onDidChange(() => seen.push(1));
    await s.run();
    expect(seen).toHaveLength(1);
  });
});

describe('a Pending edit line (finding 27): a writable, edited, versioned file', () => {
  // reconcile-pending-edit.txt: the real capture. Before the fix, `Pending
  // edit:` was an unrecognised line, so parseReconcile reported a problem and
  // the whole scan was discarded -- this file's own hazard badge never drew,
  // and any real add in the same listing would have been lost with it.
  it('does not discard the scan: the edited file is reported in source control, not new', async () => {
    const s = scan(client(fixture('reconcile-pending-edit.txt')), DEFAULT_IGNORE, {
      root: 'C:/work/Shop',
    });
    await s.run();
    expect(s.result.verdictFor('C:/work/Shop/src/DemoShop/Models/Product.cs')).toBe(
      'inSourceControl',
    );
  });

  it('closes the loop onto FileState: writable + inSourceControl is the writableNotCheckedOut hazard', async () => {
    const s = scan(client(fixture('reconcile-pending-edit.txt')), DEFAULT_IGNORE, {
      root: 'C:/work/Shop',
    });
    await s.run();
    const verdict = s.result.verdictFor('C:/work/Shop/src/DemoShop/Models/Product.cs');
    expect(
      resolveFileState({
        change: undefined,
        itemType: 'File',
        readOnly: false, // attrib -r was run: the file is writable
        ignored: false,
        mapped: true,
        scan: verdict,
      }),
    ).toBe('writableNotCheckedOut');
  });

  it('keeps a real add reported in the same listing as a Pending edit (synthetic: no real capture has both)', async () => {
    const stdout = Buffer.from(
      'src\\DemoShop\\Models:\r\nPending edit: Product.cs\r\nPending add: NewFile.cs\r\n',
      'utf8',
    );
    const s = scan(client(stdout), DEFAULT_IGNORE, { root: 'C:/work/Shop' });
    await s.run();
    expect(s.result.verdictFor('C:/work/Shop/src/DemoShop/Models/NewFile.cs')).toBe(
      'notInSourceControl',
    );
    expect(s.result.verdictFor('C:/work/Shop/src/DemoShop/Models/Product.cs')).toBe(
      'inSourceControl',
    );
  });

  it('is not a "problem": no warning is logged and the scan fires its change event', async () => {
    const s = scan(client(fixture('reconcile-pending-edit.txt')), DEFAULT_IGNORE, {
      root: 'C:/work/Shop',
    });
    const seen: unknown[] = [];
    s.onDidChange(() => seen.push(1));
    await s.run();
    expect(logged.some((l) => l.includes('output not understood'))).toBe(false);
    expect(seen).toHaveLength(1);
  });
});

describe('when the scan fails', () => {
  it('keeps the previous answer rather than replacing it with nothing, and does not fire', async () => {
    // A failed scan is not evidence that everything is versioned. Replacing a
    // good result with an empty one would turn every unversioned file into
    // `inSourceControl` -- the propagating hazard badge, on everything.
    const c = fakeClient(ok(fixture('reconcile-cwd-is-root.txt')), ok(fixture('reconcile-exit100.txt'), 100));
    const s = scan(c);
    await s.run();
    const before = s.result.verdictFor('C:/work/Personnel/Personnel.Data');
    expect(before).toBe('notInSourceControl');

    const seen: unknown[] = [];
    s.onDidChange(() => seen.push(1));
    await s.run();

    expect(s.result.verdictFor('C:/work/Personnel/Personnel.Data')).toBe(before);
    expect(seen).toHaveLength(0);
  });

  it('never parses the output of a non-zero-exit run', async () => {
    // Synthetic, NOT a capture. `reconcile-exit100.txt` is one error line with no
    // `Pending add:`, so parseReconcile returns [] from it either way and the
    // assertion cannot tell the guard from its absence. This stdout WOULD become
    // a path if the guard ever stopped running.
    const poison = Buffer.from('Pending add: NOT-A-REAL-FILE.vb\r\n', 'utf8');
    const s = scan(client(poison, 100));
    await s.run();
    expect(s.result.unversionedPaths()).toEqual([]);
    expect(s.result.verdictFor('C:/work/Personnel/NOT-A-REAL-FILE.vb')).toBe('notScanned');
  });

  it('answers notScanned for everything before the first run', () => {
    const s = scan(client(fixture('reconcile-empty.txt')));
    expect(s.result.verdictFor('C:/work/Personnel/anything.vb')).toBe('notScanned');
  });

  it('does not call a KILLED scan a failure, keeps the previous answer, and does not fire', async () => {
    // Node reports a signalled child as `code === null`, so its exit code says
    // nothing. Conflating "tf reported failure" with "we never learned the
    // outcome" once showed a user tf's own SUCCESS output inside a red error
    // dialog (FEDORA, 2026-09-18, fixed in 7ef6a26). Both outcomes keep the
    // previous result here, so what this pins is the LOG: it must not claim
    // the scan failed when nobody knows whether it did.
    const c = fakeClient(ok(fixture('reconcile-cwd-is-root.txt')), killed('SIGTERM'));
    const s = scan(c);
    await s.run();
    const before = s.result.verdictFor('C:/work/Personnel/Personnel.Data');
    expect(before).toBe('notInSourceControl');

    const seen: unknown[] = [];
    s.onDidChange(() => seen.push(1));
    await s.run();

    expect(s.result.verdictFor('C:/work/Personnel/Personnel.Data')).toBe(before);
    expect(logged.join('\n')).toContain('SIGTERM');
    expect(logged.join('\n')).not.toContain('failed');
    expect(seen).toHaveLength(0);
  });

  it('does not call a TIMED OUT scan a failure, keeps the previous answer, and does not fire', async () => {
    // The sibling of the killed-scan test above, and previously untested:
    // both fakes in this file used to hardcode `timedOut: false`, so this
    // branch (UnversionedScan.ts's `if (result.timedOut)`) had no test at
    // all. TfClient guarantees `timedOut && exitCode !== 0`, so deleting the
    // branch falls through to the exit-code guard and logs "failed (exit -1)"
    // -- exactly the failure/unknown-outcome conflation the killed-scan
    // branch exists to end, just for the other cause of "we never learned
    // what tf did".
    const c = fakeClient(ok(fixture('reconcile-cwd-is-root.txt')), timedOutResult());
    const s = scan(c);
    await s.run();
    const before = s.result.verdictFor('C:/work/Personnel/Personnel.Data');
    expect(before).toBe('notInSourceControl');

    const seen: unknown[] = [];
    s.onDidChange(() => seen.push(1));
    await s.run();

    expect(s.result.verdictFor('C:/work/Personnel/Personnel.Data')).toBe(before);
    expect(logged.join('\n')).toContain('timed out');
    expect(logged.join('\n')).not.toContain('failed');
    expect(seen).toHaveLength(0);
  });

  it('logs a scan-specific line, not the check-in wording, when the exclusion list is too long for one tf command', async () => {
    // TfClient refuses this itself (exit -1, empty stdout, reason in
    // stderr) rather than truncate an itemspec list. Its own wording
    // ("exclude some changes, act on the rest") is written for a check-in
    // the user chose to make -- wrong for a scan they did not ask to limit.
    const stderr = Buffer.from(
      `${TOO_MANY_ITEMS_PREFIX}: 500 items need 9000 characters, and the limit is 8000.\n` +
        'Nothing was run, and nothing was changed on the server.\n' +
        'Do this in smaller batches — exclude some changes, act on the rest, then repeat. ' +
        'tf cannot take the item list from a file.',
      'utf8',
    );
    const c = fakeClient({ stdout: Buffer.from(''), stderr, exitCode: -1 });
    const s = scan(c as never);
    await s.run();
    const log = logged.join('\n');
    expect(log).toMatch(/exclusion list is too long for one tf command \(\d+ patterns\)/);
    expect(log).not.toContain('exclude some changes');
    expect(log).not.toContain('failed (exit');
  });
});

describe('serialisation and the rerun flag', () => {
  /** One `RunResult`, for the `twoStageDeferredClient`/`deferredClient` tests below. */
  const landed = (stdout: Buffer): RunResult => ({
    stdout,
    stderr: Buffer.from(''),
    exitCode: 0,
    timedOut: false,
    terminatedBy: undefined,
  });

  it('a call while one is running does not join it: it schedules exactly one rerun, and its own promise waits for that rerun to land', async () => {
    // Not "joins the first" any more: the answer the in-flight scan is about
    // to produce was built before this call arrived, and may already be
    // stale (a `teamExplorer.ignore` change or another Refresh). If this
    // regressed to the old join behaviour there would be only ONE pending tf
    // call, and the second `resolveNext` below would throw
    // "no pending call to resolve".
    const c = twoStageDeferredClient();
    const s = scan(c as never);
    const first = s.run();
    const second = s.run();
    expect(c.calls, 'the rerun must not start until the first scan ends').toHaveLength(1);

    c.resolveNext({
      stdout: fixture('reconcile-empty.txt'),
      stderr: Buffer.from(''),
      exitCode: 0,
      timedOut: false,
      terminatedBy: undefined,
    });
    // Let the microtask queue drain so the rerun is actually dispatched
    // (doRun's own `await this.client.run(args)` reached) before resolving it.
    await new Promise((r) => setTimeout(r, 0));
    c.resolveNext({
      stdout: fixture('reconcile-cwd-is-root.txt'),
      stderr: Buffer.from(''),
      exitCode: 0,
      timedOut: false,
      terminatedBy: undefined,
    });
    await Promise.all([first, second]);

    expect(c.calls).toHaveLength(2);
    // second's caller sees the FRESH (rerun) result, not the first scan's.
    expect(s.result.verdictFor('C:/work/Personnel/Personnel.Data')).toBe('notInSourceControl');
  });

  it('however many calls arrive while a scan is in flight, exactly one rerun follows', async () => {
    const c = twoStageDeferredClient();
    const s = scan(c as never);
    const first = s.run();
    const second = s.run();
    const third = s.run();
    expect(c.calls).toHaveLength(1);

    c.resolveNext({
      stdout: fixture('reconcile-empty.txt'),
      stderr: Buffer.from(''),
      exitCode: 0,
      timedOut: false,
      terminatedBy: undefined,
    });
    // Let the microtask queue drain so the rerun is actually dispatched
    // before we try to resolve it.
    await new Promise((r) => setTimeout(r, 0));
    expect(c.calls, 'three requests produced more than one rerun').toHaveLength(2);

    c.resolveNext({
      stdout: fixture('reconcile-empty.txt'),
      stderr: Buffer.from(''),
      exitCode: 0,
      timedOut: false,
      terminatedBy: undefined,
    });
    await Promise.all([first, second, third]);

    expect(c.calls, 'a THIRD tf call happened').toHaveLength(2);
  });

  it('the rerun re-reads the ignorer, so a live teamExplorer.ignore/`.tfignore` change mid-scan takes effect', async () => {
    const c = twoStageDeferredClient();
    let call = 0;
    const patternsPerCall = [['node_modules'], ['node_modules', 'freshpattern']];
    const s = new UnversionedScan(
      c as never,
      'C:/work/Personnel',
      'win32',
      () => new IgnoreMatcher(patternsPerCall[Math.min(call++, patternsPerCall.length - 1)]),
      { appendLine: (l: string) => logged.push(l) } as never,
      (p) => p,
      () => true,
    );
    const first = s.run();
    const second = s.run();

    c.resolveNext({
      stdout: fixture('reconcile-empty.txt'),
      stderr: Buffer.from(''),
      exitCode: 0,
      timedOut: false,
      terminatedBy: undefined,
    });
    // Let the microtask queue drain so the rerun is actually dispatched
    // (doRun's own `await this.client.run(args)` reached) before resolving it.
    await new Promise((r) => setTimeout(r, 0));
    c.resolveNext({
      stdout: fixture('reconcile-empty.txt'),
      stderr: Buffer.from(''),
      exitCode: 0,
      timedOut: false,
      terminatedBy: undefined,
    });
    await Promise.all([first, second]);

    const excludeOf = (i: number) => c.calls[i].find((a) => a.startsWith('/exclude:'));
    expect(excludeOf(0)).not.toContain('freshpattern');
    expect(excludeOf(1)).toContain('freshpattern');
  });

  it('a request queued for a rerun still settles if dispose() cuts the rerun short', async () => {
    const c = deferredClient();
    const s = scan(c as never);
    const first = s.run();
    const second = s.run(); // queued for a rerun that will never be dispatched
    s.dispose();
    c.resolveRun({
      stdout: fixture('reconcile-empty.txt'),
      stderr: Buffer.from(''),
      exitCode: 0,
      timedOut: false,
      terminatedBy: undefined,
    });

    // Resolving is the assertion: a hang here (an unsettled `second`) is the
    // bug this test exists to catch.
    await Promise.all([first, second]);
    expect(c.calls, 'the rerun must not run once disposed').toHaveLength(1);
  });

  it('a queued call does NOT settle when the scan already running lands -- only once its own rerun does', async () => {
    // Kills a mutant that resolves `rerunWaiters` as soon as they are
    // snapshotted (or right after round 1), instead of after the round they
    // were snapshotted FOR actually lands.
    const c = twoStageDeferredClient();
    const s = scan(c as never);
    const first = s.run();
    const second = s.run(); // queued behind round 1, waiting for round 2
    let secondSettled = false;
    void second.then(() => {
      secondSettled = true;
    });

    c.resolveNext(landed(fixture('reconcile-empty.txt'))); // round 1 lands
    // A macrotask, not a bare microtask: it runs only once every pending
    // microtask has drained, which is what lets round 1's own continuation
    // (dispatching round 2) run to completion before this checks anything.
    await new Promise((r) => setTimeout(r, 0));
    expect(c.calls, 'round 2 (the rerun) was never dispatched').toHaveLength(2);
    expect(secondSettled, 'the queued call settled before its own rerun landed').toBe(false);

    c.resolveNext(landed(fixture('reconcile-cwd-is-root.txt'))); // round 2 lands
    await second;
    expect(secondSettled).toBe(true);
    await first;
  });

  it('a run() call made DURING the rerun gets its own third round, not silently dropped', async () => {
    // Kills a `while` -> `if` mutant on runLoop's loop: without the `while`,
    // only ONE extra round ever runs, however many further requests arrive
    // while THAT round is in flight -- exactly the lost-request bug this
    // whole task exists to fix, just one level deeper.
    const c = twoStageDeferredClient();
    const s = scan(c as never);
    const first = s.run();
    const second = s.run(); // queued for round 2

    c.resolveNext(landed(fixture('reconcile-empty.txt'))); // round 1 lands
    await new Promise((r) => setTimeout(r, 0));
    expect(c.calls).toHaveLength(2);

    const third = s.run(); // arrives WHILE round 2 is still in flight
    expect(c.calls, 'a third call must not start before round 2 ends').toHaveLength(2);

    c.resolveNext(landed(fixture('reconcile-empty.txt'))); // round 2 lands
    await new Promise((r) => setTimeout(r, 0));
    expect(c.calls, 'the request made during round 2 was dropped, not given round 3').toHaveLength(
      3,
    );

    c.resolveNext(landed(fixture('reconcile-cwd-is-root.txt'))); // round 3 lands
    await Promise.all([first, second, third]);
    expect(c.calls).toHaveLength(3);
    expect(s.result.verdictFor('C:/work/Personnel/Personnel.Data')).toBe('notInSourceControl');
  });

  it('dispose() during the rerun settles every waiting promise and starts nothing further', async () => {
    const c = twoStageDeferredClient();
    const s = scan(c as never);
    const first = s.run();
    const second = s.run(); // queued for round 2

    c.resolveNext(landed(fixture('reconcile-empty.txt'))); // round 1 lands
    await new Promise((r) => setTimeout(r, 0));
    expect(c.calls).toHaveLength(2); // round 2 dispatched

    const third = s.run(); // queued while round 2 is genuinely in flight
    s.dispose();

    c.resolveNext(landed(fixture('reconcile-empty.txt'))); // round 2 lands, but disposed
    // Settling is the assertion for `second` and `third`: a hang here (either
    // promise left pending) is the bug.
    await Promise.all([first, second, third]);
    await new Promise((r) => setTimeout(r, 0));

    expect(c.calls, 'a further round started after dispose()').toHaveLength(2);
    // Round 1 (the empty-fixture success) is still what `this.current` holds:
    // dispose() only stops a FUTURE build from landing, it does not erase an
    // answer that had already landed before it was called.
    expect(s.result.verdictFor('C:/work/Personnel/anything.vb')).toBe('inSourceControl');
  });

  it("inFlight stays set across rounds: an arrival noted DURING the rerun is buffered and replayed onto the rerun's own result", async () => {
    // Kills a mutant that clears `this.inFlight` between rounds (inside the
    // loop) instead of only once, in the outer `finally`, after every round
    // has finished: `noteArrival`/`noteDeparture` gate their buffering on
    // `this.inFlight`, so clearing it early would drop an arrival noted while
    // the SECOND (or later) round is running, not just the first.
    const c = twoStageDeferredClient();
    const s = scan(c as never);
    const first = s.run();
    const second = s.run(); // schedules round 2

    c.resolveNext(landed(fixture('reconcile-empty.txt'))); // round 1 lands
    await new Promise((r) => setTimeout(r, 0));
    expect(c.calls).toHaveLength(2); // round 2 (the rerun) is now in flight

    // Noted DURING round 2, not round 1.
    s.noteArrival('C:/work/Personnel/mid-rerun.txt');
    expect(c.calls, 'the arrival above triggered an unexpected extra call').toHaveLength(2);

    c.resolveNext(landed(fixture('reconcile-cwd-is-root.txt'))); // round 2 lands
    await Promise.all([first, second]);

    expect(s.result.verdictFor('C:/work/Personnel/mid-rerun.txt')).toBe('notScanned');
  });

  it('a round that rejects still settles every promise queued behind it, instead of leaving them hanging (hardening)', async () => {
    // `doRun` is designed never to reject -- it catches everything internally,
    // including a throw from `client.run` itself. This simulates a defect
    // that escapes that anyway, to prove `runLoop` itself does not compound
    // it into a second bug: a caller waiting on a round that failed must
    // still be told, not left pending forever.
    const s = scan(client(fixture('reconcile-empty.txt')));
    let call = 0;
    const doRunSpy = vi
      .spyOn(s as unknown as { doRun: () => Promise<void> }, 'doRun')
      .mockImplementation(() => (call++ === 0 ? Promise.resolve() : Promise.reject(new Error('boom'))));
    try {
      const first = s.run();
      const second = s.run(); // queued for the (rejecting) rerun

      await expect(first).rejects.toThrow('boom');
      await expect(second).resolves.toBeUndefined();
    } finally {
      doRunSpy.mockRestore();
    }
  });
});

describe('dispose', () => {
  it('disposes its own change emitter', () => {
    // `ownEmitter` names exactly the emitter the constructor builds for
    // `this.changed` -- captured by array position immediately before
    // construction, the same idiom `decorationProvider.test.ts` uses --
    // rather than "the last one in `createdEmitters`", which would silently
    // point at the wrong object the day anything else in the constructor
    // builds an emitter too.
    const beforeEmitters = createdEmitters.length;
    const s = scan(client(fixture('reconcile-empty.txt')));
    const ownEmitter = createdEmitters[beforeEmitters];
    expect(ownEmitter.disposed).toBe(false);
    s.dispose();
    expect(ownEmitter.disposed).toBe(true);
  });

  it('marks itself disposed, so a later run() never calls tf', async () => {
    const c = client(fixture('reconcile-empty.txt'));
    const s = scan(c);
    s.dispose();
    await s.run();
    expect(c.calls).toHaveLength(0);
  });

  it('drops a result that lands after dispose() was called mid-flight', async () => {
    const c = deferredClient();
    const s = scan(c as never);
    const seen: unknown[] = [];
    s.onDidChange(() => seen.push(1));

    const running = s.run();
    s.dispose();
    c.resolveRun({
      stdout: fixture('reconcile-cwd-is-root.txt'),
      stderr: Buffer.from(''),
      exitCode: 0,
      timedOut: false,
      terminatedBy: undefined,
    });
    await running;

    // Had the post-await disposed check been removed, this would have
    // become 'notInSourceControl' and the change event would have fired.
    expect(s.result.verdictFor('C:/work/Personnel/Personnel.Data')).toBe('notScanned');
    expect(seen).toHaveLength(0);
  });
});

describe('the result it builds knows when the scan started', () => {
  it('answers notScanned for an unlisted file created after the scan began', async () => {
    const before = Date.now();
    const s = scan(client(fixture('reconcile-cwd-is-root.txt')));
    await s.run();
    expect(s.result.verdictFor('C:/work/Personnel/Program.vb', Date.now() + 1000)).toBe('notScanned');
    expect(s.result.verdictFor('C:/work/Personnel/Program.vb', before - 1000)).toBe('inSourceControl');
  });
});

describe('output the scan does not fully understand (exit 0)', () => {
  it('keeps the previous result when parseReconcile reports a problem, and does not fire', async () => {
    // Exit 0 with a line tf never printed before -- a localized tf, or a
    // future message -- must not be read as "found nothing", which is what an
    // empty parse would otherwise mean. Pins the exact log wording; the
    // it.each below covers the same "keeps the previous result" behaviour for
    // every OTHER problem kind without repeating this exact-string assertion.
    const c = fakeClient(
      ok(fixture('reconcile-cwd-is-root.txt')),
      ok(Buffer.from('Warning: something tf never printed before\r\n', 'utf8')),
    );
    const s = scan(c);
    await s.run();
    const before = s.result.verdictFor('C:/work/Personnel/Personnel.Data');
    expect(before).toBe('notInSourceControl');

    const seen: unknown[] = [];
    s.onDidChange(() => seen.push(1));
    await s.run();

    expect(s.result.verdictFor('C:/work/Personnel/Personnel.Data')).toBe(before);
    expect(seen).toHaveLength(0);
    expect(logged.join('\n')).toContain(
      'scan for new files: output not understood, keeping the previous result: ' +
        'unrecognised line: Warning: something tf never printed before',
    );
  });

  // One exit-0 stdout per problem kind parseReconcile recognises. Each must
  // keep the scan's previous result and fire nothing -- proven by pinning
  // `before` to a real verdict FIRST, so a mutant that keeps the previous
  // result unconditionally (even on a good scan) cannot pass vacuously.
  const problemStdouts: Array<[string, string]> = [
    ['an unrecognised line', 'Warning: something tf never printed before\r\n'],
    ['an absolute header with a drive letter', 'C:\\work:\r\nPending add: one\r\n'],
    ['an absolute header with a leading forward slash', '/etc/foo:\r\nPending add: one\r\n'],
    ['an absolute header with a leading backslash (UNC-shaped)', '\\\\server\\share:\r\nPending add: one\r\n'],
    ['a header with a .. component', 'Foo\\..\\Bar:\r\nPending add: one\r\n'],
    ['an item name containing a colon', 'Pending add: weird:name.txt\r\n'],
    // Backslash-separated, not '/' -- kills a mutant that splits only on '/'
    // when looking for a '..' component.
    ['an item name with a backslash-separated .. component', 'Pending add: a\\..\\b\r\n'],
  ];

  it.each(problemStdouts)('keeps the previous result for %s', async (_label, badStdout) => {
    const c = fakeClient(
      ok(fixture('reconcile-cwd-is-root.txt')),
      ok(Buffer.from(badStdout, 'utf8')),
    );
    const s = scan(c);
    await s.run();
    const before = s.result.verdictFor('C:/work/Personnel/Personnel.Data');
    expect(before).toBe('notInSourceControl');

    const seen: unknown[] = [];
    s.onDidChange(() => seen.push(1));
    await s.run();

    expect(s.result.verdictFor('C:/work/Personnel/Personnel.Data')).toBe(before);
    expect(seen).toHaveLength(0);
    expect(logged.some((l) => l.includes('output not understood'))).toBe(true);
  });

  it('"No matching changes found to pend." is a clean empty success, not a problem', async () => {
    const s = scan(client(fixture('reconcile-empty.txt')));
    const seen: unknown[] = [];
    s.onDidChange(() => seen.push(1));
    await s.run();

    expect(s.result.unversionedPaths()).toEqual([]);
    expect(seen).toHaveLength(1);
    expect(logged.some((l) => l.includes('output not understood'))).toBe(false);
  });

  it('a header naming a directory that does not exist keeps the previous result and logs the header', async () => {
    // Catches exactly the shape parseReconcile.test.ts's "a foreign line
    // ending in a colon is still read as a header, not flagged a problem"
    // test pins: a diagnostic line ending in ':' is read as a header and
    // would otherwise silently re-root everything after it.
    const c = fakeClient(
      ok(fixture('reconcile-cwd-is-root.txt')),
      ok(Buffer.from('Bogus:\r\nPending add: file.txt\r\n', 'utf8')),
    );
    const s = scan(c, DEFAULT_IGNORE, { folderExists: (p) => !p.endsWith('Bogus') });
    await s.run();
    const before = s.result.verdictFor('C:/work/Personnel/Personnel.Data');
    expect(before).toBe('notInSourceControl');

    const seen: unknown[] = [];
    s.onDidChange(() => seen.push(1));
    await s.run();

    expect(s.result.verdictFor('C:/work/Personnel/Personnel.Data')).toBe(before);
    expect(seen).toHaveLength(0);
    expect(logged.some((l) => l.includes('Bogus'))).toBe(true);
  });

  it('records the exact absolute path it asks folderExists about, joined with the platform separator (win32)', async () => {
    const seenPaths: string[] = [];
    const s = scan(client(fixture('reconcile-cwd-is-root.txt')), DEFAULT_IGNORE, {
      root: 'C:\\work\\Personnel',
      folderExists: (p) => {
        seenPaths.push(p);
        return true;
      },
    });
    await s.run();
    // reconcile-cwd-is-root.txt's headers are Customers, Customers\Customers2020
    // and Nexus -- joined with '\', not concatenated raw and not left as '/'.
    expect(seenPaths).toContain('C:\\work\\Personnel\\Customers');
    expect(seenPaths).toContain('C:\\work\\Personnel\\Customers\\Customers2020');
    expect(seenPaths).toContain('C:\\work\\Personnel\\Nexus');
  });

  it('records the exact absolute path it asks folderExists about, joined with the platform separator (linux)', async () => {
    const seenPaths: string[] = [];
    const c = client(Buffer.from('Shop2023\\Forms:\r\nPending add: File.vb\r\n', 'utf8'));
    const s = scan(c, DEFAULT_IGNORE, {
      platform: 'linux',
      root: '/home/shax/work/Shop',
      toTfPath: (p) => p,
      folderExists: (p) => {
        seenPaths.push(p);
        return true;
      },
    });
    await s.run();
    // tf emits '\' even under Wine; parseReconcile normalises it to '/', and
    // the join below must use the PLATFORM's own separator, not tf's.
    expect(seenPaths).toEqual(['/home/shax/work/Shop/Shop2023/Forms']);
  });

  describe('against the REAL default folderExists (no fake, actual statSync)', () => {
    it('succeeds when every header names a real directory under the root', async () => {
      await withTempDir(async (dir) => {
        mkdirSync(join(dir, 'Customers', 'Customers2020'), { recursive: true });
        mkdirSync(join(dir, 'Nexus'), { recursive: true });
        const s = new UnversionedScan(
          client(fixture('reconcile-cwd-is-root.txt')) as never,
          dir,
          NATIVE,
          () => new IgnoreMatcher(DEFAULT_IGNORE),
          { appendLine: (l: string) => logged.push(l) } as never,
          (p) => p,
          // No folderExists -- exercises the real default.
        );
        await s.run();
        expect(s.result.verdictFor(join(dir, 'Personnel.Data'))).toBe('notInSourceControl');
      });
    });

    it('fails and keeps the previous result when a header names a folder that does not exist', async () => {
      await withTempDir(async (dir) => {
        // Neither 'Customers' nor 'Nexus' exists under dir.
        const c = fakeClient(ok(fixture('reconcile-empty.txt')), ok(fixture('reconcile-cwd-is-root.txt')));
        const s = new UnversionedScan(
          c as never,
          dir,
          NATIVE,
          () => new IgnoreMatcher(DEFAULT_IGNORE),
          { appendLine: (l: string) => logged.push(l) } as never,
          (p) => p,
        );
        await s.run(); // baseline: an empty success, real folderExists never asked (no headers)
        const before = s.result.verdictFor(join(dir, 'anything.vb'));
        expect(before).toBe('inSourceControl');

        await s.run(); // 'Customers' does not exist under dir
        expect(s.result.verdictFor(join(dir, 'anything.vb'))).toBe(before);
        expect(logged.some((l) => l.includes('header not found'))).toBe(true);
      });
    });

    it('fails when a header names a plain file, not a directory', async () => {
      await withTempDir(async (dir) => {
        writeFileSync(join(dir, 'Customers'), 'not a directory');
        const c = fakeClient(ok(fixture('reconcile-empty.txt')), ok(fixture('reconcile-cwd-is-root.txt')));
        const s = new UnversionedScan(
          c as never,
          dir,
          NATIVE,
          () => new IgnoreMatcher(DEFAULT_IGNORE),
          { appendLine: (l: string) => logged.push(l) } as never,
          (p) => p,
        );
        await s.run();
        const before = s.result.verdictFor(join(dir, 'anything.vb'));
        expect(before).toBe('inSourceControl');

        await s.run();
        expect(s.result.verdictFor(join(dir, 'anything.vb'))).toBe(before);
        expect(logged.some((l) => l.includes('header not found'))).toBe(true);
      });
    });
  });
});

describe('the failure log stays scrubbed even when the message comes from parseReconcile, not tf', () => {
  it('never lets a secret in an unrecognised line reach the output channel', async () => {
    const c = fakeClient(
      ok(fixture('reconcile-cwd-is-root.txt')),
      ok(Buffer.from('warning /login:.,SECRET here\r\n', 'utf8')),
    );
    const s = scan(c);
    await s.run();
    await s.run();
    expect(logged.join('\n')).not.toContain('SECRET');
    expect(logged.some((l) => l.includes('output not understood'))).toBe(true);
  });

  it('never lets a secret in a would-be header reach the output channel', async () => {
    const c = fakeClient(
      ok(fixture('reconcile-cwd-is-root.txt')),
      ok(Buffer.from('TFSPAT=SECRET3 x:\r\nPending add: file.txt\r\n', 'utf8')),
    );
    // True for the first (real) scan's headers, false only for the
    // secret-bearing one -- so the FIRST run succeeds and leaves a previous
    // result, and only the second run hits the missing-header failure.
    const s = scan(c, DEFAULT_IGNORE, { folderExists: (p) => !p.includes('TFSPAT') });
    await s.run();
    await s.run();
    expect(logged.join('\n')).not.toContain('SECRET');
    expect(logged.some((l) => l.includes('header not found'))).toBe(true);
  });

  it('caps a long unrecognised line before it reaches the output channel', async () => {
    // Words, not one long run: scrubSecrets treats a long bare token as a secret.
    const long = Array.from({ length: 120 }, (_, i) => `word${i}`).join(' ');
    expect(long.length).toBeGreaterThan(600);
    const c = fakeClient(ok(fixture('reconcile-cwd-is-root.txt')), ok(Buffer.from(`${long}\r\n`, 'utf8')));
    const s = scan(c);
    await s.run();
    await s.run();
    const line = logged.find((l) => l.includes('output not understood'));
    expect(line).toBeDefined();
    expect(line).not.toContain('word119');
    expect(line).toContain('...');
  });
});

describe('a non-zero exit logs at most 5 lines / 500 characters of the scrubbed message', () => {
  it('cuts after 5 lines and appends ...', async () => {
    const lines = Array.from({ length: 8 }, (_, i) => `line ${i}`);
    const c = fakeClient(
      ok(fixture('reconcile-cwd-is-root.txt')),
      { stdout: Buffer.from(''), stderr: Buffer.from(lines.join('\n'), 'utf8'), exitCode: 1 },
    );
    const s = scan(c);
    await s.run();
    await s.run();
    const log = logged.join('\n');
    expect(log).toContain(lines.slice(0, 5).join('\n'));
    expect(log).not.toContain('line 5');
    expect(log.trimEnd().endsWith('...')).toBe(true);
  });

  it('cuts at 500 characters even within the first 5 lines', async () => {
    // Broken into 10-character blocks (9 word characters + a hyphen) so no
    // run is 40+ characters -- scrubSecrets' bare-token rule would otherwise
    // fold one long alphanumeric run into `***` and this test would not be
    // measuring the cap at all.
    const longLine = 'abcdefghi-'.repeat(60); // 600 characters, no whitespace
    const c = fakeClient(
      ok(fixture('reconcile-cwd-is-root.txt')),
      { stdout: Buffer.from(''), stderr: Buffer.from(longLine, 'utf8'), exitCode: 1 },
    );
    const s = scan(c);
    await s.run();
    await s.run();
    const log = logged.join('\n');
    expect(log).toContain(`${longLine.slice(0, 500)}...`);
    expect(log).not.toContain(longLine.slice(0, 501));
  });

  it('does not append ... when the message needs no cut', async () => {
    const c = fakeClient(
      ok(fixture('reconcile-cwd-is-root.txt')),
      { stdout: Buffer.from(''), stderr: Buffer.from('short message', 'utf8'), exitCode: 1 },
    );
    const s = scan(c);
    await s.run();
    await s.run();
    const log = logged.join('\n');
    expect(log).toContain('short message');
    expect(log).not.toContain('short message...');
  });

  it('does not cut at exactly 5 lines', async () => {
    // Kills a `>` -> `>=` mutant on the line-count check: 5 lines is within
    // the limit, not over it.
    const lines = Array.from({ length: 5 }, (_, i) => `line ${i}`);
    const c = fakeClient(
      ok(fixture('reconcile-cwd-is-root.txt')),
      { stdout: Buffer.from(''), stderr: Buffer.from(lines.join('\n'), 'utf8'), exitCode: 1 },
    );
    const s = scan(c);
    await s.run();
    await s.run();
    const log = logged.join('\n');
    expect(log).toContain(lines.join('\n'));
    expect(log.trimEnd().endsWith('...')).toBe(false);
  });

  it('does not cut at exactly 500 characters', async () => {
    // Kills a `>` -> `>=` mutant on the character-count check: 500 characters
    // is within the limit, not over it. Same word-boundary trick as the
    // "cuts at 500 characters" test above, to avoid scrubSecrets' bare-token
    // rule folding this into `***`.
    const exactly500 = 'abcdefghi-'.repeat(50); // 500 characters, no whitespace
    const c = fakeClient(
      ok(fixture('reconcile-cwd-is-root.txt')),
      { stdout: Buffer.from(''), stderr: Buffer.from(exactly500, 'utf8'), exitCode: 1 },
    );
    const s = scan(c);
    await s.run();
    await s.run();
    const log = logged.join('\n');
    expect(log).toContain(exactly500);
    expect(log.trimEnd().endsWith('...')).toBe(false);
  });

  it('leaves the too-many-items special log line untouched', async () => {
    // Task 2's branch returns before the generic failure log is built at all;
    // this pins that the cap added here does not touch it.
    const stderr = Buffer.from(
      `${TOO_MANY_ITEMS_PREFIX}: 500 items need 9000 characters, and the limit is 8000.\n` +
        'Nothing was run, and nothing was changed on the server.\n' +
        'Do this in smaller batches — exclude some changes, act on the rest, then repeat. ' +
        'tf cannot take the item list from a file.',
      'utf8',
    );
    const c = fakeClient({ stdout: Buffer.from(''), stderr, exitCode: -1 });
    const s = scan(c as never);
    await s.run();
    const log = logged.join('\n');
    expect(log).toMatch(/exclusion list is too long for one tf command \(\d+ patterns\)/);
  });
});

describe('the exit-code guard is not special-cased to 100', () => {
  it('treats exit -1 (a TfClient refusal shape: empty stdout, reason in stderr) as a failure', async () => {
    const c = fakeClient(
      ok(fixture('reconcile-cwd-is-root.txt')),
      {
        stdout: Buffer.from(''),
        stderr: Buffer.from(
          '[tfvc] Cannot safely pass "!", "%", "^" or a newline/CR to tf through this wrapper.',
          'utf8',
        ),
        exitCode: -1,
      },
    );
    const s = scan(c);
    await s.run();
    const before = s.result.verdictFor('C:/work/Personnel/Personnel.Data');
    expect(before).toBe('notInSourceControl');

    await s.run();

    expect(s.result.verdictFor('C:/work/Personnel/Personnel.Data')).toBe(before);
    expect(logged.join('\n')).toContain('failed (exit -1)');
  });

  it('treats exit 1 as a failure and keeps the previous result', async () => {
    const c = fakeClient(ok(fixture('reconcile-cwd-is-root.txt')), ok(Buffer.from(''), 1));
    const s = scan(c);
    await s.run();
    const before = s.result.verdictFor('C:/work/Personnel/Personnel.Data');
    expect(before).toBe('notInSourceControl');

    await s.run();

    expect(s.result.verdictFor('C:/work/Personnel/Personnel.Data')).toBe(before);
    expect(logged.join('\n')).toContain('failed (exit 1)');
  });
});

describe('the failure log stays scrubbed', () => {
  it('never lets a secret in stderr reach the output channel', async () => {
    const c = fakeClient(
      ok(fixture('reconcile-cwd-is-root.txt')),
      {
        stdout: Buffer.from(''),
        stderr: Buffer.from('some tf message /login:.,SECRET more text', 'utf8'),
        exitCode: 1,
      },
    );
    const s = scan(c);
    await s.run();
    await s.run();
    expect(logged.join('\n')).not.toContain('SECRET');
  });
});

describe('the watcher: arrivals and departures reported live (noteArrival / noteDeparture)', () => {
  it('an arrival during an in-flight scan is honoured by the result that lands', async () => {
    // U2/C2 + M-shape: a fresh ScanResult knows only parsed.items, so without
    // replaying what arrived mid-flight the path would wear the hazard again
    // the instant this scan's own result landed.
    const c = deferredClient();
    const s = scan(c as never);
    const running = s.run();
    s.noteArrival('C:/work/Personnel/notes-renamed.txt');
    c.resolveRun({
      stdout: fixture('reconcile-empty.txt'),
      stderr: Buffer.from(''),
      exitCode: 0,
      timedOut: false,
      terminatedBy: undefined,
    });
    await running;
    expect(s.result.verdictFor('C:/work/Personnel/notes-renamed.txt')).toBe('notScanned');
  });

  it("takes 'started' before spawning tf, not after it resolves", async () => {
    // Kills a mutant that moves `started = Date.now()` to after `await
    // this.client.run(args)`: a file appearing strictly between calling
    // run() and tf's own resolution must still read notScanned.
    //
    // A controlled clock, not two bare `Date.now()` calls: both landed in the
    // same real-clock millisecond often enough (11/20, then 2/5, real runs)
    // that the mutant survived by accident -- `started` and `createdAtMs`
    // ended up equal either way, and `>=` treats that as notScanned under
    // BOTH the correct code and the mutant. Faking only `Date` (not the
    // timers `setTimeout`/`Promise` scheduling relies on) keeps `run()`'s own
    // async machinery working normally while making the three points in time
    // -- `run()` called, tf resolves, the file's `createdAtMs` -- exact and
    // reproducible.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const START = 1_000_000;
      vi.setSystemTime(START);
      const c = deferredClient();
      const s = scan(c as never);
      const running = s.run(); // `started` is captured here, at START
      const createdAtMs = START + 5; // strictly between START and tf's resolution
      vi.setSystemTime(START + 10); // the clock has moved on by the time tf answers
      c.resolveRun({
        stdout: fixture('reconcile-empty.txt'),
        stderr: Buffer.from(''),
        exitCode: 0,
        timedOut: false,
        terminatedBy: undefined,
      });
      await running;
      expect(s.result.verdictFor('C:/work/Personnel/mid-flight.txt', createdAtMs)).toBe(
        'notScanned',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('noteDeparture removes a group row and a later noteArrival restores it', async () => {
    const s = scan(client(fixture('reconcile-cwd-is-root.txt')));
    await s.run();
    expect(s.result.unversionedPaths()).toContain('C:\\work\\Personnel\\Personnel.Data');

    s.noteDeparture('C:/work/Personnel/Personnel.Data');
    expect(s.result.unversionedPaths()).not.toContain('C:\\work\\Personnel\\Personnel.Data');

    s.noteArrival('C:/work/Personnel/Personnel.Data');
    expect(s.result.unversionedPaths()).toContain('C:\\work\\Personnel\\Personnel.Data');
  });

  it('a departure during an in-flight scan is buffered and replayed onto the landing result', async () => {
    const c = deferredClient();
    const s = scan(c as never);
    const running = s.run();
    s.noteDeparture('C:/work/Personnel/Personnel.Data');
    c.resolveRun({
      stdout: fixture('reconcile-cwd-is-root.txt'),
      stderr: Buffer.from(''),
      exitCode: 0,
      timedOut: false,
      terminatedBy: undefined,
    });
    await running;
    // reconcile-cwd-is-root.txt lists Personnel.Data as a Pending add -- it
    // would show up in the group unless the mid-flight departure survived.
    expect(s.result.unversionedPaths()).not.toContain('C:\\work\\Personnel\\Personnel.Data');
  });

  it('replay preserves event ORDER: a delete then a create of the same path leaves the row present', async () => {
    const c = deferredClient();
    const s = scan(c as never);
    const running = s.run();
    s.noteDeparture('C:/work/Personnel/Personnel.Data');
    s.noteArrival('C:/work/Personnel/Personnel.Data');
    c.resolveRun({
      stdout: fixture('reconcile-cwd-is-root.txt'),
      stderr: Buffer.from(''),
      exitCode: 0,
      timedOut: false,
      terminatedBy: undefined,
    });
    await running;
    expect(s.result.unversionedPaths()).toContain('C:\\work\\Personnel\\Personnel.Data');
  });

  it('replay preserves event ORDER: a create then a delete of the same path leaves the row absent', async () => {
    const c = deferredClient();
    const s = scan(c as never);
    const running = s.run();
    s.noteArrival('C:/work/Personnel/Personnel.Data');
    s.noteDeparture('C:/work/Personnel/Personnel.Data');
    c.resolveRun({
      stdout: fixture('reconcile-cwd-is-root.txt'),
      stderr: Buffer.from(''),
      exitCode: 0,
      timedOut: false,
      terminatedBy: undefined,
    });
    await running;
    expect(s.result.unversionedPaths()).not.toContain('C:\\work\\Personnel\\Personnel.Data');
  });

  it('does not buffer an event while no scan is running, so it is not wrongly replayed onto the NEXT scan', async () => {
    const s = scan(client(fixture('reconcile-empty.txt')));
    // Noted before run() is ever called: this.inFlight is undefined, so a
    // correct implementation never queues this for replay. It is still
    // applied directly to `this.current` (the notRun() sentinel here, so a
    // no-op) -- see noteArrival's own doc comment.
    s.noteArrival('C:/work/Personnel/pre-existing.txt');
    await s.run();
    // If the arrival had been buffered despite no scan running, doRun would
    // replay it onto this landing result and this would wrongly say
    // notScanned instead of the fresh scan's own (correct) answer.
    expect(s.result.verdictFor('C:/work/Personnel/pre-existing.txt')).toBe('inSourceControl');
  });
});

describe('the debounced onDidChange after an arrival or a departure', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * A scan with a real, LANDED result covering `C:/work/Personnel` -- not
   * `ScanResult.notRun()`'s sentinel root, which nothing is ever "under", so
   * every arrival/departure against it would be a no-op and these tests would
   * pass vacuously regardless of whether scheduling actually happened.
   */
  async function landedScan() {
    const s = scan(client(fixture('reconcile-empty.txt')));
    await s.run();
    return s;
  }

  it('fires once for many arrivals, 200 ms after the last one -- not once per event', async () => {
    const s = await landedScan();
    const seen: unknown[] = [];
    s.onDidChange(() => seen.push(1));

    s.noteArrival('C:/work/Personnel/a.txt');
    vi.advanceTimersByTime(100);
    s.noteArrival('C:/work/Personnel/b.txt');
    vi.advanceTimersByTime(100);
    s.noteArrival('C:/work/Personnel/c.txt');
    expect(seen, 'fired before the trailing window elapsed').toHaveLength(0);

    vi.advanceTimersByTime(200);
    expect(seen).toHaveLength(1);
  });

  it('a departure debounces the same way as an arrival', async () => {
    const s = await landedScan();
    const seen: unknown[] = [];
    s.onDidChange(() => seen.push(1));

    s.noteDeparture('C:/work/Personnel/a.txt');
    vi.advanceTimersByTime(199);
    expect(seen).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(seen).toHaveLength(1);
  });

  it('dispose() cancels a pending debounce', async () => {
    const s = await landedScan();
    const seen: unknown[] = [];
    s.onDidChange(() => seen.push(1));

    s.noteArrival('C:/work/Personnel/a.txt');
    s.dispose();
    vi.advanceTimersByTime(1000);
    expect(seen).toHaveLength(0);
  });

  it('scheduleChange does nothing after dispose: noting an arrival post-dispose schedules no timer', async () => {
    const s = await landedScan();
    const seen: unknown[] = [];
    s.onDidChange(() => seen.push(1));

    s.dispose();
    s.noteArrival('C:/work/Personnel/a.txt');
    vi.advanceTimersByTime(1000);
    expect(seen).toHaveLength(0);
  });

  it('a landing scan cancels a pending debounce, so onDidChange fires exactly once per landing', async () => {
    const c = twoStageDeferredClient();
    const s = scan(c as never);
    const seen: unknown[] = [];
    s.onDidChange(() => seen.push(1));

    // First scan lands, so `this.current` covers C:/work/Personnel -- needed
    // for the arrival below to actually schedule something real.
    const first = s.run();
    c.resolveNext({
      stdout: fixture('reconcile-empty.txt'),
      stderr: Buffer.from(''),
      exitCode: 0,
      timedOut: false,
      terminatedBy: undefined,
    });
    await first;
    expect(seen).toHaveLength(1);

    // Arms a real 200 ms debounce (no scan running, applied directly to the
    // now-covering `this.current`), then a SECOND scan starts and lands
    // before that debounce would otherwise fire.
    s.noteArrival('C:/work/Personnel/a.txt');
    const second = s.run();
    c.resolveNext({
      stdout: fixture('reconcile-empty.txt'),
      stderr: Buffer.from(''),
      exitCode: 0,
      timedOut: false,
      terminatedBy: undefined,
    });
    await second;

    expect(seen, 'the second scan landing fired, on top of the first').toHaveLength(2);
    vi.advanceTimersByTime(1000);
    expect(seen, 'the debounce the arrival armed must not ALSO fire').toHaveLength(2);
  });

  it('an arrival under an EXCLUDED folder (bin/) schedules no change', async () => {
    const s = await landedScan();
    const seen: unknown[] = [];
    s.onDidChange(() => seen.push(1));

    // 'bin' is one of TF_BUILTIN_EXCLUSIONS, so this path was never going to
    // change what this result draws -- a build writing under bin/obj/.vs/.git
    // must not schedule a refresh per file.
    s.noteArrival('C:/work/Personnel/bin/App.dll');
    vi.advanceTimersByTime(1000);
    expect(seen).toHaveLength(0);
  });

  it('a COVERED arrival schedules a change', async () => {
    const s = await landedScan();
    const seen: unknown[] = [];
    s.onDidChange(() => seen.push(1));

    s.noteArrival('C:/work/Personnel/new.txt');
    vi.advanceTimersByTime(200);
    expect(seen).toHaveLength(1);
  });
});
