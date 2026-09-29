import { describe, it, expect } from 'vitest';
import { performance } from 'node:perf_hooks';
import { BlameWalk, splitLines, DIFF_LIMITS, type Owner } from '../../src/annotate/blame.js';

const cs = (id: number): Owner => ({ kind: 'changeset', id });

describe('splitLines', () => {
  it('splits on CRLF, LF and a lone CR, as VS Code does', () => {
    expect(splitLines('a\r\n' + 'b\n' + 'c\r' + 'd')).toEqual(['a', 'b', 'c', 'd']);
    expect(splitLines('a\r\n')).toEqual(['a', '']);
  });
});

describe('BlameWalk', () => {
  it('gives each line the changeset that introduced it', () => {
    const walk = new BlameWalk({ id: 3, lines: ['a', 'b', 'x'] });
    walk.step({ id: 2, lines: ['a', 'b'] });
    walk.step({ id: 1, lines: ['a'] });
    walk.finish();
    expect(walk.owners()).toEqual([cs(1), cs(2), cs(3)]);
  });

  it('blames a changed line on the change, not on the line it replaced', () => {
    const walk = new BlameWalk({ id: 2, lines: ['a', 'B'] });
    walk.step({ id: 1, lines: ['a', 'b'] });
    walk.finish();
    expect(walk.owners()).toEqual([cs(1), cs(2)]);
  });

  it('ignores lines deleted along the way', () => {
    const walk = new BlameWalk({ id: 2, lines: ['a', 'c'] });
    walk.step({ id: 1, lines: ['a', 'b', 'c'] });
    walk.finish();
    expect(walk.owners()).toEqual([cs(1), cs(1)]);
  });

  it('blames a line removed and later re-added on the re-add', () => {
    const walk = new BlameWalk({ id: 3, lines: ['a', 'x'] });
    walk.step({ id: 2, lines: ['a'] });
    walk.step({ id: 1, lines: ['a', 'x'] });
    walk.finish();
    expect(walk.owners()).toEqual([cs(1), cs(3)]);
  });

  it('leaves lines it has not reached pending while walking', () => {
    const walk = new BlameWalk({ id: 3, lines: ['a', 'b', 'x'] });
    walk.step({ id: 2, lines: ['a', 'b'] });
    expect(walk.owners()).toEqual([{ kind: 'pending' }, { kind: 'pending' }, cs(3)]);
    expect(walk.done).toBe(false);
  });

  it('marks unreached lines at-or-before the last version once stopped, and ignores later steps', () => {
    const walk = new BlameWalk({ id: 3, lines: ['a', 'b', 'x'] });
    walk.step({ id: 2, lines: ['a', 'b'] });
    walk.stop();
    expect(walk.owners()).toEqual([{ kind: 'atOrBefore', id: 2 }, { kind: 'atOrBefore', id: 2 }, cs(3)]);
    walk.step({ id: 1, lines: ['a'] });
    expect(walk.owners()[1]).toEqual({ kind: 'atOrBefore', id: 2 });
  });

  it('owns every line once finished, even with repeated identical lines', () => {
    const walk = new BlameWalk({ id: 3, lines: ['}', '}', 'x', '}'] });
    walk.step({ id: 2, lines: ['}', 'x'] });
    walk.step({ id: 1, lines: ['}'] });
    walk.finish();
    const owners = walk.owners();
    expect(owners).toHaveLength(4);
    expect(owners.every((o) => o.kind === 'changeset')).toBe(true);
  });

  it('gives every line to the only version when there is just one', () => {
    const walk = new BlameWalk({ id: 5, lines: ['a', 'b'] });
    walk.finish();
    expect(walk.owners()).toEqual([cs(5), cs(5)]);
  });

  it('returns true for a fold within limits', () => {
    const walk = new BlameWalk({ id: 3, lines: ['a', 'b', 'x'] });
    expect(walk.step({ id: 2, lines: ['a', 'b'] })).toBe(true);
  });

  describe('D11: bounded diffs', () => {
    it('stops and returns false when a fold exceeds maxEditLength, reading atOrBefore the newer version', () => {
      // Every line differs, so the edit distance (4 removed + 4 added = 8)
      // exceeds a maxEditLength of 2: jsdiff gives up and returns undefined.
      const walk = new BlameWalk({ id: 5, lines: ['p', 'q', 'r', 's'] });
      const folded = walk.step({ id: 4, lines: ['w', 'x', 'y', 'z'] }, { maxEditLength: 2, timeout: 300 });
      expect(folded).toBe(false);
      expect(walk.done).toBe(true);
      expect(walk.owners()).toEqual([
        { kind: 'atOrBefore', id: 5 },
        { kind: 'atOrBefore', id: 5 },
        { kind: 'atOrBefore', id: 5 },
        { kind: 'atOrBefore', id: 5 },
      ]);
    });

    it('bounds a huge, fully different diff under the default limits to well under 3s', () => {
      const newest = Array.from({ length: 20_000 }, (_, i) => `newer-line-${i}`);
      const older = Array.from({ length: 20_000 }, (_, i) => `older-line-${i}`);
      const walk = new BlameWalk({ id: 2, lines: newest });

      const start = performance.now();
      const folded = walk.step({ id: 1, lines: older }, DIFF_LIMITS);
      const elapsed = performance.now() - start;

      expect(folded).toBe(false);
      expect(elapsed).toBeLessThan(3000);
    });
  });
});
