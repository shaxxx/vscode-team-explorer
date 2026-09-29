import { describe, it, expect } from 'vitest';
import { wouldCorruptOnSave, countReplacements } from '../../src/commands/encodingGuard.js';

/** A real windows-1250 line, read the way VS Code reads it by default. */
const cp1250Bytes = Buffer.from([
  0x27, 0x20, 0x49, 0x7a, 0x72, 0x61, 0xe8, 0x75, 0x6e, 0x61, 0x6a,
  0x20, 0x7a, 0x61, 0x20, 0x8e, 0x75, 0x70, 0x61, 0x6e, 0x69, 0x6a, 0x75,
]);

describe('wouldCorruptOnSave', () => {
  it('flags a windows-1250 file that VS Code decoded as UTF-8', () => {
    const asVsCodeSeesIt = cp1250Bytes.toString('utf8');
    expect(wouldCorruptOnSave(asVsCodeSeesIt)).toBe(true);
  });

  it('proves the loss is real: saving that text back does not round-trip', () => {
    const asVsCodeSeesIt = cp1250Bytes.toString('utf8');
    const saved = Buffer.from(asVsCodeSeesIt, 'utf8');
    expect(saved.equals(cp1250Bytes)).toBe(false);
    // The 0xe8 (č) and 0x8e (Ž) become EF BF BD and cannot be recovered.
    expect(saved.includes(Buffer.from([0xef, 0xbf, 0xbd]))).toBe(true);
  });

  it('does not flag the same bytes decoded correctly', () => {
    const correct = new TextDecoder('windows-1250').decode(cp1250Bytes);
    expect(correct).toContain('č');
    expect(wouldCorruptOnSave(correct)).toBe(false);
  });

  it('does not flag ordinary UTF-8 Croatian text', () => {
    expect(wouldCorruptOnSave('Račun za Đakovo — čćžšđ ČĆŽŠĐ')).toBe(false);
  });

  it('does not flag plain ASCII or an empty document', () => {
    expect(wouldCorruptOnSave('const x = 1;')).toBe(false);
    expect(wouldCorruptOnSave('')).toBe(false);
  });

  it('counts how many characters would be destroyed', () => {
    expect(countReplacements(cp1250Bytes.toString('utf8'))).toBe(2);
    expect(countReplacements('clean')).toBe(0);
  });
});
