import { classifyError, type RunOptions, type TfResult } from '../tf/TfClient.js';
import { messageFor } from '../tf/errorMessage.js';
import { parseDir, type DirListing } from '../tf/parseDir.js';
import { parseInfo, type InfoItem } from '../tf/parseInfo.js';
import { parseStatusOwned, parseWorkspaces } from '../tf/parse.js';
import { streamedGet, type StreamedGetResult } from '../tf/streamedGet.js';
import { S } from '../tf/strings.js';
import type { OwnedPendingChange, WorkspaceInfo } from '../tf/types.js';

type Client = { run(args: string[], opts?: RunOptions): Promise<TfResult>; readonly timeoutMs: number };

export type Loaded<T> = { ok: true; value: T } | { ok: false; message: string };

const key = (path: string): string => path.toLowerCase();

/** A folder's children as one itemspec: `$/*` for the root, `<folder>/*` otherwise (design Q2, Q5). */
export const childrenSpec = (path: string): string => (path === '$/' ? '$/*' : `${path}/*`);

/**
 * Every tf call the Source Control Explorer makes.
 * `dir` listings are cached per folder: they feed the tree and change rarely.
 * `info` and `status` are never cached -- they are exactly what goes stale,
 * and the explorer re-runs them on every visit, Refresh and change event.
 */
export class ExplorerService {
  private readonly listings = new Map<string, DirListing>();
  private workspaceList: Promise<Loaded<WorkspaceInfo[]>> | undefined;
  /** Bumped by a full `forget()`, so a `list` started before it never writes its stale answer into the cache. */
  private epoch = 0;
  /** Per-key generation, bumped when that key's listing starts or is forgotten -- so an older `list` resolving after a newer one for the same key cannot overwrite it (review finding 1: a call can take 5-6s on FEDORA). */
  private readonly sequences = new Map<string, number>();

  constructor(
    private readonly client: Client,
    private readonly collectionUrl: string,
  ) {}

  /** `vc dir` (Q1), with the collection like part 1's browse. Cached until `forget`, unless `fresh`. */
  async list(path: string, fresh = false): Promise<Loaded<DirListing>> {
    const k = key(path);
    const cached = this.listings.get(k);
    if (cached && !fresh) return { ok: true, value: cached };
    const epoch = this.epoch;
    const seq = (this.sequences.get(k) ?? 0) + 1;
    this.sequences.set(k, seq);
    const r = await this.client.run(['vc', 'dir', path, `/collection:${this.collectionUrl}`]);
    const listed = this.parsed(r, (stdout) => parseDir(stdout.toString('utf8')));
    // Only write the cache if nothing forgot everything, and no newer `list` for
    // this same key started, while this call was in flight (review finding 1).
    if (listed.ok && epoch === this.epoch && seq === this.sequences.get(k)) {
      this.listings.set(k, listed.value);
    }
    return listed;
  }

  cachedListing(path: string): DirListing | undefined {
    return this.listings.get(key(path));
  }

  /** `info` and everyone's `status` for the folder's children, side by side (X2). */
  async details(path: string): Promise<{ info: Loaded<InfoItem[]>; status: Loaded<OwnedPendingChange[]> }> {
    const spec = childrenSpec(path);
    const [info, status] = await Promise.all([this.client.run(['vc', 'info', spec]), this.status(path)]);
    return { info: this.parsed(info, (stdout) => parseInfo(stdout.toString('utf8'))), status };
  }

  /** Everyone's `status` for the folder's children alone: for a folder the server lists nothing in, where `info` has nothing to say but a pending Add can still be. */
  async status(path: string): Promise<Loaded<OwnedPendingChange[]>> {
    const r = await this.client.run(['vc', 'status', childrenSpec(path), '/user:*', '/format:xml']);
    return this.parsed(r, parseStatusOwned);
  }

  /** This computer's workspaces (fixtures finding 18): whose pending changes are "mine". Once, until `forget()`. */
  workspaces(): Promise<Loaded<WorkspaceInfo[]>> {
    const thisList: Promise<Loaded<WorkspaceInfo[]>> = (this.workspaceList ??= this.client
      .run(['vc', 'workspaces', `/collection:${this.collectionUrl}`, '/format:xml'])
      .then((r) => this.parsed(r, parseWorkspaces))
      .then((loaded) => {
        // Do not let a timeout or a failed read stick until forget(): retry
        // next time, unless a forget() already replaced this promise (review
        // finding 2).
        if (!loaded.ok && this.workspaceList === thisList) this.workspaceList = undefined;
        return loaded;
      }));
    return thisList;
  }

  /** Drops one folder's listing; with no path, every listing and the workspace list (Refresh). */
  forget(path?: string): void {
    if (path === undefined) {
      this.listings.clear();
      this.workspaceList = undefined;
      this.epoch += 1;
      return;
    }
    const k = key(path);
    this.listings.delete(k);
    this.sequences.set(k, (this.sequences.get(k) ?? 0) + 1);
  }

  /**
   * A streamed Get (part 1 W5). The argv is built by getVersion.ts, never
   * here -- but this is the module's one generic spawn with no timeout, so it
   * refuses anything but `vc get` itself: nothing may ever reach `checkin`
   * except the Check In button (review finding 3).
   */
  get(args: string[], onProgress: (items: number) => void, signal: AbortSignal): Promise<StreamedGetResult> {
    if (args[0] !== 'vc' || args[1] !== 'get') {
      return Promise.resolve({ items: 0, deleted: 0, cancelled: false, failure: S.sceUnknownPath });
    }
    return streamedGet(this.client, args, (items) => onProgress(items), signal);
  }

  private parsed<T>(r: TfResult, parse: (stdout: Buffer) => T): Loaded<T> {
    if (r.timedOut) return { ok: false, message: S.commandTimedOut(this.client.timeoutMs) };
    const error = classifyError(r.exitCode, r.stdout.toString('utf8'), r.stderr.toString('utf8'));
    if (error) return { ok: false, message: messageFor(error) };
    try {
      return { ok: true, value: parse(r.stdout) };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  }
}
