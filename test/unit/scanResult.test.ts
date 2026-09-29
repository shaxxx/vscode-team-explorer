import { describe, it, expect } from 'vitest';
import { ScanResult } from '../../src/scan/ScanResult.js';
import { IgnoreMatcher, DEFAULT_IGNORE, scanExclusion } from '../../src/ignore/IgnoreMatcher.js';
import { combineIgnoreSources } from '../../src/ignore/readTfIgnore.js';
import { resolveFileState } from '../../src/state/FileState.js';

const ignore = new IgnoreMatcher(DEFAULT_IGNORE);
// The exact function UnversionedScan calls, so a builtin-excluded path
// (`bin`, not in DEFAULT_IGNORE) reads `notScanned` here for the same reason
// it does in production, not because this file rebuilt the list by hand.
const exclusion = scanExclusion(ignore);

/** A scan of `root` that found exactly these relative paths. */
function scanned(paths: string[]) {
  return new ScanResult('C:/work/Proj', paths, { exclusion, ignore }, 'win32');
}

describe('what the scan actually looked at', () => {
  it('reports a listed path as not in source control', () => {
    expect(scanned(['new.vb']).verdictFor('C:/work/Proj/new.vb')).toBe('notInSourceControl');
  });

  it('reports an unlisted path it DID cover as in source control', () => {
    // The scan enumerates unversioned items only, so silence about a path it
    // walked is real evidence.
    expect(scanned(['new.vb']).verdictFor('C:/work/Proj/old.vb')).toBe('inSourceControl');
  });
});

describe('what the scan never looked at', () => {
  it('will not answer for a path an ignore pattern excluded', () => {
    // THE bug this type exists to prevent. `/exclude:node_modules` means tf
    // never enumerated it, so its absence from the list is not evidence -- and
    // calling it `inSourceControl` gives every one of those files the
    // propagating `!` hazard badge.
    expect(scanned([]).verdictFor('C:/work/Proj/node_modules/x.js')).toBe('notScanned');
  });

  it('will not answer for a path in tf\'s own default list', () => {
    // `bin` is one of tf's 22, but tf itself never sees this list any more:
    // the scan runs with /noignore, so `bin` is skipped only because
    // `exclusion` (built from TF_BUILTIN_EXCLUSIONS) was passed in /exclude:.
    expect(scanned([]).verdictFor('C:/work/Proj/bin/App.dll')).toBe('notScanned');
  });

  it('will not answer for a path outside the scanned root', () => {
    expect(scanned([]).verdictFor('C:/elsewhere/x.vb')).toBe('notScanned');
  });

  it('will not answer for a sibling that merely shares a name prefix', () => {
    // Mutant: `relative()`'s prefix test as `a.startsWith(r)` instead of
    // `a.startsWith(\`${r}/\`)`. Root `C:/work/Proj` and path
    // `C:/work/Proj2/x.vb` share the string prefix `C:/work/Proj`, so without
    // the separator in the guard, `x.vb` would get relative path `2/x.vb`,
    // be unlisted, and answer `inSourceControl` -- the propagating hazard, on
    // a file in an entirely different project.
    expect(scanned([]).verdictFor('C:/work/Proj2/x.vb')).toBe('notScanned');
  });

  it('will not answer for the root itself', () => {
    expect(scanned([]).verdictFor('C:/work/Proj')).toBe('notScanned');
  });

  it('will not answer for the root with a trailing separator either', () => {
    // Mutant: `covered()`'s `rel === ''` check deleted (replaced with
    // "always true"). `relative(root + '/')` yields `''`, and only this guard
    // stops that from reading as `inSourceControl`.
    expect(scanned([]).verdictFor('C:/work/Proj/')).toBe('notScanned');
  });
});

