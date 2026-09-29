import { existsSync, readdirSync, renameSync, statSync, type Dirent } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { isServerPath } from '../explorer/explorerModel.js';
import type { FileOpsService } from '../fileops/FileOpsService.js';
import { nameOfPath, planDelete, planRename, renamedPath, validateName } from '../fileops/renamePlan.js';
import type { ScanResult } from '../scan/ScanResult.js';
import { localKey } from '../tf/PathMapper.js';
import { S } from '../tf/strings.js';
import type { TfvcService } from '../TfvcService.js';

export interface FileOpsDeps {
  service: TfvcService;
  ops: FileOpsService;
  output: vscode.OutputChannel;
  /** The unversioned scan's latest answer; the same accessor ScmProvider gets. */
  scan: () => ScanResult;
  /** Re-reads the pending set and re-scans: a rename or delete changes both. */
  refresh: () => void;
}

/**
 * Rename, move and delete.
 *
 * VS Code reports its OWN file operations only -- F2, drag-and-drop, Delete, a
 * refactor -- which is the same rule Visual Studio's Solution Explorer
 * follows: what the IDE does becomes a pending change, what a build script
 * does does not.
 *
 * The `will` events are where the item still exists, so that is where its
 * state is read; the `did` events act on what was remembered. A `did` with
 * nothing remembered does nothing at all.
 */
/**
 * How many entries `holdsVersionedFile` may look at in total before giving up.
 * Reached only by a folder with no versioned file near the top of it, which is
 * exactly the case where the answer is "not versioned" anyway.
 */
const WALK_BUDGET = 1000;

/**
 * How many entries it may look at in ONE directory before moving on to the
 * next. Level-order alone does not save the walk from `ClientApp/node_modules`
 * (12,000 files) sitting next to `ClientApp/src`: whichever `readdir` returns
 * first is walked first, and the total budget would be gone before the other
 * is opened. With a per-directory cap, a big unversioned folder costs a fixed
 * slice and its siblings are still reached.
 */
const PER_DIR_BUDGET = 200;

