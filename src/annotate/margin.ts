import type { Changeset } from '../tf/parseHistory.js';
import type { Owner } from './blame.js';
import type { VersionRef } from './walk.js';
import { S } from '../tf/strings.js';

/** CSS collapses ordinary spaces in a decoration's `contentText`; these it keeps. */
export const NBSP = String.fromCharCode(0xa0);

/**
 * Zero-width space (D11). Inserted after every `<` in server text handed to
 * the hover, because `appendText` does not escape `<` and text such as
 * `<command:teamExplorer.showChangeset?x>` would otherwise still read as a
 * Markdown autolink once it reaches the hover's Markdown renderer.
 */
const ZWSP = String.fromCharCode(0x200b);

function guardAutolinks(text: string): string {
  return text.replace(/</g, `<${ZWSP}`);
}

/** Long enough for a first name, short enough to leave room for the code. */
export const USER_WIDTH = 12;

/** The two commands a hover link may run (D7). Nothing else is trusted. */
export const SHOW_CHANGESET = 'teamExplorer.showChangeset';
export const COMPARE_VERSIONS = 'teamExplorer.compareVersions';

export function labelOf(owner: Owner, userOf: (id: number) => string | undefined): string {
  switch (owner.kind) {
    case 'changeset': {
      const user = (userOf(owner.id) ?? '').slice(0, USER_WIDTH);
      return user ? `${owner.id} ${user}` : String(owner.id);
    }
    case 'pending':
      return S.annotatePending;
    case 'atOrBefore':
      return S.annotateAtOrBefore(owner.id);
    case 'local':
      return S.annotateLocal;
  }
}

function sameOwner(a: Owner, b: Owner): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'changeset' || a.kind === 'atOrBefore') return a.id === (b as { id: number }).id;
  return true;
}

/**
 * True for the first line of a run of equal owners -- the only line whose
 * margin label is non-empty; the rest of the block reads blank, the way a
 * blame margin reads. (Formerly also the only line a decoration's
 * `hoverMessage` was put on -- D17a -- but D19b moved hovers to a
 * `HoverProvider` that answers for any line of a block, since decorations no
 * longer carry one at all: VS Code converts and serialises a `hoverMessage`
 * per decoration it is given, so putting one on every line of a 20,000-line
 * file cost ~0.55s and ~30MB per render for text that was blank on every line
 * but the first anyway.)
 */
export function isBlockStart(owners: readonly Owner[], i: number): boolean {
  return i === 0 || !sameOwner(owners[i], owners[i - 1]);
}

/**
 * One margin string per line. The first line of a run of equal owners carries
 * the label and the rest are blank, the way a blame reads; every string is
 * padded to the widest so the code after it lines up.
 */
export function marginLabels(owners: readonly Owner[], userOf: (id: number) => string | undefined): string[] {
  const raw = owners.map((o, i) => (isBlockStart(owners, i) ? labelOf(o, userOf) : ''));
  // reduce, not Math.max(...raw): a spread of a 200k-line file exceeds the
  // engine's argument limit.
  const width = raw.reduce((w, l) => Math.max(w, l.length), 0);
  return raw.map((l) => l.padEnd(width, NBSP));
}

export interface HoverLink {
  label: string;
  command: string;
  args: unknown[];
}

export interface HoverParts {
  /** Plain text: must reach the hover through appendText, never appendMarkdown. */
  heading: string;
  /** Plain text, the full comment. Same rule. */
  body: string;
  links: HoverLink[];
}

/**
 * What a margin hover says. Server text (user, date, comment) goes ONLY into
 * `heading` and `body`, which the caller adds as plain text; the links carry
 * our own labels and arguments.
 */
export function hoverParts(
  cs: Changeset,
  fileServerPath: string,
  current: VersionRef | undefined,
  previous: VersionRef | undefined,
): HoverParts {
  const links: HoverLink[] = [
    { label: S.annotateHoverDetails, command: SHOW_CHANGESET, args: [fileServerPath, cs.id] },
  ];
  if (current && previous) {
    links.push({
      label: S.annotateHoverCompare,
      command: COMPARE_VERSIONS,
      args: [previous.serverPath, previous.id, current.serverPath, current.id],
    });
  }
  return {
    heading: guardAutolinks(S.annotateHoverHeading(cs.id, cs.user, cs.date)),
    body: guardAutolinks(cs.comment),
    links,
  };
}

/**
 * A `command:` link target. encodeURIComponent leaves `(` and `)` alone, and a
 * `)` in a server path would end the Markdown link early, so those are encoded
 * too; VS Code decodes the whole query before parsing the JSON.
 *
 * VS Code's command opener actually decodes the query TWICE (`URI.parse`,
 * then `decodeURIComponent`) before `JSON.parse` (D11). A literal `%` in an
 * argument -- e.g. a path that really contains `%20` -- survives encoding and
 * one decode as a percent-escape-shaped substring, and the second decode then
 * misreads it as an escaped byte, corrupting the argument (a `%20` arriving
 * as a space). Replacing every `%` with the JSON string escape `%`
 * before encoding removes every raw `%` from the payload, so neither decode
 * can find anything of ours left to (mis)interpret; `JSON.parse` turns
 * `%` back into `%` once, at the end, same as any other JSON escape.
 */
export function commandLink(link: HoverLink): string {
  const json = JSON.stringify(link.args).replace(/%/g, '\\u0025');
  const args = encodeURIComponent(json).replace(/\(/g, '%28').replace(/\)/g, '%29');
  return `command:${link.command}?${args}`;
}
