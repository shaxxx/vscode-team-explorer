import { execFileSync, spawn, type StdioOptions } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * Opens a throwaway file to collect the child's stderr.
 *
 * Returns undefined if it cannot, rather than throwing: an unwritable or full
 * temp directory must not stop a background `status` from running. The caller
 * falls back to a pipe.
 */
function openStderrFile(): { path: string; fd: number } | undefined {
  try {
    const path = join(tmpdir(), `tfvc-stderr-${process.pid}-${randomBytes(6).toString('hex')}`);
    return { path, fd: openSync(path, 'w') };
  } catch {
    return undefined;
  }
}

export interface TfClientOptions {
  /** Absolute path to the tfp wrapper. */
  wrapperPath: string;
  timeoutMs: number;
  /** Arguments inserted before the caller's, for tests. Normally empty. */
  argsPrefix?: string[];
  /** Extra environment for the child. Never logged. */
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /**
   * Receives one line per tf invocation. Optional so TfClient stays free of
   * vscode, but in practice always wired: without it the output channel was
   * EMPTY unless something failed, so there was no trail at all for an
   * extension whose whole job is spawning an external process against an
   * irreversible system -- and "the log contains no token" could not be
   * checked, because there was no log.
   *
   * Arguments are scrubbed before they reach this. Output is never logged
   * here: a recursive status against this collection is 38 MB.
   */
  log?: (line: string) => void;
}

export interface TfResult {
  /** Raw bytes. NEVER decode this before you know the encoding. */
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number;
  timedOut: boolean;
  /**
   * The signal that killed the child, when one did.
   *
   * Node reports a SIGNALLED process as `code === null`, and the exit code
   * then says nothing. Set here so a caller can tell "tf reported failure"
   * from "we never learned the outcome" -- they need opposite handling, and
   * conflating them showed a user tf's own SUCCESS output inside a red error
   * dialog (FEDORA, 2026-09-18: a checkout that worked, reported as exit -1).
   */
  terminatedBy?: NodeJS.Signals;
  /** True when `RunOptions.signal` aborted the call. The outcome is then unknown, as for a timeout. */
  cancelled?: boolean;
}

/** Per-call overrides for `TfClient.run`. Every field is optional. */
export interface RunOptions {
  /** Working directory for this call only (Create Workspace runs in an empty temp folder, design P1). */
  cwd?: string;
  /** This call's timeout; `'none'` for a Get that may run for many minutes (design W5). */
  timeoutMs?: number | 'none';
  /** Each stdout chunk as it arrives, for progress. The full stdout is still returned. */
  onStdout?: (chunk: Buffer) => void;
  /** Aborting kills the process tree the way a timeout does; the result says `cancelled`. */
  signal?: AbortSignal;
}

/**
 * Characters that cmd.exe or the wrapper rewrite inside a quoted argument;
 * refused rather than escaped — see below. Measured against a wrapper
 * faithful to the real tfp.cmd (`setlocal enabledelayedexpansion`, `%*`
 * followed by an unquoted `!TFSPAT!`):
 *
 *   $/Vesta/Foo!bar!.cs        -> $/Vesta/Foo.cs           a DIFFERENT file
 *   $/Vesta/%OS%.cs            -> $/Vesta/Windows_NT.cs    a DIFFERENT file
 *   $/Vesta/caret ^ literal.cs -> $/Vesta/caret  literal.cs (caret gone)
 *
 * An odd number of `!` also swallows the wrapper's own trailing /noprompt and
 * /login:, after which tf opens a GUI dialog that windowsHide hides.
 *
 * `%` and `!`/`^` are two different mechanisms. `%` is expanded on the OUTER
 * `cmd /d /s /c` line itself, before the wrapper ever runs -- a variable set
 * only inside the wrapper arrives unexpanded, while `%OS%` (already in the
 * environment) expands. No wrapper shape avoids it.
 *
 * `!` and `^` come from delayed expansion's OWN second pass, over the
 * WRAPPER's line once it runs, which does not respect quotes. ANY `!` on
 * that line triggers it, and the real wrapper always supplies one of its own
 * (`!TFSPAT!`), so a caret is stripped even when none of OUR arguments
 * contains a `!`. The pass also treats `^` as its own escape: `^^` collapses
 * to one literal `^`. Both are pinned by the "PINS the caret-stripping
 * premise" test. So doubling every caret in quoteForCmd WOULD
 * survive the real wrapper's line -- refusing is a choice, made because that
 * survival depends on a fact about a script we do not control and share with
 * the user's own terminal, and trusting it on an irreversible operation is
 * the two-layer-rewriting risk this file exists to avoid.
 *
 * CR and LF are refused for the same reason: a newline ends the wrapper's
 * line early, and a CR is silently deleted -- both corrupt the item exactly
 * as `!` and `%` do.
 */
const CMD_UNSAFE = /[!%^\r\n]/;

/** Arguments that cannot survive the .cmd wrapper intact. */
export function findUnsafeArgs(args: readonly string[]): string[] {
  return args.filter((a) => CMD_UNSAFE.test(a));
}

/**
 * A candidate for the verb: not `vc` and not an option. The verb is the FIRST
 * such argument -- see isReconcileMissingPreview for why it is not "the one
 * after `vc`". Shared by the two guards below so they cannot disagree.
 */
const isVerbCandidate = (a: string): boolean =>
  a.toLowerCase() !== 'vc' && !a.startsWith('/') && !a.startsWith('-');

