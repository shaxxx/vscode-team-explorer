import * as vscode from 'vscode';
import { classifyError, scrubSecrets, type TfClient, type TfResult } from '../tf/TfClient.js';
import { messageFor } from '../tf/errorMessage.js';
import { parseInfo, type InfoItem } from '../tf/parseInfo.js';
import { isPreviewFailure, parsePreview, type ListedConflict } from '../tf/parseResolve.js';
import { localKey, PathMapper } from '../tf/PathMapper.js';
import { S } from '../tf/strings.js';
import type { TfvcService } from '../TfvcService.js';
import { autoMergeAllArgs, isAbsoluteTfPath, listArgs, resolveOneArgs, type AutoResolution } from './resolveArgs.js';
import { buildConflicts, type Conflict, type LocatedConflict } from './conflictModel.js';

type Client = Pick<TfClient, 'run' | 'timeoutMs'>;
type Service = Pick<TfvcService, 'onDidChange' | 'pathMapper' | 'workspaceFolders' | 'workspaceRoot' | 'platform'>;

export interface ResolveOutcome {
  ok: boolean;
  /** tf's own stdout and stderr, scrubbed: what the user reads when it did not work. */
  detail: string;
}

/** `info` takes many itemspecs in one call (C11), but a command line has a limit. */
export const INFO_BATCH = 50;

/**
 * Phase 5's list of conflicts: the WHOLE workspace of the opened
 * folder, re-read after every pending-changes refresh (U3). tf's exit codes
 * cannot say whether a conflict was left (C1, C2), and `status` never shows
 * one (C4), so the `/preview` listing is the one source.
 *
 * tf runs in the opened folder -- the client's own working directory, passed
 * explicitly because relative paths in the listing are relative to it (C7).
 */
