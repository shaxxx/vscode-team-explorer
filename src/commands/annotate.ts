import * as vscode from 'vscode';
import { statSync } from 'node:fs';
import { basename } from 'node:path';
import type { Annotator } from '../annotate/Annotator.js';
import { unwrapTargets } from './resolveTarget.js';
import { S } from '../tf/strings.js';

function isFolder(fsPath: string): boolean {
  try {
    return statSync(fsPath).isDirectory();
  } catch {
    return false;
  }
}

export function registerAnnotate(context: vscode.ExtensionContext, annotator: Annotator): void {
  const targetOf = (args: readonly unknown[]): vscode.Uri | undefined =>
    (unwrapTargets(args)[0] as vscode.Uri | undefined) ?? vscode.window.activeTextEditor?.document.uri;

  context.subscriptions.push(
    annotator,
    vscode.commands.registerCommand('teamExplorer.annotate', async (...args: unknown[]) => {
      const target = targetOf(args);
      if (!target) {
        void vscode.window.showWarningMessage(S.noTarget);
        return;
      }
      if (isFolder(target.fsPath)) {
        void vscode.window.showInformationMessage(S.annotateFolder);
        return;
      }
      // From the Explorer the file may not be open yet, and Annotate draws on an editor.
      // VS Code refuses a binary (or too large) file here, and a command's rejection is
      // only logged, so say why instead of doing nothing.
      let document: vscode.TextDocument;
      try {
        document = await vscode.workspace.openTextDocument(target);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        const detail = /Detail: ([\s\S]*)$/.exec(message)?.[1].trim() || message;
        void vscode.window.showInformationMessage(S.annotateCannotOpen(basename(target.fsPath), detail));
        return;
      }
      await vscode.window.showTextDocument(document, { preview: false });
      await annotator.annotate(document);
    }),
    vscode.commands.registerCommand('teamExplorer.hideAnnotations', (...args: unknown[]) => {
      const target = targetOf(args);
      if (target) annotator.hide(target);
    }),
  );
}