describe('separators, because fsPath and tf disagree about them', () => {
  it('accepts a native Windows path, which is what uri.fsPath gives', () => {
    // `uri.fsPath` is `C:\work\Proj\new.vb`, NOT `C:/work/Proj/new.vb`.
    // A comparison that skips normalisation misses every path on Windows --
    // silently, because the answer would be a plausible `notScanned`.
    const r = new ScanResult('C:\\work\\Proj', ['sub/new.vb'], { exclusion, ignore }, 'win32');
    expect(r.verdictFor('C:\\work\\Proj\\sub\\new.vb')).toBe('notInSourceControl');
  });

  it('gives back native separators for the UI', () => {
    const r = new ScanResult('C:\\work\\Proj', ['sub/new.vb'], { exclusion, ignore }, 'win32');
    expect(r.unversionedPaths()).toEqual(['C:\\work\\Proj\\sub\\new.vb']);
  });

  it('does not mislabel a listed file behind a doubled separator', () => {
    // `relative('C:/work/Proj//a.vb')` used to yield `/a.vb`: the leading `/`
    // made `listedOrInsideOne`'s ancestor walk stop (`cut > 0` is false at
    // `cut === 0`) before ever testing `a.vb` against the listed set, so a
    // LISTED file answered `inSourceControl` -- the one input where a listed
    // file was mislabelled in the dangerous direction.
    expect(scanned(['a.vb']).verdictFor('C:/work/Proj//a.vb')).toBe('notInSourceControl');
  });
});

describe('case, because Windows and tf disagree about it', () => {
  it('matches a listed path whatever its case, on win32', () => {
    expect(scanned(['New.vb']).verdictFor('c:/work/proj/NEW.VB')).toBe('notInSourceControl');
  });

  it('folds the LISTED lookup case-insensitively on linux too, because tf is a Windows program', () => {
    // tf may spell a path in a case the Linux disk does not, so `key()` folds
    // unconditionally on both platforms now -- unlike `relativeToRoot`'s own
    // root-prefix comparison, which stays platform-native (see the next
    // `describe` block, "Linux: tf's case for a listed item ..."). Folding
    // can only turn a would-be miss into `notInSourceControl` (silence),
    // never into the hazard.
    const r = new ScanResult('/home/shax/work/Proj', ['New.vb'], { exclusion, ignore }, 'linux');
    expect(r.verdictFor('/home/shax/work/Proj/New.vb')).toBe('notInSourceControl');
    expect(r.verdictFor('/home/shax/work/Proj/new.vb')).toBe('notInSourceControl');
  });

  it("Linux: tf's case for a listed item does not have to match the disk's own case", () => {
    // Kills a mutant that keeps `key()`'s old platform-conditional folding:
    // tf lists 'Forms/New.vb', the file on disk is 'forms/New.vb' -- without
    // unconditional folding this would wrongly read as inSourceControl.
    const r = new ScanResult('/home/shax/work/Proj', ['Forms/New.vb'], { exclusion, ignore }, 'linux');
    expect(r.verdictFor('/home/shax/work/Proj/forms/New.vb')).toBe('notInSourceControl');
  });
});

describe('a listed DIRECTORY, whose contents tf never enumerated', () => {
  // `reconcile` lists a new FOLDER and does not always enumerate what is in it.
  // In `reconcile-adds.txt`, `Connected Services` is a `Pending add:` with no
  // header of its own anywhere in the file -- and `Dialogs`, `DX` and `Forms`
  // in the same block have the same shape.
  //
  // An exact-path lookup answers `inSourceControl` for every file inside such a
  // folder. That is the mislabelling this union exists to prevent, and it is
  // the worst one available: those files are writable, so the badge it produces
  // is the PROPAGATING `!` hazard, on every file in every new folder.
  //
  // A file inside an unversioned folder cannot itself be versioned, so
  // attributing the folder's verdict to its descendants is sound rather than
  // merely cautious.
  it('answers for a file inside a listed folder', () => {
    expect(
      scanned(['Connected Services']).verdictFor('C:/work/Proj/Connected Services/x.json'),
    ).toBe('notInSourceControl');
  });

  it('answers for a file nested several levels inside one', () => {
    expect(
      scanned(['Connected Services']).verdictFor('C:/work/Proj/Connected Services/a/b/x.json'),
    ).toBe('notInSourceControl');
  });

  it('does not treat a sibling with a shared prefix as being inside it', () => {
    // `Connected Services2` is not inside `Connected Services`. A `startsWith`
    // that forgot the separator would say it was.
    expect(
      scanned(['Connected Services']).verdictFor('C:/work/Proj/Connected Services2/x.json'),
    ).toBe('inSourceControl');
  });

  it('still answers for the listed folder itself', () => {
    expect(scanned(['Connected Services']).verdictFor('C:/work/Proj/Connected Services')).toBe(
      'notInSourceControl',
    );
  });
});