/**
 * Whether `args` invokes `reconcile` without `/preview`.
 *
 * Defence in depth for the one property the unversioned-files scan rests on
 * (see UnversionedScan's own doc comment): `/preview` is what makes
 * `tf vc reconcile /promote /adds` list what it would do instead of doing
 * it. A missing `/preview`, added to a second call site that no test caught,
 * once pended 79,929 changes against a real workspace with 584 green tests.
 * This does not know or trust what built the command line -- it refuses the
 * shape itself, on BOTH platforms, so a future call site cannot reintroduce
 * that incident no matter how many other tests stay green when it does.
 *
 * The verb is the FIRST argument that is not `vc` (case-insensitive) and does
 * not start with `/` or `-` -- NOT "the argument after `vc`". TF.exe accepts
 * a verb with no `vc` at all: the real tfp.cmd's own usage comment invokes it
 * as `tfp checkout ...` and `tfp status /recursive`, never `tfp vc checkout
 * ...`. A guard keyed on `vc` being present would never see
 * `run(['reconcile', '/promote', '/adds', root])` -- exactly the shape that
 * pends every change it lists.
 */
function isReconcileMissingPreview(args: readonly string[]): boolean {
  const verb = args.find(isVerbCandidate);
  if (verb?.toLowerCase() !== 'reconcile') return false;
  // Deliberately asymmetric, and fail-safe because of it: `-preview` is
  // skipped above as an option when hunting for the verb, same as any other
  // `-`-prefixed argument, but it does NOT count as proof of safety here --
  // only the exact `/preview` spelling does. Being broad about what is "not
  // the verb" costs nothing; being broad about what counts as "/preview is
  // present" would.
  return !args.some((a) => a.toLowerCase() === '/preview');
}

const RESOLVE_AUTOS = new Set(['automerge', 'taketheirs', 'keepyours', 'overwritelocal']);

/**
 * Whether `args` invokes `resolve` in any shape but the two phase 5 builds:
 * the LISTING -- `/preview` and `/recursive`, no
 * `/auto:` -- or one RESOLUTION -- exactly one `/auto:` from the four offered,
 * no `/preview`, and more than one item or `/recursive` only for AutoMerge.
 * Either way at least one itemspec, every one an absolute local path in tf's
 * form, and no wildcard.
 *
 * Defence in depth, in the same spirit as the reconcile guard: a bare
 * `resolve` prompts, which `/noprompt` turns into a failure at best; a
 * listing without `/recursive` answers "none" over a folder that has a
 * conflict inside (C9); `/auto:KeepYours` over a folder would overwrite every
 * other user's change under it at the next Check In (C14) without a single
 * question. This does not trust whatever built the argv -- it refuses the
 * shape itself, so a future call site cannot reintroduce any of those.
 *
 * Any `-` spelling of an option is refused outright rather than understood:
 * only the exact `/` spellings count, as with the reconcile guard's
 * `/preview`.
 */
export function isResolveOutOfShape(args: readonly string[]): boolean {
  const at = args.findIndex(isVerbCandidate);
  if (at < 0 || args[at].toLowerCase() !== 'resolve') return false;
  // Everything but the verb and a `vc` in front of it: tf reads options
  // wherever they appear.
  const rest = args.filter((a, i) => i !== at && !(i < at && a.toLowerCase() === 'vc'));
  if (rest.some((a) => a.startsWith('-'))) return true;
  const options = rest.filter((a) => a.startsWith('/')).map((a) => a.toLowerCase());
  const items = rest.filter((a) => !a.startsWith('/'));
  // Only the form resolveArgs builds counts as an item: an absolute local
  // path in tf's form. A blank, a relative path, `$/…`, `@file` or a
  // space-prefixed ` /auto:…` might be dropped or read as an option by tf,
  // leaving a destructive resolution with no item -- the whole workspace.
  const isItem = (i: string) => /^[A-Za-z]:\\/.test(i) || i.startsWith('\\\\');
  if (items.length === 0 || items.some((i) => !isItem(i) || /[*?]/.test(i))) return true;
  if (options.some((o) => o !== '/preview' && o !== '/recursive' && !o.startsWith('/auto:'))) return true;
  const autos = options.filter((o) => o.startsWith('/auto:')).map((o) => o.slice('/auto:'.length));
  const recursive = options.includes('/recursive');
  if (options.includes('/preview')) return !recursive || autos.length > 0;
  if (autos.length !== 1 || !RESOLVE_AUTOS.has(autos[0])) return true;
  if (autos[0] === 'automerge') return false;
  return recursive || items.length !== 1;
}

/**
 * cmd.exe refuses a command line over 8191 characters, counting the
 * `C:\WINDOWS\system32\cmd.exe /d /s /c ` prefix as well as what we pass.
 *
 * Measured against a wrapper faithful to the real tfp.cmd, with server paths
 * of ~58 characters (typical for this collection):
 *
 *   137 items, line 8102 -> ran, argc 142
 *   138 items, line 8160 -> "The command line is too long.", exit 1, NOTHING ran
 *
 * It fails safely — no partial check-in — but the user gets cmd.exe's message,
 * not ours, and no idea what to do about it.
 *
 * `tf vc checkin` takes `@file` for /comment, /notes and /override but NOT for
 * the item list (verified against TF 15.129's own help), so there is no way to
 * pass a long list out of band. Splitting into several `checkin` calls is the
 * one thing we must not do: it would turn one changeset into several, silently,
 * on an operation that cannot be undone. Refusing with a count the user can act
 * on is the honest answer.
 */
export const CMD_LINE_LIMIT = 8191;

/**
 * How long to keep waiting for stderr after the child has exited and stdout
 * has ended. Anything `tf` wrote is already delivered by then; the only writer
 * still holding the pipe under Wine is `wineserver`, which has nothing to say.
 * See the comment on maybeFinish.
 */
export const STDERR_GRACE_MS = 150;

