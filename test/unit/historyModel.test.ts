import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseHistory, type Changeset } from '../../src/tf/parseHistory.js';
import { HistoryModel, parseIntent, DETAILS_CAP } from '../../src/history/historyModel.js';
import { S } from '../../src/tf/strings.js';

const parsed = (name: string): Changeset[] =>
  parseHistory(readFileSync(join(__dirname, '../fixtures/windows', name)).toString('utf8')).changesets;

const CURRENT = '$/Shop/Shop2023/ShopModel/Till/tillPOSReply.vb';
const OLD_NAME = '$/Shop/Shop2023/ShopModel/Till/tillPOSReplies.vb';

function renamedFile(more = false): HistoryModel {
  const model = new HistoryModel('file', CURRENT, 'tillPOSReply.vb');
  model.append({ changesets: parsed('history-file-renamed-itemmode.txt'), more });
  return model;
}

// SYNTHETIC: a file's own history, built inline rather than from a capture, so each
// D13 refusal (a plain edit row's ancestor, an undelete's, a deleted row itself) can
// be pinned in isolation. tf's actual text shape is unaffected by the fake content.
const SYNTH_PATH = '$/Synth/Folder/file.vb';
const SYNTH_HISTORY = `-------------------------------------------------------------------------------
Changeset: 30
User: A
Date: 1. sijecnja 2026. 10:00:00

Comment:
  edit thirty

Items:
  edit $/Synth/Folder/file.vb

-------------------------------------------------------------------------------
Changeset: 25
User: A
Date: 1. sijecnja 2026. 09:00:00

Comment:
  undeleted

Items:
  undelete $/Synth/Folder/file.vb

-------------------------------------------------------------------------------
Changeset: 20
User: A
Date: 1. sijecnja 2026. 08:00:00

Comment:
  deleted

Items:
  delete $/Synth/Folder/file.vb;X999

-------------------------------------------------------------------------------
Changeset: 10
User: A
Date: 1. sijecnja 2026. 07:00:00

Comment:
  edit ten

Items:
  edit $/Synth/Folder/file.vb

-------------------------------------------------------------------------------
Changeset: 5
User: A
Date: 1. sijecnja 2026. 06:00:00

Comment:
  added

Items:
  add $/Synth/Folder/file.vb
`;

function synthFile(more = false): HistoryModel {
  const model = new HistoryModel('file', SYNTH_PATH, 'file.vb');
  model.append({ changesets: parseHistory(SYNTH_HISTORY).changesets, more });
  return model;
}

/** SYNTHETIC: a single-row history, used to isolate one row's behaviour as "the oldest". */
function synthSingleRow(record: string, more: boolean): HistoryModel {
  const model = new HistoryModel('file', SYNTH_PATH, 'file.vb');
  model.append({ changesets: parseHistory(record).changesets, more });
  return model;
}

const EDIT_ONLY = `-------------------------------------------------------------------------------
Changeset: 10
User: A
Date: 1. sijecnja 2026. 07:00:00

Comment:
  edit only

Items:
  edit $/Synth/Folder/file.vb
`;

const BRANCH_ONLY = `-------------------------------------------------------------------------------
Changeset: 80
User: A
Date: 1. sijecnja 2026. 07:00:00

Comment:
  branched

Items:
  branch $/Synth/Folder/file.vb
`;

// Printed path is the SYNTH_PATH's case-fold, pinning that D1's identity check is case-insensitive.
const CASE_FOLDED = `-------------------------------------------------------------------------------
Changeset: 50
User: A
Date: 1. sijecnja 2026. 07:00:00

Comment:
  same file, different case in the printed path

Items:
  edit $/SYNTH/FOLDER/FILE.VB
`;

