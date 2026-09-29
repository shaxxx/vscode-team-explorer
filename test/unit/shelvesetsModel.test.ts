import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseShelvedChanges, parseShelvesets } from '../../src/tf/parseShelvesets.js';
import { ShelvesetsModel, displayDate, keyOf, parseShelvesetsIntent } from '../../src/shelve/shelvesetsModel.js';
import { S } from '../../src/tf/strings.js';

const fixture = (name: string) => readFileSync(join(__dirname, '../fixtures/windows', name));
const LIST = parseShelvesets(fixture('shelvesets-list.xml'));
const MOVED = parseShelvedChanges(fixture('status-shelveset-rename-delete.xml'));
const EF6 = LIST.find((s) => s.name === 'EF6 Migration 9')!;
const COLLEAGUE = LIST.find((s) => s.name === 'Popravak web servisa')!;

const model = () => {
  const m = new ShelvesetsModel(() => ['user@example.com', 'Filip']);
  m.setList(LIST);
  return m;
};

describe('parseShelvesetsIntent: what the page may post', () => {
  it('accepts each intent with a valid body', () => {
    for (const ok of [
      { type: 'ready' }, { type: 'refresh' }, { type: 'unshelve' },
      { type: 'find', owner: 'Nika Blaškova' },
      { type: 'select', key: 'EF6 Migration 9;user@example.com' },
      { type: 'delete', key: 'EF6 Migration 9;user@example.com' },
      { type: 'tick', paths: ['$/K/a.cs'], ticked: false },
      { type: 'preserve', value: false },
      { type: 'file', action: 'compareWorkspace', path: '$/K/a.cs' },
    ]) {
      expect(parseShelvesetsIntent(ok), JSON.stringify(ok)).toEqual(ok);
    }
  });

  it('refuses anything else', () => {
    for (const bad of [
      null, [], 'ready', { type: 'checkout' },
      { type: 'find', owner: 5 }, { type: 'find', owner: 'x'.repeat(300) },
      { type: 'select', key: '' }, { type: 'select', key: 'a\nb' },
      { type: 'delete', key: '' }, { type: 'delete', key: 'a\nb' },
      { type: 'tick', paths: 'x', ticked: true }, { type: 'tick', paths: ['C:\\a.cs'], ticked: true }, { type: 'tick', paths: ['$/K/*'], ticked: true },
      { type: 'tick', paths: ['$/K/a.cs'], ticked: 'yes' },
      { type: 'tick', paths: ['$/K/a;b'], ticked: true }, { type: 'tick', paths: ['$/K/a\tb.cs'], ticked: true },
      { type: 'preserve', value: 'no' },
      { type: 'file', action: 'delete', path: '$/K/a.cs' }, { type: 'file', action: 'viewShelved', path: 'a.cs' },
    ]) {
      expect(parseShelvesetsIntent(bad), JSON.stringify(bad)).toBeUndefined();
    }
  });
});

describe('ShelvesetsModel', () => {
  it('lists newest first, says whose each is, and shows the first line of the comment', () => {
    const rows = model().state().rows;
    expect(rows.map((r) => r.name)[0]).toBe('TFVC-PROBE-P4-1');
    const probe = rows.find((r) => r.name === 'TFVC-PROBE-P4-1')!;
    expect(probe.comment).toBe('Probe shelveset čćžšđ');
    expect(probe.owner).toBe('Filip');
    expect(probe.mine).toBe(true);
    expect(rows.find((r) => r.name === 'Popravak web servisa')!.mine).toBe(false);
    expect(probe.key).toBe(keyOf({ name: 'TFVC-PROBE-P4-1', ownerUnique: 'user@example.com' }));
  });

  it('opens a shelveset loading, then with every change ticked and Preserve ticked, as Visual Studio does', () => {
    const m = model();
    m.select(keyOf(EF6));
    expect(m.state().details).toMatchObject({ name: 'EF6 Migration 9', state: 'loading', preserve: true, busy: false, mine: true });
    m.setChanges(keyOf(EF6), MOVED);
    const d = m.state().details!;
    expect(d.state).toBe('ok');
    expect(d.changes.every((c) => c.ticked)).toBe(true);
    expect(d.changes.find((c) => c.serverPath.endsWith('date2.js'))!.name).toBe('date.js → date2.js');
    expect(d.changes.find((c) => c.serverPath.endsWith('date2.js'))!.folder).toBe('$/Shop/Shop2023/Enterprise.Till.Server/Web/assets');
    expect(d.comment).toBe('EF6 Migration 7');
  });

  it('ticks and unticks only changes it listed', () => {
    const m = model();
    m.select(keyOf(EF6));
    m.setChanges(keyOf(EF6), MOVED);
    m.tick([MOVED[0].serverItem, '$/Not/listed.cs'], false);
    expect([...m.ticked]).not.toContain(MOVED[0].serverItem);
    expect([...m.ticked]).not.toContain('$/Not/listed.cs');
    m.tick([MOVED[0].serverItem], true);
    expect([...m.ticked]).toContain(MOVED[0].serverItem);
    // Ticking ON an item it never listed must not add it either: only what setChanges gave it can end up ticked.
    m.tick(['$/Not/listed.cs'], true);
    expect([...m.ticked]).not.toContain('$/Not/listed.cs');
  });

  it('drops an answer for a shelveset that is no longer selected', () => {
    const m = model();
    m.select(keyOf(EF6));
    m.select(keyOf(COLLEAGUE));
    m.setChanges(keyOf(EF6), MOVED);
    expect(m.state().details).toMatchObject({ name: 'Popravak web servisa', state: 'loading', mine: false });
  });

  it('forgets a selection the new list no longer holds, and everything on a failed list', () => {
    const m = model();
    m.select(keyOf(EF6));
    m.setList(LIST.filter((s) => s !== EF6));
    expect(m.state().details).toBeUndefined();
    m.select(keyOf(COLLEAGUE));
    m.failList('TF30063');
    expect(m.state()).toMatchObject({ listState: 'failed', listError: 'TF30063', rows: [] });
    expect(m.state().details).toBeUndefined();
  });

  it('nothing is mine when the aliases are unknown', () => {
    const m = new ShelvesetsModel(() => []);
    m.setList(LIST);
    expect(m.state().rows.some((r) => r.mine)).toBe(false);
  });

  it('shows a date as YYYY-MM-DD HH:MM, and leaves one it cannot read as it is', () => {
    expect(displayDate('2026-09-23T13:57:31.84+02:00')).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(displayDate('not a date')).toBe('not a date');
    expect(model().state().labels).toBe(S.shelvesetsLabels);
  });
});