/**
 * Spawn the child into its OWN process group, so a timeout can signal the
 * whole tree.
 *
 * This constant is used in exactly two places - the spawn options and
 * killTree - and they must agree. Signalling a process GROUP is
 * `process.kill(-pid)`, and if the child were NOT a group leader that negative
 * pid is the extension host's own group: VS Code would kill itself trying to
 * clean up after a slow `tf`. Tying both sides to one expression is what makes
 * the negative pid safe to use.
 *
 * Not on Windows, where `detached` means a new console window - which
 * `windowsHide` then hides, leaving an invisible one - and where `taskkill /T`
 * already walks the tree.
 */
export const SPAWN_DETACHED = process.platform !== 'win32';

/** How long the tree gets to exit on SIGTERM before SIGKILL. */
export const SIGKILL_AFTER_MS = 500;

/**
 * The largest delay `setTimeout` honours (2^31 - 1 ms, ~24.8 days). Above
 * this -- or for a non-finite value -- Node fires almost immediately instead
 * of waiting, which is the opposite of what a caller passing a huge or
 * infinite `timeoutMs` means. See the `run` timer.
 */
export const MAX_TIMEOUT_MS = 2 ** 31 - 1;

/**
 * Reserved for the options the wrapper appends to its own line after `%*`
 * (`/noprompt /loginType:OAuth /login:.,<PAT>`), which we never see and whose
 * PAT length varies by token.
 */
const WRAPPER_APPEND_RESERVE = 256;

/** The exact line handed to cmd.exe, so the guard measures what cmd measures. */
export function buildCmdLine(wrapperPath: string, args: readonly string[]): string {
  return `"${quoteForCmd(wrapperPath)} ${args.map(quoteForCmd).join(' ')}"`;
}

export function cmdLineBudget(shell: string): number {
  return CMD_LINE_LIMIT - shell.length - ' /d /s /c '.length - WRAPPER_APPEND_RESERVE;
}

/**
 * The stable prefix of the length-refusal message below, exported so a
 * caller (`UnversionedScan`) can recognise THIS specific refusal from
 * `classifyError`'s `originalMessage` without re-deriving `cmdLineBudget`'s
 * arithmetic itself.
 */
export const TOO_MANY_ITEMS_PREFIX = '[tfvc] Too many items for one tf command';

/** Our own refusal when the configured wrapper is not on disk. Classified as `wrapperMissing`. */
export const WRAPPER_NOT_FOUND_PREFIX = '[tfvc] Wrapper not found';

/**
 * How many of these arguments are items, for a message the user can act on.
 * "402 items" when 400 files were selected reads as a bug; the verbs `vc` and
 * `checkin` are not items and must not be counted.
 */
export function countItemspecs(args: readonly string[]): number {
  return args.filter((a) => !a.startsWith('/') && (a.startsWith('$/') || /[\\/]/.test(a))).length;
}

export class TfClient {
  constructor(private readonly options: TfClientOptions) {}

