import type { ScanVerdict } from '../state/FileState.js';
import { IgnoreMatcher, type Ignorer } from '../ignore/IgnoreMatcher.js';
import type { Platform } from '../tf/PathMapper.js';
import { norm, relativeToRoot } from '../paths/relativeToRoot.js';

/**
 * The two matchers a `ScanResult` needs, as ONE named parameter rather than
 * two positional ones. `exclusion` and `ignore` are structurally
 * interchangeable (`IgnoreMatcher` satisfies both), so two adjacent
 * positional parameters of those shapes can be silently swapped and still
 * type-check -- a real mutant that survived the whole suite. Naming them
 * forces a swap to rename two object keys instead, which is a far louder
 * change at every call site.
 */
export interface ScanCoverage {
  /**
   * What the scan actually told tf to skip: `TF_BUILTIN_EXCLUSIONS` plus the
   * ignorer's own patterns, built by `scanExclusion` exactly as
   * `UnversionedScan` built the `/exclude:` argument. This, not `ignore`,
   * decides `coveredRelative` -- tf never enumerated a path matching this, so
   * the listing says nothing about it either way. Plain `{ matches }` rather
   * than `Ignorer`: this class needs no `excludePatterns()`, and requiring it
   * would force every caller through `IgnoreMatcher` for no reason.
   */
  exclusion: { matches(relativePath: string): boolean };
  /**
   * `Ignorer`, not `IgnoreMatcher`: a `.tfignore` contributes negations, and
   * `combineIgnoreSources` resolves those into a wrapper object rather than
   * that nominal class. Used ONLY by `unversionedPaths()`, to keep the
   * "Not in source control" group from listing something the user's own
   * rules ignore -- it plays no part in `coveredRelative`; see that method's
   * own comment for what can and cannot make it diverge from `exclusion`.
   */
  ignore: Ignorer;
}

/**
 * One scan's answer, and the ONLY thing allowed to produce a `ScanVerdict`.
 *
 * `ScanVerdict`'s own doc comment specifies this class. The rule it exists to
 * enforce: the scan enumerates unversioned items ONLY, and runs with
 * `/exclude:` patterns, so a path's ABSENCE from the list means either "walked
 * it, it is versioned" or "never looked". Those must not resolve the same way.
 * Writing `set.has(p) ? 'notInSourceControl' : 'inSourceControl'` at a call
 * site is the bug; what makes it unexpressible is `private listed` together
 * with `verdictFor` being the only public accessor to it -- `covered()` is
 * separately public and answers a different question, whether the scan
 * looked at the path at all.
 *
 * Immutable once built, with one exception: `noteArrival` and `noteDeparture`
 * feed two small mutable sets, fed live by the FileSystemWatcher in
 * `extension.ts` and replayed by `UnversionedScan` onto a result that lands
 * while paths arrived or left. Nothing else on this class ever changes after
 * construction.
 */
export class ScanResult {
  /** Folded for lookup. */
  private readonly listed: Set<string>;
  /** As tf spelled them, for anything a human will read. */
  private readonly original: readonly string[];
  /** Canonicalised: the platform's native separators, no trailing one, case preserved. */
  private readonly root: string;
  private readonly exclusion: { matches(relativePath: string): boolean };
  private readonly ignore: Ignorer;
  /**
   * Folded keys of paths reported created, renamed or moved in since this
   * result's own scan started -- see `noteArrival`. Checked by `verdictFor`
   * only; `unversionedPaths()` never reads this.
   */
  private readonly arrivals = new Set<string>();
  /**
   * Folded keys of paths reported deleted since this result's own scan
   * started -- see `noteDeparture`. Checked by `unversionedPaths()` only;
   * `verdictFor` never reads this, because a delete is not evidence either
   * way about version-control status.
   */
  private readonly departures = new Set<string>();
  /**
   * The part of `unversionedPaths()` that costs real time -- tf's own listing
   * filtered by `exclusion` and `ignore`, neither of which ever changes --
   * lazily built once and reused. `key` is the FOLDED relative path (what
   * `matchesOrIsInside` needs to test against `departures`), precomputed here
   * rather than re-derived on every `unversionedPaths()` call: re-folding
   * 80,000 entries on every call, on top of the filter itself, was measured
   * at ~26 ms against ~0.2 ms for the equivalent scan before departures
   * existed. `departures` is applied AFTER this cache on every call, which is
   * what keeps a later `noteDeparture` visible without rebuilding the
   * expensive part. See `unversionedPaths()`'s own comment.
   */
  private cachedBaseUnversioned: ReadonlyArray<{ key: string; abs: string }> | undefined;
  /**
   * `cachedBaseUnversioned`, already mapped down to just the absolute paths --
   * built lazily the first time `unversionedPaths()` is called with no
   * departures in effect, and reused for as long as that stays true. This is
   * what makes the common case (no departure at all) skip both the filter AND
   * the map on every call, not just the filter.
   */
  private cachedAbsOnly: readonly string[] | undefined;

