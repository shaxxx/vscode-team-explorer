import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DecorationProvider } from '../../src/ui/DecorationProvider.js';
import { ScmProvider } from '../../src/ui/ScmProvider.js';
import { TFVC_SCHEME } from '../../src/ui/ServerContentProvider.js';
import { PathMapper } from '../../src/tf/PathMapper.js';
import { IgnoreMatcher } from '../../src/ignore/IgnoreMatcher.js';
import { ScanResult } from '../../src/scan/ScanResult.js';
import {
  Uri,
  configValues,
  hooks,
  fireConfigChange,
  EventEmitter,
  decorationProviders,
  createdEmitters,
  outputChannel,
} from '../vscode-mock.js';
import type { ChangeFlag, PendingChange } from '../../src/tf/types.js';
import type { ScanVerdict } from '../../src/state/FileState.js';

/**
 * Real files on disk, because the read-only bit IS the input under test: in a
 * server workspace a versioned file is read-only unless it is checked out, and
 * that is the whole reason this ships before the unversioned scan.
 */
const dir = mkdtempSync(join(tmpdir(), 'tfvc-dec-'));

const ON_WINDOWS = process.platform === 'win32';
const PLATFORM = ON_WINDOWS ? 'win32' : 'linux';

/** A working folder's localPath is in tf.exe's terms: a Z: path under Wine. */
const toWine = (p: string) => (ON_WINDOWS ? p : 'Z:' + p.replace(/\//g, '\\'));

/** Directories created outside `dir`, for the "outside the mapping" case. */
const outsideDirs: string[] = [];

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const d of outsideDirs) rmSync(d, { recursive: true, force: true });
});

function file(name: string, readOnly: boolean): string {
  const path = join(dir, name);
  writeFileSync(path, 'x');
  chmodSync(path, readOnly ? 0o444 : 0o644);
  return path;
}

function folder(name: string): string {
  const path = join(dir, name);
  mkdirSync(path, { recursive: true });
  return path;
}

function change(
  localPath: string,
  flags: ChangeFlag[],
  itemType: 'File' | 'Folder' = 'File',
): PendingChange {
  return {
    serverItem: '$/Vesta/' + localPath.split(/[\\/]/).pop(),
    localPath,
    itemType,
    changes: new Set(flags),
    changeFlags: 0,
    encoding: 1250,
    itemId: 7,
    date: '',
  };
}

/** A `vscode.Event<void>` double that never fires -- the default for tests
 * that do not care about exclusion refreshing. */
const neverFires = () => ({ dispose() {} });

/**
 * Defaults its two plan-2 arguments to an empty ignore list and a scan that
 * has never run, so the 23 tests written against plan 1 keep asserting the
 * same behaviour unchanged: nothing is ignored, and `ScanResult.notRun()`
 * answers `notScanned` for every path, which resolves to `unknown` either
 * way. Defaults its two Task 7 arguments to "nothing is excluded, and it
 * never changes", for the same reason.
 */
function provider(
  changes: PendingChange[],
  ignorePatterns: string[] = [],
  scan: ScanResult = ScanResult.notRun(),
  isExcluded: (path: string) => boolean = () => false,
  onDidChangeExcluded: (listener: () => void) => { dispose(): void } = neverFires,
) {
  const service = {
    pathMapper: new PathMapper([{ serverItem: '$/Vesta', localPath: toWine(dir) }], PLATFORM),
    onDidChange: () => ({ dispose() {} }),
    changeForLocal: (p: string) => changes.find((c) => c.localPath === p),
  };
  return new DecorationProvider(
    service as never,
    () => new IgnoreMatcher(ignorePatterns),
    () => scan,
    dir,
    isExcluded,
    onDidChangeExcluded as never,
    neverFires,
  );
}

function providerWithScan(changes: PendingChange[], scan: ScanResult) {
  return provider(changes, [], scan);
}

function providerWithIgnore(changes: PendingChange[], ignorePatterns: string[]) {
  return provider(changes, ignorePatterns);
}

/**
 * A scan double that answers `verdict` for ANY path, regardless of `dir` or
 * filename -- these tests are pinning `DecorationProvider`'s wiring to
 * `ScanResult.verdictFor()`, not `ScanResult`'s own path arithmetic, which
 * `scanResult.test.ts` already covers in full. Cast the same way every other
 * fake service in this file is: a real `ScanResult` demands a root, listed
 * paths, an exclusion matcher, an `Ignorer` and a platform that are
 * irrelevant here.
 */
