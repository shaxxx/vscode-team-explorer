import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HistoryViews, HISTORY_VIEW_TYPE, DETAILS_DELAY_MS } from '../../src/ui/HistoryView.js';
import { parseHistory, type Changeset } from '../../src/tf/parseHistory.js';
import { HistoryError } from '../../src/history/HistoryService.js';
import type { VersionPointer } from '../../src/history/historyModel.js';
import { recorder, createdPanels, Uri, type MockWebviewPanel } from '../vscode-mock.js';
import { S } from '../../src/tf/strings.js';

const changesets = (name: string): Changeset[] =>
  parseHistory(readFileSync(join(__dirname, '../fixtures/windows', name)).toString('utf8')).changesets;

const RENAMED = changesets('history-file-renamed-itemmode.txt');
const CURRENT = '$/Shop/Shop2023/ShopModel/Till/tillPOSReply.vb';
const OLD_NAME = '$/Shop/Shop2023/ShopModel/Till/tillPOSReplies.vb';
const FILE = { mode: 'file' as const, serverPath: CURRENT, name: 'tillPOSReply.vb' };

type Page = { changesets: Changeset[]; more: boolean } | Error;

/** A queued reply for `history.changeset`, consumed in call order regardless of id. */
type ChangesetReply = Changeset | Error;

function build(pages: Page[] = [{ changesets: RENAMED, more: false }], changesetReplies: ChangesetReply[] = []) {
  const pageCalls: [unknown, unknown][] = [];
  const changesetCalls: number[] = [];
  const history = {
    page: async (target: unknown, options: unknown) => {
      pageCalls.push([target, options]);
      const next = pages.shift() ?? { changesets: [], more: false };
      if (next instanceof Error) throw next;
      return next;
    },
    changeset: async (id: number) => {
      changesetCalls.push(id);
      if (changesetReplies.length > 0) {
        const next = changesetReplies.shift()!;
        if (next instanceof Error) throw next;
        return next;
      }
      const found = RENAMED.find((c) => c.id === id);
      if (!found) throw new HistoryError(S.changesetNotFound(id), 'unreadable');
      return found;
    },
  };
  const compared: [VersionPointer, VersionPointer, string][] = [];
  const viewed: VersionPointer[] = [];
  const got: [VersionPointer, string][] = [];
  const actions = {
    compare: async (l: VersionPointer, r: VersionPointer, n: string) => void compared.push([l, r, n]),
    view: async (v: VersionPointer) => void viewed.push(v),
    getVersion: async (v: VersionPointer, n: string) => void got.push([v, n]),
  };
  const log: string[] = [];
  const views = new HistoryViews(() => Uri.file('/ext') as never, history as never, actions, (l) => log.push(l));
  return { views, pageCalls, changesetCalls, compared, viewed, got, log };
}

const panel = (): MockWebviewPanel => createdPanels[createdPanels.length - 1];
const lastState = (p: MockWebviewPanel) =>
  (p.webview.posted.filter((m) => (m as { type: string }).type === 'state').at(-1) as { state: any }).state;

beforeEach(() => recorder.reset());

