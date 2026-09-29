import { classifyError, scrubSecrets, type TfClient, type TfErrorKind } from '../tf/TfClient.js';
import { parseHistory, type Changeset } from '../tf/parseHistory.js';
import { messageFor } from '../tf/errorMessage.js';
import { S } from '../tf/strings.js';

/** Records per `history` call. One page is about a second on either machine (design F7). */
export const HISTORY_PAGE = 50;

export type HistoryMode = 'file' | 'folder';

export interface HistoryTarget {
  mode: HistoryMode;
  /**
   * A server path, or -- for Annotate's `/version:W` -- the local path in tf's
   * own form (`Z:\...` under Wine, from PathMapper.toWinePath).
   */
  itemspec: string;
}

export interface PageOptions {
  /** Only changesets older than this one: the "Load more" range. */
  before?: number;
  /** Stop at the workspace version instead of the latest: Annotate's base (F5). */
  workspace?: boolean;
}

export interface HistoryPage {
  changesets: Changeset[];
  /** A full page came back, so there may be older records. */
  more: boolean;
}

export class HistoryError extends Error {
  constructor(
    message: string,
    readonly kind: TfErrorKind | 'unreadable' | 'spawn' | 'timeout' | 'stopped',
  ) {
    super(message);
    this.name = 'HistoryError';
  }
}

type Client = Pick<TfClient, 'run' | 'timeoutMs'>;

/**
 * Every `tf vc history` this extension runs.
 *
 * vscode-free, like TfClient, so all of it is unit-tested against the real
 * captures. The verbs it may spawn are pinned by phase2Safety.test.ts.
 */
export class HistoryService {
  /** A changeset never changes once it exists, so its details are kept for the session. */
  private readonly details = new Map<number, Changeset>();

  /**
   * One `changeset()` call per id in flight at a time (phase 2 D16).
   *
   * The History tab's details pane retries on every reselect, and a fast
   * double-click -- or a retry that lands while the first attempt is still
   * running -- would otherwise start a second `tf vc history` for the exact
   * same id. Kept OUT of `details`: a rejection must never be cached as if it
   * were the changeset's content, so the entry is dropped in `finally`
   * whichever way the call ends, and the next call starts fresh.
   */
  private readonly inFlight = new Map<number, Promise<Changeset>>();

  constructor(
    private readonly client: Client,
    private readonly log: (line: string) => void = () => {},
  ) {}

  /**
   * The argv for one page. Static so the safety test can see every shape.
   *
   * The itemspec is always pinned (D12, fixtures README finding 24): tf
   * resolves an UNPINNED itemspec at the top of the `/version:` range, not at
   * the range's own end, so for a renamed file every page past the one
   * holding the rename asked "does this name exist at the newest version?",
   * got no, and answered "No history entries" -- exit 0, indistinguishable
   * from a real end of history. Pinning at an identity that IS present in the
   * range (`;T` for a server path, `;W` for a local one -- Annotate's own
   * `/version:W` on page 1 already proves it) makes `/itemmode` follow the
   * item back across the rename instead. This applies to every page,
   * including the first, and to both files and folders alike (finding 24's
   * unverified-but-checked folder case). `changesetArgs` below stays
   * unpinned: it always asks over `$/` itself, which never gets renamed.
   */
  static pageArgs(target: HistoryTarget, options: PageOptions = {}): string[] {
    const pin = target.itemspec.startsWith('$/') ? ';T' : ';W';
    const args = ['vc', 'history', target.itemspec + pin];
    if (target.mode === 'folder') args.push('/recursive');
    args.push('/format:detailed', `/stopafter:${HISTORY_PAGE}`);
    // /itemmode follows a file across renames (F9). For a folder tf ignores
    // it and says so on stderr (F10), so it is never sent there.
    if (target.mode === 'file') args.push('/itemmode');
    if (options.before !== undefined) args.push(`/version:C1~C${options.before - 1}`);
    else if (options.workspace) args.push('/version:W');
    return args;
  }

  /**
   * Every item in one changeset (F6). Deliberately `history` over `$/`, never
   * `tf changeset`: given /comment: or /notes: that command REWRITES a
   * changeset, and nothing here should be one flag away from doing so.
   */
  static changesetArgs(id: number): string[] {
    return ['vc', 'history', '$/', `/version:C${id}~C${id}`, '/recursive', '/format:detailed', '/stopafter:1'];
  }

  async page(target: HistoryTarget, options: PageOptions = {}): Promise<HistoryPage> {
    const { changesets, more } = await this.fetchPage(target, options);
    return { changesets, more };
  }

  /** Every page, newest first, until tf returns a short one. Annotate needs the whole list. */
  async all(
    target: HistoryTarget,
    options: { workspace?: boolean; signal?: AbortSignal } = {},
  ): Promise<Changeset[]> {
    const out: Changeset[] = [];
    let page = await this.fetchPage(target, { workspace: options.workspace });
    for (;;) {
      // A skipped record is a version the blame walk would never see: its
      // lines would go to an older changeset with no sign anything was wrong.
      if (page.skipped > 0) throw new HistoryError(S.historyUnreadable, 'unreadable');
      out.push(...page.changesets);
      if (!page.more || options.signal?.aborted) return out;
      page = await this.fetchPage(target, { before: out[out.length - 1].id });
    }
  }

