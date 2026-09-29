import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * What the .vsix would actually contain.
 *
 * `.vscodeignore` was a DENYLIST, so every new file at the repo root shipped by
 * default. HANDOFF.md, a private planning file, did: it once shipped this way
 * and carried machine details. Nothing failed, because nothing looked.
 *
 * The first version of this file got vsce's matching wrong and passed anyway.
 * It modelled the ignore patterns literally, so `!dist/` looked like a no-op -
 * but vsce EXPANDS every pattern `p` into `p` and `p/**`, so that line
 * re-included the whole directory and the real .vsix shipped a 485 KB source
 * map containing the text of every source file. Running `vsce package` is what
 * found it; this test had certified the opposite.
 *
 * So `expand` below reproduces that rule specifically, and the expected file
 * list is checked against real `vsce package` output rather than derived.
 */

const ROOT = join(__dirname, '../..');

/**
 * vsce packs the working tree minus these. node_modules would carry runtime
 * dependencies if there were any; this extension bundles with esbuild and
 * declares none, so excluding it here does not hide a shipped file.
 */
const SKIP_DIRS = new Set(['.git', 'node_modules', '.claude']);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) {
      if (SKIP_DIRS.has(entry)) continue;
      walk(abs, out);
    } else {
      out.push(relative(ROOT, abs).split(sep).join('/'));
    }
  }
  return out;
}

/**
 * The glob subset .vscodeignore is allowed to use: literal segments, `*` within
 * a segment, and `**` spanning segments. A pattern using anything else would
 * silently match nothing here and make every assertion below vacuous.
 */
function usesOnlySupportedSyntax(pattern: string): boolean {
  return /^!?[A-Za-z0-9_./*-]+$/.test(pattern);
}

/**
 * vsce's own expansion, from its package.ts: any pattern whose last segment
 * contains no `*` also matches everything beneath it.
 *
 *   'foo/bar'  ->  ['foo/bar', 'foo/bar/**']
 *   'foo/'     ->  ['foo/',    'foo/**']
 *   '**'       ->  ['**']                      (last segment has a *)
 *
 * This is the rule that made `!dist/` re-include the source map.
 */
function expand(patterns: string[]): string[] {
  const derived = patterns
    .filter((p) => !/(^|\/)[^/]*\*[^/]*$/.test(p))
    .map((p) => (p.endsWith('/') ? `${p}**` : `${p}/**`));
  return [...patterns, ...derived];
}

const GLOBSTAR = '@@GLOBSTAR@@';

function toRegExp(pattern: string): RegExp {
  const body = pattern
    .split('/')
    .map((seg) =>
      seg === '**'
        ? GLOBSTAR
        : seg.replace(/[.+^${}()|[\]\\?]/g, '\\$&').replace(/\*/g, '[^/]*'),
    )
    .join('/')
    // `a/**/b` must match `a/b` too, and a leading or trailing `**` may match
    // nothing at all - otherwise `**` would not match a file at the root.
    .split(`/${GLOBSTAR}/`)
    .join('(?:/.*)?/')
    .replace(new RegExp(`^${GLOBSTAR}/`), '(?:.*/)?')
    .replace(new RegExp(`/${GLOBSTAR}$`), '(?:/.*)?')
    .split(GLOBSTAR)
    .join('.*');
  return new RegExp(`^${body}$`);
}

function patterns(): string[] {
  return readFileSync(join(ROOT, '.vscodeignore'), 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'));
}

/**
 * vsce's rule: a file ships when it matches NO ignore pattern, OR matches any
 * `!` pattern. The `!` lines always win wherever they appear in the file - this
 * is not gitignore's last-match-wins.
 */
function shippedFiles(): string[] {
  const all = expand(patterns());
  const ignore = all.filter((p) => !p.startsWith('!')).map(toRegExp);
  const include = all.filter((p) => p.startsWith('!')).map((p) => toRegExp(p.slice(1)));
  return walk(ROOT)
    .filter((f) => !ignore.some((re) => re.test(f)) || include.some((re) => re.test(f)))
    .sort();
}

describe('.vscodeignore', () => {
  it('uses only syntax this test can actually evaluate', () => {
    // Without this, the tests below can pass by matching nothing at all.
    const unsupported = patterns().filter((p) => !usesOnlySupportedSyntax(p));
    expect(unsupported, 'extend toRegExp before using these').toEqual([]);
  });

  it("ships the bundle, the manifest and the two tabs' media, and NOTHING else", () => {
    // A .vsix cannot exist without the bundle, so this needs a built tree.
    // Without the guard the failure reads as "the allowlist is wrong" rather
    // than "you did not build" - which is what it looked like the first time
    // this suite was run on Linux.
    expect(
      readdirSync(join(ROOT, 'dist')).includes('extension.js'),
      'run `node esbuild.mjs` first - this test inspects the real tree',
    ).toBe(true);
    // Confirmed against real `vsce package` output: the bundle, the manifest,
    // the History tab's two media files (phase 2), and the Source Control
    // Explorer's two media files plus its activity bar icon (phase 3 part 2).
    expect(shippedFiles()).toEqual([
      'CHANGELOG.md',
      'LICENSE',
      'THIRD-PARTY-NOTICES.md',
      'dist/extension.js',
      'media/conflicts.css',
      'media/conflicts.js',
      'media/explorer.css',
      'media/explorer.js',
      'media/history.css',
      'media/history.js',
      'media/icon.png',
      'media/shelvesets.css',
      'media/shelvesets.js',
      'media/team-explorer.svg',
      'package.json',
    ]);
  });

  it('re-includes no DIRECTORY, which would drag its whole contents in', () => {
    // The actual defect. `!dist/` reads like "let the walk descend here" and
    // means "ship everything under dist", because vsce expands it to
    // `!dist/**`. Name files.
    // LICENSE is the one deliberate exception: a real file, by GitHub's own
    // naming convention, that carries no extension.
    const reincludedDirs = patterns()
      .filter((p) => p.startsWith('!'))
      .filter((p) => p !== '!LICENSE')
      .filter((p) => p.endsWith('/') || !/\.[A-Za-z0-9]+$/.test(p));

    expect(reincludedDirs, 'name the files instead').toEqual([]);
  });

  it('ships no Markdown except the changelog and the notices', () => {
    // HANDOFF.md once shipped this way, carrying a machine's address. The
    // Details tab's readme is added by vsce from --readme-path, not by this list.
    expect(shippedFiles().filter((f) => f.endsWith('.md'))).toEqual(['CHANGELOG.md', 'THIRD-PARTY-NOTICES.md']);
  });

  it('does not ship the source map, which embeds every source file verbatim', () => {
    // This assertion passed while the real .vsix contained the map. It is only
    // worth anything now that `expand` models what vsce actually does.
    expect(shippedFiles().filter((f) => f.endsWith('.map'))).toEqual([]);
  });

  it('is an allowlist: the first pattern excludes everything', () => {
    // The regression that matters is going back to naming what to leave out,
    // because then the next new file ships by default.
    expect(patterns()[0]).toBe('**');
  });
});
