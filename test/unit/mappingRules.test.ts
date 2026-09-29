import { describe, it, expect } from 'vitest';
import { checkMapping, whereMapped } from '../../src/workspace/mappingRules.js';
import type { WorkingFolder, WorkspaceInfo } from '../../src/tf/types.js';

// DEVPC's real workspace (fixtures/windows/workspaces.xml): $/ plus a child override outside C:\work.
const DEVPC: WorkspaceInfo = {
  name: 'DEVPC',
  computer: 'DEVPC',
  folders: [
    { serverItem: '$/', localPath: 'C:\\work' },
    {
      serverItem: '$/Vesta/DatabaseFirst/Insight.Database',
      localPath: 'C:\\Users\\user1\\Downloads\\Insight.Database-main\\Insight.Database',
    },
  ],
};
const OTHER: WorkspaceInfo = { name: 'OTHER', computer: 'DEVPC', folders: [{ serverItem: '$/Lib', localPath: 'D:\\lib' }] };
const ALL = [DEVPC, OTHER];
const check = (serverItem: string, localPath: string, target = DEVPC) => checkMapping({ serverItem, localPath }, target, ALL);

describe('checkMapping', () => {
  it('(M1) a server path already covered by the root mapping is a move, not a fresh add', () => {
    expect(check('$/Ledger', 'D:\\work\\Ledger')).toEqual({ kind: 'move', from: 'C:\\work\\Ledger' });
  });

  it('a trailing backslash does not change the answer', () => {
    expect(check('$/Ledger', 'D:\\work\\Ledger\\')).toEqual({ kind: 'move', from: 'C:\\work\\Ledger' });
  });

  it('is ok when nothing maps the server path yet (no root mapping in this workspace)', () => {
    const noRoot: WorkspaceInfo = { name: 'NOROOT', computer: 'DEVPC', folders: [{ serverItem: '$/Shop', localPath: 'C:\\work\\Shop' }] };
    expect(checkMapping({ serverItem: '$/Ledger', localPath: 'D:\\work\\Ledger' }, noRoot, [noRoot])).toEqual({ kind: 'ok' });
  });

  it('R1: a server path already mapped here is a move, naming where it is now', () => {
    expect(check('$/', 'E:\\work')).toEqual({ kind: 'move', from: 'C:\\work' });
  });

  it('R1: the exact same pair again changes nothing', () => {
    expect(check('$/', 'c:\\WORK')).toMatchObject({ kind: 'redundant' });
  });

  it("R2: a local folder that is already another mapping's folder is refused (tf would take it over, P2)", () => {
    expect(check('$/Shop', 'C:\\Users\\user1\\Downloads\\Insight.Database-main\\Insight.Database')).toMatchObject({
      kind: 'refuse',
      reason: 'localInUse',
      workspace: 'DEVPC',
    });
  });

  it("R2: the same, when the folder belongs to another workspace on this computer", () => {
    expect(check('$/X', 'D:\\lib')).toMatchObject({ kind: 'refuse', reason: 'localInUse', workspace: 'OTHER' });
  });

  it("refuses a folder inside another workspace's mapping, and one that contains it", () => {
    expect(check('$/X', 'D:\\lib\\sub')).toMatchObject({ kind: 'refuse', reason: 'insideOther', workspace: 'OTHER' });
    expect(check('$/X', 'D:\\')).toMatchObject({ kind: 'refuse', reason: 'containsOther', workspace: 'OTHER' });
  });

  it('R3: a different project inside a mapped folder is refused (tf accepts it, P5)', () => {
    expect(check('$/Ledger', 'C:\\work\\Other')).toMatchObject({
      kind: 'refuse',
      reason: 'insideOther',
      mapping: { serverItem: '$/' },
    });
  });

  it('R4: a child the parent already maps there is redundant (tf drops it, P4), case-insensitively', () => {
    expect(check('$/Shop', 'C:\\work\\Shop')).toMatchObject({ kind: 'redundant', parent: { serverItem: '$/' } });
    expect(check('$/shop', 'c:\\WORK\\shop')).toMatchObject({ kind: 'redundant' });
  });

  it("R5: an override deeper than a mapped folder is a move to the parent's implied location", () => {
    expect(check('$/Vesta/DatabaseFirst', 'C:\\Users\\user1\\Downloads\\Insight.Database-main')).toEqual({
      kind: 'move',
      from: 'C:\\work\\Vesta\\DatabaseFirst',
    });
  });

  it('R5: ...and refused when that mapping is some other server path', () => {
    expect(check('$/Other', 'C:\\Users\\user1\\Downloads')).toMatchObject({
      kind: 'refuse',
      reason: 'containsOther',
      mapping: { serverItem: '$/Vesta/DatabaseFirst/Insight.Database' },
    });
  });

  it('(M6) does not produce a double slash when the proposal itself has a trailing slash', () => {
    const trail: WorkspaceInfo = {
      name: 'TRAIL',
      computer: 'DEVPC',
      folders: [{ serverItem: '$/Foo/Bar', localPath: 'C:\\newroot\\Bar' }],
    };
    expect(checkMapping({ serverItem: '$/Foo/', localPath: 'C:\\newroot' }, trail, [trail])).toEqual({ kind: 'ok' });
  });

  it('works on Wine paths the same way', () => {
    const fedora: WorkspaceInfo = { name: 'Fedora', computer: 'FEDORA', folders: [{ serverItem: '$/', localPath: 'Z:\\home\\shax\\work' }] };
    expect(checkMapping({ serverItem: '$/Shop', localPath: 'Z:\\home\\shax\\work\\Shop' }, fedora, [fedora])).toMatchObject({ kind: 'redundant' });
    expect(checkMapping({ serverItem: '$/Ledger', localPath: 'Z:\\home\\shax\\work\\x' }, fedora, [fedora])).toMatchObject({ kind: 'refuse', reason: 'insideOther' });
    expect(checkMapping({ serverItem: '$/Ledger', localPath: 'Z:\\home\\shax\\ledger' }, fedora, [fedora])).toEqual({
      kind: 'move',
      from: 'Z:\\home\\shax\\work\\Ledger',
    });
  });

  it('checks a brand-new, empty workspace only against the others', () => {
    const fresh: WorkspaceInfo = { name: 'NEW', computer: 'DEVPC', folders: [] };
    expect(checkMapping({ serverItem: '$/', localPath: 'E:\\work' }, fresh, [...ALL, fresh])).toEqual({ kind: 'ok' });
    expect(checkMapping({ serverItem: '$/', localPath: 'C:\\work' }, fresh, [...ALL, fresh])).toMatchObject({ kind: 'refuse', workspace: 'DEVPC' });
  });

  describe('R1 combined with the other rules (review I1) - each must still refuse or move, not just move', () => {
    it('refuses localInUse even though the server path is mapped elsewhere', () => {
      expect(check('$/Vesta/DatabaseFirst/Insight.Database', 'C:\\work')).toMatchObject({ kind: 'refuse', reason: 'localInUse' });
    });

    it('refuses insideOther even though the server path is mapped elsewhere', () => {
      expect(check('$/Vesta/DatabaseFirst/Insight.Database', 'C:\\work\\Other')).toMatchObject({ kind: 'refuse', reason: 'insideOther' });
    });

    it('refuses containsOther even for the root server path', () => {
      expect(check('$/', 'C:\\Users\\user1')).toMatchObject({ kind: 'refuse', reason: 'containsOther' });
    });

    it('is a move back to where the parent mapping would put it, not a refusal', () => {
      expect(check('$/Vesta/DatabaseFirst/Insight.Database', 'C:\\work\\Vesta\\DatabaseFirst\\Insight.Database')).toEqual({
        kind: 'move',
        from: 'C:\\Users\\user1\\Downloads\\Insight.Database-main\\Insight.Database',
      });
    });
  });

  it('(I2, M6) nested mappings: the deepest parent wins, by normalized key length', () => {
    const nest: WorkspaceInfo = {
      name: 'NEST',
      computer: 'DEVPC',
      folders: [
        { serverItem: '$/', localPath: 'C:\\work' },
        { serverItem: '$/Legacy/Old', localPath: 'C:\\work\\Old' },
        { serverItem: '$/Old/Sub', localPath: 'E:\\sub' },
      ],
    };
    expect(checkMapping({ serverItem: '$/Old/Sub', localPath: 'C:\\work\\Old\\Sub' }, nest, [nest])).toMatchObject({
      kind: 'refuse',
      reason: 'insideOther',
      mapping: { serverItem: '$/Legacy/Old' },
    });
  });

  describe('(M3) local path normalization before comparing', () => {
    it('treats forward slashes as backslashes', () => {
      expect(check('$/Shop', 'C:/work/Shop')).toMatchObject({ kind: 'redundant' });
    });

    it('resolves .. before comparing', () => {
      expect(check('$/Shop', 'C:\\Users\\..\\work\\Shop')).toMatchObject({ kind: 'redundant' });
    });
  });

  describe('(M4, M5) trailing separators and drive roots', () => {
    it('a trailing backslash on an exact match is still redundant', () => {
      expect(check('$/', 'C:\\work\\')).toMatchObject({ kind: 'redundant' });
    });

    it('a trailing backslash on an in-use folder still refuses', () => {
      expect(check('$/X', 'D:\\lib\\')).toMatchObject({ kind: 'refuse', reason: 'localInUse' });
    });

    it('a folder whose name merely starts with another one\'s is not inside it', () => {
      expect(check('$/X', 'C:\\workX')).toEqual({ kind: 'move', from: 'C:\\work\\X' });
    });

    it('a drive-root mapping covers everything on that drive', () => {
      const drive: WorkspaceInfo = { name: 'DRIVE', computer: 'DEVPC', folders: [{ serverItem: '$/', localPath: 'D:\\' }] };
      expect(checkMapping({ serverItem: '$/Y', localPath: 'D:\\y2' }, drive, [drive])).toMatchObject({
        kind: 'refuse',
        reason: 'insideOther',
        mapping: { serverItem: '$/' },
      });
    });
  });
});

describe('whereMapped', () => {
  it("resolves a path through DEVPC's root mapping", () => {
    expect(whereMapped('$/Shop', DEVPC.folders)).toBe('C:\\work\\Shop');
  });

  it('resolves a path through the deepest covering override', () => {
    expect(whereMapped('$/Vesta/DatabaseFirst/Insight.Database/sub', DEVPC.folders)).toBe(
      'C:\\Users\\user1\\Downloads\\Insight.Database-main\\Insight.Database\\sub',
    );
  });

  it('is undefined when nothing covers it - $/Shop is not an ancestor of $/Shop2023', () => {
    const shopOnly: WorkingFolder[] = [{ serverItem: '$/Shop', localPath: 'C:\\work\\Shop' }];
    expect(whereMapped('$/Shop2023', shopOnly)).toBeUndefined();
  });
});
