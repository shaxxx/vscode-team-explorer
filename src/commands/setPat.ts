import * as vscode from 'vscode';
import { S } from '../tf/strings.js';
import { writePatFile, defaultPatFilePath } from '../pat/PatStore.js';

import { SECRET_KEY } from '../migrateState.js';

/**
 * The saved token, if there is one.
 *
 * "On an auth failure with a PAT in SecretStorage, offer to rewrite
 * the file rather than doing it silently." Until this existed, nothing ever
 * READ the secret — a live credential sat in the OS keychain serving no
 * purpose, and the one failure it was stored to help with (pat.txt deleted,
 * emptied, or saved with a BOM) had no path to recovery.
 */
export async function storedPat(secrets: vscode.SecretStorage): Promise<string | undefined> {
  const token = (await secrets.get(SECRET_KEY))?.trim();
  return token ? token : undefined;
}

/**
 * Stores the PAT in SecretStorage AND writes the file both tfp wrappers read.
 *
 * The file is written ONLY by this command — never at activation, never in the
 * background — so hand-edits to pat.txt are never fought. The wrapper reads the
 * file, so the file always wins.
 */
export function registerSetPat(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('teamExplorer.setPat', async () => {
      const token = await vscode.window.showInputBox({
        prompt: S.patPrompt,
        password: true,
        ignoreFocusOut: true,
      });
      // Trim BEFORE the guard. `!token` is false for "   ", so a stray space
      // or a lone newline from a clipboard artefact used to pass: SecretStorage
      // was overwritten with '' and pat.txt with a single "\n" -- BOTH copies
      // of a live token destroyed, behind a "saved" toast, and with the rewrite
      // offer then suppressed because storedPat trims '' back to undefined.
      // The user's terminal tfp workflow breaks at the same moment.
      const trimmed = token?.trim();
      if (!trimmed) return;

      // Interior whitespace cannot survive either: tfp.cmd reads the file with
      // `set /p`, which takes the first line only, so a multi-line value is
      // silently truncated to something that will never authenticate -- and
      // the rewrite flow would faithfully reproduce the broken file forever.
      if (/\s/.test(trimmed)) {
        void vscode.window.showErrorMessage(S.patNotAToken);
        return;
      }

      await context.secrets.store(SECRET_KEY, trimmed);
      writePatFile(defaultPatFilePath(), trimmed);

      void vscode.window.showInformationMessage(S.patSaved);
    }),
  );
}
