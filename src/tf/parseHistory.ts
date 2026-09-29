/**
 * `tf vc history /format:detailed` -> changesets.
 *
 * Text, because history has no XML form (TF10120, test/fixtures/README.md
 * finding 7), and `brief` truncates comments to its column width. Written
 * against the real captures in test/fixtures/{windows,fedora}/ (findings
 * 20-23), not against a description of them.
 *
 * Three things the captures showed that a line regex alone gets wrong:
 *  - comment lines and item lines are BOTH indented two spaces, and a
 *    comment can itself contain "$/..." (finding 22), so the section a line
 *    is in decides what it is;
 *  - a deleted item prints its deletion id, "$/a/b.sln;X703";
 *  - the change column is padded to the widest entry in the record
 *    ("rename                $/...").
 *
 * Dates are kept VERBATIM and never parsed: the same changeset prints
 * "13. veljače 2026. 15:53:13" on DEVPC and "Friday, February 13, 2026
 * 3:53:13 PM" on FEDORA (finding 13). Order comes from changeset numbers.
 */

export interface HistoryItem {
  /** "merge, edit" -> ["merge", "edit"]. Open vocabulary: an unknown word is kept, not dropped. */
  change: string[];
  /** As printed, without a ";X<n>" deletion suffix. */
  serverPath: string;
  /** 703 for "...;X703". Present only on items tf printed as deleted. */
  deletionId?: number;
}

export interface Changeset {
  id: number;
  user: string;
  /** Verbatim. NEVER parse this. */
  date: string;
  /** Lines joined with "\n", the two-space indent removed, trailing blank lines dropped. */
  comment: string;
  items: HistoryItem[];
}

export interface HistoryParse {
  changesets: Changeset[];
  /** The first line of each record that had no readable "Changeset:" line. */
  skipped: string[];
}

/** tf prints 79; anything this long at column 0 is a record boundary. */
const SEPARATOR = /^-{20,}$/;
const INDENT = '  ';
const NO_ENTRIES = 'No history entries were found';

type Section = 'header' | 'comment' | 'items' | 'other';

export function parseHistory(text: string): HistoryParse {
  const records: string[][] = [];
  const preamble: string[] = [];
  let current: string[] | undefined;

  for (const line of text.split(/\r?\n/)) {
    if (SEPARATOR.test(line)) {
      current = [];
      records.push(current);
    } else if (current) {
      current.push(line);
    } else {
      preamble.push(line);
    }
  }

  const changesets: Changeset[] = [];
  const skipped: string[] = [];
  for (const lines of records) {
    const parsed = parseRecord(lines);
    if (parsed) changesets.push(parsed);
    else skipped.push(firstNonBlank(lines) ?? '');
  }

  // No record at all is either tf's empty-range sentence (exit 0, stdout,
  // design F13) or output this parser does not know. Only the second is worth
  // reporting; the caller decides what to do with it.
  if (records.length === 0) {
    const first = firstNonBlank(preamble);
    if (first !== undefined && !first.startsWith(NO_ENTRIES)) skipped.push(first);
  }

  return { changesets, skipped };
}

function parseRecord(lines: readonly string[]): Changeset | undefined {
  let id: number | undefined;
  let user = '';
  let date = '';
  const comment: string[] = [];
  const items: HistoryItem[] = [];
  let section: Section = 'header';

  for (const line of lines) {
    if (line.startsWith(INDENT)) {
      const body = line.slice(INDENT.length);
      if (section === 'comment') comment.push(body);
      else if (section === 'items') {
        const item = parseItem(body);
        if (item) items.push(item);
      }
      continue;
    }
    if (line.trim() === '') continue;

    // A column-0 line is a header field or a section heading.
    const field = /^([^:]+):\s?(.*)$/.exec(line);
    if (!field) continue;
    const [, name, value] = field;
    if (name === 'Changeset') {
      const n = Number(value.trim());
      if (Number.isInteger(n) && n > 0) id = n;
      section = 'header';
    } else if (name === 'User') {
      user = value.trim();
      section = 'header';
    } else if (name === 'Date') {
      date = value.trim();
      section = 'header';
    } else if (name === 'Comment') {
      section = 'comment';
    } else if (name === 'Items') {
      section = 'items';
    } else {
      // "Check-in Notes:", "Policy Warnings:" and anything else: not ours to read.
      section = 'other';
    }
  }

  if (id === undefined) return undefined;
  while (comment.length > 0 && comment[comment.length - 1].trim() === '') comment.pop();
  return { id, user, date, comment: comment.map((l) => l.trimEnd()).join('\n'), items };
}

function parseItem(body: string): HistoryItem | undefined {
  // A path segment cannot start with "$", so the first " $/" is where the
  // path begins, however wide the padded change column is.
  const at = body.indexOf(' $/');
  if (at < 0) return undefined;
  const change = body
    .slice(0, at)
    .split(',')
    .map((w) => w.trim())
    .filter((w) => w !== '');
  if (change.length === 0) return undefined;

  let serverPath = body.slice(at + 1).trimEnd();
  const deleted = /^(.*);X(\d+)$/.exec(serverPath);
  if (!deleted) return { change, serverPath };
  serverPath = deleted[1];
  return { change, serverPath, deletionId: Number(deleted[2]) };
}

function firstNonBlank(lines: readonly string[]): string | undefined {
  return lines.find((l) => l.trim() !== '')?.trim();
}
