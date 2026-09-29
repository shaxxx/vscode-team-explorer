import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseDir } from '../../src/tf/parseDir.js';

const fixture = (name: string) => readFileSync(join(__dirname, '../fixtures', name), 'utf8');

describe('parseDir', () => {
  it('reads the root listing: folders are the $-prefixed lines', () => {
    const dir = parseDir(fixture('windows/dir-root.txt'));

    expect(dir.path).toBe('$/');
    expect(dir.folders).toContain('Partners');
    expect(dir.folders).toContain('Extra Revenue');
    expect(dir.folders.every((f) => !f.startsWith('$'))).toBe(true);
  });

  it('keeps a non-ASCII path and separates files from folders', () => {
    const dir = parseDir(fixture('fedora/dir-croatian.txt'));

    expect(dir.path).toBe('$/Urudžbeni zapisnik');
    expect(dir.folders).toEqual([
      'ForeignIdSignTool',
      'OcrToolkitNET472',
      'Urudzbeni',
      'Urudzbeni.Sandbox',
      'Urudzbeni.REGIT',
    ]);
    expect(dir.files).toEqual(['Urudzbeni.sln']);
  });

  it('reads an empty folder', () => {
    expect(parseDir('$/Empty:\r\n\r\n0 item(s)\r\n')).toEqual({ path: '$/Empty', folders: [], files: [] });
  });

  it('refuses text that is not a dir listing', () => {
    expect(() => parseDir('TF10122: The path is not found.\r\n')).toThrow();
  });
});
