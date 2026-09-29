import { describe, it, expect, beforeEach } from 'vitest';
import { createdPanels, EventEmitter, recorder, Uri } from '../vscode-mock.js';
import { CONFLICTS_VIEW_TYPE, ConflictsView, type ConflictsViewState } from '../../src/ui/ConflictsView.js';
import type { Conflict, ConflictActions } from '../../src/conflicts/conflictModel.js';
import { S } from '../../src/tf/strings.js';

const VERSION: Conflict = {
  localPath: String.raw`C:\work\Shop\Startup.cs`,
  tfPath: String.raw`C:\work\Shop\Startup.cs`,
  serverPath: '$/Shop/Startup.cs',
  reason: 'You have a conflicting pending change.',
  family: 'version',
  base: 18319,
  theirs: 18325,
  binary: false,
};
const KEY = VERSION.localPath.toLowerCase();

function setup(list: Conflict[] = [VERSION]) {
  const changed = new EventEmitter<void>();
  const source = { conflicts: list, onDidChange: changed.event };
  const calls: string[] = [];
  let gate: (() => void) | undefined;
  const actions: ConflictActions = {
    compare: async (c) => void calls.push(`compare ${c.localPath}`),
    compareServerBase: async (c) => void calls.push(`compareServerBase ${c.localPath}`),
    compareLocalBase: async (c) => void calls.push(`compareLocalBase ${c.localPath}`),
    resolve: async (c, how) => {
      calls.push(`resolve ${how}`);
      if (how === 'TakeTheirs') await new Promise<void>((r) => (gate = r));
      return true;
    },
    markMerged: async () => (calls.push('markMerged'), true),
    autoMergeAll: async () => void calls.push('autoMergeAll'),
    refresh: async () => void calls.push('refresh'),
  };
  const view = new ConflictsView((() => Uri.file('/ext')) as never, source as never, actions, 'win32');
  return { view, source, changed, calls, actions, open: () => gate?.() };
}

const lastState = () => createdPanels[0].webview.posted.at(-1) as ConflictsViewState;

beforeEach(() => recorder.reset());

