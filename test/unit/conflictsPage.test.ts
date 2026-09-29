import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadPage, type FakeElement } from '../helpers/fakeDom.js';
import { S } from '../../src/tf/strings.js';

const SCRIPT = readFileSync(join(__dirname, '../../media/conflicts.js'), 'utf8');
const L = S.conflictsLabels;
const KEY = String.raw`c:\work\shop\startup.cs`;
const EVIL = '<img src=x onerror=alert(1)>';
/** Visual Studio's Compare drop-down button. */
const COMPARE = `${S.conflictsLabels.compareMenu} ▾`;

function state(over: Record<string, unknown> = {}) {
  return {
    title: S.conflictsTitle,
    rows: [
      {
        key: KEY,
        name: 'Startup.cs',
        folder: String.raw`C:\work\Shop`,
        reason: 'You have a conflicting pending change.',
        versions: 'yours from C18319, server at C18325',
        actions: ['compare', 'compareServerBase', 'compareLocalBase', 'autoMerge', 'takeTheirs', 'keepYours', 'mergeManually'],
        merging: false,
      },
      { key: 'evil', name: EVIL, folder: EVIL, reason: EVIL, versions: '', actions: ['overwriteLocal'], merging: false },
    ],
    selected: undefined,
    busy: false,
    empty: S.conflictsNone,
    mergingHint: S.conflictsMergingHint,
    labels: L,
    toolbar: { refresh: S.conflictsRefresh, autoMergeAll: S.conflictsAutoMergeAll },
    ...over,
  };
}

const rowOf = (page: ReturnType<typeof loadPage>, key: string) => page.app.querySelector(`div[data-path="${key}"]`)!;
const buttonNamed = (root: FakeElement, text: string) => root.querySelectorAll('button').find((b) => b.textContent === text)!;
const buttonTexts = (root: FakeElement) => root.querySelectorAll('button').map((b) => b.textContent);

