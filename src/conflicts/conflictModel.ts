import type { InfoItem } from '../tf/parseInfo.js';
import type { Platform } from '../tf/PathMapper.js';
import type { AutoResolution } from './resolveArgs.js';

/**
 * Phase 5's decisions, with no `vscode` and no tf: which
 * family a conflict is, what its row offers, which conflicts lie under the
 * paths phase 4 names, and what the Resolve Conflicts page may ask for.
 */

/** version: the item has a pending change. blocked: a local file is in the way and nothing is pending. */
export type ConflictFamily = 'version' | 'blocked' | 'unknown';

/** A listed conflict, located by ConflictService from tf's path and the mapper. */
export interface LocatedConflict {
  /** Native: `C:\…` on Windows, `/home/…` on Linux. What VS Code opens. */
  localPath: string;
  /** tf's own form of the same path (`Z:\…` under Wine). Every itemspec uses it. */
  tfPath: string;
  /** Undefined when no mapping covers the path. */
  serverPath: string | undefined;
  /** tf's sentence, verbatim. Shown, never read. */
  reason: string;
  /**
   * tf named it by `$/` path: it has no local item, so an empty local half
   * in `info` does not mean a file is in the way.
   */
  listedByServerPath?: boolean;
}

export interface Conflict extends LocatedConflict {
  family: ConflictFamily;
  /** The changeset the local file came from: `info`'s local half. */
  base: number | undefined;
  /** The server's latest: `info`'s server half. */
  theirs: number | undefined;
  /** tf types the file `Binary`, so tf cannot merge it. */
  binary: boolean;
}

/**
 * What a row can offer. The three compares are Visual Studio's
 * Compare drop-down: Local and Server (`compare`, the default), Server and
 * Base, Local and Base.
 */
export type ConflictAction =
  | 'compare'
  | 'compareServerBase'
  | 'compareLocalBase'
  | 'autoMerge'
  | 'takeTheirs'
  | 'keepYours'
  | 'mergeManually'
  | 'overwriteLocal';

/** The merging state's own two buttons (Merge manually). */
export type MergeAction = 'resolved' | 'cancelMerge';

/** The row actions that ARE a tf resolution. */
export const RESOLUTION_OF: Readonly<Partial<Record<ConflictAction, AutoResolution>>> = {
  autoMerge: 'AutoMerge',
  takeTheirs: 'TakeTheirs',
  keepYours: 'KeepYours',
  overwriteLocal: 'OverwriteLocal',
};

/**
 * From `info`'s local half (C5), never from tf's reason, which tf localises.
 * A pending change there makes it a version conflict; `none`, or a local half
 * with nothing in it (a file that was never downloaded), makes it blocked.
 */
export function familyOf(info: InfoItem | undefined): ConflictFamily {
  if (!info) return 'unknown';
  const change = info.localChange.trim().toLowerCase();
  return change === '' || change === 'none' ? 'blocked' : 'version';
}

/**
 * The family of one listed conflict. Beyond `familyOf`: a conflict tf named
 * by server path has no local item, so it is never "blocked"; and a pending
 * change whose version IS the server's latest cannot be in conflict with the
 * server -- the other side is something else, a shelveset being unshelved
 * (seam S7) or a merge -- so the server-worded buttons and confirms would
 * describe the wrong loss.
 */
function familyFor(l: LocatedConflict, info: InfoItem | undefined): ConflictFamily {
  if (l.listedByServerPath) return 'unknown';
  const family = familyOf(info);
  if (family === 'version' && info?.localChangeset !== undefined && info.localChangeset === info.serverChangeset) {
    return 'unknown';
  }
  return family;
}

/**
 * Joins the listing to `info` by the path `info` was asked about (every call
 * names `tfPath`), and failing that by SERVER path: a blocked file's `info`
 * has no local path at all (C5), and a pending rename's server half still
 * carries the old name. A path tf printed twice (overlapping roots) is listed
 * once.
 */
export function buildConflicts(
  located: readonly LocatedConflict[],
  infos: readonly InfoItem[],
  keyOf: (localPath: string) => string,
): Conflict[] {
  const byLocal = new Map(
    infos.filter((i) => i.localPath !== undefined).map((i) => [keyOf(i.localPath as string), i]),
  );
  const byServer = new Map(infos.map((i) => [i.serverPath.toLowerCase(), i]));
  const seen = new Set<string>();
  const out: Conflict[] = [];
  for (const l of located) {
    const key = keyOf(l.localPath);
    if (seen.has(key)) continue;
    seen.add(key);
    const info =
      byLocal.get(keyOf(l.tfPath)) ?? (l.serverPath === undefined ? undefined : byServer.get(l.serverPath.toLowerCase()));
    out.push({
      ...l,
      family: familyFor(l, info),
      base: info?.localChangeset,
      theirs: info?.serverChangeset,
      binary: info?.fileType?.toLowerCase() === 'binary',
    });
  }
  return out;
}

