import * as vscode from 'vscode';
import { diskFacts } from '../watch/readOnly.js';
import { resolveFileState, type FileState, type FileStateSource } from '../state/FileState.js';
import { GLYPHS, excluded } from './decorations.js';
import type { TfvcService } from '../TfvcService.js';
import type { Ignorer } from '../ignore/IgnoreMatcher.js';
import type { ScanResult } from '../scan/ScanResult.js';
import { relativeToRoot } from '../paths/relativeToRoot.js';
import type { Platform } from '../tf/PathMapper.js';

/**
 * Draws TFVC state in the file tree.
 *
 * `versioned`, `checkedOut`, `pendingAdd`, `pendingDelete` and `pendingRename`
 * are all decidable from the pending set plus one stat, because in a SERVER
 * workspace a versioned file is read-only unless it is checked out. The two
 * states that need the scan -- `notVersioned` and the `writableNotCheckedOut`
 * hazard -- were `unknown` until plan 2 wired `ignore` and `scan` in; now they
 * resolve from `IgnoreMatcher.matches()` and `ScanResult.verdictFor()`
 * respectively, still against `unknown` (which still draws nothing) for any
 * path the scan has not covered.
 *
 * Wrong in exactly ONE direction. The implication only runs versioned =>
 * read-only; this uses the converse, so a read-only file inside a mapping that
 * TFVC has never heard of resolves to `versioned` and wears a lock claiming it
 * is on the server. Measured: copying a read-only file on Windows, with both
 * `fs.copyFileSync` and PowerShell's `Copy-Item`, preserves the read-only
 * attribute on the copy -- so a `Form1 - Copy.vb` made from a checked-in
 * `Form1.vb` (a TFVC habit: keep a copy before you touch something) reads as
 * `versioned` and locked, though nothing has ever told TFVC it exists. The
 * unversioned scan in plan 2 is the only real fix; until then the tree is
 * incomplete AND, in that one case, confidently wrong.
 */
