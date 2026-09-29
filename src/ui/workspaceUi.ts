import * as vscode from 'vscode';
import type { PickItem, WorkspaceUi } from '../commands/workspace.js';

/** The VS Code side of `WorkspaceUi`. Thin on purpose: the flows are tested through the interface. */
export const workspaceUi: WorkspaceUi = {
  async pick<T>(title: string, items: PickItem<T>[]) {
    const chosen = await vscode.window.showQuickPick(
      items.map((i) => ({ label: i.label, description: i.description, value: i.value })),
      { title, ignoreFocusOut: true },
    );
    return chosen?.value;
  },
  async pickMany<T>(title: string, items: PickItem<T>[]) {
    const chosen = await vscode.window.showQuickPick(
      items.map((i) => ({ label: i.label, description: i.description, value: i.value })),
      { title, canPickMany: true, ignoreFocusOut: true },
    );
    return chosen?.map((c) => c.value);
  },
  input(title, value, validate) {
    return Promise.resolve(vscode.window.showInputBox({ title, value, validateInput: validate, ignoreFocusOut: true }));
  },
  async pickLocalFolder(title) {
    const picked = await vscode.window.showOpenDialog({
      title,
      openLabel: 'Use This Folder',
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: false,
    });
    return picked?.[0]?.fsPath;
  },
  async confirm(message, detail, yes) {
    return (await vscode.window.showWarningMessage(message, { modal: true, detail: detail || undefined }, yes)) === yes;
  },
  info(message) {
    void vscode.window.showInformationMessage(message);
  },
  warn(message) {
    void vscode.window.showWarningMessage(message);
  },
  progress(title, task) {
    return Promise.resolve(
      vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: true }, (progress, token) => {
        const controller = new AbortController();
        token.onCancellationRequested(() => controller.abort());
        return task((message) => progress.report({ message }), controller.signal);
      }),
    );
  },
};
