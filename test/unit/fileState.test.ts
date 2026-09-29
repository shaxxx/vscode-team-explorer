import { describe, it, expect } from 'vitest';
import { resolveFileState, pendingStateOf, type FileStateInput } from '../../src/state/FileState.js';
import type { ChangeFlag, PendingChange } from '../../src/tf/types.js';

function change(...flags: ChangeFlag[]): PendingChange {
  return {
    serverItem: '$/Vesta/File.vb',
    localPath: 'C:\\work\\Vesta\\File.vb',
    itemType: 'File',
    changes: new Set(flags),
    changeFlags: 0,
    encoding: 1250,
    itemId: 7,
    date: '',
  };
}

/** Defaults describe an ordinary versioned FILE with nothing pending. */
function input(over: Partial<FileStateInput> = {}): FileStateInput {
  return {
    change: undefined,
    itemType: 'File',
    readOnly: true,
    ignored: false,
    mapped: true,
    scan: 'notScanned',
    ...over,
  };
}

describe('the two short circuits, which are checked first', () => {
  it('reports an unmapped path as unmapped even when it looks pending', () => {
    // `unmapped` is FINAL and knowable; `unknown` is temporary. They render the
    // same but spec 5 gates menus on this union, where they differ.
    expect(resolveFileState(input({ mapped: false, change: change('Edit') }))).toBe('unmapped');
  });

  it('reports an ignored path as ignored even when it looks pending', () => {
    expect(resolveFileState(input({ ignored: true, change: change('Edit') }))).toBe('ignored');
  });

  it('checks mapped before ignored', () => {
    expect(resolveFileState(input({ mapped: false, ignored: true }))).toBe('unmapped');
  });
});

describe('pending changes decide the state', () => {
  // `chg` is a space-separated flag SET, not an enum. "Add Edit Encoding" is a
  // real captured value, so every case below is a set, not a single value.
  it('reads a plain edit as checked out', () => {
    expect(resolveFileState(input({ change: change('Edit'), readOnly: false }))).toBe('checkedOut');
  });

  it('reads Add Edit Encoding as a pending add, not an edit', () => {
    expect(resolveFileState(input({ change: change('Add', 'Edit', 'Encoding'), readOnly: false })))
      .toBe('pendingAdd');
  });

  it('lets Delete win over Edit', () => {
    expect(resolveFileState(input({ change: change('Delete', 'Edit'), readOnly: false })))
      .toBe('pendingDelete');
  });

  it('reads Rename as a rename', () => {
    expect(resolveFileState(input({ change: change('Rename'), readOnly: false })))
      .toBe('pendingRename');
  });

  it('reads SourceRename as a rename too', () => {
    expect(resolveFileState(input({ change: change('SourceRename'), readOnly: false })))
      .toBe('pendingRename');
  });

  it('falls back to checked out for a flag set we do not draw', () => {
    // Lock alone is pending and Check In will act on it, so it must not vanish.
    expect(resolveFileState(input({ change: change('Lock'), readOnly: false }))).toBe('checkedOut');
  });

  it('still reads a change with NO recognised flags as pending', () => {
    // parse.ts drops flags it does not know, so a future tf.exe degrades
    // instead of breaking -- which makes an empty set reachable from real
    // output, not just from a hand-built object. Without this, someone adds a
    // `size === 0` guard as a safety measure and a genuinely pending file
    // silently stops drawing.
    expect(resolveFileState(input({ change: change(), readOnly: false }))).toBe('checkedOut');
  });

  it('trusts the pending change over the read-only bit', () => {
    expect(resolveFileState(input({ change: change('Edit'), readOnly: true }))).toBe('checkedOut');
  });

  it('answers a plain Edit and an undrawn flag set identically, on purpose', () => {
    // The explicit `Edit` branch and the fallback below it return the same
    // value, so no mutation can catch removing the former. This pins the
    // EQUIVALENCE: if the fallback is ever given a state of its own, this fails
    // and forces a deliberate decision about Edit rather than a silent change.
    const edit = resolveFileState(input({ change: change('Edit'), readOnly: false }));
    const lockOnly = resolveFileState(input({ change: change('Lock'), readOnly: false }));
    expect(edit).toBe(lockOnly);
    expect(edit).toBe('checkedOut');
  });
});