describe('the empty result', () => {
  it('is not the same as no result', () => {
    // A scan that ran and found nothing means every covered path IS in source
    // control. That is a real answer, and the reason `empty()` is not used for
    // "has not run yet".
    expect(scanned([]).verdictFor('C:/work/Proj/old.vb')).toBe('inSourceControl');
  });

  it('answers notScanned for everything before a scan has run', () => {
    expect(ScanResult.notRun().verdictFor('C:/work/Proj/anything.vb')).toBe('notScanned');
  });

  it('answers notScanned on a linux-shaped path too', () => {
    // Mutant: the sentinel root `'\u0000never'` replaced with `''`. The one
    // test above only exercises it against a Windows-shaped path on an
    // instance built with platform 'linux', so an empty root's prefix test
    // becomes `startsWith('/')` -- which every absolute POSIX path passes,
    // answering `inSourceControl` for every file on the machine before any
    // scan has run.
    expect(ScanResult.notRun().verdictFor('/home/shax/Proj/x.vb')).toBe('notScanned');
  });
});

describe('the list, for the SCM panel', () => {
  it('offers absolute paths, ignore-filtered', () => {
    const r = scanned(['a.vb', 'node_modules/b.js', 'sub/c.vb']);
    // `scanned()`'s root is spelled with `/` for readability, but the
    // constructor canonicalises it to the platform's native separator (see
    // "canonicalising the root" below), so the join is fully native-spelled
    // even though the fixture root above is not.
    expect(r.unversionedPaths().sort()).toEqual([
      'C:\\work\\Proj\\a.vb',
      'C:\\work\\Proj\\sub\\c.vb',
    ]);
  });

  it('preserves case, because a lower-cased name would be a silent lie', () => {
    // Mutant: `return [...this.listed]` in place of `return this.original`.
    // `listed` is case-folded for lookup; every entry in the test above is
    // already lower-case, so it would not have noticed.
    const r = scanned(['Connected Services']);
    expect(r.unversionedPaths()).toEqual(['C:\\work\\Proj\\Connected Services']);
  });

  it('is not aliased to the caller\'s array', () => {
    const paths = ['a.vb'];
    const r = scanned(paths);
    paths.push('b.vb');
    expect(r.unversionedPaths()).toEqual(['C:\\work\\Proj\\a.vb']);
  });

  it('drops a listed item matching only a built-in exclusion, not just an ignore pattern', () => {
    // The test above ('ignore-filtered') uses node_modules, which is in
    // BOTH `exclusion` and `ignore` here, so it cannot tell a missing
    // `!this.exclusion.matches(rel)` half of the filter from a working one.
    // 'bin' is a built-in ONLY (not in DEFAULT_IGNORE), so it exercises that
    // half on its own.
    const r = scanned(['bin/App.dll', 'keep.vb']);
    expect(r.unversionedPaths()).toEqual(['C:\\work\\Proj\\keep.vb']);
  });

  it('returns a fresh array each call, so a caller\'s .sort() cannot corrupt the cache', () => {
    const r = scanned(['b.vb', 'a.vb']);
    const first = r.unversionedPaths();
    first.sort();
    expect(r.unversionedPaths()).toEqual(['C:\\work\\Proj\\b.vb', 'C:\\work\\Proj\\a.vb']);
  });
});

