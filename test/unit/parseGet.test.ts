import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { classifyGetLine, lineSplitter } from '../../src/tf/parseGet.js';

const fixture = (name: string) => readFileSync(join(__dirname, '../fixtures', name));

describe('classifyGetLine', () => {
  it('classifies each kind of line tf prints', () => {
    expect(classifyGetLine('Z:\\tmp\\tfvc-probe-ws\\assets:')).toBe('folder');
    expect(classifyGetLine('C:\\work\\Shop:')).toBe('folder');
    expect(classifyGetLine('Getting smiley.jpg')).toBe('getting');
    expect(classifyGetLine('Replacing frmInvoice.vb')).toBe('replacing');
    expect(classifyGetLine('Deleting old.txt')).toBe('deleting');
    expect(classifyGetLine('All files are up to date.')).toBe('upToDate');
    expect(classifyGetLine('')).toBe('other');
    expect(classifyGetLine('Conflict frmInvoice.vb - Unable to perform the get operation')).toBe('other');
  });
});

describe('lineSplitter', () => {
  it('yields whole lines from the real capture even when a chunk ends mid-line', () => {
    const bytes = fixture('fedora/get-recursive.txt');
    const lines: string[] = [];
    const split = lineSplitter((l) => lines.push(l));

    split.push(bytes.subarray(0, 37));
    split.push(bytes.subarray(37));
    split.end();

    const kinds = lines.map(classifyGetLine);
    expect(kinds.filter((k) => k === 'folder')).toHaveLength(2);
    expect(kinds.filter((k) => k === 'getting')).toHaveLength(3);
    expect(lines.every((l) => !l.includes('\r'))).toBe(true);
  });

  it('reads the up-to-date answer', () => {
    const lines: string[] = [];
    const split = lineSplitter((l) => lines.push(l));
    split.push(fixture('fedora/get-up-to-date.txt'));
    split.end();

    expect(lines.map(classifyGetLine)).toContain('upToDate');
  });

  it('keeps a multi-byte character split across chunks intact', () => {
    const lines: string[] = [];
    const split = lineSplitter((l) => lines.push(l));
    const bytes = Buffer.from('Getting Urudžbeni.txt\r\n', 'utf8');
    const cut = bytes.indexOf(0xc5) + 1;

    split.push(bytes.subarray(0, cut));
    split.push(bytes.subarray(cut));
    split.end();

    expect(lines).toEqual(['Getting Urudžbeni.txt']);
  });

  it('moves on past a line whose callback throws, instead of repeating it', () => {
    const lines: string[] = [];
    const split = lineSplitter((l) => {
      lines.push(l);
      if (l === 'b') throw new Error('boom');
    });

    expect(() => split.push(Buffer.from('a\nb\nc\n'))).toThrow();
    split.push(Buffer.from('d\n'));
    split.end();

    // `c` was still pending when `b` threw; it arrives with the next chunk, and `b` is never repeated.
    expect(lines).toEqual(['a', 'b', 'c', 'd']);
  });

  it('flushes a last line with no newline at end()', () => {
    const lines: string[] = [];
    const split = lineSplitter((l) => lines.push(l));
    split.push(Buffer.from('Getting a.txt'));
    split.end();

    expect(lines).toEqual(['Getting a.txt']);
  });
});
