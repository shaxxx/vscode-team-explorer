import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isReadOnly } from '../../src/watch/readOnly.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'readonly-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('isReadOnly', () => {
  it('reports a writable file as not read-only', () => {
    const f = join(dir, 'a.txt');
    writeFileSync(f, 'x');
    expect(isReadOnly(f)).toBe(false);
  });

  it('reports a read-only file as read-only — the checked-in state in TFVC', () => {
    const f = join(dir, 'b.txt');
    writeFileSync(f, 'x');
    chmodSync(f, constants.S_IRUSR);
    expect(isReadOnly(f)).toBe(true);
    chmodSync(f, constants.S_IRUSR | constants.S_IWUSR); // so cleanup can delete it
  });

  it('returns false rather than throwing for a missing file', () => {
    expect(isReadOnly(join(dir, 'nope.txt'))).toBe(false);
  });
});
