/**
 * Every `tf vc resolve` argv. The ONLY file that
 * names the verb -- phase5Safety.test.ts pins that -- and TfClient refuses
 * any shape this file does not build, so a second call site cannot get
 * around either.
 *
 * Every itemspec is an absolute LOCAL path in tf's own form (`C:\…`, or
 * `Z:\…` under Wine). Never a `$/` path: tf cannot tell the workspace from
 * one when its working directory is outside it (C10). Never relative: a
 * relative path means whatever tf's working directory happens to be.
 */

/** The four resolutions this extension offers. Never AutoMergeForced, DeleteConflict or KeepYoursRenameTheirs. */
export const AUTO_RESOLUTIONS = ['AutoMerge', 'TakeTheirs', 'KeepYours', 'OverwriteLocal'] as const;
export type AutoResolution = (typeof AUTO_RESOLUTIONS)[number];

/** `C:\…`, `Z:\…` or `\\server\…`: a local path in tf's own form. */
export function isAbsoluteTfPath(path: string): boolean {
  return /^[A-Za-z]:\\/.test(path) || path.startsWith('\\\\');
}

function checkedItem(path: string): string {
  if (!isAbsoluteTfPath(path) || /[*?]/.test(path)) {
    throw new Error(`resolve: not an absolute local path: ${JSON.stringify(path)}`);
  }
  return path;
}

function checkedRoots(roots: readonly string[]): string[] {
  // No roots at all would be a bare `resolve`, which acts on the working directory.
  if (roots.length === 0) throw new Error('resolve: no roots');
  return roots.map(checkedItem);
}

/** The listing. `/recursive` always: without it a folder with a conflict inside answers "none" (C9). */
export function listArgs(roots: readonly string[]): string[] {
  return ['vc', 'resolve', ...checkedRoots(roots), '/recursive', '/preview'];
}

/** One conflict, one resolution. Never `/recursive`: it names exactly one item. */
export function resolveOneArgs(tfPath: string, how: AutoResolution): string[] {
  // Checked at run time too: `how` can arrive from a webview message.
  if (!(AUTO_RESOLUTIONS as readonly string[]).includes(how)) {
    throw new Error(`resolve: not an offered resolution: ${String(how)}`);
  }
  return ['vc', 'resolve', checkedItem(tfPath), `/auto:${how}`];
}

/**
 * Auto-merge all: the one resolution that may name folders, and
 * only because tf changes nothing it cannot merge -- it refuses those items
 * one by one and leaves them in conflict (C12, C17).
 */
export function autoMergeAllArgs(roots: readonly string[]): string[] {
  return ['vc', 'resolve', ...checkedRoots(roots), '/recursive', '/auto:AutoMerge'];
}