describe('HistoryViews: the tab', () => {
  it('opens one tab titled History - <name>, scripts on, context not retained, resources limited to media', async () => {
    await build().views.show(FILE);
    expect(createdPanels).toHaveLength(1);
    expect(panel().viewType).toBe(HISTORY_VIEW_TYPE);
    expect(panel().title).toBe('History - tillPOSReply.vb');
    expect(panel().options).toMatchObject({ enableScripts: true, retainContextWhenHidden: false });
    const roots = panel().options.localResourceRoots as Uri[];
    expect(roots.map((r) => r.fsPath)).toEqual(['/ext/media']);
  });

  it('puts no server text in the HTML: rows reach the page only as posted state', async () => {
    await build().views.show(FILE);
    expect(panel().webview.html).not.toContain('Teller_ID');
    expect(lastState(panel()).rows.map((r: { id: number }) => r.id)).toEqual(RENAMED.map((c) => c.id));
  });

  it('loads the first page by server path', async () => {
    const h = build();
    await h.views.show(FILE);
    expect(h.pageCalls).toEqual([[{ mode: 'file', itemspec: CURRENT }, {}]]);
  });

  it('reveals the existing tab when asked again, without opening a second one (D18b re-fetches page 1; see below)', async () => {
    const h = build([{ changesets: RENAMED, more: false }, { changesets: [], more: false }]);
    await h.views.show(FILE);
    await h.views.show(FILE);
    expect(createdPanels).toHaveLength(1);
    expect(panel().revealed).toBe(1);
    // D18b: "asking again" now re-fetches page 1 to check for anything newer
    // (a second `describe` below covers that in detail) -- what stays true
    // here is that it is still the SAME tab, not a new one.
    expect(h.pageCalls).toHaveLength(2);
    expect(lastState(panel()).rows.map((r: { id: number }) => r.id)).toEqual(RENAMED.map((c) => c.id));
  });

  it('forgets a closed tab, so asking again opens a new one', async () => {
    const h = build([{ changesets: RENAMED, more: false }, { changesets: RENAMED, more: false }]);
    await h.views.show(FILE);
    panel().dispose();
    await h.views.show(FILE);
    expect(createdPanels).toHaveLength(2);
  });

  it('re-posts the state whenever the page (re)loads and says ready', async () => {
    await build().views.show(FILE);
    const before = panel().webview.posted.length;
    await panel().receive({ type: 'ready' });
    expect(panel().webview.posted.length).toBe(before + 1);
  });

  it('shows a failed load in the tab and stops loading', async () => {
    await build([new HistoryError('TF30063: You are not authorized', 'patRejected')]).views.show(FILE);
    expect(lastState(panel())).toMatchObject({ loading: false, error: 'TF30063: You are not authorized' });
  });

  it('reloads a stuck tab (empty, nothing loading) when asked for again, clearing the old error (D16c)', async () => {
    const h = build([
      new HistoryError('TF30063: You are not authorized', 'patRejected'),
      { changesets: RENAMED, more: false },
    ]);
    await h.views.show(FILE); // fails: the tab stays empty
    expect(lastState(panel())).toMatchObject({ error: 'TF30063: You are not authorized', rows: [] });
    await h.views.show(FILE); // asked for again: reloads rather than just revealing a dead tab
    expect(createdPanels).toHaveLength(1); // still the SAME tab, not a second one
    expect(panel().revealed).toBe(1);
    expect(h.pageCalls).toHaveLength(2);
    expect(lastState(panel())).toMatchObject({ error: undefined });
    expect(lastState(panel()).rows.length).toBe(RENAMED.length);
  });

  it('disposes every tab with itself', async () => {
    const h = build();
    await h.views.show(FILE);
    h.views.dispose();
    expect(panel().disposed).toBe(true);
  });
});

