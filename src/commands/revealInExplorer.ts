import * as vscode from 'vscode';
import { unwrapTargets } from './resolveTarget.js';
import { S } from '../tf/strings.js';

/**
 * "Reveal in Explorer" on a Source Control row: VS Code's own
 * `revealInExplorer` opens the Explorer view with the file selected. A menu
 * entry hands it the row (and the selection), not a Uri, so it cannot be
 * contributed directly. The first of a multi-selection, as Compare does.
 */
export function registerRevealInExplorer(context: { subscriptions: { dispose(): unknown }[] }): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('teamExplorer.revealInExplorer', async (...args: unknown[]) => {
      const target = unwrapTargets(args)[0] as vscode.Uri | undefined;
      if (!target) {
        void vscode.window.showWarningMessage(S.noTarget);
        return;
      }
      await vscode.commands.executeCommand('revealInExplorer', target);
    }),
  );
}
