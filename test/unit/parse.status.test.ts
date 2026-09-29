import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseStatus } from '../../src/tf/parse.js';
import { ENC_BINARY, ENC_NOT_APPLICABLE, isBinary, isPendingAdd } from '../../src/tf/types.js';

const fixture = (name: string) =>
  readFileSync(join(__dirname, '../fixtures', name));

describe('parseStatus', () => {
  it('returns an empty list for <Status /> (finding 12: exit code is 0 here)', () => {
    expect(parseStatus(fixture('windows/status-journals.xml'))).toEqual([]);
  });

  it('reads all six shapes from the mixed fixture', () => {
    expect(parseStatus(fixture('windows/status-mixed.xml'))).toHaveLength(6);
  });

  it('finding 1: chg is a space-separated flag SET, not an enum', () => {
    const changes = parseStatus(fixture('windows/status-mixed.xml'));
    const add = changes.find((c) => c.changes.size === 3)!;

    expect([...add.changes].sort()).toEqual(['Add', 'Edit', 'Encoding']);
    expect(add.changeFlags).toBe(7); // Add=1 | Edit=2 | Encoding=4
  });

  it('finding 2: ver is absent on pending Adds, present on Edits', () => {
    const changes = parseStatus(fixture('windows/status-mixed.xml'));

    const edit = changes.find((c) => c.serverItem === '$/Ledger/Ledger.sqlproj')!;
    expect(edit.version).toBe(20783);
    expect(isPendingAdd(edit)).toBe(false);

    for (const add of changes.filter(isPendingAdd)) {
      expect(add.version).toBeUndefined();
    }
  });

  it('finding 3: pending Adds have a negative itemId', () => {
    const changes = parseStatus(fixture('windows/status-mixed.xml'));

    const edit = changes.find((c) => c.serverItem === '$/Ledger/Ledger.sqlproj')!;
    expect(edit.itemId).toBeGreaterThan(0);

    for (const add of changes.filter(isPendingAdd)) {
      expect(add.itemId).toBeLessThan(0);
    }
  });

  it('finding 4: enc -1 means binary, -3 means not applicable', () => {
    const changes = parseStatus(fixture('windows/status-mixed.xml'));

    const binary = changes.find((c) => c.encoding === ENC_BINARY)!;
    expect(binary).toBeDefined();
    expect(isBinary(binary)).toBe(true);

    const folder = changes.find((c) => c.encoding === ENC_NOT_APPLICABLE)!;
    expect(folder.itemType).toBe('Folder');
  });

  it('finding 5: type="Folder" appears and is reported as such', () => {
    const changes = parseStatus(fixture('windows/status-mixed.xml'));
    expect(changes.filter((c) => c.itemType === 'Folder')).toHaveLength(1);
    expect(changes.filter((c) => c.itemType === 'File')).toHaveLength(5);
  });

  it('decodes Croatian characters in paths as UTF-8', () => {
    const changes = parseStatus(fixture('windows/status-croatian-SYNTHETIC.xml'));

    expect(changes).toHaveLength(2);
    expect(changes.some((c) => c.serverItem.includes('Urudžbeni zapisnik'))).toBe(true);
    expect(changes.some((c) => c.serverItem.includes('čćžšđ ČĆŽŠĐ'))).toBe(true);
  });

  it('pins every field of every change in the mixed fixture (golden, phase 3 part 2 review)', () => {
    // Regression pin: the tests above only sample individual fields, so an
    // unnoticed change to `date`, `localPath`, `length`, or most `encoding`
    // values would still pass the whole suite. This expects EXACTLY what
    // parseStatus produced at commit b3a4296 (before the Task 2 split) for
    // every field of every change, `changes` sorted to an array since Set
    // order is not what is being pinned. toStrictEqual (not toEqual) so an
    // `undefined` field going missing, or vice versa, is caught too.
    const changes = parseStatus(fixture('windows/status-mixed.xml')).map((c) => ({
      ...c,
      changes: [...c.changes].sort(),
    }));

    expect(changes).toStrictEqual([
      {
        serverItem: '$/Ledger/Ledger.sqlproj',
        localPath: 'C:\\work\\Ledger\\Ledger.sqlproj',
        changes: ['Edit'],
        changeFlags: 2,
        itemType: 'File',
        encoding: 65001,
        version: 20783,
        itemId: 152732,
        date: '2026-07-27T14:38:43.17+02:00',
        length: 698616,
      },
      {
        serverItem: '$/Ledger/dbo/Stored Procedures/till_ClientsSelect.sql',
        localPath: 'C:\\work\\Ledger\\dbo\\Stored Procedures\\till_ClientsSelect.sql',
        changes: ['Edit'],
        changeFlags: 2,
        itemType: 'File',
        encoding: 65001,
        version: 20783,
        itemId: 163088,
        date: '2026-07-27T14:38:42.63+02:00',
        length: 10974,
      },
      {
        serverItem: '$/Bookkeeping/Bookkeeping2023/docs/database/_orphans.txt',
        localPath: 'c:\\work\\Bookkeeping\\Bookkeeping2023\\docs\\database\\_orphans.txt',
        changes: ['Add', 'Edit', 'Encoding'],
        changeFlags: 7,
        itemType: 'File',
        encoding: 1250,
        version: undefined,
        itemId: -328662,
        date: '2026-05-06T20:33:38.003+02:00',
        length: undefined,
      },
      {
        serverItem: '$/Bookkeeping/Bookkeeping2023/docs/database/_regenerate-plan.md',
        localPath: 'c:\\work\\Bookkeeping\\Bookkeeping2023\\docs\\database\\_regenerate-plan.md',
        changes: ['Add', 'Edit', 'Encoding'],
        changeFlags: 7,
        itemType: 'File',
        encoding: 1250,
        version: undefined,
        itemId: -328660,
        date: '2026-05-06T20:25:31.81+02:00',
        length: undefined,
      },
      {
        serverItem: '$/Bookkeeping/Bookkeeping2023/docs/business-domain/retail-simplified',
        localPath: 'C:\\work\\Bookkeeping\\Bookkeeping2023\\docs\\business-domain\\retail-simplified',
        changes: ['Add', 'Encoding'],
        changeFlags: 5,
        itemType: 'Folder',
        encoding: -3,
        version: undefined,
        itemId: -339205,
        date: '2026-07-22T12:21:32.017+02:00',
        length: undefined,
      },
      {
        serverItem:
          '$/Bookkeeping/Bookkeeping2023/docs/help/retail/docusaurus/node_modules/@docusaurus/logger/demo.png',
        localPath:
          'C:\\work\\Bookkeeping\\Bookkeeping2023\\docs\\help\\retail\\docusaurus\\node_modules\\@docusaurus\\logger\\demo.png',
        changes: ['Add', 'Edit', 'Encoding'],
        changeFlags: 7,
        itemType: 'File',
        encoding: -1,
        version: undefined,
        itemId: -344326,
        date: '2026-07-24T09:12:26.593+02:00',
        length: undefined,
      },
    ]);
  });
});

