import * as vscode from 'vscode';
import { S } from '../tf/strings.js';
import { scrubSecrets, type TfClient } from '../tf/TfClient.js';
import type { TfvcService } from '../TfvcService.js';
import type { ScmProvider } from '../ui/ScmProvider.js';
import { runMutation } from './index.js';
import { writeCommentFile } from './commentFile.js';

/**
 * HARD RULE 1 — the ONLY place `tf vc checkin` is ever invoked.
 *
 * Reachable only from the Check In button, and only after the user confirms a
 * modal dialog. There is deliberately no command-palette entry, no keybinding,
 * and no exported function that performs a check-in without the dialog.
 * `test/unit/checkinCallSite.test.ts` enforces this.
 */
export function registerCheckIn(
  context: vscode.ExtensionContext,
  client: TfClient,
  service: TfvcService,
  scm: ScmProvider,
  output: vscode.OutputChannel,
  autoCheckout?: { reset(fsPath: string): void },
  serverContent?: { invalidate(serverItem?: string): void },
  /**
   * Re-scans for unversioned files after a successful check-in. A file the
   * scan had listed as `notInSourceControl` must stop reading that way once
   * it is checked in, or it reappears in the "Not in source control" group
   * with no lock -- see `runMutation`'s own doc comment.
   */
  rescan?: () => void,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('teamExplorer.checkInFromButton', async () => {
      const files = scm.includedChanges;
      if (files.length === 0) return;

      const choice = await vscode.window.showWarningMessage(
        S.checkInConfirmTitle,
        { modal: true, detail: S.checkInConfirmDetail(files.length) },
        S.checkInConfirmYes,
      );
      if (choice !== S.checkInConfirmYes) return;

      const comment = scm.inputBoxValue.trim();

      // The comment goes via a file, not the command line. Even correctly
      // quoted, a command-line argument is still subject to %VAR% expansion,
      // so `%PATH%` in a comment would be replaced by its value — permanently,
      // in TFVC history — and a newline would truncate it.
      //
      // Created INSIDE the try. mkdtempSync and writeFileSync throw on a full
      // disk, an unwritable %TEMP%, or an AV block, and this handler has no
      // outer catch — so the rejection escaped registerCommand and the user,
      // having just confirmed "N items will be checked in… This cannot be
      // undone", saw nothing happen at all. The natural response is to click
      // Check In again. It also leaked the temp directory, because the finally
      // belonged to a try that was never entered.
      let commentFile: { path: string; dispose: () => void } | undefined;
      try {
        if (comment) commentFile = writeCommentFile(comment);
      } catch (e) {
        const detail = scrubSecrets(e instanceof Error ? e.message : String(e));
        output.appendLine(detail);
        void vscode.window.showErrorMessage(S.commentFileFailed(detail));
        return;
      }

      try {
        // The comment path must be one TF.EXE can open. On Fedora tf runs under
        // Wine and sees the disk as Z:, so /tmp/... is not a path it can
        // resolve — the same translation `tfvc.add` already does.
        const commentPath = commentFile
          ? (service.pathMapper?.toWinePath(commentFile.path) ?? commentFile.path)
          : undefined;

        const args = [
          'vc',
          'checkin',
          ...files.map((f) => f.serverItem),
          ...(commentPath ? [`/comment:@${commentPath}`] : []),
        ];

        const ok = (await runMutation(client, service, output, args, rescan)).ok;
        if (ok) {
          scm.clearInputBox();
          // A check-in is the one thing this extension does that changes what
          // `view /version:T` resolves to, so the cached server copies of the
          // files just submitted are now wrong.
          for (const file of files) serverContent?.invalidate(file.serverItem);
        }

        // Clear the auto-checkout one-shot guard for everything submitted,
        // WHATEVER the outcome.
        //
        // A check-in makes these files read-only again - on success because
        // they were checked in, and on failure because `tf vc checkin` undoes
        // any pending edit whose content matches the server ("The following
        // changes were not checked in because the items were not modified.
        // Undoing edit: ..."). Either way the extension is not told.
        //
        // The guard allows one checkout attempt per file per session, so
        // without this the next edit to such a file hits `attempted` and is
        // skipped. The file stays read-only, the save fails, and VS Code
        // answers with an **Overwrite** action that clears the read-only bit
        // and writes behind TFVC's back - the one thing CLAUDE.md forbids
        // outright, reached by a user who did nothing wrong. Observed on
        // DEVPC: exactly this dialog, on NetUtils.cs, after a check-in that
        // had undone its unmodified edit.
        //
        // Deliberately NOT reverting open buffers the way Undo does. Undo's
        // dialog promises the edits will be discarded; check-in promises no
        // such thing, and a dirty buffer here holds work the user still wants.
        // Clearing the guard is what lets them check the file out and save it.
        for (const file of files) {
          const local = service.pathMapper?.fromWinePath(file.localPath) ?? file.localPath;
          autoCheckout?.reset(local);
        }
      } finally {
        commentFile?.dispose();
      }
    }),
  );
}
