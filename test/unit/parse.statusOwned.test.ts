import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseStatus, parseStatusOwned } from '../../src/tf/parse.js';

const fixture = (name: string) => readFileSync(join(__dirname, '../fixtures', name));

describe('parseStatusOwned (status /user:*, phase 3 part 2 design Q5)', () => {
  it('keeps who, on which computer and in which workspace, for every change', () => {
    const changes = parseStatusOwned(fixture('windows/status-folder-star-allusers.xml'));
    expect(changes).toHaveLength(5);
    const xml = changes.filter((c) => c.serverItem.endsWith('/Enterprise.Till.Server.xml'));
    expect(xml.map((c) => c.owner)).toEqual(['Filip', 'Boris', 'Ivan', 'Zoran']);
    const boris = changes.find((c) => c.owner === 'Boris' && c.serverItem.endsWith('.vspscc'))!;
    expect(boris.computer).toBe('BORIS');
    expect(boris.workspace).toBe('BORIS');
    expect([...boris.changes]).toEqual(['Edit']);
  });

  it('reads the FEDORA capture the same way', () => {
    expect(parseStatusOwned(fixture('fedora/status-folder-star-allusers.xml'))).toEqual(
      parseStatusOwned(fixture('windows/status-folder-star-allusers.xml')),
    );
  });

  it('reads an empty <Status /> as no changes', () => {
    expect(parseStatusOwned(fixture('windows/status-journals.xml'))).toEqual([]);
  });

  it('leaves parseStatus exactly as it was: the same changes, with no owner fields', () => {
    const plain = parseStatus(fixture('windows/status-folder-star-allusers.xml'));
    expect(plain).toHaveLength(5);
    expect(plain.some((c) => 'owner' in c || 'computer' in c || 'workspace' in c)).toBe(false);
    const owned = parseStatusOwned(fixture('windows/status-folder-star-allusers.xml'));
    expect(owned.map(({ owner, computer, workspace, ...rest }) => rest)).toEqual(plain);
  });
});