describe('ConflictsView', () => {
  it('opens one tab, and reveals it when asked again', async () => {
    const { view } = setup();
    await view.show();
    await view.show();
    expect(createdPanels).toHaveLength(1);
    expect(createdPanels[0].viewType).toBe(CONFLICTS_VIEW_TYPE);
    expect(createdPanels[0].title).toBe(S.conflictsTitle);
    expect(createdPanels[0].revealed).toBe(1);
    view.dispose();
  });

  it('posts one row per conflict, with its buttons and changesets', async () => {
    const { view } = setup();
    await view.show(VERSION.localPath);
    await createdPanels[0].receive({ type: 'ready' });
    const state = lastState();
    expect(state.selected).toBe(KEY);
    expect(state.rows).toEqual([
      {
        key: KEY,
        name: 'Startup.cs',
        folder: String.raw`C:\work\Shop`,
        reason: 'You have a conflicting pending change.',
        versions: 'yours from C18319, server at C18325',
        actions: ['compare', 'compareServerBase', 'compareLocalBase', 'autoMerge', 'takeTheirs', 'keepYours', 'mergeManually'],
        merging: false,
      },
    ]);
    expect(state.empty).toBe(S.conflictsNone);
    view.dispose();
  });

  it('posts again whenever the list changes', async () => {
    const { view, changed } = setup();
    await view.show();
    const before = createdPanels[0].webview.posted.length;
    changed.fire();
    expect(createdPanels[0].webview.posted.length).toBe(before + 1);
    view.dispose();
  });

  it('hands each button to its action', async () => {
    const { view, calls } = setup();
    await view.show();
    const panel = createdPanels[0];
    await panel.receive({ type: 'act', key: KEY, action: 'compare' });
    await panel.receive({ type: 'act', key: KEY, action: 'compareServerBase' });
    await panel.receive({ type: 'act', key: KEY, action: 'compareLocalBase' });
    await panel.receive({ type: 'act', key: KEY, action: 'keepYours' });
    await panel.receive({ type: 'refresh' });
    await panel.receive({ type: 'autoMergeAll' });
    expect(calls).toEqual([
      `compare ${VERSION.localPath}`,
      `compareServerBase ${VERSION.localPath}`,
      `compareLocalBase ${VERSION.localPath}`,
      'resolve KeepYours',
      'refresh',
      'autoMergeAll',
    ]);
    view.dispose();
  });

  it('Merge manually opens the compare and holds the row in the merging state until Resolved or Cancel', async () => {
    const { view, calls } = setup();
    await view.show();
    const panel = createdPanels[0];
    await panel.receive({ type: 'act', key: KEY, action: 'resolved' });
    expect(calls).toEqual([]); // Resolved means nothing outside the merging state
    await panel.receive({ type: 'act', key: KEY, action: 'mergeManually' });
    expect(lastState().rows[0].merging).toBe(true);
    expect(calls).toEqual([`compare ${VERSION.localPath}`]);
    await panel.receive({ type: 'act', key: KEY, action: 'cancelMerge' });
    expect(lastState().rows[0].merging).toBe(false);
    await panel.receive({ type: 'act', key: KEY, action: 'mergeManually' });
    await panel.receive({ type: 'act', key: KEY, action: 'resolved' });
    expect(calls.at(-1)).toBe('markMerged');
    expect(lastState().rows[0].merging).toBe(false);
    view.dispose();
  });

  it('ends a merge whose conflict changed under it: Resolved never runs on something the user did not merge', async () => {
    const { view, source, changed, calls } = setup();
    await view.show();
    const panel = createdPanels[0];
    await panel.receive({ type: 'act', key: KEY, action: 'mergeManually' });
    // Undone and got again elsewhere: a blocked conflict at the same path, and
    // the service may never have posted the moment it was gone.
    source.conflicts = [{ ...VERSION, family: 'blocked', base: undefined }];
    await panel.receive({ type: 'act', key: KEY, action: 'resolved' });
    expect(calls).not.toContain('markMerged');
    expect(lastState().rows[0].merging).toBe(false);

    // A new version conflict at the same path is a different merge.
    source.conflicts = [VERSION];
    await panel.receive({ type: 'act', key: KEY, action: 'mergeManually' });
    source.conflicts = [{ ...VERSION, theirs: 18400 }];
    changed.fire();
    expect(lastState().rows[0].merging).toBe(false);
    await panel.receive({ type: 'act', key: KEY, action: 'resolved' });
    expect(calls).not.toContain('markMerged');
    view.dispose();
  });

  it('is never left busy when an action throws', async () => {
    const { view, actions } = setup();
    actions.resolve = async () => {
      throw new Error('boom');
    };
    await view.show();
    await createdPanels[0].receive({ type: 'act', key: KEY, action: 'autoMerge' });
    expect(lastState().busy).toBe(false);
    expect(recorder.messages.at(-1)?.message).toContain('boom');
    view.dispose();
  });

  it('refuses a button the row does not offer, and a row that is gone', async () => {
    const { view, calls } = setup([{ ...VERSION, family: 'blocked', base: undefined }]);
    await view.show();
    await createdPanels[0].receive({ type: 'act', key: KEY, action: 'keepYours' });
    await createdPanels[0].receive({ type: 'act', key: 'c:\\nowhere', action: 'compare' });
    await createdPanels[0].receive({ type: 'act', key: KEY, action: 'checkin' });
    expect(calls).toEqual([]);
    view.dispose();
  });

  it('runs one resolution at a time: a click while one runs is dropped', async () => {
    const { view, calls, open } = setup();
    await view.show();
    const panel = createdPanels[0];
    const first = panel.receive({ type: 'act', key: KEY, action: 'takeTheirs' });
    await new Promise((r) => setImmediate(r));
    expect(lastState().busy).toBe(true);
    await panel.receive({ type: 'act', key: KEY, action: 'keepYours' });
    open();
    await first;
    expect(calls).toEqual(['resolve TakeTheirs']);
    expect(lastState().busy).toBe(false);
    view.dispose();
  });

  it('stops posting once the tab is closed', async () => {
    const { view, changed } = setup();
    await view.show();
    createdPanels[0].dispose();
    expect(() => changed.fire()).not.toThrow();
    view.dispose();
  });
});
