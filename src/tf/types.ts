/** A single flag from the space-separated `chg` attribute. */
export type ChangeFlag =
  | 'Add' | 'Edit' | 'Encoding' | 'Delete' | 'Rename'
  | 'Branch' | 'Merge' | 'Lock' | 'Undelete' | 'Rollback' | 'SourceRename';

/** Sentinel values that appear in the `enc` attribute instead of a code page. */
export const ENC_BINARY = -1;
export const ENC_NOT_APPLICABLE = -3;

export interface PendingChange {
  /** `$/Project/path/file.cs` */
  serverItem: string;
  /** `C:\work\...` on Windows, `Z:\home\shax\work\...` on Fedora. */
  localPath: string;
  /** Parsed from `chg`, which is a space-separated flag SET, not an enum. */
  changes: ReadonlySet<ChangeFlag>;
  /** The `chgEx` bitmask. Add=1, Edit=2, Encoding=4. */
  changeFlags: number;
  itemType: 'File' | 'Folder';
  /** `enc`. A code page, or ENC_BINARY, or ENC_NOT_APPLICABLE. */
  encoding: number;
  /** `ver`. ABSENT on pending Adds — they have no server baseline. */
  version?: number;
  /** `itemid`. Negative for pending Adds. */
  itemId: number;
  /** `date`, as the ISO string from the XML. Never parsed from text output. */
  date: string;
  /** `len`. Absent on folders. */
  length?: number;
}

/**
 * A pending change with the `PendingSet` it came from -- `status /user:*`
 * lists every workspace's changes (phase 3 part 2 design Q5), and the
 * Source Control Explorer's User column needs to say whose each one is.
 */
export interface OwnedPendingChange extends PendingChange {
  /** `ownerdisp`: a display name, e.g. "Boris". */
  owner: string;
  /** `computer`, e.g. "BORIS". */
  computer: string;
  /** The workspace `name`, e.g. "BORIS". */
  workspace: string;
}

export interface WorkingFolder {
  /** `C:\work` or `Z:\home\shax\work` */
  localPath: string;
  /** `$/` or `$/Vesta/DatabaseFirst/Insight.Database` */
  serverItem: string;
}

export interface WorkspaceInfo {
  name: string;
  computer: string;
  /** `ownerdisp`, e.g. "Filip". Shown in the Manage Workspace title. */
  owner?: string;
  /**
   * `<OwnerAliases>`: every name tf knows this workspace's owner by (an account,
   * a display name). Phase 4 uses them to tell the user's own shelvesets from a
   * colleague's. Optional so hand-built test values need not list any.
   */
  ownerAliases?: string[];
  folders: WorkingFolder[];
}

/** True when the item is binary and must not be text-diffed. */
export function isBinary(change: PendingChange): boolean {
  return change.encoding === ENC_BINARY;
}

/** True when the change is a pending Add, which has no server baseline. */
export function isPendingAdd(change: PendingChange): boolean {
  return change.changes.has('Add');
}
