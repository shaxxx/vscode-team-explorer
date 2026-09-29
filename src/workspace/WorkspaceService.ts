import { classifyError, findUnsafeArgs, type RunOptions, type TfResult } from '../tf/TfClient.js';
import { PathMapper, type Platform } from '../tf/PathMapper.js';
import { parseWorkspaces } from '../tf/parse.js';
import { parseDir } from '../tf/parseDir.js';
import { streamedGet } from '../tf/streamedGet.js';
import { messageFor } from '../tf/errorMessage.js';
import { S } from '../tf/strings.js';
import type { WorkspaceInfo } from '../tf/types.js';

export type Outcome<T = undefined> = { ok: true; value: T } | { ok: false; message: string; items?: number };

type Client = { run(args: string[], opts?: RunOptions): Promise<TfResult>; readonly timeoutMs: number };

const ok = <T>(value: T): Outcome<T> => ({ ok: true, value });
const fail = <T>(message: string, items?: number): Outcome<T> =>
  items === undefined ? { ok: false, message } : { ok: false, message, items };

/**
 * `/new`, `/map` and `/unmap` measured 1-11 s against the real server (design
 * P9), but the user-configurable global timeout can be as low as 1000 ms --
 * so these three verbs get their own floor, regardless of that setting.
 */
const WORKSPACE_CHANGE_MIN_TIMEOUT_MS = 120_000;

/**
 * Every workspace-changing argv. Local paths arrive NATIVE
 * and go to tf in tf's form (`Z:\...` on Wine). Never `/delete`, `/force`,
 * `/overwrite` or `/all` (W7); `/unmap` never carries `/collection` (P6).
 */
export class WorkspaceService {
  private readonly paths: PathMapper;

  constructor(
    private readonly client: Client,
    private readonly collectionUrl: string,
    platform: Platform,
    private readonly log: (line: string) => void = () => {},
  ) {
    this.paths = new PathMapper([], platform);
  }

  /** The floor `/new`, `/map` and `/unmap` run with, regardless of the configured global timeout (I1 point 2). */
  private get longTimeoutMs(): number {
    return Math.max(this.client.timeoutMs, WORKSPACE_CHANGE_MIN_TIMEOUT_MS);
  }

  toTf(nativePath: string): string {
    return this.paths.toWinePath(nativePath);
  }

  fromTf(tfPath: string): string {
    return this.paths.fromWinePath(tfPath);
  }

  async list(): Promise<Outcome<WorkspaceInfo[]>> {
    const r = await this.client.run(['vc', 'workspaces', `/collection:${this.collectionUrl}`, '/format:xml']);
    const bad = this.failure(r);
    if (bad) return fail(S.wsUnreadable(bad));
    try {
      return ok(parseWorkspaces(r.stdout));
    } catch (e) {
      return fail(S.wsUnreadable((e as Error).message));
    }
  }

  /**
   * P1: tf maps `$/` to the working directory; it is removed at once, from
   * that same empty folder (M2).
   *
   * When `/new`'s own outcome is UNKNOWN -- timed out, killed, or a bare -1
   * with no tf text at all -- the workspace may or may not exist on the
   * server. The unmap runs anyway: a folder made moments ago cannot be
   * anyone else's mapping, and if the workspace was never created the unmap
   * simply fails, harmlessly. A DEFINITE tf failure (non-zero exit WITH tf's
   * own message) still stops here without unmapping, as before (I1).
   */
  async create(name: string, emptyDir: string): Promise<Outcome> {
    const tfDir = this.toTf(emptyDir);
    // Refuse up front (M4): the unmap below would itself be refused for the
    // same reason, leaving a stray automatic $/ mapping with no way back.
    if (findUnsafeArgs([tfDir]).length > 0) return fail(S.wsTempUnsafe(emptyDir));

    const timeoutMs = this.longTimeoutMs;
    const created = await this.client.run(
      ['vc', 'workspace', '/new', name, `/collection:${this.collectionUrl}`, '/location:server'],
      { cwd: emptyDir, timeoutMs },
    );

    if (this.isUnknownResult(created)) {
      const unmapped = await this.client.run(
        ['vc', 'workfold', '/unmap', tfDir, `/workspace:${name}`],
        { cwd: emptyDir, timeoutMs },
      );
      const detail = this.failure(created, timeoutMs) ?? `tf exited with code ${created.exitCode} and no output.`;
      return fail(S.wsCreateUnknown(name, emptyDir, !this.failure(unmapped, timeoutMs), detail));
    }

    const bad = this.failure(created, timeoutMs);
    if (bad) return fail(bad);

    const unmapped = await this.client.run(
      ['vc', 'workfold', '/unmap', tfDir, `/workspace:${name}`],
      { cwd: emptyDir, timeoutMs },
    );
    const stray = this.failure(unmapped, timeoutMs);
    if (stray) return fail(S.wsCreateStrayMapping(name, emptyDir, stray));
    return ok(undefined);
  }