describe('parseIntent: everything the webview may send', () => {
  it('accepts each allowed shape and keeps only the fields it knows', () => {
    expect(parseIntent({ type: 'ready' })).toEqual({ type: 'ready' });
    expect(parseIntent({ type: 'loadMore' })).toEqual({ type: 'loadMore' });
    expect(parseIntent({ type: 'select', id: 21082 })).toEqual({ type: 'select', id: 21082 });
    expect(parseIntent({ type: 'getVersion', id: 5 })).toEqual({ type: 'getVersion', id: 5 });
    expect(parseIntent({ type: 'compare', id: 5 })).toEqual({ type: 'compare', id: 5 });
    expect(parseIntent({ type: 'compare', id: 5, item: 2 })).toEqual({ type: 'compare', id: 5, item: 2 });
    expect(parseIntent({ type: 'view', id: 5, item: 0 })).toEqual({ type: 'view', id: 5, item: 0 });
    expect(parseIntent({ type: 'view', id: 5, path: '$/evil', args: ['/overwrite'] })).toEqual({ type: 'view', id: 5 });
  });

  it('drops anything else', () => {
    for (const bad of [
      null, 'select', [], { type: 'exec', cmd: 'x' }, { type: 'select' }, { type: 'select', id: 0 },
      { type: 'select', id: -3 }, { type: 'select', id: 1.5 }, { type: 'select', id: '21082' },
      { type: 'view', id: 5, item: -1 }, { type: 'view', id: 5, item: 1.5 }, { type: 'getVersion', id: 5, item: 0 },
    ]) {
      expect(parseIntent(bad), JSON.stringify(bad)).toBeUndefined();
    }
  });
});

describe('HistoryModel: file history', () => {
  it('compares a row with the next older row', () => {
    expect(renamedFile().compare(18552)).toEqual({
      ok: true,
      value: { left: { serverPath: CURRENT, changeset: 18547 }, right: { serverPath: CURRENT, changeset: 18552 } },
    });
  });

  it('follows the rename: the older side of the rename row is the OLD name (F9)', () => {
    expect(renamedFile().compare(18547)).toEqual({
      ok: true,
      value: { left: { serverPath: OLD_NAME, changeset: 18544 }, right: { serverPath: CURRENT, changeset: 18547 } },
    });
  });

  it('refuses to compare the row where the file was added', () => {
    expect(renamedFile().compare(18544)).toEqual({ ok: false, message: S.noPreviousVersion(18544) });
  });

  it('views a pre-rename version under the name it had then', () => {
    expect(renamedFile().view(18544)).toEqual({ ok: true, value: { serverPath: OLD_NAME, changeset: 18544 } });
  });

  it('gets only versions under the current name (D1)', () => {
    expect(renamedFile().getVersion(18659)).toEqual({ ok: true, value: { serverPath: CURRENT, changeset: 18659 } });
    expect(renamedFile().getVersion(18544)).toEqual({ ok: false, message: S.getVersionRenamed });
  });

  it('refuses a changeset that is not in the list', () => {
    expect(renamedFile().compare(1)).toEqual({ ok: false, message: S.historyStale });
    expect(renamedFile().view(1)).toEqual({ ok: false, message: S.historyStale });
    expect(renamedFile().getVersion(1)).toEqual({ ok: false, message: S.historyStale });
  });

  it('says the oldest loaded row needs the next page when more exist', () => {
    expect(renamedFile(true).needsMoreFor(18544)).toBe(true);
    expect(renamedFile(false).needsMoreFor(18544)).toBe(false);
    expect(renamedFile(true).needsMoreFor(18547)).toBe(false);
  });

  it('tells the webview what each row allows', () => {
    const rows = renamedFile().state().rows;
    const row = (id: number) => rows.find((r) => r.id === id)!;
    expect(row(18552)).toMatchObject({ canCompare: true, canView: true, canGet: true });
    expect(row(18544)).toMatchObject({ canCompare: false, canView: true, canGet: false });
    expect(row(18659).firstLine).toBe('Teller_ID');
  });
});

