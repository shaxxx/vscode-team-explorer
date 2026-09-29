import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadPage, type FakeElement } from '../helpers/fakeDom.js';
import { S } from '../../src/tf/strings.js';

const SCRIPT = readFileSync(join(__dirname, '../../media/shelvesets.js'), 'utf8');
const L = S.shelvesetsLabels;
const MINE = 'EF6 Migration 9;user@example.com';
const THEIRS = 'Popravak web servisa;colleague@example.com';
const EVIL = '<img src=x onerror=alert(1)>;x';
const A = '$/K/a.cs';
const B = '$/K/b.cs';

function state(over: Record<string, unknown> = {}) {
  return {
    owner: 'Filip',
    listState: 'ok',
    rows: [
      { key: MINE, name: 'EF6 Migration 9', owner: 'Filip', date: '2026-06-25 15:08', comment: 'EF6 Migration 7', mine: true },
      { key: THEIRS, name: 'Popravak web servisa', owner: 'Colleague', date: '2026-02-25 15:57', comment: 'Ažuriranje, Zatvaranje', mine: false },
      { key: EVIL, name: '<img src=x onerror=alert(1)>', owner: 'x', date: 'd', comment: '', mine: false },
    ],
    labels: L,
    ...over,
  };
}

function withDetails(over: Record<string, unknown> = {}) {
  return state({
    selected: MINE,
    details: {
      key: MINE, name: 'EF6 Migration 9', owner: 'Filip', date: '2026-06-25 15:08', comment: 'line 1\nline 2', mine: true,
      state: 'ok', preserve: true, busy: false,
      changes: [
        { serverPath: A, name: 'a.cs', folder: '$/K', change: 'edit', ticked: true },
        { serverPath: B, name: 'old.cs → b.cs', folder: '$/K', change: 'rename', ticked: false },
      ],
      ...over,
    },
  });
}

const buttonNamed = (root: FakeElement, text: string) => root.querySelectorAll('button').find((b) => b.textContent === text)!;
const rowOf = (page: ReturnType<typeof loadPage>, key: string) => page.app.querySelector(`tr[data-path="${key}"]`)!;
const last = (page: ReturnType<typeof loadPage>) => page.posted[page.posted.length - 1];

