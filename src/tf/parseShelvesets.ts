import { XMLParser } from 'fast-xml-parser';
import { parseChangeFlags } from './parse.js';
import type { ChangeFlag } from './types.js';

/** One row of `vc shelvesets /format:xml`. */
export interface Shelveset {
  name: string;
  /** `owner`: the account tf knows the owner by, e.g. an email. */
  owner: string;
  /** `ownerdisp`: the display name, e.g. "Filip". */
  ownerDisplay: string;
  /** `owneruniq`: what a `name;owner` itemspec takes (S18). */
  ownerUnique: string;
  /** `date`, the ISO string exactly as tf wrote it. */
  date: string;
  /** `<Comment>`, line breaks as `\n`; '' when there is none. */
  comment: string;
}

/**
 * One change inside a shelveset (S2b). A `PendingChange` element, but with no
 * `local`: a shelveset lives on the server, not in a workspace.
 */
export interface ShelvedChange {
  serverItem: string;
  /** `srcitem`: where a rename came FROM. */
  sourceItem?: string;
  changes: ReadonlySet<ChangeFlag>;
  itemType: 'File' | 'Folder';
  /** `enc`: a code page, or -1 for binary. */
  encoding: number;
  /** `ver`: the version it was shelved from. Absent on an add. */
  version?: number;
  itemId: number;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  // A comment of digits is text: "007" must not come back as the number 7.
  parseTagValue: false,
  isArray: (name) => ['Shelveset', 'PendingSet', 'PendingChange'].includes(name),
});

function text(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'object') return String((value as Record<string, unknown>)['#text'] ?? '');
  return String(value);
}

function optionalInt(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  return Number.isNaN(n) ? undefined : n;
}

/**
 * `vc shelvesets /format:xml`. Throws on anything that is not a listing, so a
 * mis-wired call can never read as "no shelvesets".
 */
export function parseShelvesets(xml: Buffer): Shelveset[] {
  const doc = parser.parse(xml.toString('utf8'));
  if (doc?.Shelvesets === undefined) throw new Error('tf did not answer with a shelveset listing.');
  const root = doc.Shelvesets;
  // `<Shelvesets />` parses to an empty string.
  if (!root || typeof root !== 'object') return [];
  return ((root.Shelveset ?? []) as Record<string, unknown>[]).map((s) => ({
    name: String(s['@_name'] ?? ''),
    owner: String(s['@_owner'] ?? ''),
    ownerDisplay: String(s['@_ownerdisp'] ?? ''),
    ownerUnique: String(s['@_owneruniq'] ?? s['@_owner'] ?? ''),
    date: String(s['@_date'] ?? ''),
    // tf writes the comment's own line breaks as CRLF (S2).
    comment: text(s.Comment).replace(/\r\n/g, '\n'),
  }));
}

/**
 * `vc status /shelveset:<name>;<owner> /format:xml /recursive` (S2b).
 *
 * Refuses a `PendingSet` that is not `type="Shelveset"`: a workspace's own
 * status has the same shape, and showing the user's pending changes as a
 * shelveset's would put the wrong files under Unshelve.
 */
export function parseShelvedChanges(xml: Buffer): ShelvedChange[] {
  const doc = parser.parse(xml.toString('utf8'));
  if (doc?.Status === undefined) throw new Error('tf did not answer with a status listing.');
  const status = doc.Status;
  if (!status || typeof status !== 'object') return [];
  const sets = (status.PendingSet ?? []) as Record<string, any>[];
  if (sets.some((set) => set['@_type'] !== 'Shelveset')) throw new Error('tf answered with pending changes, not a shelveset.');
  return sets.flatMap((set) => ((set.PendingChanges?.PendingChange ?? []) as Record<string, unknown>[]).map(toShelvedChange));
}

function toShelvedChange(c: Record<string, unknown>): ShelvedChange {
  const version = optionalInt(c['@_ver']);
  return {
    serverItem: String(c['@_item']),
    ...(c['@_srcitem'] !== undefined ? { sourceItem: String(c['@_srcitem']) } : {}),
    changes: parseChangeFlags(String(c['@_chg'] ?? '')),
    itemType: c['@_type'] === 'Folder' ? 'Folder' : 'File',
    encoding: Number(c['@_enc'] ?? 0),
    ...(version !== undefined ? { version } : {}),
    itemId: Number(c['@_itemid'] ?? 0),
  };
}