describe('HistoryModel: file history, synthetic (D13)', () => {
  it('refuses compare, view and getVersion on a deleted row, and its state row disallows all three', () => {
    const model = synthFile();
    expect(model.compare(20)).toEqual({ ok: false, message: S.versionDeleted(20) });
    expect(model.view(20)).toEqual({ ok: false, message: S.versionDeleted(20) });
    expect(model.getVersion(20)).toEqual({ ok: false, message: S.versionDeleted(20) });
    const row20 = model.state().rows.find((r) => r.id === 20)!;
    expect(row20).toMatchObject({ canView: false, canGet: false, canCompare: false });
  });

  it('refuses compare on an undelete row as "where it began", but still gets that version', () => {
    const model = synthFile();
    expect(model.compare(25)).toEqual({ ok: false, message: S.noPreviousVersion(25) });
    expect(model.getVersion(25)).toEqual({ ok: true, value: { serverPath: SYNTH_PATH, changeset: 25 } });
  });

  it('pairs an edit row with the undelete row right below it', () => {
    expect(synthFile().compare(30)).toEqual({
      ok: true,
      value: { left: { serverPath: SYNTH_PATH, changeset: 25 }, right: { serverPath: SYNTH_PATH, changeset: 30 } },
    });
  });

  it('gets an older edit row at the CURRENT server path', () => {
    expect(synthFile().getVersion(10)).toEqual({ ok: true, value: { serverPath: SYNTH_PATH, changeset: 10 } });
  });

  it('refuses to compare a branch row like an add (BEGINNINGS)', () => {
    expect(synthSingleRow(BRANCH_ONLY, false).compare(80)).toEqual({ ok: false, message: S.noPreviousVersion(80) });
  });

  it('refuses compare on the oldest row with "load more" when the previous page has not arrived (D13)', () => {
    expect(synthSingleRow(EDIT_ONLY, true).compare(10)).toEqual({ ok: false, message: S.previousNotLoaded(10) });
  });

  it('refuses compare on the oldest row as "where it began" once there is nothing more to load', () => {
    expect(synthSingleRow(EDIT_ONLY, false).compare(10)).toEqual({ ok: false, message: S.noPreviousVersion(10) });
  });

  it('compares the printed path to the current path case-insensitively (D1)', () => {
    expect(synthSingleRow(CASE_FOLDED, false).getVersion(50)).toEqual({
      ok: true,
      value: { serverPath: '$/Synth/Folder/file.vb', changeset: 50 },
    });
  });
});

describe('HistoryModel: folder history', () => {
  const folder = () => {
    const model = new HistoryModel('folder', '$/Shop/Shop2023/Distribution', 'Distribution');
    model.append({ changesets: parsed('history-folder-page1.txt'), more: true });
    return model;
  };

  it('offers details only: compare, view and get are refused on a folder row', () => {
    const model = folder();
    expect(model.compare(21082)).toEqual({ ok: false, message: S.folderRowAction });
    expect(model.view(21082)).toEqual({ ok: false, message: S.folderRowAction });
    expect(model.getVersion(21082)).toEqual({ ok: false, message: S.folderRowAction });
    expect(model.state().rows.every((r) => !r.canCompare && !r.canView && !r.canGet)).toBe(true);
  });

  it('appends the next page without duplicates, newest first, and remembers the oldest', () => {
    const model = folder();
    model.append({ changesets: [...parsed('history-folder-page2.txt'), ...parsed('history-folder-page1.txt')], more: false });
    expect(model.state().rows.map((r) => r.id)).toEqual([21082, 21043, 21032, 21019, 21018, 21016, 21013, 20995, 20993, 20992]);
    expect(model.oldest).toBe(20992);
    expect(model.more).toBe(false);
  });

  it('drops duplicate ids WITHIN one incoming page, not just ones already held (D13)', () => {
    // SYNTHETIC: only the ids matter for dedup/sort, so minimal changesets stand in for real ones.
    const cs = (id: number): Changeset => ({ id, user: 'A', date: 'd', comment: '', items: [] });
    const model = new HistoryModel('folder', '$/A', 'A');
    model.append({ changesets: [cs(7), cs(7), cs(5)], more: false });
    expect(model.state().rows.map((r) => r.id)).toEqual([7, 5]);
  });
});

