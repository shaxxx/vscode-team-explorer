import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TfvcService } from '../../src/TfvcService.js';
import { AutoCheckout, SAVE_PARTICIPANT_BUDGET_MS } from '../../src/commands/autoCheckout.js';
import { ReadOnlyWatcher } from '../../src/watch/ReadOnlyWatcher.js';
import { UnversionedScan } from '../../src/scan/UnversionedScan.js';
import { ScmProvider } from '../../src/ui/ScmProvider.js';
import { TfClient } from '../../src/tf/TfClient.js';
import { WorkspaceService } from '../../src/workspace/WorkspaceService.js';
import { S } from '../../src/tf/strings.js';
import { activate, reinitialise, newWorkspaceDirBase } from '../../src/extension.js';
import {
  recorder,
  outputChannel,
  Uri,
  hooks,
  workspace,
  window,
  commands,
  createdWatchers,
  decorationProviders,
  configValues,
  fireConfigChange,
  executed,
  panelSerializers,
  treeProviders,
} from '../vscode-mock.js';

/**
 * TfvcService, AutoCheckout and ReadOnlyWatcher had NO tests — the mock could
 * not even construct them. That is why a mapper left live on a failed
 * initialize, a missing try/catch on the keystroke path, and a status spawned
 * after dispose all survived every earlier review.
 */

/**
 * Platform-aware, because TfvcService picks its PathMapper platform from
 * `process.platform` and cannot be told otherwise.
 *
 * The first time this suite was ever run on Linux, six tests in this file
 * failed. They used the Windows fixture and a `C:\work\...` folder, so on
 * Linux the mapping never resolved, initialize() returned an error, and no
 * mapper, watcher or status was ever created - every assertion was made
 * against a service that had not started.
 */
const ON_WINDOWS = process.platform === 'win32';

const WORKSPACES_XML = readFileSync(
  join(
    __dirname,
    ON_WINDOWS ? '../fixtures/windows/workspaces.xml' : '../fixtures/fedora/workspaces.xml',
  ),
);

/** A folder that IS mapped by the fixture for this platform. */
const MAPPED = ON_WINDOWS ? 'C:\\work\\Vesta' : '/home/shax/work/Vesta';
/** A folder that is NOT, so initialize() must refuse it. */
const UNMAPPED = ON_WINDOWS ? 'D:\\somewhere\\else' : '/var/somewhere/else';

type Run = { args: string[] };

function fakeClient(opts: { runs: Run[]; statusXml?: Buffer; fail?: Error }) {
  return {
    timeoutMs: 1000,
    run: async (args: string[]) => {
      if (opts.fail) throw opts.fail;
      opts.runs.push({ args });
      const isWorkspaces = args.includes('workspaces');
      return {
        stdout: isWorkspaces ? WORKSPACES_XML : (opts.statusXml ?? Buffer.from('<Status />')),
        stderr: Buffer.alloc(0),
        exitCode: 0,
        timedOut: false,
      };
    },
  };
}

const folderAt = (fsPath: string) => ({ uri: Uri.file(fsPath) });

/** One canned `TfResult`, for `stubTfRun`'s per-verb dispatch below. */
function ok(stdout: Buffer | string) {
  return {
    stdout: typeof stdout === 'string' ? Buffer.from(stdout, 'utf8') : stdout,
    stderr: Buffer.alloc(0),
    exitCode: 0,
    timedOut: false,
  };
}

/**
 * Installs `vi.spyOn(TfClient.prototype, 'run')`, answering by VERB, so a
 * lifecycle test can drive `activate()` through a REAL successful
 * `initialize()` and a real scan without ever touching `tf`. `activate()`
 * builds its own `TfClient` internally -- there is no injection point -- so
 * spying on the prototype is the only way to control what it sees. The
 * caller MUST restore it (`mockRestore()`), same as every other prototype
 * spy in this file, since it is otherwise shared by every `TfClient` in this
 * process for as long as the spy lives.
 */
function stubTfRun(opts: {
  /** Defaults to WORKSPACES_XML (mapping `MAPPED`). */
  workspacesXml?: Buffer;
  /** Called once per `workspaces` call (1-based), for the retry-path test. */
  workspacesByCall?: (call: number) => ReturnType<typeof ok>;
  /** Defaults to `<Status />` (nothing pending). */
  statusXml?: Buffer;
  /** Defaults to a clean, empty success. */
  reconcileStdout?: string;
  /** Observes every `reconcile` call's full argument list. */
  onReconcile?: (args: string[]) => void;
  /**
   * Handed TfClient's own `log` option off the FIRST call's `this`, so a test
   * can invoke it directly -- e.g. to simulate a real `tf` process finishing
   * its own logging strictly AFTER the extension has torn everything down,
   * which nothing else in this file can otherwise reach.
   */
  captureLog?: (log: (line: string) => void) => void;
}) {
  let workspacesCalls = 0;
  let logCaptured = false;
  return vi.spyOn(TfClient.prototype, 'run').mockImplementation(async function (
    this: unknown,
    args: string[],
  ) {
    if (!logCaptured && opts.captureLog) {
      const log = (this as { options: { log?: (l: string) => void } }).options.log;
      if (log) {
        logCaptured = true;
        opts.captureLog(log);
      }
    }
    if (args.includes('workspaces')) {
      workspacesCalls++;
      if (opts.workspacesByCall) return opts.workspacesByCall(workspacesCalls);
      return ok(opts.workspacesXml ?? WORKSPACES_XML);
    }
    if (args.includes('status')) return ok(opts.statusXml ?? '<Status />');
    if (args.includes('reconcile')) {
      opts.onReconcile?.(args);
      return ok(opts.reconcileStdout ?? 'No matching changes found to pend.\r\n');
    }
    return ok(Buffer.alloc(0));
  });
}

beforeEach(() => {
  recorder.reset();
  outputChannel.clear();
  // Task 5: collectionUrl now defaults to '' (no more acme.visualstudio.com
  // fallback), and activate() refuses to start TFVC at all without one. Every
  // test in this file drives activate() (or TfvcService directly, which is
  // handed a collection URL as a constructor argument and is unaffected) to
  // reach real TFVC wiring, so all of them need one configured -- a single
  // shared default here rather than repeating the line at every call site.
  configValues['teamExplorer.collectionUrl'] = 'https://acme.visualstudio.com/';
});

describe('the vscode mock: getConfiguration().get(key, default)', () => {
  // The reviewer found a `lifecycle.test.ts` test whose comment claimed it
  // exercised `teamExplorer.ignore: null`, when the mock's old `?? d` here
  // silently rewrote `null` into `undefined` before the code under test ever
  // saw it -- so that iteration tested nothing the `undefined` case did not
  // already cover. Real VS Code substitutes the default ONLY for `undefined`.
  it('substitutes the default only for undefined, not for null, false or 0', () => {
    const cfg = workspace.getConfiguration('teamExplorer');
    expect(cfg.get('missing', 'fallback')).toBe('fallback');

    configValues['teamExplorer.probe'] = null;
    expect(cfg.get('probe', 'fallback'), 'null must not be coerced to the default').toBeNull();

    configValues['teamExplorer.probe'] = false;
    expect(cfg.get('probe', true), '`false` must not be coerced to the default').toBe(false);

    configValues['teamExplorer.probe'] = 0;
    expect(cfg.get('probe', 42), '`0` must not be coerced to the default').toBe(0);

    delete configValues['teamExplorer.probe'];
  });
});

describe('TfvcService.initialize on a folder that is not mapped', () => {
  it('leaves NO path mapper behind, so auto-checkout cannot act', async () => {
    // The old code assigned this.mapper before testing the mapping and returned
    // the error without unsetting it. doRefresh then returned undefined --
    // success -- forever, because scope was undefined: a permanently empty
    // panel, no status ever running, and AutoCheckout still happily mapping and
    // checking out every C:\work file edited in another root. Invisibly.
    const runs: Run[] = [];
    const service = new TfvcService(
      fakeClient({ runs }) as never,
      folderAt(UNMAPPED) as never,
      'https://acme.visualstudio.com/',
      outputChannel as never,
    );

    const error = await service.initialize();

    expect(error).toBeDefined();
    expect(service.pathMapper, 'a live mapper here arms auto-checkout').toBeUndefined();
    service.dispose();
  });

  it('a mapped folder DOES get a mapper, so the check is not just always-off', async () => {
    const runs: Run[] = [];
    const service = new TfvcService(
      fakeClient({ runs }) as never,
      folderAt(MAPPED) as never,
      'https://acme.visualstudio.com/',
      outputChannel as never,
    );

    const error = await service.initialize();

    expect(error).toBeUndefined();
    expect(service.pathMapper).toBeDefined();
    service.dispose();
  });
});

