import * as vscode from 'vscode';
import type { FileStateSource } from '../state/FileState.js';

/** The `when`-clause key the editor menu gates on. */
export const ACTIVE_FILE_STATE_KEY = 'teamExplorer.activeFileState';

/**
 * Keeps `teamExplorer.activeFileState` equal to the FileState of the file in
 * the active editor, so the editor's context menu offers only what applies.
 * One global key is all the platform allows -- an extension cannot set a
 * context key per resource -- and it is enough here, because there is only
 * one active editor.
 *
 * An empty string when there is no active file editor, or the file has no
 * state, so every state-gated entry hides rather than matching a stale value.
 */
export class ActiveFileState implements vscode.Disposable {
  private last: string | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly source: Pick<FileStateSource, 'stateOf'>,
    /** Anything that can change a file's state: status refreshes, scans. */
    triggers: readonly vscode.Event<unknown>[],
  ) {
    this.disposables.push(vscode.window.onDidChangeActiveTextEditor(() => this.update()));
    for (const trigger of triggers) this.disposables.push(trigger(() => this.update()));
    this.update();
  }

  private update(): void {
    const uri = vscode.window.activeTextEditor?.document.uri;
    const value = uri?.scheme === 'file' ? (this.source.stateOf(uri.fsPath) ?? '') : '';
    // Every status refresh fires a trigger; most change nothing about the one
    // file in front of the user, and setContext is a round trip to the
    // renderer.
    if (value === this.last) return;
    this.last = value;
    void vscode.commands.executeCommand('setContext', ACTIVE_FILE_STATE_KEY, value);
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}
