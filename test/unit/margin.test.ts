import { describe, it, expect } from 'vitest';
import {
  labelOf,
  marginLabels,
  hoverParts,
  commandLink,
  NBSP,
  SHOW_CHANGESET,
  COMPARE_VERSIONS,
} from '../../src/annotate/margin.js';
import type { Owner } from '../../src/annotate/blame.js';
import { S } from '../../src/tf/strings.js';

const users: Record<number, string> = { 21082: 'Filip', 20545: 'Boris', 1: 'AVeryLongUserNameIndeed' };
const userOf = (id: number) => users[id];
const cs = (id: number): Owner => ({ kind: 'changeset', id });
const plain = (label: string) => label.split(NBSP).join(' ').trimEnd();

describe('margin labels', () => {
  it('labels a changeset with its number and user', () => {
    expect(labelOf(cs(21082), userOf)).toBe('21082 Filip');
  });

  it('truncates a long user name to 12 characters', () => {
    expect(labelOf(cs(1), userOf)).toBe('1 AVeryLongUse');
  });

  it('labels the other kinds with their own strings', () => {
    expect(labelOf({ kind: 'pending' }, userOf)).toBe(S.annotatePending);
    expect(labelOf({ kind: 'atOrBefore', id: 18544 }, userOf)).toBe('≤ C18544');
    expect(labelOf({ kind: 'local' }, userOf)).toBe(S.annotateLocal);
  });

  it('labels a run of equal owners once and pads every label so the code lines up', () => {
    const labels = marginLabels([cs(21082), cs(21082), cs(20545), { kind: 'local' }], userOf);
    expect(labels.map(plain)).toEqual(['21082 Filip', '', '20545 Boris', 'local']);
    expect(new Set(labels.map((l) => l.length)).size).toBe(1);
  });

  it('pads with no-break spaces, which CSS does not collapse', () => {
    expect(marginLabels([cs(21082), cs(21082)], userOf)[1]).toBe(NBSP.repeat('21082 Filip'.length));
  });

  it('handles a very long file without a spread-argument limit', () => {
    const owners = Array.from({ length: 200_000 }, (_, i) => cs(i % 2 ? 20545 : 21082));
    expect(marginLabels(owners, userOf)).toHaveLength(200_000);
  });
});

describe('hover parts', () => {
  const changeset = {
    id: 21082,
    user: 'Filip',
    date: '21. rujna 2026. 8:58:49',
    comment: 'x ](command:teamExplorer.checkInFromButton)',
    items: [],
  };
  const current = { id: 21082, serverPath: '$/Shop/a.vb', change: ['edit'] };
  const previous = { id: 20969, serverPath: '$/Shop/a.vb', change: ['edit'] };

  it('puts server text in the heading and body only, never in a link', () => {
    const parts = hoverParts(changeset, '$/Shop/a.vb', current, previous);
    expect(parts.heading).toBe('Changeset 21082 · Filip · 21. rujna 2026. 8:58:49');
    expect(parts.body).toBe(changeset.comment);
    expect(parts.links.map((l) => l.command)).toEqual([SHOW_CHANGESET, COMPARE_VERSIONS]);
    expect(parts.links.map((l) => l.label)).toEqual([S.annotateHoverDetails, S.annotateHoverCompare]);
    expect(parts.links[0].args).toEqual(['$/Shop/a.vb', 21082]);
    expect(parts.links[1].args).toEqual(['$/Shop/a.vb', 20969, '$/Shop/a.vb', 21082]);
  });

  it('offers no compare link when there is no previous version', () => {
    expect(hoverParts(changeset, '$/Shop/a.vb', current, undefined).links.map((l) => l.command)).toEqual([
      SHOW_CHANGESET,
    ]);
  });

  it('escapes parentheses and brackets so a server path cannot end the Markdown link early', () => {
    const link = commandLink({ label: 'x', command: SHOW_CHANGESET, args: ['$/a) [y](command:evil', 1] });
    const query = link.slice(link.indexOf('?') + 1);
    expect(link.startsWith(`command:${SHOW_CHANGESET}?`)).toBe(true);
    expect(query).not.toMatch(/[()[\] ]/);
    expect(JSON.parse(decodeURIComponent(query))).toEqual(['$/a) [y](command:evil', 1]);
  });

  describe('D11: hover hardening', () => {
    // A literal '%20', a letter-like escape shape, a lone trailing '%' next to
    // punctuation, and Croatian letters -- all things that survive ordinary
    // encodeURIComponent as %-escape-shaped text and could be misread as an
    // escape by a SECOND decode.
    const paths = ['$/Shop/Ugovor%20Stari.vb', '$/Shop/x%41y.vb', '$/a (1)/50%.vb', '$/Shop/čćžšđ.vb'];

    it('survives one decode AND the real double decode VS Code performs (URI.parse, then decodeURIComponent)', () => {
      for (const path of paths) {
        const args = [path, 42];
        const link = commandLink({ label: 'x', command: SHOW_CHANGESET, args });
        const query = link.slice(link.indexOf('?') + 1);
        expect(JSON.parse(decodeURIComponent(query))).toEqual(args);
        expect(JSON.parse(decodeURIComponent(decodeURIComponent(query)))).toEqual(args);
      }
    });

    it('never leaves a raw "(", ")" in the link, nor a "%" that is not a proper two-digit escape', () => {
      for (const path of paths) {
        const link = commandLink({ label: 'x', command: SHOW_CHANGESET, args: [path, 1] });
        const query = link.slice(link.indexOf('?') + 1);
        expect(query).not.toMatch(/[()]/);
        expect(query).toMatch(/^([^%]|%[0-9A-Fa-f]{2})*$/);
      }
    });

    it('never lets a comment containing "<command:...>" read as a Markdown autolink in the body', () => {
      const changesetWithLinkInComment = {
        id: 1,
        user: 'Filip',
        date: 'today',
        comment: 'see <command:teamExplorer.showChangeset?x> for details',
        items: [],
      };
      const parts = hoverParts(changesetWithLinkInComment, '$/a.vb', undefined, undefined);
      expect(parts.body).not.toMatch(/<c/);
    });

    it('never lets a user name containing "<command:...>" read as a Markdown autolink in the heading', () => {
      const changesetWithLinkInUser = {
        id: 1,
        user: '<command:teamExplorer.showChangeset?x>Filip',
        date: 'today',
        comment: '',
        items: [],
      };
      const parts = hoverParts(changesetWithLinkInUser, '$/a.vb', undefined, undefined);
      expect(parts.heading).not.toMatch(/<c/);
    });
  });
});
