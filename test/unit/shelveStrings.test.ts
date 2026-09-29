import { describe, it, expect } from 'vitest';
import { S } from '../../src/tf/strings.js';

describe('phase 4 strings', () => {
  it('names the shelveset and counts what was shelved', () => {
    expect(S.shelveDone('fiskal', 1)).toBe('Shelved 1 change as "fiskal".');
    expect(S.shelveDone('fiskal', 3)).toBe('Shelved 3 changes as "fiskal".');
    expect(S.shelveDoneUndone('fiskal', 2)).toContain('undid them');
    expect(S.shelveNamePrompt(2)).toContain('2 included changes');
  });

  it('quotes a shelveset name that itself contains spaces', () => {
    expect(S.shelveDone('A B', 2)).toBe('Shelved 2 changes as "A B".');
    expect(S.shelvedRight('A B')).toBe('shelveset "A B"');
  });

  it('keeps tf text in the failure messages', () => {
    expect(S.shelveFailed('x', 'TF10141: no.')).toContain('TF10141: no.');
    expect(S.unshelveFailed('x', 'why')).toContain('why');
    expect(S.shelvesetDeleteFailed('x', 'why')).toContain('why');
  });

  it('says what the two Shelve modes do before the user picks one', () => {
    expect(S.shelveKeepDetail).toMatch(/nothing changes/i);
    expect(S.shelveUndoDetail).toMatch(/removed from disk/i);
    expect(S.shelveUndoDetail).toMatch(/shelveset/i);
  });

  it('says a deleted shelveset cannot come back', () => {
    expect(S.shelvesetDeleteDetail).toMatch(/cannot be restored/i);
    expect(S.shelvesetDeleteYes).toBe('Delete');
  });

  it('has the tab labels the page reads', () => {
    for (const key of ['owner', 'find', 'filter', 'refresh', 'unshelve', 'preserve', 'delete', 'compareUnmodified', 'compareWorkspace', 'viewShelved'] as const) {
      expect(S.shelvesetsLabels[key].length, key).toBeGreaterThan(0);
    }
    expect(S.shelvesetsLabels.preserve).toBe('Preserve shelveset on server');
  });

  it('says why a shelveset was kept after an unshelve', () => {
    expect(S.unshelveKept('fiskal', S.unshelveKeptConflicts)).toBe('"fiskal" was kept on the server: the unshelve left conflicts.');
    expect(S.unshelveKeptMissing(['a.cs', 'b.cs'])).toContain('a.cs, b.cs');
  });
});
