import { win32 } from 'node:path';
import type { WorkingFolder, WorkspaceInfo } from '../tf/types.js';

/** A proposed working folder. `localPath` is a tf path (`C:\...`, `Z:\...`). */
export interface MappingProposal {
  serverItem: string;
  localPath: string;
}

export type MappingVerdict =
  | { kind: 'ok' }
  /** R1 / M1: the server path is already mapped in this workspace - explicitly, or
   *  implicitly through an ancestor mapping; `/map` would relocate it (P3). */
  | { kind: 'move'; from: string }
  /** R1 (same pair) or R4: the pair matches where the server path already sits;
   *  tf would drop it silently (P4). */
  | { kind: 'redundant'; parent: WorkingFolder }
  | {
      kind: 'refuse';
      /** R2 / R3 and the cross-workspace overlap / R5. */
      reason: 'localInUse' | 'insideOther' | 'containsOther';
      mapping: WorkingFolder;
      workspace: string;
    };

/** Always removes a trailing separator, drive root or not - only safe for building a
 * NEW path (`base + '\\' + rest`), never for a key that will be compared or `startsWith`-checked. */
const stripTrailingSeparators = (p: string) => p.replace(/[\\/]+$/, '');

/**
 * tf compares local paths case-insensitively on both machines, Wine included
 * (M3): `/` becomes `\`, then `path.win32.normalize` resolves `.`/`..` and
 * doubled separators, then trailing separators are stripped - EXCEPT a bare
 * drive root (`D:\`), where stripping would turn it into `D:`, a different
 * (drive-relative) path, and break every `startsWith` containment check below.
 */