  run(args: string[], opts: RunOptions = {}): Promise<TfResult> {
    const all = [...(this.options.argsPrefix ?? []), ...args];
    const started = Date.now();
    const log = this.options.log;
    log?.(`tfp ${scrubSecrets(all.join(' '))}`);

    return new Promise<TfResult>((resolve) => {
      // Refuse before any platform-specific quoting logic runs: unlike the
      // unsafe-character guard below, this applies on BOTH machines, not just
      // the Windows .cmd branch. See isReconcileMissingPreview.
      //
      // Checked against `args`, the CALLER's array, not `all` (argsPrefix +
      // args) -- unlike the unsafe-character and length guards below, which
      // use `all` because THEIR job is the bytes that actually reach cmd.
      // This guard's job is meaning, and argsPrefix is test plumbing
      // (interpreter flags standing in for the wrapper; never set in src/, so
      // production always has args === all) that must not be able to hide
      // the verb from it or forge a `/preview` on its behalf.
      if (isReconcileMissingPreview(args)) {
        resolve({
          stdout: Buffer.alloc(0),
          stderr: Buffer.from(
            [
              '[tfvc] Refusing to run "reconcile" without /preview: without it,',
              'reconcile PENDS every change it lists instead of merely listing them --',
              'a missing /preview once pended 79,929 changes against a real workspace.',
              'Nothing was run.',
            ].join('\n'),
            'utf8',
          ),
          exitCode: -1,
          timedOut: false,
        });
        log?.('  -> REFUSED: reconcile without /preview');
        return;
      }

      // Same reasoning, same place, same caller's-args rule: see isResolveOutOfShape.
      if (isResolveOutOfShape(args)) {
        resolve({
          stdout: Buffer.alloc(0),
          stderr: Buffer.from(
            [
              '[tfvc] Refusing to run "resolve" in a shape this extension never builds:',
              `  ${scrubSecrets(args.join(' '))}`,
              'Only the /preview listing and one /auto: resolution are allowed --',
              'anything else can resolve conflicts nobody chose.',
              'Nothing was run.',
            ].join('\n'),
            'utf8',
          ),
          exitCode: -1,
          timedOut: false,
        });
        log?.('  -> REFUSED: resolve out of shape');
        return;
      }

      // A wrapper that is not there is the commonest first-run failure, and
      // spawning it explains nothing: ENOENT on Linux, and on Windows cmd.exe's
      // own "is not recognized" in the machine's language. Only an ABSOLUTE
      // path is checked; a bare name is left to PATH lookup, which only the
      // spawn itself can do.
      if (isAbsolute(this.options.wrapperPath) && !existsSync(this.options.wrapperPath)) {
        resolve({
          stdout: Buffer.alloc(0),
          stderr: Buffer.from(`${WRAPPER_NOT_FOUND_PREFIX}: ${this.options.wrapperPath}`, 'utf8'),
          exitCode: -1,
          timedOut: false,
        });
        log?.('  -> REFUSED: wrapper not found');
        return;
      }

      const isCmd = process.platform === 'win32' && /\.(cmd|bat)$/i.test(this.options.wrapperPath);

      // Refuse rather than silently act on the wrong item. See findUnsafeArgs.
      const unsafe = isCmd ? findUnsafeArgs(all) : [];
      if (unsafe.length > 0) {
        resolve({
          stdout: Buffer.alloc(0),
          stderr: Buffer.from(
            [
              '[tfvc] Cannot safely pass "!", "%", "^" or a newline/CR to tf through ' +
                'this wrapper:',
              ...unsafe.map((a) => `  ${a}`),
              'Nothing was run. Visual Studio can act on these items.',
            ].join('\n'),
            'utf8',
          ),
          exitCode: -1,
          timedOut: false,
        });
        log?.(`  -> REFUSED: unsafe characters in ${unsafe.length} argument(s)`);
        return;
      }

      // A .cmd is not an executable, so Windows needs a shell to run it. But
      // `shell: true` does NOT quote arguments: a path containing a space
      // splits into two, and `&` in a check-in comment would execute. So we
      // invoke the interpreter ourselves and quote every argument by hand.
      const shell = process.env.ComSpec ?? 'cmd.exe';
      const commandLine = isCmd ? buildCmdLine(this.options.wrapperPath, all) : '';

      // Refuse before spawning, so the user gets a count and a next step
      // instead of cmd.exe's "The command line is too long." See CMD_LINE_LIMIT.
      //
      // NOT gated on isCmd. On Fedora the wrapper is ~/bin/tfp, not a .cmd, so
      // this was skipped entirely — and the reasoning above (never split one
      // changeset into several) applies to both machines equally. Linux
      // execve allows ~2 MB, so the oversize list is handed to TF.exe under
      // Wine, which must rebuild a Windows command line capped at 32,767
      // characters. A truncation there is a PARTIAL item list on an operation
      // that cannot be undone, which is exactly what this exists to prevent.
      const measured = isCmd
        ? commandLine.length
        : Buffer.byteLength(all.join(' '), 'utf8') + this.options.wrapperPath.length;
      if (measured > cmdLineBudget(shell)) {
        resolve({
          stdout: Buffer.alloc(0),
          stderr: Buffer.from(
            [
              `${TOO_MANY_ITEMS_PREFIX}: ${countItemspecs(all)} items ` +
                `need ${measured} characters, and the limit is ` +
                `${cmdLineBudget(shell)}.`,
              'Nothing was run, and nothing was changed on the server.',
              'Do this in smaller batches — exclude some changes, act on the rest, ' +
                'then repeat. tf cannot take the item list from a file.',
            ].join('\n'),
            'utf8',
          ),
          exitCode: -1,
          timedOut: false,
        });
        log?.(`  -> REFUSED: command line ${measured} > ${cmdLineBudget(shell)}`);
        return;
      }

      if (opts.signal?.aborted) {
        resolve({ stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: -1, timedOut: false, cancelled: true });
        log?.('  -> CANCELLED before it started');
        return;
      }

      /**
       * stderr goes to a FILE, not a pipe.
       *
       * Node's 'close' fires only when every writer has released the child's
       * stdio, and under Wine that is not the child: `wineserver` inherits the
       * stderr PIPE and holds it for its persistence timeout, ~3 s, long after
       * `tf` has exited. Measured on FEDORA, `tf` finished at 1241 ms and
       * 'close' arrived at 5310 ms, so every command looked four seconds
       * slower than it was.
       *
       * A file descriptor is not a stream, so it cannot gate 'close' and
       * nothing downstream can hold it open. That removes the problem rather
       * than working around it: we still wait for the genuine 'close', we
       * still get every byte of stderr, and there is no heuristic about when
       * it is safe to stop waiting. Measured on the same machine: 763-883 ms,
       * against 771-1309 ms for the heuristic it replaces.
       *
       * If the file cannot be opened - a full or unwritable temp directory -
       * stderr falls back to a pipe and the exit-based settle below takes
       * over. Worse, but never worse than before.
       */
      const stderrFile = openStderrFile();
      const stdio: StdioOptions = ['pipe', 'pipe', stderrFile ? stderrFile.fd : 'pipe'];

      const child = isCmd
        ? spawn(
            shell,
            ['/d', '/s', '/c', commandLine],
            {
              cwd: opts.cwd ?? this.options.cwd,
              env: { ...process.env, ...this.options.env },
              windowsHide: true,
              windowsVerbatimArguments: true,
              stdio,
            },
          )
        : spawn(this.options.wrapperPath, all, {
            cwd: opts.cwd ?? this.options.cwd,
            env: { ...process.env, ...this.options.env },
            windowsHide: true,
            stdio,
            // Its own process group, so killTree can signal the whole tree.
            // NOT unref'd: we still want to wait for it.
            detached: SPAWN_DETACHED,
          });

      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let timedOut = false;
      let cancelled = false;

      const limit = opts.timeoutMs ?? this.options.timeoutMs;
      // Node's setTimeout treats a delay that is not finite, or over the
      // 32-bit signed range it stores it in, as "1 ms" rather than "never" --
      // `Infinity` measured firing the callback almost immediately instead of
      // not at all. Non-finite means no bound was really intended, and a
      // finite but oversized value is clamped to the largest delay Node can
      // actually honour rather than reinterpreted as urgent.
      const timer =
        limit === 'none' || !Number.isFinite(limit)
          ? undefined
          : setTimeout(() => {
              timedOut = true;
              killTree(child);
              // killTree is best-effort. If the tree survives, the grandchild still
              // holds the inherited stdout handles, so 'close' never fires and the
              // promise would outlive its own timeout indefinitely — measured at 6 s
              // against a 300 ms limit. Settle regardless after a short grace period.
              // `exited ?? -1`, NOT -1. The child's real exit code may already be
              // known: it can exit cleanly just before the deadline while a
              // `wineserver` still holds the stdout pipe, so 'close' never fires and
              // this settle runs. Hard-coding -1 there threw away a 0 and made
              // `timedOut && exitCode !== 0` true — which is the exact reporting bug
              // described below, reached by the other path. A `tf vc checkin` that
              // COMMITTED would be reported as a timeout, and the obvious next
              // action is to press Check In again on something that cannot be undone.
              setTimeout(() => finish(exited ?? -1), 2000).unref?.();
            }, Math.min(limit, MAX_TIMEOUT_MS));

      // Non-null because stdio[1] is always 'pipe' above; TypeScript only
      // widens it because the stdio array is now given explicitly. stdout is
      // the one stream we must never divert to a file - it carries the XML.
      const childStdout = child.stdout!;
      childStdout.on('data', (b: Buffer) => {
        stdout.push(b);
        // A late chunk can still arrive after finish() has already resolved
        // (the same exit-to-close gap as `cancelled` above: something can go
        // on holding the pipe after we stopped waiting for it), and a caller
        // who has moved on must not be called into again.
        if (settled) return;
        // A progress callback must never be able to lose the output or hang the call.
        try {
          opts.onStdout?.(b);
        } catch {
          // ignored
        }
      });
      // null when stderr went to a file, which is the normal path.
      child.stderr?.on('data', (b: Buffer) => {
        stderr.push(b);
        // Restart the idle window: more is clearly still coming.
        if (graceTimer) maybeFinish();
      });

      let settled = false;
      const finish = (exitCode: number) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(graceTimer);

        // Collect stderr from the file and remove it. Every step is guarded:
        // this runs on the timeout path too, where the child may have been
        // killed mid-write, and losing the temp file must never turn a
        // completed command into a rejected promise.
        if (stderrFile) {
          try { closeSync(stderrFile.fd); } catch { /* already closed */ }
          try { stderr.push(readFileSync(stderrFile.path)); } catch { /* nothing written */ }
          try { unlinkSync(stderrFile.path); } catch { /* left for the OS */ }
        }

        const bytes = stdout.reduce((n, b) => n + b.length, 0);
        log?.(
          `  -> exit ${exitCode}${termSignal ? ` (KILLED BY ${termSignal})` : ''}` +
            `${timedOut && exitCode !== 0 ? ' (TIMED OUT)' : ''}` +
            `${cancelled && exitCode !== 0 ? ' (CANCELLED)' : ''}` +
            `, ${bytes} bytes, ${Date.now() - started} ms`,
        );
        opts.signal?.removeEventListener('abort', onAbort);
        resolve({
          stdout: Buffer.concat(stdout),
          stderr: Buffer.concat(stderr),
          exitCode,
          // A command that FINISHED is not a command that timed out, even if
          // the deadline passed first. The timer sets timedOut and only then
          // kills; if the child was already closing, 'close' arrives with the
          // real exit code and used to be reported as {exitCode: 0,
          // timedOut: true} — measured 150/150 when the child exits at exactly
          // timeoutMs. Every consumer checks timedOut BEFORE the exit code, so
          // a check-in that committed was reported as a timeout: the panel kept
          // showing the files as pending, the comment stayed in the box, and
          // the obvious next action was to press Check In again on an operation
          // that cannot be undone.
          //
          // Exit code 0 is the discriminator: taskkill /F and a killed cmd.exe
          // both yield non-zero, so 0 means the command really completed.
          timedOut: timedOut && exitCode !== 0,
          terminatedBy: termSignal,
          // Same discriminator as timedOut, and for the same reason: an abort
          // that lands in the exit-to-close gap -- the child already reported
          // its real exit code, and 'close' is only late because something
          // (a wineserver, a background grandchild on Windows) still holds the
          // stdout pipe -- must not turn a command that FINISHED into one
          // reported as cancelled. Exit code 0 is what proves it finished.
          ...(cancelled && exitCode !== 0 ? { cancelled: true } : {}),
        });
      };

      child.on('error', (err) => {
        stderr.push(Buffer.from(`[spawn] ${err.message}`, 'utf8'));
        finish(-1);
      });

      /**
       * FALLBACK ONLY — reached when stderr had to be a pipe because the temp
       * file could not be opened.
       *
       * It settles on exit plus a drained stdout rather than on 'close', which
       * is what a pipe held open by `wineserver` would otherwise delay by ~4 s.
       * It is a heuristic: it abandons stderr after an idle window, and
       * nothing proves that window is either necessary or sufficient. The
       * normal path above avoids all of that by not giving stderr a pipe at
       * all, so this exists only so a full temp directory degrades to the
       * previous behaviour instead of a four-second stall.
       */
      let exited: number | undefined;
      /** Set when the child was killed rather than exiting. See TfResult. */
      let termSignal: NodeJS.Signals | undefined;
      let stdoutEnded = false;
      let stderrEnded = false;
      let graceTimer: NodeJS.Timeout | undefined;

      const maybeFinish = () => {
        // With stderr on a file there is no pipe for anything to hold, so
        // 'close' is trustworthy and is what we wait for.
        if (stderrFile) return;
        if (exited === undefined || !stdoutEnded || settled) return;
        if (stderrEnded) {
          clearTimeout(graceTimer);
          finish(exited);
          return;
        }
        // Give a straggling stderr a moment, then stop waiting for it. The
        // timer is restarted on every chunk (see the stderr 'data' handler),
        // so this is an IDLE period rather than a flat deadline: a large
        // payload still in flight at exit drains completely, while a pipe held
        // open by a process with nothing to say is abandoned promptly.
        clearTimeout(graceTimer);
        graceTimer = setTimeout(() => finish(exited ?? -1), STDERR_GRACE_MS);
        graceTimer.unref?.();
      };

      childStdout.on('end', () => {
        stdoutEnded = true;
        maybeFinish();
      });
      child.stderr?.on('end', () => {
        stderrEnded = true;
        maybeFinish();
      });
      child.on('exit', (code, signal) => {
        // `code` is null when the child was SIGNALLED, and `signal` is the only
        // thing that says what happened. Recording -1 and dropping the signal
        // made a killed process indistinguishable from one that returned -1,
        // so a checkout that had already written its success output and done
        // its work was reported as a failure with that output as the message.
        termSignal = signal ?? undefined;
        exited = code ?? -1;
        maybeFinish();
      });
      // The NORMAL settle point when stderr went to a file, and a backstop
      // otherwise: if a stream errors rather than ending, 'close' still
      // arrives and finish() is idempotent.
      child.on('close', (code, signal) => {
        termSignal ??= signal ?? undefined;
        finish(exited ?? code ?? -1);
      });

      // Same kill-then-settle as the timeout: a killed grandchild can keep the
      // stdout pipe open, so settle after a grace period regardless.
      function onAbort(): void {
        cancelled = true;
        killTree(child);
        setTimeout(() => finish(exited ?? -1), 2000).unref?.();
      }
      opts.signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  get timeoutMs(): number {
    return this.options.timeoutMs;
  }

  /** The directory a call without its own `cwd` runs in; tf's output is relative to it. */
  get cwd(): string | undefined {
    return this.options.cwd;
  }
}

export type TfErrorKind =
  | 'patMissing' | 'patRejected' | 'tfNotFound' | 'wineMissing'
  | 'wrapperMissing' | 'commandNotFound'
  | 'notInWorkspace' | 'accessDenied' | 'timeout' | 'unknown';

export interface TfError {
  kind: TfErrorKind;
  /** The TF##### code when there was one. */
  code?: string;
  /** The tool's own message, VERBATIM. Never paraphrased, never dropped. */
  originalMessage: string;
}

/** Wrapper failures are prefixed `[tfp]`, so they need no guessing. */
const WRAPPER_PATTERNS: ReadonlyArray<[RegExp, TfErrorKind]> = [
  [/\[tfp\][^\n]*PAT file (not found|is empty|has an empty)/i, 'patMissing'],
  [/\[tfp\][^\n]*TF\.exe not found/i, 'tfNotFound'],
  [/\[tfp\][^\n]*Wine prefix not found/i, 'wineMissing'],
  [/\[tfvc\] Wrapper not found/, 'wrapperMissing'],
];

/** Keyed on the CODE, never on message text, because the text is localized. */
const CODE_KINDS: Readonly<Record<string, TfErrorKind>> = {
  TF30063: 'patRejected',
  TF14098: 'accessDenied',
  TF14061: 'notInWorkspace',
  TF400813: 'patRejected',
};

export function classifyError(exitCode: number, stdout: string, stderr: string): TfError | undefined {
  if (exitCode === 0) return undefined;

  // Scrubbed HERE, where the message is built, rather than at each consumer.
  // Four call sites remembered to scrub and three did not; making
  // originalMessage safe by construction removes the chance to forget.
  const combined = scrubSecrets([stderr, stdout].filter(Boolean).join('\n').trim());

  for (const [pattern, kind] of WRAPPER_PATTERNS) {
    if (pattern.test(combined)) {
      return { kind, originalMessage: combined };
    }
  }

  const codeMatch = /\b(TF\d{5,6})\b/.exec(combined);
  if (codeMatch) {
    const code = codeMatch[1];
    return { kind: CODE_KINDS[code] ?? 'unknown', code, originalMessage: combined };
  }

  // 127 is the POSIX shell's "command not found". On Linux the wrapper is a
  // shell script, so this is something it runs (wine, winepath) missing from
  // where it runs -- inside a Flatpak VS Code, always. Keyed on the exit code
  // because the shell's own message is localised.
  if (exitCode === 127) {
    return {
      kind: 'commandNotFound',
      originalMessage: combined || 'The command failed with exit code 127 and no output.',
    };
  }

  return {
    kind: 'unknown',
    originalMessage: combined || `The command failed with exit code ${exitCode} and no output.`,
  };
}

/**
 * The thin line-scanner for text-output commands (checkout, undo, add, get).
 * This lives in TfClient, NOT parse.ts — parse.ts stays strictly XML-only.
 *
 * tf prints a directory header ending in ':' followed by bare file names, and
 * for undo prefixes them with a verb: "Undoing edit: Foo.cs".
 * It never parses dates — tf's date format differs per machine locale.
 *
 * The header is RELATIVE to the directory tf ran in when the item is under
 * it, and absent for an item directly in it; only outside it is the header
 * absolute. `cwd` is that directory in tf's own terms (`Z:\...` under Wine).
 * Without it a relative header is dropped rather than passed off as
 * absolute: Undo read `Integrator.Standard.POSIntegration\PayDevice:` as a
 * full path, matched no editor, and left the typed edit on screen over a file
 * tf had just made read-only.
 */
export function scanAffectedItems(stdout: string, cwd?: string): string[] {
  const items: string[] = [];
  const under = (base: string, rest: string) => (base.endsWith('\\') ? base : base + '\\') + rest;
  let dir = cwd ?? '';

  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '') continue;

    if (line.endsWith(':') && !/^[A-Za-z]+ [a-z]+:/.test(line)) {
      const header = line.slice(0, -1);
      if (header.startsWith('$/')) {
        // A server path: tf listing other users' checkouts of that item
        // ("opened for edit in KARLO;Karlo"). Nothing under it is ours.
        dir = '';
      } else if (/^[A-Za-z]:\\/.test(header) || header.startsWith('\\\\')) {
        dir = header;
      } else {
        dir = cwd ? under(cwd, header) : '';
      }
      continue;
    }

    const name = line.replace(/^[A-Za-z]+ [a-z]+:\s*/, '');
    // A file name cannot contain a colon, so this is one of tf's messages
    // ("...: No file matches."), not an item.
    if (name.includes(':')) continue;
    if (dir) items.push(under(dir, name));
  }