describe('TfvcService refreshes when the window regains focus', () => {
  /**
   * Acceptance #16 failed on DEVPC: a file checked out in Visual Studio never
   * appeared in the panel. It was neither pending (so seedWatcher never tracked
   * it from the status cache) nor open in an editor (so it was not seeded from
   * textDocuments either), and ReadOnlyWatcher ignores filesystem events for
   * untracked paths by design. Nothing was watching the file at all.
   */
  const statusRuns = (runs: Run[]) => runs.filter((r) => r.args.includes('status')).length;

  it('runs a status when the window is focused again', async () => {
    const runs: Run[] = [];
    const service = new TfvcService(
      fakeClient({ runs }) as never,
      folderAt(MAPPED) as never,
      'https://acme.visualstudio.com/',
      outputChannel as never,
    );
    await service.initialize();
    const before = statusRuns(runs);

    // Past the focus rate limit. initialize() has just run a status, and a
    // focus arriving inside the quiet window is deliberately dropped - see the
    // FEDORA measurements in focusRefreshTooSoon. The fake client returns
    // instantly, so the quiet window here is the 1000 ms floor.
    await new Promise((r) => setTimeout(r, 1100));

    hooks.didChangeWindowState.emit({ focused: true });
    await new Promise((r) => setTimeout(r, 400)); // past the 300 ms debounce

    expect(statusRuns(runs), 'alt-tabbing back from Visual Studio changed nothing').toBe(
      before + 1,
    );
    service.dispose();
  });

  it('drops a focus that arrives while the last status is still warm', async () => {
    // Measured on FEDORA: `status` over 4,369 files takes ~5.2 s under Wine
    // against ~800 ms on Windows, and the user drives that machine through
    // a remote console, which emits focus events in bursts. Without this the
    // extension spent most of its time running `tf`.
    const runs: Run[] = [];
    const service = new TfvcService(
      fakeClient({ runs }) as never,
      folderAt(MAPPED) as never,
      'https://acme.visualstudio.com/',
      outputChannel as never,
    );
    await service.initialize();
    const before = statusRuns(runs);

    // No wait: initialize()'s status has only just finished.
    hooks.didChangeWindowState.emit({ focused: true });
    hooks.didChangeWindowState.emit({ focused: true });
    hooks.didChangeWindowState.emit({ focused: true });
    await new Promise((r) => setTimeout(r, 400));

    expect(statusRuns(runs), 'a burst of focus events each cost a status').toBe(before);
    expect(outputChannel.lines.join('\n')).toContain('skipping refresh');
    service.dispose();
  });

  it('does NOT rate-limit an explicit refresh, which follows a user action', async () => {
    // The limiter guards the focus path only. A refresh the user asked for, or
    // one following a checkout or an undo, is worth paying for however slow
    // the machine is.
    const runs: Run[] = [];
    const service = new TfvcService(
      fakeClient({ runs }) as never,
      folderAt(MAPPED) as never,
      'https://acme.visualstudio.com/',
      outputChannel as never,
    );
    await service.initialize();
    const before = statusRuns(runs);

    await service.refresh();

    expect(statusRuns(runs)).toBe(before + 1);
    service.dispose();
  });

  it('does NOT run one when the window merely loses focus', async () => {
    // Otherwise every alt-tab away spawns a status against an 80,000-item
    // workspace for a window the user is not looking at.
    const runs: Run[] = [];
    const service = new TfvcService(
      fakeClient({ runs }) as never,
      folderAt(MAPPED) as never,
      'https://acme.visualstudio.com/',
      outputChannel as never,
    );
    await service.initialize();
    const before = statusRuns(runs);

    hooks.didChangeWindowState.emit({ focused: false });
    await new Promise((r) => setTimeout(r, 400));

    expect(statusRuns(runs)).toBe(before);
    service.dispose();
  });

  it('stops listening once disposed, so a focus change cannot spawn tf', async () => {
    const runs: Run[] = [];
    const service = new TfvcService(
      fakeClient({ runs }) as never,
      folderAt(MAPPED) as never,
      'https://acme.visualstudio.com/',
      outputChannel as never,
    );
    await service.initialize();
    expect(hooks.didChangeWindowState.count, 'nothing was listening to begin with').toBe(1);
    service.dispose();
    const before = runs.length;

    // Asserted directly, not just via the absence of a tf run: `disposed` is
    // checked in requestRefresh AND again in refresh, so dropping the listener
    // disposal alone changes no observable behaviour and a run-count assertion
    // passes against it. The leak is the thing being tested here.
    expect(hooks.didChangeWindowState.count, 'the focus listener outlived the service').toBe(0);

    hooks.didChangeWindowState.emit({ focused: true });
    await new Promise((r) => setTimeout(r, 400));

    expect(runs.length, 'tf ran after dispose').toBe(before);
  });
});

describe('TfvcService teardown', () => {
  it('does not spawn a tf command after dispose', async () => {
    // An in-flight auto-checkout cannot be cancelled by dispose(), so it
    // resolves afterwards and calls requestRefresh. That used to arm a fresh
    // timer AFTER teardown and spawn a 12 s recursive status the extension no
    // longer owned.
    const runs: Run[] = [];
    const service = new TfvcService(
      fakeClient({ runs }) as never,
      folderAt(MAPPED) as never,
      'https://acme.visualstudio.com/',
      outputChannel as never,
    );
    await service.initialize();

    service.dispose();
    const before = runs.length;

    service.requestRefresh();
    expect(await service.refresh()).toBeUndefined();
    await new Promise((r) => setTimeout(r, 400));

    expect(runs.length, 'tf ran after dispose').toBe(before);
  });

  it('the Set PAT retry does not leave a second watcher running', async () => {
    const runs: Run[] = [];
    const service = new TfvcService(
      fakeClient({ runs }) as never,
      folderAt(MAPPED) as never,
      'https://acme.visualstudio.com/',
      outputChannel as never,
    );

    await service.initialize();
    await service.initialize(); // the retry after Set PAT

    expect(createdWatchers).toHaveLength(2);
    expect(createdWatchers[0].disposed, 'the first watcher kept polling').toBe(true);
    expect(createdWatchers[1].disposed).toBe(false);

    service.dispose();
    expect(createdWatchers[1].disposed).toBe(true);
  });
});

describe('ReadOnlyWatcher', () => {
  it('does not stat a path it is not tracking', () => {
    // isReadOnly was evaluated as an ARGUMENT, so it ran before update could
    // reject an untracked path: a build writing bin/ and obj/ fired thousands
    // of blocking stats on the extension-host thread for paths then discarded.
    const watcher = new ReadOnlyWatcher(folderAt(MAPPED) as never, false);

    hooks.fsDidChange.emit(Uri.file('C:\\work\\Vesta\\obj\\Debug\\Thing.dll'));

    expect(watcher.trackedCount).toBe(0);
    watcher.dispose();
  });

  it('exposes the bound so callers can avoid preparing evicted entries', () => {
    const watcher = new ReadOnlyWatcher(folderAt(MAPPED) as never, false);
    expect(watcher.capacity).toBeGreaterThan(0);
    watcher.dispose();
  });
});

describe('AutoCheckout', () => {
  // A REAL read-only file. tryCheckout returns early unless isReadOnly is true,
  // and isReadOnly is false for a path that does not exist — so a made-up path
  // makes every assertion in here vacuous.
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tfvc-auto-'));
    file = join(dir, 'Form1.vb');
    writeFileSync(file, 'clean ascii');
    chmodSync(file, 0o444);
  });

  afterEach(() => {
    chmodSync(file, 0o666);
    rmSync(dir, { recursive: true, force: true });
  });

  // A keystroke leaves the document dirty; VS Code reports that WITH the change.
  const doc = (fsPath: string, text = 'clean ascii') => ({
    uri: Uri.file(fsPath),
    fileName: fsPath,
    isDirty: true,
    getText: () => text,
  });

  function build(opts: { fail?: Error; mapped?: boolean } = {}) {
    const runs: Run[] = [];
    const service = {
      pathMapper: opts.mapped === false ? undefined : {
        toServerPath: (p: string) => (p.startsWith(dir) ? '$/Vesta/Form1.vb' : undefined),
      },
      requestRefresh() {},
    };
    const client = {
      timeoutMs: 1000,
      run: async (args: string[]) => {
        if (opts.fail) throw opts.fail;
        runs.push({ args });
        return {
          stdout: Buffer.alloc(0),
          stderr: Buffer.alloc(0),
          exitCode: 0,
          timedOut: false,
        };
      },
    };
    const auto = new AutoCheckout(
      client as never,
      service as never,
      outputChannel as never,
      () => 'onEdit',
    );
    return { auto, runs };
  }

  it('reports a checkout that cannot even start, instead of rejecting into the void', async () => {
    // `void this.tryCheckout(...)` has no .catch, so a spawn throw became an
    // unhandled rejection: nothing shown, `attempted` already set so nothing
    // retries, and every later save failing with a generic read-only error.
    const { auto } = build({ fail: new Error('spawn ENOENT') });

    hooks.didChangeTextDocument.emit({
      document: doc(file),
      contentChanges: [{ text: 'x' }],
    });
    await new Promise((r) => setTimeout(r, 50));

    const warnings = recorder.messages.filter((m) => m.kind === 'warning');
    expect(warnings.length, 'the user was told nothing').toBeGreaterThan(0);
    expect(warnings.map((w) => w.message).join('\n')).toContain('spawn ENOENT');
    auto.dispose();
  });

  it('never scrubs a token into the log or the warning', async () => {
    const { auto } = build({ fail: new Error('failed: /login:.,SECRETPATVALUE') });

    hooks.didChangeTextDocument.emit({
      document: doc(file),
      contentChanges: [{ text: 'x' }],
    });
    await new Promise((r) => setTimeout(r, 50));

    const everything = [...recorder.shown, ...outputChannel.lines].join('\n');
    expect(everything).not.toContain('SECRETPATVALUE');
    auto.dispose();
  });
});

describe('AutoCheckout suppression', () => {
  // Observed on the real host: undo reverted the buffer, and the revert's own
  // change event made auto-checkout check the file straight back out — a
  // second `vc checkout` seconds after the user confirmed the undo.
  let sdir: string;
  let sfile: string;

  beforeEach(() => {
    sdir = mkdtempSync(join(tmpdir(), 'tfvc-sup-'));
    sfile = join(sdir, 'Form1.vb');
    writeFileSync(sfile, 'clean ascii');
    chmodSync(sfile, 0o444);
  });

  afterEach(() => {
    chmodSync(sfile, 0o666);
    rmSync(sdir, { recursive: true, force: true });
  });

  function build() {
    const runs: Run[] = [];
    const service = {
      pathMapper: { toServerPath: (p: string) => (p.startsWith(sdir) ? '$/Vesta/Form1.vb' : undefined) },
      requestRefresh() {},
    };
    const client = {
      timeoutMs: 1000,
      run: async (args: string[]) => {
        runs.push({ args });
        return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0, timedOut: false };
      },
    };
    const auto = new AutoCheckout(client as never, service as never, outputChannel as never, () => 'onEdit');
    return { auto, runs };
  }

  const doc = (p: string, isDirty = true) => ({ uri: Uri.file(p), fileName: p, isDirty, getText: () => 'clean ascii' });

  it('does NOT check out when the change came from our own revert', async () => {
    const { auto, runs } = build();
    auto.suppress(sfile);

    hooks.didChangeTextDocument.emit({ document: doc(sfile), contentChanges: [{ text: 'x' }] });
    await new Promise((r) => setTimeout(r, 50));

    expect(runs, 'the revert re-pended the file').toHaveLength(0);
    auto.dispose();
  });

  it('suppression is case-insensitive, since tf mixes upper and lower drive letters', async () => {
    const { auto, runs } = build();
    auto.suppress(sfile.toUpperCase());

    hooks.didChangeTextDocument.emit({ document: doc(sfile), contentChanges: [{ text: 'x' }] });
    await new Promise((r) => setTimeout(r, 50));

    expect(runs).toHaveLength(process.platform === 'win32' ? 0 : 1);
    auto.dispose();
  });

  it('still checks out a genuine edit — the suppression is not a blanket off switch', async () => {
    const { auto, runs } = build();

    hooks.didChangeTextDocument.emit({ document: doc(sfile), contentChanges: [{ text: 'x' }] });
    await new Promise((r) => setTimeout(r, 50));

    expect(runs).toHaveLength(1);
    expect(runs[0].args).toEqual(['vc', 'checkout', '$/Vesta/Form1.vb']);
    auto.dispose();
  });

  it('does NOT check out when a get rewrote an open, clean file (a reload, not an edit)', async () => {
    // Observed on FEDORA (acceptance item 30): Get This Version rewrote an open
    // frmInvoice.vb, VS Code reloaded the clean buffer, and the reload's change
    // event checked the file out; the Get Latest after it then hit a conflict.
    // A reload leaves the document clean; typing never does.
    const { auto, runs } = build();

    hooks.didChangeTextDocument.emit({ document: doc(sfile, false), contentChanges: [{ text: 'x' }] });
    await new Promise((r) => setTimeout(r, 50));

    expect(runs, 'a reload from disk pended the file').toHaveLength(0);
    auto.dispose();
  });

  it('expires, so a later real edit is not silently ignored', async () => {
    const { auto, runs } = build();
    auto.suppress(sfile, 10);
    await new Promise((r) => setTimeout(r, 40));

    hooks.didChangeTextDocument.emit({ document: doc(sfile), contentChanges: [{ text: 'x' }] });
    await new Promise((r) => setTimeout(r, 50));

    expect(runs).toHaveLength(1);
    auto.dispose();
  });
});

