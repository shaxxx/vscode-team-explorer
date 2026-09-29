import type { PendingChange } from '../tf/types.js';

/**
 * What TFVC thinks of one file.
 *
 * The type the decoration badges, the menu gating and the "not in source
 * control" group will all be renderings of (plans 1-3). Deliberately free of
 * `vscode`, per the architecture invariant in CLAUDE.md, so it stays
 * unit-testable with no workspace and no network.
 */
export type FileState =
  | 'checkedOut'             // pending Edit
  | 'pendingAdd'
  | 'pendingDelete'
  | 'pendingRename'          // Rename or SourceRename
  | 'versioned'              // under TFVC, read-only on disk, nothing pending
  | 'writableNotCheckedOut'  // under TFVC, writable, nothing pending -- the hazard
  | 'notVersioned'           // scanned, and genuinely not in TFVC
  | 'ignored'                // matched an ignore pattern
  | 'folderNotPending'       // a folder with nothing pending. FINAL: nothing will ever answer.
  | 'unmapped'               // outside every workspace mapping. Knowable, and FINAL.
  | 'unknown';               // nothing has answered YET. The only temporary state here.

/**
 * What the unversioned scan has to say about one path.
 *
 * `inSourceControl` means the scan AFFIRMATIVELY covered this path and did not
 * list it. The scan enumerates unversioned items ONLY, and runs with
 * `/exclude:` patterns that are load-bearing -- 6,950 of the 6,974 folders in
 * one real project's scan output were `node_modules` (measured on DEVPC,
 * 2026-09-17, against WebOrders). Its silence about a path it never looked
 * at is therefore not evidence, and that case is `notScanned`.
 *
 * A boolean would make the mistake easy: `set.has(path)` returning false reads
 * as `inSourceControl` when it may only mean "excluded from the scan". Naming
 * the third case forces the caller to decide.
 *
 * Build this ONLY from the scan result's own `verdictFor(path)`, never from a
 * bare `set.has()` at the call site -- only the scan knows which paths it
 * actually covered, and `/exclude:` guarantees that is not all of them:
 *
 *     verdictFor(p) {
 *       if (!this.covered(p)) return 'notScanned';  // excluded, or never visited
 *       return this.unversioned.has(p) ? 'notInSourceControl' : 'inSourceControl';
 *     }
 *
 * `set.has(p) ? 'notInSourceControl' : 'inSourceControl'` compiles and is the
 * bug this union exists to make visible. What makes it unexpressible is
 * `ScanResult`'s `listed` being private, with `verdictFor` as the only public
 * accessor to it -- not `covered()`, which is separately public and answers a
 * different question. Plan 2 is written against `verdictFor`.
 */
export type ScanVerdict = 'notInSourceControl' | 'inSourceControl' | 'notScanned';

export interface FileStateInput {
  /** The pending change tf reports for this path, if any. */
  change: PendingChange | undefined;
  /**
   * File or folder.
   *
   * TFVC does not check a folder out, so a folder's read-only bit carries no
   * versioning signal -- and it really can carry one: `attrib +R` on a
   * directory makes statSync report mode 40444 with S_IWUSR clear (measured on
   * DEVPC, 2026-09-17). `readOnly` is therefore read for FILES only.
   *
   * VS Code asks a FileDecorationProvider about folder rows too, so this is not
   * hypothetical.
   */
  itemType: 'File' | 'Folder';
  /**
   * Read-only on disk. Only a versioning signal in a SERVER workspace, where a
   * versioned file is read-only unless it is checked out. A local workspace
   * leaves everything writable and this field means nothing there.
   */
  readOnly: boolean;
  /** Whether an ignore pattern matches. */
  ignored: boolean;
  /** Whether the path falls inside a workspace mapping. */
  mapped: boolean;
  /** What the unversioned scan says about this path. See ScanVerdict. */
  scan: ScanVerdict;
}

/** The four states a file with a pending change can be in. */
export type PendingState = 'checkedOut' | 'pendingAdd' | 'pendingDelete' | 'pendingRename';

