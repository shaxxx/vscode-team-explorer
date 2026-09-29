import { classifyError, scrubSecrets, type RunOptions, type TfResult } from '../tf/TfClient.js';
import { messageFor } from '../tf/errorMessage.js';
import { parseStatus } from '../tf/parse.js';
import { parseShelvedChanges, parseShelvesets, type ShelvedChange, type Shelveset } from '../tf/parseShelvesets.js';
import { S } from '../tf/strings.js';
import { nameProblem, ownerProblem, passable } from './shelveRules.js';

type Client = { run(args: string[], opts?: RunOptions): Promise<TfResult>; readonly timeoutMs: number };

export type Loaded<T> = { ok: true; value: T } | { ok: false; message: string };

/**
 * A mutation's outcome: tf's exit code, with its own text when that was not 0.
 * Callers act on BOTH outcomes -- an unshelve can pend changes and still exit 1
 * (S14), so a failure here never means "nothing happened".
 */
export interface Ran {
  exitCode: number;
  message?: string;
}

export interface ShelveRequest {
  name: string;
  /** tf-form local paths (`Z:\...` under Wine), straight from the status XML. Never empty. */
  paths: readonly string[];
  /** A comment file, already in the form TF.EXE can open. */
  commentPath?: string;
  /** Only after the user said Yes to replacing their shelveset of this name. */
  replace: boolean;
  /** Only after the user chose "Shelve and undo my pending changes". */
  move: boolean;
}

export interface UnshelveRequest {
  name: string;
  ownerUnique: string;
  /** Server paths; absent means the whole shelveset. */
  items?: readonly string[];
}

/** A TF##### code: tf's own failures carry one, its "none found" answer does not (S11). */
const TF_CODE = /\bTF\d{5,6}\b/;

/**
 * A tf wildcard. A real shelveset name or a real TFVC server path never
 * contains one, so only an upstream bug could put `*` or `?` into a name or
 * an item here -- but `vc shelve /delete *` or an itemspec built from one is
 * irreversible and its effect on a real shelveset is unverified, so it is
 * refused rather than risked.
 */
const WILDCARD = /[*?]/;

/**
 * Every tf call phase 4 makes, and the ONLY file that names
 * `shelve`, `unshelve` or `shelvesets` -- so the safety pin has one place to
 * watch. Three things it never does, each pinned by a test:
 *
 * - a `shelve` with no explicit paths: a bare `tf vc shelve <name>` shelves
 *   EVERY pending change in the workspace, the Excluded ones included;
 * - `unshelve /move`: it deletes the shelveset even when a conflict still
 *   refers to it (S9), so the view deletes it itself, only once nothing is
 *   in doubt;
 * - `shelve /delete` with `;owner`: without it, tf can only resolve the name
 *   among the CALLER's own shelvesets.
 */
export class ShelveService {
  constructor(
    private readonly client: Client,
    private readonly collectionUrl: string,
  ) {}

  /**
   * `''` lists the caller's own (S2); anything else goes to `/owner:` -- a
   * display name, an email or `*` (S18). A leading `-` or `/` is harmless
   * here, wrapped inside `/owner:...` -- but a value ownerProblem refuses
   * (a `"` above all: it can break TfClient's cmd quoting) can come back
   * from a stored view and reach this on a later Refresh, so it is checked
   * before argv, not just where it was first typed.
   */
  list(owner: string): Promise<Loaded<Shelveset[]>> {
    const who = owner.trim();
    const problem = ownerProblem(who);
    if (problem) return Promise.resolve({ ok: false, message: problem });
    return this.listing(['vc', 'shelvesets', ...(who === '' ? [] : [`/owner:${who}`]), '/format:xml', `/collection:${this.collectionUrl}`]);
  }

  /** Whether the caller already owns a shelveset of this name. tf's own lookup ignores case. */
  async exists(name: string): Promise<Loaded<boolean>> {
    const problem = nameProblem(name);
    if (problem) return { ok: false, message: problem };
    const r = await this.listing(['vc', 'shelvesets', name, '/format:xml', `/collection:${this.collectionUrl}`]);
    if (!r.ok) return r;
    return { ok: true, value: r.value.some((s) => s.name.toLowerCase() === name.toLowerCase()) };
  }

  /** A shelveset's changes (S2b). `/collection` is left out: status only says it ignores it. */
  contents(name: string, ownerUnique: string): Promise<Loaded<ShelvedChange[]>> {
    return this.read(['vc', 'status', `/shelveset:${name};${ownerUnique}`, '/format:xml', '/recursive'], parseShelvedChanges);
  }

  /** One shelved file's bytes (S3). Decoding is the caller's: it knows the item's `enc`. */
  view(name: string, ownerUnique: string, serverPath: string): Promise<Loaded<Buffer>> {
    if (!serverPath.startsWith('$/')) return Promise.resolve({ ok: false, message: S.sceUnknownPath });
    return this.read(['vc', 'view', `/shelveset:${name};${ownerUnique}`, serverPath, '/console'], (stdout) => stdout);
  }