function scanSaying(verdict: ScanVerdict): ScanResult {
  return { verdictFor: () => verdict } as never;
}

beforeEach(() => {
  // Clears `hooks.didChangeConfiguration` along with everything else, so a
  // provider's config-change listener from an earlier test cannot fire again
  // here.
  hooks.reset();
  configValues['teamExplorer.decorations'] = true;
});

describe('what the tree draws', () => {
  it('locks a read-only file with nothing pending', () => {
    const path = file('versioned.vb', true);
    const d = provider([]).provideFileDecoration(Uri.file(path) as never);
    expect(d?.badge).toBe('\u{1F512}');
    expect(d?.propagate).toBe(false);
  });

  it('checks a file that is checked out', () => {
    const path = file('edited.vb', false);
    const d = provider([change(path, ['Edit'])]).provideFileDecoration(Uri.file(path) as never);
    expect(d?.badge).toBe('✓');
    expect(d?.propagate).toBe(true);
  });

  it('pluses a pending add', () => {
    const path = file('added.vb', false);
    const d = provider([change(path, ['Add'])]).provideFileDecoration(Uri.file(path) as never);
    expect(d?.badge).toBe('+');
  });

  it('arrows a pending rename', () => {
    const path = file('renamed.vb', false);
    const d = provider([change(path, ['Rename'])]).provideFileDecoration(Uri.file(path) as never);
    expect(d?.badge).toBe('→');
  });

  it('still draws a pending DELETE, whose file is gone from disk', () => {
    // `tf delete` removes the local file. An implementation that stats first
    // and bails when the stat fails would draw nothing here -- discarding the
    // one state most worth showing, and the pending set is the only source
    // that still knows about it.
    const gone = join(dir, 'never-existed.vb');
    const d = provider([change(gone, ['Delete'])]).provideFileDecoration(Uri.file(gone) as never);
    expect(d?.badge).toBe('−');
  });

  it('draws nothing on a folder with nothing pending', () => {
    // TFVC does not check folders out, so a folder's read-only bit says
    // nothing. Read-only here specifically, so the itemType guard is what
    // makes the difference: a WRITABLE folder draws nothing either way
    // (falling through to `unknown`, since `scan` is hardcoded to
    // `notScanned`), but a read-only one without the guard would read as
    // `versioned` and wear a lock.
    const path = folder('plain-folder');
    chmodSync(path, 0o555);
    expect(provider([]).provideFileDecoration(Uri.file(path) as never)).toBeUndefined();
  });

  it('still draws a folder that IS pending', () => {
    // Folders are pending changes too; the folder guard sits after the pending
    // check precisely so it cannot swallow them.
    const path = folder('added-folder');
    const d = provider([change(path, ['Add'], 'Folder')]).provideFileDecoration(
      Uri.file(path) as never,
    );
    expect(d?.badge).toBe('+');
  });

  it('draws nothing for a writable file the scan has not answered for', () => {
    // Plan 2 turns this into either nothing (new) or `!` (the hazard). Until
    // then it must draw NOTHING rather than guess.
    const path = file('mystery.vb', false);
    expect(provider([]).provideFileDecoration(Uri.file(path) as never)).toBeUndefined();
  });

  it('draws nothing for a path that is simply gone', () => {
    const gone = join(dir, 'never-created.vb');
    expect(provider([]).provideFileDecoration(Uri.file(gone) as never)).toBeUndefined();
  });

  it('draws nothing before the workspace mapping is known', () => {
    // From activation until `tf vc workspaces` returns, and permanently after
    // an auth failure or a failed re-initialize, `pathMapper` is undefined.
    // Every other fake here hands over a live mapper, so this state was never
    // reached -- and treating a missing mapper as MAPPED survived every test.
    const service = {
      pathMapper: undefined,
      onDidChange: () => ({ dispose() {} }),
      changeForLocal: () => undefined,
    };
    const p = new DecorationProvider(
      service as never,
      () => new IgnoreMatcher([]),
      () => ScanResult.notRun(),
      dir,
      () => false,
      neverFires,
      neverFires,
    );
    const path = file('no-mapper.vb', true);
    expect(p.provideFileDecoration(Uri.file(path) as never)).toBeUndefined();
  });

  it('draws nothing outside the workspace mapping', () => {
    // Must be a REAL read-only file outside the mapped root. With a
    // non-existent path this returned at the `!facts` guard and never
    // evaluated `mapped` at all.
    const outsideDir = mkdtempSync(join(tmpdir(), 'tfvc-outside-'));
    outsideDirs.push(outsideDir);
    const outside = join(outsideDir, 'elsewhere.vb');
    writeFileSync(outside, 'x');
    chmodSync(outside, 0o444);
    expect(provider([]).provideFileDecoration(Uri.file(outside) as never)).toBeUndefined();
  });

  it('ignores non-file schemes', () => {
    // TFVC_SCHEME belongs to ServerContentProvider; decorating it would put a
    // lock on the left-hand pane of every diff. The path must EXIST and be
    // read-only, or this passes because the stat failed rather than because
    // the guard fired -- which is how it passed before.
    const path = file('in-a-diff.vb', true);
    const d = provider([]).provideFileDecoration({ scheme: TFVC_SCHEME, fsPath: path } as never);
    expect(d).toBeUndefined();
  });

  it('gives the lock a tooltip and a colour, not just a badge', () => {
    // The mock throws on a decoration with no colour, badge or tooltip, the
    // same as the real host. This pins that all three are populated.
    const path = file('tooltipped.vb', true);
    const d = provider([]).provideFileDecoration(Uri.file(path) as never);
    expect(d?.tooltip).toBe('Under source control');
    expect(d?.color?.id).toBe('teamExplorer.versionedForeground');
  });
});

