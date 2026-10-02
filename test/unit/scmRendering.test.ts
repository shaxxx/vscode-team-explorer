import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ScmProvider, MAX_RENDERED } from '../../src/ui/ScmProvider.js';
import { PathMapper } from '../../src/tf/PathMapper.js';
import type { Platform } from '../../src/tf/PathMapper.js';
import { compareVerdict } from '../../src/ui/compareTarget.js';
import { ScanResult } from '../../src/scan/ScanResult.js';
import { IgnoreMatcher } from '../../src/ignore/IgnoreMatcher.js';
import { scm, Uri, recorder, outputChannel, configValues, fireConfigChange, EventEmitter } from '../vscode-mock.js';
import type { PendingChange } from '../../src/tf/types.js';

/**
 * The platform the temp dir actually lives on -- these tests run a real
 * `statSync` against a real directory, so joining it with the other
 * platform's separator would make the directory check fail for the wrong
 * reason. Same reasoning as `unversionedScan.test.ts`'s own `NATIVE`.
 */
const NATIVE: Platform = process.platform === 'win32' ? 'win32' : 'linux';

const ENC_BINARY = -1;

/** Same root `provider()` maps the workspace folder to. */
const ROOT = 'C:\\work\\Vesta';

/**
 * A real `ScanResult` rooted at `ROOT`, so `unversionedPaths()` exercises the
 * actual root/relative-path arithmetic and ignore filtering rather than a
 * scripted stand-in -- the "an ignored file does not appear" test needs the
 * real filtering, not a fake that already excludes what we tell it to.
 *
 * Takes ABSOLUTE paths under `ROOT` for readability at call sites, and strips
 * the prefix to build the relative list the real constructor wants.
 */
function scanWith(absolutePaths: string[], ignore: IgnoreMatcher = new IgnoreMatcher([])): ScanResult {
  const prefix = ROOT.toLowerCase() + '\\';
  const relative = absolutePaths.map((p) => {
    if (!p.toLowerCase().startsWith(prefix)) {
      throw new Error(`scanWith: ${p} is not under ${ROOT}`);
    }
    // The constructor wants `/`-separated relative paths (its own doc
    // comment says so); IgnoreMatcher.matches() splits on `/` only, so a
    // backslash-separated relative path would come through as a single,
    // never-matching component.
    return p.slice(ROOT.length + 1).replace(/\\/g, '/');
  });
  // No exclusion matcher here: these tests are about the `ignore` layer
  // (the group filter and, via `ignore`, the panel), not about tf's own
  // `/exclude:` coverage, which `scanResult.test.ts` covers directly.
  return new ScanResult(ROOT, relative, { exclusion: new IgnoreMatcher([]), ignore }, 'win32');
}

function change(n: number, over: Partial<PendingChange> = {}): PendingChange {
  return {
    serverItem: `$/Vesta/File${n}.vb`,
    localPath: `C:\\work\\Vesta\\File${n}.vb`,
    itemType: 'File',
    changes: new Set(['Edit']),
    changeFlags: 2,
    encoding: 1250,
    version: 42,
    ...over,
  } as PendingChange;
}

function provider(
  changes: PendingChange[],
  excluded: unknown = [],
  scan: ScanResult = ScanResult.notRun(),
) {
  const mapper = new PathMapper(
    [{ serverItem: '$/Vesta', localPath: 'C:\\work\\Vesta' }],
    'win32',
  );
  const service = {
    pendingChanges: changes,
    pathMapper: mapper,
    onDidChange: () => ({ dispose() {} }),
    changeFor: (item: string) =>
      changes.find((c) => c.serverItem.toLowerCase() === item.toLowerCase()),
    changeForLocal: (local: string) =>
      changes.find((c) => c.localPath.toLowerCase() === local.toLowerCase()),
  };
  const store = new Map<string, unknown>([['teamExplorer.excluded', excluded]]);
  const state = {
    get: <T>(k: string, d: T) => (store.has(k) ? (store.get(k) as T) : d),
    update: async (k: string, v: unknown) => void store.set(k, v),
  };
  const p = new ScmProvider(
    service as never,
    { uri: Uri.file('C:\\work\\Vesta') } as never,
    state as never,
    outputChannel as never,
    () => scan,
    () => ({ dispose() {} }),
  );
  return { p, control: scm.last!, store };
}

