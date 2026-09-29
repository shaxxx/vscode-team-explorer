import { describe, it, expect } from 'vitest';
import { chooseCreatedAtMs } from '../../src/watch/readOnly.js';

describe('chooseCreatedAtMs', () => {
  it('returns birthtime when the filesystem recorded one', () => {
    expect(chooseCreatedAtMs({ birthtimeMs: 12345, ctimeMs: 99999 })).toBe(12345);
  });

  it('returns undefined when birthtime is 0, even if ctime is set -- kills the ctime-fallback mutant', () => {
    // `chmod`/`attrib -R` moves ctime, so falling back to it would hide the
    // very `!` hazard badge that making a versioned file writable exists to
    // show. See ScanResult.verdictFor and the readOnly.ts doc comment.
    expect(chooseCreatedAtMs({ birthtimeMs: 0, ctimeMs: 99999 })).toBeUndefined();
  });
});