describe('AutoCheckout as a save participant', () => {
  /**
   * The dangerous case. VS Code gives onWillSaveTextDocument roughly 1.5 s and
   * then saves regardless; a Wine checkout regularly overruns that. The save
   * then runs against a still-read-only file, fails, and VS Code offers an
   * **Overwrite** action that clears the read-only bit and writes anyway —
   * chmod u+w instead of a checkout, offered by the editor itself.
   */
  let pdir: string;
  let pfile: string;

  beforeEach(() => {
    pdir = mkdtempSync(join(tmpdir(), 'tfvc-save-'));
    pfile = join(pdir, 'Form1.vb');
    writeFileSync(pfile, 'clean ascii');
    chmodSync(pfile, 0o444);
  });

  afterEach(() => {
    vi.useRealTimers();
    chmodSync(pfile, 0o666);
    rmSync(pdir, { recursive: true, force: true });
  });

  function build(runs: Run[], behaviour: 'slow' | 'fast') {
    const service = {
      pathMapper: { toServerPath: (p: string) => (p.startsWith(pdir) ? '$/Vesta/Form1.vb' : undefined) },
      requestRefresh() {},
    };
    const client = {
      timeoutMs: 60_000,
      run: async (args: string[]) => {
        runs.push({ args });
        // A checkout that never comes back within the budget: Wine cold-start.
        if (behaviour === 'slow') await new Promise(() => {});
        return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0, timedOut: false };
      },
    };
    return new AutoCheckout(client as never, service as never, outputChannel as never, () => 'onSave');
  }

  /** Drives the save the way VS Code does, capturing the blocking promise. */
  function fireWillSave(fsPath: string) {
    let settled = false;
    const waited: Promise<unknown>[] = [];
    hooks.willSaveTextDocument.emit({
      document: { uri: Uri.file(fsPath), fileName: fsPath, getText: () => 'clean ascii' },
      waitUntil: (p: Promise<unknown>) => {
        waited.push(p);
        void p.then(() => {
          settled = true;
        });
      },
    });
    return { waited, settled: () => settled };
  }

  it('keeps the budget under the limit VS Code actually enforces', () => {
    // The timing tests below are written against SAVE_PARTICIPANT_BUDGET_MS, so
    // they move with it and all still pass if it is raised to 30 s. This is the
    // one that does not: the number only does its job while it is below the
    // ~1500 ms VS Code allows a save participant. Above that, VS Code cuts us
    // off first and the overrun goes unreported — which is the whole bug.
    expect(SAVE_PARTICIPANT_BUDGET_MS).toBeLessThan(1500);
    expect(SAVE_PARTICIPANT_BUDGET_MS).toBeGreaterThan(0);
  });

  it('stops blocking the save at the budget instead of being cut off silently', async () => {
    vi.useFakeTimers();
    const runs: Run[] = [];
    const auto = build(runs, 'slow');

    const save = fireWillSave(pfile);
    expect(save.waited, 'the save was never made to wait at all').toHaveLength(1);

    await vi.advanceTimersByTimeAsync(SAVE_PARTICIPANT_BUDGET_MS - 100);
    expect(save.settled(), 'released the save before the budget was up').toBe(false);

    await vi.advanceTimersByTimeAsync(200);
    expect(save.settled(), 'still blocking past the budget — VS Code will drop us').toBe(true);

    auto.dispose();
  });

  it('warns about Overwrite BY NAME, because that button corrupts the file', async () => {
    vi.useFakeTimers();
    const auto = build([], 'slow');

    fireWillSave(pfile);
    await vi.advanceTimersByTimeAsync(SAVE_PARTICIPANT_BUDGET_MS + 100);

    const warnings = recorder.messages.filter((m) => m.kind === 'warning');
    expect(warnings, 'the user was told nothing before being offered Overwrite').toHaveLength(1);
    // Naming it is the whole point: "the save may fail" would leave the user
    // to discover Overwrite on their own and click it.
    expect(warnings[0].message).toContain('Overwrite');
    expect(warnings[0].message).toContain('invisible to source control');
    auto.dispose();
  });

  it('a checkout that lands in time warns about nothing and leaves no timer behind', async () => {
    vi.useFakeTimers();
    const runs: Run[] = [];
    const auto = build(runs, 'fast');

    const save = fireWillSave(pfile);
    await vi.advanceTimersByTimeAsync(0);

    expect(save.settled()).toBe(true);
    expect(runs).toHaveLength(1);
    expect(recorder.messages.filter((m) => m.kind === 'warning')).toHaveLength(0);
    // Without clearTimeout the budget timer stays armed after every fast save.
    expect(vi.getTimerCount(), 'the budget timer was left running').toBe(0);
    auto.dispose();
  });
});

describe('activate() wires up the decoration provider', () => {
  /**
   * DecorationProvider.ts is fully tested in decorationProvider.test.ts, but
   * that file constructs the class directly — it never touches extension.ts.
   * `DecorationProvider` has exactly one construction site,
   * `context.subscriptions.push(new DecorationProvider(service))` in
   * activate(), and until this test existed nothing in the suite ran that
   * line: deleting it left every other test green, because every other test
   * exercises the CLASS, not the WIRING. In a real VS Code window that
   * deletion means no badge is ever drawn, with nothing anywhere saying so.
   *
   * This drives the real activate() end to end — through migrateStateKeys,
   * TfClient, TfvcService, ScmProvider, past the DecorationProvider
   * construction, and through a failed initialize() — so removing that one
   * line fails here even though nothing in DecorationProvider.ts changes.
   */

  afterEach(() => {
    // Shared mutable module state in the mock; nothing else in this file
    // touches it, but leaving it set would let this test bleed into whatever
    // runs after it, in this file or (since vitest can share workers) beyond.
    workspace.workspaceFolders = undefined;
    delete configValues['teamExplorer.wrapperPath'];
  });

  /** A minimal vscode.ExtensionContext: just enough for activate() to run. */
  function fakeExtensionContext() {
    const state = new Map<string, unknown>();
    return {
      subscriptions: [] as { dispose(): void }[],
      workspaceState: {
        get: (k: string, d?: unknown) => (state.has(k) ? state.get(k) : d),
        update: async (k: string, v: unknown) => {
          if (v === undefined) state.delete(k);
          else state.set(k, v);
        },
      },
      secrets: {
        get: async () => undefined,
        store: async () => {},
        delete: async () => {},
      },
    };
  }

  it('registers a FileDecorationProvider, so the tree actually draws badges', async () => {
    workspace.workspaceFolders = [folderAt(MAPPED)];

    // A wrapper path that cannot exist. TfClient spawns it directly (it has no
    // .cmd/.bat extension, so TfClient never shells out through cmd.exe
    // either) and Node's own ENOENT handling turns the failed spawn into an
    // ordinary, non-throwing TfError -- see TfClient.spawn.test.ts for the
    // same "point wrapperPath somewhere harmless" approach with a real
    // executable. This never runs `tf`, or anything else, for real: the path
    // does not exist, so nothing is ever executed. It only has to survive long
    // enough for activate() to run to completion; DecorationProvider is
    // constructed BEFORE service.initialize() is ever called.
    configValues['teamExplorer.wrapperPath'] = join(tmpdir(), 'tfvc-lifecycle-no-such-wrapper');

    // A RELATIVE count. `hooks.reset()` (called from this file's top-level
    // beforeEach via recorder.reset()) does zero `decorationProviders` between
    // tests, so an absolute `toHaveLength(1)` would also pass today -- but a
    // relative count stays correct even if a later test in this file also
    // drives activate(), without depending on this file's reset order.
    const before = decorationProviders.length;
    const context = fakeExtensionContext();

    await activate(context as never);

    expect(
      decorationProviders.length,
      'DecorationProvider was not registered during activate()',
    ).toBe(before + 1);

    for (const d of context.subscriptions) d.dispose();
  });

  it('wires up the Source Control Explorer: its commands, its serializer and the activity bar home (phase 3 part 2)', async () => {
    workspace.workspaceFolders = [folderAt(MAPPED)];
    configValues['teamExplorer.wrapperPath'] = join(tmpdir(), 'tfvc-lifecycle-no-such-wrapper');
    const context = fakeExtensionContext();

    await activate(context as never);

    for (const id of ['teamExplorer.openExplorer', 'teamExplorer.showInExplorer', 'teamExplorer.viewVersion', 'teamExplorer.mapServerFolder']) {
      expect(recorder.commands.has(id), `${id} was not registered`).toBe(true);
    }
    expect(panelSerializers.has('teamExplorer.sourceControlExplorer')).toBe(true);
    expect(treeProviders.has('teamExplorer.home')).toBe(true);

    for (const d of context.subscriptions) d.dispose();
  });

  it('wires up shelvesets: Shelve, Find Shelvesets and the tab serializer (phase 4)', async () => {
    workspace.workspaceFolders = [folderAt(MAPPED)];
    configValues['teamExplorer.wrapperPath'] = join(tmpdir(), 'tfvc-lifecycle-no-such-wrapper');
    const context = fakeExtensionContext();

    await activate(context as never);

    for (const id of ['teamExplorer.shelve', 'teamExplorer.findShelvesets']) {
      expect(recorder.commands.has(id), `${id} was not registered`).toBe(true);
    }
    expect(panelSerializers.has('teamExplorer.shelvesets')).toBe(true);

    for (const d of context.subscriptions) d.dispose();
  });

  it('wires up conflict resolution: the seam command and the palette one (phase 5)', async () => {
    workspace.workspaceFolders = [folderAt(MAPPED)];
    configValues['teamExplorer.wrapperPath'] = join(tmpdir(), 'tfvc-lifecycle-no-such-wrapper');
    const context = fakeExtensionContext();

    await activate(context as never);

    for (const id of ['teamExplorer.resolveConflicts', 'teamExplorer.showConflicts']) {
      expect(recorder.commands.has(id), `${id} was not registered`).toBe(true);
    }

    for (const d of context.subscriptions) d.dispose();
  });
});

