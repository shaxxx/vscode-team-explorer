import { describe, it, expect } from 'vitest';
import {
  migrateExcluded,
  migrateSecret,
  EXCLUDED_KEY,
  SECRET_KEY,
} from '../../src/migrateState.js';

/**
 * The two private storage keys moving across the `tfvc` -> `teamExplorer`
 * rename.
 *
 * Neither could collide with anything, so neither HAD to move; they move for
 * consistency. That makes the bar higher, not lower — a migration done for
 * tidiness has no excuse for costing the user their excluded-files list, and
 * simply editing the constant would have done exactly that, silently, with the
 * only symptom being excluded files quietly rejoining the check-in set.
 */

function memento(initial: Record<string, unknown> = {}) {
  const store = new Map<string, unknown>(Object.entries(initial));
  return {
    store,
    keys: () => [...store.keys()],
    get: (key: string, fallback?: unknown) => (store.has(key) ? store.get(key) : fallback),
    update: async (key: string, value: unknown) => {
      if (value === undefined) store.delete(key);
      else store.set(key, value);
    },
  };
}

/** A SecretStorage backed by a Map. `store` is its setter, per the real API. */
function secrets(initial: Record<string, string> = {}) {
  const kept = new Map<string, string>(Object.entries(initial));
  return {
    kept,
    get: (key: string) => Promise.resolve(kept.get(key)),
    store: (key: string, value: string) => {
      kept.set(key, value);
      return Promise.resolve();
    },
    delete: (key: string) => {
      kept.delete(key);
      return Promise.resolve();
    },
    onDidChange: () => ({ dispose() {} }),
  };
}

describe('the excluded-files list', () => {
  it('moves to the new key and leaves nothing behind', async () => {
    const state = memento({ 'tfvc.excluded': ['$/Shop/A.vb', '$/Shop/B.vb'] });

    const moved = await migrateExcluded(state as never);

    expect(moved).toBe(true);
    expect(state.store.get(EXCLUDED_KEY)).toEqual(['$/Shop/A.vb', '$/Shop/B.vb']);
    expect(state.store.has('tfvc.excluded'), 'the old key was left behind').toBe(false);
  });

  it('does nothing when there is nothing to move', async () => {
    const state = memento();

    expect(await migrateExcluded(state as never)).toBe(false);
    expect(state.keys()).toEqual([]);
  });

  it('never overwrites a list already under the new key', async () => {
    // Running twice, or a downgrade-then-upgrade, must not resurrect a stale
    // list over the one in use.
    const state = memento({
      'tfvc.excluded': ['$/Shop/OLD.vb'],
      [EXCLUDED_KEY]: ['$/Shop/CURRENT.vb'],
    });

    expect(await migrateExcluded(state as never)).toBe(false);
    expect(state.store.get(EXCLUDED_KEY)).toEqual(['$/Shop/CURRENT.vb']);
  });

  it('is idempotent', async () => {
    const state = memento({ 'tfvc.excluded': ['$/Shop/A.vb'] });

    await migrateExcluded(state as never);
    await migrateExcluded(state as never);

    expect(state.store.get(EXCLUDED_KEY)).toEqual(['$/Shop/A.vb']);
    expect(state.keys()).toEqual([EXCLUDED_KEY]);
  });

  it('moves an EMPTY list rather than treating it as absent', async () => {
    // "I have excluded nothing" and "I have never been asked" are different
    // states, and only the first should survive as an explicit empty array.
    const state = memento({ 'tfvc.excluded': [] });

    expect(await migrateExcluded(state as never)).toBe(true);
    expect(state.store.get(EXCLUDED_KEY)).toEqual([]);
  });

  it('moves an unusable value instead of quietly dropping it', async () => {
    // excludedSet() already reports a non-array to the user and treats it as
    // empty. Dropping it here would rob that code of the chance, and the user
    // of the warning.
    const state = memento({ 'tfvc.excluded': 'not an array' });

    expect(await migrateExcluded(state as never)).toBe(true);
    expect(state.store.get(EXCLUDED_KEY)).toBe('not an array');
  });
});

describe('the stored token', () => {
  it('moves to the new key and deletes the old', async () => {
    const s = secrets({ 'tfvc.pat': 'TOKENVALUE' });

    const moved = await migrateSecret(s as never);

    expect(moved).toBe(true);
    expect(await s.get(SECRET_KEY)).toBe('TOKENVALUE');
    expect(await s.get('tfvc.pat'), 'the old secret was left in the keychain').toBeUndefined();
  });

  it('does nothing when there is no old token', async () => {
    const s = secrets();
    expect(await migrateSecret(s as never)).toBe(false);
  });

  it('never overwrites a token already under the new key', async () => {
    const s = secrets({ 'tfvc.pat': 'STALE', [SECRET_KEY]: 'CURRENT' });

    expect(await migrateSecret(s as never)).toBe(false);
    expect(await s.get(SECRET_KEY)).toBe('CURRENT');
  });
});