describe('a pending Delete (captured 2026-09-23; the corpus had none until then)', () => {
  const changes = parseStatus(fixture('windows/status-delete.xml'));

  it('reads both a deleted FILE and a deleted FOLDER', () => {
    expect(changes).toHaveLength(2);
    const byType = Object.fromEntries(changes.map((c) => [c.itemType, c]));

    expect(byType.Folder.serverItem).toBe('$/Shop/Shop2023/Enterprise.Till.Server/Web/assets');
    expect([...byType.Folder.changes]).toEqual(['Delete']);
    expect(byType.File.serverItem).toBe('$/Shop/Shop2023/Enterprise.Till.Server/Web/hello.html');
    expect([...byType.File.changes]).toEqual(['Delete']);
  });

  it('keeps the server baseline, unlike an Add', () => {
    // `ver` is present on a delete -- the item exists on the server, which is
    // what distinguishes it from a pending Add (itemid negative, no ver).
    for (const c of changes) expect(c.version).toBe(18312);
    expect(changes.every((c) => c.itemId > 0)).toBe(true);
  });

  it('gives the deleted FOLDER no length, and the file its own', () => {
    const folder = changes.find((c) => c.itemType === 'Folder')!;
    const file = changes.find((c) => c.itemType === 'File')!;
    expect(folder.length).toBeUndefined();
    expect(file.length).toBe(304);
  });
});