describe('the off switch', () => {
  it('is on when nobody has set it', () => {
    // Every other test sets the value explicitly, so the default itself was
    // never exercised: flipping it to `false` survived all 412 tests. Until
    // Task 6 contributes the setting to package.json, this literal is the
    // only default in the system. `delete` happens AFTER the top-level
    // `beforeEach` has already set the key, so this genuinely runs with it
    // absent rather than being overwritten back to `true`.
    delete configValues['teamExplorer.decorations'];
    const path = file('default-on.vb', true);
    expect(provider([]).provideFileDecoration(Uri.file(path) as never)?.badge).toBe('\u{1F512}');
  });

  it('draws nothing at all when decorations are disabled', () => {
    configValues['teamExplorer.decorations'] = false;
    const path = file('off.vb', true);
    expect(provider([]).provideFileDecoration(Uri.file(path) as never)).toBeUndefined();
  });

  it('reacts to the setting changing, with no reload', () => {
    // Acceptance item 25. Before this, the mock discarded the handler and the
    // whole branch -- the affectsConfiguration string, the re-read and the
    // refire -- had never executed. Subscribing before flipping the setting
    // pins the refire itself: `readConfig()` alone can make `provideFileDecoration`
    // change its answer, so asserting only that would pass even if VS Code was
    // never told to re-query and every badge stayed on screen until reload.
    const path = file('live.vb', true);
    const p = provider([]);
    expect(p.provideFileDecoration(Uri.file(path) as never)?.badge).toBe('\u{1F512}');

    const seen: unknown[] = [];
    p.onDidChangeFileDecorations((e) => seen.push(e));

    configValues['teamExplorer.decorations'] = false;
    fireConfigChange('teamExplorer.decorations');

    expect(seen).toEqual([undefined]);
    expect(p.provideFileDecoration(Uri.file(path) as never)).toBeUndefined();
  });

  it("also fires undefined on a teamExplorer.ignore change, so the tree re-queries `ignored` rows", () => {
    // The `ignored` flag is read fresh from `this.ignore()` on every call
    // (see `pending` in `provideFileDecoration`), so this needs no
    // `readConfig()` -- only the same re-fire every other trigger gets.
    const path = file('ignore-change.vb', true);
    const p = provider([]);
    const seen: unknown[] = [];
    p.onDidChangeFileDecorations((e) => seen.push(e));

    fireConfigChange('teamExplorer.ignore');

    expect(seen).toEqual([undefined]);
  });

  it("ignores a change to someone else's setting", () => {
    // Two different kinds of "someone else": another extension's section
    // entirely, and a SIBLING of ours under `teamExplorer` that is not
    // `decorations`. Broadening the guard from `affectsConfiguration(
    // 'teamExplorer.decorations')` to `affectsConfiguration('teamExplorer')`
    // would still ignore `editor.fontSize`, so that case alone does not pin
    // the string's specificity -- `teamExplorer.autoCheckout` does.
    const path = file('unrelated.vb', true);
    const p = provider([]);

    configValues['teamExplorer.decorations'] = false;
    fireConfigChange('editor.fontSize');
    fireConfigChange('teamExplorer.autoCheckout');

    // The guard means we have NOT re-read, so the old value still applies.
    expect(p.provideFileDecoration(Uri.file(path) as never)?.badge).toBe('\u{1F512}');
  });
});

