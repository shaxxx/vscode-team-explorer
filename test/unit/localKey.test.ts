import { describe, it, expect } from 'vitest';
import { localKey } from '../../src/tf/PathMapper.js';

describe('the local-path key', () => {
  it('lower-cases on Windows, absolutely and not merely consistently', () => {
    // Asserting a relationship is not enough: `toUpperCase()` would satisfy
    // "these two agree" while breaking every lookup against a Map built by
    // the real implementation.
    expect(localKey('C:\\work\\Vesta\\File.vb', 'win32')).toBe('c:\\work\\vesta\\file.vb');
  });

  it('collapses the casing tf actually emits', () => {
    // One real capture mixed `C:\work` 79,920 times with `c:\work` 9 times.
    expect(localKey('C:\\work\\Vesta\\File.vb', 'win32'))
      .toBe(localKey('c:\\WORK\\vesta\\file.VB', 'win32'));
  });

  it('returns the path untouched on Linux', () => {
    expect(localKey('/home/shax/work/File.vb', 'linux')).toBe('/home/shax/work/File.vb');
  });

  it('leaves case alone on Linux, where two such paths are two files', () => {
    expect(localKey('/home/shax/work/File.vb', 'linux'))
      .not.toBe(localKey('/home/shax/work/file.vb', 'linux'));
  });
});
