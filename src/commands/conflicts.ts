import * as vscode from 'vscode';
import { localKey, type Platform } from '../tf/PathMapper.js';
import { S } from '../tf/strings.js';
import { ServerContentProvider } from '../ui/ServerContentProvider.js';
import type { ConflictService, ResolveOutcome } from '../conflicts/ConflictService.js';
import {
  conflictsUnder,
  nameAndFolder,
  type Conflict,
  type ConflictActions,
} from '../conflicts/conflictModel.js';
import type { AutoResolution } from '../conflicts/resolveArgs.js';

export interface ActionDeps {
  // `resolve` spelled as a method, not a `Pick` key: phase5Safety.test.ts pins
  // the string 'resolve' to resolveArgs.ts and TfClient's guard.
  conflicts: Pick<ConflictService, 'conflicts' | 'autoMergeAll' | 'check'> & {
    resolve(c: Conflict, how: AutoResolution): Promise<ResolveOutcome>;
  };
  /** A resolution changes pending changes and files on disk (C13, C16): refresh them and re-scan. */
  afterAction: () => void;
  platform: Platform;
  /**
   * A server version VS Code can diff even when TFVC calls the file binary:
   * history's `versionDocument` (a read-only copy on disk, D25).
   */
  versionDocument: (serverPath: string, changeset: number) => Promise<vscode.Uri>;
}