describe('staying in step with the service', () => {
  function live() {
    const changed = new EventEmitter<void>();
    const service = {
      pathMapper: new PathMapper([{ serverItem: '$/Vesta', localPath: toWine(dir) }], PLATFORM),
      onDidChange: changed.event,
      changeForLocal: () => undefined,
    };
    // Captured immediately before construction, so `ownEmitter` names exactly
    // the emitter the constructor builds for `this.changed` -- NOT "the last
    // one in `createdEmitters`", which would silently point at the wrong
    // object the day anything else in the constructor builds an emitter too.
    const beforeEmitters = createdEmitters.length;
    const p = new DecorationProvider(
      service as never,
      () => new IgnoreMatcher([]),
      () => ScanResult.notRun(),
      dir,
      () => false,
      neverFires,
      neverFires,
    );
    const ownEmitter = createdEmitters[beforeEmitters];
    const seen: unknown[] = [];
    p.onDidChangeFileDecorations((e) => seen.push(e));
    return { p, seen, fireStatus: () => changed.fire(), ownEmitter };
  }

  it('re-queries every row when a status lands', () => {
    // Fires with `undefined`, meaning "all URIs" -- VS Code then re-asks only
    // about the rows it is drawing. Without this the tree would show whatever
    // it showed at first paint, forever, which is the failure this whole task
    // exists to avoid.
    const { seen, fireStatus } = live();
    fireStatus();
    expect(seen).toEqual([undefined]);
  });

  it('goes quiet once disposed', () => {
    const { p, seen, fireStatus } = live();
    p.dispose();
    fireStatus();
    expect(seen).toEqual([]);
  });

  it('stops being asked for decorations once disposed', () => {
    // The leak that matters in a real host: VS Code keeps calling a provider
    // it was never told to forget. `decorationProviders` is the double's
    // record of who is registered.
    const before = decorationProviders.length;
    const { p } = live();
    expect(decorationProviders).toHaveLength(before + 1);
    p.dispose();
    expect(decorationProviders).toHaveLength(before);
  });

  it('unsubscribes from the configuration when disposed', () => {
    // `goes quiet once disposed` cannot see this on its own: disposing
    // `this.changed` (or the service subscription) is equally enough to
    // silence `seen`. This checks the config listener's own removal directly.
    const before = hooks.didChangeConfiguration.count;
    const { p } = live();
    expect(hooks.didChangeConfiguration.count).toBe(before + 1);
    p.dispose();
    expect(hooks.didChangeConfiguration.count).toBe(before);
  });

  it('unsubscribes from the service when disposed', () => {
    // Same reasoning as the configuration case, for the other upstream
    // subscription. The double reports its own disposal directly, since
    // nothing else in the mock exposes a count for it the way `hooks` does.
    let subDisposed = false;
    const service = {
      pathMapper: new PathMapper([{ serverItem: '$/Vesta', localPath: toWine(dir) }], PLATFORM),
      onDidChange: (_h: () => void) => ({
        dispose: () => {
          subDisposed = true;
        },
      }),
      changeForLocal: () => undefined,
    };
    const p = new DecorationProvider(
      service as never,
      () => new IgnoreMatcher([]),
      () => ScanResult.notRun(),
      dir,
      () => false,
      neverFires,
      neverFires,
    );
    p.dispose();
    expect(subDisposed).toBe(true);
  });

  it('disposes its own emitter when disposed', () => {
    // Previously accepted as unobservable: `EventEmitter.dispose()` was a
    // no-op wired to nothing a test could see. It now records its own
    // disposal, and `ownEmitter` (see `live()`) names the exact instance
    // `this.changed` is -- not a guess based on array position after the fact.
    const { p, ownEmitter } = live();
    expect(ownEmitter.disposed).toBe(false);
    p.dispose();
    expect(ownEmitter.disposed).toBe(true);
  });
});