beforeEach(() => {
  recorder.reset();
  outputChannel.clear();
  scm.last = undefined;
});

describe('SCM rendering with a very large pending set (risk R2)', () => {
  // The DEVPC workspace really held 79,929 pending changes before the R6
  // cleanup, and onEdit auto-checkout is how it got there. This is the
  // measured scenario, not a hypothetical one.
  const many = Array.from({ length: 80_000 }, (_, i) => change(i));

  it('caps what it hands to VS Code', () => {
    const { control } = provider(many);

    expect(control.groups.get('included')!.resourceStates).toHaveLength(MAX_RENDERED);
  });

  it('reports the TRUE total in the badge, not the rendered count', () => {
    const { control } = provider(many);

    // The badge is how the user knows how much is pending. Showing 500 when
    // 80,000 are pending would be a lie that hides the problem.
    expect(control.count).toBe(80_000);
  });

  it('says so in the group label, so the list is not silently truncated', () => {
    const { control } = provider(many);

    expect(control.groups.get('included')!.label).toBe(
      `Included Changes (showing ${MAX_RENDERED} of 80000)`,
    );
  });

  it('check-in still sees every included item, not just the rendered ones', () => {
    const { p } = provider(many);

    // If the cap leaked into this, Check In would silently check in 500 of
    // 80,000 while the dialog said otherwise.
    expect(p.includedChanges).toHaveLength(80_000);
  });

  it('leaves a normal-sized list alone, label included', () => {
    const { p, control } = provider([change(1), change(2), change(3)]);

    expect(control.groups.get('included')!.resourceStates).toHaveLength(3);
    expect(control.groups.get('included')!.label).toBe('Included Changes');
    expect(control.count).toBe(3);
    expect(p.includedChanges).toHaveLength(3);
  });

  it('counts excluded items out of the badge but still renders them capped', () => {
    const excluded = many.slice(0, 1000).map((c) => c.serverItem);
    const { control } = provider(many, excluded);

    expect(control.count).toBe(79_000);
    expect(control.groups.get('excluded')!.resourceStates).toHaveLength(MAX_RENDERED);
    expect(control.groups.get('excluded')!.label).toBe(
      `Excluded Changes (showing ${MAX_RENDERED} of 1000)`,
    );
  });
});

describe('Compare with Latest Version', () => {
  it('works on a file with NO pending change', () => {
    // The old implementation reused the quick-diff provider, which returns
    // undefined here — so the command did nothing at all, with no message, for
    // every unmodified file. `view /version:T` works for any versioned item.
    expect(compareVerdict(true, undefined)).toBe('ok');
  });

  it('refuses a pending Add, which has no server version', () => {
    expect(compareVerdict(true, change(1, { changes: new Set(['Add']), version: undefined }))).toBe('pendingAdd');
  });

  it('refuses a binary file', () => {
    expect(compareVerdict(true, change(1, { encoding: ENC_BINARY }))).toBe('binary');
  });

  it('reports an unmapped file rather than doing nothing', () => {
    expect(compareVerdict(false, undefined)).toBe('unmapped');
  });

  it('compares an ordinary pending edit', () => {
    expect(compareVerdict(true, change(1))).toBe('ok');
  });
});