describe("ShelvesetsModel.reopen: a Refresh's implicit re-select keeps the user's choices", () => {
  const [HELLO, ADDED, RENAME, SMILEY] = MOVED;

  it('keeps Preserve and every still-listed tick, ticks a change new to the reload, and drops one no longer listed, when the reload finds the SAME shelveset (same date)', () => {
    const m = model();
    m.select(keyOf(EF6));
    m.setChanges(keyOf(EF6), MOVED);
    m.tick([HELLO.serverItem], false);
    m.setPreserve(false);
    // A Refresh re-lists first; EF6 is the SAME shelveset object, so its date is unchanged.
    m.setList(LIST);
    const reopened = m.reopen(keyOf(EF6));
    expect(reopened).toMatchObject({ name: 'EF6 Migration 9' });
    // While the reload's own `contents` is in flight the prior choices already show.
    expect(m.state().details).toMatchObject({ state: 'loading', preserve: false });
    expect([...m.ticked]).not.toContain(HELLO.serverItem);
    const NEW_CHANGE = { ...ADDED, serverItem: `${ADDED.serverItem}.new` };
    // HELLO is gone from the reload; NEW_CHANGE is in it for the first time.
    m.setChanges(keyOf(EF6), [ADDED, RENAME, SMILEY, NEW_CHANGE]);
    const d = m.state().details!;
    expect(d.preserve).toBe(false);
    expect(d.changes.some((c) => c.serverPath === HELLO.serverItem)).toBe(false);
    expect(d.changes.find((c) => c.serverPath === ADDED.serverItem)).toMatchObject({ ticked: true });
    expect(d.changes.find((c) => c.serverPath === RENAME.serverItem)).toMatchObject({ ticked: true });
    expect(d.changes.find((c) => c.serverPath === NEW_CHANGE.serverItem)).toMatchObject({ ticked: true });
  });

  it('starts fresh -- every change ticked, Preserve on -- when the reload finds the same key with a DIFFERENT date (it was replaced)', () => {
    const m = model();
    m.select(keyOf(EF6));
    m.setChanges(keyOf(EF6), MOVED);
    m.tick([HELLO.serverItem], false);
    m.setPreserve(false);
    const replaced = LIST.map((s) => (s === EF6 ? { ...s, date: '2027-01-01T00:00:00+02:00' } : s));
    m.setList(replaced);
    m.reopen(keyOf(EF6));
    expect(m.state().details).toMatchObject({ state: 'loading', preserve: true });
    m.setChanges(keyOf(EF6), MOVED);
    expect(m.state().details!.changes.every((c) => c.ticked)).toBe(true);
  });

  it('reopen behaves exactly like select (fresh) the first time a shelveset is opened', () => {
    const m = model();
    m.reopen(keyOf(EF6));
    expect(m.state().details).toMatchObject({ state: 'loading', preserve: true });
    m.setChanges(keyOf(EF6), MOVED);
    expect(m.state().details!.changes.every((c) => c.ticked)).toBe(true);
  });
});
