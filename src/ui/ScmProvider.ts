import { statSync } from 'node:fs';
import * as vscode from 'vscode';
import { S } from '../tf/strings.js';
import type { TfvcService } from '../TfvcService.js';
import type { PendingChange } from '../tf/types.js';
import type { ScanResult } from '../scan/ScanResult.js';
import { pendingStateOf } from '../state/FileState.js';

import { EXCLUDED_KEY } from '../migrateState.js';

/**
 * Risk R2: this collection really does produce pending sets of that size — the
 * DEVPC workspace held 79,929 before the R6 cleanup, and `onEdit` auto-checkout
 * is how it got there. Handing VS Code 80,000 SourceControlResourceState
 * objects on every refresh makes the panel unusable and the extension host
 * unresponsive, and a list that long is no use to a human anyway.
 *
 * The cap is on RENDERING only. `includedChanges`, the group label and the
 * count badge all report the true totals, so nothing downstream — the check-in
 * confirmation above all — ever sees a truncated set.
 */
export const MAX_RENDERED = 500;

function groupLabel(base: string, total: number): string {
  return total > MAX_RENDERED ? `${base} (showing ${MAX_RENDERED} of ${total})` : base;
}

/** `statSync` failing (deleted, denied, offline) means "treat as a file". */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export class ScmProvider implements vscode.Disposable {
  private readonly scm: vscode.SourceControl;
  private readonly included: vscode.SourceControlResourceGroup;
  private readonly excluded: vscode.SourceControlResourceGroup;
  private readonly notInSourceControl: vscode.SourceControlResourceGroup;
  private readonly conflicts: vscode.SourceControlResourceGroup;
  private readonly disposables: vscode.Disposable[] = [];

  /** One warning per session, not one per render. render() runs on every refresh. */
  private warnedAboutState = false;

  /** Fires when the excluded set changes, so decorations can re-query. */
  private readonly excludedChanged = new vscode.EventEmitter<void>();
  readonly onDidChangeExcluded = this.excludedChanged.event;

  constructor(
    private readonly service: TfvcService,
    private readonly folder: vscode.WorkspaceFolder,
    private readonly state: vscode.Memento,
    private readonly output: vscode.OutputChannel,
    private readonly scan: () => ScanResult,
    /**
     * Fires when a scan lands, so the third group fills in.
     *
     * The scan is deliberately not awaited at activation -- it costs 0.8 s for
     * a small project and 17-20 s for the whole collection -- so the panel
     * renders once from `service.onDidChange` with an empty third group and
     * again from this. Without it the group stays empty until the next status
     * refresh, which is minutes away or never.
     */
    onDidChangeScan: vscode.Event<void>,
  ) {
    this.scm = vscode.scm.createSourceControl('teamExplorer', 'Team Explorer', folder.uri);
    this.scm.inputBox.placeholder = S.checkInPlaceholder;

    // Phase 5 (U4): created FIRST, so it sits above Included
    // Changes -- VS Code renders groups in creation order -- where Visual
    // Studio puts its own conflicts bar. Hidden until ConflictService finds one.
    this.conflicts = this.scm.createResourceGroup('conflicts', S.conflictsGroup);
    this.conflicts.hideWhenEmpty = true;
    this.included = this.scm.createResourceGroup('included', S.includedChanges);
    this.excluded = this.scm.createResourceGroup('excluded', S.excludedChanges);
    this.excluded.hideWhenEmpty = true;

    // Created LAST: this group sits below Included and Excluded, and
    // VS Code renders resource groups in creation order.
    this.notInSourceControl = this.scm.createResourceGroup('notInSourceControl', S.notInSourceControl);
    this.notInSourceControl.hideWhenEmpty = true;

    this.disposables.push(
      this.scm,
      this.conflicts,
      this.included,
      this.excluded,
      this.notInSourceControl,
      this.excludedChanged,
    );
    this.disposables.push(service.onDidChange(() => this.render()));
    this.disposables.push(onDidChangeScan(() => this.render()));
    // So turning the group on or off takes effect at once, not at the next
    // status refresh.
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('teamExplorer.showNotInSourceControl')) this.render();
      }),
    );
    this.render();
  }

  get inputBoxValue(): string {
    return this.scm.inputBox.value;
  }

  /** VS Code draws gutter bars from the provider attached to the SourceControl. */
  set quickDiffProvider(provider: vscode.QuickDiffProvider) {
    this.scm.quickDiffProvider = provider;
  }

  clearInputBox(): void {
    this.scm.inputBox.value = '';
  }

  /**
   * Phase 5: the Conflicts group's rows, from ConflictService. A click opens
   * Resolve Conflicts on that row; the group keeps no state of its own, so
   * the tab and the group can never disagree about what is in conflict.
   */
  setConflicts(rows: readonly { localPath: string; reason: string }[]): void {
    this.conflicts.resourceStates = rows.slice(0, MAX_RENDERED).map((r) => ({
      resourceUri: vscode.Uri.file(r.localPath),
      decorations: { tooltip: r.reason },
      contextValue: 'conflict',
      command: { command: 'teamExplorer.showConflicts', title: S.conflictsTitle, arguments: [r.localPath] },
    }));
    this.conflicts.label = groupLabel(S.conflictsGroup, rows.length);
  }

  get includedChanges(): PendingChange[] {
    const excluded = this.excludedSet();
    return this.service.pendingChanges.filter(
      (c) => c.itemType === 'File' && !ScmProvider.isExcluded(c, excluded),
    );
  }

  async setExcluded(serverItem: string, exclude: boolean): Promise<void> {
    await this.setExcludedMany([serverItem], exclude);
  }

  /**
   * One read, one write, one render for the whole selection.
   *
   * The callers loop over a multi-select, and doing this per item meant a
   * 50-file Exclude performed 50 Memento writes and 50 renders. `Memento
   * .update` persists the entire object each time, and render() rebuilds both
   * resource groups, so the cost was quadratic in the selection for no reason.
   */
  async setExcludedMany(serverItems: readonly string[], exclude: boolean): Promise<void> {
    if (serverItems.length === 0) return;

    const set = this.excludedSet();
    for (const serverItem of serverItems) {
      const keys = this.keysFor(serverItem);
      // Remove every key this item could be held under, then add back the
      // preferred one. An item excluded under its old path before the id key
      // existed is thereby migrated rather than left to match twice.
      for (const key of keys) set.delete(key);
      if (exclude) set.add(keys[0]);
    }

    await this.state.update(EXCLUDED_KEY, [...set]);
    this.render();
    this.excludedChanged.fire();
  }

  /**
   * Whether the file at this LOCAL path is deliberately held back from
   * check-in.
   *
   * `DecorationProvider` only ever has a local path (`uri.fsPath`), not a
   * server item, so this looks the pending change up the same way
   * `DecorationProvider` already looks up `change` for that path --
   * `TfvcService.changeForLocal`, which normalises through the same
   * platform-aware key `changeForLocal` itself uses. From there it defers
   * to the SAME `isExcluded` identity check `render()` and `includedChanges`
   * use (itemid where there is one, else the server path), so a file can
   * never be excluded here and included there. A path with no pending
   * change is never excluded -- there is nothing for a check-in to hold
   * back.
   */
  isExcludedPath(localPath: string): boolean {
    const change = this.service.changeForLocal(localPath);
    return change !== undefined && ScmProvider.isExcluded(change, this.excludedSet());
  }

  /**
   * The keys an item may be stored under, preferred first.
   *
   * Keyed on the server path, an exclusion did not survive a RENAME: tf
   * reports the new `item`, nothing matches the stored old one, and the file
   * the user deliberately held back silently rejoined Included — where Check
   * In takes it, irreversibly.
   *
   * `itemid` is TFVC's identity for the item and does not move when the path
   * does, so it is the better key wherever there is one. A pending Add has no
   * server item yet and carries a negative placeholder id, so those still key
   * on the path; a rename of a pending Add has no server-side identity to
   * preserve either way.
   *
   * The `#` prefix keeps the two spaces apart: a server path always begins
   * `$/`, so no id key can ever collide with one.
   */
  private keysFor(serverItem: string): string[] {
    const keys = [ScmProvider.key(serverItem)];
    const id = this.service.changeFor(serverItem)?.itemId;
    if (id !== undefined && id > 0) keys.unshift(`#${id}`);
    return keys;
  }

  /** Whether a change is held back, by either key. */
  private static isExcluded(change: PendingChange, excluded: ReadonlySet<string>): boolean {
    if (change.itemId > 0 && excluded.has(`#${change.itemId}`)) return true;
    return excluded.has(ScmProvider.key(change.serverItem));
  }

  /**
   * TFVC server paths are case-insensitive, so the stored set is normalised.
   *
   * The two sides genuinely disagree about casing: setExcluded is handed a path
   * reconstructed by PathMapper, whose casing comes from the file on disk,
   * while render() compares against the raw `item` attribute from tf's status
   * output. tf.exe is demonstrably inconsistent here - one real capture mixed
   * `C:\work` 79,920 times with `c:\work` 9 times. A mismatch would silently
   * drop the exclusion, and the file the user excluded would be checked in.
   *
   * Normalising on read also migrates any entry stored before this fix.
   */
  private excludedSet(): Set<string> {
    // `Memento.get` returns whatever is stored, with no validation and no
    // guarantee it matches the type argument. The previous version asserted
    // `string[]` and mapped straight over it, so a value of the wrong shape
    // threw a TypeError - and this runs from render(), which runs from the
    // CONSTRUCTOR. A bricked activation: no panel, no commands, no way to
    // clear the bad value from inside the extension, because activate() never
    // finished registering anything.
    const raw: unknown = this.state.get(EXCLUDED_KEY, []);
    if (!Array.isArray(raw)) {
      this.reportUnusableState(`expected an array, found ${typeof raw}`);
      return new Set();
    }

    const usable = raw.filter((item): item is string => typeof item === 'string');
    if (usable.length !== raw.length) {
      this.reportUnusableState(`${raw.length - usable.length} entr(y/ies) were not strings`);
    }
    return new Set(usable.map((item) => item.toLowerCase()));
  }

  /**
   * Losing the exclusion list is not cosmetic: a file the user excluded
   * becomes included again, and Check In takes what is included. So this is
   * said out loud rather than swallowed.
   *
   * The bad value is deliberately NOT rewritten here. Reading happens on every
   * render, and repairing on read would destroy whatever is there before the
   * user has been told. The next Exclude or Include writes the sanitised set
   * anyway.
   */
  private reportUnusableState(detail: string): void {
    if (this.warnedAboutState) return;
    this.warnedAboutState = true;
    this.output.appendLine(`the saved exclusion list is unusable (${detail}) - treating it as empty`);
    void vscode.window.showWarningMessage(S.exclusionsUnreadable);
  }

  /** Single definition of the comparison key, so the two sides cannot drift. */
  private static key(serverItem: string): string {
    return serverItem.toLowerCase();
  }

  private render(): void {
    const excluded = this.excludedSet();

    // Folders are pending changes too (9,459 of them in one real capture),
    // but they are not editable files and are not offered as resources.
    const files = this.service.pendingChanges.filter((c) => c.itemType === 'File');

    const includedAll = files.filter((c) => !ScmProvider.isExcluded(c, excluded));
    const excludedAll = files.filter((c) => ScmProvider.isExcluded(c, excluded));

    this.included.resourceStates = includedAll.slice(0, MAX_RENDERED).map((c) => this.toResource(c));
    this.excluded.resourceStates = excludedAll.slice(0, MAX_RENDERED).map((c) => this.toResource(c));

    this.included.label = groupLabel(S.includedChanges, includedAll.length);
    this.excluded.label = groupLabel(S.excludedChanges, excludedAll.length);

    // From the scan, minus anything the ignore matcher catches -- ScanResult
    // filters already, so this is the same list the tree uses. Capped like the
    // others, with the true total in the label, because a user with 5,000 new
    // files needs the number more than the rows.
    //
    // OFF by default. Visual Studio's Pending Changes lists no such section,
    // and the user asked for the panel to match it. The scan still runs either
    // way: it is what draws the `!` hazard and keeps an unearned lock off a
    // copied file. This setting hides the LIST, not the knowledge.
    const untracked = (
      vscode.workspace.getConfiguration('teamExplorer').get<boolean>('showNotInSourceControl', false)
        ? this.scan().unversionedPaths()
        : []
    )
      // A file with a pending change is not "not in source control", whatever
      // the last scan said. After Add, the status refresh lands before the next
      // scan does, so without this the file sat in BOTH groups until a Refresh.
      .filter((p) => this.service.changeForLocal(p) === undefined);
    this.notInSourceControl.resourceStates = untracked
      .slice(0, MAX_RENDERED)
      .map((p) => this.toUntrackedResource(p));
    this.notInSourceControl.label = groupLabel(S.notInSourceControl, untracked.length);

    // The TRUE count, not the rendered one. This badge is what tells the user
    // how much is pending, and the check-in dialog counts the same way. It
    // must NOT include `untracked`: those files have no pending change, Check
    // In will not take them, and folding them in here would misstate the one
    // number the check-in confirmation dialog is derived from.
    this.scm.count = includedAll.length;
  }

  private toResource(change: PendingChange): vscode.SourceControlResourceState {
    const local = this.service.pathMapper?.fromWinePath(change.localPath) ?? change.localPath;
    return {
      resourceUri: vscode.Uri.file(local),
      decorations: { tooltip: [...change.changes].join(', ') },
      // What package.json's `scmResourceState` clauses key on (plan 3), so a
      // row offers only what can work on it: Compare only on an edit --
      // `ServerContentProvider` views the local file's OWN server path, which
      // for a pending Add or Delete does not exist and for a pending rename is
      // the NEW name, uncommitted until check-in -- and Check Out only on a
      // rename.
      contextValue: pendingStateOf(change),
      command: {
        command: 'teamExplorer.compareWithLatest',
        title: S.compareWithLatest,
        arguments: [vscode.Uri.file(local)],
      },
    };
  }

  /**
   * A row for a file that is not in source control.
   *
   * NOT a PendingChange -- there is no pending change, which is the whole
   * point. `contextValue` is `untracked` so package.json's `when` clauses (and
   * the Add button) can key on it, and so Undo, Checkout and Compare with
   * Latest -- none of which apply to something with no pending change -- are
   * gated off this group there.
   *
   * `command` opens the file, unless the path is a DIRECTORY, in which case
   * there is nothing to open -- `vscode.open` on a folder used to hand VS Code
   * a Uri it could not edit. `revealInExplorer` is what a folder row gets
   * instead. `statSync` failing (deleted, denied, offline) is treated as
   * "file": that is the safer of the two wrong guesses, since `vscode.open` on
   * a path that is actually a directory merely fails silently, while
   * `revealInExplorer` on a path that is actually a file would reveal the
   * wrong thing with no error either.
   */
  private toUntrackedResource(localPath: string): vscode.SourceControlResourceState {
    const uri = vscode.Uri.file(localPath);
    return {
      resourceUri: uri,
      decorations: { tooltip: S.notInSourceControlTooltip },
      contextValue: 'untracked',
      command: isDirectory(localPath)
        ? { command: 'revealInExplorer', title: S.revealInExplorer, arguments: [uri] }
        : { command: 'vscode.open', title: S.open, arguments: [uri] },
    };
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}