export class ConflictService implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private list: readonly Conflict[] = [];
  private running: Promise<readonly Conflict[]> | undefined;
  private queued: Promise<readonly Conflict[]> | undefined;
  private disposed = false;
  private readonly subscription: vscode.Disposable;

  constructor(
    private readonly client: Client,
    private readonly service: Service,
    private readonly log: (line: string) => void,
  ) {
    // Every refresh -- activation, focus, the watcher, Refresh and every
    // mutation -- is a reason to look again. A failure is logged inside.
    this.subscription = service.onDidChange(() => void this.check().catch(() => undefined));
  }

  get conflicts(): readonly Conflict[] {
    return this.list;
  }

  /**
   * One check at a time. A caller who asks while one is running gets the NEXT
   * one, never the running one: it may have started before whatever the
   * caller just did -- an unshelve, a Get -- and would answer for the world
   * before it. Every caller during one flight shares that next check.
   * Rejects when tf could not say; the list stays what it was.
   */
  check(): Promise<readonly Conflict[]> {
    if (this.disposed) return Promise.resolve(this.list);
    if (!this.running) {
      this.running = this.runOnce().finally(() => {
        this.running = undefined;
      });
      return this.running;
    }
    if (!this.queued) {
      this.queued = this.running
        .then(
          () => undefined,
          () => undefined,
        )
        .then(() => {
          this.queued = undefined;
          return this.check();
        });
    }
    return this.queued;
  }

  private async runOnce(): Promise<readonly Conflict[]> {
    const mapper = this.service.pathMapper;
    const roots = this.service.workspaceFolders.map((f) => f.localPath);
    if (!mapper || roots.length === 0) {
      // A definite answer, not a failure to look: the folder has no workspace
      // (its mapping was removed), so its old conflicts are gone with it and
      // their buttons must not stay live.
      const had = this.list.length > 0;
      this.list = [];
      if (had) this.changed.fire();
      throw this.failed(S.noWorkspaceMapping);
    }
    const cwd = this.service.workspaceRoot;

    let r: TfResult;
    try {
      r = await this.client.run(listArgs(roots), { cwd });
    } catch (e) {
      throw this.failed(scrubSecrets(e instanceof Error ? e.message : String(e)));
    }
    if (this.disposed) return this.list;
    if (r.timedOut) throw this.failed(S.commandTimedOut(this.client.timeoutMs));

    const stdout = r.stdout.toString('utf8');
    const stderr = r.stderr.toString('utf8');
    if (isPreviewFailure(r.exitCode, stdout, stderr)) {
      const error = classifyError(r.exitCode, stdout, stderr) ?? {
        kind: 'unknown' as const,
        originalMessage: scrubSecrets(`${stderr}\n${stdout}`.trim()),
      };
      throw this.failed(messageFor(error));
    }

    let listed: ListedConflict[];
    try {
      listed = parsePreview(r.exitCode, stdout, stderr);
    } catch (e) {
      throw this.failed(S.conflictsNotUnderstood((e as Error).message));
    }

    // tf's form throughout, then converted once: a relative path is joined to
    // the working directory as TF saw it (`Z:\…` under Wine). A `$/` path --
    // a conflict with no local item -- goes where the workspace maps it, so
    // every resolution still names an absolute local path.
    const tfCwd = mapper.toWinePath(cwd).replace(/\\+$/, '');
    // Placed with THIS workspace's mappings only: the shared mapper spans every
    // workspace on the computer, and its longest match could be another one's
    // folder -- where a resolution would then act.
    const own = new PathMapper([...this.service.workspaceFolders], this.service.platform);
    const located: LocatedConflict[] = [];
    for (const l of listed) {
      if (l.path.startsWith('$/')) {
        const localPath = own.toLocalPath(l.path);
        if (localPath === undefined) {
          // Cannot come from a listing of this workspace's own roots; one odd
          // line must not hide every other conflict.
          this.log(`conflicts: ${scrubSecrets(l.path)} is not mapped here -- left out`);
          continue;
        }
        located.push({
          localPath,
          tfPath: mapper.toWinePath(localPath),
          serverPath: l.path,
          reason: l.reason,
          listedByServerPath: true,
        });
        continue;
      }
      const tfPath = isAbsoluteTfPath(l.path) ? l.path : `${tfCwd}\\${l.path}`;
      const localPath = mapper.fromWinePath(tfPath);
      located.push({ localPath, tfPath, serverPath: mapper.toServerPath(localPath), reason: l.reason });
    }

    const infos = located.length === 0 ? [] : await this.infoFor(located.map((l) => l.tfPath), cwd);
    if (this.disposed) return this.list;

    const next = buildConflicts(located, infos, (p) => localKey(p, this.service.platform));
    const same = JSON.stringify(next) === JSON.stringify(this.list);
    this.list = next;
    this.log(`conflicts: ${next.length}`);
    if (!same) this.changed.fire();
    return this.list;
  }

  private failed(message: string): Error {
    // Some messages quote tf's raw output (a line that was not understood).
    const safe = scrubSecrets(message);
    this.log(`conflicts: could not look -- ${safe}`);
    return new Error(safe);
  }

  /**
   * Family and changesets for each conflict. Best effort: a batch that fails
   * leaves its rows `unknown`, which still lists them -- the listing is what
   * matters, and a row with tf's reason is better than no row.
   */
  private async infoFor(tfPaths: readonly string[], cwd: string): Promise<InfoItem[]> {
    const out: InfoItem[] = [];
    for (let i = 0; i < tfPaths.length; i += INFO_BATCH) {
      try {
        const r = await this.client.run(['vc', 'info', ...tfPaths.slice(i, i + INFO_BATCH)], { cwd });
        if (r.timedOut) {
          this.log('conflicts: info timed out; those rows have no changesets');
          continue;
        }
        out.push(...parseInfo(r.stdout.toString('utf8')));
      } catch (e) {
        this.log(`conflicts: info not usable (${scrubSecrets((e as Error).message)}); those rows have no changesets`);
      }
    }
    return out;
  }

  /** One resolution of one conflict, then a fresh look. Never throws. */
  async resolve(conflict: Conflict, how: AutoResolution): Promise<ResolveOutcome> {
    return this.runThenCheck(() => resolveOneArgs(conflict.tfPath, how));
  }

  /** Auto-merge all: every mapping root, `/recursive /auto:AutoMerge`. Never throws. */
  async autoMergeAll(): Promise<ResolveOutcome> {
    return this.runThenCheck(() => autoMergeAllArgs(this.service.workspaceFolders.map((f) => f.localPath)));
  }

  private async runThenCheck(argv: () => string[]): Promise<ResolveOutcome> {
    let outcome: ResolveOutcome;
    try {
      outcome = this.outcomeOf(await this.client.run(argv(), { cwd: this.service.workspaceRoot }));
    } catch (e) {
      outcome = { ok: false, detail: scrubSecrets(e instanceof Error ? e.message : String(e)) };
    }
    await this.check().catch(() => undefined);
    return outcome;
  }

  private outcomeOf(r: TfResult): ResolveOutcome {
    if (r.timedOut) return { ok: false, detail: S.commandTimedOut(this.client.timeoutMs) };
    const detail = scrubSecrets(
      [r.stdout.toString('utf8'), r.stderr.toString('utf8')]
        .map((s) => s.trim())
        .filter((s) => s !== '')
        .join('\n'),
    );
    return { ok: r.exitCode === 0 && r.terminatedBy === undefined, detail };
  }

  dispose(): void {
    this.disposed = true;
    this.subscription.dispose();
    this.changed.dispose();
  }
}