  return items;
}

/**
 * Defence in depth: we never build /login:, but never let one reach a log
 * either. This is load-bearing rather than decorative, because runMutation
 * logs tf's OWN stdout and stderr, not just the arguments we sent.
 *
 * The original pattern matched exactly one shape. Measured against the shapes
 * that actually occur, it let six through: `-login:` (TF accepts `-` as an
 * option prefix), `/login=`, `/login: ` with a space, a token echoed by the
 * shell with no flag at all ("'<token>' is not recognized..."), a `set` dump
 * (`TFSPAT=<token>`), and a URL query (`?pat=<token>`).
 */
export function scrubSecrets(text: string): string {
  return (
    text
      // Any option spelling, with either prefix and either separator, and
      // tolerating a space before the value.
      .replace(/([-/])login[:=]\s*\S*/gi, '$1login:***')
      // A named assignment, however it is spelled.
      .replace(/\b(TFSPAT|PAT|TOKEN|PASSWORD)\s*[:=]\s*\S+/gi, '$1=***')
      // A PAT in a URL, as userinfo or as a query parameter.
      .replace(/(\bhttps?:\/\/)[^/\s:@]+:[^/\s@]+@/gi, '$1***:***@')
      .replace(/([?&](?:pat|token|access_token)=)[^&\s]+/gi, '$1***')
      // A BARE token, with nothing next to it naming it. The docstring above
      // has always claimed the `'<token>' is not recognized as an internal or
      // external command` shape was covered; none of the rules above match it,
      // because there is no flag, no keyword and no URL — just the value.
      //
      // An Azure DevOps PAT is a long run of letters and digits with no
      // separators, which is distinctive: a GUID has dashes, a path has
      // slashes, a changeset id is short. 40 is below the 52 a classic PAT
      // uses and above anything tf prints in the normal course of things.
      .replace(/\b[A-Za-z0-9]{40,}\b/g, '***')
  );
}

