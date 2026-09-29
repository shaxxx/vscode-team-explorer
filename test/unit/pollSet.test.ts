import { describe, it, expect } from 'vitest';
import { PollSet, DEFAULT_MAX_TRACKED } from '../../src/watch/pollSet.js';

describe('PollSet', () => {
  it('tracks and reads back a value', () => {
    const s = new PollSet();
    s.track('a', true);
    expect(s.has('a')).toBe(true);
    expect(s.get('a')).toBe(true);
    expect(s.size).toBe(1);
  });

  it('update reports a genuine transition', () => {
    const s = new PollSet();
    s.track('a', true);
    expect(s.update('a', false)).toBe(true);
    expect(s.get('a')).toBe(false);
  });

  it('update reports nothing when the value is unchanged', () => {
    const s = new PollSet();
    s.track('a', true);
    expect(s.update('a', true)).toBe(false);
  });

  it('update does NOT add an untracked path — this is the bound', () => {
    // The growth bug: every filesystem event from a **/* watcher added an
    // entry that was never removed, so a Get Latest or a build grew the set by
    // thousands and the 2 s poll stat'd all of them synchronously.
    const s = new PollSet();
    expect(s.update('never-tracked', true)).toBe(false);
    expect(s.size).toBe(0);
    expect(s.has('never-tracked')).toBe(false);
  });

  it('caps the set and evicts least-recently-tracked first', () => {
    const s = new PollSet(3);
    s.track('a', true);
    s.track('b', true);
    s.track('c', true);
    s.track('d', true);

    expect(s.size).toBe(3);
    expect(s.has('a')).toBe(false); // oldest evicted
    expect(s.keys()).toEqual(['b', 'c', 'd']);
  });

  it('re-tracking refreshes recency, so an active path is evicted last', () => {
    const s = new PollSet(3);
    s.track('a', true);
    s.track('b', true);
    s.track('c', true);
    s.track('a', true); // touched again -> now newest
    s.track('d', true);

    expect(s.has('a')).toBe(true);
    expect(s.has('b')).toBe(false); // b is now the oldest
  });

  it('stays bounded under sustained churn', () => {
    const s = new PollSet(100);
    for (let i = 0; i < 50_000; i++) s.track(`file-${i}`, i % 2 === 0);
    expect(s.size).toBe(100);
  });

  it('forget removes a path, so deletions do not accumulate', () => {
    const s = new PollSet();
    s.track('a', true);
    s.forget('a');
    expect(s.has('a')).toBe(false);
    expect(s.size).toBe(0);
  });

  it('has a sane default cap', () => {
    expect(DEFAULT_MAX_TRACKED).toBeGreaterThan(0);
    expect(DEFAULT_MAX_TRACKED).toBeLessThanOrEqual(10_000);
  });
});
