import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadPage, type FakeElement } from '../helpers/fakeDom.js';
import { S } from '../../src/tf/strings.js';
import { ACTIONS } from '../../src/explorer/explorerModel.js';

const SCRIPT = readFileSync(join(__dirname, '../../media/explorer.js'), 'utf8');
const L = S.sceLabels;

const README = '$/Shop/readme.txt';
const EVIL = '$/Shop/<img src=x onerror=alert(1)>';

function state(over: Record<string, unknown> = {}) {
  return {
    title: 'Source Control Explorer',
    path: '$/Shop',
    crumbs: [{ name: '$/', path: '$/' }, { name: 'Shop', path: '$/Shop' }],
    tree: [
      { path: '$/', name: '$/', depth: 0, expanded: true, loading: false, current: false },
      { path: '$/Shop', name: 'Shop', depth: 1, expanded: true, loading: false, current: true },
    ],
    rows: [
      { name: 'Shop2023', serverPath: '$/Shop/Shop2023', isFolder: true, pending: '', users: [], userDetails: [], latest: 'yes', lastCheckIn: '10. studenog 2023. 8:27:45', serverChangeset: 15661 },
      { name: 'readme.txt', serverPath: README, isFolder: false, pending: 'edit', users: ['Filip', 'Boris'], userDetails: ['Filip (DEVPC/DEVPC): edit, 2026-08-21', 'Boris (BORIS/BORIS): edit, 2025-11-03'], latest: 'no', lastCheckIn: '21. ožujka 2025. 12:08:14', serverChangeset: 18312 },
      { name: '<img src=x onerror=alert(1)>', serverPath: EVIL, isFolder: false, pending: '', users: [], userDetails: [], latest: 'notDownloaded', lastCheckIn: '', serverChangeset: 1 },
    ],
    listState: 'ok',
    infoState: 'ok',
    statusState: 'ok',
    footer: '3 item(s)',
    sort: { key: 'name', dir: 'asc' },
    selection: [],
    allowed: [],
    folderAllowed: ['getLatest', 'getSpecific', 'history'],
    labels: L,
    ...over,
  };
}

const rowOf = (page: ReturnType<typeof loadPage>, path: string) => page.app.querySelector(`tr[data-path="${path}"]`)!;
const cells = (tr: FakeElement) => tr.children.map((td) => td.textContent);
const buttonNamed = (root: FakeElement, text: string) => root.querySelectorAll('button').find((b) => b.textContent === text)!;

