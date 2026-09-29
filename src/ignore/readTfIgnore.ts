import * as fs from 'node:fs';
import * as path from 'node:path';
import { IgnoreMatcher, type Ignorer } from './IgnoreMatcher.js';
import { findUnsafeArgs } from '../tf/TfClient.js';

/**
 * Reads a `.tfignore`, if the workspace has one -- read-only, always. Nothing
 * in this file ever creates, writes to, or deletes a `.tfignore`: it is
 * shared with Visual Studio and with the other machine, and CLAUDE.md forbids
 * disturbing either's view of it.
 *
 * The scan itself runs with `/noignore` (see `IgnoreMatcher.ts`), so tf's own
 * handling of ANY `.tfignore` -- this one or a subfolder's -- no longer
 * affects which files the scan reports on. This module's output now only
 * decides our own `ignored` flag, which group a row appears in, and which
 * names this extension excludes from its own walk.
 *
 * SUPPORTED SUBSET (anything else is skipped -- see `parseLine` below):
 *   - one glob per line, using the same `*`/`?` syntax as `IgnoreMatcher`
 *     (case-insensitive, matched against a whole path component's name);
 *   - blank lines and full-line `#` comments;
 *   - a leading `!` negates the pattern -- the LAST matching rule in file
 *     order decides, same as every other ignore format;
 *   - a leading `\` anchors the pattern to the `.tfignore`'s OWN directory:
 *     `\bin` matches `<dir>/bin` and everything under it, but not
 *     `<dir>/src/bin`. This is a deliberate simplification and does NOT match
 *     real gitignore/.tfignore backslash-escaping semantics (where a leading
 *     `\` escapes a literal `#`/`!`) -- it was chosen for this task because
 *     the alternative, silently reinterpreting an ambiguous line, is the one
 *     thing this file must never do;
 *   - a SINGLE trailing `/` or `\` is stripped before anything else is
 *     checked: `.idea/` is the plain name `.idea`, and an anchored
 *     `\build/`-style rule becomes anchored `build`. This is the most common
 *     REAL form of a folder rule (Visual Studio and every gitignore-alike
 *     write it this way; a real `.tfignore` on DEVPC uses it for
 *     `.claude/`, `.idea/`, `.screenshots/`, `.dart_tool/`).
 *
 * Everything else -- a pattern with an embedded `/` or a second `\` (a path
 * pattern our name-only matcher cannot honestly represent), a character
 * class (`[abc]`), a globstar (`**`), a comma (which `tf /exclude:` and
 * `IgnoreMatcher`'s constructor both read as a separator between TWO
 * patterns, not a literal character in one filename), a bare `!`/`\` with
 * nothing after it, a character `TfClient` refuses as a tf argument (`%`,
 * `^`, a `!` anywhere but the leading negation already stripped, CR, LF), or
 * any control character (below U+0020) anywhere in the line -- is
 * UNPARSEABLE and is skipped rather than guessed at. Skipping FAILS OPEN: a
 * skipped line hides nothing, so at worst a file is shown that the user did
 * not need to see. Guessing wrong in the other direction -- hiding a file
 * the user needed to check in -- is the failure this whole feature exists to
 * avoid. A pattern containing a comma (`my,file.txt`) is exactly that wrong
 * guess: accepted as a single glob, it silently becomes two rules (`my` and
 * `file.txt`) that hide every file with either name, while never hiding the
 * file actually named. A refused character is a sharper version of the same
 * failure: unskipped, it would reach `TfClient.run()` and make it refuse the
 * WHOLE `/exclude:` argument, silently disabling the scan for every pattern,
 * not just this one (I8) -- one bad line must never do that.
 */

/** One successfully parsed line. */
export interface TfIgnoreRule {
  /** The glob text itself, with any leading `!`/`\` already stripped. */
  readonly pattern: string;
  readonly negated: boolean;
  readonly anchored: boolean;
}

export interface ParsedTfIgnore {
  readonly rules: readonly TfIgnoreRule[];
  /** Raw (trimmed) source lines that were skipped, for the caller to log. */
  readonly skipped: readonly string[];
}

type LineResult = TfIgnoreRule | 'blank' | 'skip';