describe('canonicalising the root', () => {
  // Every other method compares through `norm()` and already tolerates any
  // spelling. `unversionedPaths()` used to concatenate `this.root` raw, so it
  // alone was sensitive to exactly how the caller spelled the root.
  it('accepts a root spelled with forward slashes', () => {
    const r = new ScanResult('C:/work/Proj', ['sub/a.vb'], { exclusion, ignore }, 'win32');
    expect(r.unversionedPaths()).toEqual(['C:\\work\\Proj\\sub\\a.vb']);
  });

  it('strips a trailing separator', () => {
    const r = new ScanResult('C:\\work\\Proj\\', ['a.vb'], { exclusion, ignore }, 'win32');
    expect(r.unversionedPaths()).toEqual(['C:\\work\\Proj\\a.vb']);
  });

  it('strips a trailing separator from a bare drive root', () => {
    const r = new ScanResult('C:\\', ['a.vb'], { exclusion, ignore }, 'win32');
    expect(r.unversionedPaths()).toEqual(['C:\\a.vb']);
  });
});

describe('covered(), separately public from verdictFor', () => {
  it('is false outside the root', () => {
    expect(scanned([]).covered('C:/elsewhere/x.vb')).toBe(false);
  });

  it('is false for the root itself, exactly', () => {
    expect(scanned([]).covered('C:/work/Proj')).toBe(false);
  });

  it('rejects a `..` component rather than trust the string-prefix test', () => {
    // `relative()` is a string-prefix test, not a containment test, so
    // without this check `C:/work/Proj/../Other/a.vb` would pass as "under"
    // `C:/work/Proj`.
    expect(scanned([]).covered('C:/work/Proj/../Other/a.vb')).toBe(false);
  });
});

describe('an anchored .tfignore rule narrows the group, never coverage', () => {
  it('is covered (not in the exclusion list), and resolveFileState reads ignored before the hazard', () => {
    // Anchored rules never reach `/exclude:` (readTfIgnore.ts), so `vendor`
    // is NOT in the list tf was told to skip -- tf enumerated it, and its
    // absence from the listing is real evidence, not silence. Without
    // `resolveFileState` checking `ignored` first, this path would resolve
    // to `inSourceControl` on an unlisted writable file: the hazard.
    const anchored = combineIgnoreSources(DEFAULT_IGNORE, {
      rules: [{ pattern: 'vendor', negated: false, anchored: true }],
      skipped: [],
      path: 'C:/work/Proj/.tfignore',
      dirOffsetFromRoot: '',
    });
    const tfExclusion = scanExclusion(anchored);
    const r = new ScanResult('C:/work/Proj', [], { exclusion: tfExclusion, ignore: anchored }, 'win32');

    expect(r.covered('C:/work/Proj/vendor/lib.js')).toBe(true);
    expect(r.verdictFor('C:/work/Proj/vendor/lib.js')).toBe('inSourceControl');

    expect(
      resolveFileState({
        change: undefined,
        itemType: 'File',
        readOnly: false,
        ignored: anchored.matches('vendor/lib.js'),
        mapped: true,
        scan: r.verdictFor('C:/work/Proj/vendor/lib.js'),
      }),
    ).toBe('ignored');
  });

  it('drops a LISTED item from unversionedPaths() once an anchored .tfignore rule matches it', () => {
    // Kills a mutant that filters `unversionedPaths()` by `exclusion` alone,
    // dropping the `ignore` half of the filter: `vendor/lib.js` IS listed (tf
    // enumerated and pended it), but the group must not show it because the
    // project author's own anchored rule says to hide it.
    const anchored = combineIgnoreSources(DEFAULT_IGNORE, {
      rules: [{ pattern: 'vendor', negated: false, anchored: true }],
      skipped: [],
      path: 'C:/work/Proj/.tfignore',
      dirOffsetFromRoot: '',
    });
    const tfExclusion = scanExclusion(anchored);
    const r = new ScanResult('C:/work/Proj', ['vendor/lib.js'], { exclusion: tfExclusion, ignore: anchored }, 'win32');
    expect(r.unversionedPaths()).toEqual([]);
  });
});