/**
 * Kills the whole process tree.
 *
 * On Windows the wrapper is a .cmd, so the real tf.exe is a GRANDCHILD of the
 * cmd.exe we spawned. `child.kill()` reaps only cmd.exe; tf.exe survives,
 * keeps the inherited stdout/stderr handles open, and the pipe never reaches
 * EOF — so Node's 'close' never fires and the timeout bounds nothing.
 * `taskkill /T` walks the tree. Best-effort: the caller settles regardless.
 */
export function killTree(child: {
  pid?: number;
  kill: () => void;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
}): void {
  // Never signal a process that has already gone. Windows reuses PIDs freely,
  // and `child.pid` keeps its value after exit — so between the timeout firing
  // and taskkill running, that number can belong to somebody else's process,
  // and `/T /F` would take its children down with it. A reaped child has a
  // non-null exitCode or signalCode; that is the only safe gate we have.
  if (child.exitCode !== null || child.signalCode !== null) return;

  if (process.platform === 'win32' && child.pid) {
    try {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      // spawn reports a missing executable ASYNCHRONOUSLY. With no 'error'
      // listener Node rethrows it as an uncaught exception, which takes down
      // the extension host — the whole window, over a timeout cleanup. The
      // try/catch above cannot see it: it is not thrown from this stack.
      killer.on('error', () => {
        if (child.exitCode === null && child.signalCode === null) child.kill();
      });
      return;
    } catch {
      // fall through to the plain kill below
    }
  }

  /**
   * POSIX: signal the process GROUP, not just the child.
   *
   * `child.kill()` sends SIGTERM to the direct child only. Under Wine that is
   * the `tfp` shell script, which has `exec`ed wine - and wine starts a
   * `wineserver` that outlives it and inherits the child's file descriptors.
   * We now know exactly what that costs, because a `wineserver` holding an
   * inherited stderr pipe is what made every command look four seconds slower
   * than it was.
   *
   * The negative pid is a group signal, and it is only safe because the child
   * was spawned with `detached: SPAWN_DETACHED` and is therefore its own group
   * leader. Without that, `-pid` is the extension host's group and VS Code
   * would kill itself.
   *
   * SIGTERM first so wine can tear the prefix down cleanly, then SIGKILL for
   * whatever ignored it. The SIGKILL timer is unref'd: it must never hold the
   * extension host open on its own account.
   */
  if (SPAWN_DETACHED && child.pid && leadsOwnGroup(child.pid)) {
    const pid = child.pid;
    try {
      process.kill(-pid, 'SIGTERM');
      const hard = setTimeout(() => {
        // Ask whether the GROUP is still alive, not whether the leader is.
        //
        // This used to test `child.exitCode`, which skips the escalation in
        // precisely the case the group kill exists for: `tfp` dies promptly on
        // SIGTERM and Node reaps it, while the `wineserver` that ignored the
        // signal is still in the group holding descriptors. A dead leader was
        // read as "done" and the SIGKILL never went to the thing that ignored
        // it.
        if (!groupAlive(pid)) return;
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          // ESRCH: it went between the probe and the signal. Good outcome.
        }
      }, SIGKILL_AFTER_MS);
      hard.unref?.();
      return;
    } catch {
      // ESRCH, or the child was never a group leader. Fall through.
    }
  }

  child.kill();
}