  constructor(
    /**
     * The scanned root. Either `/` or native separators are accepted --
     * canonicalised below to the platform's native form with any trailing
     * separator stripped, case preserved (case is folded only for lookup, in
     * `key()`, never for display). This matters because it is compared
     * against `uri.fsPath` (`C:\work\Proj` on Windows, never `C:/work/Proj`).
     * Plan 2's Task 4 doc briefly claimed `UnversionedScan`'s own `root` was
     * "Absolute, `/`-separated, no trailing slash", disagreeing with this
     * contract; that was the plan's error and it has since been corrected to
     * `folder.uri.fsPath` (native) -- this constructor's contract was already
     * the right one. Accepting either spelling here is defence in depth
     * regardless: `unversionedPaths()` is the one method that used to
     * concatenate `root` raw, so it alone would have acted on a wrong
     * spelling silently.
     */
    root: string,
    /**
     * Paths relative to `root`, `/`-separated. That is only true when tf's
     * working directory WAS `root` when it produced them: `parseReconcile`'s
     * own doc says its paths are relative to the process working directory,
     * not the itemspec, and ends "The caller resolves what comes back." This
     * class does no resolving and cannot detect a mismatch -- a wrong cwd
     * silently inverts every verdict to the propagating hazard instead of
     * throwing. The invariant holds today only because the caller runs tf
     * with `cwd` set to the same folder it passes as `root`.
     */
    relativePaths: readonly string[],
    coverage: ScanCoverage,
    private readonly platform: Platform,
    /**
     * When the scan began, in `Date.now()` milliseconds -- taken BEFORE tf was
     * spawned. The listing only speaks for files that existed when tf walked
     * the tree, so an unlisted file created at or after this moment is
     * `notScanned`, not `inSourceControl`. Without it every new file wore the
     * red `!` until the next scan (acceptance run, 2026-09-18).
     *
     * This is the SECOND line of defence, behind `noteArrival`: a rename or a
     * same-volume move keeps the file's birthtime (measured on NTFS: 312 ms
     * before `started` after a rename), so it can predate this bound and slip
     * past it. `noteArrival` is what actually catches that case; this bound
     * still catches a copy whose watcher event this class was never told
     * about.
     *
     * Defaults to "no bound", which trusts the listing for every file. Only
     * `UnversionedScan` builds real results, and its test pins that it passes
     * this.
     */
    private readonly startedAt: number = Number.POSITIVE_INFINITY,
  ) {
    this.root = ScanResult.canonicalRoot(root, platform);
    this.exclusion = coverage.exclusion;
    this.ignore = coverage.ignore;
    this.listed = new Set(relativePaths.map((p) => this.key(p)));
    this.original = [...relativePaths];
  }

  /**
   * The state before any scan has run, and after one that failed.
   *
   * Deliberately NOT an empty successful scan: an empty success means every
   * covered path IS in source control, which is a real answer. "We have not
   * looked" must answer `notScanned` for everything.
   */
  static notRun(): ScanResult {
    const none = new IgnoreMatcher([]);
    return new ScanResult('\u0000never', [], { exclusion: none, ignore: none }, 'linux');
  }

