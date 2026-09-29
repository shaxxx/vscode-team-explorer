/**
 * `tf vc dir $/<path>` is text only on this client (fixtures README, finding
 * 15: byte-identical on both machines). First line `$/path:`, then one line
 * per item -- a folder as `$Name`, a file as `Name` -- a blank line, and
 * `N item(s)`.
 */
export interface DirListing {
  path: string;
  folders: string[];
  files: string[];
}

export function parseDir(text: string): DirListing {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() !== '');
  const header = start >= 0 ? lines[start] : undefined;
  if (!header || !header.startsWith('$/') || !header.endsWith(':')) {
    throw new Error(`not a dir listing: ${header ?? '(empty)'}`);
  }
  const listing: DirListing = { path: header.slice(0, -1), folders: [], files: [] };
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '') continue;
    if (/^\d+ item\(s\)$/.test(line.trim())) break;
    if (line.startsWith('$')) listing.folders.push(line.slice(1));
    else listing.files.push(line);
  }
  return listing;
}