  async changeset(id: number): Promise<Changeset> {
    const cached = this.details.get(id);
    if (cached) return cached;
    const existing = this.inFlight.get(id);
    if (existing) return existing;
    const promise = this.fetchChangeset(id);
    this.inFlight.set(id, promise);
    try {
      return await promise;
    } finally {
      this.inFlight.delete(id);
    }
  }

  private async fetchChangeset(id: number): Promise<Changeset> {
    const found = (await this.run(HistoryService.changesetArgs(id))).changesets.find((c) => c.id === id);
    if (!found) throw new HistoryError(S.changesetNotFound(id), 'unreadable');
    this.details.set(id, found);
    return found;
  }

  private async fetchPage(target: HistoryTarget, options: PageOptions): Promise<HistoryPage & { skipped: number }> {
    if (options.before !== undefined && options.before <= 1) return { changesets: [], more: false, skipped: 0 };
    const { changesets, skipped, stdout } = await this.run(HistoryService.pageArgs(target, options));
    this.checkRange(changesets, options.before, stdout);
    // A record tf printed but the parser skipped still used one of the page's
    // slots; without it a full page would look like the last one.
    return { changesets, more: changesets.length + skipped >= HISTORY_PAGE, skipped };
  }

  /**
   * Guards the one property `all()`'s loop depends on (D12): a page asked for
   * with `before` must hold only ids strictly older than it, and no page may
   * repeat an id. Without this a tf that ignored the `/version:` range would
   * make `all()` re-fetch the same records forever, and would hand the blame
   * walk versions out of order along the way.
   *
   * D18h: a range violation is exactly as unreadable as a page the parser
   * could not make sense of at all, so it is logged the same way -- tf's
   * first three lines, scrubbed -- rather than only naming the id that
   * tripped the check.
   */
  private checkRange(changesets: Changeset[], before: number | undefined, stdout: string): void {
    const seen = new Set<number>();
    for (const c of changesets) {
      if (before !== undefined && c.id >= before) {
        this.rejectRange(`changeset ${c.id} is not older than the requested ${before}`, stdout);
      }
      if (seen.has(c.id)) {
        this.rejectRange(`changeset ${c.id} appeared twice`, stdout);
      }
      seen.add(c.id);
    }
  }

  private rejectRange(reason: string, stdout: string): never {
    this.log(scrubSecrets(`history: rejected a page: ${reason}`));
    const head = stdout.split(/\r?\n/).slice(0, 3).join(' | ');
    this.log(`history: could not read tf's output; it began: ${scrubSecrets(head)}`);
    throw new HistoryError(S.historyUnreadable, 'unreadable');
  }

  private async run(args: string[]): Promise<{ changesets: Changeset[]; skipped: number; stdout: string }> {
    let result;
    try {
      result = await this.client.run(args);
    } catch (e) {
      throw new HistoryError(scrubSecrets(e instanceof Error ? e.message : String(e)), 'spawn');
    }
    if (result.timedOut) throw new HistoryError(S.commandTimedOut(this.client.timeoutMs), 'timeout');

    // A killed tf has no reliable exit code (Node reports a SIGNALLED process
    // as code -1, so `classifyError` below would read its partial stdout as
    // the error text) and nothing it wrote is trustworthy history. Checked
    // BEFORE classifyError and before stdout is even decoded; only a byte
    // count reaches the log, never the bytes themselves.
    if (result.terminatedBy) {
      this.log(`history: tf was killed by ${result.terminatedBy} after writing ${result.stdout.length} bytes`);
      throw new HistoryError(S.historyStopped(result.terminatedBy), 'stopped');
    }

    // UTF-8 when piped, measured on both machines (fixtures README, Phase 2 captures).
    const stdout = result.stdout.toString('utf8');
    const error = classifyError(result.exitCode, stdout, result.stderr.toString('utf8'));
    // D18d: Phase 1's own wording for a classified failure (an expired PAT
    // names the fix) rather than tf's raw text alone.
    if (error) throw new HistoryError(messageFor(error), error.kind);

    const parsed = parseHistory(stdout);
    for (const line of parsed.skipped) {
      this.log(`history: skipped a record this extension cannot read: ${scrubSecrets(line)}`);
    }
    if (parsed.changesets.length === 0 && parsed.skipped.length > 0) {
      const head = stdout.split(/\r?\n/).slice(0, 3).join(' | ');
      this.log(`history: could not read tf's output; it began: ${scrubSecrets(head)}`);
      throw new HistoryError(S.historyUnreadable, 'unreadable');
    }
    return { changesets: [...parsed.changesets].sort((a, b) => b.id - a.id), skipped: parsed.skipped.length, stdout };
  }
}
