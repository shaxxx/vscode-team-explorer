import { describe, it, expect } from 'vitest';
import { remap } from '../../src/annotate/remap.js';
import type { Owner } from '../../src/annotate/blame.js';

const A: Owner = { kind: 'changeset', id: 1 };
const B: Owner = { kind: 'changeset', id: 2 };
const LOCAL: Owner = { kind: 'local' };

describe('remap: the base attribution moved onto what the editor holds now', () => {
  it('keeps every owner when nothing changed', () => {
    expect(remap(['a', 'b'], [A, B], ['a', 'b'])).toEqual([A, B]);
  });

  it('marks an inserted line local and moves the rest down', () => {
    expect(remap(['a', 'b'], [A, B], ['a', 'new', 'b'])).toEqual([A, LOCAL, B]);
  });

  it('marks a changed line local', () => {
    expect(remap(['a', 'b'], [A, B], ['a', 'B!'])).toEqual([A, LOCAL]);
  });

  it('drops the owners of deleted lines', () => {
    expect(remap(['a', 'b', 'c'], [A, B, A], ['a', 'c'])).toEqual([A, A]);
  });

  it('marks lines typed past the end local', () => {
    expect(remap(['a'], [A], ['a', 'b', 'c'])).toEqual([A, LOCAL, LOCAL]);
  });

  it('returns exactly one owner per buffer line', () => {
    const buffer = ['x', 'a', 'y', 'b', 'z'];
    expect(remap(['a', 'b'], [A, B], buffer)).toHaveLength(buffer.length);
  });

  describe('D11: bounded diffs', () => {
    const owners = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((id): Owner => ({ kind: 'changeset', id }));
    const [P1, P2, , , , P6, , , , P10, P11] = owners;
    // base:   pre1 pre2 [d1 d2 d3 common d4 d5 d6] suf1 suf2
    // buffer: pre1 pre2 [e1 e2 e3 common e4 e5 e6] suf1 suf2
    // 'common' sits in the middle, identical on both sides. The true minimal
    // edit script keeps it unchanged (6 removed + 6 added = 12; not matching
    // it would cost 14), so an UNBOUNDED diff attributes it to owners[5] (the
    // base line 'common' matches) same as any ordinary edit. A maxEditLength
    // of 2 is far below the 12 actually needed, so jsdiff gives up outright:
    // the give-up fallback only compares from the outside in, so it can
    // never discover that inner match and must mark all of ['e1'..'e6'] --
    // including 'common' -- local. This is what distinguishes the fallback
    // from simply running the same diff with no bound: the two must give
    // DIFFERENT answers for 'common', or this test could not tell the give-up
    // path apart from an implementation that ignored `limits` entirely.
    const base = ['pre1', 'pre2', 'd1', 'd2', 'd3', 'common', 'd4', 'd5', 'd6', 'suf1', 'suf2'];
    const buffer = ['pre1', 'pre2', 'e1', 'e2', 'e3', 'common', 'e4', 'e5', 'e6', 'suf1', 'suf2'];
    const tinyLimits = { maxEditLength: 2, timeout: 300 };

    it('keeps owners for the common prefix and suffix and marks the whole middle local when the diff gives up, even a line matching by chance', () => {
      expect(remap(base, owners, buffer, tinyLimits)).toEqual([
        P1,
        P2,
        LOCAL,
        LOCAL,
        LOCAL,
        LOCAL,
        LOCAL,
        LOCAL,
        LOCAL,
        P10,
        P11,
      ]);
    });

    it('an unbounded diff of the same pair (limits comfortably covering it) finds the inner match instead', () => {
      // Confirms the fixture actually distinguishes give-up from ordinary diffing.
      expect(remap(base, owners, buffer)).toEqual([P1, P2, LOCAL, LOCAL, LOCAL, P6, LOCAL, LOCAL, LOCAL, P10, P11]);
    });

    it('always returns exactly one owner per buffer line, even on the give-up path', () => {
      expect(remap(base, owners, buffer, tinyLimits)).toHaveLength(buffer.length);
    });

    it('a normal small edit is unaffected by the give-up path (default limits comfortably cover it)', () => {
      expect(remap(['a', 'b'], [A, B], ['a', 'new', 'b'])).toEqual([A, LOCAL, B]);
    });
  });
});
