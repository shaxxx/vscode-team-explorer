import { describe, it, expect } from 'vitest';
import { unwrapTarget, unwrapTargets } from '../../src/commands/resolveTarget.js';

const uriA = { fsPath: 'C:\\work\\Shop\\a.cs' };
const uriB = { fsPath: 'C:\\work\\Shop\\b.cs' };
const stateA = { resourceUri: uriA, decorations: { tooltip: 'Edit' } };
const stateB = { resourceUri: uriB };

describe('unwrapTarget', () => {
  it('passes a Uri straight through (explorer and editor context menus)', () => {
    expect(unwrapTarget(uriA)).toBe(uriA);
  });

  it('unwraps a SourceControlResourceState (the SCM panel context menu)', () => {
    expect(unwrapTarget(stateA)).toBe(uriA);
  });

  it('returns undefined for a palette invocation, which passes nothing', () => {
    expect(unwrapTarget(undefined)).toBeUndefined();
  });

  it('returns undefined rather than throwing for an unexpected shape', () => {
    expect(unwrapTarget(null)).toBeUndefined();
    expect(unwrapTarget('a string')).toBeUndefined();
    expect(unwrapTarget(42)).toBeUndefined();
    expect(unwrapTarget({})).toBeUndefined();
  });

  it('ignores a resourceUri that is not Uri-shaped', () => {
    expect(unwrapTarget({ resourceUri: {} })).toBeUndefined();
    expect(unwrapTarget({ resourceUri: null })).toBeUndefined();
  });

  it('does not throw when a getter throws — commands are globally invocable', () => {
    const hostile = new Proxy({}, {
      has: () => true,
      get: () => { throw new Error('boom'); },
    });
    expect(() => unwrapTarget(hostile)).not.toThrow();
    expect(unwrapTarget(hostile)).toBeUndefined();
  });
});

describe('unwrapTargets', () => {
  it('returns every file of a multi-select, NOT undefined', () => {
    // The bug this exists to prevent: an array yielded undefined, so the
    // caller fell back to the active editor and `tf vc undo` discarded edits
    // on a file the user had not selected. Ordinary click, silent data loss.
    expect(unwrapTargets([[stateA, stateB]])).toEqual([uriA, uriB]);
  });

  it('handles the (first, all[]) shape without duplicating the first', () => {
    // VS Code passes the clicked item, then the whole selection.
    expect(unwrapTargets([stateA, [stateA, stateB]])).toEqual([uriA, uriB]);
  });

  it('handles the same shape for explorer Uris', () => {
    expect(unwrapTargets([uriA, [uriA, uriB]])).toEqual([uriA, uriB]);
  });

  it('handles a single target from either menu', () => {
    expect(unwrapTargets([stateA])).toEqual([uriA]);
    expect(unwrapTargets([uriA])).toEqual([uriA]);
  });

  it('returns an empty array for a palette invocation', () => {
    expect(unwrapTargets([])).toEqual([]);
    expect(unwrapTargets([undefined])).toEqual([]);
  });

  it('preserves selection order', () => {
    expect(unwrapTargets([[stateB, stateA]])).toEqual([uriB, uriA]);
  });

  it('skips unrecognised entries rather than aborting the whole selection', () => {
    expect(unwrapTargets([[stateA, null, 'junk', stateB]])).toEqual([uriA, uriB]);
  });

  it('de-duplicates by path', () => {
    const duplicate = { resourceUri: { fsPath: uriA.fsPath } };
    expect(unwrapTargets([[stateA, duplicate]])).toEqual([uriA]);
  });
});