describe('activate() wires up the unversioned scan', () => {
  /**
   * The scan has exactly one construction site, in activate(), and the whole
   * feature is invisible without it: no `Not in source control` group, no `!`
   * hazard badge, and no error anywhere saying why. Deleting that line leaves
   * every unit test in the suite green, because they all exercise the CLASS.
   *
   * Observed through the Refresh command rather than through activation,
   * because activation starts a scan only once `initialize()` has SUCCEEDED --
   * the itemspec translation reads `service.pathMapper` -- and initialize()
   * cannot succeed here, since the wrapper path deliberately does not exist.
   * Refresh runs the scan unconditionally OF initialize() -- though not of
   * `teamExplorer.scanForNewFiles`, which the next test exists to prove -- so
   * it is the reachable seam.
   */

  afterEach(() => {
    workspace.workspaceFolders = undefined;
    delete configValues['teamExplorer.wrapperPath'];
    delete configValues['teamExplorer.scanForNewFiles'];
  });

  function fakeExtensionContext() {
    const state = new Map<string, unknown>();
    return {
      subscriptions: [] as { dispose(): void }[],
      workspaceState: {
        get: (k: string, d?: unknown) => (state.has(k) ? state.get(k) : d),
        update: async (k: string, v: unknown) => {
          if (v === undefined) state.delete(k);
          else state.set(k, v);
        },
      },
      secrets: { get: async () => undefined, store: async () => {}, delete: async () => {} },
    };
  }

  /** Waits for a line the scan writes, or gives up. */
  async function waitForScanLine(): Promise<boolean> {
    for (let i = 0; i < 50; i++) {
      if (outputChannel.lines.some((l) => l.includes('scan for new files'))) return true;
      await new Promise((r) => setTimeout(r, 10));
    }
    return false;
  }

  it('runs a scan when Refresh is pressed', async () => {
    workspace.workspaceFolders = [folderAt(MAPPED)];
    configValues['teamExplorer.wrapperPath'] = join(tmpdir(), 'tfvc-lifecycle-no-such-wrapper');
    const context = fakeExtensionContext();

    await activate(context as never);
    outputChannel.clear();
    await recorder.invoke('teamExplorer.refresh');

    expect(await waitForScanLine(), 'Refresh did not run the unversioned scan').toBe(true);

    // The specific line, not just any line mentioning the scan. `toTfPath`
    // throws when the mapping is unknown, and that is deliberate: toWinePath is
    // the IDENTITY on Windows, so a `?? p` fallback would look correct on
    // DEVPC and be silently wrong on FEDORA -- which is how this shipped broken
    // once. Asserting on the generic prefix alone would keep passing if someone
    // reinstated the fallback, because the exit-code failure line contains it
    // too.
    expect(
      outputChannel.lines.some((l) =>
        l.includes('scan ran before the workspace mapping was known'),
      ),
      'toTfPath did not throw: the itemspec may be falling back to an untranslated path',
    ).toBe(true);
    for (const d of context.subscriptions) d.dispose();
  });

  it('survives a teamExplorer.ignore that is not an array of strings', async () => {
    // `WorkspaceConfiguration.get(section, default)` substitutes the default
    // only for `undefined`, so a hand-edited settings.json holding `null` -- or
    // a bare string, the natural typo for a one-entry list -- reaches
    // `buildIgnorer` as the literal value and must not throw inside
    // `activate()`. A throw there rejects the whole activation: no panel, no
    // decorations, no commands, no Check In, and nothing but a line in the
    // extension-host log to say why.
    workspace.workspaceFolders = [folderAt(MAPPED)];
    configValues['teamExplorer.wrapperPath'] = join(tmpdir(), 'tfvc-lifecycle-no-such-wrapper');

    for (const bad of [null, 'node_modules', 42, { a: 1 }]) {
      configValues['teamExplorer.ignore'] = bad;
      const context = fakeExtensionContext();
      const before = decorationProviders.length;
      outputChannel.clear();

      await activate(context as never);

      expect(
        decorationProviders.length,
        `activate() died on teamExplorer.ignore = ${JSON.stringify(bad)}`,
      ).toBe(before + 1);
      if (bad === null) {
        // This is the case the mock's `get()` fix is for: with the OLD mock
        // (`?? d`), `null` here was silently rewritten to `undefined` before
        // `buildIgnorer` ever ran, so this log line never appeared and the
        // iteration was indistinguishable from testing `undefined`.
        expect(
          outputChannel.lines.join('\n'),
          'teamExplorer.ignore: null did not reach buildIgnorer as null',
        ).toContain('teamExplorer.ignore is null, not an array of strings');
      }
      for (const d of context.subscriptions) d.dispose();
    }
    delete configValues['teamExplorer.ignore'];
  });

  it('runs no scan at all when teamExplorer.scanForNewFiles is false', async () => {
    // The off switch has to reach the RUNNER, not just hide the group: a user
    // who turns this off is usually doing it because the scan is expensive on
    // their collection (17-20 s across the whole of C:\work).
    workspace.workspaceFolders = [folderAt(MAPPED)];
    configValues['teamExplorer.wrapperPath'] = join(tmpdir(), 'tfvc-lifecycle-no-such-wrapper');
    configValues['teamExplorer.scanForNewFiles'] = false;
    const context = fakeExtensionContext();

    await activate(context as never);
    outputChannel.clear();
    await recorder.invoke('teamExplorer.refresh');

    expect(await waitForScanLine(), 'the scan ran although the setting is off').toBe(false);
    for (const d of context.subscriptions) d.dispose();
  });
});

describe('activate() wires up the FileSystemWatcher as intended', () => {
  /**
   * The watcher has exactly one construction site, right beside `scan` itself
   * in activate(). It has to exist even when `initialize()` fails -- a file
   * can appear on disk before the workspace mapping is even known -- so this
   * reuses the same "wrapper path does not exist" setup as the describe block
   * above rather than needing initialize() to succeed.
   */

  afterEach(() => {
    workspace.workspaceFolders = undefined;
    delete configValues['teamExplorer.wrapperPath'];
  });

  function fakeExtensionContext() {
    const state = new Map<string, unknown>();
    return {
      subscriptions: [] as { dispose(): void }[],
      workspaceState: {
        get: (k: string, d?: unknown) => (state.has(k) ? state.get(k) : d),
        update: async (k: string, v: unknown) => {
          if (v === undefined) state.delete(k);
          else state.set(k, v);
        },
      },
      secrets: { get: async () => undefined, store: async () => {}, delete: async () => {} },
    };
  }

  it('creates a FileSystemWatcher and registers it on context.subscriptions', async () => {
    workspace.workspaceFolders = [folderAt(MAPPED)];
    configValues['teamExplorer.wrapperPath'] = join(tmpdir(), 'tfvc-lifecycle-no-such-wrapper');
    const context = fakeExtensionContext();
    const before = createdWatchers.length;

    await activate(context as never);

    expect(createdWatchers.length, 'no FileSystemWatcher was created during activate()').toBe(
      before + 1,
    );
    const watcher = createdWatchers[before];
    expect(watcher.disposed).toBe(false);

    for (const d of context.subscriptions) d.dispose();
    expect(watcher.disposed, 'the watcher was not pushed onto context.subscriptions').toBe(true);
  });

  it("wires the watcher's onDidCreate to noteArrival and onDidDelete to noteDeparture", async () => {
    workspace.workspaceFolders = [folderAt(MAPPED)];
    configValues['teamExplorer.wrapperPath'] = join(tmpdir(), 'tfvc-lifecycle-no-such-wrapper');
    const context = fakeExtensionContext();

    // ReadOnlyWatcher's own onDidCreate/onDidDelete only ever attach once
    // TfvcService.initialize() succeeds (it does not here), so spying on the
    // prototype is what isolates "the scan's watcher wiring", rather than
    // hoping this describe block's setup never runs another onDidCreate
    // consumer alongside it.
    const arrivalSpy = vi.spyOn(UnversionedScan.prototype, 'noteArrival');
    const departureSpy = vi.spyOn(UnversionedScan.prototype, 'noteDeparture');
    try {
      await activate(context as never);

      const created = join(MAPPED, 'new-file.txt');
      const deleted = join(MAPPED, 'gone-file.txt');
      hooks.fsDidCreate.emit(Uri.file(created));
      hooks.fsDidDelete.emit(Uri.file(deleted));

      expect(arrivalSpy).toHaveBeenCalledWith(created);
      expect(departureSpy).toHaveBeenCalledWith(deleted);
    } finally {
      arrivalSpy.mockRestore();
      departureSpy.mockRestore();
      for (const d of context.subscriptions) d.dispose();
    }
  });
});

