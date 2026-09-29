import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseWorkspaces } from '../../src/tf/parse.js';

const fixture = (name: string) =>
  readFileSync(join(__dirname, '../fixtures', name));

describe('parseWorkspaces', () => {
  it('reads the Windows workspace with its two non-nested mappings', () => {
    const [ws] = parseWorkspaces(fixture('windows/workspaces.xml'));

    expect(ws.name).toBe('DEVPC');
    expect(ws.computer).toBe('DEVPC');
    expect(ws.folders).toHaveLength(2);
    expect(ws.folders).toContainEqual({
      localPath: 'C:\\work',
      serverItem: '$/',
    });
    expect(ws.folders).toContainEqual({
      localPath: 'C:\\Users\\user1\\Downloads\\Insight.Database-main\\Insight.Database',
      serverItem: '$/Vesta/DatabaseFirst/Insight.Database',
    });
  });

  it('reads the Fedora workspace with its single Z: mapping', () => {
    const [ws] = parseWorkspaces(fixture('fedora/workspaces.xml'));

    expect(ws.name).toBe('Fedora');
    expect(ws.computer).toBe('FEDORA');
    expect(ws.folders).toEqual([
      { localPath: 'Z:\\home\\shax\\work', serverItem: '$/' },
    ]);
  });

  it('reads the owner display name, for the Manage Workspace title', () => {
    const [ws] = parseWorkspaces(fixture('windows/workspaces.xml'));

    expect(ws.owner).toBe('Filip');
  });

  it('reads the owner aliases, which say which shelvesets are mine (phase 4)', () => {
    const [ws] = parseWorkspaces(fixture('fedora/workspaces.xml'));
    expect(ws.ownerAliases).toEqual(['user@example.com', 'user@example.com', 'Filip']);
  });

  it('reads a workspace with no <OwnerAliases> as having none', () => {
    const xml = '<Workspaces><Workspace computer="C" name="W" ownerdisp="X"><Folders /></Workspace></Workspaces>';
    expect(parseWorkspaces(Buffer.from(xml))[0].ownerAliases).toEqual([]);
  });

  it('keeps an owner alias that looks like a number as text', () => {
    const xml =
      '<Workspaces><Workspace computer="C" name="W" ownerdisp="X"><Folders /><OwnerAliases><string>007</string><string>1e3</string></OwnerAliases></Workspace></Workspaces>';
    expect(parseWorkspaces(Buffer.from(xml))[0].ownerAliases).toEqual(['007', '1e3']);
  });
});