/**
 * True when any character of `s` is a C0 control character (below U+0020).
 * Exported for `extension.ts`'s `teamExplorer.ignore` setting normalisation,
 * which needs the identical check for the identical reason (a NUL or other
 * control character reaching `TfClient.run()`'s argument list throws).
 */
export function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) < 0x20) return true;
  }
  return false;
}

function parseLine(rawLine: string): LineResult {
  const trimmed = rawLine.trim();
  if (trimmed === '' || trimmed.startsWith('#')) return 'blank';

  // Checked on the TRIMMED line, not the raw one: a leading/trailing TAB is
  // ordinary whitespace around an otherwise good rule ("\tvendor\t") and must
  // not make it vanish. A NUL (the realistic cause, from a UTF-16 file once
  // misread) is not something `trim()` removes -- it is not in the Unicode
  // White_Space set -- so one anywhere in the middle of the line still
  // survives trimming and is still caught here, before it ever reaches
  // `TfClient.run()` and throws.
  if (hasControlChar(trimmed)) return 'skip';

  let rest = trimmed;
  let negated = false;
  if (rest.startsWith('!')) {
    negated = true;
    rest = rest.slice(1);
  }

  let anchored = false;
  if (rest.startsWith('\\')) {
    anchored = true;
    rest = rest.slice(1);
  }

  // A single trailing separator is stripped before anything else is checked:
  // ".idea/" is the plain name ".idea", and an anchored "\build/" becomes
  // anchored "build". Only ONE is stripped -- "a/b/" becomes "a/b", which
  // still contains an embedded separator and is skipped below, same as today.
  if (rest.endsWith('/') || rest.endsWith('\\')) {
    rest = rest.slice(0, -1);
  }

  // An embedded slash or a second backslash is a path pattern (or an escape)
  // this name-only matcher cannot honestly represent. A character class or a
  // globstar is likewise outside the documented subset. A comma is here for a
  // different reason: it parses cleanly as a glob, but both `tf /exclude:`
  // and `IgnoreMatcher`'s constructor treat it as a separator between two
  // patterns, not a literal character, so `my,file.txt` would silently become
  // two rules that hide `my` and `file.txt` everywhere while never hiding the
  // file actually named -- commas are legal and common in real Windows
  // filenames. Guessing at any of these is exactly the half-understood-hides-
  // a-file hazard this exists to avoid, so all of them are skipped instead.
  const unsupported =
    rest === '' ||
    rest.includes('/') ||
    rest.includes('\\') ||
    rest.includes('[') ||
    rest.includes(']') ||
    rest.includes('**') ||
    rest.includes(',');
  if (unsupported) return 'skip';

  // A pattern TfClient itself would refuse as a tf argument (%, ^, a bare !
  // anywhere but the leading negation already stripped above, CR, LF) must
  // never reach `/exclude:` -- unskipped, one such line used to make
  // TfClient refuse the WHOLE combined argument, disabling the scan
  // permanently on Windows (I8). Skipping just this line keeps every other
  // rule working. `findUnsafeArgs` is the single source of truth for which
  // characters those are, shared with TfClient so the two can never drift.
  if (findUnsafeArgs([rest]).length > 0) return 'skip';

  return { pattern: rest, negated, anchored };
}

/**
 * Parses `.tfignore` TEXT into rules. Pure -- no filesystem access -- so it
 * is testable with nothing but inline strings. `findTfIgnore` below is the
 * thin, impure counterpart that actually reads a file.
 */
export function readTfIgnore(text: string): ParsedTfIgnore {
  // Visual Studio may write UTF-8 with a BOM. No special-casing is needed for
  // it here: `parseLine` trims every line before looking at it, and
  // `String.prototype.trim()` already strips a leading U+FEFF, so a BOM on
  // the first line disappears on its own before `startsWith('#')` or any
  // other check ever sees it. (Verified: `'﻿node_modules'.trim() ===
  // 'node_modules'`.) An earlier version of this function stripped the BOM
  // itself before splitting into lines; that code never did anything
  // observable and has been removed.
  const rules: TfIgnoreRule[] = [];
  const skipped: string[] = [];
  for (const rawLine of text.split(/\r\n|\r|\n/)) {
    const result = parseLine(rawLine);
    if (result === 'blank') continue;
    if (result === 'skip') {
      skipped.push(rawLine.trim());
      continue;
    }
    rules.push(result);
  }
  return { rules, skipped };
}