describe('HistoryModel.mergeNewest (D18b)', () => {
  const cs = (id: number): Changeset => ({ id, user: 'A', date: 'd' + id, comment: '', items: [] });
  const range = (hi: number, lo: number): Changeset[] => {
    const out: Changeset[] = [];
    for (let i = hi; i >= lo; i--) out.push(cs(i));
    return out;
  };

  it('adds rows not already held, keeping newest-first order', () => {
    const model = new HistoryModel('folder', '$/A', 'A');
    model.append({ changesets: [cs(5), cs(4)], more: true });
    model.mergeNewest({ changesets: [cs(7), cs(6), cs(5)], more: false });
    expect(model.state().rows.map((r) => r.id)).toEqual([7, 6, 5, 4]);
  });

  it('does NOT change `more`, unlike append', () => {
    const model = new HistoryModel('folder', '$/A', 'A');
    model.append({ changesets: [cs(5)], more: true });
    model.mergeNewest({ changesets: [cs(6)], more: false });
    expect(model.more).toBe(true);
    expect(model.oldest).toBe(5);
  });

  it('drops duplicate ids within the incoming page too', () => {
    const model = new HistoryModel('folder', '$/A', 'A');
    model.append({ changesets: [cs(5)], more: false });
    model.mergeNewest({ changesets: [cs(7), cs(7)], more: false });
    expect(model.state().rows.map((r) => r.id)).toEqual([7, 5]);
  });

  it('is a no-op when every row it is given is already held', () => {
    const model = new HistoryModel('folder', '$/A', 'A');
    model.append({ changesets: [cs(5), cs(4)], more: true });
    model.mergeNewest({ changesets: [cs(5), cs(4)], more: false });
    expect(model.state().rows.map((r) => r.id)).toEqual([5, 4]);
    expect(model.more).toBe(true);
  });

  it('D20b: REPLACES the rows, and takes `more`, when page 1 shares no id with what is loaded and says there is more', () => {
    // 100..51 held (page 1 from an earlier open); 60+ check-ins land, so a
    // fresh page 1 comes back as 160..111 -- nothing in common with 100..51.
    const model = new HistoryModel('file', '$/A', 'A');
    model.append({ changesets: range(100, 51), more: true });
    model.mergeNewest({ changesets: range(160, 111), more: true });
    expect(model.state().rows.map((r) => r.id)).toEqual(range(160, 111).map((c) => c.id));
    expect(model.more).toBe(true);
  });

  it('D20b: with an overlap, the merge behaves as before even when more is true', () => {
    const model = new HistoryModel('file', '$/A', 'A');
    model.append({ changesets: range(10, 6), more: true });
    model.mergeNewest({ changesets: range(12, 8), more: true }); // 10, 9, 8 overlap
    expect(model.state().rows.map((r) => r.id)).toEqual([12, 11, 10, 9, 8, 7, 6]);
    expect(model.more).toBe(true); // unchanged by the merge, per D18b
  });
});