interface Question {
  message: string;
  detail: string;
  yes: string;
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * What each row button does. The dialogs live here, next to the
 * one call each makes, so no path reaches a destructive resolution without
 * passing its question: Take Theirs undoes the pending change (C13), Keep
 * Yours makes the next Check In overwrite the server's change (C14),
 * Overwrite deletes a file that is not in source control (C16).
 */
export function createConflictActions(deps: ActionDeps): ConflictActions {
  const nameOf = (c: Conflict) => nameAndFolder(c.localPath, deps.platform).name;
  const openDocument = (c: Conflict) =>
    vscode.workspace.textDocuments.find(
      (d) => d.uri.scheme === 'file' && localKey(d.uri.fsPath, deps.platform) === localKey(c.localPath, deps.platform),
    );
  // Phase 2's refusal, said plainly: opening the diff anyway ends in VS Code's
  // "could not be opened" when the content provider refuses a binary version.
  // One side of a compare. Text goes through the content provider as ever; for
  // what TFVC labels binary the provider refuses to decode (phase 2), so the
  // version's bytes go to a file instead and VS Code decides, as Visual
  // Studio's diff does: an XML file tf calls Binary diffs as the text it is.
  const versionSide = async (c: Conflict, serverPath: string, changeset: number): Promise<vscode.Uri | undefined> => {
    if (!c.binary) return ServerContentProvider.versionUri(serverPath, changeset);
    try {
      return await deps.versionDocument(serverPath, changeset);
    } catch (e) {
      void vscode.window.showWarningMessage(messageOf(e));
      return undefined;
    }
  };
  const ask = async (q: Question): Promise<boolean> =>
    (await vscode.window.showWarningMessage(q.message, { modal: true, detail: q.detail }, q.yes)) === q.yes;

  const question: Record<AutoResolution, ((c: Conflict) => Question) | undefined> = {
    // Changes nothing it cannot merge (C12, C17): nothing to ask.
    AutoMerge: undefined,
    TakeTheirs: (c) => ({ message: S.conflictsTakeTheirsConfirm(nameOf(c)), detail: S.conflictsTakeTheirsDetail, yes: S.conflictsTakeTheirsYes }),
    KeepYours: (c) => ({ message: S.conflictsKeepYoursConfirm(nameOf(c)), detail: S.conflictsKeepYoursDetail(c.theirs), yes: S.conflictsKeepYoursYes }),
    OverwriteLocal: (c) => ({ message: S.conflictsOverwriteConfirm(nameOf(c)), detail: S.conflictsOverwriteDetail, yes: S.conflictsOverwriteYes }),
  };
  // The questions above describe a conflict with the SERVER. For a conflict of
  // no known family (an unshelve's, a merge's, one with no local item) the
  // other side is unknown, so they would name the wrong loss: ask plainly,
  // with tf's own reason.
  const questionFor = (c: Conflict, how: AutoResolution): Question | undefined => {
    const q = question[how]?.(c);
    if (q === undefined || c.family !== 'unknown') return q;
    return { message: S.conflictsUnknownConfirm(q.yes, nameOf(c)), detail: S.conflictsUnknownDetail(c.reason), yes: q.yes };
  };

  const run = async (c: Conflict, how: AutoResolution): Promise<boolean> => {
    const outcome = await deps.conflicts.resolve(c, how);
    deps.afterAction();
    if (!outcome.ok) void vscode.window.showWarningMessage(S.conflictsActionFailed(nameOf(c), outcome.detail));
    return outcome.ok;
  };

  return {
    compare: async (c) => {
      if (c.serverPath === undefined || c.theirs === undefined) return;
      const theirs = await versionSide(c, c.serverPath, c.theirs);
      if (!theirs) return;
      await vscode.commands.executeCommand(
        'vscode.diff',
        theirs,
        // The real file, editable: a manual merge is done right here.
        vscode.Uri.file(c.localPath),
        S.conflictsCompareTitle(nameOf(c), c.theirs),
      );
    },

    compareServerBase: async (c) => {
      if (c.serverPath === undefined || c.base === undefined || c.theirs === undefined) return;
      const base = await versionSide(c, c.serverPath, c.base);
      const theirs = base && (await versionSide(c, c.serverPath, c.theirs));
      if (!base || !theirs) return;
      await vscode.commands.executeCommand(
        'vscode.diff',
        base,
        theirs,
        S.conflictsCompareServerBaseTitle(nameOf(c), c.base, c.theirs),
      );
    },

    compareLocalBase: async (c) => {
      if (c.serverPath === undefined || c.base === undefined) return;
      const base = await versionSide(c, c.serverPath, c.base);
      if (!base) return;
      await vscode.commands.executeCommand(
        'vscode.diff',
        base,
        vscode.Uri.file(c.localPath),
        S.conflictsCompareLocalBaseTitle(nameOf(c), c.base),
      );
    },

    resolve: async (c, how) => {
      // Every resolution can rewrite the file on disk; an editor holding
      // unsaved changes would then disagree with it, or overwrite it.
      if (openDocument(c)?.isDirty) {
        void vscode.window.showWarningMessage(S.conflictsUnsaved(nameOf(c)));
        return false;
      }
      const q = questionFor(c, how);
      if (q && !(await ask(q))) return false;
      return run(c, how);
    },

    markMerged: async (c) => {
      // Resolved saves instead of refusing: the unsaved edits ARE the merge.
      const doc = openDocument(c);
      if (doc?.isDirty && !(await doc.save())) {
        void vscode.window.showWarningMessage(S.conflictsSaveFailed(nameOf(c)));
        return false;
      }
      if (!(await ask({ message: S.conflictsResolvedConfirm(nameOf(c)), detail: S.conflictsResolvedDetail, yes: S.conflictsResolvedYes }))) {
        return false;
      }
      // C14 is what makes this honest: KeepYours moves the pending edit onto
      // the server's changeset, so the merged file checks in as its successor.
      return run(c, 'KeepYours');
    },

    autoMergeAll: async () => {
      // tf may rewrite any conflicted file: the same refusal as one row's.
      const dirty = deps.conflicts.conflicts.find((c) => openDocument(c)?.isDirty);
      if (dirty) {
        void vscode.window.showWarningMessage(S.conflictsUnsaved(nameOf(dirty)));
        return;
      }
      const before = deps.conflicts.conflicts.length;
      const outcome = await deps.conflicts.autoMergeAll();
      deps.afterAction();
      const after = deps.conflicts.conflicts.length;
      if (after < before) void vscode.window.showInformationMessage(S.conflictsAutoMergeAllResult(before - after, before));
      else void vscode.window.showWarningMessage(S.conflictsAutoMergeAllNone(outcome.detail));
    },

    refresh: async () => {
      try {
        await deps.conflicts.check();
      } catch (e) {
        void vscode.window.showWarningMessage(S.conflictsCheckFailed(messageOf(e)));
      }
    },
  };
}

export interface CommandDeps {
  conflicts: Pick<ConflictService, 'check'>;
  /** Opens or reveals the tab; `select` is a local path. */
  showTab: (select?: string) => Promise<void>;
}

/** A local path from the SCM row's own command (a string) or its context menu (a resource state). */
function selectionOf(arg: unknown): string | undefined {
  if (typeof arg === 'string') return arg;
  const uri = (arg as { resourceUri?: { fsPath?: unknown } } | undefined)?.resourceUri;
  return typeof uri?.fsPath === 'string' ? uri.fsPath : undefined;
}

export function registerConflictCommands(context: vscode.ExtensionContext, deps: CommandDeps): void {
  context.subscriptions.push(
    // The one call between shelving and conflict resolution, which phase 4
    // makes after every unshelve. Rejects only when it could not find out,
    // which phase 4 treats as "unknown" and never deletes the shelveset on.
    vscode.commands.registerCommand('teamExplorer.resolveConflicts', async (serverPaths?: unknown): Promise<number> => {
      // Anything but `$/` paths is refused, not read as "none" (a 0 lets phase 4
      // delete the shelveset) or as "everything".
      const valid =
        serverPaths === undefined ||
        (Array.isArray(serverPaths) && serverPaths.every((p) => typeof p === 'string' && p.startsWith('$/')));
      if (!valid) throw new Error('teamExplorer.resolveConflicts takes an array of $/ server paths');
      const roots = (serverPaths ?? []) as string[];
      const found = conflictsUnder(await deps.conflicts.check(), roots);
      if (found.length > 0) await deps.showTab(found[0].localPath);
      return found.length;
    }),

    // The user's own: the palette and the panel's menus. Always opens -- a
    // user who asked must see "No conflicts" rather than nothing -- and
    // shows the list it has at once, while a fresh one is fetched.
    vscode.commands.registerCommand('teamExplorer.showConflicts', async (arg?: unknown) => {
      await deps.showTab(selectionOf(arg));
      try {
        await deps.conflicts.check();
      } catch (e) {
        void vscode.window.showWarningMessage(S.conflictsCheckFailed(messageOf(e)));
      }
    }),
  );
}