describe('states that needed the scan', () => {
  it('draws the hazard on a writable file the scan says IS in source control', () => {
    // Edited without being checked out. TFVC cannot see the change, and Check
    // In will not take it. Unreachable until plan 2 -- this is the first test
    // that can produce it.
    const path = file('edited-behind-tfvcs-back.vb', false);
    const d = providerWithScan([], scanSaying('inSourceControl')).provideFileDecoration(
      Uri.file(path) as never,
    );
    expect(d?.badge).toBe('!');
    expect(d?.propagate).toBe(true);
  });

  it('draws nothing for a file the scan says is NOT in source control', () => {
    // Absence is the signal: a new file has no badge because everything else
    // has one. It appears in the panel's third group instead.
    //
    // `toBeUndefined()` on its own does NOT prove the scan was consulted:
    // `notVersioned` and `unknown` are BOTH `null` in `GLYPHS`
    // (src/ui/decorations.ts, lines 111 and 115), so this assertion would
    // pass identically if `provideFileDecoration` never called
    // `scan().verdictFor()` at all and fell through to `unknown` instead. The
    // `calls` array below is what actually pins the wiring: verified this
    // session that this test fails (`calls` stays `[]`) when `DecorationProvider`
    // is edited to hardcode the pending set's `scan` field to `'notScanned'`
    // instead of calling `this.scan().verdictFor(uri.fsPath)`.
    const path = file('brand-new.vb', false);
    const calls: string[] = [];
    const scan = {
      verdictFor: (p: string) => {
        calls.push(p);
        return 'notInSourceControl' as ScanVerdict;
      },
    } as never;
    expect(
      providerWithScan([], scan).provideFileDecoration(Uri.file(path) as never),
    ).toBeUndefined();
    expect(calls).toEqual([path]);
  });

  it('draws nothing for an ignored path even when it looks pending', () => {
    // The resolver checks `ignored` BEFORE the pending change, so a pending
    // file inside node_modules draws nothing. That is a real consequence and
    // it was written down in plan 1 rather than discovered here.
    const path = file('ignored-but-pending.vb', false);
    const d = providerWithIgnore([change(path, ['Edit'])], ['ignored-but-pending.vb'])
      .provideFileDecoration(Uri.file(path) as never);
    expect(d).toBeUndefined();
  });

  it('still draws nothing when the scan has not run', () => {
    // The plan 1 behaviour must survive: notScanned resolves to `unknown`.
    const path = file('not-scanned-yet.vb', false);
    expect(
      providerWithScan([], ScanResult.notRun()).provideFileDecoration(Uri.file(path) as never),
    ).toBeUndefined();
  });
});

