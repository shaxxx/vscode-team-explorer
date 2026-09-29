import { describe, it, expect } from 'vitest';
import { S } from '../../src/tf/strings.js';

describe('phase 3 part 3 strings', () => {
  it('has a menu label for Rename and Delete', () => {
    expect(S.sceLabels.rename).toBe('Rename…');
    expect(S.sceLabels.delete).toBe('Delete');
  });

  it('says what a failed rename left behind, and never undoes the user own rename', () => {
    const message = S.fileOpsRenameFailed('b.txt', 'TF10141: no.');
    expect(message).toContain('b.txt');
    expect(message).toContain('TF10141: no.');
    expect(message.toLowerCase()).toContain('tfvc did not record');
    expect(S.fileOpsRenameFailed('b.txt', 'why')).toMatch(/was renamed/);
  });

  it('names up to three deleted items, then counts the rest', () => {
    expect(S.fileOpsDeleteConfirmFile(['a', 'b'])).toBe('Delete a, b?');
    expect(S.fileOpsDeleteConfirmFolder(['a'])).toBe('Delete a and everything in it?');
    expect(S.fileOpsDeleteFailed(['a', 'b', 'c', 'd'], 'why')).toContain('a, b, c and 1 more');
  });

  it('tells the user what a pending delete means before they confirm it', () => {
    expect(S.fileOpsDeleteDetail).toContain('Undo Pending Changes…');
    expect(S.fileOpsDeleteDetail).toContain('until you check in');
    expect(S.fileOpsDeleteYes).toBe('Delete');
  });

  it('has one message per name rule', () => {
    for (const s of [S.fileOpsBadNameEmpty, S.fileOpsBadNameChars, S.fileOpsBadNameEdge, S.fileOpsBadNameLong]) {
      expect(typeof s).toBe('string');
      expect(s.length).toBeGreaterThan(0);
    }
    expect(S.fileOpsBadNameTaken('a.txt')).toContain('a.txt');
    for (const c of ['$', '/', '\\', ':', '*', '?', '"', '<', '>', '|']) {
      expect(S.fileOpsBadNameChars).toContain(c);
    }
    expect(S.fileOpsBadNameChars.toLowerCase()).toContain('tab');
    expect(S.fileOpsBadNameLong).toContain('255');
    expect(S.fileOpsBadNameEdge.toLowerCase()).toContain('space');
    expect(S.fileOpsBadNameEdge.toLowerCase()).toContain('dot');
  });

  it('has one message per repair refusal: old name taken, or new path gone', () => {
    expect(S.fileOpsRepairBlocked('c.txt')).toContain('c.txt');
    expect(S.fileOpsRepairBlocked('c.txt').toLowerCase()).toContain('did not record the rename');
    expect(S.fileOpsRepairMissing('c.txt')).toContain('c.txt');
    expect(S.fileOpsRepairMissing('c.txt').toLowerCase()).toContain('did not record the rename');
    expect(S.fileOpsRepairBlocked('c.txt')).not.toBe(S.fileOpsRepairMissing('c.txt'));
  });

  it('says the item is now under its OLD name when a failed rename cannot even be restored', () => {
    const message = S.fileOpsRestoreBlocked('a.txt', 'b.txt');
    expect(message).toContain('a.txt');
    expect(message).toContain('b.txt');
    expect(message.toLowerCase()).toContain('old name');
    expect(message).not.toBe(S.fileOpsRepairBlocked('b.txt'));
    expect(message).not.toBe(S.fileOpsRepairMissing('b.txt'));
  });
});
