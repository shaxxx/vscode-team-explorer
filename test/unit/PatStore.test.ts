import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writePatFile } from '../../src/pat/PatStore.js';

let dir: string;

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'patstore-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('writePatFile', () => {
  it('writes the token with NO BOM — a BOM would become part of the token', () => {
    const file = join(dir, 'pat.txt');
    writePatFile(file, 'abc123');

    const bytes = readFileSync(file);
    expect(bytes[0]).not.toBe(0xef);
    expect(bytes.toString('utf8').split(/\r?\n/)[0]).toBe('abc123');
  });

  it('creates the parent directory when missing', () => {
    const file = join(dir, 'nested', '.tfs', 'pat.txt');
    writePatFile(file, 'abc123');
    expect(existsSync(file)).toBe(true);
  });

  it('trims surrounding whitespace from a pasted token', () => {
    const file = join(dir, 'pat.txt');
    writePatFile(file, '  abc123\n');
    expect(readFileSync(file, 'utf8').split(/\r?\n/)[0]).toBe('abc123');
  });

  it('overwrites an existing file rather than appending', () => {
    const file = join(dir, 'pat.txt');
    writePatFile(file, 'first');
    writePatFile(file, 'second');
    expect(readFileSync(file, 'utf8').split(/\r?\n/)[0]).toBe('second');
  });
});
