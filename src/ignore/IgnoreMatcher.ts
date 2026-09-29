/**
 * tf 17.14's own default exclusion list, as the real client prints it
 * (measured on DEVPC 2026-09-17).
 *
 * The scan runs with `/noignore`, which turns off tf's own copy of this list
 * along with everything else it would otherwise apply silently -- a subfolder
 * `.tfignore`, hidden defaults like `*.vspscc` (test/fixtures/README.md
 * finding 19). `scanExclusion` below passes this list back explicitly in
 * `/exclude:`, so tf still skips these paths -- because we told it to.
 */
export const TF_BUILTIN_EXCLUSIONS: readonly string[] = [
  '*.cache', '*.exe', 'bin', 'Debug', '*.dll', '*.lib', '*.log', '*.ncb',
  'obj', '*.obj', '*.opensdf', '*.ilk', '*.pch', '*.user', 'Release',
  '*.tmp', '*.sdf', '*.suo', '*.swp', '*.pdb', 'TestResults', '*.tlog',
];

/**
 * What tf's list misses, and what actually caused the noise.
 *
 * In one real project's raw scan output, 6,950 of 6,974 folders were
 * `node_modules` (measured on DEVPC 2026-09-17 against WebOrders), and tf
 * excludes none of it. `nul` is here for a sharper reason: three real files
 * with that name exist in this collection, Windows resolves them to the NUL
 * device, and each one makes the entire scan exit 100 with no usable output.
 */
export const DEFAULT_IGNORE: readonly string[] = [
  'node_modules', 'packages', 'nul',
  '.git', '.vs', '.svn', '.angular', '.nuxt', '.next',
  'dist', 'bower_components',
  '*.zip', '*.msi', '*.bak', 'thumbs.db', 'desktop.ini',
];

/**
 * `*` and `?` only, anchored to a whole path component.
 *
 * Not exported: `readTfIgnore.ts` matches an ANCHORED `.tfignore` pattern by
 * building its own `new IgnoreMatcher([pattern])` and calling `.matches()`
 * on it, rather than by calling this function directly. That keeps there
 * being exactly one caller of this escaping/case-folding rule, so the two
 * places can never quietly diverge in what a comma, or anything else, means.
 */
function toRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped.replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');
}

/**
 * Decides whether a path is ours to talk about.
 *
 * Matches by NAME against every component, which is what `tf /exclude:` does --
 * one `node_modules` entry therefore covers every project in the collection
 * rather than one directory.
 *
 * Case-insensitive throughout: Windows filesystems are case-insensitive and tf
 * echoes back whatever spelling is on disk, so `Thumbs.DB` and `thumbs.db` name
 * one file and must match the same rule. (Whether a drive letter's case varies
 * is a separate, also-real fact -- see `ScanResult.norm` -- but irrelevant here:
 * `matches()` only ever sees a relative path with the root already stripped, so
 * a drive letter is never one of the components these rules test.)
 */
export class IgnoreMatcher {
  /**
   * The patterns this matcher actually uses, after normalising the caller's
   * input: `tf /exclude:` reads its argument as a comma-separated list, so a
   * pattern containing a comma is not one rule to tf, it is two. Splitting on
   * `,` here -- once, before building either the local rules or the argument
   * string -- means both are derived from the same list and therefore agree
   * about what a comma means, by construction rather than by coincidence.
   * Empty segments (from `''`, a trailing comma, or `['', 'foo']`) are dropped
   * so they cannot become a rule that matches nothing, or a bare `/exclude:`
   * with nothing after it.
   */
  private readonly patterns: readonly string[];
  private readonly rules: RegExp[];

  constructor(patterns: readonly string[]) {
    // Each comma-separated part is trimmed too: "a, b" is common shorthand
    // for two patterns, and without this a leading space survived into the
    // second one, producing a pattern ("` b`") that could never match a real
    // file name.
    this.patterns = patterns
      .flatMap((p) => p.split(',').map((s) => s.trim()))
      .filter((p) => p !== '');
    this.rules = this.patterns.map(toRegExp);
  }

