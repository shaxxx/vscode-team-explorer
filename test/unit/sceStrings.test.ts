import { describe, it, expect } from 'vitest';
import { S } from '../../src/tf/strings.js';

describe('phase 3 part 2 strings', () => {
  it('posts only plain strings to the page: labels survive postMessage', () => {
    const values = Object.values(S.sceLabels);
    expect(values.length).toBeGreaterThan(30);
    for (const v of values) {
      expect(typeof v).toBe('string');
      expect((v as string).length).toBeGreaterThan(0);
    }
  });

  it('has a label for every menu action, keyed by the action name', () => {
    for (const a of ['getLatest', 'getSpecific', 'checkout', 'undo', 'history', 'compare', 'view', 'annotate', 'addItems', 'rename', 'delete', 'map', 'copyPath']) {
      expect(S.sceLabels).toHaveProperty(a);
    }
  });

  it('says separately what a Get removed (design Q10)', () => {
    expect(S.sceGetDone('a.txt', 3, 0)).toBe('Got a.txt: 3 item(s).');
    expect(S.sceGetDone('a.txt', 3, 1)).toBe('Got a.txt: 3 item(s); 1 removed, because they did not exist at that version.');
  });

  it('names up to three items, then counts the rest', () => {
    expect(S.sceWhat(['a', 'b'])).toBe('a, b');
    expect(S.sceWhat(['a', 'b', 'c', 'd', 'e'])).toBe('a, b, c and 2 more');
  });

  it('never says TFVC in the activity bar or the explorer title (design X4)', () => {
    expect(S.sceTitle).toBe('Source Control Explorer');
    expect(JSON.stringify(S.sceLabels)).not.toMatch(/tfvc/i);
  });
});