describe('a file created after the scan started', () => {
  // The scan is a snapshot. A file created after it began was never enumerated,
  // so its ABSENCE from the listing is not evidence it is in source control.
  // Reading it that way put the red ! on every new file until the next scan
  // (acceptance run, C:\work\Rex\new_file.txt, 2026-09-18).
  const started = 1_000_000;
  const r = () => new ScanResult('C:/work/Proj', ['listed.vb'], { exclusion, ignore }, 'win32', started);

  it('is notScanned when it is not listed', () => {
    expect(r().verdictFor('C:/work/Proj/new_file.txt', started + 1)).toBe('notScanned');
  });

  it('is still notInSourceControl when it IS listed: positive evidence needs no timestamp', () => {
    expect(r().verdictFor('C:/work/Proj/listed.vb', started + 1)).toBe('notInSourceControl');
  });

  it('is still inSourceControl when it existed before the scan: the hazard survives', () => {
    expect(r().verdictFor('C:/work/Proj/old.vb', started - 1)).toBe('inSourceControl');
  });

  it('is notScanned when createdAtMs exactly equals startedAt -- kills a >= -> > mutant', () => {
    // Created in the same millisecond the scan started may or may not have
    // been seen; guessing "seen" is the direction that cries wolf.
    expect(r().verdictFor('C:/work/Proj/new_file.txt', started)).toBe('notScanned');
  });
});

describe('arrivals: a path reported created, renamed or moved in (fed by the watcher)', () => {
  it('a renamed file is notScanned, not inSourceControl: VS Code reports a rename as delete + create', () => {
    // U2/C2: a rename keeps the file's birthtime, so createdAtMs alone cannot
    // catch this -- noteArrival is the mechanism that does.
    const r = scanned(['notes.txt']);
    r.noteArrival('C:/work/Proj/notes-renamed.txt');
    expect(r.verdictFor('C:/work/Proj/notes-renamed.txt')).toBe('notScanned');
  });

  it('a renamed FOLDER makes everything inside it notScanned too, not just the folder itself', () => {
    // The watcher reports the folder's own path, never each descendant --
    // same reasoning as a listed folder tf never enumerated.
    const r = scanned([]);
    r.noteArrival('C:/work/Proj/renamedDir');
    expect(r.verdictFor('C:/work/Proj/renamedDir/inner.txt')).toBe('notScanned');
  });

  it('positive evidence still wins: a LISTED path stays notInSourceControl even when it is also an arrival', () => {
    const r = scanned(['notes.txt']);
    r.noteArrival('C:/work/Proj/notes.txt');
    expect(r.verdictFor('C:/work/Proj/notes.txt')).toBe('notInSourceControl');
  });

  it('folds the key the same way listed does, case-insensitively', () => {
    const r = scanned([]);
    r.noteArrival('C:/work/Proj/New-Name.txt');
    expect(r.verdictFor('c:/work/proj/new-name.txt')).toBe('notScanned');
  });
});

describe('departures: a path reported deleted (onDidDelete)', () => {
  it('drops the departed path from unversionedPaths(), and everything under it', () => {
    const r = scanned(['a.vb', 'sub/b.vb']);
    r.noteDeparture('C:/work/Proj/sub');
    expect(r.unversionedPaths()).toEqual(['C:\\work\\Proj\\a.vb']);
  });

  it('a later arrival of the same path clears the departure and restores the group row', () => {
    const r = scanned(['a.vb']);
    r.noteDeparture('C:/work/Proj/a.vb');
    expect(r.unversionedPaths()).toEqual([]);
    r.noteArrival('C:/work/Proj/a.vb');
    expect(r.unversionedPaths()).toEqual(['C:\\work\\Proj\\a.vb']);
  });

  it('does not affect verdictFor: a departed but still-listed path stays notInSourceControl', () => {
    const r = scanned(['a.vb']);
    r.noteDeparture('C:/work/Proj/a.vb');
    expect(r.verdictFor('C:/work/Proj/a.vb')).toBe('notInSourceControl');
  });

  it('the cache still returns a fresh copy, and reflects a departure made after the first call', () => {
    const r = scanned(['a.vb', 'b.vb']);
    const first = r.unversionedPaths();
    first.sort(); // mutating the returned array must not corrupt the cache
    r.noteDeparture('C:/work/Proj/b.vb');
    expect(r.unversionedPaths()).toEqual(['C:\\work\\Proj\\a.vb']);
  });
});