/**
 * The state a pending change puts its file in. Shared by `resolveFileState`
 * and by the SCM panel's rows, whose `contextValue` it becomes (plan 3), so a
 * row's menu and the file's badge cannot disagree.
 */
export function pendingStateOf(change: PendingChange): PendingState {
  // `chg` is a space-separated flag SET, not an enum: "Add Edit Encoding" is
  // a real captured value. Highest-consequence flag wins, so a file that is
  // both deleted and edited reads as deleted.
  if (change.changes.has('Delete')) return 'pendingDelete';
  if (change.changes.has('Add')) return 'pendingAdd';
  if (change.changes.has('Rename') || change.changes.has('SourceRename')) return 'pendingRename';

  // Edit -- and Lock, Branch, Merge, Undelete or Rollback alone, and also an
  // EMPTY flag set, which is reachable because parse.ts drops flags it does
  // not recognise so a future tf.exe degrades instead of breaking. The file
  // IS in the pending set and Check In will act on it, so it must not fall
  // through to a state that draws nothing.
  return 'checkedOut';
}

export function resolveFileState(input: FileStateInput): FileState {
  // Outside a mapping we know nothing and never will, which outranks
  // everything else -- an ignore pattern matching a path we do not own says
  // nothing useful. Distinct from `unknown`, which is temporary.
  if (!input.mapped) return 'unmapped';
  if (input.ignored) return 'ignored';

  if (input.change) return pendingStateOf(input.change);

  // A folder with nothing pending. TFVC does not check folders out, so its
  // read-only bit says nothing -- and `attrib +R` really does clear S_IWUSR on a
  // directory, so without this guard an attributed folder reads as `versioned`,
  // a lock badge on a folder, and one without it reads as the hazard, which
  // propagates to every parent.
  //
  // The scan DOES enumerate folders -- 41 of 275 entries in one measured run
  // were directories -- so `scan` could answer here. It is deliberately not
  // consulted: `notVersioned` and `folderNotPending` both draw nothing, and a
  // folder's own state adds nothing over its contents'. Those folder entries
  // earn their keep in plan 2's "Not in source control" group instead.
  if (input.itemType === 'Folder') return 'folderNotPending';

  // The scan's POSITIVE finding beats the read-only bit. `reconcile` listing a
  // file is direct evidence TFVC has never heard of it; read-only is only an
  // inference, running versioned => read-only backwards. And that inference is
  // measurably wrong in the commonest case: a Windows copy of a checked-in file
  // keeps the read-only attribute (verified with both fs.copyFileSync and
  // Copy-Item), so `Form1 - Copy.vb` would otherwise wear a lock claiming it is
  // on the server. Plan 1 pinned the opposite order deliberately, as a decision
  // left to plan 2; this is that decision.
  //
  // Only the positive finding moves up. `inSourceControl` and `notScanned` on a
  // read-only file still read as `versioned`, exactly as before.
  if (input.scan === 'notInSourceControl') return 'notVersioned';

  // In a SERVER workspace a versioned file is read-only unless it is checked
  // out, so one stat answers this without a round trip -- which is what lets
  // the decorations work for everything the scan did not cover.
  if (input.readOnly) return 'versioned';

  // Writable with nothing pending, and the scan did not list it: either it was
  // edited without being checked out, or the scan never looked. Only the scan
  // separates those, and guessing would hide a hazard or cry wolf.
  if (input.scan === 'inSourceControl') return 'writableNotCheckedOut';
  return 'unknown';
}

/**
 * Answers `FileState` for one path. `DecorationProvider` is the one
 * implementation: the badge and the editor menu's context key both read the
 * same answer, so they cannot disagree about a file.
 *
 * Add does NOT read this (plan 3, after review): it judges from the pending
 * cache directly, the same way Undo and Check Out do, because the scan behind
 * `stateOf` can be stale in a way that matters for Add specifically -- see the
 * comment on `known` in `src/commands/index.ts`.
 */
export interface FileStateSource {
  /** `undefined` when the path vanished with nothing pending to explain it. */
  stateOf(fsPath: string): FileState | undefined;
}