describe('media/conflicts.js', () => {
  it('says ready first', () => {
    const page = loadPage(SCRIPT);
    expect(page.posted[0]).toEqual({ type: 'ready' });
  });

  it("draws every row, putting tf's text in as text only", () => {
    const page = loadPage(SCRIPT);
    page.send(state());
    expect(rowOf(page, KEY).querySelector('.name')!.textContent).toBe('Startup.cs');
    expect(rowOf(page, KEY).querySelector('.reason')!.textContent).toBe('You have a conflicting pending change.');
    expect(rowOf(page, KEY).querySelector('.versions')!.textContent).toBe('yours from C18319, server at C18325');
    expect(rowOf(page, 'evil').querySelector('.name')!.textContent).toBe(EVIL);
    expect(page.body.querySelectorAll('img')).toHaveLength(0);
  });

  it("shows exactly the row's buttons, and each posts its action for that row", () => {
    const page = loadPage(SCRIPT);
    page.send(state());
    expect(buttonTexts(rowOf(page, KEY))).toEqual([COMPARE, L.autoMerge, L.takeTheirs, L.keepYours, L.mergeManually]);
    expect(buttonTexts(rowOf(page, 'evil'))).toEqual([L.overwriteLocal]);
    page.fire(buttonNamed(rowOf(page, KEY), L.takeTheirs), 'click');
    expect(page.posted.at(-1)).toEqual({ type: 'act', key: KEY, action: 'takeTheirs' });
  });

  it("opens Visual Studio's Compare drop-down: Local and Server, Server and Base, Local and Base", () => {
    const page = loadPage(SCRIPT);
    page.send(state());
    expect(rowOf(page, KEY).querySelector('.menu')).toBeNull();
    page.fire(buttonNamed(rowOf(page, KEY), COMPARE), 'click');
    const menu = rowOf(page, KEY).querySelector('.menu')!;
    expect(buttonTexts(menu)).toEqual([L.compare, L.compareServerBase, L.compareLocalBase]);
    page.fire(buttonNamed(menu, L.compareServerBase), 'click');
    expect(page.posted.at(-1)).toEqual({ type: 'act', key: KEY, action: 'compareServerBase' });
    // A choice closes it; so does Escape.
    expect(rowOf(page, KEY).querySelector('.menu')).toBeNull();
    page.fire(buttonNamed(rowOf(page, KEY), COMPARE), 'click');
    page.fire(page.body, 'keydown', { key: 'Escape' });
    expect(rowOf(page, KEY).querySelector('.menu')).toBeNull();
    // A row with fewer compares offers only those: a blocked file has no base.
    const s = state();
    s.rows[0].actions = ['compare', 'overwriteLocal'];
    page.send(s);
    page.fire(buttonNamed(rowOf(page, KEY), COMPARE), 'click');
    expect(buttonTexts(rowOf(page, KEY).querySelector('.menu')!)).toEqual([L.compare]);
  });

  it('shows the merging state: the hint, Resolved, Cancel and the Compare menu', () => {
    const page = loadPage(SCRIPT);
    const s = state();
    s.rows[0].merging = true;
    page.send(s);
    const row = rowOf(page, KEY);
    expect(row.querySelector('.hint')!.textContent).toBe(S.conflictsMergingHint);
    expect(buttonTexts(row)).toEqual([L.resolved, L.cancelMerge, COMPARE]);
    page.fire(buttonNamed(row, L.resolved), 'click');
    expect(page.posted.at(-1)).toEqual({ type: 'act', key: KEY, action: 'resolved' });
    page.fire(buttonNamed(row, L.cancelMerge), 'click');
    expect(page.posted.at(-1)).toEqual({ type: 'act', key: KEY, action: 'cancelMerge' });
  });

  it('says No conflicts when there are none', () => {
    const page = loadPage(SCRIPT);
    page.send(state({ rows: [] }));
    expect(page.app.querySelector('.empty')!.textContent).toBe(S.conflictsNone);
  });

  it('posts refresh and autoMergeAll from the toolbar', () => {
    const page = loadPage(SCRIPT);
    page.send(state());
    const toolbar = page.app.querySelector('.toolbar')!;
    page.fire(buttonNamed(toolbar, S.conflictsRefresh), 'click');
    expect(page.posted.at(-1)).toEqual({ type: 'refresh' });
    page.fire(buttonNamed(toolbar, S.conflictsAutoMergeAll), 'click');
    expect(page.posted.at(-1)).toEqual({ type: 'autoMergeAll' });
  });

  it('selects a row on click, and Enter on a row compares it', () => {
    const page = loadPage(SCRIPT);
    page.send(state());
    page.fire(rowOf(page, KEY), 'click');
    expect(page.posted.at(-1)).toEqual({ type: 'select', key: KEY });
    expect(rowOf(page, KEY).className).toContain('selected');
    page.fire(rowOf(page, KEY), 'keydown', { key: 'Enter' });
    expect(page.posted.at(-1)).toEqual({ type: 'act', key: KEY, action: 'compare' });
  });

  it("leaves Enter on a button to the button: it never also compares", () => {
    const page = loadPage(SCRIPT);
    page.send(state());
    const before = page.posted.length;
    page.fire(buttonNamed(rowOf(page, KEY), L.takeTheirs), 'keydown', { key: 'Enter' });
    expect(page.posted.slice(before)).toEqual([]);
  });

  it('gives a focused row its focus back after every render, so Enter keeps working', () => {
    const page = loadPage(SCRIPT);
    page.send(state());
    rowOf(page, KEY).focus();
    page.send(state());
    expect(page.doc.activeElement).toBe(rowOf(page, KEY));
    page.fire(rowOf(page, KEY), 'click');
    expect(page.doc.activeElement).toBe(rowOf(page, KEY));
  });

  it('dims the resolutions while one runs, without disabling them', () => {
    const page = loadPage(SCRIPT);
    page.send(state({ busy: true }));
    const take = buttonNamed(rowOf(page, KEY), L.takeTheirs);
    expect((take as unknown as { disabled?: boolean }).disabled).toBeFalsy();
    expect(take.getAttribute('disabled')).toBeNull();
    expect(take.className).toContain('dim');
    expect(buttonNamed(rowOf(page, KEY), COMPARE).className).not.toContain('dim');
  });
});