export class DecorationProvider
  implements vscode.FileDecorationProvider, FileStateSource, vscode.Disposable
{
  private readonly changed = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this.changed.event;
  private readonly disposables: vscode.Disposable[] = [];
  private enabled = true;
  /**
   * Not threaded through a constructor parameter: `TfvcService` already
   * decides this the same way (see its own `platform` field), and nothing
   * about it can change without the extension host itself restarting, so
   * there is nothing for a caller to override or a test to inject.
   */
  private readonly platform: Platform = process.platform === 'win32' ? 'win32' : 'linux';

  constructor(
    private readonly service: TfvcService,
    /** Re-read per call: the user can edit `teamExplorer.ignore` at any time. */
    private readonly ignore: () => Ignorer,
    /** The CURRENT result; the scan replaces it wholesale when one lands. */
    private readonly scan: () => ScanResult,
    /**
     * The workspace root: absolute, native-separated, no trailing separator
     * -- `folder.uri.fsPath` in `extension.ts`'s terms, the same shape as the
     * `uri.fsPath` this class already compares it against. A plain string,
     * not a function like `ignore` and `scan`: `extension.ts` reads
     * `workspaceFolders?.[0]` exactly once, at activation, into a local
     * `folder` that it then reuses both for `TfClient`'s `cwd` and for this
     * constructor's `root` argument -- so for the life of this instance
     * `root` is whatever that one read captured, regardless of what the API
     * itself allows `workspaceFolders` to do later. (`onDidChangeWorkspaceFolders`
     * fires without a host restart, so a different guarantee -- that the root
     * itself cannot change -- would not hold in general; it just does not
     * apply here, since nothing in this extension re-reads `workspaceFolders`
     * after activation.)
     */
    private readonly root: string,
    /**
     * Whether a file is deliberately held back from check-in. Re-read per
     * call, like `ignore` and `scan` -- `ScmProvider`'s exclusion set can
     * change between two rows of the same refresh.
     */
    private readonly isExcluded: (path: string) => boolean,
    /**
     * Fires when the excluded set changes elsewhere (`ScmProvider
     * .setExcludedMany`). A second constructor argument rather than folding
     * it into `isExcluded` because a plain predicate has no way to also be a
     * subscription -- this is exactly the same shape `service.onDidChange`
     * already has below.
     */
    onDidChangeExcluded: vscode.Event<void>,
    /**
     * Fires when a scan lands. Until one does, `scan()` answers `notScanned`
     * for everything, so the `!` hazard and the silence for untracked files
     * are both unreachable -- the tree would keep plan 1's behaviour until
     * something else happened to refresh it.
     */
    onDidChangeScan: vscode.Event<void>,
  ) {
    this.readConfig();
    this.disposables.push(
      this.changed,
      // Fire with `undefined`, meaning "all URIs". VS Code re-queries only the
      // rows it is currently drawing, so the width of this event costs nothing
      // however large the pending set is.
      service.onDidChange(() => this.changed.fire(undefined)),
      onDidChangeExcluded(() => this.changed.fire(undefined)),
      onDidChangeScan(() => this.changed.fire(undefined)),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('teamExplorer.decorations')) {
          this.readConfig();
          this.changed.fire(undefined);
          return;
        }
        // `ignored` (in `pending`, above) is read fresh from `this.ignore()`
        // on every call, so a `teamExplorer.ignore` change needs no local
        // state update here -- only the same re-query every other trigger
        // gets, so a row that now matches (or no longer does) is redrawn.
        if (e.affectsConfiguration('teamExplorer.ignore')) {
          this.changed.fire(undefined);
        }
      }),
      vscode.window.registerFileDecorationProvider(this),
    );
  }

  /**
   * Re-read rather than held. Whether a `WorkspaceConfiguration` reflects
   * later changes is not something the typings promise either way, and this
   * is the off switch for a feature that touches every row in the tree -- so
   * it reads fresh rather than depending on the answer.
   */
  private readConfig(): void {
    this.enabled = vscode.workspace
      .getConfiguration('teamExplorer')
      .get<boolean>('decorations', true);
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (!this.enabled) return undefined;

    // ServerContentProvider's own scheme (TFVC_SCHEME, 'teamExplorer' -- not
    // literally "tfvc:") serves the server's copy of a file. Decorating it
    // would put a lock on the left-hand pane of every diff.
    if (uri.scheme !== 'file') return undefined;

    const state = this.stateOf(uri.fsPath);
    return state === undefined ? undefined : this.decorate(state, uri.fsPath);
  }

  /**
   * What TFVC thinks of this path: the answer the badge is drawn from, and
   * the one the editor menu's context key reads too (plan 3). NOT gated on
   * `teamExplorer.decorations`: turning the badges off must not turn the
   * menu off with them. Add does NOT read this -- see `FileStateSource`'s
   * doc comment for why.
   */
  stateOf(fsPath: string): FileState | undefined {
    // Computed once and passed to both branches, so they cannot disagree about
    // the same workspace. NOT asserted from the index: a SUCCESSFUL
    // re-initialize installs a new mapper while `localIndex` still holds the
    // old entries until the next `doRefresh` completes, so `changeForLocal`
    // can answer for a path the new mapper does not map. `mapped: false` then
    // resolves it to `unmapped`, which draws nothing -- the honest answer.
    const mapped = this.service.pathMapper?.toServerPath(fsPath) !== undefined;

    // Short-circuited HERE rather than left to the resolver: this runs per
    // visible row on every refresh, and in a multi-root window with a
    // non-TFVC root every row there would otherwise cost a blocking stat on
    // the extension-host thread for an answer that is always `unmapped`.
    if (!mapped) return 'unmapped';

    // Both were hardcoded until plan 2. They are computed once and shared by
    // the two branches for the same reason the pair was extracted: plan 2
    // changes them, and changing them in two places is how they drift.
    const relative = relativeToRoot(this.root, fsPath, this.platform);
    const pending = {
      ignored: relative !== undefined && this.ignore().matches(relative),
    } as const;
    // Not in `pending`: the verdict needs the file's creation time, which only
    // the stat below knows, and a file created after the scan must not be
    // read as versioned. The change branch never consults `scan` -- the
    // resolver returns from `change` first -- so it asks without one.
    const verdict = (createdAtMs?: number) => this.scan().verdictFor(fsPath, createdAtMs);

    // The pending set FIRST, and the disk only when it has nothing to say.
    //
    // `tf delete` removes the local file, so a pending delete has no stat to
    // take -- statting first and bailing on failure would discard the one
    // state most worth showing.
    const change = this.service.changeForLocal(fsPath);
    if (change) {
      return resolveFileState({
        change,
        itemType: change.itemType,
        // `mapped` and `ignored` are both read on this path -- the resolver
        // checks them ahead of `change` -- while `itemType`, `readOnly` and
        // `scan` are not: it answers from `change` and returns first. They are
        // passed truthfully anyway, so a future resolver change cannot quietly
        // start reading a lie.
        //
        // Worth deciding in plan 2, not discovering: once `ignored` is real, a
        // PENDING change on an ignored path draws nothing at all -- a file Check
        // In will act on, invisible in the tree.
        readOnly: false,
        mapped,
        ...pending,
        scan: verdict(),
      });
    }

    const facts = diskFacts(fsPath);
    // Gone between VS Code asking and us looking, and nothing pending to
    // explain it. Nothing truthful to draw.
    if (!facts) return undefined;

    return resolveFileState({
      change: undefined,
      itemType: facts.itemType,
      readOnly: facts.readOnly,
      mapped,
      ...pending,
      scan: verdict(facts.createdAtMs),
    });
  }

  /**
   * Five of the eleven states draw nothing, and `GLYPHS` maps those to null.
   *
   * `isExcluded` is applied AFTER the glyph lookup, not folded into
   * `FileState`/`GLYPHS`: exclusion is orthogonal to state (plan 1's comment
   * on `GLYPHS` says so) -- a file's badge and propagation come from what it
   * IS, and only the colour and tooltip change for what will happen to it at
   * the next check-in.
   */
  private decorate(state: FileState, path: string): vscode.FileDecoration | undefined {
    const glyph = GLYPHS[state];
    if (!glyph) return undefined;

    const drawn = this.isExcluded(path) ? excluded(glyph) : glyph;
    const decoration = new vscode.FileDecoration(
      drawn.badge,
      drawn.tooltip,
      new vscode.ThemeColor(drawn.color),
    );
    decoration.propagate = drawn.propagate;
    return decoration;
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}
