import * as vscode from 'vscode';

/**
 * After one of the extension's own Gets, look for conflicts under
 * what it got -- the Resolve Conflicts tab opens only when there are some.
 * tf's exit code cannot say (C1, C2). Fire-and-forget: the Get has already
 * reported its own result, a failed look is logged by ConflictService, and a
 * rejection here (the command missing, say) must not become an unhandled one.
 */
export function lookForConflictsAfterGet(serverPaths: readonly string[]): void {
  if (serverPaths.length === 0) return;
  void Promise.resolve(
    vscode.commands.executeCommand('teamExplorer.resolveConflicts', [...serverPaths]),
  ).catch(() => undefined);
}
