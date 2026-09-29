import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseHistory } from '../../src/tf/parseHistory.js';

const fixture = (machine: 'windows' | 'fedora', name: string): string =>
  readFileSync(join(__dirname, '../fixtures', machine, name)).toString('utf8');

const RENAMED = '$/Shop/Shop2023/ShopModel/Till/tillPOSReply.vb';
const OLD_NAME = '$/Shop/Shop2023/ShopModel/Till/tillPOSReplies.vb';

// The same changesets, printed by each machine in its own language (finding 13).
const DATES = {
  windows: {
    18659: '29. svibnja 2025. 15:05:47',
    18544: '20. svibnja 2025. 10:07:54',
    20213: '13. veljače 2026. 15:53:13',
  },
  fedora: {
    18659: 'Thursday, May 29, 2025 3:05:47 PM',
    18544: 'Tuesday, May 20, 2025 10:07:54 AM',
    20213: 'Friday, February 13, 2026 3:53:13 PM',
  },
} as const;

describe.each(['windows', 'fedora'] as const)('parseHistory on the %s captures', (machine) => {
  it('follows a rename back with /itemmode, printing the OLD name on the older record', () => {
    const { changesets, skipped } = parseHistory(fixture(machine, 'history-file-renamed-itemmode.txt'));
    expect(skipped).toEqual([]);
    expect(changesets.map((c) => c.id)).toEqual([18659, 18617, 18588, 18558, 18552, 18547, 18544]);
    expect(changesets.map((c) => c.user)).toEqual(['Boris', 'Filip', 'Boris', 'Boris', 'Boris', 'Filip', 'Boris']);
    expect(changesets[5].items).toEqual([{ change: ['rename', 'edit'], serverPath: RENAMED }]);
    expect(changesets[6].items).toEqual([{ change: ['add'], serverPath: OLD_NAME }]);
    expect(changesets[6].comment).toBe('till_POS (Replies, Requests, Links)');
  });

  it('keeps dates exactly as the machine printed them', () => {
    const { changesets } = parseHistory(fixture(machine, 'history-file-renamed-itemmode.txt'));
    expect(changesets[0].date).toBe(DATES[machine][18659]);
    expect(changesets[6].date).toBe(DATES[machine][18544]);
  });

  it('stops at the rename without /itemmode', () => {
    const { changesets } = parseHistory(fixture(machine, 'history-file-renamed-no-itemmode.txt'));
    expect(changesets.map((c) => c.id)).toEqual([18659, 18617, 18588, 18558, 18552, 18547]);
  });

  it('reads the local-path /version:W capture exactly like the server-path one', () => {
    expect(parseHistory(fixture(machine, 'history-workspace-version.txt'))).toEqual(
      parseHistory(fixture(machine, 'history-file-renamed-itemmode.txt')),
    );
  });

  it('joins a multi-line comment and keeps its blank middle line', () => {
    const [cs] = parseHistory(fixture(machine, 'history-changeset-multiline.txt')).changesets;
    expect(cs.id).toBe(13559);
    expect(cs.user).toBe('Zoran');
    expect(cs.comment).toBe(
      'exportPriceListSync - export ponekad nakon Base64Encode sadrzava znak jednakosti u sebi, a on nije ' +
        'ispravno protumacen unutar HeaderValuea, osim ako ga se prije toga ne UrlEncodeira' +
        '\n\nFlexo: slanje cjenika u shop',
    );
    expect(cs.items).toEqual([
      { change: ['edit'], serverPath: '$/Shop/Shop2013/Distribution/classes/TransferApiClient.vb' },
    ]);
  });

  it('splits the deletion id off a path and reads a padded change column', () => {
    const [cs] = parseHistory(fixture(machine, 'history-changeset-rename-delete.txt')).changesets;
    expect(cs.id).toBe(20213);
    expect(cs.comment).toBe('');
    expect(cs.date).toBe(DATES[machine][20213]);
    expect(cs.items).toEqual([
      {
        change: ['delete', 'source rename'],
        serverPath: '$/Shop/Shop2023/Raverus.FiskalizacijaDEV.Standard/Raverus.FiskalizacijaDEV.sln',
        deletionId: 703,
      },
      {
        change: ['rename'],
        serverPath: '$/Shop/Shop2023/Raverus.FiskalizacijaDEV.Standard/Raverus.FiskalizacijaDEV.sln.bak',
      },
    ]);
  });

  it('reads both folder pages, which do not overlap', () => {
    const one = parseHistory(fixture(machine, 'history-folder-page1.txt')).changesets;
    const two = parseHistory(fixture(machine, 'history-folder-page2.txt')).changesets;
    expect(one.map((c) => c.id)).toEqual([21082, 21043, 21032, 21019, 21018]);
    expect(two.map((c) => c.id)).toEqual([21016, 21013, 20995, 20993, 20992]);
    expect(two[1].items).toHaveLength(14);
    expect(one[0].comment).toBe('Ispravak SQL pogreške pri učitavanju popisa proizvoda');
  });

  it("reads tf's empty-range sentence as no changesets and nothing skipped", () => {
    expect(parseHistory(fixture(machine, 'history-no-entries.txt'))).toEqual({ changesets: [], skipped: [] });
  });

  it('still reads the Phase 0 capture', () => {
    const [cs] = parseHistory(fixture(machine, 'history-detailed.txt')).changesets;
    expect(cs).toEqual({
      id: 240,
      user: 'Zoran',
      date: machine === 'windows' ? '11. ožujka 2013. 13:52:15' : 'Monday, March 11, 2013 1:52:15 PM',
      comment: '',
      items: [{ change: ['add'], serverPath: '$/Deposits/Deposits/frmDeposits.vb' }],
    });
  });
});

