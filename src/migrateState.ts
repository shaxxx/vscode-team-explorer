import * as vscode from 'vscode';

/**
 * Carries the two private storage keys across the `tfvc` -> `teamExplorer`
 * rename.
 *
 * Neither key could collide with anything — a Memento and a SecretStorage
 * entry are scoped to the extension that wrote them — so unlike the command
 * ids and settings, these did not HAVE to move. They move anyway, because a
 * lone `tfvc.excluded` in a codebase with no other `tfvc` is a question mark
 * for whoever reads it next.
 *
 * What they must not do is move by simply changing the constant. That reads a
 * key nobody ever wrote, so the Excluded list silently empties and the stored
 * token silently disappears — the first visible only as files the user had
 * excluded quietly rejoining the check-in set.
 *
 * Both migrations are one-way, idempotent, and never overwrite a value already
 * under the new key.
 */

export const EXCLUDED_KEY = 'teamExplorer.excluded';
export const SECRET_KEY = 'teamExplorer.pat';

const OLD_EXCLUDED_KEY = 'tfvc.excluded';
const OLD_SECRET_KEY = 'tfvc.pat';

/**
 * Moves the excluded-files list, if it is still under the old key.
 *
 * Deliberately NOT validating the value: `excludedSet()` already treats an
 * unusable stored value as empty and warns, and doing that check here as well
 * would mean a corrupt value was silently dropped during migration instead of
 * being reported to the user by the code that owns that decision.
 */
export async function migrateExcluded(state: vscode.Memento): Promise<boolean> {
  if (state.get(EXCLUDED_KEY) !== undefined) return false;

  const old = state.get(OLD_EXCLUDED_KEY);
  if (old === undefined) return false;

  await state.update(EXCLUDED_KEY, old);
  await state.update(OLD_EXCLUDED_KEY, undefined);
  return true;
}

/** Moves the stored PAT, if it is still under the old key. */
export async function migrateSecret(secrets: vscode.SecretStorage): Promise<boolean> {
  if ((await secrets.get(SECRET_KEY)) !== undefined) return false;

  const old = await secrets.get(OLD_SECRET_KEY);
  if (old === undefined) return false;

  await secrets.store(SECRET_KEY, old);
  await secrets.delete(OLD_SECRET_KEY);
  return true;
}

/**
 * Runs both, reporting to the log rather than to the user.
 *
 * A failure here must not stop activation: the worst case is an empty Excluded
 * list, which is visible and recoverable, whereas an extension that refuses to
 * start over a housekeeping step is neither.
 */
export async function migrateStateKeys(
  state: vscode.Memento,
  secrets: vscode.SecretStorage,
  output: vscode.OutputChannel,
): Promise<void> {
  try {
    if (await migrateExcluded(state)) {
      output.appendLine('migrated the excluded-files list to teamExplorer.excluded');
    }
  } catch (e) {
    output.appendLine(`could not migrate the excluded-files list: ${(e as Error).message}`);
  }

  try {
    if (await migrateSecret(secrets)) {
      output.appendLine('migrated the stored token to teamExplorer.pat');
    }
  } catch (e) {
    output.appendLine(`could not migrate the stored token: ${(e as Error).message}`);
  }
}