  /** Which of these server paths are pending in THIS workspace -- the last check before a delete. */
  pendingIn(serverPaths: readonly string[]): Promise<Loaded<string[]>> {
    if (serverPaths.length === 0 || !serverPaths.every((p) => p.startsWith('$/'))) {
      return Promise.resolve({ ok: false, message: S.sceUnknownPath });
    }
    return this.read(['vc', 'status', ...serverPaths, '/format:xml'], (stdout) => parseStatus(stdout).map((c) => c.serverItem));
  }

  shelve(r: ShelveRequest): Promise<Ran> {
    const problem = nameProblem(r.name);
    if (problem) return Promise.resolve({ exitCode: -1, message: problem });
    if (r.paths.length === 0 || !r.paths.every(isItem)) return Promise.resolve({ exitCode: -1, message: S.shelveNoItems });
    return this.mutate([
      'vc',
      'shelve',
      ...(r.replace ? ['/replace'] : []),
      ...(r.move ? ['/move'] : []),
      r.name,
      ...r.paths,
      ...(r.commentPath ? [`/comment:@${r.commentPath}`] : []),
    ]);
  }

  unshelve(r: UnshelveRequest): Promise<Ran> {
    if (!passable({ name: r.name, ownerUnique: r.ownerUnique })) return Promise.resolve({ exitCode: -1, message: S.shelvesetUnpassable(r.name) });
    if (r.items !== undefined && (r.items.length === 0 || !r.items.every((p) => p.startsWith('$/') && !WILDCARD.test(p)))) {
      return Promise.resolve({ exitCode: -1, message: S.unshelveNothingTicked });
    }
    return this.mutate(['vc', 'unshelve', `${r.name};${r.ownerUnique}`, ...(r.items ?? [])]);
  }

  /** The caller's own shelveset of this name, and only that: never `;owner`. */
  deleteOwn(name: string): Promise<Ran> {
    if (!passable({ name, ownerUnique: 'self' }) || WILDCARD.test(name)) {
      return Promise.resolve({ exitCode: -1, message: S.shelvesetUnpassable(name) });
    }
    return this.mutate(['vc', 'shelve', '/delete', name]);
  }

  /**
   * `shelvesets`: tf answers "none found" with exit 100, empty stdout and no
   * TF code (S9, S11), while a real failure -- an unknown owner (TF14045), a
   * rejected token -- carries one. Matching the CODE, never the text: this tf
   * localises its messages.
   */
  private async listing(args: string[]): Promise<Loaded<Shelveset[]>> {
    const r = await this.client.run(args);
    if (!r.timedOut && !r.terminatedBy && r.exitCode === 100 && r.stdout.length === 0 && !TF_CODE.test(r.stderr.toString('utf8'))) {
      return { ok: true, value: [] };
    }
    return this.parsed(r, parseShelvesets);
  }

  private async read<T>(args: string[], parse: (stdout: Buffer) => T): Promise<Loaded<T>> {
    return this.parsed(await this.client.run(args), parse);
  }

  private parsed<T>(r: TfResult, parse: (stdout: Buffer) => T): Loaded<T> {
    if (r.timedOut) return { ok: false, message: S.commandTimedOut(this.client.timeoutMs) };
    if (r.terminatedBy) return { ok: false, message: S.outcomeUnknown(r.terminatedBy) };
    const error = classifyError(r.exitCode, r.stdout.toString('utf8'), r.stderr.toString('utf8'));
    // classifyError already scrubs what it builds into `originalMessage`, but
    // this call site is scrubbed too, on purpose (coordinator review I3): its
    // own doc comment records that this exact belt-and-suspenders was skipped
    // at three call sites before, which is how a token got out.
    if (error) return { ok: false, message: scrubSecrets(messageFor(error)) };
    try {
      return { ok: true, value: parse(r.stdout) };
    } catch (e) {
      return { ok: false, message: scrubSecrets((e as Error).message) };
    }
  }

  private async mutate(args: string[]): Promise<Ran> {
    const r = await this.client.run(args);
    if (r.timedOut) return { exitCode: -1, message: S.commandTimedOut(this.client.timeoutMs) };
    if (r.terminatedBy) return { exitCode: -1, message: S.outcomeUnknown(r.terminatedBy) };
    const error = classifyError(r.exitCode, r.stdout.toString('utf8'), r.stderr.toString('utf8'));
    return error ? { exitCode: r.exitCode, message: scrubSecrets(messageFor(error)) } : { exitCode: 0 };
  }
}

/**
 * One literal item: never a switch (`/`, `-`) and never a tf wildcard (`*`,
 * `?`). FileOpsService's rule, for the same reason: a wildcard would widen
 * what is shelved.
 */
function isItem(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.startsWith('-') && !WILDCARD.test(p);
}
