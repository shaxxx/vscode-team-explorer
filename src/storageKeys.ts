/**
 * Where this extension keeps its own state.
 *
 * Deliberately NOT in `migrateState.ts`, although the rename that created them
 * lives there. These are permanent; that migration is not, and importing a
 * production key from a module named for a one-time migration means the keys
 * get deleted along with it.
 */

/** workspaceState: the server paths the user has excluded from check-in. */
export const EXCLUDED_KEY = 'teamExplorer.excluded';

/** SecretStorage: the Azure DevOps Personal Access Token. */
export const SECRET_KEY = 'teamExplorer.pat';

/**
 * globalState: set once the token has been moved off the pre-rename key AND
 * that key removed.
 *
 * This flag exists to keep the OS keychain out of the activation path. Reading
 * SecretStorage is not free and not safe to do eagerly: it rejects when the
 * Linux keyring is locked or absent, which is a normal state on the Fedora
 * machine this targets, and a keyring that prompts to unlock BLOCKS rather
 * than rejecting. See the guarded read in `extension.ts`, which exists because
 * an unguarded one once killed activation outright.
 */
export const SECRET_MIGRATED_FLAG = 'teamExplorer.secretMigrated';