describe('activate() wires up .tfignore', () => {
  /**
   * `.tfignore` support (readTfIgnore.ts, IgnoreMatcher.ts) is otherwise
   * tested only through tfIgnore.test.ts, which never touches extension.ts.
   * `buildIgnorer` has exactly one pair of call sites, both in activate(),
   * and replacing `combineIgnoreSources(patterns, loaded)` with
   * `combineIgnoreSources(patterns, undefined)` there -- disabling the whole
   * feature at its one wiring point -- passed the full suite before this
   * test existed: every other test exercises readTfIgnore/IgnoreMatcher as
   * CLASSES, never the wiring that reads a real `.tfignore` off disk and
   * reports what it found.
   *
   * The `.tfignore` here lives in a throwaway temp directory created and
   * removed by this test, never under `C:\work` and never a real,
   * Visual-Studio-shared file -- CLAUDE.md forbids touching either.
   */

  afterEach(() => {
    workspace.workspaceFolders = undefined;
    delete configValues['teamExplorer.wrapperPath'];
  });

  function fakeExtensionContext() {
    const state = new Map<string, unknown>();
    return {
      subscriptions: [] as { dispose(): void }[],
      workspaceState: {
        get: (k: string, d?: unknown) => (state.has(k) ? state.get(k) : d),
        update: async (k: string, v: unknown) => {
          if (v === undefined) state.delete(k);
          else state.set(k, v);
        },
      },
      secrets: { get: async () => undefined, store: async () => {}, delete: async () => {} },
    };
  }

  it('reads a real .tfignore from the workspace root and logs what it contributed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tfvc-tfignore-lifecycle-'));
    try {
      // One line buildIgnorer can parse, one it cannot -- so both log paths
      // (the summary AND the "skipped" line) are exercised, not just one.
      writeFileSync(join(root, '.tfignore'), 'vendor\nsrc/bin\n', 'utf8');
      workspace.workspaceFolders = [folderAt(root)];
      // Same trick as the sibling describe blocks above: a wrapper path that
      // cannot exist, so TfClient's spawn fails with ENOENT and nothing real
      // is ever executed, while activate() still runs to completion.
      configValues['teamExplorer.wrapperPath'] = join(tmpdir(), 'tfvc-lifecycle-no-such-wrapper');
      const context = fakeExtensionContext();

      await activate(context as never);

      const log = outputChannel.lines.join('\n');
      const tfignorePath = join(root, '.tfignore');
      expect(log, '.tfignore was never read during activate()').toContain(
        `${tfignorePath} contributed 1 pattern(s)`,
      );
      expect(log, 'the unparseable line was not logged').toContain(
        'skipped a line this extension does not understand: src/bin',
      );

      for (const d of context.subscriptions) d.dispose();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('Task 5: re-scan when it matters, never lose a request', () => {
  function fakeExtensionContext() {
    const state = new Map<string, unknown>();
    return {
      subscriptions: [] as { dispose(): void }[],
      workspaceState: {
        get: (k: string, d?: unknown) => (state.has(k) ? state.get(k) : d),
        update: async (k: string, v: unknown) => {
          if (v === undefined) state.delete(k);
          else state.set(k, v);
        },
      },
      secrets: { get: async () => undefined, store: async () => {}, delete: async () => {} },
    };
  }

  async function waitForScanLine(): Promise<boolean> {
    for (let i = 0; i < 50; i++) {
      if (outputChannel.lines.some((l) => l.includes('scan for new files'))) return true;
      await new Promise((r) => setTimeout(r, 10));
    }
    return false;
  }

  afterEach(() => {
    workspace.workspaceFolders = undefined;
    delete configValues['teamExplorer.wrapperPath'];
    delete configValues['teamExplorer.ignore'];
  });

  describe('a scan runs right after a successful initialize(), with no Refresh needed', () => {
    it('kills the "no startScan() after a successful initialize()" mutant', async () => {
      workspace.workspaceFolders = [folderAt(MAPPED)];
      // Irrelevant here: TfClient.prototype.run is fully replaced below, so
      // nothing is ever really spawned regardless of what this path resolves
      // to.
      configValues['teamExplorer.wrapperPath'] = join(tmpdir(), 'tfvc-lifecycle-no-such-wrapper');

      const runSpy = stubTfRun({});
      const context = fakeExtensionContext();
      try {
        await activate(context as never);

        expect(
          await waitForScanLine(),
          'no scan ran after a successful initialize() -- Refresh was never pressed',
        ).toBe(true);
        expect(outputChannel.lines.some((l) => l.includes('listed 0 item(s)'))).toBe(true);
      } finally {
        runSpy.mockRestore();
        for (const d of context.subscriptions) d.dispose();
      }
    });
  });

  describe('the retry path after Set PAT', () => {
    it('kills the "no startScan() on the retry path" mutant: a scan runs after the SECOND initialize() succeeds', async () => {
      workspace.workspaceFolders = [folderAt(MAPPED)];
      configValues['teamExplorer.wrapperPath'] = join(tmpdir(), 'tfvc-lifecycle-no-such-wrapper');

      const runSpy = stubTfRun({
        // The first `workspaces` call fails with a rejected PAT (TF30063),
        // which is what makes activate() offer "Set Personal Access Token"
        // and retry; the second succeeds, using the real fixture mapping.
        workspacesByCall: (call) =>
          call === 1
            ? {
                stdout: Buffer.alloc(0),
                stderr: Buffer.from('TF30063: You are not authorized to access...', 'utf8'),
                exitCode: 1,
                timedOut: false,
              }
            : ok(WORKSPACES_XML),
      });
      // Answers the error dialog's one action: "Set Personal Access Token".
      // `vscode.commands.executeCommand` in the mock only RECORDS the call --
      // it does not run the real `teamExplorer.setPat` handler -- so nothing
      // here depends on the input box or SecretStorage beyond what
      // `fakeExtensionContext`'s stubs already answer.
      recorder.answers.push(S.setPat);

      const context = fakeExtensionContext();
      try {
        await activate(context as never);

        expect(
          await waitForScanLine(),
          'no scan ran after the retried initialize() succeeded',
        ).toBe(true);
      } finally {
        runSpy.mockRestore();
        for (const d of context.subscriptions) d.dispose();
      }
    });
  });

  describe('a teamExplorer.ignore change', () => {
    it('kills the "no startScan() on a teamExplorer.ignore change" mutant', async () => {
      workspace.workspaceFolders = [folderAt(MAPPED)];
      configValues['teamExplorer.wrapperPath'] = join(tmpdir(), 'tfvc-lifecycle-no-such-wrapper');
      const context = fakeExtensionContext();

      await activate(context as never);
      outputChannel.clear();
      fireConfigChange('teamExplorer.ignore');

      expect(
        await waitForScanLine(),
        'an ignore change did not run the unversioned scan',
      ).toBe(true);
      for (const d of context.subscriptions) d.dispose();
    });
  });

  describe("the scan's /exclude: reflects the LIVE ignorer, not DEFAULT_IGNORE", () => {
    it('kills the "DEFAULT_IGNORE used instead of the live ignorer" mutant', async () => {
      workspace.workspaceFolders = [folderAt(MAPPED)];
      configValues['teamExplorer.wrapperPath'] = join(tmpdir(), 'tfvc-lifecycle-no-such-wrapper');
      configValues['teamExplorer.ignore'] = ['my-custom-exclusion'];

      const reconcileArgs: string[][] = [];
      const runSpy = stubTfRun({ onReconcile: (args) => reconcileArgs.push(args) });
      const context = fakeExtensionContext();
      try {
        await activate(context as never);
        expect(await waitForScanLine()).toBe(true);

        const exclude = reconcileArgs[0]?.find((a) => a.startsWith('/exclude:'));
        expect(exclude, 'the scan never ran with an /exclude: argument at all').toBeDefined();
        expect(exclude).toContain('my-custom-exclusion');
        // 'node_modules' is DEFAULT_IGNORE's own distinguishing member -- it is
        // not one of TF_BUILTIN_EXCLUSIONS -- so its absence here proves the
        // scan used the LIVE setting, not the built-in fallback list.
        expect(exclude).not.toContain('node_modules');
      } finally {
        runSpy.mockRestore();
        for (const d of context.subscriptions) d.dispose();
      }
    });
  });

  describe('the scan is pushed onto context.subscriptions', () => {
    it('kills the "scan not disposed at deactivation" mutant', async () => {
      workspace.workspaceFolders = [folderAt(MAPPED)];
      configValues['teamExplorer.wrapperPath'] = join(tmpdir(), 'tfvc-lifecycle-no-such-wrapper');
      const context = fakeExtensionContext();
      const disposeSpy = vi.spyOn(UnversionedScan.prototype, 'dispose');
      try {
        await activate(context as never);
        expect(disposeSpy).not.toHaveBeenCalled();

        for (const d of context.subscriptions) d.dispose();

        expect(
          disposeSpy,
          'the scan was not pushed onto context.subscriptions',
        ).toHaveBeenCalledTimes(1);
      } finally {
        disposeSpy.mockRestore();
      }
    });
  });

  describe('.tfignore is re-read before EVERY scan, not just at activation', () => {
    it('kills the "ignorer rebuilt only once" mutant: a temp-dir .tfignore change between two scans changes the second /exclude:', async () => {
      const root = mkdtempSync(join(tmpdir(), 'tfvc-tfignore-rescan-'));
      const toWineLocal = (p: string) => (ON_WINDOWS ? p : 'Z:' + p.replace(/\//g, '\\'));
      try {
        writeFileSync(join(root, '.tfignore'), 'firstpattern\n', 'utf8');
        workspace.workspaceFolders = [folderAt(root)];
        configValues['teamExplorer.wrapperPath'] = join(tmpdir(), 'tfvc-lifecycle-no-such-wrapper');

        // A synthetic `workspaces` XML mapping THIS temp dir, not the shared
        // fixture -- `.tfignore` must live somewhere this test can write to
        // and remove, never under `C:\work`.
        const workspacesXml = Buffer.from(
          '<Workspaces><Workspace name="W" computer="C"><Folders>' +
            `<WorkingFolder type="Map" item="$/Proj" local="${toWineLocal(root)}"/>` +
            '</Folders></Workspace></Workspaces>',
          'utf8',
        );
        const reconcileArgs: string[][] = [];
        const runSpy = stubTfRun({
          workspacesXml,
          onReconcile: (args) => reconcileArgs.push(args),
        });
        const context = fakeExtensionContext();
        try {
          await activate(context as never); // scan 1, with 'firstpattern'
          expect(await waitForScanLine()).toBe(true);
          expect(reconcileArgs).toHaveLength(1);
          expect(reconcileArgs[0].find((a) => a.startsWith('/exclude:'))).toContain(
            'firstpattern',
          );

          writeFileSync(join(root, '.tfignore'), 'secondpattern\n', 'utf8');
          outputChannel.clear();
          await recorder.invoke('teamExplorer.refresh'); // scan 2

          expect(await waitForScanLine()).toBe(true);
          expect(reconcileArgs).toHaveLength(2);
          const secondExclude = reconcileArgs[1].find((a) => a.startsWith('/exclude:'));
          expect(secondExclude).toContain('secondpattern');
          expect(secondExclude).not.toContain('firstpattern');
        } finally {
          runSpy.mockRestore();
          for (const d of context.subscriptions) d.dispose();
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe('DecorationProvider and ScmProvider are subscribed to the scan\'s OWN change event', () => {
    it('kills the "scan event not subscribed" mutant: both react to a scan landing with no status refresh involved', async () => {
      workspace.workspaceFolders = [folderAt(MAPPED)];
      configValues['teamExplorer.wrapperPath'] = join(tmpdir(), 'tfvc-lifecycle-no-such-wrapper');

      const runSpy = stubTfRun({});
      // `render` is private at the type level only; at runtime it is an
      // ordinary prototype method, and spying on it (default: calls through)
      // is the only way to observe ScmProvider's OWN re-render count without
      // adding a test-only hook to production code.
      const renderSpy = vi.spyOn(ScmProvider.prototype as unknown as Record<string, () => void>, 'render');

      const beforeProviders = decorationProviders.length;
      const context = fakeExtensionContext();
      try {
        await activate(context as never);
        expect(await waitForScanLine(), 'the activation scan never landed').toBe(true);

        const decorationProvider = decorationProviders[beforeProviders] as {
          onDidChangeFileDecorations: (h: (e: unknown) => void) => { dispose(): void };
        };
        const seen: unknown[] = [];
        decorationProvider.onDidChangeFileDecorations((e) => seen.push(e));
        const rendersBefore = renderSpy.mock.calls.length;

        outputChannel.clear();
        // teamExplorer.refresh fires BOTH `service.refresh()` (a status) AND
        // `startScan()`, so a correctly-wired DecorationProvider/ScmProvider
        // fire TWICE here -- once from `service.onDidChange`, once from the
        // scan's own `onDidChange`. If the scan event were not subscribed,
        // only the status refresh's single fire would show up, however many
        // times this runs.
        await recorder.invoke('teamExplorer.refresh');
        expect(await waitForScanLine(), 'the second scan never landed').toBe(true);

        expect(
          seen.length,
          "DecorationProvider fired only from the status refresh, not the scan's own event",
        ).toBeGreaterThanOrEqual(2);
        expect(
          renderSpy.mock.calls.length - rendersBefore,
          "ScmProvider re-rendered only from the status refresh, not the scan's own event",
        ).toBeGreaterThanOrEqual(2);
      } finally {
        runSpy.mockRestore();
        renderSpy.mockRestore();
        for (const d of context.subscriptions) d.dispose();
      }
    });
  });
});

describe('follow-up: a successful Check In re-scans (registerCheckIn is wired to startScan)', () => {
  function fakeExtensionContext() {
    const state = new Map<string, unknown>();
    return {
      subscriptions: [] as { dispose(): void }[],
      workspaceState: {
        get: (k: string, d?: unknown) => (state.has(k) ? state.get(k) : d),
        update: async (k: string, v: unknown) => {
          if (v === undefined) state.delete(k);
          else state.set(k, v);
        },
      },
      secrets: { get: async () => undefined, store: async () => {}, delete: async () => {} },
    };
  }

  async function waitForScanLine(): Promise<boolean> {
    for (let i = 0; i < 50; i++) {
      if (outputChannel.lines.some((l) => l.includes('scan for new files'))) return true;
      await new Promise((r) => setTimeout(r, 10));
    }
    return false;
  }

  afterEach(() => {
    workspace.workspaceFolders = undefined;
    delete configValues['teamExplorer.wrapperPath'];
  });

  it('kills the "startScan not passed to registerCheckIn" mutant: a successful Check In runs a second reconcile', async () => {
    workspace.workspaceFolders = [folderAt(MAPPED)];
    configValues['teamExplorer.wrapperPath'] = join(tmpdir(), 'tfvc-lifecycle-no-such-wrapper');

    // A REAL pending Edit on a mapped file, so `scm.includedChanges` is
    // non-empty -- `teamExplorer.checkInFromButton` returns immediately
    // otherwise (`if (files.length === 0) return;`), and this test would
    // pass vacuously without ever driving the confirm dialog or runMutation.
    const serverItem = '$/Vesta/A.vb';
    const toWineLocal = (p: string) => (ON_WINDOWS ? p : 'Z:' + p.replace(/\//g, '\\'));
    const localWine = toWineLocal(join(MAPPED, 'A.vb'));
    const statusXml = Buffer.from(
      '<Status><PendingSet><PendingChanges>' +
        `<PendingChange item="${serverItem}" local="${localWine}" chg="Edit" type="File" enc="1250" itemid="7" date=""/>` +
        '</PendingChanges></PendingSet></Status>',
      'utf8',
    );

    const reconcileArgs: string[][] = [];
    const runSpy = stubTfRun({ statusXml, onReconcile: (args) => reconcileArgs.push(args) });
    const context = fakeExtensionContext();
    try {
      await activate(context as never);
      expect(await waitForScanLine(), 'the activation scan never landed').toBe(true);
      expect(reconcileArgs).toHaveLength(1);

      recorder.answers.push(S.checkInConfirmYes);
      outputChannel.clear();
      // Through the REAL registered command and the REAL confirm dialog (via
      // the mock), never a direct call to a check-in function -- hard rule 1
      // requires that this stay the only route.
      await recorder.invoke('teamExplorer.checkInFromButton');

      expect(await waitForScanLine(), 'Check In did not trigger a re-scan').toBe(true);
      expect(reconcileArgs, 'Check In did not trigger a SECOND reconcile call').toHaveLength(2);
    } finally {
      runSpy.mockRestore();
      for (const d of context.subscriptions) d.dispose();
    }
  });
});

describe('follow-up: the output channel stops writing once deactivated (activate() wires timestamped to context.subscriptions)', () => {
  function fakeExtensionContext() {
    const state = new Map<string, unknown>();
    return {
      subscriptions: [] as { dispose(): void }[],
      workspaceState: {
        get: (k: string, d?: unknown) => (state.has(k) ? state.get(k) : d),
        update: async (k: string, v: unknown) => {
          if (v === undefined) state.delete(k);
          else state.set(k, v);
        },
      },
      secrets: { get: async () => undefined, store: async () => {}, delete: async () => {} },
    };
  }

  afterEach(() => {
    workspace.workspaceFolders = undefined;
    delete configValues['teamExplorer.wrapperPath'];
  });

  it('kills the "timestamped(channel) called without context.subscriptions" mutant', async () => {
    workspace.workspaceFolders = [folderAt(MAPPED)];
    configValues['teamExplorer.wrapperPath'] = join(tmpdir(), 'tfvc-lifecycle-no-such-wrapper');

    let log: ((line: string) => void) | undefined;
    const runSpy = stubTfRun({
      captureLog: (l) => {
        log = l;
      },
    });
    const context = fakeExtensionContext();
    try {
      await activate(context as never);
      expect(log, "never captured TfClient's log callback").toBeDefined();

      for (const d of context.subscriptions) d.dispose();
      const before = outputChannel.lines.length;

      // Simulates a real `tf` process finishing its own logging -- TfClient's
      // `finish()` calls `log(...)` unconditionally, with no concept of
      // "disposed" of its own -- strictly AFTER the extension has torn down.
      log!('late line, after deactivation');

      expect(
        outputChannel.lines.length,
        'a line written after deactivation reached the output channel',
      ).toBe(before);
    } finally {
      runSpy.mockRestore();
      for (const d of context.subscriptions) d.dispose();
    }
  });
});

describe('activate(): per-activation .tfignore log state (review item 4)', () => {
  /**
   * `buildIgnorer`'s "log only on change" dedup key used to live in a
   * module-level `let`, so a SECOND `activate()` call (the extension host
   * reloading the window, or a second test in the same process) inherited
   * the first activation's memory of what it had already logged and stayed
   * silent about a `.tfignore` it had never mentioned in this "activation" at
   * all. Moving `tfIgnoreLogState` to a fresh object per `activate()` call
   * fixed it; this test is what a reviewer noted was still missing --
   * `buildIgnorer.test`-level tests passing two hand-built fresh objects
   * prove `buildIgnorer` itself resets correctly, but not that `activate()`
   * actually constructs a fresh one each time it runs.
   */
  afterEach(() => {
    workspace.workspaceFolders = undefined;
    delete configValues['teamExplorer.wrapperPath'];
  });

  function fakeExtensionContext() {
    const state = new Map<string, unknown>();
    return {
      subscriptions: [] as { dispose(): void }[],
      workspaceState: {
        get: (k: string, d?: unknown) => (state.has(k) ? state.get(k) : d),
        update: async (k: string, v: unknown) => {
          if (v === undefined) state.delete(k);
          else state.set(k, v);
        },
      },
      secrets: { get: async () => undefined, store: async () => {}, delete: async () => {} },
    };
  }

  it('activating twice logs the same .tfignore summary both times, not just the first', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tfvc-tfignore-reactivate-'));
    try {
      // Content never changes between the two activations -- the point is
      // that a module-global dedup key would see "already logged this" on
      // the second call and wrongly stay silent.
      writeFileSync(join(root, '.tfignore'), 'vendor\n', 'utf8');
      workspace.workspaceFolders = [folderAt(root)];
      configValues['teamExplorer.wrapperPath'] = join(tmpdir(), 'tfvc-lifecycle-no-such-wrapper');
      const expected = `${join(root, '.tfignore')} contributed 1 pattern(s)`;

      const context1 = fakeExtensionContext();
      await activate(context1 as never);
      const afterFirst = outputChannel.lines.filter((l: string) => l.includes(expected)).length;
      expect(afterFirst, 'the first activation must log the summary').toBe(1);

      const context2 = fakeExtensionContext();
      await activate(context2 as never);
      const afterSecond = outputChannel.lines.filter((l: string) => l.includes(expected)).length;
      expect(
        afterSecond,
        'a second activation must log its own summary again',
      ).toBe(2);

      for (const d of context1.subscriptions) d.dispose();
      for (const d of context2.subscriptions) d.dispose();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('activate(): the .tfignore walk is bounded once the mapping is known (review item 4)', () => {
  /**
   * `PathMapper.localRootFor` feeds `findTfIgnore`'s `stopDir` only once
   * `service.pathMapper` is set, i.e. after a SUCCESSFUL `initialize()`.
   * Every other lifecycle test in this file uses a wrapper path that cannot
   * exist specifically so `initialize()` FAILS harmlessly -- which is also
   * why none of them could ever have caught `stopDir:` being deleted from
   * `rebuildIgnorer` in extension.ts. `initialize()` must actually succeed
   * here, without ever touching real `tf`: `TfClient.prototype.run` is
   * stubbed, keyed on the verb the same way the `fakeClient` helper at the
   * top of this file already does for `TfvcService`-level tests, and the
   * `workspaces` XML it returns is built fresh in code (never a fixture
   * pointing at the real, protected `C:\work`) so the synthetic mapping's
   * root can be an ordinary temp directory.
   */
  afterEach(() => {
    workspace.workspaceFolders = undefined;
    delete configValues['teamExplorer.wrapperPath'];
    vi.restoreAllMocks();
  });

  function fakeExtensionContext() {
    const state = new Map<string, unknown>();
    return {
      subscriptions: [] as { dispose(): void }[],
      workspaceState: {
        get: (k: string, d?: unknown) => (state.has(k) ? state.get(k) : d),
        update: async (k: string, v: unknown) => {
          if (v === undefined) state.delete(k);
          else state.set(k, v);
        },
      },
      secrets: { get: async () => undefined, store: async () => {}, delete: async () => {} },
    };
  }

  function workspacesXmlFor(localPath: string): Buffer {
    // tf.exe reports working folders in ITS OWN terms -- a `Z:` path under
    // Wine, never the host's raw `/tmp/...` -- so the stubbed XML must too
    // (as the other `toWineLocal` uses in this file already do), or
    // `PathMapper` (built with the real platform) never recognises `mapRoot`
    // as covering the workspace folder and `doInitialize` silently falls back
    // to `noWorkspaceMapping`, so `stopDir` is never applied (M3).
    const toWineLocal = (p: string) => (ON_WINDOWS ? p : 'Z:' + p.replace(/\//g, '\\'));
    return Buffer.from(
      '<Workspaces><Workspace computer="TEST" name="TEST" ownerdisp="Test" ownerid="0" ' +
        'ownertype="x" owner="0" owneruniq="0"><Comment /><Folders>' +
        `<WorkingFolder local="${toWineLocal(localPath)}" item="$/" />` +
        '</Folders><LastAccessDate>2026-09-16T08:21:45.403+02:00</LastAccessDate>' +
        '<OwnerAliases><string>user@example.com</string></OwnerAliases></Workspace></Workspaces>',
      'utf8',
    );
  }

  /** Stubs TfClient.run so initialize() succeeds against a SYNTHETIC mapping. */
  function stubSuccessfulTf(mapRoot: string) {
    vi.spyOn(TfClient.prototype, 'run').mockImplementation(async (args: unknown) => {
      const isWorkspaces = (args as string[]).includes('workspaces');
      return {
        stdout: isWorkspaces ? workspacesXmlFor(mapRoot) : Buffer.from('<Status />'),
        stderr: Buffer.alloc(0),
        exitCode: 0,
        timedOut: false,
      };
    });
  }

  /**
   * A writable, read-only-flipped probe file inside a "vendor" directory --
   * `ignored: true` resolves unconditionally to the `ignored` FileState
   * (draws nothing), while `ignored: false` + read-only resolves to
   * `versioned` (draws the lock badge) regardless of the scan verdict. That
   * gives a decoration that is `undefined` exactly when the ignorer still
   * thinks "vendor" is excluded, and defined exactly when it does not.
   */
  function makeReadOnlyProbe(underDir: string): string {
    const probeDir = join(underDir, 'vendor');
    mkdirSync(probeDir, { recursive: true });
    const probe = join(probeDir, 'x.js');
    writeFileSync(probe, '', 'utf8');
    chmodSync(probe, 0o444);
    return probe;
  }

  it('a .tfignore ABOVE the mapping root is not read once the mapping is known', async () => {
    const outer = mkdtempSync(join(tmpdir(), 'tfvc-stopdir-outer-'));
    try {
      writeFileSync(join(outer, '.tfignore'), 'vendor\n', 'utf8');
      const mapRoot = join(outer, 'map');
      const sub = join(mapRoot, 'sub');
      mkdirSync(sub, { recursive: true });
      const probe = makeReadOnlyProbe(sub);

      workspace.workspaceFolders = [folderAt(sub)];
      stubSuccessfulTf(mapRoot);
      const context = fakeExtensionContext();

      await activate(context as never);

      const provider = decorationProviders.at(-1) as {
        provideFileDecoration(u: unknown): unknown;
      };
      const decoration = provider.provideFileDecoration(Uri.file(probe));
      expect(
        decoration,
        'the outer .tfignore must not still be feeding the ignorer once the mapping is known',
      ).toBeDefined();

      for (const d of context.subscriptions) d.dispose();
    } finally {
      rmSync(outer, { recursive: true, force: true });
    }
  });

  it('a .tfignore AT the mapping root is still read once the mapping is known (the bound is inclusive)', async () => {
    const outer = mkdtempSync(join(tmpdir(), 'tfvc-stopdir-inner-'));
    try {
      const mapRoot = join(outer, 'map');
      const sub = join(mapRoot, 'sub');
      mkdirSync(sub, { recursive: true });
      writeFileSync(join(mapRoot, '.tfignore'), 'vendor\n', 'utf8');
      const probe = makeReadOnlyProbe(sub);

      workspace.workspaceFolders = [folderAt(sub)];
      stubSuccessfulTf(mapRoot);
      const context = fakeExtensionContext();

      await activate(context as never);

      const provider = decorationProviders.at(-1) as {
        provideFileDecoration(u: unknown): unknown;
      };
      const decoration = provider.provideFileDecoration(Uri.file(probe));
      expect(decoration, 'a .tfignore at the mapping root must still be read').toBeUndefined();

      for (const d of context.subscriptions) d.dispose();
    } finally {
      rmSync(outer, { recursive: true, force: true });
    }
  });
});

describe('activate() publishes the active file state for the editor menus (plan 3)', () => {
  afterEach(() => {
    workspace.workspaceFolders = undefined;
    delete configValues['teamExplorer.wrapperPath'];
  });

  function fakeExtensionContext() {
    const state = new Map<string, unknown>();
    return {
      subscriptions: [] as { dispose(): void }[],
      workspaceState: {
        get: (k: string, d?: unknown) => (state.has(k) ? state.get(k) : d),
        update: async (k: string, v: unknown) => {
          if (v === undefined) state.delete(k);
          else state.set(k, v);
        },
      },
      secrets: { get: async () => undefined, store: async () => {}, delete: async () => {} },
    };
  }

  const published = () =>
    executed
      .filter((e) => e.id === 'setContext' && e.args[0] === 'teamExplorer.activeFileState')
      .map((e) => e.args[1]);

  it('publishes at activation, and again once initialize() makes the file mappable', async () => {
    const spy = stubTfRun({});
    try {
      workspace.workspaceFolders = [folderAt(MAPPED)];
      // Never created: tests must not write under the real workspace. A path
      // that does not exist resolves to no state at all once it is mapped.
      recorder.activeTextEditor = {
        document: { uri: Uri.file(join(MAPPED, 'tfvc-plan3-no-such-file.vb')) },
      };
      const context = fakeExtensionContext();

      await activate(context as never);
      for (let i = 0; i < 100 && published().length < 2; i++) {
        await new Promise((r) => setTimeout(r, 10));
      }

      // Before initialize() nothing is mapped; after it succeeds the service
      // fires onDidChange, which DecorationProvider turns into its own
      // onDidChangeFileDecorations -- the ONE trigger ActiveFileState listens
      // to -- so the key is re-read there, and the missing file answers ''.
      expect(published()).toEqual(['unmapped', '']);
      for (const d of context.subscriptions) d.dispose();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('activate() registers Check for Server Changes as Compare under a second name (plan 3)', () => {
  afterEach(() => {
    workspace.workspaceFolders = undefined;
    delete configValues['teamExplorer.wrapperPath'];
  });

  it('binds both ids to the same handler', async () => {
    workspace.workspaceFolders = [folderAt(MAPPED)];
    configValues['teamExplorer.wrapperPath'] = join(tmpdir(), 'tfvc-lifecycle-no-such-wrapper');
    const state = new Map<string, unknown>();
    const context = {
      subscriptions: [] as { dispose(): void }[],
      workspaceState: {
        get: (k: string, d?: unknown) => (state.has(k) ? state.get(k) : d),
        update: async (k: string, v: unknown) => void state.set(k, v),
      },
      secrets: { get: async () => undefined, store: async () => {}, delete: async () => {} },
    };

    await activate(context as never);

    const compare = recorder.commands.get('teamExplorer.compareWithLatest');
    expect(compare).toBeDefined();
    expect(recorder.commands.get('teamExplorer.checkForServerChanges')).toBe(compare);
    for (const d of context.subscriptions) d.dispose();
  });
});

describe('I1: activation never awaits the recovery notification (task 7-8 review)', () => {
  /**
   * Before this fix, the tail of activate() -- everything after the first
   * `service.initialize()` -- ran inline: `await
   * vscode.window.showErrorMessage(...)`, and on "Set Up Workspace", `await
   * vscode.commands.executeCommand('teamExplorer.manageWorkspace')`, a whole
   * flow that can include a Get with no time limit. VS Code resolves
   * activation only when activate()'s own promise settles, so every palette
   * command of this extension did nothing until the sticky notification was
   * answered. This drives that exact shape: a `showErrorMessage` that never
   * resolves, on a folder that reaches the "not mapped" branch (the case
   * that offers Set Up Workspace at all).
   */
  afterEach(() => {
    workspace.workspaceFolders = undefined;
    delete configValues['teamExplorer.wrapperPath'];
    vi.restoreAllMocks();
  });

  function fakeExtensionContext() {
    const state = new Map<string, unknown>();
    return {
      subscriptions: [] as { dispose(): void }[],
      workspaceState: {
        get: (k: string, d?: unknown) => (state.has(k) ? state.get(k) : d),
        update: async (k: string, v: unknown) => {
          if (v === undefined) state.delete(k);
          else state.set(k, v);
        },
      },
      secrets: { get: async () => undefined, store: async () => {}, delete: async () => {} },
    };
  }

  it('says nothing at all in a folder that is not mapped: no notification, only the log (user, 2026-09-23)', async () => {
    // The user opens git folders and folders under no source control at all
    // in the same VS Code. A popup on every one of them is noise: Manage
    // Workspace from the palette is how a folder gets mapped when they want
    // it.
    workspace.workspaceFolders = [folderAt(UNMAPPED)];
    configValues['teamExplorer.wrapperPath'] = join(tmpdir(), 'tfvc-lifecycle-no-such-wrapper');
    const runSpy = stubTfRun({});
    const errorSpy = vi.spyOn(window, 'showErrorMessage').mockImplementation(() => new Promise(() => {}));
    const warnSpy = vi.spyOn(window, 'showWarningMessage').mockImplementation(() => new Promise(() => {}));
    const infoSpy = vi.spyOn(window, 'showInformationMessage').mockImplementation(() => new Promise(() => {}));

    const context = fakeExtensionContext();
    try {
      await activate(context as never);
      await new Promise((r) => setTimeout(r, 0));

      expect(errorSpy, 'an unmapped folder must not pop up anything').not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
      expect(infoSpy).not.toHaveBeenCalled();
      // Still reachable on purpose, and still logged.
      expect(recorder.commands.has('teamExplorer.manageWorkspace')).toBe(true);
      expect(outputChannel.lines.join('\n')).toContain(S.noWorkspaceMapping);
    } finally {
      runSpy.mockRestore();
      for (const d of context.subscriptions) d.dispose();
    }
  });

  it('resolves even when the recovery notification never answers, having registered Manage Workspace', async () => {
    // A PAT error, which is the failure that still shows a notification: an
    // unmapped folder now says nothing at all (the test above).
    workspace.workspaceFolders = [folderAt(MAPPED)];
    configValues['teamExplorer.wrapperPath'] = join(tmpdir(), 'tfvc-lifecycle-no-such-wrapper');
    const runSpy = stubTfRun({
      workspacesByCall: () => ({
        stdout: Buffer.alloc(0),
        stderr: Buffer.from('TF30063: You are not authorized to access...', 'utf8'),
        exitCode: 1,
        timedOut: false,
      }),
    });
    // Never resolves -- the whole point of this test.
    const shownSpy = vi.spyOn(window, 'showErrorMessage').mockImplementation(() => new Promise(() => {}));

    const context = fakeExtensionContext();
    try {
      const settledInTime = await Promise.race([
        activate(context as never).then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 300)),
      ]);
      expect(settledInTime, 'activate() waited on the recovery notification to be answered').toBe(true);

      expect(
        recorder.commands.has('teamExplorer.manageWorkspace'),
        'teamExplorer.manageWorkspace was not registered',
      ).toBe(true);

      expect(shownSpy).toHaveBeenCalledTimes(1);
      expect(shownSpy.mock.calls[0]?.slice(1)).toContain(S.setPat);
    } finally {
      runSpy.mockRestore();
      for (const d of context.subscriptions) d.dispose();
    }
  });

  it('a PAT error offers only Set PAT', async () => {
    workspace.workspaceFolders = [folderAt(MAPPED)];
    configValues['teamExplorer.wrapperPath'] = join(tmpdir(), 'tfvc-lifecycle-no-such-wrapper');
    const runSpy = stubTfRun({
      workspacesByCall: () => ({
        stdout: Buffer.alloc(0),
        stderr: Buffer.from('TF30063: You are not authorized to access...', 'utf8'),
        exitCode: 1,
        timedOut: false,
      }),
    });
    const shownSpy = vi.spyOn(window, 'showErrorMessage').mockImplementation(() => new Promise(() => {}));

    const context = fakeExtensionContext();
    try {
      await activate(context as never);
      // offerRecovery is detached (I1): a PAT error reads the saved token
      // first (`await storedPat(...)`), one more microtask than activate()
      // itself waits on, so this flushes it before checking the notification.
      await new Promise((r) => setTimeout(r, 0));

      expect(shownSpy).toHaveBeenCalledTimes(1);
      const actions = shownSpy.mock.calls[0]?.slice(1) ?? [];
      expect(actions).toEqual([S.setPat]);
    } finally {
      runSpy.mockRestore();
      for (const d of context.subscriptions) d.dispose();
    }
  });
});

describe('I2: Manage Workspace is registered even with no folder open (task 7-8 review)', () => {
  afterEach(() => {
    workspace.workspaceFolders = undefined;
  });

  function fakeExtensionContext() {
    const state = new Map<string, unknown>();
    return {
      subscriptions: [] as { dispose(): void }[],
      workspaceState: {
        get: (k: string, d?: unknown) => (state.has(k) ? state.get(k) : d),
        update: async (k: string, v: unknown) => {
          if (v === undefined) state.delete(k);
          else state.set(k, v);
        },
      },
      secrets: { get: async () => undefined, store: async () => {}, delete: async () => {} },
    };
  }

  it('registers teamExplorer.manageWorkspace, and still teamExplorer.setPat, with no workspace folder open', async () => {
    workspace.workspaceFolders = undefined;
    const context = fakeExtensionContext();

    await activate(context as never);

    expect(
      recorder.commands.has('teamExplorer.manageWorkspace'),
      'command not found: an empty window can never reach Manage Workspace, the way out of an unmapped folder',
    ).toBe(true);
    expect(recorder.commands.has('teamExplorer.setPat')).toBe(true);
    for (const d of context.subscriptions) d.dispose();
  });
});

describe('I1: the manageWorkspace command handler catches a throw (task 7-8 review)', () => {
  afterEach(() => {
    workspace.workspaceFolders = undefined;
    delete configValues['teamExplorer.wrapperPath'];
    vi.restoreAllMocks();
  });

  function fakeExtensionContext() {
    const state = new Map<string, unknown>();
    return {
      subscriptions: [] as { dispose(): void }[],
      workspaceState: {
        get: (k: string, d?: unknown) => (state.has(k) ? state.get(k) : d),
        update: async (k: string, v: unknown) => {
          if (v === undefined) state.delete(k);
          else state.set(k, v);
        },
      },
      secrets: { get: async () => undefined, store: async () => {}, delete: async () => {} },
    };
  }

  it('a throw inside manageWorkspace(...) is caught, logged and shown -- never an unhandled rejection', async () => {
    workspace.workspaceFolders = [folderAt(MAPPED)];
    configValues['teamExplorer.wrapperPath'] = join(tmpdir(), 'tfvc-lifecycle-no-such-wrapper');
    // A clean, successful activation first, so the only failure in play is
    // the one this test injects into the command itself.
    const runSpy = stubTfRun({});
    // manageWorkspace()'s very first line is `await d.service.list()` --
    // rejecting it simulates a throw from anywhere inside the flow (ensureDir
    // failing with EPERM, for one) without needing to touch workspace.ts.
    const listSpy = vi
      .spyOn(WorkspaceService.prototype, 'list')
      .mockRejectedValue(new Error('EPERM: could not list workspaces'));

    const context = fakeExtensionContext();
    try {
      await activate(context as never);
      outputChannel.clear();
      recorder.messages.length = 0;

      // Must not reject: an unhandled rejection here is exactly what VS Code
      // would report as its own, unrelated extension-host error.
      await recorder.invoke('teamExplorer.manageWorkspace');

      expect(
        outputChannel.lines.some((l) => l.includes('EPERM: could not list workspaces')),
        'the throw never reached the output channel',
      ).toBe(true);
      expect(
        recorder.messages.some(
          (m) => m.kind === 'error' && m.message.includes('EPERM: could not list workspaces'),
        ),
        'the throw never reached showErrorMessage',
      ).toBe(true);
    } finally {
      listSpy.mockRestore();
      runSpy.mockRestore();
      for (const d of context.subscriptions) d.dispose();
    }
  });
});

describe('I3: reinitialise() reports a failure instead of just disabling menus (task 7-8 review)', () => {
  /**
   * `reinitialise` is exported with its own dependency object precisely so
   * this can drive a REAL failure -- a real TfvcService, a fake tf -- without
   * scripting the whole Manage Workspace UI flow (list/pick/confirm) to reach
   * it. It also proves TfvcService.initialize() itself clears the
   * pending-change cache on failure: the SCM panel reads `pendingChanges`
   * (via ScmProvider.includedChanges), and this is the state a stale panel
   * would still be showing after Remove Mapping of the opened folder's own
   * mapping.
   */
  it('after a successful initialize(), a failing one disables menus, logs and shows the error, and clears the stale pending changes', async () => {
    const serverItem = '$/Vesta/A.vb';
    const toWineLocal = (p: string) => (ON_WINDOWS ? p : 'Z:' + p.replace(/\//g, '\\'));
    const localWine = toWineLocal(join(MAPPED, 'A.vb'));
    const statusXml = Buffer.from(
      '<Status><PendingSet><PendingChanges>' +
        `<PendingChange item="${serverItem}" local="${localWine}" chg="Edit" type="File" enc="1250" itemid="7" date=""/>` +
        '</PendingChanges></PendingSet></Status>',
      'utf8',
    );

    // The FIRST `workspaces` call succeeds (mapping MAPPED, via the real
    // fixture); the SECOND -- what reinitialise() re-runs -- fails with a
    // rejected PAT. Modelled on `stubTfRun`'s own `workspacesByCall`, but
    // against a plain fake client rather than the TfClient prototype: this
    // needs no wrapper path, no spy to restore, and no other test in the file
    // to share the prototype with.
    let workspacesCalls = 0;
    const client = {
      timeoutMs: 1000,
      run: async (args: string[]) => {
        if (args.includes('workspaces')) {
          workspacesCalls++;
          if (workspacesCalls === 1) {
            return { stdout: WORKSPACES_XML, stderr: Buffer.alloc(0), exitCode: 0, timedOut: false };
          }
          return {
            stdout: Buffer.alloc(0),
            stderr: Buffer.from('TF30063: You are not authorized to access...', 'utf8'),
            exitCode: 1,
            timedOut: false,
          };
        }
        if (args.includes('status')) {
          return { stdout: statusXml, stderr: Buffer.alloc(0), exitCode: 0, timedOut: false };
        }
        return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0, timedOut: false };
      },
    };

    const service = new TfvcService(
      client as never,
      folderAt(MAPPED) as never,
      'https://acme.visualstudio.com/',
      outputChannel as never,
    );

    const first = await service.initialize();
    expect(first, 'setup: the first initialize() must succeed').toBeUndefined();
    expect(service.pendingChanges, 'setup: the first status must carry a pending change').toHaveLength(1);

    outputChannel.clear();
    const startScanCalls: number[] = [];
    const realSetEnabled = (on: boolean) =>
      void commands.executeCommand('setContext', 'teamExplorer:enabled', on);

    await reinitialise({
      service,
      output: outputChannel as never,
      setEnabled: realSetEnabled,
      startScan: () => startScanCalls.push(1),
    });

    expect(
      executed.some((e) => e.id === 'setContext' && e.args[0] === 'teamExplorer:enabled' && e.args[1] === false),
      'menus were not disabled on the failure',
    ).toBe(true);
    expect(startScanCalls, 'a scan ran despite the failure').toHaveLength(0);
    expect(outputChannel.lines.some((l) => l.includes('TF30063')), 'the failure was not logged').toBe(true);
    expect(
      recorder.messages.some((m) => m.kind === 'error' && m.message.includes('TF30063')),
      'the failure was not shown to the user',
    ).toBe(true);
    expect(
      service.pendingChanges,
      "the SCM panel's pending-change source still held the stale change",
    ).toHaveLength(0);

    service.dispose();
  });
});

describe('Create Workspace makes its empty folder where the host can see it', () => {
  // The Flatpak VS Code on FEDORA has a PRIVATE /tmp: a file the host puts in
  // /tmp is not there inside the sandbox, and the reverse (checked 2026-09-22).
  // tf runs on the host through flatpak-spawn --host, so `vc workspace /new`
  // run in a folder under the sandbox's /tmp runs in a folder that does not
  // exist. The home folder is shared (filesystems=host).
  it('uses a folder under the home folder on Linux, never tmpdir()', () => {
    expect(newWorkspaceDirBase('linux', '/home/shax', '/tmp')).toBe(join('/home/shax', '.cache', 'vscode-tfvc'));
  });

  it('keeps the temp folder on Windows, where nothing is sandboxed', () => {
    expect(newWorkspaceDirBase('win32', 'C:\\Users\\user1', 'C:\\Temp')).toBe('C:\\Temp');
  });
});
