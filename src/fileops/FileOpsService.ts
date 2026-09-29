import { classifyError, type RunOptions, type TfResult } from '../tf/TfClient.js';
import { messageFor } from '../tf/errorMessage.js';
import { S } from '../tf/strings.js';

type Client = { run(args: string[], opts?: RunOptions): Promise<TfResult>; timeoutMs: number };

export type OpOutcome = { ok: true } | { ok: false; message: string };

/**
 * `vc rename` and `vc delete`: the only file in
 * the extension that may name either verb, so the safety pin has one place to
 * watch.
 *
 * Paths are tf's own form -- `Z:\...` under Wine -- or server paths, and the
 * CALLER decides which: rename takes local paths only, because a server path
 * as the source crashes tf (R2b), while delete accepts either (R15).
 *
 * A batch `delete` can be PARTLY successful: tf exits non-zero both when
 * nothing worked and when it skipped some of a batch -- the same
 * partial-success behaviour `test/unit/partialSuccess.test.ts` pins for `vc
 * add` and the other verbs. This class does not try to tell those two apart:
 * a non-zero exit is always `{ok:false}` with tf's own text, never a lie in
 * either direction. CALLERS MUST REFRESH ON BOTH OUTCOMES, not only on
 * success, or an item tf really did pend will sit stale in the panel.
 */
export class FileOpsService {
  constructor(private readonly client: Client) {}

  /** Records a rename or move. tf moves the item itself (R1, R5). */
  async rename(oldPath: string, newPath: string): Promise<OpOutcome> {
    if (!safePath(oldPath) || !safePath(newPath)) return refusedPath();
    return this.run(['vc', 'rename', oldPath, newPath]);
  }

  /** Records a pending delete for each path; a folder takes its children (R11). */
  async delete(paths: readonly string[]): Promise<OpOutcome> {
    if (paths.length === 0 || !paths.every(safePath)) return refusedPath();
    return this.run(['vc', 'delete', ...paths]);
  }

  private async run(args: string[]): Promise<OpOutcome> {
    const r = await this.client.run(args);
    if (r.timedOut) return { ok: false, message: S.commandTimedOut(this.client.timeoutMs) };
    const error = classifyError(r.exitCode, r.stdout.toString('utf8'), r.stderr.toString('utf8'));
    if (error) return { ok: false, message: messageFor(error) };
    return { ok: true };
  }
}

/**
 * A path tf will read as one literal item -- never a switch, and never an
 * itemspec tf will expand. Local paths reach tf in Windows form even under
 * Wine (`Z:\home\...`), and server paths start with `$/`, so nothing
 * legitimate begins with `/` or `-` -- which is exactly what a switch looks
 * like. Neither `*` nor `?` is legal in a Windows local path or a TFVC server
 * path either, and tf expands both: `delete(['$/T/*'])` would pend a delete on
 * every item in the folder, taking the local files with it -- this file is the
 * one place pinned to refuse that before it ever reaches tf.
 */
function safePath(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.startsWith('-') && !/[*?]/.test(p);
}

function refusedPath(): OpOutcome {
  return { ok: false, message: S.sceUnknownPath };
}
