/**
 * `tf vc resolve <roots…> /recursive /preview` (C6-C10).
 *
 * Text only: `resolve` has no XML format. "None" is exit 0 with nothing on
 * stderr. "Some" is exit 1, nothing on stdout, and one `<path>: <reason>` line
 * per conflict on STDERR (C6), UTF-8 on both machines (C8). The path is
 * relative to tf's working directory when the item is under it and absolute
 * otherwise (C7); resolving that is the caller's job, since only the caller
 * knows the working directory it used.
 *
 * The reason is tf's own sentence, shown verbatim and never read: tf localises
 * (dates already come back in Croatian on DEVPC), so nothing may be decided
 * from its words. "There are no conflicts to resolve." is not read either --
 * exit 0 with an empty stderr is what "none" is.
 */

export interface ListedConflict {
  /**
   * As tf printed it: absolute in tf's form (`C:\…`, `Z:\…`, `\\server\…`),
   * relative to its working directory, or a server path (`$/…`) when the
   * conflict has no local item.
   */
  path: string;
  /** tf's own sentence, verbatim. */
  reason: string;
}

const BOM = new RegExp(`^${String.fromCharCode(0xfeff)}`);
const TF_CODE = /\bTF\d{5,6}\b/;
const WRAPPER_LINE = /\[tfp\]/;

/**
 * True when tf FAILED rather than listed: an exit code other than 0 and 1 --
 * "Unable to determine the workspace" is exit 100 (C10), a TfClient refusal
 * is -1 -- or a TF error code or a wrapper line anywhere, whatever the exit
 * code. The caller hands such a result to `classifyError` for its message:
 * `TF30063: You are not authorized…` must never become a conflict on a file
 * called `TF30063`.
 */
export function isPreviewFailure(exitCode: number, stdout: string, stderr: string): boolean {
  if (exitCode !== 0 && exitCode !== 1) return true;
  const all = `${stdout}\n${stderr}`;
  return TF_CODE.test(all) || WRAPPER_LINE.test(all);
}

/**
 * The conflicts a listing names. Throws on anything it does not understand --
 * stdout on exit 1, stderr on exit 0, a line that is not `<path>: <reason>` --
 * and the caller keeps what it had: a half-understood list is
 * never shown. Call only when `isPreviewFailure` is false.
 */
export function parsePreview(exitCode: number, stdout: string, stderr: string): ListedConflict[] {
  const lines = stderr
    .split(/\r?\n/)
    .map((line) => line.replace(BOM, ''))
    .filter((line) => line.trim() !== '');
  if (exitCode === 0) {
    if (lines.length > 0) throw new Error(`resolve /preview: exit 0 with output on stderr: ${lines[0]}`);
    return [];
  }
  if (exitCode !== 1) throw new Error(`resolve /preview: unexpected exit code ${exitCode}`);
  if (stdout.trim() !== '') {
    throw new Error(`resolve /preview: unexpected output on stdout: ${stdout.trim().split(/\r?\n/)[0]}`);
  }
  if (lines.length === 0) throw new Error('resolve /preview: exit 1 with nothing listed');
  return lines.map(parseLine);
}

function parseLine(line: string): ListedConflict {
  // A drive letter's own colon is not the separator: `C:\x\a.cs: reason`.
  const from = /^[A-Za-z]:\\/.test(line) ? 2 : 0;
  const at = line.indexOf(': ', from);
  const path = at < 0 ? '' : line.slice(0, at);
  const reason = at < 0 ? '' : line.slice(at + 2).trim();
  // Neither a Windows name nor a TFVC one can contain `:`, so a second colon
  // means this is not a path at all. A `$/` path is kept: tf names a conflict
  // by its server path when it has no local item (never probed --
  // but it is what Microsoft's own Java tf prints), and throwing here would
  // hide every other conflict with it.
  if (path.trim() === '' || reason === '' || path.slice(from).includes(':')) {
    throw new Error(`resolve /preview: not a conflict line: ${line}`);
  }
  return { path, reason };
}
