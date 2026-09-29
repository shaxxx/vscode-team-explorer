import * as vscode from 'vscode';
import * as path from 'node:path';
import { statSync } from 'node:fs';
import { classifyError, scrubSecrets, TOO_MANY_ITEMS_PREFIX, type TfClient } from '../tf/TfClient.js';
import type { Platform } from '../tf/PathMapper.js';
import { scanExclusion, type Ignorer } from '../ignore/IgnoreMatcher.js';
import { parseReconcile, type ParsedReconcile } from '../tf/parseReconcile.js';
import { parseInfo } from '../tf/parseInfo.js';
import { S } from '../tf/strings.js';
import { ScanResult } from './ScanResult.js';

/**
 * The scan's default `folderExists`: whether `absolutePath` names a real
 * directory. Injected rather than called inline so a test can fake "no such
 * directory" without touching disk -- see `doRun`'s use of it on every header
 * `parseReconcile` returns.
 */
function statIsDirectory(absolutePath: string): boolean {
  try {
    return statSync(absolutePath).isDirectory();
  } catch {
    return false;
  }
}

/** How much of a non-zero exit's scrubbed message the log gets. See `capForLog`. */
const FAILURE_LOG_MAX_LINES = 5;
const FAILURE_LOG_MAX_CHARS = 500;

/**
 * How long `noteArrival`/`noteDeparture` wait, after the last one, before
 * firing `onDidChange`. Trailing, not leading: a rename/move is a delete then
 * a create, and a build or a Get Latest can touch hundreds of paths in a
 * burst -- firing per event would re-render the tree and the panel hundreds
 * of times for one human-visible change. 200 ms is comfortably above VS
 * Code's own decoration-refresh debounce, so the tree has already asked (and
 * possibly gotten a stale answer) by the time this fires and asks it to ask
 * again.
 */
const WATCHER_DEBOUNCE_MS = 200;

/**
 * At most the first `FAILURE_LOG_MAX_LINES` lines and `FAILURE_LOG_MAX_CHARS`
 * characters of `message`, with `...` appended when either cut anything.
 *
 * tf's own error text can run to a full recursive listing; the output channel
 * is a log a human reads, not a place to reproduce it in full.
 */
function capForLog(message: string): string {
  const lines = message.split('\n');
  let cut = lines.length > FAILURE_LOG_MAX_LINES;
  let capped = lines.slice(0, FAILURE_LOG_MAX_LINES).join('\n');
  if (capped.length > FAILURE_LOG_MAX_CHARS) {
    capped = capped.slice(0, FAILURE_LOG_MAX_CHARS);
    cut = true;
  }
  return cut ? `${capped}...` : capped;
}

/**
 * Finds files that are not in source control, in the background.
 *
 * `tf vc status` reports only PENDING changes, so an unversioned file is
 * invisible to it. `reconcile` is the command built for this, and `/preview`
 * makes it INERT -- it lists what it would promote and pends nothing. The
 * exact command line below, including `/noignore` and every exclusion passed
 * explicitly, was verified inert three times against a live workspace:
 * pending count 49 before and 49 after every run, 2026-09-18
 * (test/fixtures/README.md finding 19).
 *
 * That inertness is the only thing between this feature and a repeat of the
 * 79,929-pending-change incident. If this command line is ever edited, verify
 * the pending count before and after on a real workspace before committing.
 *
 * Never blocking: the extension activates, the panel works and every command is
 * usable before the first scan finishes. Cost is real -- 0.8 s for a small
 * project, 2.2 s for a large one with exclusions, 17-20 s for the whole
 * collection -- but it is never in front of the user.
 */
