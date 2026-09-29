import { S } from '../tf/strings.js';

/**
 * Every decision behind phase 3 part 3. Pure on purpose: the
 * VS Code layer never guesses, so "did the extension do the right thing?" is
 * answerable with no tf, no disk and no workspace.
 */
export type IgnoreReason = 'notVersioned' | 'notMapped' | 'leavesWorkspace' | 'sameItem';

export type RenameDecision =
  | { kind: 'ignore'; reason: IgnoreReason }
  | { kind: 'rename'; oldPath: string; newPath: string };

export interface RenameInput {
  /** The native local path before VS Code moved it. */
  oldPath: string;
  /** The native local path after VS Code moved it. */
  newPath: string;
  oldServerPath: string | undefined;
  newServerPath: string | undefined;
  /** What the extension knew before the move -- read at `onWill…` time. */
  wasVersioned: boolean;
}

export function planRename(input: RenameInput): RenameDecision {
  if (!input.wasVersioned) return { kind: 'ignore', reason: 'notVersioned' };
  if (input.oldServerPath === undefined) return { kind: 'ignore', reason: 'notMapped' };
  // Moving an item out of the workspace is not a TFVC rename: tf has nowhere
  // to put it. The user can delete or add deliberately.
  if (input.newServerPath === undefined) return { kind: 'ignore', reason: 'leavesWorkspace' };
  // Exact comparison, never case-insensitive: a change of case IS a rename to
  // TFVC and tf records it (R4).
  if (input.oldServerPath === input.newServerPath) return { kind: 'ignore', reason: 'sameItem' };
  return { kind: 'rename', oldPath: input.oldPath, newPath: input.newPath };
}

export interface DeleteCandidate {
  path: string;
  serverPath: string | undefined;
  wasVersioned: boolean;
}

export type DeleteDecision =
  | { kind: 'ignore'; reason: IgnoreReason }
  | { kind: 'delete'; paths: string[] };

export function planDelete(items: readonly DeleteCandidate[]): DeleteDecision {
  const paths = items.filter((i) => i.wasVersioned && i.serverPath !== undefined).map((i) => i.path);
  if (paths.length === 0) return { kind: 'ignore', reason: 'notVersioned' };
  return { kind: 'delete', paths };
}

/** TFVC's own forbidden characters, plus the control characters tf refuses. */
const BAD_NAME = /[$/\\:*?"<>|\u0000-\u001f]/;
const MAX_NAME = 255;

/** The message for a new name, or undefined when it is fine. */
export function validateName(name: string, current: string, siblings: readonly string[]): string | undefined {
  if (name.length === 0) return S.fileOpsBadNameEmpty;
  if (BAD_NAME.test(name)) return S.fileOpsBadNameChars;
  // A leading dot is legal -- .gitignore, .editorconfig, .tfignore -- so only
  // a leading SPACE is refused; trailing space or dot are still edge cases
  // TFVC dislikes.
  if (/^ |[ .]$/.test(name)) return S.fileOpsBadNameEdge;
  if (name.length > MAX_NAME) return S.fileOpsBadNameLong;
  // Renaming `a.txt` to `A.txt` is legal even though the name "exists": it is
  // the same item, and TFVC records the change of case (R4).
  const lower = name.toLowerCase();
  if (lower === current.toLowerCase()) return undefined;
  if (siblings.some((s) => s.toLowerCase() === lower)) return S.fileOpsBadNameTaken(name);
  return undefined;
}

/**
 * The path `oldPath` would have if its last segment were `newName`. Written
 * without `node:path`: local paths are `C:\...` on Windows and `/home/...`
 * under Wine, and `win32.join` would put a backslash in a Linux path.
 */
export function renamedPath(oldPath: string, newName: string): string {
  const trimmed = oldPath.replace(/[\\/]+$/, '');
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return cut < 0 ? newName : `${trimmed.slice(0, cut + 1)}${newName}`;
}

/** The last segment, whichever separator the path uses, ignoring a trailing one. */
export function nameOfPath(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return cut < 0 ? trimmed : trimmed.slice(cut + 1);
}
