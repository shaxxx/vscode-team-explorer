import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readTfIgnore,
  findTfIgnore,
  combineIgnoreSources,
} from '../../src/ignore/readTfIgnore.js';
import { DEFAULT_IGNORE, IgnoreMatcher, scanExclusion } from '../../src/ignore/IgnoreMatcher.js';
import { ScanResult } from '../../src/scan/ScanResult.js';
import { buildIgnorer } from '../../src/extension.js';
import { configValues } from '../vscode-mock.js';

// A single backslash, built with a name rather than typed next to a letter --
// the Write/Edit parameter layer has been seen to decode a literal
// backslash-then-'b' into a real backspace character.
const BACKSLASH = String.fromCharCode(92);

describe('readTfIgnore -- pure parsing of .tfignore text', () => {
  it('ignores comments and blank lines', () => {
    const { rules, skipped } = readTfIgnore('# a comment\n\nnode_modules\n');
    expect(rules).toEqual([{ pattern: 'node_modules', negated: false, anchored: false }]);
    expect(skipped).toEqual([]);
  });

  it('treats a bare name as a name match, like the built-in list', () => {
    const { rules } = readTfIgnore('vendor\n');
    expect(rules).toEqual([{ pattern: 'vendor', negated: false, anchored: false }]);
    const combined = combineIgnoreSources(DEFAULT_IGNORE, {
      rules,
      skipped: [],
      path: 'X/.tfignore',
      dirOffsetFromRoot: '',
    });
    expect(combined.matches('vendor/x.js')).toBe(true);
    expect(combined.matches('src/vendor/x.js')).toBe(true);
  });

  it('lets a later ! negation win', () => {
    // *.dll then !keep.dll -- keep.dll is NOT ignored, but other .dll files
    // still are. Order matters and the last matching rule decides, which is
    // the one thing every ignore format agrees on.
    const { rules } = readTfIgnore('*.dll\n!keep.dll\n');
    expect(rules).toEqual([
      { pattern: '*.dll', negated: false, anchored: false },
      { pattern: 'keep.dll', negated: true, anchored: false },
    ]);
    const combined = combineIgnoreSources([], {
      rules,
      skipped: [],
      path: 'X/.tfignore',
      dirOffsetFromRoot: '',
    });
    expect(combined.matches('a/keep.dll')).toBe(false);
    expect(combined.matches('a/other.dll')).toBe(true);
  });

  it('anchors a leading backslash to the .tfignore directory', () => {
    const text = BACKSLASH + 'bin\n';
    const { rules } = readTfIgnore(text);
    expect(rules).toEqual([{ pattern: 'bin', negated: false, anchored: true }]);

    const combined = combineIgnoreSources([], {
      rules,
      skipped: [],
      path: 'X/.tfignore',
      dirOffsetFromRoot: '',
    });
    expect(combined.matches('bin/a.dll')).toBe(true);
    expect(combined.matches('bin')).toBe(true);
    expect(combined.matches('src/bin/a.dll')).toBe(false);
    expect(combined.matches('src/bin')).toBe(false);
  });

  it('skips a line it does not understand rather than guessing, and fails open', () => {
    // An internal slash is a path pattern our name-only matcher cannot
    // represent honestly, so it is not guessed at -- it is dropped, and the
    // file it would have hidden stays visible.
    const { rules, skipped } = readTfIgnore('src/bin\n');
    expect(rules).toEqual([]);
    expect(skipped).toEqual(['src/bin']);

    const loaded = { rules, skipped, path: 'X/.tfignore', dirOffsetFromRoot: '' };
    const combined = combineIgnoreSources(DEFAULT_IGNORE, loaded);
    // Failing open: the unparsed line hid nothing, so this path is still shown.
    expect(combined.matches('src/bin/a.dll')).toBe(false);
  });

  it('skips a pattern containing a comma, rather than letting tf split it into two rules', () => {
    // `tf /exclude:` and IgnoreMatcher's constructor both read a comma as a
    // separator between two patterns, not a literal character in a filename.
    // `my,file.txt` contains no `/`, `\`, `[`, `]` or `**`, so without this
    // check it would look perfectly parseable as one glob -- and then
    // silently become two rules that hide every file named `my` and every
    // file named `file.txt`, while never hiding the file actually named.
    // Commas are legal and common in real Windows filenames ("Report,
    // final.docx").
    const { rules, skipped } = readTfIgnore('my,file.txt\n');
    expect(rules, 'a comma pattern must not become a rule').toEqual([]);
    expect(skipped, 'the line must be logged, not silently dropped').toEqual(['my,file.txt']);

    const combined = combineIgnoreSources([], {
      rules,
      skipped,
      path: 'X/.tfignore',
      dirOffsetFromRoot: '',
    });
    // Failing open: neither half-name is hidden, and neither is the file
    // actually named.
    expect(combined.matches('a/my')).toBe(false);
    expect(combined.matches('a/file.txt')).toBe(false);
    expect(combined.matches('a/my,file.txt')).toBe(false);
    expect(combined.excludePatterns()).toEqual([]);
  });

  it('is not confused by CRLF', () => {
    const { rules } = readTfIgnore('node_modules\r\n*.dll\r\n');
    expect(rules).toEqual([
      { pattern: 'node_modules', negated: false, anchored: false },
      { pattern: '*.dll', negated: false, anchored: false },
    ]);
  });

  it('splits on a bare CR too, not just CRLF', () => {
    // A CRLF's trailing \r happens to also be stripped by String.trim(), so a
    // naive "split on \n only" implementation passes the test above by
    // accident. A lone \r (no \n) tells the two implementations apart: split
    // on \n alone, this is ONE line with an embedded \r in the middle, which
    // trim() does NOT touch, and it would wrongly become (or corrupt) a
    // single pattern instead of two.
    const { rules } = readTfIgnore('node_modules\r*.dll\n');
    expect(rules).toEqual([
      { pattern: 'node_modules', negated: false, anchored: false },
      { pattern: '*.dll', negated: false, anchored: false },
    ]);
  });

  it('skips a bare negation or a bare anchor with nothing after it', () => {
    const { rules, skipped } = readTfIgnore('!\n' + BACKSLASH + '\n');
    expect(rules).toEqual([]);
    expect(skipped).toEqual(['!', BACKSLASH]);
  });

  it('skips a character class and a globstar, rather than guessing at them', () => {
    const { rules, skipped } = readTfIgnore('[abc]\nfoo**bar\n');
    expect(rules).toEqual([]);
    expect(skipped).toEqual(['[abc]', 'foo**bar']);
  });

  it('skips a pattern with a second, non-anchoring backslash', () => {
    const text = BACKSLASH + 'a' + BACKSLASH + 'b\n';
    const { rules, skipped } = readTfIgnore(text);
    expect(rules).toEqual([]);
    // The full original line is what gets logged, not the marker-stripped
    // remainder -- so the user can find the exact line in their own file.
    expect(skipped).toEqual([BACKSLASH + 'a' + BACKSLASH + 'b']);
  });

  it('trims trailing whitespace and CR remnants around a pattern', () => {
    const { rules } = readTfIgnore('  node_modules  \n');
    expect(rules).toEqual([{ pattern: 'node_modules', negated: false, anchored: false }]);
  });

  it('skips a line containing a control character, rather than turning it into a NUL-laden pattern', () => {
    // The realistic cause is a UTF-16 file misread, which used to yield a
    // pattern like "n\0o\0d\0e..." that reaches TfClient.run() and throws on
    // the embedded NUL. The check is general, not NUL-specific: any character
    // below U+0020 makes the line unparseable, the same way an embedded slash
    // does above.
    const nul = String.fromCharCode(0);
    const { rules, skipped } = readTfIgnore('vendor\n' + 'no' + nul + 'de_modules\n');
    expect(rules).toEqual([{ pattern: 'vendor', negated: false, anchored: false }]);
    expect(skipped).toEqual(['no' + nul + 'de_modules']);
  });

  it('a line of only whitespace is still blank, even though tab is technically a control character', () => {
    // trim() removes tab along with every other whitespace character, so a
    // line like this reaches the blank check first and never becomes a
    // reported "skip" -- unlike a NUL, which trim() does NOT remove.
    const { rules, skipped } = readTfIgnore('vendor\n\t\t\t\n');
    expect(rules).toEqual([{ pattern: 'vendor', negated: false, anchored: false }]);
    expect(skipped).toEqual([]);
  });

  it('does not skip a valid rule just because it has leading/trailing TAB around it (review item 3)', () => {
    // The control-character check must run on the TRIMMED line, not the raw
    // one: a leading/trailing tab is ordinary whitespace and must not make an
    // otherwise perfectly good rule vanish (and log an invisible-looking
    // "skipped" line no one could ever find in their own file).
    const { rules, skipped } = readTfIgnore('\tvendor\t\n');
    expect(rules).toEqual([{ pattern: 'vendor', negated: false, anchored: false }]);
    expect(skipped).toEqual([]);
  });

  it('still skips a control character embedded in the middle, surviving the trim (review item 3)', () => {
    const nul = String.fromCharCode(0);
    const { rules, skipped } = readTfIgnore('ven' + nul + 'dor\n');
    expect(rules).toEqual([]);
    expect(skipped).toEqual(['ven' + nul + 'dor']);
  });

  it('strips a single trailing slash from a folder-style rule: .idea/ is the name .idea', () => {
    // The most common REAL form of a .tfignore rule: Visual Studio and every
    // gitignore-alike write folder rules this way. A real .tfignore
    // on DEVPC uses this shape for .claude/, .idea/, .screenshots/, .dart_tool/.
    const { rules } = readTfIgnore('.idea/\n');
    expect(rules).toEqual([{ pattern: '.idea', negated: false, anchored: false }]);
  });

  it('strips a single trailing backslash from a folder-style rule too', () => {
    const { rules } = readTfIgnore('.idea' + BACKSLASH + '\n');
    expect(rules).toEqual([{ pattern: '.idea', negated: false, anchored: false }]);
  });

  it('strips the trailing slash from an anchored rule before checking for a separator', () => {
    // \build/ -- anchor marker, name, trailing slash -- becomes anchored
    // "build", not a skipped "still has a separator" line.
    const { rules } = readTfIgnore(BACKSLASH + 'build/\n');
    expect(rules).toEqual([{ pattern: 'build', negated: false, anchored: true }]);
  });

  it('still skips a rule with an embedded (non-trailing) separator after the single strip', () => {
    // The single trailing strip turns "a/b/" into "a/b" before the separator
    // check, which still fires (an embedded "/" remains) -- but `skipped`
    // reports the ORIGINAL raw line, like every other skip, so the user can
    // find the exact line in their own file.
    const { rules, skipped } = readTfIgnore('a/b/\n');
    expect(rules).toEqual([]);
    expect(skipped).toEqual(['a/b/']);
  });

  it('skips a pattern containing %, which TfClient refuses as a tf argument', () => {
    const { rules, skipped } = readTfIgnore('a%b\n');
    expect(rules).toEqual([]);
    expect(skipped).toEqual(['a%b']);
  });

  it('skips a pattern containing ^, which TfClient refuses as a tf argument', () => {
    const { rules, skipped } = readTfIgnore('a^b\n');
    expect(rules).toEqual([]);
    expect(skipped).toEqual(['a^b']);
  });

  it('skips a pattern with a ! anywhere but the leading negation', () => {
    // The leading ! is a negation marker, already stripped before this check;
    // a SECOND ! inside the pattern is exactly the character TfClient refuses.
    const { rules, skipped } = readTfIgnore('a!b\n');
    expect(rules).toEqual([]);
    expect(skipped).toEqual(['a!b']);
  });

  it('a bad pattern is skipped without disabling any other line in the same file (I8)', () => {
    // One % used to make TfClient refuse EVERY argument forever on Windows,
    // because scanExclusion combined it into one shared /exclude: list. Here,
    // only the offending line is dropped -- the good rule survives.
    const { rules, skipped } = readTfIgnore('vendor\na%b\n*.dll\n');
    expect(rules).toEqual([
      { pattern: 'vendor', negated: false, anchored: false },
      { pattern: '*.dll', negated: false, anchored: false },
    ]);
    expect(skipped).toEqual(['a%b']);
  });

  it('a leading negation is not itself refused', () => {
    const { rules, skipped } = readTfIgnore('!node_modules\n');
    expect(rules).toEqual([{ pattern: 'node_modules', negated: true, anchored: false }]);
    expect(skipped).toEqual([]);
  });
});

