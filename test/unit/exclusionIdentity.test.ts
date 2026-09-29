import { describe, it, expect, beforeEach } from 'vitest';
import { ScmProvider } from '../../src/ui/ScmProvider.js';
import { PathMapper } from '../../src/tf/PathMapper.js';
import { ScanResult } from '../../src/scan/ScanResult.js';
import { scm, Uri, recorder, outputChannel } from '../vscode-mock.js';
import type { PendingChange } from '../../src/tf/types.js';

/**
 * What an exclusion is keyed on.
 *
 * Losing one is not cosmetic: the file the user deliberately held back
 * rejoins Included, and Check In takes what is included. That is irreversible.
 *
 * Keyed on the server path, a RENAME broke it — tf reports the new `item`,
 * nothing matches the stored old one, and the file silently came back. tf also
 * reports `itemid`, which is TFVC's identity for the item and does not move
 * when the path does.
 */

function change(over: Partial<PendingChange> = {}): PendingChange {
  return {
    serverItem: '$/Vesta/Form1.vb',
    localPath: 'C:\\work\\Vesta\\Form1.vb',
    itemType: 'File',
    changes: new Set(['Edit']),
    changeFlags: 2,
    encoding: 1250,
    itemId: 152732,
    version: 42,
    ...over,
  } as PendingChange;
}

function provider(changes: PendingChange[], excluded: unknown = []) {
  const mapper = new PathMapper([{ serverItem: '$/Vesta', localPath: 'C:\\work\\Vesta' }], 'win32');
  const service = {
    pendingChanges: changes,
    pathMapper: mapper,
    onDidChange: () => ({ dispose() {} }),
    changeFor: (item: string) =>
      changes.find((c) => c.serverItem.toLowerCase() === item.toLowerCase()),
  };
  const store = new Map<string, unknown>([['teamExplorer.excluded', excluded]]);
  let writes = 0;
  const state = {
    get: <T>(k: string, d: T) => (store.has(k) ? (store.get(k) as T) : d),
    update: async (k: string, v: unknown) => {
      writes++;
      store.set(k, v);
    },
  };
  const p = new ScmProvider(
    service as never,
    { uri: Uri.file('C:\\work\\Vesta') } as never,
    state as never,
    outputChannel as never,
    () => ScanResult.notRun(),
    () => ({ dispose() {} }),
  );
  return { p, control: scm.last!, store, writes: () => writes };
}

const stored = (store: Map<string, unknown>) => store.get('teamExplorer.excluded') as string[];
const excludedCount = (control: { groups: Map<string, { resourceStates: unknown[] }> }) =>
  control.groups.get('excluded')!.resourceStates.length;

beforeEach(() => {
  recorder.reset();
  outputChannel.clear();
});

describe('an exclusion survives a rename', () => {
  it('still matches after the server path changes', async () => {
    // THE BUG. The user excludes Form1.vb, then renames it. tf now reports
    // `$/Vesta/Renamed.vb` with the SAME itemid, and the old key matches
    // nothing — so the file quietly rejoined the set Check In takes.
    const before = [change()];
    const { p, store } = provider(before);
    await p.setExcluded('$/Vesta/Form1.vb', true);

    // Same item, new path, same id — which is what a rename looks like.
    const renamed = change({
      serverItem: '$/Vesta/Renamed.vb',
      localPath: 'C:\\work\\Vesta\\Renamed.vb',
      changes: new Set(['Rename']),
    });
    const after = provider([renamed], stored(store));

    expect(after.p.includedChanges, 'the renamed file came back as included').toHaveLength(0);
    expect(excludedCount(after.control as never)).toBe(1);
  });

  it('prefers the id key when there is one', async () => {
    const { p, store } = provider([change()]);
    await p.setExcluded('$/Vesta/Form1.vb', true);

    expect(stored(store)).toEqual(['#152732']);
  });
});

describe('items with no server identity', () => {
  it('keys a pending Add on its path, because its id is a placeholder', async () => {
    // tf gives a pending Add a NEGATIVE itemid; there is no server item yet
    // for it to be the identity of.
    const add = change({
      serverItem: '$/Vesta/New.vb',
      itemId: -4,
      changes: new Set(['Add']),
      version: undefined,
    });
    const { p, store } = provider([add]);

    await p.setExcluded('$/Vesta/New.vb', true);

    expect(stored(store)).toEqual(['$/vesta/new.vb']);
    expect(p.includedChanges).toHaveLength(0);
  });
});

describe('entries stored before the id key existed', () => {
  it('are still honoured', async () => {
    const { p } = provider([change()], ['$/vesta/form1.vb']);
    expect(p.includedChanges, 'a legacy path entry stopped working').toHaveLength(0);
  });

  it('are migrated to the id key on the next change, not left to match twice', async () => {
    const { p, store } = provider([change()], ['$/vesta/form1.vb']);

    await p.setExcluded('$/Vesta/Form1.vb', true);

    expect(stored(store)).toEqual(['#152732']);
  });

  it('Include clears BOTH keys, so nothing is left holding the file back', async () => {
    // If Include removed only the preferred key, an item excluded under its
    // old path would stay excluded with no way to release it from the UI.
    const { p, store } = provider([change()], ['$/vesta/form1.vb', '#152732']);

    await p.setExcluded('$/Vesta/Form1.vb', false);

    expect(stored(store)).toEqual([]);
    expect(p.includedChanges).toHaveLength(1);
  });
});

describe('a multi-select', () => {
  it('writes once and renders once, not once per file', async () => {
    // Memento.update persists the whole object and render() rebuilds both
    // resource groups, so per-item was quadratic in the selection.
    const many = Array.from({ length: 20 }, (_, i) =>
      change({ serverItem: `$/Vesta/F${i}.vb`, itemId: 1000 + i }),
    );
    const { p, writes } = provider(many);
    const before = writes();

    await p.setExcludedMany(many.map((c) => c.serverItem), true);

    expect(writes() - before, 'one write for the whole selection').toBe(1);
    expect(p.includedChanges).toHaveLength(0);
  });

  it('does nothing at all for an empty selection', async () => {
    const { p, writes } = provider([change()]);
    const before = writes();

    await p.setExcludedMany([], true);

    expect(writes() - before).toBe(0);
  });
});