describe('a folder with nothing pending', () => {
  it('is folderNotPending, whatever the read-only bit or the scan says', () => {
    // `attrib +R` on a directory really does clear S_IWUSR (mode 40444,
    // measured), so without the guard an attributed folder would read as
    // `versioned` and an unattributed one as the hazard. The scan DOES have an
    // opinion about folders -- 41 of 275 entries in one measured run were
    // directories -- and this pins that we deliberately ignore it, because a
    // folder's own state adds nothing over its contents'.
    for (const readOnly of [true, false]) {
      for (const scan of ['notInSourceControl', 'inSourceControl', 'notScanned'] as const) {
        expect(resolveFileState(input({ itemType: 'Folder', readOnly, scan })))
          .toBe('folderNotPending');
      }
    }
  });

  it('is not what a PENDING folder gets', () => {
    // Folders are pending changes too -- see the note in ScmProvider.ts, which
    // is where that observation and its figure come from. The guard sits after
    // the pending block precisely so it cannot swallow them.
    expect(resolveFileState(input({ itemType: 'Folder', change: change('Add'), readOnly: false })))
      .toBe('pendingAdd');
  });
});

describe('with nothing pending on a FILE, read-only is the answer', () => {
  it('reads a read-only file as versioned', () => {
    expect(resolveFileState(input({ readOnly: true }))).toBe('versioned');
  });

  it('lets the scan win when it says NOT in source control, even if read-only', () => {
    // Plan 1 pinned the opposite -- read-only first -- deliberately, as a
    // decision left to plan 2. Decided: `reconcile` listing the file is direct
    // evidence; read-only is an inference that a Windows copy of a checked-in
    // file measurably breaks, because the copy keeps the attribute. Without
    // this, `Form1 - Copy.vb` wears a lock claiming it is on the server.
    expect(resolveFileState(input({ readOnly: true, scan: 'notInSourceControl' })))
      .toBe('notVersioned');
  });

  it('still reads read-only as versioned when the scan agrees or never looked', () => {
    // Only the positive finding moved up. Everything the scan did not cover --
    // bin, obj, node_modules -- keeps plan 1's behaviour.
    expect(resolveFileState(input({ readOnly: true, scan: 'inSourceControl' }))).toBe('versioned');
    expect(resolveFileState(input({ readOnly: true, scan: 'notScanned' }))).toBe('versioned');
  });
});

describe('a writable file with nothing pending needs the scan', () => {
  it('is notVersioned when the scan looked and did not find it', () => {
    expect(resolveFileState(input({ readOnly: false, scan: 'notInSourceControl' })))
      .toBe('notVersioned');
  });

  it('is the hazard when the scan looked and it IS in source control', () => {
    // Writable, in source control, nothing pending: edited without checkout,
    // and TFVC cannot see the edit.
    expect(resolveFileState(input({ readOnly: false, scan: 'inSourceControl' })))
      .toBe('writableNotCheckedOut');
  });

  it('is unknown when the scan never looked', () => {
    // The whole reason ScanVerdict is a union and not a boolean: a path the
    // scan excluded must land HERE, not on the hazard.
    expect(resolveFileState(input({ readOnly: false, scan: 'notScanned' }))).toBe('unknown');
  });
});

describe('pendingStateOf (plan 3: the SCM row contextValue)', () => {
  const c = (...flags: ChangeFlag[]) => ({ changes: new Set(flags) }) as unknown as PendingChange;

  it('uses the same precedence as resolveFileState', () => {
    expect(pendingStateOf(c('Edit'))).toBe('checkedOut');
    expect(pendingStateOf(c('Add', 'Edit', 'Encoding'))).toBe('pendingAdd');
    expect(pendingStateOf(c('Delete', 'Edit'))).toBe('pendingDelete');
    expect(pendingStateOf(c('Rename'))).toBe('pendingRename');
    expect(pendingStateOf(c('SourceRename', 'Edit'))).toBe('pendingRename');
    expect(pendingStateOf(c('Lock'))).toBe('checkedOut');
    expect(pendingStateOf(c())).toBe('checkedOut');
  });

  it('is exactly what resolveFileState answers for a pending file', () => {
    const sets: ChangeFlag[][] = [['Edit'], ['Add'], ['Delete'], ['Rename'], ['SourceRename'], ['Lock'], []];
    for (const flags of sets) {
      const change = c(...flags);
      expect(
        resolveFileState({
          change,
          itemType: 'File',
          readOnly: true,
          ignored: false,
          mapped: true,
          scan: 'notScanned',
        }),
        flags.join(' '),
      ).toBe(pendingStateOf(change));
    }
  });
});