describe('a file excluded from check-in (Task 7)', () => {
  it('keeps its badge and letter, and gains the dimmed colour and tooltip suffix', () => {
    const path = file('excluded.vb', false);
    const d = provider([change(path, ['Edit'])], [], ScanResult.notRun(), () => true)
      .provideFileDecoration(Uri.file(path) as never);
    expect(d?.badge).toBe('✓');
    expect(d?.propagate).toBe(true);
    expect(d?.color?.id).toBe('teamExplorer.excludedForeground');
    expect(d?.tooltip).toBe('Checked out for edit (excluded from check-in)');
  });

  it('leaves a non-excluded file with the same change completely unchanged', () => {
    const path = file('included.vb', false);
    const d = provider([change(path, ['Edit'])], [], ScanResult.notRun(), () => false)
      .provideFileDecoration(Uri.file(path) as never);
    expect(d?.badge).toBe('✓');
    expect(d?.color?.id).toBe('teamExplorer.checkedOutForeground');
    expect(d?.tooltip).toBe('Checked out for edit');
  });

  it('does not manufacture a decoration for a state that draws nothing', () => {
    // A writable file the scan has not answered for draws nothing at all
    // (see "what the tree draws" above). `isExcluded` must not turn that
    // absence into a decoration -- it only dims what GLYPHS already draws.
    const path = file('mystery-excluded.vb', false);
    expect(
      provider([], [], ScanResult.notRun(), () => true).provideFileDecoration(
        Uri.file(path) as never,
      ),
    ).toBeUndefined();
  });

  it('refreshes when the exclusion set changes, with no reload', () => {
    const path = file('live-excluded.vb', false);
    const excludedChanged = new EventEmitter<void>();
    let isExcluded = false;
    const p = provider(
      [change(path, ['Edit'])],
      [],
      ScanResult.notRun(),
      () => isExcluded,
      excludedChanged.event,
    );
    expect(p.provideFileDecoration(Uri.file(path) as never)?.color?.id).toBe(
      'teamExplorer.checkedOutForeground',
    );

    const seen: unknown[] = [];
    p.onDidChangeFileDecorations((e) => seen.push(e));

    isExcluded = true;
    excludedChanged.fire();

    expect(seen).toEqual([undefined]);
    expect(p.provideFileDecoration(Uri.file(path) as never)?.color?.id).toBe(
      'teamExplorer.excludedForeground',
    );
  });

  it('unsubscribes from onDidChangeExcluded when disposed', () => {
    const excludedChanged = new EventEmitter<void>();
    const p = provider([], [], ScanResult.notRun(), () => false, excludedChanged.event);
    const seen: unknown[] = [];
    p.onDidChangeFileDecorations((e) => seen.push(e));

    p.dispose();
    excludedChanged.fire();

    expect(seen).toEqual([]);
  });
});

/**
 * `ScmProvider` owns the exclusion set for real; the describe block above
 * fakes both `isExcluded` and `onDidChangeExcluded` to test only
 * `DecorationProvider`'s own wiring. This one goes one layer down and pins
 * the two things `ScmProvider` itself promises: `isExcludedPath` answering
 * from a LOCAL path with the same identity `includedChanges` uses, and
 * `setExcludedMany` firing the event exactly once per call, not once per
 * item -- the same one-write-one-render property `exclusionIdentity.test.ts`
 * already pins for the Memento write.
 */
describe('ScmProvider.isExcludedPath and onDidChangeExcluded (Task 7)', () => {
  function change(localPath: string, serverItem: string, itemId: number): PendingChange {
    return {
      serverItem,
      localPath,
      itemType: 'File',
      changes: new Set(['Edit']),
      changeFlags: 0,
      encoding: 1250,
      itemId,
      version: 42,
      date: '',
    } as PendingChange;
  }

  function scmWith(changes: PendingChange[]) {
    const mapper = new PathMapper([{ serverItem: '$/Vesta', localPath: toWine(dir) }], PLATFORM);
    const service = {
      pendingChanges: changes,
      pathMapper: mapper,
      onDidChange: () => ({ dispose() {} }),
      changeFor: (item: string) =>
        changes.find((c) => c.serverItem.toLowerCase() === item.toLowerCase()),
      changeForLocal: (p: string) => changes.find((c) => c.localPath === p),
    };
    const store = new Map<string, unknown>([['teamExplorer.excluded', []]]);
    const state = {
      get: <T>(k: string, d: T) => (store.has(k) ? (store.get(k) as T) : d),
      update: async (k: string, v: unknown) => void store.set(k, v),
    };
    return new ScmProvider(
      service as never,
      { uri: Uri.file(dir) } as never,
      state as never,
      outputChannel as never,
      () => ScanResult.notRun(),
      () => ({ dispose() {} }),
    );
  }

  it('answers false until the file is excluded, then true, by local path', async () => {
    const path = join(dir, 'exclusion-target.vb');
    const c = change(path, '$/Vesta/exclusion-target.vb', 321);
    const scm = scmWith([c]);

    expect(scm.isExcludedPath(path)).toBe(false);
    await scm.setExcluded(c.serverItem, true);
    expect(scm.isExcludedPath(path)).toBe(true);
    // Same identity as includedChanges -- cannot be excluded in one and
    // included in the other.
    expect(scm.includedChanges).toHaveLength(0);
  });

  it('answers false for a local path with no pending change at all', () => {
    const scm = scmWith([]);
    expect(scm.isExcludedPath(join(dir, 'never-pending.vb'))).toBe(false);
  });

  it('fires onDidChangeExcluded exactly once for a multi-item setExcludedMany', async () => {
    const many = Array.from({ length: 5 }, (_, i) =>
      change(join(dir, `many${i}.vb`), `$/Vesta/many${i}.vb`, 100 + i),
    );
    const scm = scmWith(many);
    let fireCount = 0;
    scm.onDidChangeExcluded(() => fireCount++);

    await scm.setExcludedMany(many.map((c) => c.serverItem), true);

    expect(fireCount).toBe(1);
  });

  it('does not fire onDidChangeExcluded for an empty selection', async () => {
    const scm = scmWith([]);
    let fireCount = 0;
    scm.onDidChangeExcluded(() => fireCount++);

    await scm.setExcludedMany([], true);

    expect(fireCount).toBe(0);
  });
});

