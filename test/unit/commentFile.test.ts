import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { writeCommentFile } from '../../src/commands/commentFile.js';

describe('writeCommentFile', () => {
  it('writes the comment verbatim, including the characters cmd would mangle', () => {
    const comment = 'R&D branch merge 100% done <final> | %PATH%';
    const f = writeCommentFile(comment);
    try {
      const text = readFileSync(f.path, 'utf8').replace(/^﻿/, '');
      expect(text).toBe(comment);
    } finally {
      f.dispose();
    }
  });

  it('preserves a multi-line comment, which the command line truncated', () => {
    const comment = 'Fix TF14098\n\nSee bug 1234';
    const f = writeCommentFile(comment);
    try {
      expect(readFileSync(f.path, 'utf8').replace(/^﻿/, '')).toBe(comment);
    } finally {
      f.dispose();
    }
  });

  it('preserves Croatian characters', () => {
    const comment = 'Ispravljeno čćžšđ ČĆŽŠĐ u računu';
    const f = writeCommentFile(comment);
    try {
      expect(readFileSync(f.path, 'utf8').replace(/^﻿/, '')).toBe(comment);
    } finally {
      f.dispose();
    }
  });

  it('writes a BOM — the opposite of pat.txt, because tf.exe is .NET and detects one', () => {
    const f = writeCommentFile('hello');
    try {
      const bytes = readFileSync(f.path);
      expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xef, 0xbb, 0xbf]);
    } finally {
      f.dispose();
    }
  });

  it('dispose removes the file and its directory', () => {
    const f = writeCommentFile('x');
    const dir = dirname(f.path);
    expect(existsSync(f.path)).toBe(true);
    f.dispose();
    expect(existsSync(dir)).toBe(false);
  });

  it('dispose is safe to call twice', () => {
    const f = writeCommentFile('x');
    f.dispose();
    expect(() => f.dispose()).not.toThrow();
  });
});