/**
 * Whether `pid` is still its own process-group leader.
 *
 * `process.kill(-pid)` signals a GROUP, and the only thing making that safe is
 * that the child was spawned `detached` and so leads its own. The parameter
 * `killTree` takes is a structural duck type with no way to express that, and
 * the constant alone cannot stop a future caller passing a child spawned
 * without it — at which point the negative pid is the extension host's own
 * group and VS Code kills itself.
 *
 * So verify it rather than assume it. Node has no `process.getpgid`, hence
 * /proc on Linux and `ps` elsewhere; if neither can confirm it, the answer is
 * "no" and we fall back to the plain kill. This also covers PID reuse: a recycled
 * pid is almost never a group leader, so it fails here and we fall back to the
 * plain kill.
 */
function leadsOwnGroup(pid: number): boolean {
  // process.kill(-1) signals every process the user owns; never verify that.
  if (!Number.isInteger(pid) || pid <= 1) return false;
  return processGroupOf(pid) === pid;
}

/**
 * Parse the process-group id out of a Linux `/proc/<pid>/stat` line.
 *
 * The format is `pid (comm) state ppid pgrp ...`. `comm` is free text and can
 * hold spaces and parentheses, so only the text after the LAST ')' is
 * splittable: [state, ppid, pgrp, ...]. Anything that does not yield a positive
 * integer is undefined, never a guess.
 */
