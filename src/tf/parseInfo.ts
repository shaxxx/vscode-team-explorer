/**
 * `tf vc info '<folder>/*'` (phase 3 part 2 design Q2, Q3, Q8; fixtures README
 * finding 26). Text only on this client. One block per item: a
 * `Local information:` half, then a `Server information:` half, each line
 * `  Key : value` with the key padded -- and a value can itself contain `:`
 * (a Windows path, a time of day), so only the FIRST colon after the key
 * separates them.
 *
 * The folder itself comes back as one more block whose SERVER half is empty;
 * it is skipped. An item mapped but never downloaded, and an item outside
 * every mapping, both have an empty LOCAL half -- `info` cannot tell those two
 * apart (Q8), so this does not try; the explorer decides "not mapped" from the
 * mappings.
 *
 * `Last modified` is localized (Croatian on DEVPC, English under Wine) and is
 * kept verbatim, never parsed (design X6, as parseHistory.ts does).
 */
export interface InfoItem {
  serverPath: string;
  type: 'file' | 'folder';
  /** tf's own form (`Z:\...` under Wine). Absent when the local half is empty. */
  localPath?: string;
  /** Absent when the local half is empty: not downloaded, or not mapped (Q3, Q8). */
  localChangeset?: number;
  /** The local half's `Change`, e.g. `none` or `edit`; '' when the local half is empty. */
  localChange: string;
  serverChangeset: number;
  lock: string;
  /** Verbatim and localized (Q4). */
  lastModified: string;
  /** Files only. */
  fileType?: string;
  /** Files only. */
  size?: number;
}

/** `  Local path : C:\x` -> [`Local path`, `C:\x`]. Keys are letters and spaces only. */
const LINE = /^\s+([A-Za-z][A-Za-z ]*?)\s*:\s?(.*)$/;

export function parseInfo(text: string): InfoItem[] {
  const items: InfoItem[] = [];
  let half: 'local' | 'server' | undefined;
  let local: Record<string, string> = {};
  let server: Record<string, string> = {};

  const flush = (): void => {
    if (half !== undefined) {
      const item = toItem(local, server);
      if (item) items.push(item);
    }
    half = undefined;
    local = {};
    server = {};
  };

  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('Local information:')) {
      flush();
      half = 'local';
      continue;
    }
    if (line.startsWith('Server information:')) {
      half = 'server';
      continue;
    }
    if (half === undefined) continue;
    const m = LINE.exec(line);
    if (!m) continue;
    (half === 'local' ? local : server)[m[1]] = m[2].trim();
  }
  flush();
  return items;
}

function toItem(local: Record<string, string>, server: Record<string, string>): InfoItem | undefined {
  const serverPath = server['Server path'] ?? '';
  // The folder's own block (Q2): nothing on the server side to show.
  if (serverPath === '') return undefined;

  const serverChangeset = Number(server['Changeset']);
  if (!Number.isInteger(serverChangeset)) {
    throw new Error(`info: the server changeset of ${serverPath} is not a number: ${server['Changeset'] ?? '(missing)'}`);
  }

  const localPath = local['Local path'] ?? '';
  const item: InfoItem = {
    serverPath,
    type: server['Type'] === 'folder' ? 'folder' : 'file',
    localChange: localPath === '' ? '' : (local['Change'] ?? ''),
    serverChangeset,
    lock: server['Lock'] ?? '',
    lastModified: server['Last modified'] ?? '',
  };
  if (localPath !== '') {
    item.localPath = localPath;
    const localChangeset = Number(local['Changeset']);
    if (Number.isInteger(localChangeset) && localChangeset > 0) item.localChangeset = localChangeset;
  }
  if (server['File type']) item.fileType = server['File type'];
  if (server['Size']) {
    const size = Number(server['Size']);
    if (Number.isFinite(size)) item.size = size;
  }
  return item;
}
