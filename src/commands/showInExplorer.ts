import * as vscode from 'vscode';
import { unwrapTargets } from './resolveTarget.js';
import { isServerPath, parentPath } from '../explorer/explorerModel.js';
import type { PathMapper } from '../tf/PathMapper.js';
import { S } from '../tf/strings.js';

/**
 * "Show in Source Control Explorer" (phase 3 part 2 design X5): from the
 * Explorer's Team Explorer submenu and the editor's right-click menu, opens
 * the explorer at the item's folder with the item selected.
 */
export function registerShowInExplorer(
  context: { subscriptions: { dispose(): unknown }[] },
  service: { readonly pathMapper: Pick<PathMapper, 'toServerPath'> | undefined },
  explorer: { show(path?: string, select?: string): Promise<void> },
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('teamExplorer.showInExplorer', async (...args: unknown[]) => {
      const target = (unwrapTargets(args)[0] as vscode.Uri | undefined) ?? vscode.window.activeTextEditor?.document.uri;
      if (!target) {
        void vscode.window.showWarningMessage(S.noTarget);
        return;
      }
      const serverPath = service.pathMapper?.toServerPath(target.fsPath);
      if (!serverPath) {
        void vscode.window.showWarningMessage(S.noWorkspaceMapping);
        return;
      }
      // Review: a real local folder can be named `*` or `;` (legal on
      // Fedora's ext4), and toServerPath does nothing but translate the
      // prefix -- it does not reject tf itemspec syntax. Never hand that to
      // show() as the folder to open.
      if (!isServerPath(serverPath)) {
        void vscode.window.showWarningMessage(S.sceUnknownPath);
        return;
      }
      await explorer.show(parentPath(serverPath), serverPath);
    }),
  );
}
