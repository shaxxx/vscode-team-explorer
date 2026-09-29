import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseInfo } from '../../src/tf/parseInfo.js';

const fixture = (name: string) => readFileSync(join(__dirname, '../fixtures', name)).toString('utf8');

describe('parseInfo', () => {
  it("reads every item of a folder and skips the folder's own block, whose server half is empty (design Q2)", () => {
    const items = parseInfo(fixture('windows/info-folder-star.txt'));
    expect(items).toHaveLength(23);
    expect(items.some((i) => i.serverPath === '$/Shop/Shop2023/Enterprise.Till.Server')).toBe(false);
    expect(items.every((i) => i.serverPath.startsWith('$/Shop/Shop2023/Enterprise.Till.Server/'))).toBe(true);
  });

  it('reads a downloaded file: both changesets, the verbatim Croatian date, file type and size', () => {
    const item = parseInfo(fixture('windows/info-folder-star.txt')).find((i) =>
      i.serverPath.endsWith('/AddApiVersionControllerConvention.cs'),
    );
    expect(item).toEqual({
      serverPath: '$/Shop/Shop2023/Enterprise.Till.Server/AddApiVersionControllerConvention.cs',
      type: 'file',
      localPath: 'C:\\work\\Shop\\Shop2023\\Enterprise.Till.Server\\AddApiVersionControllerConvention.cs',
      localChangeset: 15661,
      localChange: 'none',
      serverChangeset: 15661,
      lock: 'none',
      lastModified: '10. studenog 2023. 8:27:45',
      fileType: 'utf-8',
      size: 837,
    });
  });

  it('reads a folder item: no file type, no size', () => {
    const web = parseInfo(fixture('windows/info-folder-star.txt')).find((i) => i.serverPath.endsWith('/Web'))!;
    expect(web.type).toBe('folder');
    expect(web.serverChangeset).toBe(18312);
    expect(web.lastModified).toBe('21. ožujka 2025. 12:08:14');
    expect(web.fileType).toBeUndefined();
    expect(web.size).toBeUndefined();
  });

  it("keeps the local half's pending change", () => {
    const xml = parseInfo(fixture('windows/info-folder-star.txt')).find((i) =>
      i.serverPath.endsWith('/Enterprise.Till.Server.xml'),
    )!;
    expect(xml.localChange).toBe('edit');
  });

  it('reads the Wine capture: Z: local paths and English dates (design Q4)', () => {
    const items = parseInfo(fixture('fedora/info-folder-star.txt'));
    expect(items).toHaveLength(23);
    const item = items.find((i) => i.serverPath.endsWith('/AddApiVersionControllerConvention.cs'))!;
    expect(item.localPath).toBe(
      'Z:\\home\\shax\\work\\Shop\\Shop2023\\Enterprise.Till.Server\\AddApiVersionControllerConvention.cs',
    );
    expect(item.lastModified).toBe('Friday, November 10, 2023 8:27:45 AM');
  });

  it('reads items never downloaded: an empty local half means no local changeset (design Q3, Q8)', () => {
    const items = parseInfo(fixture('fedora/info-not-downloaded.txt'));
    expect(items.map((i) => i.serverPath).sort()).toEqual(
      ['$/Ledger/CLAUDE.md', '$/Ledger/Ledger.sln', '$/Ledger/Ledger.sqlproj', '$/Ledger/Security', '$/Ledger/dbo', '$/Ledger/docs'].sort(),
    );
    for (const i of items) {
      expect(i.localChangeset).toBeUndefined();
      expect(i.localPath).toBeUndefined();
      expect(i.localChange).toBe('');
    }
    expect(items.find((i) => i.serverPath === '$/Ledger/Ledger.sqlproj')!.serverChangeset).toBe(20783);
    expect(items.find((i) => i.serverPath === '$/Ledger/dbo')!.type).toBe('folder');
  });

  it('returns nothing for empty output, and accepts LF line ends', () => {
    expect(parseInfo('')).toEqual([]);
    const lf = fixture('windows/info-folder-star.txt').replace(/\r\n/g, '\n');
    expect(parseInfo(lf)).toHaveLength(23);
  });

  it('tells the local changeset apart from the server one, and keeps blocks from leaking into each other', () => {
    const text = [
      'Local information:',
      '  Local path : C:\\x\\a.txt',
      '  Changeset  : 100',
      '  Change     : edit',
      'Server information:',
      '  Server path  : $/X/a.txt',
      '  Changeset    : 120',
      '  Type         : file',
      'Local information:',
      '  Local path : C:\\y\\b.txt',
      '  Changeset  : 200',
      '  Change     : none',
      'Server information:',
      '  Server path  : $/X/b.txt',
      '  Changeset    : 220',
      '  Type         : file',
      '',
    ].join('\r\n');
    const items = parseInfo(text);
    const a = items.find((i) => i.serverPath === '$/X/a.txt')!;
    expect(a.localChangeset).toBe(100);
    expect(a.serverChangeset).toBe(120);
    expect(a.localChange).toBe('edit');
    const b = items.find((i) => i.serverPath === '$/X/b.txt')!;
    expect(b.localChangeset).toBe(200);
    expect(b.serverChangeset).toBe(220);
    expect(b.localChange).toBe('none');
  });

  it('throws on a server changeset that is not a number, naming the item, rather than guessing', () => {
    const text = [
      'Local information:',
      '  Local path : ',
      '  Server path: ',
      '  Changeset  : 0',
      '  Change     : none',
      '  Type       : ',
      'Server information:',
      '  Server path  : $/X/a.txt',
      '  Changeset    : ???',
      '  Type         : file',
      '',
    ].join('\r\n');
    expect(() => parseInfo(text)).toThrow('$/X/a.txt');
  });
});