  /** I1: whether `r` is a definite tf failure or an UNKNOWN outcome that must still be followed by the unmap. */
  private isUnknownResult(r: TfResult): boolean {
    if (r.timedOut || r.terminatedBy) return true;
    if (r.exitCode === -1) {
      const text = (r.stderr.toString('utf8') + r.stdout.toString('utf8')).trim();
      if (!text) return true;
    }
    return false;
  }

  async map(workspace: string, serverItem: string, nativeLocal: string): Promise<Outcome> {
    return this.simple(
      ['vc', 'workfold', '/map', serverItem, this.toTf(nativeLocal), `/workspace:${workspace}`, `/collection:${this.collectionUrl}`],
      { timeoutMs: this.longTimeoutMs },
    );
  }

  async unmap(workspace: string, nativeLocal: string): Promise<Outcome> {
    return this.simple(
      ['vc', 'workfold', '/unmap', this.toTf(nativeLocal), `/workspace:${workspace}`],
      { timeoutMs: this.longTimeoutMs },
    );
  }

  async folders(serverPath: string): Promise<Outcome<string[]>> {
    // With the collection: on a new machine there is no workspace yet for tf to infer it from.
    const r = await this.client.run(['vc', 'dir', serverPath, `/collection:${this.collectionUrl}`]);
    const bad = this.failure(r);
    if (bad) return fail(bad);
    try {
      return ok(parseDir(r.stdout.toString('utf8')).folders);
    } catch (e) {
      return fail((e as Error).message);
    }
  }

  /**
   * No timeout (W5); progress counts Getting / Replacing / Deleting lines (P8).
   *
   * M1: cancelled only counts when the run ALSO did not finish (`exitCode !==
   * 0`) -- a Get whose process happened to finish right as Cancel was pressed
   * is a plain success, not a cancellation.
   *
   * I2: a non-zero, non-cancelled exit is a failure that keeps the item
   * count so far, with a message built from stderr plus whichever stdout
   * lines are not progress noise (`getting` / `replacing` / `deleting` /
   * `folder`) -- not the whole, mostly-progress stdout. The full text also
   * goes to the optional `log`, for the output channel.
   */
  async get(
    nativeLocal: string,
    onProgress: (items: number, line: string) => void,
    signal: AbortSignal,
  ): Promise<Outcome<{ items: number; cancelled: boolean }>> {
    const r = await streamedGet(this.client, ['vc', 'get', this.toTf(nativeLocal), '/recursive'], onProgress, signal);
    if (r.cancelled) return ok({ items: r.items, cancelled: true });
    if (r.failure !== undefined) {
      const message = S.wsGetPartial(r.items, r.failure);
      this.log(message);
      return fail(message, r.items);
    }
    return ok({ items: r.items, cancelled: false });
  }

  private async simple(args: string[], opts: RunOptions = {}): Promise<Outcome> {
    const timeoutMs = typeof opts.timeoutMs === 'number' ? opts.timeoutMs : this.client.timeoutMs;
    const bad = this.failure(await this.client.run(args, opts), timeoutMs);
    return bad ? fail(bad) : ok(undefined);
  }

  /** The user-facing message for a failed call, or undefined when it worked. */
  private failure(r: TfResult, timeoutMs: number = this.client.timeoutMs): string | undefined {
    if (r.timedOut) return S.commandTimedOut(timeoutMs);
    const error = classifyError(r.exitCode, r.stdout.toString('utf8'), r.stderr.toString('utf8'));
    return error ? messageFor(error) : undefined;
  }
}