export function registerFileOps(context: vscode.ExtensionContext, deps: FileOpsDeps): void {
  const remembered = new Map<string, boolean>();
  // Platform-aware, not a blind `toLowerCase()`: on Linux `a.txt` and `A.txt`
  // are different files, and folding them onto the same key would let one
  // borrow the other's remembered verdict.
  const key = (p: string): string => localKey(p, deps.service.platform);

  /**
   * A file TFVC handed out. In a SERVER workspace a versioned file is
   * read-only unless it is checked out, so one stat answers it.
   */
  const readOnlyFile = (path: string): boolean => {
    try {
      const stat = statSync(path);
      return stat.isFile() && (stat.mode & 0o200) === 0;
    } catch {
      return false;
    }
  };

  /**
   * Does this FOLDER hold a versioned file?
   *
   * A folder's own read-only bit says nothing (see `FileState`), so a folder
   * had no local evidence at all until this: it fell through to "not
   * versioned" whenever the scan was unsure, and deleting a freshly fetched
   * folder in the file tree recorded nothing (found in acceptance item 4,
   * 2026-09-23 -- `delete: 1 item(s) not recorded (notVersioned)`). What is
   * INSIDE it is the evidence TFVC leaves behind: every file it handed out is
   * read-only, so one such file anywhere below proves the folder is part of
   * the workspace's tree.
   *
   * Runs at `onWillDeleteFiles`, while the folder is still on disk, and stops
   * at the FIRST proof -- a versioned folder normally answers on its first
   * entry. `budget` bounds the opposite case, a big folder with nothing
   * versioned in it (`node_modules` the scan has not covered yet): the walk
   * gives up and answers "not versioned", which is this handler's default
   * everywhere else.
   */
  const holdsVersionedFile = (root: string, budget: { left: number }): boolean => {
    // LEVEL-ORDER, not depth-first, and that is the whole point of the queue.
    // Depth-first spends the budget on whatever `readdir` happens to return
    // first: for `ClientApp/{node_modules, src}` it would exhaust itself
    // inside `node_modules` and never reach the read-only files in `src`,
    // answering "not versioned" for a folder that plainly is -- the same
    // silent non-recording this function was added to fix. Level-order reaches
    // every folder's own files before descending into any of them, so a big
    // unversioned subtree can no longer hide a versioned sibling.
    const queue: string[] = [root];
    while (queue.length > 0) {
      const dir = queue.shift()!;
      let entries: readonly Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        continue; // unreadable: not evidence either way, and its siblings still are
      }
      let here = PER_DIR_BUDGET;
      for (const entry of entries) {
        if (budget.left-- <= 0) return false;
        if (here-- <= 0) break; // enough of this one; its siblings still deserve a look
        const child = join(dir, entry.name);
        // A symlink is neither: `Dirent.isDirectory()` and `.isFile()` are both
        // false for one, so links are skipped here and no cycle is possible.
        if (entry.isDirectory()) {
          queue.push(child);
          continue;
        }
        if (!entry.isFile()) continue;
        if (deps.service.changeForLocal(child) !== undefined) return true;
        if (readOnlyFile(child)) return true;
      }
    }
    return false;
  };

  /**
   * Was this path under version control a moment ago? Read from what the
   * extension already knows -- no tf call in a file-operation handler.
   * `FileState`'s own order: a pending change proves it, the scan's positive
   * finding disproves it, and in a server workspace a read-only file is
   * versioned. Anything still unknown counts as NOT versioned, so silence is
   * the default.
   */
  const wasVersioned = (fsPath: string): boolean => {
    const mapper = deps.service.pathMapper;
    if (!mapper || mapper.toServerPath(fsPath) === undefined) return false;
    if (deps.service.changeForLocal(fsPath) !== undefined) return true;
    const verdict = deps.scan().verdictFor(fsPath);
    if (verdict === 'inSourceControl') return true;
    let folder = false;
    try {
      folder = statSync(fsPath).isDirectory();
    } catch {
      // Already gone, and nothing above claimed it. Silence is the default.
      return false;
    }
    // The read-only bit OUTRANKS the scan's denial here, unlike in FileState,
    // where the scan wins so a copied file does not wear a lock badge. The
    // reason is a measured tf defect: `reconcile` reports files as "Pending
    // add" that `info` puts at a real changeset with no pending change, and
    // believing it left a delete silently unrecorded (found in acceptance,
    // 2026-09-23). Probes R28-R31 later traced that to a workspace whose
    // mapped folder was never downloaded, and `UnversionedScan` now refuses
    // to believe such a listing at all -- this guard stays regardless: it is
    // cheap, and it is the difference between losing a pending change in
    // silence and not. The costs are not symmetric: a wrong "unversioned" loses the
    // pending change in silence, while a wrong "versioned" only makes tf
    // refuse an item it does not know, which is visible and harmless.
    return folder ? holdsVersionedFile(fsPath, { left: WALK_BUDGET }) : readOnlyFile(fsPath);
  };

  const log = (line: string): void => deps.output.appendLine(line);

  async function onRenamed(files: readonly { oldUri: vscode.Uri; newUri: vscode.Uri }[]): Promise<void> {
    const mapper = deps.service.pathMapper;
    for (const f of files) {
      const oldPath = f.oldUri.fsPath;
      const newPath = f.newUri.fsPath;
      const decision = planRename({
        oldPath,
        newPath,
        oldServerPath: mapper?.toServerPath(oldPath),
        newServerPath: mapper?.toServerPath(newPath),
        wasVersioned: remembered.get(key(oldPath)) ?? false,
      });
      remembered.delete(key(oldPath));
      if (decision.kind === 'ignore') {
        log(`rename: ${nameOfPath(oldPath)} not recorded (${decision.reason})`);
        continue;
      }

      // R2: tf refuses while the item sits at its new path, and R5: it works
      // once the item is back. So put it back and let tf do the move itself.
      if (!existsSync(newPath)) {
        log(`rename: ${nameOfPath(newPath)} not recorded (it is no longer where VS Code left it)`);
        void vscode.window.showWarningMessage(S.fileOpsRepairMissing(nameOfPath(newPath)));
        continue;
      }
      // A case-only rename (`date.js` -> `Date.js`) is the SAME item on a
      // case-insensitive filesystem, so `oldPath` "existing" here is not
      // another file in the way -- it is this file, seen through its old
      // name. tf still needs to see the move to record the case change
      // (R4), so only a genuinely different item at the old name blocks
      // the repair.
      const sameItem = localKey(oldPath, deps.service.platform) === localKey(newPath, deps.service.platform);
      if (!sameItem && existsSync(oldPath)) {
        log(`rename: ${nameOfPath(newPath)} not recorded (the old name is in use again)`);
        void vscode.window.showWarningMessage(S.fileOpsRepairBlocked(nameOfPath(newPath)));
        continue;
      }
      try {
        renameSync(newPath, oldPath);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        log(`rename: could not put ${nameOfPath(newPath)} back: ${detail}`);
        void vscode.window.showWarningMessage(S.fileOpsRenameFailed(nameOfPath(newPath), detail));
        continue;
      }

      const outcome = await deps.ops.rename(mapper!.toWinePath(oldPath), mapper!.toWinePath(newPath));
      if (!outcome.ok) {
        // Never undo the user's own rename: put it back where they left it --
        // but only if the spot is free. tf can take seconds, and a save from
        // the still-open editor (often the very reason tf just failed) can
        // recreate the file at newPath while it runs; a blind `renameSync`
        // would silently overwrite that with the old content instead of
        // merely failing to record a rename.
        if (existsSync(newPath)) {
          log(`rename: could not restore ${nameOfPath(oldPath)} to ${nameOfPath(newPath)}: the name is in use again`);
          void vscode.window.showWarningMessage(S.fileOpsRestoreBlocked(nameOfPath(oldPath), nameOfPath(newPath)));
        } else {
          try {
            renameSync(oldPath, newPath);
          } catch (err) {
            log(`rename: could not restore ${nameOfPath(newPath)}: ${err instanceof Error ? err.message : String(err)}`);
          }
          void vscode.window.showWarningMessage(S.fileOpsRenameFailed(nameOfPath(newPath), outcome.message));
        }
        // FileOpsService's own doc comment: refresh on both outcomes. A
        // refused rename is not always a pure no-op on tf's side, and the
        // pending set is cheap to re-read either way.
        deps.refresh();
        continue;
      }
      log(`rename: ${nameOfPath(oldPath)} -> ${nameOfPath(newPath)} recorded`);
      deps.refresh();
    }
  }

  async function onDeleted(files: readonly vscode.Uri[]): Promise<void> {
    const mapper = deps.service.pathMapper;
    const decision = planDelete(
      files.map((uri) => ({
        path: uri.fsPath,
        serverPath: mapper?.toServerPath(uri.fsPath),
        wasVersioned: remembered.get(key(uri.fsPath)) ?? false,
      })),
    );
    for (const uri of files) remembered.delete(key(uri.fsPath));
    if (decision.kind === 'ignore') {
      log(`delete: ${files.length} item(s) not recorded (${decision.reason})`);
      return;
    }
    const outcome = await deps.ops.delete(decision.paths.map((p) => mapper!.toWinePath(p)));
    // Refresh whatever the outcome: tf exits non-zero for a batch it only
    // PARTLY recorded, and those items are already pending and already gone
    // from disk (FileOpsService's own doc comment).
    deps.refresh();
    if (!outcome.ok) {
      void vscode.window.showWarningMessage(
        S.fileOpsDeleteFailed(decision.paths.map(nameOfPath), outcome.message),
      );
      return;
    }
    log(`delete: ${decision.paths.length} item(s) recorded`);
  }

  const detach = (work: Promise<void>): void => {
    // A file-operation handler must never reject: VS Code logs that where the
    // user will not look, and the operation itself has already happened.
    void work.catch((err) => log(`fileOps: ${err instanceof Error ? err.message : String(err)}`));
  };

  context.subscriptions.push(
    vscode.workspace.onWillRenameFiles((e) => {
      for (const f of e.files) remembered.set(key(f.oldUri.fsPath), wasVersioned(f.oldUri.fsPath));
    }),
    vscode.workspace.onWillDeleteFiles((e) => {
      for (const uri of e.files) remembered.set(key(uri.fsPath), wasVersioned(uri.fsPath));
    }),
    vscode.workspace.onDidRenameFiles((e) => detach(onRenamed(e.files))),
    vscode.workspace.onDidDeleteFiles((e) => detach(onDeleted(e.files))),

    /**
     * The Source Control Explorer's Rename…. It passes the item's LOCAL path,
     * because tf needs the local copy to move (R13), and the folder's names so
     * a duplicate is refused before tf is asked.
     */
    vscode.commands.registerCommand('teamExplorer.renameItem', async (target: unknown, siblings: unknown) => {
      if (typeof target !== 'string' || target === '') {
        log('renameItem: ignored an invalid argument');
        return;
      }
      const mapper = deps.service.pathMapper;
      if (!mapper || mapper.toServerPath(target) === undefined) {
        void vscode.window.showWarningMessage(S.noWorkspaceMapping);
        return;
      }
      const current = nameOfPath(target);
      const names = Array.isArray(siblings) ? siblings.filter((s): s is string => typeof s === 'string') : [];
      /**
       * The name check: live in the box, and again on what comes back.
       *
       * `names` is the SERVER folder's listing, so on its own it misses every
       * name that exists only on disk -- a file whose rename INTO this folder
       * is still pending, one that was never added, one left behind by a
       * failed operation. tf refuses those itself (exit 100, measured during
       * acceptance 2026-09-23), but by then the user has typed a name,
       * confirmed it, and got a warning instead of a rename. The disk is the
       * authority, and asking it costs one stat.
       */
      const check = (value: string): string | undefined => {
        const invalid = validateName(value, current, names);
        if (invalid !== undefined) return invalid;
        const candidate = renamedPath(target, value);
        // A case-only rename names the SAME item, and on Windows `existsSync`
        // answers yes to every spelling of it. `key` folds case only where the
        // platform does, so this allows `a.txt` -> `A.txt` there while still
        // refusing it on Linux, where `A.txt` would be a different file.
        if (key(candidate) === key(target)) return undefined;
        return existsSync(candidate) ? S.fileOpsBadNameTaken(value) : undefined;
      };
      const next = await vscode.window.showInputBox({
        title: S.fileOpsRenameTitle,
        prompt: S.fileOpsRenamePrompt(current),
        value: current,
        validateInput: check,
      });
      if (next === undefined || next === current) return;
      const message = check(next);
      if (message !== undefined) {
        void vscode.window.showWarningMessage(message);
        return;
      }
      const destination = renamedPath(target, next);
      if (mapper.toServerPath(destination) === undefined) {
        void vscode.window.showWarningMessage(S.noWorkspaceMapping);
        return;
      }
      const outcome = await deps.ops.rename(mapper.toWinePath(target), mapper.toWinePath(destination));
      if (!outcome.ok) {
        void vscode.window.showWarningMessage(S.fileOpsRenameFailed(current, outcome.message));
        deps.refresh();
        return;
      }
      log(`rename: ${current} -> ${next} recorded`);
      deps.refresh();
    }),

    /**
     * The Source Control Explorer's Delete. Server paths, because a delete
     * needs no local copy (R15), and the explorer may be showing an item that
     * was never downloaded.
     */
    vscode.commands.registerCommand('teamExplorer.deleteItems', async (arg: unknown) => {
      const request = arg as { paths?: unknown; names?: unknown; hasFolder?: unknown } | undefined;
      const paths = Array.isArray(request?.paths) ? request.paths : [];
      const names = Array.isArray(request?.names) ? request.names.filter((n): n is string => typeof n === 'string') : [];
      if (paths.length === 0 || !paths.every(isServerPath)) {
        log('deleteItems: ignored an invalid argument');
        return;
      }
      // Shape alone is not enough: `isServerPath` accepts `$/` itself, and
      // some workspaces map exactly that as their root, so a shape-only
      // check would let a delete of the entire server root, or of an item
      // this project does not even map, reach `vc delete`. tf records a
      // pending change in a workspace, and neither of those has one here.
      const mapper = deps.service.pathMapper;
      if (!mapper || paths.some((p) => p === '$/') || !paths.every((p) => mapper.toLocalPath(p) !== undefined)) {
        log('deleteItems: ignored an invalid argument');
        return;
      }
      const yes = await vscode.window.showWarningMessage(
        request?.hasFolder === true ? S.fileOpsDeleteConfirmFolder(names) : S.fileOpsDeleteConfirmFile(names),
        { modal: true, detail: S.fileOpsDeleteDetail },
        S.fileOpsDeleteYes,
      );
      if (yes !== S.fileOpsDeleteYes) return;
      const outcome = await deps.ops.delete(paths);
      if (!outcome.ok) {
        void vscode.window.showWarningMessage(S.fileOpsDeleteFailed(names, outcome.message));
        deps.refresh();
        return;
      }
      log(`delete: ${paths.length} item(s) recorded`);
      deps.refresh();
    }),
  );
}
