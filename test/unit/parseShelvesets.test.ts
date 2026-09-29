import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseShelvesets, parseShelvedChanges } from '../../src/tf/parseShelvesets.js';

const fixture = (name: string) => readFileSync(join(__dirname, '../fixtures/windows', name));

describe('parseShelvesets (spec S2)', () => {
  const list = parseShelvesets(fixture('shelvesets-list.xml'));
  const byName = (n: string) => list.find((s) => s.name === n)!;

  it('reads every row, in tf order', () => {
    expect(list.map((s) => s.name)).toEqual([
      '__tf_clean_wksp_metadata',
      'Popravak web servisa',
      'CodeReview_2023-12-21_03.15.49.7918',
      'EF6 Migration 9',
      'Assignments uređivanje zaglavlja',
      'TFVC-PROBE-P4-1',
    ]);
  });

  it('keeps the owner, its display name and the unique id apart', () => {
    expect(byName('EF6 Migration 9')).toEqual({
      name: 'EF6 Migration 9',
      owner: 'user@example.com',
      ownerDisplay: 'Filip',
      ownerUnique: 'user@example.com',
      date: '2026-06-25T15:08:16.967+02:00',
      comment: 'EF6 Migration 7',
    });
    expect(byName('__tf_clean_wksp_metadata').ownerUnique).toBe('Build\\00000000-0000-0000-0000-000000000000');
  });

  it('keeps Croatian letters, and a multi-line comment with its line break as \\n', () => {
    expect(byName('Assignments uređivanje zaglavlja').comment).toBe('Assignments uređivanje zaglavlja');
    expect(byName('Popravak web servisa').comment).toBe('Ažuriranje, Zatvaranje');
    expect(byName('TFVC-PROBE-P4-1').comment).toBe('Probe shelveset čćžšđ\nsecond line %PATH%');
  });

  it('reads a shelveset with only <Links> as having no comment', () => {
    expect(byName('CodeReview_2023-12-21_03.15.49.7918').comment).toBe('');
  });

  it('keeps a name and a comment of digits as text', () => {
    const xml = '<Shelvesets><Shelveset date="d" name="2026" owner="a" ownerdisp="A" owneruniq="a"><Comment>007</Comment></Shelveset></Shelvesets>';
    const [s] = parseShelvesets(Buffer.from(xml));
    expect(s.name).toBe('2026');
    expect(s.comment).toBe('007');
  });

  it('reads an empty listing as none, and refuses something that is not a listing', () => {
    expect(parseShelvesets(Buffer.from('<Shelvesets />'))).toEqual([]);
    expect(() => parseShelvesets(fixture('status-shelveset.xml'))).toThrow();
  });
});

describe('parseShelvedChanges (spec S2b)', () => {
  it('reads an edit on its base, and an add with no base', () => {
    const changes = parseShelvedChanges(fixture('status-shelveset.xml'));
    expect(changes).toHaveLength(3);
    const [startup, hello, added] = changes;
    expect(startup.serverItem).toBe('$/Shop/Shop2023/Enterprise.Till.Server/Startup.cs');
    expect([...startup.changes]).toEqual(['Edit']);
    expect(startup.version).toBe(18319);
    expect(startup.encoding).toBe(65001);
    expect(hello.encoding).toBe(1250);
    expect(hello.version).toBe(18312);
    expect([...added.changes].sort()).toEqual(['Add', 'Edit', 'Encoding']);
    expect(added.version).toBeUndefined();
    expect(added.itemId).toBe(-1026);
    expect(added.sourceItem).toBeUndefined();
    expect('localPath' in added).toBe(false);
  });

  it('reads a rename with where it came from, and a binary delete', () => {
    const changes = parseShelvedChanges(fixture('status-shelveset-rename-delete.xml'));
    const rename = changes.find((c) => c.changes.has('Rename'))!;
    expect(rename.serverItem).toBe('$/Shop/Shop2023/Enterprise.Till.Server/Web/assets/date2.js');
    expect(rename.sourceItem).toBe('$/Shop/Shop2023/Enterprise.Till.Server/Web/assets/date.js');
    const del = changes.find((c) => c.changes.has('Delete'))!;
    expect(del.encoding).toBe(-1);
    expect(del.version).toBe(18312);
  });

  it("refuses a workspace's own status: those are pending changes, not shelved ones", () => {
    expect(() => parseShelvedChanges(fixture('status-mixed.xml'))).toThrow();
  });

  it('reads an empty status as no changes', () => {
    expect(parseShelvedChanges(Buffer.from('<Status />'))).toEqual([]);
  });
});
