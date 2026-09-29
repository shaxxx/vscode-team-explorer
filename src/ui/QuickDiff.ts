import * as vscode from 'vscode';
import { ServerContentProvider } from './ServerContentProvider.js';
import type { TfvcService } from '../TfvcService.js';
import { isBinary, isPendingAdd } from '../tf/types.js';

/**
 * Supplies the "original" side for VS Code's gutter change bars.
 *
 * Returns undefined — meaning "no baseline, do not draw bars" — for:
 *   - pending Adds, which have no `ver` and no server copy at all
 *   - binary files (`enc === -1`)
 */
export class QuickDiff implements vscode.QuickDiffProvider {
  constructor(private readonly service: TfvcService) {}

  provideOriginalResource(uri: vscode.Uri): vscode.Uri | undefined {
    const serverItem = this.service.pathMapper?.toServerPath(uri.fsPath);
    if (!serverItem) return undefined;

    const change = this.service.changeFor(serverItem);
    if (!change) return undefined;
    if (isPendingAdd(change)) return undefined;
    if (isBinary(change)) return undefined;

    return ServerContentProvider.uriFor(uri.fsPath);
  }
}