describe('media/shelvesets.js', () => {
  it('says ready first', () => {
    expect(loadPage(SCRIPT).posted[0]).toEqual({ type: 'ready' });
  });

  it('draws every shelveset, putting tf text in as text only', () => {
    const page = loadPage(SCRIPT);
    page.send(state());
    expect(rowOf(page, MINE).children.map((td) => td.textContent)).toEqual(['EF6 Migration 9', 'Filip', '2026-06-25 15:08', 'EF6 Migration 7']);
    expect(rowOf(page, EVIL).children[0].textContent).toBe('<img src=x onerror=alert(1)>');
    expect(page.body.querySelectorAll('img')).toHaveLength(0);
  });

  it('selects a shelveset on click', () => {
    const page = loadPage(SCRIPT);
    page.send(state());
    page.fire(rowOf(page, THEIRS), 'click');
    expect(last(page)).toEqual({ type: 'select', key: THEIRS });
  });

  it('does nothing when the already-selected row is clicked again, so a re-tick or Preserve choice is never thrown away', () => {
    const page = loadPage(SCRIPT);
    page.send(withDetails());
    const before = page.posted.length;
    page.fire(rowOf(page, MINE), 'click');
    expect(page.posted.length).toBe(before);
    page.fire(rowOf(page, THEIRS), 'click');
    expect(last(page)).toEqual({ type: 'select', key: THEIRS });
  });

  it('keeps showing the owner the extension sends, unless the user is mid-edit', () => {
    const page = loadPage(SCRIPT);
    page.send(state({ owner: '' }));
    const owner = page.app.querySelector('.owner')!;
    expect(owner.value).toBe('');
    page.send(state({ owner: 'Filip' }));
    expect(owner.value).toBe('Filip');
    // The user starts typing a different owner before the next state arrives.
    owner.value = 'Nika';
    page.fire(owner, 'input');
    page.send(state({ owner: 'Boris' }));
    expect(owner.value).toBe('Nika');
    // Posting Find clears the "mid-edit" flag, so the next state syncs again.
    page.fire(owner, 'keydown', { key: 'Enter' });
    page.send(state({ owner: 'Boris' }));
    expect(owner.value).toBe('Boris');
  });

  it('finds another owner from the button and from Enter, with what was typed', () => {
    const page = loadPage(SCRIPT);
    page.send(state());
    const owner = page.app.querySelector('.owner')!;
    expect(owner.value).toBe('Filip');
    owner.value = 'Nika Blaškova';
    page.fire(owner, 'keydown', { key: 'Enter' });
    expect(last(page)).toEqual({ type: 'find', owner: 'Nika Blaškova' });
    owner.value = '*';
    page.fire(buttonNamed(page.app, L.find), 'click');
    expect(last(page)).toEqual({ type: 'find', owner: '*' });
  });

  it('filters by name or comment on the page, without asking the extension, and remembers the filter', () => {
    const page = loadPage(SCRIPT);
    page.send(state());
    const before = page.posted.length;
    const filter = page.app.querySelector('.filter')!;
    filter.value = 'zatvaranje';
    page.fire(filter, 'input');
    expect(page.app.querySelectorAll('tr').filter((tr) => tr.getAttribute('data-path') !== null).map((tr) => tr.getAttribute('data-path'))).toEqual([THEIRS]);
    expect(page.posted.length).toBe(before);
    expect(page.saved[page.saved.length - 1]).toMatchObject({ filter: 'zatvaranje' });
  });

  it('filters by a name fragment case-insensitively, and never matches on the owner', () => {
    const page = loadPage(SCRIPT);
    page.send(state());
    const filter = page.app.querySelector('.filter')!;
    filter.value = 'eF6';
    page.fire(filter, 'input');
    expect(page.app.querySelectorAll('tr').filter((tr) => tr.getAttribute('data-path') !== null).map((tr) => tr.getAttribute('data-path'))).toEqual([MINE]);
    // "Filip" is the owner of the MINE row, not its name or comment: it must match nothing.
    filter.value = 'filip';
    page.fire(filter, 'input');
    expect(page.app.querySelectorAll('tr').filter((tr) => tr.getAttribute('data-path') !== null)).toHaveLength(0);
    expect(page.app.textContent).toContain(L.noMatch);
  });

  it('keeps the SAME toolbar inputs across renders, so typing never loses the caret', () => {
    const page = loadPage(SCRIPT);
    page.send(state());
    const owner = page.app.querySelector('.owner');
    page.send(withDetails());
    expect(page.app.querySelector('.owner')).toBe(owner);
  });

  it('shows the details: the whole comment, and a tick box per change', () => {
    const page = loadPage(SCRIPT);
    page.send(withDetails());
    expect(page.app.querySelector('pre')!.textContent).toBe('line 1\nline 2');
    const rowA = rowOf(page, A);
    expect(rowA.children.map((td) => td.textContent).slice(1)).toEqual(['a.cs', '$/K', 'edit']);
    const box = rowOf(page, B).querySelector('input')!;
    expect(box.checked).toBe(false);
    box.checked = true;
    page.fire(box, 'change');
    expect(last(page)).toEqual({ type: 'tick', paths: [B], ticked: true });
  });

  it('ticks or unticks every change from the header box', () => {
    const page = loadPage(SCRIPT);
    page.send(withDetails());
    // The changes table's first input is its header box: thead comes before tbody.
    const all = page.app.querySelector('.changes')!.querySelector('input')!;
    all.checked = true;
    page.fire(all, 'change');
    expect(last(page)).toEqual({ type: 'tick', paths: [A, B], ticked: true });
  });

  it('shows the header box checked only when every change is ticked, and indeterminate when only some are', () => {
    // withDetails(): A ticked, B not -- some but not all.
    const somePage = loadPage(SCRIPT);
    somePage.send(withDetails());
    const someBox = somePage.app.querySelector('.changes')!.querySelector('input')! as unknown as { checked: boolean; indeterminate?: boolean };
    expect(someBox.checked).toBe(false);
    expect(someBox.indeterminate).toBe(true);

    const nonePage = loadPage(SCRIPT);
    nonePage.send(withDetails({ changes: [
      { serverPath: A, name: 'a.cs', folder: '$/K', change: 'edit', ticked: false },
      { serverPath: B, name: 'old.cs → b.cs', folder: '$/K', change: 'rename', ticked: false },
    ] }));
    const noneBox = nonePage.app.querySelector('.changes')!.querySelector('input')! as unknown as { checked: boolean; indeterminate?: boolean };
    expect(noneBox.checked).toBe(false);
    expect(noneBox.indeterminate).toBeFalsy();

    const allPage = loadPage(SCRIPT);
    allPage.send(withDetails({ changes: [
      { serverPath: A, name: 'a.cs', folder: '$/K', change: 'edit', ticked: true },
      { serverPath: B, name: 'old.cs → b.cs', folder: '$/K', change: 'rename', ticked: true },
    ] }));
    const allBox = allPage.app.querySelector('.changes')!.querySelector('input')! as unknown as { checked: boolean; indeterminate?: boolean };
    expect(allBox.checked).toBe(true);
    expect(allBox.indeterminate).toBeFalsy();
  });

  it('does not open Compare on a double-click on a tick box', () => {
    const page = loadPage(SCRIPT);
    page.send(withDetails());
    const box = rowOf(page, B).querySelector('input')!;
    const before = page.posted.length;
    page.fire(box, 'dblclick');
    expect(page.posted.length).toBe(before);
  });

  it('compares with unmodified on double-click, and offers the three file actions on right-click', () => {
    const page = loadPage(SCRIPT);
    page.send(withDetails());
    page.fire(rowOf(page, A), 'dblclick');
    expect(last(page)).toEqual({ type: 'file', action: 'compareUnmodified', path: A });
    page.fire(rowOf(page, A), 'contextmenu');
    const menu = page.body.querySelector('.menu')!;
    expect(menu.querySelectorAll('button').map((b) => b.textContent)).toEqual([L.compareUnmodified, L.compareWorkspace, L.viewShelved]);
    page.fire(buttonNamed(menu, L.compareWorkspace), 'click');
    expect(last(page)).toEqual({ type: 'file', action: 'compareWorkspace', path: A });
    expect(page.body.querySelector('.menu')).toBeNull();
  });

  it('posts Unshelve and Preserve; a dimmed Unshelve still posts, so the extension can say why', () => {
    const page = loadPage(SCRIPT);
    page.send(withDetails());
    const preserve = page.app.querySelector('.check')!.querySelector('input')!;
    preserve.checked = false;
    page.fire(preserve, 'change');
    expect(last(page)).toEqual({ type: 'preserve', value: false });
    page.fire(buttonNamed(page.app, L.unshelve), 'click');
    expect(last(page)).toEqual({ type: 'unshelve' });
    page.send(withDetails({ changes: [] }));
    const dimmed = buttonNamed(page.app, L.unshelve);
    expect(dimmed.className).toContain('dim');
    page.fire(dimmed, 'click');
    expect(last(page)).toEqual({ type: 'unshelve' });
  });

  it("dims Delete on a colleague's shelveset, in the details and in the list's right-click menu", () => {
    const page = loadPage(SCRIPT);
    page.send(withDetails({ key: THEIRS, mine: false }));
    expect(buttonNamed(page.app, L.delete).className).toContain('dim');
    page.fire(rowOf(page, THEIRS), 'contextmenu');
    const item = buttonNamed(page.body.querySelector('.menu')!, L.delete);
    expect(item.className).toContain('dim');
    page.fire(item, 'click');
    expect(last(page)).toEqual({ type: 'delete', key: THEIRS });
  });

  it("gives a dimmed Delete a title with the reason, in the details and in the list's menu -- your own has none", () => {
    const reason = S.shelvesetDeleteNotYours('Popravak web servisa');
    const listPage = loadPage(SCRIPT);
    listPage.send(state({ rows: [
      { key: MINE, name: 'EF6 Migration 9', owner: 'Filip', date: '2026-06-25 15:08', comment: 'EF6 Migration 7', mine: true },
      { key: THEIRS, name: 'Popravak web servisa', owner: 'Colleague', date: '2026-02-25 15:57', comment: 'Ažuriranje, Zatvaranje', mine: false, deleteTitle: reason },
    ] }));
    listPage.fire(rowOf(listPage, THEIRS), 'contextmenu');
    expect(buttonNamed(listPage.body.querySelector('.menu')!, L.delete).getAttribute('title')).toBe(reason);
    listPage.fire(rowOf(listPage, MINE), 'contextmenu');
    expect(buttonNamed(listPage.body.querySelector('.menu')!, L.delete).getAttribute('title')).toBeNull();

    const theirsDetails = loadPage(SCRIPT);
    theirsDetails.send(withDetails({ key: THEIRS, mine: false, deleteTitle: reason }));
    expect(buttonNamed(theirsDetails.app, L.delete).getAttribute('title')).toBe(reason);

    const mineDetails = loadPage(SCRIPT);
    mineDetails.send(withDetails());
    expect(buttonNamed(mineDetails.app, L.delete).getAttribute('title')).toBeNull();
  });

  it('says loading, none, and a failure with a Retry', () => {
    const page = loadPage(SCRIPT);
    page.send(state({ listState: 'loading', rows: [] }));
    expect(page.app.textContent).toContain(L.loading);
    page.send(state({ rows: [] }));
    expect(page.app.textContent).toContain(L.none);
    page.send(state({ listState: 'failed', listError: 'TF14045: no such owner', rows: [] }));
    expect(page.app.textContent).toContain('TF14045: no such owner');
    page.fire(buttonNamed(page.app, L.retry), 'click');
    expect(last(page)).toEqual({ type: 'refresh' });
  });

  it('shows an owner the extension refused', () => {
    const page = loadPage(SCRIPT);
    page.send(state({ ownerError: S.shelvesetsBadOwner }));
    expect(page.app.textContent).toContain(S.shelvesetsBadOwner);
  });

  it('saves the owner and the selection for a restart', () => {
    const page = loadPage(SCRIPT);
    page.send(withDetails());
    expect(page.saved[page.saved.length - 1]).toMatchObject({ owner: 'Filip', selected: MINE });
  });
});