describe('media/explorer.js', () => {
  it('says ready first', () => {
    const page = loadPage(SCRIPT);
    expect(page.posted[0]).toEqual({ type: 'ready' });
  });

  it('draws the five columns and every row, putting tf text in as text only', () => {
    const page = loadPage(SCRIPT);
    page.send(state());
    expect(page.app.querySelectorAll('th').map((th) => th.textContent)).toEqual([`${L.name} ▲`, L.pending, L.user, L.latest, L.lastCheckIn]);
    expect(cells(rowOf(page, README))).toEqual(['readme.txt', 'edit', 'Filip, Boris', L.no, '21. ožujka 2025. 12:08:14']);
    expect(cells(rowOf(page, EVIL))[0]).toBe('<img src=x onerror=alert(1)>');
    expect(page.body.querySelectorAll('img')).toHaveLength(0);
  });

  it('shows … while a column loads and "unavailable" when it failed', () => {
    const page = loadPage(SCRIPT);
    page.send(state({ infoState: 'loading', statusState: 'failed' }));
    expect(cells(rowOf(page, README))).toEqual(['readme.txt', L.unavailable, L.unavailable, '…', '…']);
  });

  it('reads Latest as Yes / No / Not downloaded / Not mapped', () => {
    const page = loadPage(SCRIPT);
    const s = state();
    (s.rows as { latest: string }[])[0].latest = 'notMapped';
    page.send(s);
    expect(cells(rowOf(page, '$/Shop/Shop2023'))[3]).toBe(L.notMapped);
    expect(cells(rowOf(page, EVIL))[3]).toBe(L.notDownloaded);
  });

  it('selects on click, adds with Ctrl, and takes a range with Shift', () => {
    const page = loadPage(SCRIPT);
    page.send(state());
    page.fire(rowOf(page, '$/Shop/Shop2023'), 'click');
    expect(page.posted.at(-1)).toEqual({ type: 'select', paths: ['$/Shop/Shop2023'] });
    page.send(state({ selection: ['$/Shop/Shop2023'] }));
    page.fire(rowOf(page, README), 'click', { ctrlKey: true });
    expect(page.posted.at(-1)).toEqual({ type: 'select', paths: ['$/Shop/Shop2023', README] });
    // Like Windows Explorer: the range starts at the row clicked last (the Ctrl-click).
    page.fire(rowOf(page, EVIL), 'click', { shiftKey: true });
    expect(page.posted.at(-1)).toEqual({ type: 'select', paths: [README, EVIL] });
  });

  it('keeps the Shift-click anchor by path across a reorder, not by row index (review #3)', () => {
    const page = loadPage(SCRIPT);
    page.send(state());
    // Ctrl-click Shop2023 (row index 0): the anchor is its PATH, not "0".
    page.fire(rowOf(page, '$/Shop/Shop2023'), 'click', { ctrlKey: true });
    expect(page.posted.at(-1)).toEqual({ type: 'select', paths: ['$/Shop/Shop2023'] });
    // The rows come back reordered (e.g. after a sort): Shop2023 is now LAST.
    const reordered = state({ selection: ['$/Shop/Shop2023'] });
    const rows = reordered.rows;
    reordered.rows = [rows[1], rows[2], rows[0]];
    page.send(reordered);
    // Shift-click the row now at index 0 (README): the range must run from
    // Shop2023's NEW position (index 2), not its stale old index (0) - which
    // would wrongly select only README.
    page.fire(rowOf(page, README), 'click', { shiftKey: true });
    expect(page.posted.at(-1)).toEqual({ type: 'select', paths: [README, EVIL, '$/Shop/Shop2023'] });
  });

  it('opens a row on double-click, and sorts on a header click', () => {
    const page = loadPage(SCRIPT);
    page.send(state());
    page.fire(rowOf(page, README), 'dblclick');
    expect(page.posted.at(-1)).toEqual({ type: 'action', action: 'open', paths: [README] });
    page.fire(page.app.querySelectorAll('th')[3], 'click');
    expect(page.posted.at(-1)).toEqual({ type: 'sort', key: 'latest' });
  });

  it('opens a menu over the selection, dims what is not allowed, and posts the picked action', () => {
    const page = loadPage(SCRIPT);
    page.send(state({ selection: [README], allowed: ['checkout', 'history'] }));
    page.fire(rowOf(page, README), 'contextmenu');
    const menu = page.body.querySelector('.menu')!;
    // Pins the page's menu to the model's own action list (order and membership),
    // so MENU cannot silently drop or reorder an entry (review).
    expect(menu.querySelectorAll('button').map((b) => b.textContent)).toEqual(
      ACTIONS.filter((a) => a !== 'open').map((a) => L[a]),
    );
    expect(buttonNamed(menu, L.checkout).className).not.toContain('dim');
    expect(buttonNamed(menu, L.annotate).className).toContain('dim');
    page.fire(buttonNamed(menu, L.checkout), 'click');
    expect(page.posted.at(-1)).toEqual({ type: 'action', action: 'checkout', paths: [README] });
    expect(page.body.querySelector('.menu')).toBeNull();
  });

  it('right-clicks a tree folder like Visual Studio: navigates there, then opens the folder menu with paths [] (review #4)', () => {
    const page = loadPage(SCRIPT);
    page.send(state({ folderAllowed: ['checkout', 'history'] }));
    const node = page.app.querySelector('div[data-path="$/Shop"]')!;
    page.fire(node, 'contextmenu');
    expect(page.posted.at(-1)).toEqual({ type: 'navigate', path: '$/Shop' });
    const menu = page.body.querySelector('.menu')!;
    expect(menu).not.toBeNull();
    // 13 item actions, plus Refresh, which only a folder's menu carries.
    expect(menu.querySelectorAll('button')).toHaveLength(14);
    expect(menu.querySelectorAll('button')[0].textContent).toBe(L.refresh);
    expect(buttonNamed(menu, L.checkout).className).not.toContain('dim');
    expect(buttonNamed(menu, L.annotate).className).toContain('dim');
    page.fire(buttonNamed(menu, L.checkout), 'click');
    expect(page.posted.at(-1)).toEqual({ type: 'action', action: 'checkout', paths: [] });
    expect(page.body.querySelector('.menu')).toBeNull();
  });

  it("offers every toolbar action in the folder's own menu, Refresh included (user, 2026-09-23)", () => {
    const page = loadPage(SCRIPT);
    page.send(state({ folderAllowed: ['getLatest', 'getSpecific', 'history'] }));
    const actions = page.app.querySelector('.actions')!;
    const toolbarNames = actions.querySelectorAll('button').map((b: FakeElement) => b.textContent);
    page.fire(page.app.querySelector('div[data-path="$/Shop"]')!, 'contextmenu');
    const menu = page.body.querySelector('.menu')!;
    const menuNames = menu.querySelectorAll('button').map((b: FakeElement) => b.textContent);
    for (const name of toolbarNames) expect(menuNames, `${name} is a toolbar action`).toContain(name);
    page.fire(buttonNamed(menu, L.refresh), 'click');
    expect(page.posted.at(-1)).toEqual({ type: 'refresh' });
  });

  it('keeps the folder actions in the breadcrumb bar, and makes them look like buttons (user, 2026-09-23)', () => {
    const page = loadPage(SCRIPT);
    page.send(state());
    // The actions act on the folder the crumbs name, not on the grid's
    // selection, so they belong in the same bar -- that is what tells the user
    // which one they hit.
    const toolbar = page.app.querySelector('.toolbar')!;
    expect(toolbar.querySelector('.crumbs')).not.toBeNull();
    expect(toolbar.querySelector('.actions')).not.toBeNull();

    const css = readFileSync(join(__dirname, '../../media/explorer.css'), 'utf8');
    const actionRule = css.split('\n').find((l) => l.startsWith('.actions button'))!;
    expect(actionRule, 'a borderless button reads as plain text').toMatch(/border:\s*1px/);
    expect(css).toMatch(/\.actions button:hover/);
    expect(css.split('\n').find((l) => l.startsWith('.toolbar '))!).toMatch(/background:/);
  });

  it('closes an open menu on a tree click, a breadcrumb click, or a header click (review #4)', () => {
    const page = loadPage(SCRIPT);
    page.send(state({ selection: [README], allowed: ['checkout'] }));

    page.fire(rowOf(page, README), 'contextmenu');
    expect(page.body.querySelector('.menu')).not.toBeNull();
    page.fire(page.app.querySelector('.crumb')!, 'click');
    expect(page.body.querySelector('.menu')).toBeNull();

    page.fire(rowOf(page, README), 'contextmenu');
    expect(page.body.querySelector('.menu')).not.toBeNull();
    page.fire(page.app.querySelectorAll('th')[0], 'click');
    expect(page.body.querySelector('.menu')).toBeNull();

    page.fire(rowOf(page, README), 'contextmenu');
    expect(page.body.querySelector('.menu')).not.toBeNull();
    const node = page.app.querySelector('div[data-path="$/Shop"]')!;
    page.fire(node, 'click');
    expect(page.body.querySelector('.menu')).toBeNull();

    page.fire(rowOf(page, README), 'contextmenu');
    expect(page.body.querySelector('.menu')).not.toBeNull();
    page.fire(node.querySelector('.twisty')!, 'click');
    expect(page.body.querySelector('.menu')).toBeNull();
  });

  it('selects an unselected row on right-click first, and opens the menu once the selection comes back', () => {
    const page = loadPage(SCRIPT);
    page.send(state());
    page.fire(rowOf(page, README), 'contextmenu');
    expect(page.posted.at(-1)).toEqual({ type: 'select', paths: [README] });
    expect(page.body.querySelector('.menu')).toBeNull();
    page.send(state({ selection: [README] }));
    expect(page.body.querySelector('.menu')).not.toBeNull();
  });

  it('navigates from the breadcrumb and the tree, toggles from the twisty, and acts on the folder from the toolbar', () => {
    const page = loadPage(SCRIPT);
    page.send(state());
    page.fire(page.app.querySelector('.crumb')!, 'click');
    expect(page.posted.at(-1)).toEqual({ type: 'navigate', path: '$/' });
    const node = page.app.querySelector('div[data-path="$/Shop"]')!;
    page.fire(node.querySelector('.twisty')!, 'click');
    expect(page.posted.at(-1)).toEqual({ type: 'toggle', path: '$/Shop' });
    page.fire(node, 'click');
    expect(page.posted.at(-1)).toEqual({ type: 'navigate', path: '$/Shop' });
    page.fire(buttonNamed(page.app.querySelector('.toolbar')!, L.getLatest), 'click');
    expect(page.posted.at(-1)).toEqual({ type: 'action', action: 'getLatest', paths: [] });
  });

  it('keeps the tree pane scrolled where it was across a post (review #2)', () => {
    const page = loadPage(SCRIPT);
    page.send(state());
    const tree = page.app.querySelector('.tree')!;
    tree.scrollTop = 42;
    page.send(state({ footer: '4 item(s)' }));
    expect(page.app.querySelector('.tree')!.scrollTop).toBe(42);
  });

  it("posts the dialog's fields as typed, and keeps the typing while the host's revision is unchanged", () => {
    const page = loadPage(SCRIPT);
    const dialog = { rev: 1, paths: [README], recursive: false, what: 'readme.txt', request: { kind: 'changeset', value: '', overwriteWritable: false, getAll: false } };
    page.send(state({ dialog }));
    // Mounted as a sibling of #app in <body> (review #1), not inside #app.
    const box = page.body.querySelector('.dialog')!;
    box.querySelector('.value')!.value = '16730';
    const boxes = box.querySelectorAll('input').filter((i) => i.type === 'checkbox');
    boxes[0].checked = true;
    page.send(state({ dialog }));
    expect(page.body.querySelector('.value')!.value).toBe('16730');
    page.fire(buttonNamed(page.body.querySelector('.dialog')!, L.gsvGet), 'click');
    expect(page.posted.at(-1)).toEqual({ type: 'submitDialog', request: { kind: 'changeset', value: '16730', overwriteWritable: true, getAll: false } });
    page.fire(buttonNamed(page.body.querySelector('.dialog')!, L.gsvPick), 'click');
    expect(page.posted.at(-1)).toEqual({ type: 'pickChangeset', request: { kind: 'changeset', value: '16730', overwriteWritable: true, getAll: false } });
    page.send(state({ dialog: { ...dialog, rev: 2, error: S.gsvBadChangeset } }));
    expect(page.body.querySelector('.value')!.value).toBe('');
    expect(page.body.querySelector('.dialog')!.textContent).toContain(S.gsvBadChangeset);
  });

  it('never touches the open dialog\'s DOM while its rev is unchanged, so focus and an open <select> survive a background post (review #1)', () => {
    const page = loadPage(SCRIPT);
    const dialog = { rev: 1, paths: [README], recursive: false, what: 'readme.txt', request: { kind: 'changeset', value: '', overwriteWritable: false, getAll: false } };
    page.send(state({ dialog }));
    const overlay = page.body.querySelector('.overlay')!;
    // A post that has nothing to do with the dialog (a background detail
    // load, a status refresh) must not detach-and-reattach it: even the
    // SAME node re-appended in a real browser drops focus and closes an
    // open <select>.
    page.send(state({ dialog, footer: '9 item(s)' }));
    expect(page.body.querySelector('.overlay')).toBe(overlay);
    // Once the host's own rev changes (a real edit to the dialog's state,
    // e.g. an error message), the overlay IS replaced.
    page.send(state({ dialog: { ...dialog, rev: 2 } }));
    expect(page.body.querySelector('.overlay')).not.toBe(overlay);
  });

  it('shows a failed listing with Retry, which refreshes', () => {
    const page = loadPage(SCRIPT);
    page.send(state({ listState: 'failed', listError: 'TF14061 nope', rows: [] }));
    expect(page.app.textContent).toContain('TF14061 nope');
    page.fire(buttonNamed(page.app, L.retry), 'click');
    expect(page.posted.at(-1)).toEqual({ type: 'refresh' });
  });

  it('saves the open folder, so VS Code can reopen the tab there after a restart', () => {
    const page = loadPage(SCRIPT);
    page.send(state());
    expect(page.saved.at(-1)).toEqual({ path: '$/Shop' });
  });

  it('offers Rename and Delete, dimmed when the extension refuses them (phase 3 part 3)', () => {
    const page = loadPage(SCRIPT);
    page.send(state({ selection: [README], allowed: ['delete'] }));
    page.fire(rowOf(page, README), 'contextmenu');
    const menu = page.body.querySelector('.menu')!;
    expect(buttonNamed(menu, L.delete).className).not.toContain('dim');
    expect(buttonNamed(menu, L.rename).className).toContain('dim');
    page.fire(buttonNamed(menu, L.delete), 'click');
    expect(page.posted.at(-1)).toEqual({ type: 'action', action: 'delete', paths: [README] });
  });
});