/** `readTfIgnore`'s result, plus where it came from and how to place it. */
export interface LoadedTfIgnore extends ParsedTfIgnore {
  readonly path: string;
  /**
   * The scan root's path relative to the DIRECTORY the `.tfignore` was found
   * in, `/`-separated, `''` when they are the same directory. Anchored rules
   * are resolved against this offset -- see `combineIgnoreSources`.
   */
  readonly dirOffsetFromRoot: string;
}

/**
 * Decodes a `.tfignore`'s raw bytes: UTF-16 by its BOM (LE or BE), UTF-8 with
 * its own BOM stripped explicitly, or plain UTF-8 otherwise. Visual Studio
 * defaults to UTF-8, but nothing stops a `.tfignore` being saved as UTF-16 by
 * hand or by a different editor -- and reading UTF-16 bytes as UTF-8 (this
 * function's predecessor, an unconditional `fs.readFileSync(path, 'utf8')`)
 * turns every other byte into a NUL, which used to reach `TfClient.run()`
 * and throw.
 */
function decodeTfIgnoreBuffer(buffer: Buffer): string {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.toString('utf16le', 2);
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    // Node has no native UTF-16 BIG-endian decoder: swap each byte pair and
    // decode the result as LITTLE-endian, the standard workaround.
    return swapUtf16Bytes(buffer.subarray(2)).toString('utf16le');
  }
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return buffer.toString('utf8', 3);
  }
  return buffer.toString('utf8');
}

function swapUtf16Bytes(buffer: Buffer): Buffer {
  const evenLength = buffer.length - (buffer.length % 2);
  const swapped = Buffer.alloc(evenLength);
  for (let i = 0; i < evenLength; i += 2) {
    swapped[i] = buffer[i + 1];
    swapped[i + 1] = buffer[i];
  }
  return swapped;
}

/**
 * Whether two already-resolved directory paths are the same directory.
 * Case-insensitive on win32 (see `findTfIgnore`'s doc comment on `stopDir`
 * for why this cannot be a plain `===`), case-sensitive on Linux.
 *
 * `process.platform` is safe here, unlike `PathMapper`, which takes an
 * explicit `platform` so it can be tested against Wine-shaped paths on
 * either OS: this function only ever compares two paths on the OS this code
 * is actually running on, both produced moments earlier by `path.resolve`
 * calls in the same process.
 */
function sameDirectory(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * The thin, non-pure half: walks from `startDir` upward looking for the
 * nearest `.tfignore`, the way `.gitignore`/`.editorconfig` discovery does,
 * because the file governing a mapped workspace folder may live in an
 * ancestor of it (e.g. at the collection root) rather than in the folder
 * itself. Only the SINGLE nearest ancestor is honoured -- a `.tfignore`
 * living in a SUBFOLDER of `startDir` is out of scope for this task. That is
 * a real, known gap, not a hypothetical one: six such files exist under
 * `C:\work` on DEVPC. It is accepted anyway because the scan now runs with
 * `/noignore` (see the module doc above) -- this walk only feeds our own
 * `ignored` flag and group filter, not tf's verdicts.
 *
 * `stopDir`, when given, bounds the walk: `.tfignore` is looked for at
 * `stopDir` itself (inclusive) but never in an ancestor of it. Compared
 * case-insensitively on win32 -- VS Code's real `Uri.fsPath` lowercases the
 * drive letter (`c:\work\Rex`) while a `WorkingFolder`'s local path (what
 * `PathMapper.localRootFor` hands back for `stopDir`) is spelled however tf
 * spells it, typically uppercase (`C:\work`); a case-sensitive `===` here
 * never matched, so the walk sailed straight past the intended stop and read
 * the parent's `.tfignore` instead. Omit `stopDir` when the caller does not
 * yet know a boundary to stop at (e.g. before the workspace mapping is
 * known).
 *
 * Fails open on every I/O surprise: missing file, a directory literally
 * named `.tfignore`, a permission error reading it, or hitting `stopDir` (or
 * the filesystem root) without finding one -- all return `undefined`, which
 * callers treat exactly like "no `.tfignore` exists". A `.tfignore` we
 * cannot read must never be treated as a `.tfignore` with nothing in it that
 * happens to hide files; it must be treated as absent. Critically, a
 * directory named `.tfignore`, or one that exists but cannot be read (ENOENT
 * is the only stat failure this walks past -- anything else, e.g. EACCES or
 * EPERM, means "there but unreadable", not "absent"), STOPS the walk right
 * there rather than falling through to an ancestor's real `.tfignore` -- that
 * ancestor's file does not govern this directory, and silently substituting
 * it would be exactly the kind of guess this module exists to avoid.
 */