describe('HistoryModel: the details pane', () => {
  const withDetails = () => {
    const model = new HistoryModel('folder', '$/Shop/Shop2023', 'Shop2023');
    const [cs] = parsed('history-changeset-rename-delete.txt');
    model.append({ changesets: [cs], more: false });
    model.setDetails(cs);
    model.selected = cs.id;
    return model;
  };

  it('views a deleted item as it was just before the delete', () => {
    expect(withDetails().view(20213, 0)).toEqual({
      ok: true,
      value: {
        serverPath: '$/Shop/Shop2023/Raverus.FiskalizacijaDEV.Standard/Raverus.FiskalizacijaDEV.sln',
        changeset: 20212,
      },
    });
  });

  it('refuses to compare a renamed item up front (D9)', () => {
    expect(withDetails().compare(20213, 1)).toEqual({
      ok: false,
      message: S.compareRenamedItem('Raverus.FiskalizacijaDEV.sln.bak'),
    });
  });

  it('compares an edited item with the changeset before it', () => {
    const model = new HistoryModel('folder', '$/Shop', 'Shop');
    const [cs] = parsed('history-changeset-multiline.txt');
    model.append({ changesets: [cs], more: false });
    model.setDetails(cs);
    expect(model.compare(13559, 0)).toEqual({
      ok: true,
      value: {
        left: { serverPath: '$/Shop/Shop2013/Distribution/classes/TransferApiClient.vb', changeset: 13558 },
        right: { serverPath: '$/Shop/Shop2013/Distribution/classes/TransferApiClient.vb', changeset: 13559 },
      },
    });
  });

  it('refuses an item index that does not exist, or details not loaded', () => {
    expect(withDetails().view(20213, 2)).toEqual({ ok: false, message: S.historyStale });
    const model = new HistoryModel('folder', '$/Shop', 'Shop');
    model.append({ changesets: parsed('history-changeset-multiline.txt'), more: false });
    expect(model.view(13559, 0)).toEqual({ ok: false, message: S.historyStale });
  });

  it('refuses a details-item action on an id that is not in the loaded rows (D13)', () => {
    // Details can be loaded for a changeset (e.g. from an earlier page) without it being
    // a currently-loaded row; "unlisted ids are rejected" must hold here too.
    const model = new HistoryModel('folder', '$/Shop', 'Shop');
    const [cs] = parsed('history-changeset-multiline.txt');
    model.setDetails(cs);
    expect(model.compare(13559, 0)).toEqual({ ok: false, message: S.historyStale });
    expect(model.view(13559, 0)).toEqual({ ok: false, message: S.historyStale });
  });

  it('views an edited item at the SAME changeset it was edited in, not the one before', () => {
    const model = new HistoryModel('folder', '$/Shop', 'Shop');
    const [cs] = parsed('history-changeset-multiline.txt');
    model.append({ changesets: [cs], more: false });
    model.setDetails(cs);
    expect(model.view(13559, 0)).toEqual({
      ok: true,
      value: { serverPath: '$/Shop/Shop2013/Distribution/classes/TransferApiClient.vb', changeset: 13559 },
    });
  });

  it('views a renamed (non-deleted) item at the SAME changeset, not id - 1', () => {
    expect(withDetails().view(20213, 1)).toEqual({
      ok: true,
      value: {
        serverPath: '$/Shop/Shop2023/Raverus.FiskalizacijaDEV.Standard/Raverus.FiskalizacijaDEV.sln.bak',
        changeset: 20213,
      },
    });
  });

  it('shows the selected changeset with its full comment and what each item allows', () => {
    const details = withDetails().state().details!;
    expect(details.id).toBe(20213);
    expect(details.items).toEqual([
      { index: 0, change: 'delete, source rename', path: '$/Shop/Shop2023/Raverus.FiskalizacijaDEV.Standard/Raverus.FiskalizacijaDEV.sln', canCompare: false },
      { index: 1, change: 'rename', path: '$/Shop/Shop2023/Raverus.FiskalizacijaDEV.Standard/Raverus.FiskalizacijaDEV.sln.bak', canCompare: false },
    ]);
    expect(details.note).toBeUndefined();
  });

  it('renders at most DETAILS_CAP items and says how many there are', () => {
    // SYNTHETIC: a changeset larger than the cap.
    const big: Changeset = {
      id: 9, user: 'A', date: 'd', comment: '',
      items: Array.from({ length: DETAILS_CAP + 1 }, (_, i) => ({ change: ['add'], serverPath: `$/A/${i}.vb` })),
    };
    const model = new HistoryModel('folder', '$/A', 'A');
    model.append({ changesets: [big], more: false });
    model.setDetails(big);
    model.selected = 9;
    const details = model.state().details!;
    expect(details.items).toHaveLength(DETAILS_CAP);
    expect(details.note).toBe(S.historyShowingOf(DETAILS_CAP, DETAILS_CAP + 1));
    expect(model.view(9, DETAILS_CAP)).toEqual({ ok: false, message: S.historyStale });
  });
});

describe('HistoryModel.state', () => {
  it('reports empty only once loading is over and nothing failed', () => {
    const model = new HistoryModel('file', '$/A', 'A');
    model.loading = true;
    expect(model.state().empty).toBe(false);
    model.loading = false;
    expect(model.state().empty).toBe(true);
    model.error = 'boom';
    expect(model.state().empty).toBe(false);
  });

  it('keeps the page error and the details error as separate fields (D18c)', () => {
    const model = new HistoryModel('file', '$/A', 'A');
    model.error = 'page banner failure';
    model.detailsError = 'details pane failure';
    const state = model.state();
    expect(state.error).toBe('page banner failure');
    expect(state.detailsError).toBe('details pane failure');
  });

  it('carries the title and every label the webview shows', () => {
    const state = new HistoryModel('file', '$/A/frmInvoice.vb', 'frmInvoice.vb').state();
    expect(state.title).toBe('History - frmInvoice.vb');
    expect(state.labels).toEqual(S.historyLabels);
  });
});