describe('a corrupt saved exclusion list', () => {
  /**
   * `Memento.get` returns whatever is stored and does not check it against the
   * type argument. excludedSet asserted `string[]` and mapped straight over it,
   * and it is called from render(), which is called from the CONSTRUCTOR — so
   * a value of the wrong shape threw before activate() finished. No panel, no
   * commands, and nothing inside the extension able to clear the bad value.
   */
  const changes = [change(1), change(2)];

  it('does not throw when the stored value is not an array at all', () => {
    expect(() => provider(changes, 'not-an-array')).not.toThrow();
  });

  it('still renders the pending changes rather than coming up empty', () => {
    const { control } = provider(changes, { nonsense: true });
    expect(control.groups.get('included')!.resourceStates).toHaveLength(2);
  });

  it('drops only the entries that are unusable, and keeps the rest', () => {
    // Partial corruption must not throw away a valid exclusion, or a file the
    // user excluded silently returns to Included — and Check In takes what is
    // included.
    const { control } = provider(changes, ['$/Vesta/File1.vb', null, 42]);
    const included = control.groups.get('included')!.resourceStates;
    expect(included).toHaveLength(1);
    expect(control.groups.get('excluded')!.resourceStates).toHaveLength(1);
  });

  it('tells the user, because a lost exclusion changes what gets checked in', () => {
    provider(changes, 'not-an-array');
    const warnings = recorder.messages.filter((m) => m.kind === 'warning');
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain('excluded');
    expect(outputChannel.lines.join('\n')).toContain('unusable');
  });

  it('warns ONCE, not on every render', () => {
    // render() runs on every status refresh — roughly every focus change and
    // every checkout. A warning per render is a warning every few seconds.
    // Driven through the public getter rather than render(): both go through
    // excludedSet, which is where the once-only flag lives, and the getter is
    // reachable without reaching into the class.
    const { p } = provider(changes, 'not-an-array');
    void p.includedChanges;
    void p.includedChanges;
    expect(recorder.messages.filter((m) => m.kind === 'warning')).toHaveLength(1);
  });

  it('leaves the bad value alone instead of repairing it behind the user', () => {
    // Reading happens on every render. Repairing on read would destroy
    // whatever is stored before the user has been told anything.
    const { store } = provider(changes, 'not-an-array');
    expect(store.get('teamExplorer.excluded')).toBe('not-an-array');
  });

  it('a valid list is still honoured — the guard is not a blanket off switch', () => {
    const { control } = provider(changes, ['$/Vesta/File1.vb']);
    expect(control.groups.get('excluded')!.resourceStates).toHaveLength(1);
    expect(recorder.messages.filter((m) => m.kind === 'warning')).toHaveLength(0);
  });
});

describe('the "Not in source control" group', () => {
  // Every test here turns the group ON. It is off by default, and with it off
  // the untracked list is empty -- so the check-in badge test below would pass
  // trivially, proving nothing about whether untracked files are counted.
  beforeEach(() => {
    configValues['teamExplorer.showNotInSourceControl'] = true;
  });

  it('is created', () => {
    const { control } = provider([]);
    expect(control.groups.get('notInSourceControl')).toBeDefined();
  });

  it('is hidden when empty', () => {
    const { control } = provider([]);
    expect(control.groups.get('notInSourceControl')!.hideWhenEmpty).toBe(true);
    expect(control.groups.get('notInSourceControl')!.resourceStates).toHaveLength(0);
  });

  it('lists what the scan found', () => {
    const scan = scanWith([`${ROOT}\\new.vb`, `${ROOT}\\sub\\other.vb`]);
    const { control } = provider([], [], scan);

    const rows = control.groups.get('notInSourceControl')!.resourceStates;
    expect(rows).toHaveLength(2);
    expect(control.groups.get('notInSourceControl')!.label).toBe('Not in source control');
  });

  it('does not count untracked files in the check-in badge', () => {
    // The badge says how much Check In will take. An untracked file is not
    // pending and will not be taken, so counting it would misstate the one
    // number the check-in dialog is derived from.
    const { control } = provider([change(1)], [], scanWith([`${ROOT}\\new.vb`]));
    expect(control.count).toBe(1);
  });

  it('caps what it hands to VS Code, with the true total in the label', () => {
    const many = Array.from({ length: 600 }, (_, i) => `${ROOT}\\file${i}.vb`);
    const scan = scanWith(many);
    const { control } = provider([], [], scan);

    const group = control.groups.get('notInSourceControl')!;
    expect(group.resourceStates).toHaveLength(MAX_RENDERED);
    expect(group.label).toBe(`Not in source control (showing ${MAX_RENDERED} of 600)`);
  });

  it('does not show a file the ignore matcher catches', () => {
    const scan = scanWith(
      [`${ROOT}\\node_modules\\pkg\\index.js`, `${ROOT}\\keep.vb`],
      new IgnoreMatcher(['node_modules']),
    );
    const { control } = provider([], [], scan);

    const rows = control.groups.get('notInSourceControl')!.resourceStates as {
      resourceUri: { fsPath: string };
    }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].resourceUri.fsPath).toBe(`${ROOT}\\keep.vb`);
  });
});