export function findTfIgnore(startDir: string, stopDir?: string): LoadedTfIgnore | undefined {
  const resolvedStart = path.resolve(startDir);
  const resolvedStop = stopDir !== undefined ? path.resolve(stopDir) : undefined;
  let dir = resolvedStart;
  for (;;) {
    const candidate = path.join(dir, '.tfignore');
    let stat: fs.Stats | undefined;
    try {
      stat = fs.statSync(candidate);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return undefined; // unreadable, not absent
      stat = undefined; // ENOENT: nothing here, keep walking up.
    }
    if (stat !== undefined) {
      // Something named .tfignore exists at this level. From here on this
      // function returns, one way or another -- it never falls through to an
      // ancestor once it has found SOMETHING at this name, even a directory
      // or an unreadable file (see the doc comment above).
      if (!stat.isFile()) return undefined;
      let buffer: Buffer;
      try {
        buffer = fs.readFileSync(candidate);
      } catch {
        return undefined;
      }
      const text = decodeTfIgnoreBuffer(buffer);
      const { rules, skipped } = readTfIgnore(text);
      const rel = path.relative(dir, resolvedStart);
      const dirOffsetFromRoot = rel === '' ? '' : rel.split(path.sep).join('/');
      return { rules, skipped, path: candidate, dirOffsetFromRoot };
    }
    if (resolvedStop !== undefined && sameDirectory(dir, resolvedStop)) return undefined;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined; // reached the filesystem root
    dir = parent;
  }
}

/**
 * Merges built-in defaults with a `.tfignore`'s rules, DEFAULTS FIRST, so a
 * `.tfignore` can override a default. This is the one line of this module
 * that decides the answer to "does `!node_modules` in `.tfignore` really
 * un-ignore `node_modules`?" -- and the answer is deliberately yes.
 *
 * That is a real cost: `node_modules` is in `DEFAULT_IGNORE` precisely
 * because one real scan found 6,950 of 6,974 folders were `node_modules`,
 * and negating it here means tf will enumerate every one of them again, on
 * every scan. It is accepted anyway, for the same reason every ignore format
 * (`.gitignore`, `.dockerignore`, ...) lets a local file win over a built-in
 * default: OUR guess about what to hide is a heuristic, and a `.tfignore` is
 * the project author's explicit, on-purpose statement about their own tree.
 * Silently overruling that statement -- keeping a folder hidden because we
 * think we know better -- would be exactly the "half-understood .tfignore"
 * hazard this task exists to avoid, just aimed the other way: at HIDING
 * something the user explicitly asked to see, rather than at hiding
 * something the user needed to check in. The bias throughout this module is
 * toward showing more rather than less, and this is that bias applied to
 * defaults, not just to unparseable lines.
 *
 * `matches()` is TRUE LAST-WINS over defaults and every `.tfignore` rule
 * together, in one ordered pass: the defaults establish the baseline
 * verdict, and then each rule -- anchored or unanchored, negated or not, in
 * the order it appears in the file -- can flip that verdict if it fires for
 * the path being asked about. The LAST rule to fire decides, exactly as the
 * module doc comment above claims for every ignore format. Anchored and
 * unanchored rules differ only in what "fires" means for each (an anchored
 * rule tests just the first path component relative to the `.tfignore`'s own
 * directory; an unanchored rule tests every component), never in precedence.
 *
 * `excludePatterns()` is ALSO true last-wins, by pattern TEXT rather than by
 * path: start from `defaults` in order, then walk the UNANCHORED rules in
 * file order -- a positive rule adds its pattern text, a negated rule removes
 * every entry equal to its pattern text (case-insensitive). `!node_modules`
 * then `node_modules` therefore ends with `node_modules` present; the reverse
 * order ends with it absent. A negated rule's own text never appears as an
 * entry -- negation only removes an existing one, tf's `/exclude:` has no
 * syntax for "don't exclude this". Anchored rules are excluded from this walk
 * entirely, positive or negated: tf would apply a bare pattern everywhere,
 * not just under the `.tfignore`'s own directory, which is not what an
 * anchored rule says. A consequence worth naming: `!backup.zip` with `*.zip`
 * in `defaults` leaves `*.zip` excluded (the broader pattern's text is
 * untouched), so tf still never enumerates `backup.zip` -- the scan reports
 * it `notScanned`, not a hazard.
 *
 * `defaults` here is `DEFAULT_IGNORE`, never `TF_BUILTIN_EXCLUSIONS` -- this
 * function knows nothing about the built-ins. `scanExclusion` adds them
 * AFTER this returns, unconditionally, so a `.tfignore` negation of a
 * built-in's name (`!*.dll`) has nothing to remove here and cannot stop
 * `scanExclusion` from re-adding it: tf still never enumerates a `.dll` file,
 * and an unlisted one stays `notScanned`, absent from the group -- silence,
 * the safe direction, not a hazard.
 */