export class UnversionedScan implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;

  private current = ScanResult.notRun();
  private inFlight: Promise<void> | undefined;
  private disposed = false;
  /**
   * `true` once `vc info` has agreed with a listing. Cached because the state
   * behind the contradiction -- a mapped folder nobody has downloaded -- only
   * ever gets fixed, never re-broken, and caching the answer that means
   * "behave exactly as before" is the safe direction. Never cached negative.
   */
  private listingTrusted: boolean | undefined;
  /** See `warnListingUntrusted`: once per session, however many scans run. */
  private warnedListingUntrusted = false;
  /**
   * Arrivals and departures reported while THIS scan was running, in the
   * order they arrived. Replayed onto the new `ScanResult` right after it is
   * built, before `onDidChange` fires -- otherwise a result that lands during
   * a burst of watcher events would know only what `parsed.items` saw, and a
   * file that appeared mid-scan would wear the hazard until the NEXT scan.
   * One ordered list rather than two, so an arrival and a departure of the
   * same path replay in the order they actually happened.
   *
   * Buffering is gated on `this.inFlight`, not a separate flag: `run()` has no
   * `await` of its own before assigning `this.inFlight`, so by the time it
   * calls `doRun()` -- which runs synchronously up to its own first `await` --
   * the assignment has already happened within that same synchronous stretch.
   * A watcher event can only arrive on a later turn of the event loop, so it
   * never sees a gap where a scan is genuinely running but `inFlight` reads as
   * falsy. Cleared, in `doRun`'s own `finally`, when the scan finishes --
   * success or failure -- so a later idle `noteArrival` is never buffered.
   */
  private inFlightEvents: Array<{ type: 'arrival' | 'departure'; fsPath: string }> = [];
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * Set by a `run()` call that arrives while a scan is already in flight.
   * Consumed by `runLoop`, which runs exactly one more scan per round once
   * the current one ends, however many `run()` calls set it in that round.
   */
  private rerunRequested = false;
  /**
   * Resolvers for every `run()` call queued behind the CURRENT in-flight
   * scan, settled once the rerun THEY asked for lands -- not the scan already
   * running, which was built before their request and may already be stale
   * (a `teamExplorer.ignore` change or a Refresh made mid-scan must take
   * effect, not be silently answered with the old ignore rules). Reset to a
   * fresh array the moment its rerun is dispatched, so a `run()` call
   * arriving DURING that rerun queues for the round after it, not this one.
   */
  private rerunWaiters: Array<() => void> = [];

  constructor(
    private readonly client: TfClient,
    /**
     * The workspace folder, spelled natively -- this is `folder.uri.fsPath`,
     * which is `C:\work\Vesta` on Windows, NOT `C:/work/Vesta`.
     *
     * It is ALSO the working directory `TfClient` was constructed with
     * (`extension.ts` sets `cwd: folder.uri.fsPath` once, not per call), and
     * that is load-bearing: `reconcile` emits its folder headers relative to
     * the PROCESS working directory, so the relative paths `parseReconcile`
     * returns are root-relative only while cwd and root are the same
     * directory. Scanning some other folder from this cwd would prefix every
     * path and invert every verdict, silently.
     *
     * It is ALSO handed to tf as the `reconcile` itemspec -- but never raw:
     * see `toTfPath` below. On Windows this string and what tf sees are the
     * same. On Fedora tf runs under Wine and sees this disk as `Z:`, so the
     * untranslated form (e.g. `/home/shax/work/Vesta`) is a path Wine cannot
     * resolve, and whose leading `/` tf's own argument parser reads as an
     * option prefix -- passing `this.root` straight into `args` is precisely
     * the bug `toTfPath` exists to prevent.
     */
    private readonly root: string,
    private readonly platform: Platform,
    /**
     * Re-read per scan. Whether that actually picks up a changed
     * `teamExplorer.ignore` or a changed `.tfignore` is the CALLER's business,
     * not this class's -- `extension.ts` rebuilds the ignorer immediately
     * before each run, which is what makes it so.
     *
     * `Ignorer` rather than `IgnoreMatcher` because a
     * `.tfignore` contributes negations, which `combineIgnoreSources` resolves
     * into a wrapper object rather than that nominal class.
     */
    private readonly ignore: () => Ignorer,
    private readonly output: vscode.OutputChannel,
    /**
     * Translates a local path into the namespace TF.EXE sees. Identity on
     * Windows; on Fedora tf runs under Wine and the disk is `Z:`, so a POSIX
     * path is one it cannot resolve. `PathMapper.toWinePath` is that function
     * and Task 8 passes it; this class stays Wine-blind. See
     * `src/commands/index.ts:495` for the same lesson on `tf vc add`.
     */
    private readonly toTfPath: (localPath: string) => string,
    /**
     * Whether a header `parseReconcile` returned names a real directory under
     * the root. Defaults to a real `statSync`; a test overrides it so headers
     * from a fixture root that does not exist on this machine do not fail the
     * scan. Every header must pass this or the run is a failure -- see
     * `doRun` -- because a header this function cannot verify is exactly the
     * shape of the diagnostic line `parseReconcile`'s own doc comment
     * describes: a line ending in `:` that is not really a folder, silently
     * re-rooting everything after it.
     */
    private readonly folderExists: (absolutePath: string) => boolean = statIsDirectory,
  ) {}

  get result(): ScanResult {
    return this.current;
  }

  /**
   * A path appeared -- created, or renamed/moved into place (VS Code reports
   * a rename as delete + create). Recorded against the CURRENT result
   * immediately, so a lookup right now already gets the safe answer; also
   * buffered while a scan is in flight, so the result that scan builds
   * replays it too and does not forget it the moment it lands (see
   * `inFlightEvents`).
   *
   * Buffering happens UNCONDITIONALLY while a scan is running, even for a
   * path `this.current.noteArrival` itself ignored: the scan in flight may
   * land with a different exclusion list (a `teamExplorer.ignore` change, or
   * a `.tfignore` edit, re-read before every run), so a path uncovered by the
   * result that exists right now can still be covered by the one about to
   * replace it. Scheduling a refresh is different: that decision is about
   * what `this.current` -- the live result a lookup sees RIGHT NOW -- knows,
   * so it uses that call's own return value, not a guess about the scan that
   * has not landed yet. A build writing thousands of paths under
   * `bin`/`obj`/`.vs`/`.git` (all excluded) must not schedule one refresh per
   * file for a result those paths were never going to change.
   */
  noteArrival(fsPath: string): void {
    const changed = this.current.noteArrival(fsPath);
    if (this.inFlight) this.inFlightEvents.push({ type: 'arrival', fsPath });
    if (changed) this.scheduleChange();
  }

  /** The `onDidDelete` half of the pair above. See `noteArrival`. */
  noteDeparture(fsPath: string): void {
    const changed = this.current.noteDeparture(fsPath);
    if (this.inFlight) this.inFlightEvents.push({ type: 'departure', fsPath });
    if (changed) this.scheduleChange();
  }

  /**
   * Debounces `onDidChange` after an arrival or a departure: trailing, so a
   * burst of events fires the tree's re-query once, not once per event. A
   * real scan landing fires immediately instead (see `doRun`) and cancels any
   * pending debounce first, so a result that already reflects everything up
   * to that moment does not also produce a stale, redundant fire 200 ms
   * later.
   */
  private scheduleChange(): void {
    if (this.disposed) return;
    this.cancelScheduledChange();
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      this.changed.fire();
    }, WATCHER_DEBOUNCE_MS);
  }

  private cancelScheduledChange(): void {
    if (this.debounceTimer === undefined) return;
    clearTimeout(this.debounceTimer);
    this.debounceTimer = undefined;
  }

  /**
   * Serialised, but never silently stale: a second call while one is running
   * does not just join the first and answer with what it already knew before
   * the request arrived. A Refresh pressed mid-scan, or a `teamExplorer.ignore`
   * change (extension.ts rebuilds the ignorer and calls this), must take
   * effect -- losing it was the bug, because `doRun` had already read the old
   * ignorer by the time the request arrived. So a call while a scan is in
   * flight sets a rerun flag instead and waits for the scan that follows:
   * `doRun` re-reads `this.ignore()` on every call, so that rerun sees
   * whatever changed. However many calls pile up before the current scan
   * ends, exactly one rerun follows -- not one per call -- and every one of
   * them settles once THAT rerun lands.
   */
  /**
   * @param opts.userAsked whether a person pressed Refresh, as opposed to a
   *   watcher event, a settings change or activation. It changes exactly one
   *   thing: the "tf is contradicting itself" message is said again. That
   *   notice is otherwise once per session, and a user who dismissed it and
   *   then went looking for the missing "Not in source control" rows would get
   *   silence from the one action they would naturally try.
   */
  async run(opts: { userAsked?: boolean } = {}): Promise<void> {
    if (opts.userAsked === true) this.warnedListingUntrusted = false;
    if (this.disposed) return;
    if (this.inFlight) {
      this.rerunRequested = true;
      return new Promise<void>((resolve) => this.rerunWaiters.push(resolve));
    }
    this.inFlight = this.runLoop();
    return this.inFlight;
  }

  /**
   * Runs `doRun` once, then -- as long as `run()` set the rerun flag while the
   * previous round was in flight -- runs it again, once per round, until a
   * round ends with nothing new requested. `this.inFlight` stays equal to
   * THIS promise for every round, not just the first, which is what keeps
   * `noteArrival`/`noteDeparture` buffering events for whichever round is
   * actually running (see `inFlightEvents`'s own doc comment).
   */
  private async runLoop(): Promise<void> {
    try {
      await this.doRun();
      while (!this.disposed && this.rerunRequested) {
        this.rerunRequested = false;
        const waiters = this.rerunWaiters;
        this.rerunWaiters = [];
        try {
          await this.doRun();
        } finally {
          // In its own finally, not after the await: `doRun` is designed
          // never to reject (it catches everything, including a throw from
          // `client.run` itself -- see its own doc comment), but if a future
          // change to it ever did, these callers must still settle rather
          // than hang forever waiting for a round that already failed.
          for (const resolve of waiters) resolve();
        }
      }
    } finally {
      this.inFlight = undefined;
      // Disposal can end the loop with requests still queued for a rerun
      // that will now never happen -- a run() call after dispose() returns
      // immediately (see the guard above), so nothing else would ever settle
      // these otherwise.
      const stray = this.rerunWaiters;
      this.rerunWaiters = [];
      this.rerunRequested = false;
      for (const resolve of stray) resolve();
    }
  }

  private async doRun(): Promise<void> {
    // TfClient.run() RESOLVES for every refusal it makes itself (unsafe
    // `!`/`%`/`^` in an argument, a reconcile with no /preview, an over-long
    // command line, a spawn failure reported via 'error') -- but it can still
    // REJECT: spawn throws SYNCHRONOUSLY for some inputs (a NUL byte raises
    // ERR_INVALID_ARG_VALUE), and that throw happens inside the promise
    // executor, so it surfaces as a rejection (see runMutation in
    // commands/index.ts for the same lesson). This try/catch covers that
    // case and a throw from code on OUR side of the call -- ignore(),
    // parseReconcile, classifyError, building ScanResult -- so either one
    // logs an outcome instead of leaving `inFlight` rejected and resurfacing
    // as an unhandled rejection elsewhere.
    try {
      const pathImpl = this.platform === 'win32' ? path.win32 : path.posix;
      const ignore = this.ignore();
      // The exact list tf is told to skip -- built-ins plus the ignorer's
      // own patterns, because /noignore below drops tf's own copy too
      // (test/fixtures/README.md finding 19). `ScanResult` is given this
      // SAME matcher, never a hand-rebuilt one, so its coverage can never
      // silently drift from what tf actually saw.
      const exclusion = scanExclusion(ignore);

      // The itemspec's own folder name matching one of our patterns is
      // untested territory for tf (what it does with a self-excluded
      // itemspec is unverified) -- not running is the safe answer.
      const rootName = pathImpl.basename(this.root);
      if (exclusion.matches(rootName)) {
        this.keepPrevious(`root ${this.root} is excluded by the scan's own patterns`);
        return;
      }

      // /preview is what makes this safe. /noignore makes tf's silence exact:
      // without it, tf also applies rules we cannot see -- a subfolder
      // .tfignore, and hidden defaults like *.vspscc -- so its silence about a
      // path read as "versioned" when tf had simply never been told to look
      // (test/fixtures/README.md finding 19). /exclude: still applies under
      // /noignore, which is what makes passing every exclusion ourselves work.
      const args = ['vc', 'reconcile', '/promote', '/adds', '/preview', '/noignore', '/recursive'];
      const exclude = exclusion.excludeArgument();
      if (exclude) args.push(exclude); // unreachable-empty in practice: TF_BUILTIN_EXCLUSIONS is never []
      args.push(this.toTfPath(this.root));

      const started = Date.now();
      const result = await this.client.run(args);
      // doRun's awaits each have their own disposed check: this one, and the
      // `rootWasFetched` probe further down. The rule that matters: an await
      // added without a matching check after it would silently let a result
      // land after disposal.
      if (this.disposed) return;

      const stdout = result.stdout.toString('utf8');
      const stderr = result.stderr.toString('utf8');

      if (result.timedOut) {
        this.keepPrevious('timed out');
        return;
      }

      // A killed child is not a failed one. Node reports a SIGNALLED process as
      // `code === null`, so its exit code says nothing -- conflating the two
      // once showed a user tf's own SUCCESS output inside a red error dialog
      // (FEDORA, 2026-09-18). Here both outcomes keep the previous result, so
      // the BEHAVIOUR is the same; this branch exists so the log does not claim
      // the scan "failed" when we simply never learned what it did.
      if (result.terminatedBy) {
        this.keepPrevious(`killed by ${result.terminatedBy}, outcome unknown`);
        return;
      }

      // A non-zero exit is a total failure and the output is an error
      // message, not a listing. Three real files named `nul` in this
      // collection produce exit 100, and one project produces TF10122 on a
      // `$$deepEqual` path. Keeping the previous result is deliberate: a
      // failed scan is not evidence that everything is versioned, and
      // replacing a good answer with an empty one would make every
      // unversioned file read as the propagating hazard.
      if (result.exitCode !== 0) {
        // classifyError reads BOTH streams and scrubs the result -- every
        // TfClient refusal (unsafe characters, an over-long command line,
        // even a spawn failure) puts its reason in stderr and leaves stdout
        // empty, so reading only stdout's first line (the previous version of
        // this branch) logged a bare trailing colon for all three. Every
        // other consumer that logs tf's own output scrubs it too (see
        // scrubSecrets' own doc comment on why that is load-bearing); this
        // is the one that did not.
        const error = classifyError(result.exitCode, stdout, stderr);
        // TfClient's own length refusal: recognised by its message rather
        // than by re-deriving cmdLineBudget's arithmetic here. Its wording
        // ("exclude some changes... act on the rest") is written for a
        // check-in the user chose to make, not a scan they did not -- this
        // says what actually happened instead.
        if (error?.originalMessage.includes(TOO_MANY_ITEMS_PREFIX)) {
          this.keepPrevious(
            'the exclusion list is too long for one tf command ' +
              `(${exclusion.excludePatterns().length} patterns)`,
          );
          return;
        }
        // Not routed through keepPrevious: this is the only branch whose
        // wording leads with the exit code ("failed (exit N)") instead of a
        // reason clause, and that exact wording is what the tests pin.
        this.output.appendLine(
          `scan for new files failed (exit ${result.exitCode}), keeping the previous result: ` +
            capForLog(error?.originalMessage ?? '(no output)'),
        );
        return;
      }

      // Exit 0 does not mean tf's output matched the shape we know how to
      // read: a localized tf, a warning mixed into the listing, or a header
      // that is not really a folder can all slip through here, and reading
      // any of them as "found nothing" would mean "everything is versioned".
      const parsed = parseReconcile(stdout);
      const untrustworthy = this.untrustworthyReason(parsed, pathImpl);
      if (untrustworthy !== undefined) {
        this.keepPrevious('output not understood', untrustworthy);
        return;
      }

      // Before believing a non-empty listing, check tf against itself.
      // `reconcile` LIES in a workspace whose mapped folder has never been
      // downloaded: it reports EVERY local file as "Pending add", including
      // files `info` puts at a real changeset with no pending change. Measured
      // on DEVPC 2026-09-23 (probes R28-R31): identical 20 seconds apart, so
      // not a race, and cleared completely by one `vc get` of the mapping.
      // Believing it costs every versioned file its lock badge and puts the
      // whole tree into "Not in source control" -- which is how it was found.
      //
      // The test is the CONTRADICTION itself -- tf calling a file new that tf
      // also has at a changeset -- not the cause behind it. Asking `info`
      // about the mapped folder instead looks tempting and is wrong: a
      // workspace mapped at `$/` (the real Fedora one) has an empty local half
      // for its root however complete it is, because `$/` is never an item
      // anyone downloads, so that test would switch the feature off on a
      // perfectly healthy workspace (measured, 2026-09-23).
      //
      // Asked HERE, not before the reconcile, and only about a listing that
      // claims something: an empty listing has nothing to distrust, so the
      // healthy steady state pays nothing at all. A clean answer is cached, so
      // at most one extra `vc info` is spent per session; a contradiction is
      // re-checked every scan, which is what lets the user's own Get Latest
      // take effect.
      if (parsed.items.length > 0 && this.listingTrusted !== true) {
        const honest = await this.listingIsHonest(pathImpl.join(this.root, parsed.items[0]));
        if (this.disposed) return;
        if (honest === false) {
          // DROPPED, not kept -- the one place in doRun that does not keep the
          // previous result. Everything this scan has ever produced came from
          // the same reconcile that is now known to call every file new, so a
          // result already on screen is not evidence to preserve: it is the
          // false "not in source control" list the user is complaining about.
          // (Reachable whenever an earlier probe could not answer and this one
          // can -- the test drives exactly that.)
          const hadRows = this.current.unversionedPaths().length > 0;
          this.current = ScanResult.notRun();
          this.output.appendLine(
            'scan for new files: ignoring the list -- tf called an item new that it also has at a' +
              ` changeset (${parsed.items[0]}); run Get Latest Version on ${this.root}`,
          );
          this.warnListingUntrusted();
          // Only when there was something to take back: a first scan that
          // stands down has changed nothing anyone can see.
          if (hadRows) {
            this.cancelScheduledChange();
            this.changed.fire();
          }
          return;
        }
        // `undefined` means tf could not say, which is not a reason to switch
        // the feature off -- only a clear contradiction is. Not cached either.
        if (honest === true) this.listingTrusted = true;
      }

      // `started` was taken before tf was spawned, so it is a safe lower bound
      // on when the listing was true: anything created at or after it is
      // `notScanned` rather than presumed versioned.
      this.current = new ScanResult(this.root, parsed.items, { exclusion, ignore }, this.platform, started);
      // Replay what arrived or left WHILE this scan was running: a fresh
      // ScanResult knows only `parsed.items`, so without this an event
      // delivered mid-flight would be forgotten the instant this result
      // lands, and the path would wear the hazard again until the NEXT scan.
      for (const e of this.inFlightEvents) {
        if (e.type === 'arrival') this.current.noteArrival(e.fsPath);
        else this.current.noteDeparture(e.fsPath);
      }
      // "item(s)", not "file(s)": a listed item can be a directory whose
      // contents were never individually enumerated (see
      // `ScanResult.listedOrInsideOne`), and `unversionedPaths()` filters the
      // list further still -- so this count will not always match what the
      // panel ends up showing.
      this.output.appendLine(
        `scan for new files: listed ${parsed.items.length} item(s) not in source control ` +
          `(${Date.now() - started} ms)`,
      );
      // Fires NOW rather than waiting for a pending debounce from one of the
      // events just replayed: this result already reflects them, so a stale
      // second fire 200 ms later would only make the tree re-query for
      // nothing.
      this.cancelScheduledChange();
      this.changed.fire();
    } catch (err) {
      this.keepPrevious('internal error', err instanceof Error ? err.message : String(err));
    } finally {
      // Whatever happened -- landed, kept the previous result, or threw --
      // this scan is over, and its buffer must not outlive it: a later
      // `noteArrival` while nothing is running must not append to a stale
      // array from a scan that already replayed (or discarded) everything in
      // it.
      this.inFlightEvents = [];
    }
  }

  /**
   * Logs one line in the shape every "nothing changed" outcome shares:
   * `scan for new files: <reason>, keeping the previous result[: <detail>]`.
   * The generic non-zero-exit failure is the one exception -- its wording
   * leads with the exit code, which tests pin, so it logs directly instead.
   */
  /**
   * Whether tf's listing can be believed, judged from ONE item it just called
   * new: `true` tf agrees it is not versioned, `false` tf also has it at a
   * local changeset (the contradiction), `undefined` when tf could not say.
   *
   * Every answer but the contradiction leaves the scan alone. A genuinely new
   * file has no local version -- `info` either omits the local half (see
   * `fedora/info-not-downloaded.txt`) or fails outright -- and both land on
   * `true`/`undefined` here, so an honest listing is never thrown away.
   *
   * `undefined` is deliberately not treated as a contradiction: a failing
   * `info` -- an expired PAT, a timeout, a shape this parser does not know --
   * must not silently switch the whole feature off.
   */
  private async listingIsHonest(absolutePath: string): Promise<boolean | undefined> {
    // The WHOLE body is guarded, not just the parse. `client.run` resolves for
    // every refusal it makes itself, but it can still REJECT -- spawn throws
    // synchronously for some inputs -- and `toTfPath` throws outright when the
    // mapping is not known yet. Either would otherwise reach doRun's outer
    // catch and discard a reconcile that had already parsed and passed every
    // trust check, which is precisely the "switch the feature off on a failure"
    // this method exists to avoid.
    try {
      const result = await this.client.run(['vc', 'info', this.toTfPath(absolutePath)]);
      // A non-zero exit is tf saying it does not know the item, which is what
      // a genuinely new file looks like: the listing stands.
      if (result.timedOut) return undefined;
      if (result.exitCode !== 0) return true;
      // `info` on one item yields one block. Any other count is a shape this
      // does not understand, not an answer: `info-folder-star.txt` shows the
      // one other folder-block shape in the corpus, which parses to none.
      const items = parseInfo(result.stdout.toString('utf8'));
      if (items.length !== 1) return undefined;
      // A local changeset means tf has this item AT a version while also
      // calling it new. That is the contradiction, and the whole listing goes.
      return items[0].localChangeset === undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Said ONCE per session, not per scan: the scan re-runs on every refresh and
   * on a watcher event, and the condition persists until the user acts.
   */
  private warnListingUntrusted(): void {
    if (this.warnedListingUntrusted) return;
    this.warnedListingUntrusted = true;
    void vscode.window.showInformationMessage(S.scanListingUntrusted(this.root));
  }

  private keepPrevious(reason: string, detail?: string): void {
    this.output.appendLine(
      `scan for new files: ${reason}, keeping the previous result` +
        (detail === undefined ? '' : `: ${detail}`),
    );
  }

  /**
   * Why a successfully-exited scan's output cannot be trusted, or undefined
   * when it can be. Checked in order: the first thing `parseReconcile` itself
   * could not vouch for, then the first header that does not name a real
   * directory under the root -- the diagnostic-line shape its own doc comment
   * describes, a line ending in `:` that is not really a folder. Both are
   * scrubbed and capped before they reach the log, the same as the
   * non-zero-exit failure above does for tf's own error text.
   */
  private untrustworthyReason(
    parsed: ParsedReconcile,
    pathImpl: { join: (...paths: string[]) => string },
  ): string | undefined {
    if (parsed.problems.length > 0) return capForLog(scrubSecrets(parsed.problems[0]));
    for (const header of parsed.headers) {
      // Headers come from tf's own walk of the disk, so they are expected to
      // carry the disk's case, and an exact check (case-sensitive on Linux)
      // is right here even though ScanResult folds case when matching tf's
      // listing against VS Code's paths. Unverified on Fedora until the
      // acceptance run shows `listed N item(s)` there.
      if (!this.folderExists(pathImpl.join(this.root, header))) {
        return `header not found: ${capForLog(scrubSecrets(header))}`;
      }
    }
    return undefined;
  }

  dispose(): void {
    this.disposed = true;
    this.cancelScheduledChange();
    this.changed.dispose();
  }
}