describe('re-renders when the scan lands (Task 5 wiring: onDidChangeScan)', () => {
  it('shows a newly-landed scan result without waiting for a status refresh', () => {
    configValues['teamExplorer.showNotInSourceControl'] = true;
    let scan = ScanResult.notRun();
    const mapper = new PathMapper([{ serverItem: '$/Vesta', localPath: ROOT }], 'win32');
    const service = {
      pendingChanges: [] as PendingChange[],
      pathMapper: mapper,
      onDidChange: () => ({ dispose() {} }),
      changeFor: () => undefined,
      changeForLocal: () => undefined,
    };
    const store = new Map<string, unknown>([['teamExplorer.excluded', []]]);
    const state = {
      get: <T>(k: string, d: T) => (store.has(k) ? (store.get(k) as T) : d),
      update: async (k: string, v: unknown) => void store.set(k, v),
    };
    const scanChanged = new EventEmitter<void>();

    new ScmProvider(
      service as never,
      { uri: Uri.file(ROOT) } as never,
      state as never,
      outputChannel as never,
      () => scan,
      scanChanged.event,
    );
    const control = scm.last!;
    expect(control.groups.get('notInSourceControl')!.resourceStates).toHaveLength(0);

    // No status refresh happens here at all -- only `scan` changes and the
    // scan's own event fires. If ScmProvider were not subscribed to it, this
    // group would never update.
    scan = scanWith([`${ROOT}\\brand-new.vb`]);
    scanChanged.fire();

    expect(control.groups.get('notInSourceControl')!.resourceStates).toHaveLength(1);
  });
});

describe('teamExplorer.showNotInSourceControl', () => {
  // Visual Studio's Pending Changes shows no such section, and the user asked
  // for the panel to match it. The scan still runs; only the LIST is hidden.
  const found = () => scanWith([`${ROOT}\\NewForm.vb`]);

  it('is off by default: the scan found a file, and the group stays empty', () => {
    const { control } = provider([], [], found());
    expect(control.groups.get('notInSourceControl')!.resourceStates).toHaveLength(0);
  });

  it('lists what the scan found once it is turned on', () => {
    configValues['teamExplorer.showNotInSourceControl'] = true;
    const { control } = provider([], [], found());
    expect(control.groups.get('notInSourceControl')!.resourceStates).toHaveLength(1);
  });

  it('takes effect immediately when toggled, with no status refresh', () => {
    const { control } = provider([], [], found());
    const group = control.groups.get('notInSourceControl')!;
    expect(group.resourceStates).toHaveLength(0);

    configValues['teamExplorer.showNotInSourceControl'] = true;
    fireConfigChange('teamExplorer.showNotInSourceControl');
    expect(group.resourceStates).toHaveLength(1);

    configValues['teamExplorer.showNotInSourceControl'] = false;
    fireConfigChange('teamExplorer.showNotInSourceControl');
    expect(group.resourceStates).toHaveLength(0);
  });
});

describe('a file that already has a pending change', () => {
  beforeEach(() => {
    configValues['teamExplorer.showNotInSourceControl'] = true;
  });

  it('is not listed as not in source control, whatever the scan said', () => {
    // Acceptance item 31: after Add, the status refresh lands before the next
    // scan, so the scan still lists the file. It must not sit in both groups.
    const pending = change(7);
    const { control } = provider([pending], [], scanWith([pending.localPath]));
    expect(control.groups.get('notInSourceControl')!.resourceStates).toHaveLength(0);
    expect(control.groups.get('included')!.resourceStates).toHaveLength(1);
  });
});

/**
 * Task 6 (U5): an untracked row has no pending change at all, so Undo,
 * Checkout and Compare with Latest never applied to it -- package.json's
 * gating for those three commands is covered separately in
 * decorationContributions.test.ts. What lives here is the part only the
 * resource state itself can prove: `contextValue` (plan 3's Add button keys
 * on it) and which command a row gets, which depends on a REAL directory
 * check (`statSync(...).isDirectory()`), not on anything the scan already
 * knows -- `unversionedPaths()` returns bare paths, file or folder alike.
 */
