import { XMLParser } from 'fast-xml-parser';
import type { WorkspaceInfo, WorkingFolder, PendingChange, ChangeFlag, OwnedPendingChange } from './types.js';

/**
 * tf.exe writes UTF-8 to a redirected stdout, but emits NO <?xml?> declaration,
 * so a parser gets no encoding hint. Decode explicitly.
 */
function decode(xml: Buffer): string {
  return xml.toString('utf8');
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  // An owner alias that looks like a number ("007", "1e3") must stay text.
  parseTagValue: false,
  // A single child element must still come back as an array.
  isArray: (name) => ['Workspace', 'WorkingFolder', 'PendingSet', 'PendingChange'].includes(name),
});

function toArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * Whether a `WorkingFolder` is a real mapping rather than a CLOAK.
 *
 * `tf vc workfold /cloak serverfolder` takes no local folder — a cloak says
 * "this subtree is NOT in my workspace", so there is nothing for it to map to.
 * Every entry was being turned into a mapping regardless, and
 * `String(f['@_local'])` on a missing attribute yields the literal string
 * `"undefined"`.
 *
 * That is not inert. PathMapper picks the LONGEST matching server item, and a
 * cloak is by definition deeper than the mapping it sits inside — so
 * `toLocalPath('$/Shop/bin/x.dll')` under a cloaked `$/Shop/bin` would match
 * the cloak and answer `undefined\x.dll`. A path that is in the workspace and a
 * path that was explicitly excluded from it would both get an answer, and one
 * of them would be fiction.
 *
 * Two independent guards, because the exact XML spelling of a cloak is
 * UNVERIFIED — neither workspace on either machine has one, so there is no
 * captured fixture, only a synthetic. The `type` check is what the client
 * object model implies (`Map` / `Cloak`); the local/item check is true
 * regardless of how tf spells it, and is what actually carries this today.
 */
function isRealMapping(f: any): boolean {
  const type = f?.['@_type'];
  if (typeof type === 'string' && type.toLowerCase() !== 'map') return false;

  const local = f?.['@_local'];
  const item = f?.['@_item'];
  return typeof local === 'string' && local !== '' && typeof item === 'string' && item !== '';
}

export function parseWorkspaces(xml: Buffer): WorkspaceInfo[] {
  const doc = parser.parse(decode(xml));
  const workspaces = toArray(doc?.Workspaces?.Workspace);

  return workspaces.map((ws: any): WorkspaceInfo => {
    const folders: WorkingFolder[] = toArray(ws?.Folders?.WorkingFolder)
      .filter(isRealMapping)
      .map((f: any) => ({
        localPath: String(f['@_local']),
        serverItem: String(f['@_item']),
      }));
    return {
      name: String(ws['@_name']),
      computer: String(ws['@_computer']),
      owner: ws['@_ownerdisp'] === undefined ? undefined : String(ws['@_ownerdisp']),
      ownerAliases: toArray(ws?.OwnerAliases?.string)
        .map((a: unknown) => String(a))
        .filter((a: string) => a !== ''),
      folders,
    };
  });
}

const KNOWN_FLAGS: ReadonlySet<string> = new Set<ChangeFlag>([
  'Add', 'Edit', 'Encoding', 'Delete', 'Rename',
  'Branch', 'Merge', 'Lock', 'Undelete', 'Rollback', 'SourceRename',
]);

/**
 * `chg` is a SPACE-SEPARATED FLAG SET, e.g. "Add Edit Encoding" — not an enum.
 * Unknown flags are ignored rather than throwing, so a future tf.exe adding a
 * flag degrades instead of breaking.
 */
export function parseChangeFlags(chg: string): Set<ChangeFlag> {
  const flags = new Set<ChangeFlag>();
  for (const token of chg.split(' ')) {
    if (KNOWN_FLAGS.has(token)) flags.add(token as ChangeFlag);
  }
  return flags;
}

function optionalInt(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  return Number.isNaN(n) ? undefined : n;
}

/** The `<PendingSet>` elements of a `status` answer, each with its raw `<PendingChange>` elements. */
function pendingSets(xml: Buffer): { set: Record<string, unknown>; changes: unknown[] }[] {
  const doc = parser.parse(decode(xml));

  // `<Status />` parses to an empty string or empty object. Either means "nothing pending".
  const status = doc?.Status;
  if (!status || typeof status !== 'object') return [];

  return toArray(status.PendingSet).map((set) => ({
    set: (set ?? {}) as Record<string, unknown>,
    changes: toArray((set as any)?.PendingChanges?.PendingChange),
  }));
}

function toPendingChange(pc: unknown): PendingChange {
  const c = pc as any;
  return {
    serverItem: String(c['@_item']),
    localPath: String(c['@_local']),
    changes: parseChangeFlags(String(c['@_chg'] ?? '')),
    changeFlags: Number(c['@_chgEx'] ?? 0),
    itemType: c['@_type'] === 'Folder' ? 'Folder' : 'File',
    encoding: Number(c['@_enc'] ?? 0),
    version: optionalInt(c['@_ver']),
    itemId: Number(c['@_itemid'] ?? 0),
    date: String(c['@_date'] ?? ''),
    length: optionalInt(c['@_len']),
  };
}

export function parseStatus(xml: Buffer): PendingChange[] {
  return pendingSets(xml).flatMap((s) => s.changes.map(toPendingChange));
}

/**
 * `status <itemspec> /user:* /format:xml` (phase 3 part 2 design Q5): every
 * change, with the `PendingSet` it came from. tf's notice about `/user` goes to
 * stderr (fixtures README finding 26), so stdout parses as it is.
 */
export function parseStatusOwned(xml: Buffer): OwnedPendingChange[] {
  return pendingSets(xml).flatMap((s) =>
    s.changes.map((pc) => ({
      ...toPendingChange(pc),
      owner: String(s.set['@_ownerdisp'] ?? ''),
      computer: String(s.set['@_computer'] ?? ''),
      workspace: String(s.set['@_name'] ?? ''),
    })),
  );
}
