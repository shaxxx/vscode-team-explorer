import type { Platform } from '../tf/PathMapper.js';

/**
 * One spelling for comparison: forward slashes, and lower case on win32.
 *
 * Case folding matters on both sides of every comparison: tf.exe is
 * demonstrably inconsistent about the case it emits (one real capture mixed
 * `C:\work` 79,920 times with `c:\work` 9 times), and a caller's `root` can be
 * spelled either way regardless of platform.
 *
 * Exported so `ScanResult.key()` can call this exact function instead of
 * keeping its own copy -- a spec review of Task 5 found the two had drifted
 * into two character-identical copies of both the code and this comment.
 */
export function norm(path: string, platform: Platform): string {
  const slashed = path.replace(/\\/g, '/');
  return platform === 'win32' ? slashed.toLowerCase() : slashed;
}

/**
 * `norm(root, platform)`, with one trailing separator stripped.
 *
 * `ScanResult` canonicalises its own root once, in its constructor
 * (`canonicalRoot`), before it ever calls `relativeToRoot` -- so by the time
 * it gets here, its `root` never ends with a separator and stripping one is a
 * no-op. `DecorationProvider` does no such canonicalisation and passes
 * `folder.uri.fsPath` straight through. Measured this session against the
 * un-fixed form of this function: `relativeToRoot('C:\\', 'C:\\a.vb', 'win32')`
 * and `relativeToRoot('C:\\work\\Proj\\', 'C:\\work\\Proj\\a.vb', 'win32')`
 * both returned `undefined` -- a workspace opened at a drive root, or any
 * root spelled with a trailing separator, silently zeroed out
 * `DecorationProvider`'s ignore wiring for every file, with no error anywhere.
 * Stripping here once is cheaper and safer than asking every caller to
 * canonicalise its own root the way `ScanResult` does.
 *
 * The `length > 1` guard matches `canonicalRoot`'s own: a bare `/` (root of a
 * Linux filesystem) must not be stripped down to an empty string.
 */
function normalisedRoot(root: string, platform: Platform): string {
  const r = norm(root, platform);
  return r.length > 1 && r.endsWith('/') ? r.slice(0, -1) : r;
}

/**
 * `absolute`, relative to `root`, `/`-separated -- or `undefined` when
 * `absolute` is not under `root` at all, or only by way of a `..` component.
 *
 * Extracted from `ScanResult`'s former private `relative()` (plus the `..`
 * rejection that lived in its `coveredRelative()`), because two callers need
 * exactly this and must not drift apart:
 *
 * - `ScanResult` needs it to answer `verdictFor()` and `covered()`, comparing
 *   against the SCANNED root.
 * - `DecorationProvider` needs it to ask `IgnoreMatcher.matches()` about a
 *   path, comparing against the WORKSPACE root -- which is known immediately,
 *   unlike the scan's own root. `ScanResult.notRun()` carries a sentinel root
 *   (`'\u0000never'`), so answering from the scan's root would make every path
 *   read as "not ignored" for the seconds between activation and the first
 *   scan landing.
 *
 * `root` may carry a single trailing separator, or be a bare drive root
 * (`C:\`); `normalisedRoot()` above absorbs both, so no caller needs to get
 * this right on its own. Beyond that, `root` and `absolute` are expected to
 * already agree on separator style modulo the `norm()` above, which is what
 * `uri.fsPath` and a `WorkspaceFolder`'s own `uri.fsPath` both give directly.
 *
 * Pure, and free of `vscode`, so it needs no workspace or network to test.
 */
export function relativeToRoot(
  root: string,
  absolute: string,
  platform: Platform,
): string | undefined {
  const a = norm(absolute, platform);
  const r = normalisedRoot(root, platform);
  if (!a.startsWith(`${r}/`)) return undefined;
  // Slice the NORMALISED form so the result is `/`-separated, matching what
  // `parseReconcile` produces and what `IgnoreMatcher` expects.
  const rest = a.slice(r.length + 1);
  // A doubled separator right after the root (`C:/work/Proj//a.vb`) leaves a
  // leading `/` here, which would make an ancestor walk over the result stop
  // one component early. Strip exactly the one leading separator; do not
  // collapse repeats anywhere else in the path, or a UNC root's own
  // `\\server\share` would break.
  const stripped = rest.startsWith('/') ? rest.slice(1) : rest;
  // `relative`'s prefix test above is a string test, not a containment test,
  // so `C:\work\Proj\..\Other\a.vb` would otherwise pass as "under" `Proj`.
  if (stripped.split('/').includes('..')) return undefined;
  return stripped;
}
