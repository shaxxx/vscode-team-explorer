import { describe, it, expect } from 'vitest';
import { planRename, planDelete, validateName, renamedPath, nameOfPath } from '../../src/fileops/renamePlan.js';
import { S } from '../../src/tf/strings.js';

const versioned = {
  oldPath: 'C:\\t\\a.txt',
  newPath: 'C:\\t\\b.txt',
  oldServerPath: '$/T/a.txt',
  newServerPath: '$/T/b.txt',
  wasVersioned: true,
};

describe('planRename', () => {
  it('records a rename when both sides are mapped and the item was in TFVC', () => {
    expect(planRename(versioned)).toEqual({
      kind: 'rename',
      oldPath: 'C:\\t\\a.txt',
      newPath: 'C:\\t\\b.txt',
    });
  });

  it('stays silent for a file TFVC never had', () => {
    expect(planRename({ ...versioned, wasVersioned: false })).toEqual({ kind: 'ignore', reason: 'notVersioned' });
  });

  it('stays silent when either side is outside the mappings', () => {
    expect(planRename({ ...versioned, oldServerPath: undefined })).toEqual({ kind: 'ignore', reason: 'notMapped' });
    expect(planRename({ ...versioned, newServerPath: undefined })).toEqual({ kind: 'ignore', reason: 'leavesWorkspace' });
  });

  it('stays silent when nothing moved, but records a change of case (design R4)', () => {
    expect(planRename({ ...versioned, newPath: 'C:\\t\\a.txt', newServerPath: '$/T/a.txt' })).toEqual({
      kind: 'ignore',
      reason: 'sameItem',
    });
    expect(planRename({ ...versioned, newPath: 'C:\\t\\A.txt', newServerPath: '$/T/A.txt' }).kind).toBe('rename');
  });
});

describe('planDelete', () => {
  it('keeps the versioned, mapped paths and drops the rest', () => {
    expect(
      planDelete([
        { path: 'C:\\t\\a.txt', serverPath: '$/T/a.txt', wasVersioned: true },
        { path: 'C:\\t\\new.txt', serverPath: '$/T/new.txt', wasVersioned: false },
        { path: 'D:\\other\\x.txt', serverPath: undefined, wasVersioned: true },
        { path: 'C:\\t\\sub', serverPath: '$/T/sub', wasVersioned: true },
      ]),
    ).toEqual({ kind: 'delete', paths: ['C:\\t\\a.txt', 'C:\\t\\sub'] });
  });

  it('stays silent when nothing qualifies', () => {
    expect(planDelete([{ path: 'C:\\t\\new.txt', serverPath: '$/T/new.txt', wasVersioned: false }])).toEqual({
      kind: 'ignore',
      reason: 'notVersioned',
    });
    expect(planDelete([])).toEqual({ kind: 'ignore', reason: 'notVersioned' });
  });
});

describe('validateName', () => {
  const siblings = ['a.txt', 'Web'];

  it('accepts an ordinary new name, and the same name in another case', () => {
    expect(validateName('b.txt', 'a.txt', siblings)).toBeUndefined();
    expect(validateName('A.TXT', 'a.txt', siblings)).toBeUndefined();
  });

  it('accepts a leading dot: dotfiles are legal names (review)', () => {
    expect(validateName('.gitignore', 'a.txt', [])).toBeUndefined();
  });

  it('refuses empty, the TFVC characters, edges, length and a name already there', () => {
    expect(validateName('', 'a.txt', siblings)).toBe(S.fileOpsBadNameEmpty);
    expect(validateName('   ', 'a.txt', siblings)).toBe(S.fileOpsBadNameEdge);
    for (const bad of ['a/b', 'a\\b', 'a:b', 'a*b', 'a?b', 'a"b', 'a<b', 'a>b', 'a|b', 'a$b', 'a\tb']) {
      expect(validateName(bad, 'a.txt', siblings), bad).toBe(S.fileOpsBadNameChars);
    }
    expect(validateName(' a.txt', 'a.txt', siblings)).toBe(S.fileOpsBadNameEdge);
    expect(validateName('a.txt ', 'a.txt', siblings)).toBe(S.fileOpsBadNameEdge);
    expect(validateName('a.txt.', 'a.txt', siblings)).toBe(S.fileOpsBadNameEdge);
    expect(validateName('x'.repeat(256), 'a.txt', siblings)).toBe(S.fileOpsBadNameLong);
    expect(validateName('web', 'a.txt', siblings)).toBe(S.fileOpsBadNameTaken('web'));
  });
});

describe('path helpers', () => {
  it('keeps the separator the path already uses', () => {
    expect(renamedPath('C:\\t\\a.txt', 'b.txt')).toBe('C:\\t\\b.txt');
    expect(renamedPath('/home/shax/work/a.txt', 'b.txt')).toBe('/home/shax/work/b.txt');
    expect(renamedPath('a.txt', 'b.txt')).toBe('b.txt');
  });

  it('strips a trailing separator so a folder rename does not land inside itself (review)', () => {
    expect(renamedPath('C:\\t\\sub\\', 'newsub')).toBe('C:\\t\\newsub');
    expect(renamedPath('/home/shax/sub/', 'newsub')).toBe('/home/shax/newsub');
  });

  it('reads the last segment whichever separator is used', () => {
    expect(nameOfPath('C:\\t\\a.txt')).toBe('a.txt');
    expect(nameOfPath('/home/shax/a.txt')).toBe('a.txt');
    expect(nameOfPath('C:\\t\\sub\\')).toBe('sub');
  });
});