/** The buttons a row shows. Compare needs a server path and a changeset to compare with. */
export function actionsFor(c: Conflict): ConflictAction[] {
  if (c.family === 'unknown') return ['autoMerge', 'takeTheirs', 'keepYours', 'overwriteLocal'];
  const canCompare = c.serverPath !== undefined && c.theirs !== undefined;
  const out: ConflictAction[] = [];
  if (canCompare) out.push('compare');
  if (c.family === 'blocked') {
    out.push('overwriteLocal');
    return out;
  }
  if (canCompare && c.base !== undefined) out.push('compareServerBase');
  if (c.serverPath !== undefined && c.base !== undefined) out.push('compareLocalBase');
  if (!c.binary) out.push('autoMerge');
  out.push('takeTheirs', 'keepYours');
  if (canCompare) out.push('mergeManually');
  return out;
}

/**
 * The conflicts at or under any of `serverRoots`, compared the way TFVC
 * compares server paths (case-insensitively). No roots means all of them:
 * the seam's "absent or empty".
 */
export function conflictsUnder(conflicts: readonly Conflict[], serverRoots: readonly string[]): Conflict[] {
  if (serverRoots.length === 0) return [...conflicts];
  const roots = serverRoots.map((r) => r.replace(/\/+$/, '').toLowerCase());
  const under = conflicts.filter((c) => {
    if (c.serverPath === undefined) return false;
    const p = c.serverPath.toLowerCase();
    return roots.some((r) => r === '$' || p === r || p.startsWith(`${r}/`));
  });
  // One no mapping places may well be under the roots: counted, never left out,
  // since a 0 lets phase 4 delete the shelveset after an unshelve. After
  // the placed ones, so the tab opens on a conflict that is known to be there.
  return [...under, ...conflicts.filter((c) => c.serverPath === undefined)];
}

/** A native path's name and folder. Only Windows also splits on `/`: a Linux name may contain `\`. */
export function nameAndFolder(localPath: string, platform: Platform): { name: string; folder: string } {
  const at =
    platform === 'win32'
      ? Math.max(localPath.lastIndexOf('\\'), localPath.lastIndexOf('/'))
      : localPath.lastIndexOf('/');
  return at < 0 ? { name: localPath, folder: '' } : { name: localPath.slice(at + 1), folder: localPath.slice(0, at) };
}

export type ConflictIntent =
  | { type: 'ready' }
  | { type: 'refresh' }
  | { type: 'autoMergeAll' }
  | { type: 'select'; key: string }
  | { type: 'act'; key: string; action: ConflictAction | MergeAction };

const ACTS: ReadonlySet<string> = new Set([
  'compare', 'compareServerBase', 'compareLocalBase', 'autoMerge', 'takeTheirs', 'keepYours', 'mergeManually', 'overwriteLocal',
  'resolved', 'cancelMerge',
]);
/** No local path is longer; a longer "key" is not a row. */
const MAX_KEY = 4096;

/** The only messages the Resolve Conflicts page may send (phase5Safety pins the page to exactly these). */
export function parseConflictIntent(raw: unknown): ConflictIntent | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const m = raw as Record<string, unknown>;
  const key = typeof m.key === 'string' && m.key.length <= MAX_KEY ? m.key : undefined;
  switch (m.type) {
    case 'ready':
      return { type: 'ready' };
    case 'refresh':
      return { type: 'refresh' };
    case 'autoMergeAll':
      return { type: 'autoMergeAll' };
    case 'select':
      return key === undefined ? undefined : { type: 'select', key };
    case 'act':
      return key === undefined || typeof m.action !== 'string' || !ACTS.has(m.action)
        ? undefined
        : { type: 'act', key, action: m.action as ConflictAction | MergeAction };
    default:
      return undefined;
  }
}

/** What a row's buttons do. `commands/conflicts.ts` implements it: tf, dialogs and editors live there. */
export interface ConflictActions {
  /** Local and Server: the server's version against the real, editable file. */
  compare(c: Conflict): Promise<void>;
  /** Server and Base: what the server changed since the version the edit started from. */
  compareServerBase(c: Conflict): Promise<void>;
  /** Local and Base: what the edit changed. */
  compareLocalBase(c: Conflict): Promise<void>;
  /** Asks first when the resolution is destructive; resolves to whether tf resolved it. */
  resolve(c: Conflict, how: AutoResolution): Promise<boolean>;
  /** Merge manually's Resolved: save, confirm, Keep Yours. Resolves to whether it was marked. */
  markMerged(c: Conflict): Promise<boolean>;
  autoMergeAll(): Promise<void>;
  refresh(): Promise<void>;
}