describe('HistoryViews: what the page may ask for', () => {
  it('drops a message it does not know, and logs it', async () => {
    const h = build();
    await h.views.show(FILE);
    await panel().receive({ type: 'exec', cmd: 'rm -rf' });
    expect([...h.compared, ...h.viewed, ...h.got]).toEqual([]);
    expect(h.log.join('\n')).toContain('dropped');
  });

  it('ignores an action on a changeset it never listed', async () => {
    const h = build();
    await h.views.show(FILE);
    await panel().receive({ type: 'compare', id: 999 });
    expect(h.compared).toEqual([]);
    expect(h.log.join('\n')).toContain('999');
  });

  it('uses its own paths, never one the page sends', async () => {
    const h = build();
    await h.views.show(FILE);
    await panel().receive({ type: 'view', id: 18544, path: '$/evil' });
    expect(h.viewed).toEqual([{ serverPath: OLD_NAME, changeset: 18544 }]);
  });

  it('compares across the rename', async () => {
    const h = build();
    await h.views.show(FILE);
    await panel().receive({ type: 'compare', id: 18547 });
    expect(h.compared).toEqual([
      [{ serverPath: OLD_NAME, changeset: 18544 }, { serverPath: CURRENT, changeset: 18547 }, 'tillPOSReply.vb'],
    ]);
  });

  it('shows a refusal instead of acting', async () => {
    const h = build();
    await h.views.show(FILE);
    await panel().receive({ type: 'getVersion', id: 18544 });
    expect(h.got).toEqual([]);
    expect(recorder.shown).toContain(S.getVersionRenamed);
  });

  it('gets a version under the current name', async () => {
    const h = build();
    await h.views.show(FILE);
    await panel().receive({ type: 'getVersion', id: 18659 });
    expect(h.got).toEqual([[{ serverPath: CURRENT, changeset: 18659 }, 'tillPOSReply.vb']]);
  });

  it('posts the selection at once, and fetches its details only after DETAILS_DELAY_MS (D16d)', async () => {
    vi.useFakeTimers();
    try {
      const h = build();
      await h.views.show(FILE);
      await panel().receive({ type: 'select', id: 18547 });
      // Selection state is visible immediately; details are not fetched yet.
      expect(lastState(panel())).toMatchObject({ selected: 18547, details: undefined });
      expect(h.changesetCalls).toEqual([]);
      await panel().receive({ type: 'select', id: 18547 });
      await vi.advanceTimersByTimeAsync(DETAILS_DELAY_MS);
      expect(h.changesetCalls).toEqual([18547]);
      expect(lastState(panel())).toMatchObject({ selected: 18547, details: { id: 18547 } });
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not re-fetch a changeset already cached, even across a reselect', async () => {
    vi.useFakeTimers();
    try {
      const h = build();
      await h.views.show(FILE);
      await panel().receive({ type: 'select', id: 18547 });
      await vi.advanceTimersByTimeAsync(DETAILS_DELAY_MS);
      await panel().receive({ type: 'select', id: 18544 });
      await vi.advanceTimersByTimeAsync(DETAILS_DELAY_MS);
      await panel().receive({ type: 'select', id: 18547 });
      await vi.advanceTimersByTimeAsync(DETAILS_DELAY_MS);
      expect(h.changesetCalls).toEqual([18547, 18544]);
      expect(lastState(panel())).toMatchObject({ selected: 18547, details: { id: 18547 } });
    } finally {
      vi.useRealTimers();
    }
  });

  it('a newer selection cancels the pending details fetch for the one it replaced (D16d)', async () => {
    vi.useFakeTimers();
    try {
      const h = build();
      await h.views.show(FILE);
      await panel().receive({ type: 'select', id: 18547 });
      await vi.advanceTimersByTimeAsync(DETAILS_DELAY_MS - 50); // not due yet
      await panel().receive({ type: 'select', id: 18544 });
      await vi.advanceTimersByTimeAsync(DETAILS_DELAY_MS);
      // 18547's debounced fetch never ran; only 18544's did.
      expect(h.changesetCalls).toEqual([18544]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows a failed details fetch instead of leaving the pane stuck, and retries on reselect (D16d, split from the page error by D18c)', async () => {
    vi.useFakeTimers();
    try {
      const h = build(undefined, [new Error('tf timed out')]);
      await h.views.show(FILE);
      await panel().receive({ type: 'select', id: 18547 });
      await vi.advanceTimersByTimeAsync(DETAILS_DELAY_MS);
      // D18c: a details failure is `detailsError`, never the page banner `error`.
      expect(lastState(panel())).toMatchObject({ selected: 18547, detailsError: 'tf timed out', error: undefined });
      expect(lastState(panel()).details).toBeUndefined();
      // Reselecting the same row retries -- the failure was never cached.
      await panel().receive({ type: 'select', id: 18547 });
      await vi.advanceTimersByTimeAsync(DETAILS_DELAY_MS);
      expect(h.changesetCalls).toEqual([18547, 18547]);
      expect(lastState(panel())).toMatchObject({
        selected: 18547,
        details: { id: 18547 },
        detailsError: undefined,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("D20e/R4: selecting a new row clears the PREVIOUS row's detailsError right away, not just once its own fetch settles", async () => {
    vi.useFakeTimers();
    try {
      const h = build(undefined, [new Error('A failed')]); // row 18547's details fetch fails
      await h.views.show(FILE);
      await panel().receive({ type: 'select', id: 18547 });
      await vi.advanceTimersByTimeAsync(DETAILS_DELAY_MS);
      expect(lastState(panel())).toMatchObject({ selected: 18547, detailsError: 'A failed' });
      // Selecting a different row (18544) whose OWN fetch has not even started
      // debouncing yet must not still show 18547's failure underneath it.
      await panel().receive({ type: 'select', id: 18544 });
      expect(lastState(panel())).toMatchObject({ selected: 18544, detailsError: undefined, details: undefined });
      await vi.advanceTimersByTimeAsync(DETAILS_DELAY_MS);
      expect(lastState(panel())).toMatchObject({ selected: 18544, details: { id: 18544 }, detailsError: undefined });
    } finally {
      vi.useRealTimers();
    }
  });

  it('a stale details result -- for a row the user has since left -- never touches model.detailsError (D16d, D18c)', async () => {
    vi.useFakeTimers();
    try {
      let rejectFirst!: (e: Error) => void;
      const stalled = new Promise<Changeset>((_resolve, reject) => {
        rejectFirst = reject;
      });
      const calls: number[] = [];
      const history = {
        page: async () => ({ changesets: RENAMED, more: false }),
        // 18547's fetch hangs on `stalled`; every other id resolves normally.
        changeset: async (id: number) => {
          calls.push(id);
          if (id === 18547) return stalled;
          return RENAMED.find((c) => c.id === id)!;
        },
      };
      const views = new HistoryViews(
        () => Uri.file('/ext') as never,
        history as never,
        { compare: async () => {}, view: async () => {}, getVersion: async () => {} },
        () => {},
      );
      await views.show(FILE);
      await panel().receive({ type: 'select', id: 18547 });
      await vi.advanceTimersByTimeAsync(DETAILS_DELAY_MS); // starts 18547's fetch, which hangs
      expect(calls).toEqual([18547]);
      await panel().receive({ type: 'select', id: 18544 });
      await vi.advanceTimersByTimeAsync(DETAILS_DELAY_MS); // 18544 resolves cleanly
      expect(lastState(panel())).toMatchObject({ selected: 18544, details: { id: 18544 }, detailsError: undefined });
      rejectFirst(new Error('too late for 18547'));
      await vi.advanceTimersByTimeAsync(0); // flush the now-settled rejection
      // The stale rejection must not have clobbered 18544's clean state.
      expect(lastState(panel())).toMatchObject({ selected: 18544, details: { id: 18544 }, detailsError: undefined });
    } finally {
      vi.useRealTimers();
    }
  });

  it('loads the page older than the oldest row on Load more', async () => {
    const h = build([{ changesets: RENAMED.slice(0, 6), more: true }, { changesets: RENAMED.slice(6), more: false }]);
    await h.views.show(FILE);
    await panel().receive({ type: 'loadMore' });
    expect(h.pageCalls[1]).toEqual([{ mode: 'file', itemspec: CURRENT }, { before: 18547 }]);
    expect(lastState(panel()).more).toBe(false);
  });

  it('loads the next page before comparing the oldest loaded row', async () => {
    const h = build([{ changesets: RENAMED.slice(0, 6), more: true }, { changesets: RENAMED.slice(6), more: false }]);
    await h.views.show(FILE);
    await panel().receive({ type: 'compare', id: 18547 });
    expect(h.pageCalls).toHaveLength(2);
    expect(h.compared[0][0]).toEqual({ serverPath: OLD_NAME, changeset: 18544 });
  });
});

describe('HistoryViews.show with a changeset to select (the Annotate hover)', () => {
  it('pages until the changeset is listed, then selects it', async () => {
    const h = build([{ changesets: RENAMED.slice(0, 6), more: true }, { changesets: RENAMED.slice(6), more: false }]);
    await h.views.show(FILE, 18544);
    expect(h.pageCalls).toHaveLength(2);
    expect(lastState(panel()).selected).toBe(18544);
  });

  it('stops paging when a page fails, instead of looping', async () => {
    const h = build([{ changesets: RENAMED.slice(0, 6), more: true }, new Error('boom')]);
    await h.views.show(FILE, 18544);
    expect(h.pageCalls).toHaveLength(2);
    expect(lastState(panel())).toMatchObject({ error: 'boom', selected: undefined });
  });

  it('stops paging once the id is above the oldest loaded row, instead of paging through irrelevant older history (D16f)', async () => {
    // Every page says "more", but changeset 999999 is not this file's history
    // at all -- once the oldest loaded row (18547) drops below it, no OLDER
    // page could ever contain it either.
    const h = build([
      { changesets: RENAMED.slice(0, 6), more: true },
      { changesets: RENAMED.slice(0, 6), more: true },
      { changesets: RENAMED.slice(0, 6), more: true },
    ]);
    await h.views.show(FILE, 999999);
    expect(h.pageCalls).toHaveLength(1); // stopped right after the first page landed
    expect(lastState(panel())).toMatchObject({ selected: undefined });
  });

  it('a select requested while a page is loading is remembered and applied once that page lands (D16f)', async () => {
    let resolveSecondPage!: (v: { changesets: Changeset[]; more: boolean }) => void;
    const secondPage = new Promise<{ changesets: Changeset[]; more: boolean }>((r) => {
      resolveSecondPage = r;
    });
    const pageCalls: unknown[] = [];
    const history = {
      page: async (target: unknown, options: unknown) => {
        pageCalls.push([target, options]);
        if (pageCalls.length === 1) return { changesets: RENAMED.slice(0, 6), more: true };
        return secondPage; // "Load more" hangs until the test resolves it
      },
      changeset: async (id: number) => RENAMED.find((c) => c.id === id)!,
    };
    const views = new HistoryViews(
      () => Uri.file('/ext') as never,
      history as never,
      { compare: async () => {}, view: async () => {}, getVersion: async () => {} },
      () => {},
    );
    await views.show(FILE);
    const loadMore = panel().receive({ type: 'loadMore' }); // starts the hanging 2nd page
    await Promise.resolve();
    // 18544 is only on the 2nd (not-yet-landed) page: has(18544) is false right now.
    const select = panel().receive({ type: 'select', id: 18544 });
    resolveSecondPage({ changesets: RENAMED.slice(6), more: false });
    await Promise.all([loadMore, select]);
    expect(lastState(panel()).selected).toBe(18544);
  });
});

describe('HistoryViews.show on an already-open tab merges what is newer (D18b)', () => {
  const cs = (id: number): Changeset => ({
    id,
    user: 'A',
    date: 'd' + id,
    comment: '',
    items: [{ change: ['edit'], serverPath: CURRENT }],
  });

  it('View History again re-fetches page 1 and puts new rows on top, without touching `more`', async () => {
    const h = build([
      { changesets: [cs(10), cs(9), cs(8)], more: true },
      { changesets: [cs(12), cs(11), cs(10)], more: false },
    ]);
    await h.views.show(FILE);
    expect(lastState(panel())).toMatchObject({ more: true });
    expect(lastState(panel()).rows.map((r: { id: number }) => r.id)).toEqual([10, 9, 8]);

    await h.views.show(FILE); // "View History again" on the SAME open tab
    expect(createdPanels).toHaveLength(1); // still one tab, not a second
    expect(h.pageCalls).toHaveLength(2);
    expect(h.pageCalls[1]).toEqual([{ mode: 'file', itemspec: CURRENT }, {}]);
    expect(lastState(panel()).rows.map((r: { id: number }) => r.id)).toEqual([12, 11, 10, 9, 8]);
    // `more` came from page 1 and is untouched by the merge (Load more's state survives).
    expect(lastState(panel())).toMatchObject({ more: true });
  });

  it('a hover select for an id newer than the newest loaded row is applied after the merge lands', async () => {
    const h = build([
      { changesets: [cs(10), cs(9)], more: false },
      { changesets: [cs(12), cs(11), cs(10)], more: false },
    ]);
    await h.views.show(FILE);
    await h.views.show(FILE, 12); // e.g. Annotate's "Changeset details" hover for a brand-new changeset
    expect(lastState(panel())).toMatchObject({ selected: 12 });
    expect(lastState(panel()).rows.map((r: { id: number }) => r.id)).toEqual([12, 11, 10, 9]);
  });

  it('does nothing extra when shown again while a load is already running', async () => {
    let resolveFirst!: (v: { changesets: Changeset[]; more: boolean }) => void;
    const first = new Promise<{ changesets: Changeset[]; more: boolean }>((r) => {
      resolveFirst = r;
    });
    let calls = 0;
    const history = {
      page: async () => {
        calls++;
        return first;
      },
      changeset: async (id: number) => cs(id),
    };
    const views = new HistoryViews(
      () => Uri.file('/ext') as never,
      history as never,
      { compare: async () => {}, view: async () => {}, getVersion: async () => {} },
      () => {},
    );
    const showing = views.show(FILE); // loadFirstPage hangs on `first`
    await Promise.resolve();
    await views.show(FILE); // asked again while still loading -- reveals only
    expect(calls).toBe(1); // no second page call was started
    resolveFirst({ changesets: [cs(9), cs(8)], more: true });
    await showing;
  });

  it('D20h: a failed merge (View History again) shows the page banner, not just a swallowed error', async () => {
    const h = build([{ changesets: RENAMED, more: false }, new HistoryError('tf timed out', 'timeout')]);
    await h.views.show(FILE);
    expect(lastState(panel())).toMatchObject({ error: undefined });
    await h.views.show(FILE); // "View History again" -- the merge's own page() call fails
    expect(lastState(panel())).toMatchObject({ error: 'tf timed out' });
    // The rows already loaded are not thrown away by a failed merge.
    expect(lastState(panel()).rows.map((r: { id: number }) => r.id)).toEqual(RENAMED.map((c) => c.id));
  });
});

describe('D18f/D20c: a select queued behind a fetch that fails is dropped, not replayed', () => {
  it('a plain select() call queued behind a Load More that FAILS is not retried once it settles', async () => {
    let rejectSecondPage!: (e: Error) => void;
    const secondPage = new Promise<{ changesets: Changeset[]; more: boolean }>((_r, reject) => {
      rejectSecondPage = reject;
    });
    let pageCalls = 0;
    const history = {
      page: async () => {
        pageCalls++;
        if (pageCalls === 1) return { changesets: RENAMED.slice(0, 6), more: true };
        return secondPage;
      },
      changeset: async (id: number) => RENAMED.find((c) => c.id === id)!,
    };
    const views = new HistoryViews(
      () => Uri.file('/ext') as never,
      history as never,
      { compare: async () => {}, view: async () => {}, getVersion: async () => {} },
      () => {},
    );
    await views.show(FILE); // page 1: more=true, oldest=18547
    const loadMore = panel().receive({ type: 'loadMore' }); // starts the hanging 2nd page
    await Promise.resolve();
    // A plain select for an id that is not loaded (not until-found): with
    // `model.loading` true, it is stashed as `pendingSelect` rather than
    // starting its own fetch. The OLD `consumePendingSelect()` -- which ran
    // unconditionally -- would replay it once the failing page settled.
    await panel().receive({ type: 'select', id: 1 });
    rejectSecondPage(new Error('boom'));
    await loadMore;
    expect(pageCalls).toBe(2); // the queued select must not have replayed the failed page
    expect(lastState(panel())).toMatchObject({ selected: undefined, error: 'boom' });
  });
});

describe('D20c: one queue serializes every page load', () => {
  const cs = (id: number): Changeset => ({
    id,
    user: 'A',
    date: 'd' + id,
    comment: '',
    items: [{ change: ['edit'], serverPath: CURRENT }],
  });
  const range = (hi: number, lo: number): Changeset[] => {
    const out: Changeset[] = [];
    for (let i = hi; i >= lo; i--) out.push(cs(i));
    return out;
  };

  it("R2: show() while a Load More is in flight still merges, once it is the merge's own turn", async () => {
    let resolveLoadMore!: (v: { changesets: Changeset[]; more: boolean }) => void;
    const loadMorePage = new Promise<{ changesets: Changeset[]; more: boolean }>((r) => {
      resolveLoadMore = r;
    });
    let calls = 0;
    const history = {
      page: async () => {
        calls++;
        if (calls === 1) return { changesets: range(100, 51), more: true };
        if (calls === 2) return loadMorePage;
        return { changesets: range(105, 100), more: true }; // the merge's own page 1
      },
      changeset: async (id: number) => cs(id),
    };
    const views = new HistoryViews(
      () => Uri.file('/ext') as never,
      history as never,
      { compare: async () => {}, view: async () => {}, getVersion: async () => {} },
      () => {},
    );
    await views.show(FILE); // rows 100..51, more:true
    const loadMore = panel().receive({ type: 'loadMore' }); // fetch #2, hangs
    await Promise.resolve();
    const showAgain = views.show(FILE); // reopen()'s merge queued behind #2, not refused
    await Promise.resolve();
    expect(calls).toBe(2); // the merge has not run yet -- it is only queued
    resolveLoadMore({ changesets: range(50, 1), more: false });
    await loadMore;
    await showAgain; // now the merge (call #3) has run and landed
    expect(calls).toBe(3);
    expect(lastState(panel()).rows.map((r: { id: number }) => r.id)).toContain(105); // the merge's new rows made it in
  });

  it('R3: a plain select for an ALREADY LOADED row is not dropped by a concurrent merge', async () => {
    let resolveMerge!: (v: { changesets: Changeset[]; more: boolean }) => void;
    const merge = new Promise<{ changesets: Changeset[]; more: boolean }>((r) => {
      resolveMerge = r;
    });
    let calls = 0;
    const history = {
      page: async () => {
        calls++;
        if (calls === 1) return { changesets: range(10, 6), more: true };
        return merge;
      },
      changeset: async (id: number) => cs(id),
    };
    const views = new HistoryViews(
      () => Uri.file('/ext') as never,
      history as never,
      { compare: async () => {}, view: async () => {}, getVersion: async () => {} },
      () => {},
    );
    await views.show(FILE); // rows 10..6, more:true
    const again = views.show(FILE); // reopen()'s merge queued, hangs on `merge`
    await Promise.resolve();
    // Row 8 is already loaded: this must apply at once, not wait for the
    // unrelated merge (the OLD code deferred every select while ANYTHING was
    // loading, which is what let this get dropped if that merge then failed).
    await panel().receive({ type: 'select', id: 8 });
    expect(lastState(panel())).toMatchObject({ selected: 8 });
    resolveMerge({ changesets: range(12, 8), more: true });
    await again;
    // The merge landing afterward must not have clobbered the selection.
    expect(lastState(panel())).toMatchObject({ selected: 8 });
  });

  it("a second Compare on the oldest row still costs one tf call, not two, now that it is queued (D18f survives D20c)", async () => {
    let resolveSecondPage!: (v: { changesets: Changeset[]; more: boolean }) => void;
    const secondPage = new Promise<{ changesets: Changeset[]; more: boolean }>((r) => {
      resolveSecondPage = r;
    });
    let pageCalls = 0;
    const history = {
      page: async () => {
        pageCalls++;
        if (pageCalls === 1) return { changesets: RENAMED.slice(0, 6), more: true };
        return secondPage;
      },
      changeset: async (id: number) => RENAMED.find((c) => c.id === id)!,
    };
    const compared: unknown[] = [];
    const views = new HistoryViews(
      () => Uri.file('/ext') as never,
      history as never,
      {
        compare: async (l: VersionPointer, r: VersionPointer, n: string) => void compared.push([l, r, n]),
        view: async () => {},
        getVersion: async () => {},
      },
      () => {},
    );
    await views.show(FILE);
    const firstCompare = panel().receive({ type: 'compare', id: 18547 });
    await Promise.resolve();
    const secondCompare = panel().receive({ type: 'compare', id: 18547 }); // queued right behind the first
    resolveSecondPage({ changesets: RENAMED.slice(6), more: false });
    await Promise.all([firstCompare, secondCompare]);
    expect(pageCalls).toBe(2);
    expect(compared).toHaveLength(2);
  });
});

describe('D18f: a second Compare on the same row waits for the page its own needsMoreFor already started', () => {
  it('joins the in-flight fetch instead of refusing against not-yet-loaded data', async () => {
    let resolveSecondPage!: (v: { changesets: Changeset[]; more: boolean }) => void;
    const secondPage = new Promise<{ changesets: Changeset[]; more: boolean }>((r) => {
      resolveSecondPage = r;
    });
    let pageCalls = 0;
    const history = {
      page: async () => {
        pageCalls++;
        if (pageCalls === 1) return { changesets: RENAMED.slice(0, 6), more: true };
        return secondPage;
      },
      changeset: async (id: number) => RENAMED.find((c) => c.id === id)!,
    };
    const compared: unknown[] = [];
    const views = new HistoryViews(
      () => Uri.file('/ext') as never,
      history as never,
      {
        compare: async (l: VersionPointer, r: VersionPointer, n: string) => void compared.push([l, r, n]),
        view: async () => {},
        getVersion: async () => {},
      },
      () => {},
    );
    await views.show(FILE); // page 1 down to 18547 (the oldest loaded row), more=true
    const firstCompare = panel().receive({ type: 'compare', id: 18547 }); // needsMoreFor -> starts fetching page 2
    await Promise.resolve();
    const secondCompare = panel().receive({ type: 'compare', id: 18547 }); // arrives while that fetch is in flight
    resolveSecondPage({ changesets: RENAMED.slice(6), more: false }); // lands 18544
    await Promise.all([firstCompare, secondCompare]);
    expect(pageCalls).toBe(2); // the second Compare did not start a 3rd tf call
    // Both compares succeeded once the shared page landed -- neither was
    // refused against the model as it stood before that page arrived.
    expect(compared).toHaveLength(2);
    expect(recorder.shown).not.toContain(S.previousNotLoaded(18547));
  });
});

describe('D18f: nothing starts after the tab is closed', () => {
  it('select() on a disposed panel starts no details timer', async () => {
    vi.useFakeTimers();
    try {
      const h = build();
      await h.views.show(FILE);
      panel().dispose();
      await panel().receive({ type: 'select', id: 18544 });
      await vi.advanceTimersByTimeAsync(DETAILS_DELAY_MS * 2);
      expect(h.changesetCalls).toEqual([]); // no details timer was ever started
    } finally {
      vi.useRealTimers();
    }
  });

  it('show() does not select() on a panel disposed while reopen() was still awaiting its merge', async () => {
    let resolveMerge!: (v: { changesets: Changeset[]; more: boolean }) => void;
    const merge = new Promise<{ changesets: Changeset[]; more: boolean }>((r) => {
      resolveMerge = r;
    });
    let calls = 0;
    const history = {
      page: async () => {
        calls++;
        if (calls === 1) return { changesets: RENAMED, more: false };
        return merge;
      },
      changeset: async (id: number) => RENAMED.find((c) => c.id === id)!,
    };
    const views = new HistoryViews(
      () => Uri.file('/ext') as never,
      history as never,
      { compare: async () => {}, view: async () => {}, getVersion: async () => {} },
      () => {},
    );
    await views.show(FILE); // populates the tab normally
    const showingAgain = views.show(FILE, 18544); // reopen() starts a merge fetch that hangs
    await Promise.resolve();
    panel().dispose(); // the user closes the tab while the merge is in flight
    resolveMerge({ changesets: [], more: false });
    // Must not throw: postMessage on the mock's disposed panel throws, and a
    // select() reaching the disposed panel would try to post.
    await expect(showingAgain).resolves.toBeUndefined();
  });
});

describe('D18g: Get This Version does not overlap itself', () => {
  it('ignores a second Get This Version click for the same panel while the first is still running', async () => {
    let resolveGet!: () => void;
    const pending = new Promise<void>((r) => {
      resolveGet = r;
    });
    const calls: number[] = [];
    const history = {
      page: async () => ({ changesets: RENAMED, more: false }),
      changeset: async (id: number) => RENAMED.find((c) => c.id === id)!,
    };
    const views = new HistoryViews(
      () => Uri.file('/ext') as never,
      history as never,
      {
        compare: async () => {},
        view: async () => {},
        getVersion: async () => {
          calls.push(1);
          await pending;
        },
      },
      () => {},
    );
    await views.show(FILE);
    const first = panel().receive({ type: 'getVersion', id: 18659 }); // the current-name row: allowed
    await Promise.resolve();
    await panel().receive({ type: 'getVersion', id: 18659 }); // arrives while the first is still running
    expect(calls).toHaveLength(1); // the second click was ignored outright
    resolveGet();
    await first;
  });

  it('D20h: the guard resets after the action THROWS, so a second click still runs', async () => {
    let calls = 0;
    const history = {
      page: async () => ({ changesets: RENAMED, more: false }),
      changeset: async (id: number) => RENAMED.find((c) => c.id === id)!,
    };
    const views = new HistoryViews(
      () => Uri.file('/ext') as never,
      history as never,
      {
        compare: async () => {},
        view: async () => {},
        getVersion: async () => {
          calls++;
          throw new Error('boom');
        },
      },
      () => {},
    );
    await views.show(FILE);
    await panel().receive({ type: 'getVersion', id: 18659 }); // throws; onMessage's own catch shows it
    await panel().receive({ type: 'getVersion', id: 18659 }); // must run again, not be swallowed by a stuck guard
    expect(calls).toBe(2);
  });

  it('D20h: the guard resets after a normal return (e.g. a cancelled confirm), so a second click still runs', async () => {
    let calls = 0;
    const history = {
      page: async () => ({ changesets: RENAMED, more: false }),
      changeset: async (id: number) => RENAMED.find((c) => c.id === id)!,
    };
    const views = new HistoryViews(
      () => Uri.file('/ext') as never,
      history as never,
      {
        compare: async () => {},
        view: async () => {},
        // A real Cancel just returns without throwing (src/commands/history.ts's
        // `getVersion` action returns after `answer !== S.getVersionConfirmYes`).
        getVersion: async () => {
          calls++;
        },
      },
      () => {},
    );
    await views.show(FILE);
    await panel().receive({ type: 'getVersion', id: 18659 }); // "cancelled"
    await panel().receive({ type: 'getVersion', id: 18659 }); // must run again
    expect(calls).toBe(2);
  });
});

describe('disposal safety (D16d)', () => {
  it('posts nothing after being disposed while a page fetch is in flight', async () => {
    let resolvePage!: (v: { changesets: Changeset[]; more: boolean }) => void;
    const pending = new Promise<{ changesets: Changeset[]; more: boolean }>((r) => {
      resolvePage = r;
    });
    const history = {
      page: async () => pending,
      changeset: async (id: number) => RENAMED.find((c) => c.id === id)!,
    };
    const views = new HistoryViews(
      () => Uri.file('/ext') as never,
      history as never,
      { compare: async () => {}, view: async () => {}, getVersion: async () => {} },
      () => {},
    );
    const showing = views.show(FILE); // starts loadFirstPage, which hangs on `pending`
    await Promise.resolve();
    panel().dispose();
    // The mock's postMessage throws for a disposed panel (test/vscode-mock.ts):
    // a missing `if (this.disposed) return` anywhere in this chain fails this test.
    resolvePage({ changesets: RENAMED, more: false });
    await expect(showing).resolves.toBeUndefined();
  });

  it('a debounced details fetch still in flight at dispose posts nothing when it resolves', async () => {
    vi.useFakeTimers();
    try {
      let resolveChangeset!: (c: Changeset) => void;
      const pending = new Promise<Changeset>((r) => {
        resolveChangeset = r;
      });
      const history = {
        page: async () => ({ changesets: RENAMED, more: false }),
        changeset: async () => pending,
      };
      const views = new HistoryViews(
        () => Uri.file('/ext') as never,
        history as never,
        { compare: async () => {}, view: async () => {}, getVersion: async () => {} },
        () => {},
      );
      await views.show(FILE);
      await panel().receive({ type: 'select', id: 18544 });
      await vi.advanceTimersByTimeAsync(DETAILS_DELAY_MS); // starts the changeset fetch, which hangs
      panel().dispose();
      resolveChangeset(RENAMED[RENAMED.length - 1]);
      // Flushing must not throw: postMessage on the disposed mock panel throws.
      await vi.advanceTimersByTimeAsync(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('the pending details timer is cleared on dispose, so it never fires at all', async () => {
    vi.useFakeTimers();
    try {
      const h = build();
      await h.views.show(FILE);
      await panel().receive({ type: 'select', id: 18544 });
      panel().dispose();
      await vi.advanceTimersByTimeAsync(DETAILS_DELAY_MS * 2);
      expect(h.changesetCalls).toEqual([]); // the timer never fired
    } finally {
      vi.useRealTimers();
    }
  });
});
