import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseInfo } from '../../src/tf/parseInfo.js';
import {
  actionsFor,
  buildConflicts,
  conflictsUnder,
  familyOf,
  nameAndFolder,
  parseConflictIntent,
  type Conflict,
  type LocatedConflict,
} from '../../src/conflicts/conflictModel.js';

const fx = (dir: 'windows' | 'fedora', name: string) =>
  readFileSync(join(__dirname, '../fixtures', dir, name), 'utf8');

const THREE = parseInfo(fx('windows', 'resolve-info-three.txt'));
const infoFor = (serverPath: string) => THREE.find((i) => i.serverPath === serverPath);
const lower = (p: string) => p.toLowerCase();

const conflict = (over: Partial<Conflict> = {}): Conflict => ({
  localPath: String.raw`C:\work\Shop\Startup.cs`,
  tfPath: String.raw`C:\work\Shop\Startup.cs`,
  serverPath: '$/Shop/Startup.cs',
  reason: 'You have a conflicting pending change.',
  family: 'version',
  base: 18319,
  theirs: 18325,
  binary: false,
  ...over,
});

describe('familyOf (from info, never from the reason)', () => {
  it('is version when the local half has a pending change', () => {
    expect(familyOf(infoFor('$/OPS/OPS2023/CORE.Api/CORE.Api.xml'))).toBe('version');
    expect(familyOf(infoFor('$/Ledger/dbo/Stored Procedures/till_InvoiceSelect.sql'))).toBe('version');
  });

  it('is blocked when nothing is pending: Change none, or an empty local half (C5)', () => {
    expect(familyOf(infoFor('$/Shop/Shop2023/Enterprise.Till.Server/Startup.cs'))).toBe('blocked');
    expect(familyOf(parseInfo(fx('fedora', 'resolve-info-blocked.txt'))[0])).toBe('blocked');
  });

  it('is unknown when info did not return the item', () => {
    expect(familyOf(undefined)).toBe('unknown');
  });
});

describe('buildConflicts', () => {
  const located = (localPath: string, serverPath: string | undefined): LocatedConflict => ({
    localPath,
    tfPath: localPath,
    serverPath,
    reason: 'You have a conflicting pending change.',
  });

  it('matches info by server path, case-insensitively, and takes base, theirs and Binary from it', () => {
    const [c] = buildConflicts(
      [located(String.raw`C:\work\OPS\OPS2023\CORE.Api\CORE.Api.xml`, '$/ops/OPS2023/core.api/CORE.Api.xml')],
      THREE,
      lower,
    );
    expect(c).toMatchObject({ family: 'version', base: 15451, theirs: 21004, binary: true });
  });

  it('keeps a conflict info did not describe, as unknown with no changesets', () => {
    const [c] = buildConflicts([located(String.raw`C:\work\x.cs`, '$/x.cs')], THREE, lower);
    expect(c).toMatchObject({ family: 'unknown', base: undefined, theirs: undefined, binary: false });
    const [d] = buildConflicts([located(String.raw`C:\elsewhere\x.cs`, undefined)], THREE, lower);
    expect(d.family).toBe('unknown');
  });

  it("matches info by the path it was asked about first: a pending rename's server half has the old name", () => {
    const NEW = String.raw`C:\work\Shop\New.cs`;
    const renamed = {
      serverPath: '$/Shop/Old.cs',
      type: 'file' as const,
      localPath: NEW.toUpperCase(),
      localChangeset: 18319,
      localChange: 'rename, edit',
      serverChangeset: 18325,
      lock: 'none',
      lastModified: '',
      fileType: 'utf-8',
      size: 1,
    };
    const [c] = buildConflicts([located(NEW, '$/Shop/New.cs')], [renamed], lower);
    expect(c).toMatchObject({ family: 'version', base: 18319, theirs: 18325 });
  });

  it('never calls a conflict tf named by server path blocked: it has no local item to be in the way', () => {
    const blockedInfo = parseInfo(fx('fedora', 'resolve-info-blocked.txt'));
    const l = { ...located('/home/shax/p5-Urudžbeni zapisnik/Urudzbeni.sln', '$/Urudžbeni zapisnik/Urudzbeni.sln') };
    expect(buildConflicts([l], blockedInfo, (p) => p)[0].family).toBe('blocked');
    const [c] = buildConflicts([{ ...l, listedByServerPath: true }], blockedInfo, (p) => p);
    expect(c).toMatchObject({ family: 'unknown', theirs: 14353 });
  });

  it("is unknown when the pending change is already at the server's latest: the other side is not the server (seam S7)", () => {
    const sql = String.raw`C:\work\Ledger\dbo\Stored Procedures\till_InvoiceSelect.sql`;
    const [c] = buildConflicts([located(sql, '$/Ledger/dbo/Stored Procedures/till_InvoiceSelect.sql')], THREE, lower);
    expect(c).toMatchObject({ family: 'unknown', base: 20783, theirs: 20783 });
    expect(actionsFor(c)).not.toContain('compare');
  });

  it('lists a path tf printed twice only once', () => {
    const a = located(String.raw`C:\work\x.cs`, '$/x.cs');
    const b = located(String.raw`C:\WORK\X.cs`, '$/x.cs');
    expect(buildConflicts([a, b], [], lower)).toHaveLength(1);
  });
});