// SYNTHETIC input from here on: shapes the captures do not contain.
const SEP = '-'.repeat(79);
const record = (...lines: string[]): string => [SEP, ...lines, ''].join('\r\n');

describe('parseHistory on shapes the captures do not contain', () => {
  it('keeps a comment line that mentions a server path in the comment (finding 22)', () => {
    const { changesets } = parseHistory(
      record('Changeset: 7', 'User: A', 'Date: d', '', 'Comment:', '  Branched from $/Shop/Old', '', 'Items:', '  branch $/Shop/New'),
    );
    expect(changesets[0].comment).toBe('Branched from $/Shop/Old');
    expect(changesets[0].items).toEqual([{ change: ['branch'], serverPath: '$/Shop/New' }]);
  });

  it('ignores a section it does not know, such as check-in notes', () => {
    const { changesets } = parseHistory(
      record(
        'Changeset: 8', 'User: A', 'Date: d', '', 'Comment:', '  real comment', '',
        'Check-in Notes:', '  Code Reviewer: someone $/x', '', 'Items:', '  edit $/Shop/A.vb',
      ),
    );
    expect(changesets[0].comment).toBe('real comment');
    expect(changesets[0].items).toEqual([{ change: ['edit'], serverPath: '$/Shop/A.vb' }]);
  });

  it('skips a record with no Changeset line and reports its first line', () => {
    const text = record('User: A', 'Date: d', '', 'Comment:', '', 'Items:', '  edit $/A') +
      record('Changeset: 9', 'User: B', 'Date: d', '', 'Comment:', '', 'Items:', '  edit $/B');
    const { changesets, skipped } = parseHistory(text);
    expect(changesets.map((c) => c.id)).toEqual([9]);
    expect(skipped).toEqual(['User: A']);
  });

  it('reports output with no record at all as skipped, so the caller can say it could not read it', () => {
    expect(parseHistory('TF14045: something unexpected\r\n')).toEqual({
      changesets: [],
      skipped: ['TF14045: something unexpected'],
    });
  });

  it('returns nothing for empty output', () => {
    expect(parseHistory('')).toEqual({ changesets: [], skipped: [] });
  });

  it('carries a change word it does not know instead of dropping it', () => {
    const [cs] = parseHistory(record('Changeset: 3', 'User: A', 'Date: d', '', 'Comment:', '', 'Items:', '  frobnicate, edit $/A.vb')).changesets;
    expect(cs.items[0].change).toEqual(['frobnicate', 'edit']);
  });

  it('accepts LF line endings as well as CRLF', () => {
    const lf = [SEP, 'Changeset: 4', 'User: A', 'Date: d', '', 'Comment:', '  x', '', 'Items:', '  edit $/A.vb', ''].join('\n');
    expect(parseHistory(lf).changesets[0]).toEqual({
      id: 4, user: 'A', date: 'd', comment: 'x', items: [{ change: ['edit'], serverPath: '$/A.vb' }],
    });
  });

  // 464 of 16,219 real $/Shop items have a space in the server path, from VB's
  // standard "My Project" folder. The code splits at the FIRST " $/", so it
  // reads these correctly; a rewrite that took the last whitespace-separated
  // token, or used lastIndexOf(' $/'), would pass every other test here while
  // silently truncating or dropping these items.
  it('keeps a "My Project" path with a space intact', () => {
    const { changesets, skipped } = parseHistory(
      record(
        'Changeset: 10', 'User: A', 'Date: d', '', 'Comment:', '', 'Items:',
        '  edit $/Shop/Shop2023/ShopData/My Project/AssemblyInfo.vb',
      ),
    );
    expect(skipped).toEqual([]);
    expect(changesets[0].items).toEqual([
      { change: ['edit'], serverPath: '$/Shop/Shop2023/ShopData/My Project/AssemblyInfo.vb' },
    ]);
  });

  it('reads a deletion id off a spaced path behind a padded multi-word change column', () => {
    const { changesets, skipped } = parseHistory(
      record(
        'Changeset: 11', 'User: A', 'Date: d', '', 'Comment:', '', 'Items:',
        '  delete, source rename $/A/My Project/x.vb;X9',
      ),
    );
    expect(skipped).toEqual([]);
    expect(changesets[0].items).toEqual([
      { change: ['delete', 'source rename'], serverPath: '$/A/My Project/x.vb', deletionId: 9 },
    ]);
  });

  it('splits at the FIRST " $/" even when a folder segment itself ends in " $"', () => {
    const { changesets, skipped } = parseHistory(
      record('Changeset: 12', 'User: A', 'Date: d', '', 'Comment:', '', 'Items:', '  edit $/A/Price $/b.vb'),
    );
    expect(skipped).toEqual([]);
    expect(changesets[0].items).toEqual([{ change: ['edit'], serverPath: '$/A/Price $/b.vb' }]);
  });
});