describe('noteArrival / noteDeparture use coveredRelative, not the bare relativeToRoot', () => {
  // A build writing under bin/obj/.vs/.git fires thousands of these events;
  // storing one for a path the scan never covers, and telling
  // UnversionedScan to schedule a refresh for it, was pure overhead
  // (measured: 200k arrivals, 25.6 MB, 302 ms) for a path that could never
  // change what verdictFor or unversionedPaths() answer either way.

  it('noteArrival returns false, and does not record anything, for a path under a built-in exclusion', () => {
    const r = scanned([]);
    expect(r.noteArrival('C:/work/Proj/bin/App.dll')).toBe(false);
    // Still notScanned either way (excluded), but this pins that the excluded
    // arrival did not silently arm the arrivals set: a listed sibling one
    // level up would not accidentally look "inside an arrival".
    expect(r.verdictFor('C:/work/Proj/bin/App.dll')).toBe('notScanned');
  });

  it('noteArrival returns true for a covered path', () => {
    const r = scanned([]);
    expect(r.noteArrival('C:/work/Proj/new.vb')).toBe(true);
  });

  it('noteArrival returns false the second time for a path already recorded as arrived: nothing changed', () => {
    const r = scanned([]);
    expect(r.noteArrival('C:/work/Proj/new.vb')).toBe(true);
    expect(r.noteArrival('C:/work/Proj/new.vb')).toBe(false);
  });

  it('noteDeparture returns false for a path under a built-in exclusion: everything under an uncovered path is uncovered', () => {
    const r = scanned([]);
    expect(r.noteDeparture('C:/work/Proj/bin/App.dll')).toBe(false);
  });

  it('noteDeparture returns true for a covered, listed path', () => {
    const r = scanned(['a.vb']);
    expect(r.noteDeparture('C:/work/Proj/a.vb')).toBe(true);
  });

  it('noteDeparture returns false the second time for a path already recorded as departed', () => {
    const r = scanned(['a.vb']);
    expect(r.noteDeparture('C:/work/Proj/a.vb')).toBe(true);
    expect(r.noteDeparture('C:/work/Proj/a.vb')).toBe(false);
  });

  it('noteArrival returns true when it clears an existing departure, even if the key was already an arrival', () => {
    const r = scanned(['a.vb']);
    r.noteDeparture('C:/work/Proj/a.vb');
    expect(r.noteArrival('C:/work/Proj/a.vb')).toBe(true);
  });
});

describe('unversionedPaths(): the departures.size === 0 fast path stays correct', () => {
  it('returns a fresh, correct copy once departures.size is back to 0, not a corrupted or stale cache', () => {
    const r = scanned(['a.vb', 'b.vb']);
    const first = r.unversionedPaths();
    first.sort(); // mutating the returned array must not corrupt either cache
    r.noteDeparture('C:/work/Proj/b.vb'); // departures.size becomes 1: leaves the fast path
    expect(r.unversionedPaths()).toEqual(['C:\\work\\Proj\\a.vb']);
    r.noteArrival('C:/work/Proj/b.vb'); // clears the departure: back to departures.size === 0
    const restored = r.unversionedPaths();
    restored.sort(); // must not corrupt the fast-path cache for the next caller either
    expect(r.unversionedPaths()).toEqual(['C:\\work\\Proj\\a.vb', 'C:\\work\\Proj\\b.vb']);
  });
});