describe('actionsFor (the button table)', () => {
  it('version: every button', () => {
    expect(actionsFor(conflict())).toEqual(['compare', 'compareServerBase', 'compareLocalBase', 'autoMerge', 'takeTheirs', 'keepYours', 'mergeManually']);
  });

  it('version, Binary: no Auto-merge, but every compare (VS Code decides what a binary looks like)', () => {
    expect(actionsFor(conflict({ binary: true }))).toEqual(['compare', 'compareServerBase', 'compareLocalBase', 'takeTheirs', 'keepYours', 'mergeManually']);
  });

  it('version without a base: neither compare against the base', () => {
    expect(actionsFor(conflict({ base: undefined }))).not.toContain('compareServerBase');
    expect(actionsFor(conflict({ base: undefined }))).not.toContain('compareLocalBase');
  });

  it('blocked: Compare and Overwrite only', () => {
    expect(actionsFor(conflict({ family: 'blocked', base: undefined }))).toEqual(['compare', 'overwriteLocal']);
  });

  it('unknown: the four resolutions, and nothing that needs a server version', () => {
    expect(actionsFor(conflict({ family: 'unknown', theirs: undefined, base: undefined }))).toEqual(
      ['autoMerge', 'takeTheirs', 'keepYours', 'overwriteLocal'],
    );
  });

  it('never offers Compare or a manual merge without a server path and changeset', () => {
    expect(actionsFor(conflict({ serverPath: undefined }))).toEqual(['autoMerge', 'takeTheirs', 'keepYours']);
    expect(actionsFor(conflict({ family: 'blocked', theirs: undefined }))).toEqual(['overwriteLocal']);
  });
});

describe('conflictsUnder (the seam: "at or under the given paths")', () => {
  const all = [
    conflict(),
    conflict({ localPath: 'b', serverPath: '$/OPS/OPS2023/CORE.Api/CORE.Api.xml' }),
    conflict({ localPath: 'c', serverPath: undefined }),
  ];

  it('is everything when no paths are given', () => {
    expect(conflictsUnder(all, [])).toHaveLength(3);
  });

  const placed = all.slice(0, 2);

  it('matches the item itself and anything under a folder, case-insensitively', () => {
    expect(conflictsUnder(placed, ['$/shop/startup.cs']).map((c) => c.serverPath)).toEqual(['$/Shop/Startup.cs']);
    expect(conflictsUnder(placed, ['$/OPS']).map((c) => c.serverPath)).toEqual(['$/OPS/OPS2023/CORE.Api/CORE.Api.xml']);
    expect(conflictsUnder(placed, ['$/OPS/'])).toHaveLength(1);
    expect(conflictsUnder(placed, ['$/'])).toHaveLength(2);
  });

  it('does not match a sibling that merely shares a prefix', () => {
    expect(conflictsUnder(placed, ['$/Ka'])).toEqual([]);
  });

  it('counts a conflict no mapping places, after the placed ones: a 0 would let phase 4 delete the shelveset', () => {
    expect(conflictsUnder(all, ['$/Ka']).map((c) => c.localPath)).toEqual(['c']);
    expect(conflictsUnder(all, ['$/OPS']).map((c) => c.localPath)).toEqual(['b', 'c']);
  });
});

describe('nameAndFolder', () => {
  it('splits a Windows path on either separator, a Linux one on / only', () => {
    expect(nameAndFolder(String.raw`C:\work\Shop\Startup.cs`, 'win32')).toEqual({ name: 'Startup.cs', folder: String.raw`C:\work\Shop` });
    expect(nameAndFolder('/home/shax/work/a.cs', 'linux')).toEqual({ name: 'a.cs', folder: '/home/shax/work' });
    expect(nameAndFolder(String.raw`/home/shax/odd\name.cs`, 'linux')).toEqual({ name: String.raw`odd\name.cs`, folder: '/home/shax' });
  });
});

describe('parseConflictIntent (what the page may ask for)', () => {
  it('accepts the five intents', () => {
    expect(parseConflictIntent({ type: 'ready' })).toEqual({ type: 'ready' });
    expect(parseConflictIntent({ type: 'refresh' })).toEqual({ type: 'refresh' });
    expect(parseConflictIntent({ type: 'autoMergeAll' })).toEqual({ type: 'autoMergeAll' });
    expect(parseConflictIntent({ type: 'select', key: 'c:\\a' })).toEqual({ type: 'select', key: 'c:\\a' });
    for (const action of ['compare', 'compareServerBase', 'compareLocalBase', 'autoMerge', 'takeTheirs', 'keepYours', 'mergeManually', 'overwriteLocal', 'resolved', 'cancelMerge']) {
      expect(parseConflictIntent({ type: 'act', key: 'k', action })).toEqual({ type: 'act', key: 'k', action });
    }
  });

  it('refuses anything else', () => {
    for (const raw of [
      undefined,
      null,
      'ready',
      { type: 'checkin' },
      { type: 'act', key: 'k', action: 'AutoMergeForced' },
      { type: 'act', key: 7, action: 'compare' },
      { type: 'act', key: 'k' },
      { type: 'select' },
      { type: 'select', key: 'x'.repeat(4097) },
    ]) {
      expect(parseConflictIntent(raw), JSON.stringify(raw)).toBeUndefined();
    }
  });
});