export function parsePgrpFromStat(stat: string): number | undefined {
  const close = stat.lastIndexOf(')');
  if (close < 0) return undefined;
  const fields = stat
    .slice(close + 1)
    .trim()
    .split(' ');
  const raw = fields[2];
  if (raw === undefined || !/^\d+$/.test(raw)) return undefined;
  const pgrp = Number(raw);
  return Number.isSafeInteger(pgrp) && pgrp > 0 ? pgrp : undefined;
}

/**
 * The process-group id of `pid`, or undefined when it cannot be determined.
 * Every failure (process gone, no /proc, no ps, garbage output) is undefined so
 * the caller treats it as "not verified".
 */
function processGroupOf(pid: number): number | undefined {
  try {
    // Node has no getpgid today (not on Linux, not on macOS), but a future
    // version may add it, and tests stub it.
    const getpgid = (process as unknown as { getpgid?: (p: number) => number }).getpgid;
    if (getpgid) return getpgid(pid);
    if (process.platform === 'linux') {
      return parsePgrpFromStat(readFileSync('/proc/' + pid + '/stat', 'utf8'));
    }
    // No /proc (macOS, BSD): ask ps.
    const out = execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
      windowsHide: true,
    }).trim();
    if (!/^\d+$/.test(out)) return undefined;
    const pgid = Number(out);
    return pgid > 0 ? pgid : undefined;
  } catch {
    // ESRCH / ENOENT: already gone or unreadable. Nothing to verify.
    return undefined;
  }
}

/** Whether any process remains in the group `pid` leads. */
function groupAlive(pid: number): boolean {
  try {
    // Signal 0 performs the permission and existence checks without sending.
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Quotes one argument for cmd.exe. Wraps in double quotes, doubles any
 * embedded quote, and escapes the metacharacters cmd would otherwise act on.
 * Used only on Windows for .cmd/.bat wrappers, which cannot be spawned directly.
 */
export function quoteForCmd(arg: string): string {
  // Windows argv parsing treats a backslash run as literal UNLESS a quote
  // follows it. So every run before a quote must be doubled, and so must a
  // trailing run before the closing quote we add ourselves.
  //
  // Doubling ONLY the trailing run was the earlier bug: `a\"b` was emitted as
  // "a\""b", where \" became a literal quote, the next " CLOSED the quoted
  // region, and every later argument was absorbed into this one. Measured
  // through a faithful wrapper, four arguments arrived as three, with the
  // second itemspec, the wrapper's own /noprompt, and its /login:.,<token>
  // all folded into the first — losing /noprompt makes tf open the GUI dialog
  // that windowsHide renders invisible.
  //
  // This one replace handles both the run and the quote: N backslashes become
  // 2N and the quote is doubled to "" in the same pass. Doing it in two passes
  // double-escaped the quote and broke every comment containing one.
  const quoteEscaped = arg.replace(/(\\*)"/g, '$1$1""');
  // A trailing run needs the same treatment against OUR closing quote: `C:\dir\`
  // would otherwise emit "C:\dir\", the lone \ escaping the closing quote, so
  // the argument arrives as `C:\dir"` and every later boundary shifts. A bare
  // directory passed to a recursive tf command hits exactly this.
  const escaped = quoteEscaped.replace(/(\\+)$/, '$1$1');
  // NO caret escaping. The argument is already inside double quotes, where
  // cmd does not treat & | < > ^ as special — so on a plain line a caret is
  // never consumed and is delivered literally. Measured against a real .cmd
  // wrapper:
  //
  //   with carets:    "/comment:R&D branch merge" -> "/comment:R^&D branch merge"
  //                   "/comment:100% done <final>" -> "...done ^<final^>"
  //   without:        both arrive intact, and A&echo PWNED&rem B still does
  //                   NOT execute — the quoting alone stops injection.
  //
  // Escaping here corrupted ordinary comments into permanent check-in history.
  //
  // The real tfp.cmd's line is not plain, though, and doubling every caret
  // here would in fact survive it too — see CMD_UNSAFE's doc comment for the
  // mechanism and why refusing upstream is the more robust choice anyway.
  return `"${escaped}"`;
}
