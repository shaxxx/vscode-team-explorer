import * as vscode from 'vscode';
import { basename } from 'node:path';
import { S } from '../tf/strings.js';
import { scrubSecrets } from '../tf/TfClient.js';
import type { PendingChange } from '../tf/types.js';
import type { ShelveService } from '../shelve/ShelveService.js';
import { nameProblem } from '../shelve/shelveRules.js';
import { writeCommentFile } from './commentFile.js';

/** Everything Shelve needs (wired in extension.ts, faked in tests). */
export interface ShelveDeps {
  service: {
    readonly pathMapper?: { toWinePath(p: string): string; fromWinePath(p: string): string };
    requestRefresh(): void;
  };
  /** The Source Control panel: its Included changes and its comment box. */
  scm: { readonly includedChanges: readonly PendingChange[]; readonly inputBoxValue: string };
  shelve: Pick<ShelveService, 'exists' | 'shelve'>;
  output: vscode.OutputChannel;
  autoCheckout?: { reset(fsPath: string): void };
  /** Re-scan for files not in source control; `/move` deletes a pending add's local copy (S10). */
  rescan(): void;
  /** Refresh the Shelvesets tab if it is open. */
  afterShelve(): void;
}

export function registerShelve(context: vscode.ExtensionContext, deps: ShelveDeps): void {
  context.subscriptions.push(vscode.commands.registerCommand('teamExplorer.shelve', () => runShelve(deps)));
}

const samePath = (a: string, b: string): boolean =>
  process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;

/**
 * Shelve: Visual Studio's Pending Changes → Shelve. It takes the
 * INCLUDED changes and the comment box, as the check-in button does, then asks
 * for a name and whether to keep the changes locally.
 */
export async function runShelve(deps: ShelveDeps): Promise<void> {
  const files = deps.scm.includedChanges;
  if (files.length === 0) {
    void vscode.window.showInformationMessage(S.shelveNothingIncluded);
    return;
  }
  const native = (f: PendingChange): string => deps.service.pathMapper?.fromWinePath(f.localPath) ?? f.localPath;

  // tf shelves what is on DISK. An unsaved edit would be silently left out of
  // the shelveset -- and with "undo", lost. Visual Studio asks the same.
  //
  // A pending DELETE is excluded: "Save and Shelve" calls TextDocument.save(),
  // which writes the editor's buffer back to disk -- for a file tf is about to
  // remove that RECREATES it, the opposite of what the delete is meant to do.
  const dirty = vscode.workspace.textDocuments.filter(
    (d) => d.isDirty && files.some((f) => !f.changes.has('Delete') && samePath(native(f), d.uri.fsPath)),
  );
  if (dirty.length > 0) {
    const yes = await vscode.window.showWarningMessage(
      S.shelveSaveFirst(dirty.map((d) => basename(d.uri.fsPath))),
      { modal: true, detail: S.shelveSaveFirstDetail },
      S.shelveSaveYes,
    );
    if (yes !== S.shelveSaveYes) return;
    for (const d of dirty) {
      if (!(await d.save())) {
        void vscode.window.showErrorMessage(S.shelveSaveFailed(basename(d.uri.fsPath)));
        return;
      }
    }
  }

  const typed = await vscode.window.showInputBox({
    title: S.shelveTitle,
    prompt: S.shelveNamePrompt(files.length),
    ignoreFocusOut: true,
    validateInput: (value) => nameProblem(value) ?? null,
  });
  if (typed === undefined) return;
  const name = typed.trim();
  const problem = nameProblem(name);
  if (problem) {
    void vscode.window.showInformationMessage(problem);
    return;
  }

  const mode = await vscode.window.showQuickPick(
    [
      { label: S.shelveKeep, detail: S.shelveKeepDetail, move: false },
      { label: S.shelveUndo, detail: S.shelveUndoDetail, move: true },
    ],
    { title: S.shelveTitle, placeHolder: name },
  );
  if (!mode) return;

  // exists() and shelve() both go through TfClient.run, which RESOLVES on a
  // failed command but REJECTS when spawn throws synchronously (bad cwd,
  // malformed environment -- the same hazard runMutation guards against for
  // every other mutating command). Without a catch here that rejection
  // propagated out of an async command handler, where VS Code logs it to a
  // channel the user never opens: nothing shown, and -- worse -- a comment
  // file left on disk because the dispose below never ran. One catch around
  // both calls, with the comment file's own try/finally nested inside it so
  // BOTH failure shapes are covered by a single outer finally.
  let commentFile: { path: string; dispose: () => void } | undefined;
  try {
    // Without /replace tf refuses an existing name (S4) -- but only after
    // printing "Shelving ..." lines. Asking first is what lets the user decide.
    const taken = await deps.shelve.exists(name);
    if (!taken.ok) {
      void vscode.window.showErrorMessage(S.shelveLookupFailed(taken.message));
      return;
    }
    let replace = false;
    if (taken.value) {
      const yes = await vscode.window.showWarningMessage(
        S.shelveReplaceConfirm(name),
        { modal: true, detail: S.shelveReplaceDetail },
        S.shelveReplaceYes,
      );
      if (yes !== S.shelveReplaceYes) return;
      replace = true;
    }

    // Through a file, as the check-in comment is: an argument is subject to
    // cmd.exe's %VAR% expansion, and a newline would cut it short.
    const comment = deps.scm.inputBoxValue.trim();
    try {
      if (comment) commentFile = writeCommentFile(comment);
    } catch (e) {
      const detail = scrubSecrets(e instanceof Error ? e.message : String(e));
      deps.output.appendLine(detail);
      void vscode.window.showErrorMessage(S.shelveCommentFailed(detail));
      return;
    }

    // Wine sees the disk as Z:, so the comment path is translated the way Add and Check In translate theirs.
    const commentPath = commentFile ? (deps.service.pathMapper?.toWinePath(commentFile.path) ?? commentFile.path) : undefined;
    const ran = await deps.shelve.shelve({
      name,
      // tf's own form of each path, straight from the status XML.
      paths: files.map((f) => f.localPath),
      ...(commentPath ? { commentPath } : {}),
      replace,
      move: mode.move,
    });

    // On EVERY outcome: a failed /move may still have undone some changes.
    if (mode.move) for (const f of files) deps.autoCheckout?.reset(native(f));
    deps.service.requestRefresh();
    if (mode.move) deps.rescan();
    deps.afterShelve();

    if (ran.exitCode === 0) {
      void vscode.window.showInformationMessage(mode.move ? S.shelveDoneUndone(name, files.length) : S.shelveDone(name, files.length));
    } else {
      deps.output.appendLine(`shelve: ${ran.message ?? `exit ${ran.exitCode}`}`);
      void vscode.window.showErrorMessage(S.shelveFailed(name, ran.message ?? ''));
    }
  } catch (e) {
    const detail = scrubSecrets(e instanceof Error ? e.message : String(e));
    deps.output.appendLine(detail);
    void vscode.window.showErrorMessage(S.commandFailed(detail));
  } finally {
    commentFile?.dispose();
  }
}