  /**
   * Whether any component of a path matches.
   *
   * The caller must pass a `/`-separated, root-relative path (what
   * `ScanResult.relative` produces). This class is deliberately platform-blind
   * and does not normalise backslashes: on Linux, `foo\bar` is a legal single
   * file name, and splitting on `\` would be wrong there.
   */
  matches(relativePath: string): boolean {
    const parts = relativePath.split('/').filter((p) => p !== '');
    return parts.some((part) => this.rules.some((r) => r.test(part)));
  }

  /**
   * The plain name patterns, normalised (comma-split, empty entries dropped) --
   * what `scanExclusion` below combines with `TF_BUILTIN_EXCLUSIONS`. Kept
   * separate from the `/exclude:` argument string so that combining lives in
   * one place, `scanExclusion`. This does NOT mean there is only one
   * de-duplication pass: `combineIgnoreSources`, upstream of this, folds a
   * `.tfignore`'s own rules keeping the LAST spelling (true last-wins);
   * `scanExclusion` then folds those results against `TF_BUILTIN_EXCLUSIONS`
   * keeping the FIRST spelling (a built-in's casing wins). Two different
   * rules for two different questions.
   */
  excludePatterns(): readonly string[] {
    return this.patterns;
  }

  /**
   * The `/exclude:` argument for THIS matcher's own patterns alone, or
   * undefined when there is nothing to exclude. Used by `scanExclusion`,
   * which builds one `IgnoreMatcher` from the combined built-in + ignorer
   * pattern list and calls this on it -- so the comma-joining and the
   * empty-list check live in exactly one place.
   */
  excludeArgument(): string | undefined {
    if (this.patterns.length === 0) return undefined;
    return `/exclude:${this.patterns.join(',')}`;
  }
}

/**
 * What a caller needs to filter a scan and to know what tf was told to skip.
 *
 * Lives here, not in `readTfIgnore.ts`, even though `combineIgnoreSources` is
 * the only thing that builds one: this is the general matches()/excludePatterns()
 * abstraction, and `IgnoreMatcher` itself is one implementation of it (the
 * `.tfignore`-free case just returns `new IgnoreMatcher(defaults)` directly).
 * Several other files import this type and none of them care about `.tfignore`
 * at all -- they only need something that can answer "is this path ours to
 * talk about" and "what plain names does it stand for", which belongs next to
 * `IgnoreMatcher`, not next to the reader for one specific source of rules.
 *
 * No `excludeArgument()` here: building the `/exclude:` string is
 * `scanExclusion`'s job, because it must combine `TF_BUILTIN_EXCLUSIONS` with
 * this list before joining -- an `Ignorer` alone does not know about the
 * built-ins.
 */
export interface Ignorer {
  matches(relativePath: string): boolean;
  excludePatterns(): readonly string[];
}

/**
 * `TF_BUILTIN_EXCLUSIONS` followed by `ignorer`'s own patterns, list order
 * preserved, de-duplicated case-insensitively keeping the FIRST spelling seen
 * -- a built-in's casing wins over a `.tfignore` or setting entry that merely
 * repeats it. This is where tf's own 22 join the exclusion list: the scan
 * runs with `/noignore`, so they must reach `/exclude:` explicitly
 * (test/fixtures/README.md finding 19).
 *
 * The ONE place `UnversionedScan`, `ScanResult`'s tests and `readTfIgnore`'s
 * tests all build this list, so a caller can never accidentally rebuild it
 * with the built-ins missing, duplicated, or in the wrong matcher slot.
 */
export function scanExclusion(ignorer: Ignorer): IgnoreMatcher {
  const seen = new Set<string>();
  const combined: string[] = [];
  for (const p of [...TF_BUILTIN_EXCLUSIONS, ...ignorer.excludePatterns()]) {
    const key = p.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    combined.push(p);
  }
  return new IgnoreMatcher(combined);
}