const localKey = (p: string): string => {
  const normalized = win32.normalize(p.replace(/\//g, '\\'));
  const isDriveRoot = /^[A-Za-z]:\\$/.test(normalized);
  return (isDriveRoot ? normalized : stripTrailingSeparators(normalized)).toLowerCase();
};

/** tf compares server paths case-insensitively too; `$/` is kept as-is (it already
 * "ends" the root), anything else has its trailing slash(es) stripped. */
const serverKey = (p: string) => (p === '$/' ? '$/' : p.replace(/\/+$/, '')).toLowerCase();

/** True when `child` is strictly inside `parent` (both already `localKey`-normalized).
 * `parent` may itself be a bare drive root, which already ends in `\`. */
const inside = (child: string, parent: string): boolean => {
  if (child === parent) return false;
  const prefix = parent.endsWith('\\') ? parent : `${parent}\\`;
  return child.startsWith(prefix);
};

/** The part of `childKey` after `ancestorKey` (both already `localKey`-normalized,
 * `ancestorKey` a real or self ancestor of `childKey`). */
const localRelative = (childKey: string, ancestorKey: string): string => {
  const skip = ancestorKey.endsWith('\\') ? ancestorKey.length : ancestorKey.length + 1;
  return childKey.slice(skip);
};

/** True when `ancestorKey` (already `serverKey`-normalized) is `key` itself or a
 * real ancestor of it, with a `/` boundary - `$/shop` is not an ancestor of `$/shop2023`. */
const isAncestorOrSelf = (ancestorKey: string, key: string): boolean =>
  ancestorKey === key || ancestorKey === '$/' || key.startsWith(`${ancestorKey}/`);

/** The part of the ORIGINAL (uncased) `serverItem` after `ancestorKey` (already
 * `serverKey`-normalized, a real ancestor of it) - preserves the proposal's own
 * casing for messages and reconstructed paths. */
const serverRelativeOriginal = (serverItem: string, ancestorKey: string): string => {
  const trimmed = serverItem.replace(/\/+$/, '');
  const skip = ancestorKey.endsWith('/') ? ancestorKey.length : ancestorKey.length + 1;
  return trimmed.slice(skip);
};

/** The server path a folder `rel` levels below a mapping's local folder would have.
 * `server` is normalized with `serverKey` FIRST (M6) so a trailing slash on it
 * (e.g. the proposal's own `serverItem`) can never produce a `//` in the middle. */
const childServer = (server: string, rel: string): string => {
  const base = serverKey(server);
  const relSlashed = rel.replace(/\\/g, '/');
  return serverKey(base === '$/' ? `$/${relSlashed}` : `${base}/${relSlashed}`);
};

/** The deepest folder whose server path is `serverItem` itself or an ancestor of it. */
const findCovering = (serverItem: string, folders: readonly WorkingFolder[]): WorkingFolder | undefined => {
  const S = serverKey(serverItem);
  let best: WorkingFolder | undefined;
  let bestLen = -1;
  for (const f of folders) {
    const Fs = serverKey(f.serverItem);
    if (isAncestorOrSelf(Fs, S) && Fs.length > bestLen) {
      best = f;
      bestLen = Fs.length;
    }
  }
  return best;
};

/** The tf-form local path `serverItem` maps to right now, given `covering` (the
 * folder `findCovering` chose for it): its own folder when it IS `covering`,
 * otherwise `covering`'s folder plus the remaining segments. */
const resolveVia = (serverItem: string, covering: WorkingFolder): string => {
  const coveringKey = serverKey(covering.serverItem);
  if (coveringKey === serverKey(serverItem)) return covering.localPath;
  const rel = serverRelativeOriginal(serverItem, coveringKey).replace(/\//g, '\\');
  return `${stripTrailingSeparators(covering.localPath)}\\${rel}`;
};

/**
 * The tf-form local path `serverItem` maps to right now, given one workspace's
 * `folders`: the DEEPEST folder whose server path is `serverItem` itself or an
 * ancestor of it (design P3: tf resolves a path through whichever mapping
 * covers it, not only an explicit entry for it), with the remaining segments
 * appended. Undefined when nothing in `folders` covers it.
 */
export function whereMapped(serverItem: string, folders: readonly WorkingFolder[]): string | undefined {
  const covering = findCovering(serverItem, folders);
  return covering ? resolveVia(serverItem, covering) : undefined;
}

/**
 * The checks tf does not make. `target` is the workspace being
 * changed; `all` is every workspace on this computer (it may include `target`).
 */
export function checkMapping(p: MappingProposal, target: WorkspaceInfo, all: readonly WorkspaceInfo[]): MappingVerdict {
  const L = localKey(p.localPath);
  const S = serverKey(p.serverItem);
  const others = all.filter((w) => w.name.toLowerCase() !== target.name.toLowerCase());

  const sameServer = target.folders.find((f) => serverKey(f.serverItem) === S);
  const mine = target.folders.filter((f) => f !== sameServer);

  // R2, this workspace
  for (const f of mine) {
    if (localKey(f.localPath) === L) return { kind: 'refuse', reason: 'localInUse', mapping: f, workspace: target.name };
  }
  // R2 and any overlap, other workspaces: a local folder belongs to one workspace only.
  for (const w of others) {
    for (const f of w.folders) {
      const Lf = localKey(f.localPath);
      if (Lf === L) return { kind: 'refuse', reason: 'localInUse', mapping: f, workspace: w.name };
      if (inside(L, Lf)) return { kind: 'refuse', reason: 'insideOther', mapping: f, workspace: w.name };
      if (inside(Lf, L)) return { kind: 'refuse', reason: 'containsOther', mapping: f, workspace: w.name };
    }
  }

  // R3: the deepest mapping of this workspace whose folder contains L must agree on the server path.
  const parent = mine
    .filter((f) => inside(L, localKey(f.localPath)))
    .sort((a, b) => localKey(b.localPath).length - localKey(a.localPath).length)[0];
  if (parent) {
    const rel = localRelative(L, localKey(parent.localPath));
    if (childServer(parent.serverItem, rel) !== S) {
      return { kind: 'refuse', reason: 'insideOther', mapping: parent, workspace: target.name };
    }
  }

  // R5: every mapping inside L must be L's own corresponding child (a child override).
  for (const f of mine) {
    const Lf = localKey(f.localPath);
    if (inside(Lf, L) && childServer(p.serverItem, localRelative(Lf, L)) !== serverKey(f.serverItem)) {
      return { kind: 'refuse', reason: 'containsOther', mapping: f, workspace: target.name };
    }
  }

  // R1 / M1: where the server path actually lives right now - through an explicit
  // entry here, or through whichever ancestor mapping covers it (P3: tf relocates
  // it silently either way, so this is never a fresh, unrelated "ok" add).
  const covering = findCovering(p.serverItem, target.folders);
  if (!covering) return { kind: 'ok' };
  const now = resolveVia(p.serverItem, covering);
  return localKey(now) === L ? { kind: 'redundant', parent: covering } : { kind: 'move', from: now };
}