describe('combineIgnoreSources -- merge order and the !node_modules question', () => {
  it('falls back to a plain IgnoreMatcher when no .tfignore was found', () => {
    const combined = combineIgnoreSources(DEFAULT_IGNORE, undefined);
    expect(combined).toBeInstanceOf(IgnoreMatcher);
    expect(combined.matches('node_modules/x.js')).toBe(true);
  });

  it('falls back the same way when a .tfignore was found but contributed nothing', () => {
    const combined = combineIgnoreSources(DEFAULT_IGNORE, {
      rules: [],
      skipped: ['# only comments and skips'],
      path: 'X/.tfignore',
      dirOffsetFromRoot: '',
    });
    expect(combined.matches('node_modules/x.js')).toBe(true);
  });

  it('a .tfignore negation really does un-ignore a built-in default -- proof for !node_modules', () => {
    // This is the deliberate design decision the task calls out: merging
    // defaults first and .tfignore patterns second means a .tfignore's own
    // negation OVERRIDES our heuristic defaults. See readTfIgnore.ts's doc
    // comment for why this is accepted deliberately rather than guarded
    // against, and what it costs (tf will enumerate the whole node_modules
    // tree once this fires).
    const { rules } = readTfIgnore('!node_modules\n');
    const combined = combineIgnoreSources(DEFAULT_IGNORE, {
      rules,
      skipped: [],
      path: 'X/.tfignore',
      dirOffsetFromRoot: '',
    });
    expect(combined.matches('node_modules/x.js')).toBe(false);
  });

  it('a negated pattern never reaches excludePatterns()', () => {
    const { rules } = readTfIgnore('!node_modules\n*.dll\n!keep.dll\n');
    const combined = combineIgnoreSources(DEFAULT_IGNORE, {
      rules,
      skipped: [],
      path: 'X/.tfignore',
      dirOffsetFromRoot: '',
    });
    const patterns = combined.excludePatterns().map((p) => p.toLowerCase());
    expect(patterns).not.toContain('node_modules');
    // *.dll is still sent to tf: nothing cancels that literal pattern text,
    // so tf will still never enumerate any .dll file, including keep.dll --
    // the in-process negation above can only resurrect a file tf itself
    // told us about. Documented in readTfIgnore.ts.
    expect(patterns).toContain('*.dll');
  });

  it('an anchored pattern never reaches excludePatterns(), even when positive', () => {
    const text = BACKSLASH + 'bin\n';
    const { rules } = readTfIgnore(text);
    const combined = combineIgnoreSources([], {
      rules,
      skipped: [],
      path: 'X/.tfignore',
      dirOffsetFromRoot: '',
    });
    expect(combined.excludePatterns()).toEqual([]);
  });

  it('lets a later anchored negation win over an earlier anchored positive', () => {
    const text = BACKSLASH + 'bin\n!' + BACKSLASH + 'bin\n';
    const { rules } = readTfIgnore(text);
    expect(rules).toEqual([
      { pattern: 'bin', negated: false, anchored: true },
      { pattern: 'bin', negated: true, anchored: true },
    ]);
    const combined = combineIgnoreSources([], {
      rules,
      skipped: [],
      path: 'X/.tfignore',
      dirOffsetFromRoot: '',
    });
    expect(combined.matches('bin/x.dll')).toBe(false);
  });

  it('lets a later anchored positive win back over an earlier anchored negation', () => {
    const text = '!' + BACKSLASH + 'bin\n' + BACKSLASH + 'bin\n';
    const { rules } = readTfIgnore(text);
    const combined = combineIgnoreSources([], {
      rules,
      skipped: [],
      path: 'X/.tfignore',
      dirOffsetFromRoot: '',
    });
    expect(combined.matches('bin/x.dll')).toBe(true);
  });

  it('is true last-wins for unanchored rules, not set-based (negation does not win regardless of order)', () => {
    // !keep.dll BEFORE *.dll: the negation sits first in the file, and *.dll
    // -- the broader, later, POSITIVE rule -- is the last rule that matches
    // "keep.dll". True last-wins-in-file-order must therefore hide it, same
    // as it would for any other ignore format. A set-based implementation
    // (positive && !negative) would let the negation win no matter where it
    // sits and wrongly keep it visible.
    const { rules } = readTfIgnore('!keep.dll\n*.dll\n');
    const combined = combineIgnoreSources([], {
      rules,
      skipped: [],
      path: 'X/.tfignore',
      dirOffsetFromRoot: '',
    });
    expect(combined.matches('a/keep.dll')).toBe(true);
    // A name *.dll never mentions is unaffected either way.
    expect(combined.matches('a/other.dll')).toBe(true);
  });

  it('lets a later UNANCHORED rule win over an earlier ANCHORED one, in true file order', () => {
    // \bin (anchored, positive) then !bin (UNANCHORED negation) -- the
    // unanchored negation is the LAST rule in the file, so it must decide:
    // bin/x.dll is shown. The old anchored-rules-always-win-last
    // implementation applied every anchored rule after the unanchored
    // verdict regardless of where it actually sat in the file, and got this
    // backwards -- hiding a file a parseable, later line said to show. That
    // direction fails CLOSED, which is the one thing this feature must never
    // do.
    const text = BACKSLASH + 'bin\n!bin\n';
    const { rules } = readTfIgnore(text);
    expect(rules).toEqual([
      { pattern: 'bin', negated: false, anchored: true },
      { pattern: 'bin', negated: true, anchored: false },
    ]);
    const combined = combineIgnoreSources([], {
      rules,
      skipped: [],
      path: 'X/.tfignore',
      dirOffsetFromRoot: '',
    });
    expect(combined.matches('bin/x.dll')).toBe(false);
  });

  it('lets a later ANCHORED rule win back over an earlier unanchored one', () => {
    // The symmetric case: !bin (unanchored negation) first, \bin (anchored
    // positive) last -- the anchored rule is now the last in file order, so
    // it decides, and bin/x.dll is hidden again.
    const text = '!bin\n' + BACKSLASH + 'bin\n';
    const { rules } = readTfIgnore(text);
    const combined = combineIgnoreSources([], {
      rules,
      skipped: [],
      path: 'X/.tfignore',
      dirOffsetFromRoot: '',
    });
    expect(combined.matches('bin/x.dll')).toBe(true);
  });

  it('rebases an anchored pattern when the .tfignore lives in an ancestor of the scan root', () => {
    // The .tfignore is one level above the scanned root, at "proj", and the
    // scan root is "proj/app". "\bin" anchors to "proj", so it must match
    // proj/app/../bin conceptually -- i.e. "bin" living as a SIBLING of "app"
    // is invisible from here, but "bin" living directly under "proj" (one
    // level above the scanned root, at relative path "../bin" from the
    // root) is out of the root entirely and can never appear in a
    // root-relative path anyway. What CAN happen from inside the root is
    // "proj/app/bin", whose path relative to "proj" is "app/bin" -- two
    // components, so it must NOT match a top-level anchor at "proj".
    const { rules } = readTfIgnore(text_bin());
    const combined = combineIgnoreSources([], {
      rules,
      skipped: [],
      path: 'proj/.tfignore',
      dirOffsetFromRoot: 'app',
    });
    expect(combined.matches('bin/x.dll')).toBe(false);
  });

  it('excludePatterns() is true last-wins: !node_modules then node_modules keeps it excluded', () => {
    // Kills the pre-fix implementation, which computed a static `negatedNames`
    // set and filtered every positive with that text regardless of a LATER
    // positive re-adding it -- so this order wrongly ended with node_modules
    // absent from the list tf is told to skip.
    const { rules } = readTfIgnore('!node_modules\nnode_modules\n');
    const combined = combineIgnoreSources(DEFAULT_IGNORE, {
      rules,
      skipped: [],
      path: 'X/.tfignore',
      dirOffsetFromRoot: '',
    });
    expect(combined.excludePatterns().map((p) => p.toLowerCase())).toContain('node_modules');
  });

  it('the reverse order removes it', () => {
    // Kills "negation ignored" / "positive anywhere wins" -- a mutant that
    // only ever adds and never removes would leave node_modules present here
    // too. (The static `negatedNames`-set mutant is killed by the test above,
    // "excludePatterns() is true last-wins: ... keeps it excluded", not this
    // one: that mutant already removes it in this order.)
    const { rules } = readTfIgnore('node_modules\n!node_modules\n');
    const combined = combineIgnoreSources(DEFAULT_IGNORE, {
      rules,
      skipped: [],
      path: 'X/.tfignore',
      dirOffsetFromRoot: '',
    });
    expect(combined.excludePatterns().map((p) => p.toLowerCase())).not.toContain('node_modules');
  });

  it('splits a comma-bearing default before the last-wins walk, so a negation can cancel one half of it', () => {
    // Kills a mutant that adds each default as one unsplit key: 'BIN,foo'
    // would then sit under the single key 'bin,foo', so '!foo' would find no
    // 'foo' key to remove and the negation would silently do nothing.
    const { rules } = readTfIgnore('!foo\n');
    const combined = combineIgnoreSources(['BIN,foo'], {
      rules,
      skipped: [],
      path: 'X/.tfignore',
      dirOffsetFromRoot: '',
    });
    const patterns = combined.excludePatterns().map((p) => p.toLowerCase());
    expect(patterns).toContain('bin');
    expect(patterns).not.toContain('foo');
  });

  it('!backup.zip leaves *.zip excluded, so tf never enumerates backup.zip: the scan reports notScanned, not a hazard', () => {
    // Kills a mutant that removes a pattern from `excludePatterns()` whenever
    // ANY negation matches the path, rather than only a negation matching the
    // pattern's own TEXT: 'backup.zip' never equals '*.zip' as text, so the
    // broader default must stay excluded and this must stay notScanned.
    const { rules } = readTfIgnore('!backup.zip\n');
    const combined = combineIgnoreSources(DEFAULT_IGNORE, {
      rules,
      skipped: [],
      path: 'C:/work/Proj/.tfignore',
      dirOffsetFromRoot: '',
    });
    const exclusion = scanExclusion(combined);
    const result = new ScanResult('C:/work/Proj', [], { exclusion, ignore: combined }, 'win32');
    expect(result.verdictFor('C:/work/Proj/backup.zip')).toBe('notScanned');
  });

  it('a .tfignore negation of a built-in name has nothing to remove -- built-ins join the list only after this function returns', () => {
    // combineIgnoreSources never sees '*.dll' (a built-in, not a DEFAULT_IGNORE
    // entry), so the negation below cannot touch it here.
    const { rules } = readTfIgnore('!*.dll\n');
    const combined = combineIgnoreSources(DEFAULT_IGNORE, {
      rules,
      skipped: [],
      path: 'X/.tfignore',
      dirOffsetFromRoot: '',
    });
    expect(combined.excludePatterns().map((p) => p.toLowerCase())).not.toContain('*.dll');

    // scanExclusion adds TF_BUILTIN_EXCLUSIONS unconditionally afterwards, so
    // the negation above has no effect on the list tf actually receives.
    const exclusion = scanExclusion(combined);
    expect(exclusion.excludePatterns().map((p) => p.toLowerCase())).toContain('*.dll');
  });
});