describe('a read-only COPY of a checked-in file (acceptance item 27)', () => {
  it('draws no lock once the scan says it is not in source control', () => {
    // A Windows copy keeps the read-only attribute, so before the scan this
    // wore a lock claiming it was on the server. The scan's positive finding
    // now outranks the read-only bit -- see resolveFileState.
    const path = file('Form1 - Copy.vb', true);
    expect(
      providerWithScan([], scanSaying('notInSourceControl')).provideFileDecoration(
        Uri.file(path) as never,
      ),
    ).toBeUndefined();
  });

  it('still draws the lock on a read-only file the scan did not cover', () => {
    // bin, obj, node_modules: the scan never looked, so read-only is still
    // the best evidence available and the plan 1 behaviour stands.
    const path = file('Form1.vb', true);
    expect(
      providerWithScan([], scanSaying('notScanned')).provideFileDecoration(Uri.file(path) as never)
        ?.badge,
    ).toBe('\u{1F512}');
  });
});

describe('a file created after the scan (acceptance bug: new file showed !)', () => {
  const PLATFORM = process.platform === 'win32' ? 'win32' : 'linux';

  it('draws no hazard on a writable file created after the scan started', () => {
    const scan = new ScanResult(
      dir,
      [],
      { exclusion: new IgnoreMatcher([]), ignore: new IgnoreMatcher([]) },
      PLATFORM,
      Date.now() - 60_000,
    );
    const path = file('new_file.txt', false);
    expect(providerWithScan([], scan).provideFileDecoration(Uri.file(path) as never)).toBeUndefined();
  });

  it('still draws the hazard on a writable file that existed before the scan', () => {
    const path = file('edited.vb', false);
    const scan = new ScanResult(
      dir,
      [],
      { exclusion: new IgnoreMatcher([]), ignore: new IgnoreMatcher([]) },
      PLATFORM,
      Date.now() + 60_000,
    );
    expect(providerWithScan([], scan).provideFileDecoration(Uri.file(path) as never)?.badge).toBe('!');
  });
});

describe('stateOf: the answer the badge and the editor menu read (plan 3)', () => {
  it('answers the state the badge is drawn from', () => {
    const path = file('state-versioned.vb', true);
    const p = provider([]);
    expect(p.stateOf(path)).toBe('versioned');
    expect(p.provideFileDecoration(Uri.file(path) as never)?.badge).toBe('\u{1F512}');
  });

  it('still answers with teamExplorer.decorations off: hiding badges must not hide menus', () => {
    configValues['teamExplorer.decorations'] = false;
    const path = file('state-decorations-off.vb', true);
    const p = provider([]);
    expect(p.provideFileDecoration(Uri.file(path) as never)).toBeUndefined();
    expect(p.stateOf(path)).toBe('versioned');
  });

  it('answers from the pending set first', () => {
    const path = file('state-edited.vb', false);
    expect(provider([change(path, ['Edit'])]).stateOf(path)).toBe('checkedOut');
  });

  it('answers unmapped outside every mapping', () => {
    const outside = mkdtempSync(join(tmpdir(), 'tfvc-dec-outside-'));
    outsideDirs.push(outside);
    const path = join(outside, 'elsewhere.vb');
    writeFileSync(path, 'x');
    expect(provider([]).stateOf(path)).toBe('unmapped');
  });

  it('answers undefined for a path that vanished with nothing pending', () => {
    expect(provider([]).stateOf(join(dir, 'never-created.vb'))).toBeUndefined();
  });
});
