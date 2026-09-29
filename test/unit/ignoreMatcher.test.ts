import { describe, it, expect } from 'vitest';
import { IgnoreMatcher, TF_BUILTIN_EXCLUSIONS, DEFAULT_IGNORE } from '../../src/ignore/IgnoreMatcher.js';

const m = (patterns: readonly string[] = DEFAULT_IGNORE) => new IgnoreMatcher(patterns);

describe("tf's own list, which we do not have to reimplement but do have to know", () => {
  it('is the 22 patterns measured from the real client', () => {
    // Measured on DEVPC 2026-09-17 by making tf print its own exclusion list.
    // It matters because tf never ENUMERATES these, so the scan's silence
    // about them is not evidence -- see ScanResult.
    //
    // Before changing this number, re-measure against a real tf client --
    // this assertion exists to force that re-measurement, not to police an
    // arbitrary count.
    expect(
      TF_BUILTIN_EXCLUSIONS,
      "re-measure against a real tf client's own printed exclusion list",
    ).toHaveLength(22);
    expect(TF_BUILTIN_EXCLUSIONS).toContain('*.exe');
    expect(TF_BUILTIN_EXCLUSIONS).toContain('bin');
    expect(TF_BUILTIN_EXCLUSIONS).toContain('obj');
    expect(TF_BUILTIN_EXCLUSIONS).toContain('TestResults');
  });

  it('does NOT contain the things that actually caused the noise', () => {
    // 6,950 of 6,974 folders in one real scan were node_modules, and tf does
    // not exclude it. That gap is the entire reason this file exists.
    expect(TF_BUILTIN_EXCLUSIONS).not.toContain('node_modules');
    expect(TF_BUILTIN_EXCLUSIONS).not.toContain('packages');
  });
});

describe('matching by NAME, the way tf /exclude: does', () => {
  it('matches a directory anywhere in the path', () => {
    expect(m().matches('src/node_modules/x/y.js')).toBe(true);
    expect(m().matches('node_modules/x.js')).toBe(true);
  });

  it('matches a file name', () => {
    expect(m().matches('docs/thumbs.db')).toBe(true);
  });

  it('matches a glob against the last component', () => {
    expect(m().matches('build/out.zip')).toBe(true);
    expect(m().matches('a/b/c.bak')).toBe(true);
  });

  it('does not match a partial component', () => {
    // `node_modules_old` is not `node_modules`.
    expect(m().matches('src/node_modules_old/x.js')).toBe(false);
  });

  it('leaves ordinary source alone', () => {
    expect(m().matches('src/Form1.vb')).toBe(false);
    expect(m().matches('docs/plan.md')).toBe(false);
  });

  it('includes nul, which is not cosmetic', () => {
    // Three real files named `nul` exist in this collection and each one makes
    // the whole scan exit 100 with no usable output.
    expect(m().matches('eFileVault/nul')).toBe(true);
  });

  it('is case-insensitive, because Windows is', () => {
    expect(m().matches('src/NODE_MODULES/x.js')).toBe(true);
    expect(m().matches('a/Thumbs.DB')).toBe(true);
  });

  it('escapes the pattern, so a dot is a dot, not "any character"', () => {
    // Unescaped, `.` in `thumbs.db` or `desktop.ini` would mean "any
    // character", and the direction of the mistake is the harmful one: an
    // over-match makes `matches()` true, which makes `ScanResult.covered()`
    // false, which makes the file `notScanned` -- it silently disappears from
    // the "Not in source control" list instead of erroring.
    expect(m().matches('a/thumbsXdb')).toBe(false);
    expect(m().matches('src/xgit/a.ts')).toBe(false);
  });

  it('*.* matches only a name that actually contains a dot -- pins OUR reading (Task 7 I7)', () => {
    // A teamExplorer.ignore or .tfignore entry of "*.*" is passed through
    // unchanged by normalisation (no separator, no refused character), so it
    // can reach here. Real tf, under classic DOS 8.3 rules, MAY treat "*.*" as
    // matching every name including one with no extension at all -- that is
    // unverified against a real client and deliberately not assumed. This
    // test only pins what OUR matcher does, so a future change to toRegExp
    // cannot silently change the answer without a failing test noticing.
    expect(m(['*.*']).matches('README')).toBe(false);
    expect(m(['*.*']).matches('README.md')).toBe(true);
  });

  it('treats ? as exactly one character, not zero or many', () => {
    expect(m(['*.ba?']).matches('a/x.bak')).toBe(true);
    expect(m(['*.ba?']).matches('a/x.ba')).toBe(false);
    expect(m(['*.ba?']).matches('a/x.bakk')).toBe(false);
  });

  it('drops an empty path component, so a bare wildcard cannot match one', () => {
    // With the shipped lists this makes no observable difference: none of
    // their patterns can match an empty string, so `m().matches('src//a.ts')`
    // is `false` whether or not this filter exists. A bare `*` pattern is
    // needed to tell the two apart, because `.replace(/\*/g, '.*')` matches
    // the empty string too -- verified by removing the filter and watching
    // this assertion flip to `true`.
    expect(new IgnoreMatcher(['*']).matches('//')).toBe(false);
  });
});