describe('untracked rows carry only the actions that apply (Task 6, U5)', () => {
  beforeEach(() => {
    configValues['teamExplorer.showNotInSourceControl'] = true;
  });

  function untrackedProvider(scan: ScanResult) {
    const service = {
      pendingChanges: [] as PendingChange[],
      pathMapper: undefined,
      onDidChange: () => ({ dispose() {} }),
      changeFor: () => undefined,
      changeForLocal: () => undefined,
    };
    const state = { get: <T>(_k: string, d: T) => d, update: async () => {} };
    new ScmProvider(
      service as never,
      { uri: Uri.file(tmpdir()) } as never,
      state as never,
      outputChannel as never,
      () => scan,
      () => ({ dispose() {} }),
    );
    return scm.last!;
  }

  it('gives a directory row revealInExplorer, a file row vscode.open, and both contextValue "untracked"', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tfvc-untracked-'));
    try {
      const subDir = join(dir, 'newFolder');
      mkdirSync(subDir);
      const filePath = join(dir, 'newFile.txt');
      writeFileSync(filePath, '');

      const scan = new ScanResult(
        dir,
        ['newFolder', 'newFile.txt'],
        { exclusion: new IgnoreMatcher([]), ignore: new IgnoreMatcher([]) },
        NATIVE,
      );
      const control = untrackedProvider(scan);

      const rows = control.groups.get('notInSourceControl')!.resourceStates as {
        resourceUri: { fsPath: string };
        contextValue?: string;
        command: { command: string; arguments: unknown[] };
      }[];
      expect(rows).toHaveLength(2);

      const dirRow = rows.find((r) => r.resourceUri.fsPath === subDir);
      const fileRow = rows.find((r) => r.resourceUri.fsPath === filePath);
      expect(dirRow, 'directory row missing').toBeDefined();
      expect(fileRow, 'file row missing').toBeDefined();

      expect(dirRow!.command.command).toBe('revealInExplorer');
      expect((dirRow!.command.arguments[0] as { fsPath: string }).fsPath).toBe(subDir);
      expect(fileRow!.command.command).toBe('vscode.open');
      expect((fileRow!.command.arguments[0] as { fsPath: string }).fsPath).toBe(filePath);

      expect(dirRow!.contextValue).toBe('untracked');
      expect(fileRow!.contextValue).toBe('untracked');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('treats a path statSync cannot read (deleted before render) as a file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tfvc-untracked-'));
    try {
      const missingPath = join(dir, 'gone.txt');
      // Never created on disk -- statSync throws ENOENT for it, and the
      // requirement is explicit: failure means "treat as a file".
      const scan = new ScanResult(
        dir,
        ['gone.txt'],
        { exclusion: new IgnoreMatcher([]), ignore: new IgnoreMatcher([]) },
        NATIVE,
      );
      const control = untrackedProvider(scan);
      const rows = control.groups.get('notInSourceControl')!.resourceStates as {
        resourceUri: { fsPath: string };
        command: { command: string };
      }[];
      expect(rows).toHaveLength(1);
      expect(rows[0].resourceUri.fsPath).toBe(missingPath);
      expect(rows[0].command.command).toBe('vscode.open');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('pending rows carry their state as contextValue (plan 3)', () => {
  it('names each row by the state its flags resolve to', () => {
    const { control } = provider([
      change(1, { changes: new Set(['Edit']) }),
      change(2, { changes: new Set(['Add', 'Edit', 'Encoding']) }),
      change(3, { changes: new Set(['Delete']) }),
      change(4, { changes: new Set(['Rename']) }),
    ]);
    const rows = control.groups.get('included')!.resourceStates as { contextValue?: string }[];
    expect(rows.map((r) => r.contextValue)).toEqual([
      'checkedOut',
      'pendingAdd',
      'pendingDelete',
      'pendingRename',
    ]);
  });

  it('an excluded row carries its state too', () => {
    const { control } = provider([change(1)], ['$/vesta/file1.vb']);
    const rows = control.groups.get('excluded')!.resourceStates as { contextValue?: string }[];
    expect(rows.map((r) => r.contextValue)).toEqual(['checkedOut']);
  });
});

describe('clicking a pending row', () => {
  type Row = { command: { command: string; arguments: { fsPath: string }[] } };

  it('opens a pending Add, which has no server version to compare with', () => {
    // Compare only answered "NewModule.vb is a pending Add ... nothing to
    // compare with", so a click on a new file did nothing useful.
    const { control } = provider([change(1, { changes: new Set(['Add', 'Edit', 'Encoding']), version: undefined })]);
    const [row] = control.groups.get('included')!.resourceStates as unknown as Row[];
    expect(row.command.command).toBe('vscode.open');
    expect(row.command.arguments[0].fsPath).toBe('C:\\work\\Vesta\\File1.vb');
  });

  it('still compares an edit', () => {
    const { control } = provider([change(1)]);
    const [row] = control.groups.get('included')!.resourceStates as unknown as Row[];
    expect(row.command.command).toBe('teamExplorer.compareWithLatest');
  });
});