  /**
   * `root`, with `/` converted to the platform's native separator and any
   * single trailing separator stripped. Case is left untouched.
   *
   * Without this, `unversionedPaths()` alone was measured to be sensitive to
   * the caller's spelling, because it concatenates `this.root` raw while every
   * other method compares through `norm()`. A `/`-separated root (this file's
   * own tests spell theirs that way, for readability) yielded
   * `C:/work/Proj\sub\a.vb`; a trailing separator or a bare drive root (`C:\`)
   * doubled the next one.
   */
  private static canonicalRoot(root: string, platform: Platform): string {
    if (platform !== 'win32') {
      return root.length > 1 && root.endsWith('/') ? root.slice(0, -1) : root;
    }
    const native = root.replace(/\//g, '\\');
    return native.length > 1 && native.endsWith('\\') ? native.slice(0, -1) : native;
  }

  /**
   * `norm(relativePath, this.platform)` -- needed on BOTH sides of every
   * comparison, not just `uri.fsPath`: `canonicalRoot` stores `this.root` in
   * the platform's NATIVE form (`\` on win32) regardless of how the caller
   * spelled it, so `this.root` itself can carry backslashes even when every
   * test in this file spells its root and paths with `/`.
   *
   * Delegates to the shared `norm` in `../paths/relativeToRoot.ts` rather than
   * keeping its own copy: a spec review of Task 5 found this method and that
   * module's `norm` had drifted into two character-identical copies of the
   * same function, including the comment recording the case-folding
   * measurement (one real capture mixed `C:\work` 79,920 times with `c:\work`
   * 9 times) -- exactly the drift the extraction existed to prevent.
   *
   * Folded to lower case unconditionally, on BOTH platforms, unlike `norm`
   * itself: tf is a Windows program and may spell a path in a case the Linux
   * disk does not, so a lookup here must not depend on the disk's case. This
   * can only turn a would-be MISS into a match (`notInSourceControl`, i.e.
   * silence), never a would-be match into the hazard -- see the "case" tests
   * in `scanResult.test.ts`.
   */
  private key(relativePath: string): string {
    return norm(relativePath, this.platform).toLowerCase();
  }

  /**
   * `relativeToRoot(this.root, absolutePath, this.platform)`, or undefined
   * when the scan did not cover it.
   *
   * Two ways it did not: outside the root, or only under it by way of a `..`
   * component (both rejected by `relativeToRoot` itself); or matched by
   * `exclusion`, which is built from exactly what `UnversionedScan` passed as
   * `/exclude:` (`TF_BUILTIN_EXCLUSIONS` plus the ignorer's own patterns).
   * Nothing else narrows coverage -- in particular, `ignore.matches()` does
   * NOT: only an ANCHORED `.tfignore` rule can make `ignore` match a path
   * `exclusion` does not (it never reaches `/exclude:`; see
   * `combineIgnoreSources`) -- a negation only ever narrows `ignore`, never
   * widens it, so it can't cause this divergence either way. tf still
   * enumerated the path, and its absence from the listing is still real
   * evidence. `unversionedPaths()` is where `ignore` gets its say instead.
   *
   * `covered()` and `verdictFor()` both need exactly this, so they share it
   * here rather than each calling `relativeToRoot` again. `verdictFor()` used
   * to re-derive it after `covered()` already had, behind a second
   * `rel === undefined` check that could never be reached -- TypeScript
   * cannot narrow a boolean returned from `covered()` back into a later,
   * separate call to the private method that computed it.
   */
  private coveredRelative(absolutePath: string): string | undefined {
    const rel = relativeToRoot(this.root, absolutePath, this.platform);
    if (rel === undefined || rel === '') return undefined;
    if (this.exclusion.matches(rel)) return undefined;
    return rel;
  }

  /**
   * Whether the scan actually walked this path.
   *
   * See `coveredRelative` for the reasons it might not have.
   */
  covered(absolutePath: string): boolean {
    return this.coveredRelative(absolutePath) !== undefined;
  }

  /**
   * Two mechanisms protect an unlisted path from being read as versioned when
   * the scan never actually saw it: `arrivals` (fed by `noteArrival`, live
   * from the watcher and replayed from a scan that was in flight) catches a
   * rename or move, which keeps the file's birthtime and so defeats
   * `createdAtMs` alone; `createdAtMs` is the second line, for a copy whose
   * watcher event this class was never told about. Positive evidence outranks
   * both: a LISTED path answers `notInSourceControl` even if it is also an
   * arrival.
   *
   * @param createdAtMs when the file came into existence, if the caller knows.
   *   Only the NEGATIVE inference is time-bound: a listed file is not in
   *   source control however new it is, but an unlisted one is known to be
   *   versioned only if it already existed when tf enumerated the tree.
   */
  verdictFor(absolutePath: string, createdAtMs?: number): ScanVerdict {
    const rel = this.coveredRelative(absolutePath);
    if (rel === undefined) return 'notScanned';
    if (this.listedOrInsideOne(rel)) return 'notInSourceControl';
    if (this.arrivedOrInsideOne(rel)) return 'notScanned';
    // `>=`: a file created in the same millisecond the scan started may or may
    // not have been seen, and guessing "seen" is the direction that cries wolf.
    if (createdAtMs !== undefined && createdAtMs >= this.startedAt) return 'notScanned';
    return 'inSourceControl';
  }

  /**
   * Records that `absolutePath` appeared after -- or while -- this result's
   * own scan ran: created, or renamed/moved into place (VS Code reports a
   * rename as delete + create). `verdictFor` then answers `notScanned` for it,
   * or for anything under it, instead of trusting a snapshot that never saw
   * it. A LISTED path is unaffected: positive evidence from tf always wins.
   *
   * Clears any `noteDeparture` recorded for this exact path: a delete
   * immediately followed by a create at the same path (VS Code's own shape
   * for a rename) must not leave the path looking departed.
   *
   * Uses `coveredRelative`, not the bare `relativeToRoot` this used to call:
   * a path outside the root OR matched by `exclusion` is a no-op, same as
   * `verdictFor` would answer `notScanned` for it regardless. Without this, a
   * build writing under `bin`/`obj`/`.vs`/`.git` stored an arrival per file
   * for no reason -- measured at 200k arrivals, 25.6 MB and 302 ms of pure
   * overhead -- and `UnversionedScan` scheduled a change for every one of
   * them.
   *
   * Returns whether it actually changed anything (a new arrival, or clearing
   * an existing departure), so `UnversionedScan` can skip scheduling a
   * refresh for a path this result was never going to draw differently.
   */
  noteArrival(absolutePath: string): boolean {
    const rel = this.coveredRelative(absolutePath);
    if (rel === undefined) return false;
    const key = this.key(rel);
    const isNewArrival = !this.arrivals.has(key);
    this.arrivals.add(key);
    const clearedDeparture = this.departures.delete(key);
    return isNewArrival || clearedDeparture;
  }

  /**
   * Records that `absolutePath` left the disk (`onDidDelete`). `unversionedPaths()`
   * drops it, and everything under it, from the group; `verdictFor` is
   * unaffected, because a delete is not evidence either way about
   * version-control status. A later `noteArrival` of the exact same path
   * clears this.
   *
   * Uses `coveredRelative`, same reasoning as `noteArrival`: `exclusion`
   * matches by path COMPONENT (`IgnoreMatcher.matches`), so everything under
   * an uncovered path is itself uncovered -- an excluded path was never in
   * `unversionedPaths()` to begin with, so recording its departure could
   * never have changed anything anyway.
   *
   * Returns whether it actually added a new departure, so `UnversionedScan`
   * can skip scheduling a refresh for a no-op.
   */
  noteDeparture(absolutePath: string): boolean {
    const rel = this.coveredRelative(absolutePath);
    if (rel === undefined) return false;
    const key = this.key(rel);
    if (this.departures.has(key)) return false;
    this.departures.add(key);
    return true;
  }

  /**
   * Whether `key` (already folded) is IN `set`, or lives inside a path that
   * is -- shared by `listed` (a listed folder tf did not enumerate),
   * `arrivals` (a renamed/moved-in folder) and `departures` (a deleted
   * folder): all three need "this path or an ancestor of it", not an exact
   * lookup.
   *
   * `reconcile` lists a new DIRECTORY and does not always enumerate its
   * contents: in `test/fixtures/windows/reconcile-adds.txt`, `Connected
   * Services` is a `Pending add:` with no header of its own anywhere in the
   * file. An exact lookup therefore answers `inSourceControl` for every file
   * inside it -- the mislabelling `ScanVerdict` exists to prevent, and since
   * those files are writable, the badge it produces is the PROPAGATING
   * hazard. The same shape applies to a folder renamed in after the scan
   * started: the watcher reports the folder's own path, never each descendant.
   *
   * A file inside an unversioned (or arrived, or departed) folder cannot
   * itself hold the opposite status, so attributing the folder's answer to
   * its descendants is sound rather than merely cautious.
   */
  private matchesOrIsInside(key: string, set: ReadonlySet<string>): boolean {
    if (set.has(key)) return true;
    // Walk the ancestors rather than scanning the set: a workspace has
    // thousands of listed items and a path has a handful of components.
    for (let cut = key.lastIndexOf('/'); cut > 0; cut = key.lastIndexOf('/', cut - 1)) {
      if (set.has(key.slice(0, cut))) return true;
    }
    return false;
  }

  private listedOrInsideOne(relativePath: string): boolean {
    return this.matchesOrIsInside(this.key(relativePath), this.listed);
  }

  private arrivedOrInsideOne(relativePath: string): boolean {
    return this.matchesOrIsInside(this.key(relativePath), this.arrivals);
  }

  /**
   * Everything found, as absolute paths the UI can open.
   *
   * Built from the ORIGINAL spellings, not from `listed`, which is case-folded
   * on both platforms now -- showing a human a lower-cased file name would be
   * wrong, and `vscode.Uri.file` would still open it, so nothing would fail
   * loudly.
   *
   * Filtered on the RELATIVE path, before joining it to `root` -- not by
   * building the absolute path and calling `covered()`, which would
   * re-normalise it and strip `root` back off to recover the very relative
   * path this method already had.
   *
   * The expensive part -- filtering tf's own listing by `exclusion` and
   * `ignore`, neither of which ever changes -- is cached after the first call
   * (filtering 80,000 entries measured ~370 ms, and `ScmProvider` calls this
   * inside `render()` on every SCM refresh). `departures` is then applied on
   * EVERY call, cheaply, against that cache: a `noteDeparture` made after the
   * first call still takes effect, without repeating the expensive filter.
   * When there are no departures at all -- the common case -- even THAT
   * filter and the final `.map()` are skipped, via `cachedAbsOnly`: measured
   * at ~26 ms against ~0.2 ms for 80,000 entries with `departures.size === 0`,
   * because re-deriving the filter and the mapped path on every call added up
   * even with nothing to actually drop. A fresh array is returned each time
   * regardless -- this file's own tests call `.sort()` on the result, which
   * mutates in place, and must never corrupt the cache for the next caller.
   *
   * Drops an item matching `exclusion` OR `ignore` OR a departure: the group
   * must never list something the user's own rules ignore, including an
   * ANCHORED `.tfignore` rule that `exclusion` (tf's own `/exclude:`) never
   * sees (a negation alone cannot cause this -- see `coveredRelative`'s
   * comment), nor a path reported deleted since. Every item `exclusion`/
   * `ignore` drop is, by construction, one `this.original` actually contains,
   * i.e. LISTED -- so `verdictFor` for that same path still answers
   * `notInSourceControl`, not `notScanned`: positive evidence from being
   * listed always wins there, and a departure does not change that either
   * (see `noteDeparture`). The two methods disagreeing about whether to SHOW
   * a row is safe regardless, because the caller's `resolveFileState` checks
   * its own `ignored` flag before it ever looks at `scan`.
   */
  unversionedPaths(): string[] {
    if (this.cachedBaseUnversioned === undefined) {
      this.cachedBaseUnversioned = this.computeBaseUnversioned();
    }
    if (this.departures.size === 0) {
      if (this.cachedAbsOnly === undefined) {
        this.cachedAbsOnly = this.cachedBaseUnversioned.map((item) => item.abs);
      }
      return [...this.cachedAbsOnly];
    }
    return this.cachedBaseUnversioned
      .filter((item) => !this.matchesOrIsInside(item.key, this.departures))
      .map((item) => item.abs);
  }

  private computeBaseUnversioned(): Array<{ key: string; abs: string }> {
    const sep = this.platform === 'win32' ? '\\' : '/';
    return this.original
      .filter((rel) => !this.exclusion.matches(rel) && !this.ignore.matches(rel))
      .map((rel) => ({ key: this.key(rel), abs: `${this.root}${sep}${rel.replace(/\//g, sep)}` }));
  }
}