describe('the patterns we hand to tf', () => {
  it('offers them as a comma-joined /exclude: value', () => {
    // /exclude: takes a comma-separated list and matches by NAME, so one
    // `node_modules` covers every project in the collection.
    expect(m(['node_modules', 'packages']).excludeArgument()).toBe('/exclude:node_modules,packages');
  });

  it('is undefined when there is nothing to exclude', () => {
    // We do not rely on tf's behaviour for an empty list -- we simply never
    // pass the flag.
    expect(m([]).excludeArgument()).toBeUndefined();
  });
});

describe('excludePatterns(): the plain names UnversionedScan combines with the built-ins', () => {
  it('returns the normalised list, in order', () => {
    expect(m(['node_modules', 'packages']).excludePatterns()).toEqual(['node_modules', 'packages']);
  });

  it('splits a comma-bearing pattern the same way matches() sees it', () => {
    // Kills a mutant that returns the raw constructor input instead of
    // `this.patterns`: unlike the test above, this input is NOT already
    // normalised, so a raw pass-through would still show `'a,b'` as one entry.
    expect(m(['a,b']).excludePatterns()).toEqual(['a', 'b']);
  });

  it('drops empty entries', () => {
    expect(m(['', 'foo']).excludePatterns()).toEqual(['foo']);
  });
});

describe('normalising patterns to agree with tf about commas', () => {
  // tf reads /exclude:'s argument as comma-separated, so a pattern containing
  // a comma is not one rule to tf, it is two. The constructor splits on `,`
  // up front so the local rules and the argument we hand to tf are built from
  // the same normalised list and agree by construction.

  it('splits a comma-bearing pattern into two rules that both work', () => {
    const im = m(['a,b']);
    expect(im.matches('a')).toBe(true);
    expect(im.matches('b')).toBe(true);
    expect(im.matches('a,b')).toBe(false);
  });

  it('emits the split form back to tf, so both sides mean the same thing', () => {
    expect(m(['a,b']).excludeArgument()).toBe('/exclude:a,b');
  });

  it('drops a bare empty pattern, so excludeArgument is undefined rather than malformed', () => {
    expect(m(['']).excludeArgument()).toBeUndefined();
  });

  it('trims each comma-separated part, so "a, b" does not send a leading space to /exclude: (review item 7)', () => {
    // A setting entry like "a, b" is common shorthand for two patterns. Before
    // this fix, splitting on "," alone left the leading space on " b" intact,
    // so tf received a pattern that could never match a real file name.
    const im = m(['a, b']);
    expect(im.excludePatterns()).toEqual(['a', 'b']);
    expect(im.excludeArgument()).toBe('/exclude:a,b');
    expect(im.matches('b')).toBe(true);
  });

  it('drops only the empty entry when patterns are mixed', () => {
    expect(m(['', 'foo']).excludeArgument()).toBe('/exclude:foo');
  });
});