export function combineIgnoreSources(
  defaults: readonly string[],
  loaded: LoadedTfIgnore | undefined,
): Ignorer {
  if (!loaded || loaded.rules.length === 0) {
    return new IgnoreMatcher(defaults);
  }
  // Narrowed once, here: TypeScript does not carry `loaded`'s non-undefined
  // narrowing into the closure below, since a closure could in principle
  // outlive a reassignment. `found` is never reassigned, so it stays narrow.
  const found = loaded;

  const unanchored = found.rules.filter((r) => !r.anchored);

  // True last-wins BY TEXT, keyed case-insensitively: `Map.set` on a key that
  // is already present updates its value WITHOUT moving it, and only a
  // `delete` followed by a `set` moves a key to the end -- exactly what
  // last-wins needs, with no separate order/spelling bookkeeping to keep in sync.
  const exclude = new Map<string, string>();
  const add = (pattern: string): void => {
    exclude.set(pattern.toLowerCase(), pattern);
  };
  const remove = (patternText: string): void => {
    exclude.delete(patternText.toLowerCase());
  };
  // Split each default the same way `IgnoreMatcher` would, BEFORE adding: a
  // comma-bearing setting entry like `BIN,foo` is two patterns to tf, so it
  // must be two keys here too, or a later `!foo` has no `foo` key to remove.
  for (const d of new IgnoreMatcher(defaults).excludePatterns()) add(d);
  for (const r of unanchored) {
    if (r.negated) remove(r.pattern);
    else add(r.pattern);
  }

  // The baseline verdict, before any `.tfignore` rule gets a say.
  const defaultsMatcher = new IgnoreMatcher(defaults);

  // Every `.tfignore` rule, anchored and unanchored together, in the exact
  // order they appeared in the file -- this order IS the precedence. Each
  // gets its own single-pattern `IgnoreMatcher` rather than a shared
  // `toRegExp` call: that is the same glob/case-folding logic `IgnoreMatcher`
  // uses everywhere else, through its one existing caller, so an anchored
  // pattern and an unanchored one can never read a comma (or anything else)
  // differently. (No pattern reaching here contains a comma anyway, now that
  // `parseLine` skips one -- see readTfIgnore's module doc comment -- but
  // agreeing by construction is worth more than agreeing by accident.)
  const orderedRules = found.rules.map((r) => ({
    negated: r.negated,
    anchored: r.anchored,
    matcher: new IgnoreMatcher([r.pattern]),
  }));

  function firstComponentUnderTfIgnoreDir(relativePath: string): string | undefined {
    const rebased = found.dirOffsetFromRoot
      ? `${found.dirOffsetFromRoot}/${relativePath}`
      : relativePath;
    return rebased.split('/').filter((p) => p !== '')[0];
  }

  return {
    matches(relativePath: string): boolean {
      let result = defaultsMatcher.matches(relativePath);
      const first = firstComponentUnderTfIgnoreDir(relativePath);
      for (const rule of orderedRules) {
        const fires = rule.anchored
          ? first !== undefined && rule.matcher.matches(first)
          : rule.matcher.matches(relativePath);
        if (fires) result = !rule.negated;
      }
      return result;
    },
    excludePatterns(): readonly string[] {
      return [...exclude.values()];
    },
  };
}