function text_bin(): string {
  return BACKSLASH + 'bin\n';
}

describe('findTfIgnore -- the thin, non-pure reader and directory walk', () => {
  const dirs: string[] = [];
  function tempDir(prefix: string): string {
    const d = mkdtempSync(join(tmpdir(), prefix));
    dirs.push(d);
    return d;
  }
  afterEach(() => {
    while (dirs.length) {
      const d = dirs.pop()!;
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('finds a .tfignore directly in the given directory', () => {
    const root = tempDir('tfignore-here-');
    writeFileSync(join(root, '.tfignore'), 'node_modules\n', 'utf8');
    const loaded = findTfIgnore(root);
    expect(loaded).toBeDefined();
    expect(loaded!.dirOffsetFromRoot).toBe('');
    expect(loaded!.rules).toEqual([{ pattern: 'node_modules', negated: false, anchored: false }]);
  });

  it('walks up to find a .tfignore in an ancestor, and records the offset', () => {
    const top = tempDir('tfignore-up-');
    writeFileSync(join(top, '.tfignore'), 'vendor\n', 'utf8');
    const nested = join(top, 'a', 'b');
    mkdirSync(nested, { recursive: true });
    const loaded = findTfIgnore(nested);
    expect(loaded).toBeDefined();
    expect(loaded!.dirOffsetFromRoot).toBe('a/b');
  });

  it('honours the NEAREST ancestor .tfignore, not the furthest one', () => {
    // Two .tfignore files in the same lineage: one at "top" (vendor) and one
    // closer in, at "top/a" (node_modules). Walking from "top/a/b" must stop
    // at the first one it meets going upward -- "top/a" -- and never keep
    // going to see "top" is also there. A implementation that kept walking
    // past a hit and returned the FURTHEST .tfignore instead would read the
    // wrong rules and record the wrong `dirOffsetFromRoot`, and nothing else
    // in this suite has two `.tfignore`s in one lineage to catch it.
    const top = tempDir('tfignore-nearest-');
    writeFileSync(join(top, '.tfignore'), 'vendor\n', 'utf8');
    const a = join(top, 'a');
    mkdirSync(a, { recursive: true });
    writeFileSync(join(a, '.tfignore'), 'node_modules\n', 'utf8');
    const nested = join(a, 'b');
    mkdirSync(nested, { recursive: true });

    const loaded = findTfIgnore(nested);

    expect(loaded).toBeDefined();
    expect(loaded!.path).toBe(join(a, '.tfignore'));
    expect(loaded!.rules).toEqual([
      { pattern: 'node_modules', negated: false, anchored: false },
    ]);
    expect(loaded!.dirOffsetFromRoot).toBe('b');
  });

  it('returns undefined when no .tfignore exists on the way up', () => {
    // No fixture, no .tfignore anywhere in a throwaway temp tree -- matches
    // the plan's own note that neither real machine has one either. This
    // walks all the way up to the filesystem root (e.g. "C:\" on Windows)
    // before giving up, so it would start seeing a REAL .tfignore -- and this
    // test would start failing, since none is supposed to exist -- if anyone
    // ever created one directly at the drive root.
    const root = tempDir('tfignore-none-');
    const loaded = findTfIgnore(root);
    expect(loaded).toBeUndefined();
  });

  it('fails open when ".tfignore" is a directory rather than a file', () => {
    const root = tempDir('tfignore-dir-');
    mkdirSync(join(root, '.tfignore'));
    const loaded = findTfIgnore(root);
    expect(loaded).toBeUndefined();
  });

  it('does not fall through to an ancestor when .tfignore is a directory, even when a real one exists above it', () => {
    // The doc comment always promised this ("does NOT continue to an
    // ancestor"); the old code fell through instead, silently picking up the
    // PARENT's .tfignore -- the wrong file governing the wrong directory.
    const parent = tempDir('tfignore-dir-parent-');
    writeFileSync(join(parent, '.tfignore'), 'vendor\n', 'utf8');
    const child = join(parent, 'child');
    mkdirSync(child);
    mkdirSync(join(child, '.tfignore'));
    const loaded = findTfIgnore(child);
    expect(loaded).toBeUndefined();
  });

  it('decodes a UTF-16 LE file by its BOM', () => {
    // Built as bytes in code, never typed as a literal escape sequence in
    // this source file -- see the file-level comment on BACKSLASH about the
    // Write/Edit layer mangling control characters.
    const root = tempDir('tfignore-utf16le-');
    const text = 'vendor\r\n';
    const bom = Buffer.from([0xff, 0xfe]);
    const body = Buffer.from(text, 'utf16le');
    writeFileSync(join(root, '.tfignore'), Buffer.concat([bom, body]));

    const loaded = findTfIgnore(root);
    expect(loaded).toBeDefined();
    expect(loaded!.rules).toEqual([{ pattern: 'vendor', negated: false, anchored: false }]);
  });

  it('decodes a UTF-16 BE file by its BOM', () => {
    const root = tempDir('tfignore-utf16be-');
    const text = 'vendor\r\n';
    const le = Buffer.from(text, 'utf16le');
    const be = Buffer.alloc(le.length);
    for (let i = 0; i + 1 < le.length; i += 2) {
      be[i] = le[i + 1];
      be[i + 1] = le[i];
    }
    const bom = Buffer.from([0xfe, 0xff]);
    writeFileSync(join(root, '.tfignore'), Buffer.concat([bom, be]));

    const loaded = findTfIgnore(root);
    expect(loaded).toBeDefined();
    expect(loaded!.rules).toEqual([{ pattern: 'vendor', negated: false, anchored: false }]);
  });

  it('strips a UTF-8 BOM explicitly, rather than relying on trim()', () => {
    const root = tempDir('tfignore-utf8bom-');
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    const body = Buffer.from('vendor\r\n', 'utf8');
    writeFileSync(join(root, '.tfignore'), Buffer.concat([bom, body]));

    const loaded = findTfIgnore(root);
    expect(loaded).toBeDefined();
    expect(loaded!.rules).toEqual([{ pattern: 'vendor', negated: false, anchored: false }]);
  });

  it('does not look above stopDir when given', () => {
    const top = tempDir('tfignore-stopdir-');
    writeFileSync(join(top, '.tfignore'), 'vendor\n', 'utf8');
    const a = join(top, 'a');
    mkdirSync(a, { recursive: true });
    const nested = join(a, 'b');
    mkdirSync(nested, { recursive: true });

    // Sanity: without a stopDir, the walk reaches "top" and finds it.
    expect(findTfIgnore(nested)).toBeDefined();
    // With stopDir "a", the walk must stop there and never reach "top".
    expect(findTfIgnore(nested, a)).toBeUndefined();
  });

  it.skipIf(process.platform !== 'win32')(
    'does not look above stopDir when start and stop differ only by drive-letter case (win32, review item 1)',
    () => {
      // VS Code's real Uri.fsPath lowercases the drive letter ("c:\...");
      // PathMapper.localRootFor hands back tf's own spelling of a
      // WorkingFolder's local path, which is often uppercase ("C:\..."). A
      // case-SENSITIVE `dir === resolvedStop` never matches in that case, so
      // the walk sailed straight past the intended stop and read the
      // parent's .tfignore instead.
      const top = tempDir('tfignore-stopdir-case-');
      writeFileSync(join(top, '.tfignore'), 'vendor\n', 'utf8');
      const a = join(top, 'a');
      mkdirSync(a, { recursive: true });
      const nested = join(a, 'b');
      mkdirSync(nested, { recursive: true });

      const lowerNested = nested.charAt(0).toLowerCase() + nested.slice(1);
      const upperStop = a.charAt(0).toUpperCase() + a.slice(1);

      expect(findTfIgnore(lowerNested, upperStop)).toBeUndefined();
    },
  );

  it('still finds a .tfignore living exactly at stopDir (the bound is inclusive)', () => {
    const top = tempDir('tfignore-stopdir-at-');
    const a = join(top, 'a');
    mkdirSync(a, { recursive: true });
    writeFileSync(join(a, '.tfignore'), 'vendor\n', 'utf8');
    const nested = join(a, 'b');
    mkdirSync(nested, { recursive: true });

    const loaded = findTfIgnore(nested, a);
    expect(loaded).toBeDefined();
    expect(loaded!.dirOffsetFromRoot).toBe('b');
  });
});

describe('buildIgnorer: the .tfignore actually reaches the matcher', () => {
  /**
   * A lifecycle test can prove a `.tfignore` was READ -- the output channel
   * says so -- but not that it was USED. `buildIgnorer` logs from
   * `findTfIgnore`'s result BEFORE `combineIgnoreSources` is called, so
   * replacing the loaded file with `undefined` at that call left the entire
   * suite green: the feature was disabled at its own call site and nothing
   * noticed.
   *
   * These assert on the returned `Ignorer` instead, which is the only signal
   * reachable without a successful `tf` call.
   */
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tfvc-buildignorer-'));
    for (const k of Object.keys(configValues)) delete configValues[k];
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    for (const k of Object.keys(configValues)) delete configValues[k];
  });

  const sink = { appendLine: () => {} } as never;

  it('honours a pattern the .tfignore adds', () => {
    writeFileSync(join(dir, '.tfignore'), 'vendor\r\n', 'utf8');
    expect(buildIgnorer(dir, sink).matches('vendor/x.dll')).toBe(true);
  });

  it('honours a negation that cancels a built-in default', () => {
    // The deliberate `!node_modules` decision: a project author's explicit
    // statement about their own tree beats our default. The cost is real --
    // tf then walks the whole tree again -- and it is the caller's to accept.
    writeFileSync(join(dir, '.tfignore'), '!node_modules\r\n', 'utf8');
    const ignorer = buildIgnorer(dir, sink);
    expect(ignorer.matches('src/node_modules/x.js')).toBe(false);
    expect(ignorer.excludePatterns().map((p) => p.toLowerCase())).not.toContain('node_modules');
  });

  it('still applies the built-in defaults when there is no .tfignore', () => {
    expect(buildIgnorer(dir, sink).matches('src/node_modules/x.js')).toBe(true);
  });

  it('normalises teamExplorer.ignore: drops non-strings (with a count), trims, strips a trailing separator, and drops anything still unsafe', () => {
    configValues['teamExplorer.ignore'] = [null, ' node_modules ', 'src/gen', 'a%b'];
    const log: string[] = [];
    const ignorer = buildIgnorer(dir, { appendLine: (l: string) => log.push(l) } as never);

    // 'node_modules' is the only entry that survives normalisation.
    expect(ignorer.matches('x/node_modules/y')).toBe(true);
    expect(ignorer.excludePatterns().map((p) => p.toLowerCase())).toEqual(['node_modules']);

    expect(log.some((l) => l.includes('1') && l.toLowerCase().includes('non-string'))).toBe(true);
    expect(log.some((l) => l.includes('src/gen'))).toBe(true);
    expect(log.some((l) => l.includes('a%b'))).toBe(true);
  });

  it('strips a trailing slash from a setting entry, the same as a .tfignore rule', () => {
    configValues['teamExplorer.ignore'] = ['.idea/'];
    const ignorer = buildIgnorer(dir, sink);
    expect(ignorer.matches('proj/.idea/workspace.xml')).toBe(true);
  });

  it('logs again when only the skipped-line content changes, not just the rule count', () => {
    // A summary keyed on "path + rule count" alone would see 1 rule before
    // and 1 rule after here and never notice the skipped line changed.
    const logState: { lastTfIgnoreKey?: string } = {};
    const first: string[] = [];
    writeFileSync(join(dir, '.tfignore'), 'vendor\nsrc/bin\n', 'utf8');
    buildIgnorer(dir, { appendLine: (l: string) => first.push(l) } as never, { logState });
    expect(first.some((l) => l.includes('src/bin'))).toBe(true);

    const second: string[] = [];
    writeFileSync(join(dir, '.tfignore'), 'vendor\nsrc/other\n', 'utf8');
    buildIgnorer(dir, { appendLine: (l: string) => second.push(l) } as never, { logState });
    expect(second.some((l) => l.includes('src/other'))).toBe(true);
  });

  it('does not repeat the same summary on the same logState when nothing changed', () => {
    writeFileSync(join(dir, '.tfignore'), 'vendor\n', 'utf8');
    const logState: { lastTfIgnoreKey?: string } = {};
    const first: string[] = [];
    buildIgnorer(dir, { appendLine: (l: string) => first.push(l) } as never, { logState });
    const second: string[] = [];
    buildIgnorer(dir, { appendLine: (l: string) => second.push(l) } as never, { logState });
    expect(first.length).toBeGreaterThan(0);
    expect(second).toEqual([]);
  });

  // "A second activation logs again" moved to lifecycle.test.ts
  // (describe('activate(): per-activation .tfignore log state ...')): passing
  // two hand-built fresh objects here only proved buildIgnorer's OWN dedup
  // resets with a fresh object, never that activate() actually constructs a
  // fresh one on every call -- moving `tfIgnoreLogState` to module scope in
  // extension.ts left this version green.

  it('drops setting entries containing any control character below U+0020, so a NUL cannot reach tf and crash spawn (review item 2)', () => {
    const nul = String.fromCharCode(0);
    const unitSep = String.fromCharCode(0x1f);
    const bad = ['a' + nul + 'b', 'a\tb', 'q' + unitSep];
    // Sanity check on the fixture itself, so a future accidental "cleanup" of
    // these literals cannot quietly turn this into a no-op test.
    for (const s of bad) {
      expect([...s].some((ch) => ch.charCodeAt(0) < 0x20), s).toBe(true);
    }

    configValues['teamExplorer.ignore'] = bad;
    const log: string[] = [];
    const ignorer = buildIgnorer(dir, { appendLine: (l: string) => log.push(l) } as never);

    expect(ignorer.excludePatterns()).toEqual([]);
    for (const entry of bad) {
      expect(log.some((l) => l.includes(entry)), entry).toBe(true);
    }
  });

  it('does not repeat the "dropped" setting log lines on every call when the setting has not changed (review item 6)', () => {
    // startScan() rebuilds the ignorer on every scan (every 0.8-20 s); an
    // unconditional line here would repeat the same complaint about a
    // persistently bad setting forever, the same problem the .tfignore
    // summary already solved.
    configValues['teamExplorer.ignore'] = [null, 'src/gen'];
    const logState = {};
    const first: string[] = [];
    buildIgnorer(dir, { appendLine: (l: string) => first.push(l) } as never, { logState });
    expect(first.length).toBeGreaterThan(0);

    const second: string[] = [];
    buildIgnorer(dir, { appendLine: (l: string) => second.push(l) } as never, { logState });
    expect(second).toEqual([]);
  });

  it('logs the setting issues again once they change, even on the same logState', () => {
    const logState = {};
    configValues['teamExplorer.ignore'] = ['src/gen'];
    const first: string[] = [];
    buildIgnorer(dir, { appendLine: (l: string) => first.push(l) } as never, { logState });
    expect(first.some((l) => l.includes('src/gen'))).toBe(true);

    configValues['teamExplorer.ignore'] = ['a%b'];
    const second: string[] = [];
    buildIgnorer(dir, { appendLine: (l: string) => second.push(l) } as never, { logState });
    expect(second.some((l) => l.includes('a%b'))).toBe(true);
  });

  it('respects an explicit stopDir, passed through to findTfIgnore', () => {
    // The .tfignore lives one level above `dir`; without a stopDir it would
    // be found (matching findTfIgnore's own ancestor-walk tests), but a
    // stopDir at `dir` itself must stop the walk before it gets there.
    const above = dir;
    const nested = join(dir, 'nested');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(above, '.tfignore'), 'vendor\n', 'utf8');

    const withoutStop = buildIgnorer(nested, sink);
    expect(withoutStop.matches('vendor/x.js')).toBe(true);

    const withStop = buildIgnorer(nested, sink, { stopDir: nested });
    expect(withStop.matches('vendor/x.js')).toBe(false);
  });
});
