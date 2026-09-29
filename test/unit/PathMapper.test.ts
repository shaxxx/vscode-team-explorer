import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PathMapper } from '../../src/tf/PathMapper.js';
import { parseWorkspaces } from '../../src/tf/parse.js';

const fixture = (name: string) =>
  readFileSync(join(__dirname, '../fixtures', name));

const windowsMapper = () =>
  new PathMapper(parseWorkspaces(fixture('windows/workspaces.xml'))[0].folders, 'win32');

const fedoraMapper = () =>
  new PathMapper(parseWorkspaces(fixture('fedora/workspaces.xml'))[0].folders, 'linux');

describe('PathMapper on Windows', () => {
  it('maps a local path under the root mapping to a server path', () => {
    expect(windowsMapper().toServerPath('C:\\work\\Shop\\Potpisivanje.cs'))
      .toBe('$/Shop/Potpisivanje.cs');
  });

  it('finding 6: compares case-insensitively (tf mixes C:\\work and c:\\work)', () => {
    expect(windowsMapper().toServerPath('c:\\WORK\\Shop\\Potpisivanje.cs'))
      .toBe('$/Shop/Potpisivanje.cs');
  });

  it('prefers the longest matching mapping, not the first', () => {
    // This path is NOT under C:\work — the two mappings are not nested.
    expect(windowsMapper().toServerPath(
      'C:\\Users\\user1\\Downloads\\Insight.Database-main\\Insight.Database\\Foo.cs',
    )).toBe('$/Vesta/DatabaseFirst/Insight.Database/Foo.cs');
  });

  it('round-trips a server path back to the local path', () => {
    expect(windowsMapper().toLocalPath('$/Shop/Potpisivanje.cs'))
      .toBe('C:\\work\\Shop\\Potpisivanje.cs');
  });

  it('matches a server path case-insensitively, so it picks the right mapping', () => {
    // Worse than returning undefined: the specific mapping
    // `$/Vesta/DatabaseFirst` is skipped on a case mismatch and the catch-all
    // `$/` mapping matches instead, so the file resolves under C:\work —
    // silently, to a path on a different part of the disk entirely.
    expect(windowsMapper().toLocalPath('$/vesta/databasefirst/Insight.Database/Foo.cs'))
      .toBe('C:\\Users\\user1\\Downloads\\Insight.Database-main\\Insight.Database\\Foo.cs');
  });

  it('returns undefined for a path outside every mapping', () => {
    expect(windowsMapper().toServerPath('D:\\elsewhere\\x.cs')).toBeUndefined();
  });

  it('maps the mapping root itself to $/', () => {
    expect(windowsMapper().toServerPath('C:\\work')).toBe('$/');
  });

  it('localRootFor: returns the containing mapping\'s own local root', () => {
    expect(windowsMapper().localRootFor('C:\\work\\Shop\\Potpisivanje.cs'))
      .toBe('C:\\work');
  });

  it('localRootFor: prefers the deepest (most specific) mapping, like toServerPath does', () => {
    expect(windowsMapper().localRootFor(
      'C:\\Users\\user1\\Downloads\\Insight.Database-main\\Insight.Database\\Foo.cs',
    )).toBe('C:\\Users\\user1\\Downloads\\Insight.Database-main\\Insight.Database');
  });

  it('localRootFor: prefers the deepest of two NESTED mappings (review item 8)', () => {
    // The fixture's two mappings are NOT nested -- a path under one is never
    // under the other -- so the test above cannot actually fail if "prefer
    // the deepest" regressed to "prefer the first" or "prefer the longest
    // STRING" (coincidentally still correct there). These two mappings really
    // do both contain the probed path, so only a genuine deepest-wins
    // implementation passes.
    const mapper = new PathMapper(
      [
        { serverItem: '$/', localPath: 'C:\\work' },
        { serverItem: '$/Proj', localPath: 'C:\\work\\Proj\\sub' },
      ],
      'win32',
    );
    expect(mapper.localRootFor('C:\\work\\Proj\\sub\\deep\\file.cs'))
      .toBe('C:\\work\\Proj\\sub');
    // A sibling of "sub", still under the outer mapping only.
    expect(mapper.localRootFor('C:\\work\\Proj\\other\\file.cs')).toBe('C:\\work');
  });

  it('localRootFor: returns undefined for a path outside every mapping', () => {
    expect(windowsMapper().localRootFor('D:\\elsewhere\\x.cs')).toBeUndefined();
  });
});

describe('PathMapper on Fedora', () => {
  it('converts a POSIX path through the Z: prefix to a server path', () => {
    expect(fedoraMapper().toServerPath('/home/shax/work/Shop/Potpisivanje.cs'))
      .toBe('$/Shop/Potpisivanje.cs');
  });

  it('round-trips a server path back to a POSIX path', () => {
    expect(fedoraMapper().toLocalPath('$/Shop/Potpisivanje.cs'))
      .toBe('/home/shax/work/Shop/Potpisivanje.cs');
  });

  it('matches a server path case-insensitively here too', () => {
    // Server-path casing is TFVC's rule, not the filesystem's, so this does
    // NOT follow the platform the way the local-path comparison does — the
    // POSIX test directly below stays case-SENSITIVE.
    //
    // Built by hand rather than from the fixture: the captured Fedora
    // workspace maps only `$/`, which matches whatever its case, so a fixture
    // test here would pass against a case-sensitive comparison too.
    const mapper = new PathMapper(
      [{ serverItem: '$/Shop', localPath: 'Z:\\home\\shax\\work\\Shop' }],
      'linux',
    );
    expect(mapper.toLocalPath('$/shop/Potpisivanje.cs'))
      .toBe('/home/shax/work/Shop/Potpisivanje.cs');
  });

  it('is case-SENSITIVE for the POSIX portion', () => {
    expect(fedoraMapper().toServerPath('/home/shax/WORK/Shop/x.cs')).toBeUndefined();
  });

  it('localRootFor: maps the Wine Z: form back to the LOCAL (POSIX) root', () => {
    // The fixture's one mapping is stored as "Z:\home\shax\work" (WorkingFolder
    // is always in wine/local-drive form); localRootFor must hand back the
    // POSIX form, via fromWinePath, not the raw Z: string.
    expect(fedoraMapper().localRootFor('/home/shax/work/Shop/Potpisivanje.cs'))
      .toBe('/home/shax/work');
  });

  it('localRootFor: returns undefined outside every mapping, on Linux too', () => {
    expect(fedoraMapper().localRootFor('/home/shax/elsewhere/x.cs')).toBeUndefined();
  });
});
