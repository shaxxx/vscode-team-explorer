import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Behavioural tests of `media/history.js` against a
 * MINIMAL fake DOM built right here -- no new dependency. The two Task 7
 * reviewers built similar shims to find the bugs D16 fixes; this keeps that
 * approach as a real, checked-in test rather than a one-off scratch script.
 *
 * The script is loaded as TEXT and run with `new Function` against fake
 * `document` / `window` / `acquireVsCodeApi`, exactly the globals the IIFE in
 * history.js references. Each test gets its OWN fresh page (own closures for
 * `state` / `menuState`), since the script keeps module-level state.
 */

const SCRIPT = readFileSync(join(__dirname, '../../media/history.js'), 'utf8');

type Listener = (e: FakeEvent) => void;
interface FakeEvent {
  type: string;
  target?: FakeElement;
  clientX: number;
  clientY: number;
  key?: string;
  shiftKey: boolean;
  stopped: boolean;
  preventDefault(): void;
  stopPropagation(): void;
  [k: string]: unknown;
}

/** A tiny stand-in for a DOM element: just enough for history.js to run against. */
class FakeElement {
  tagName: string;
  children: FakeElement[] = [];
  parent: FakeElement | null = null;
  attrs: Record<string, string> = {};
  listeners: Record<string, Listener[]> = {};
  style: Record<string, string> = {};
  className = '';
  type = '';
  scrollTop = 0;
  disabled = false;
  private _text = '';

  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }
  set textContent(v: string) {
    this._text = String(v);
    this.children = [];
  }
  get textContent(): string {
    return this._text + this.children.map((c) => c.textContent).join('');
  }
  setAttribute(k: string, v: unknown): void {
    this.attrs[k] = String(v);
    if (k === 'disabled') this.disabled = true;
  }
  getAttribute(k: string): string | null {
    return k in this.attrs ? this.attrs[k] : null;
  }
  hasAttribute(k: string): boolean {
    return k in this.attrs;
  }
  appendChild(c: FakeElement): FakeElement {
    if (c.parent) c.remove();
    c.parent = this;
    this.children.push(c);
    return c;
  }
  remove(): void {
    if (this.parent) {
      this.parent.children = this.parent.children.filter((x) => x !== this);
      this.parent = null;
    }
  }
  /** `this` itself, or an ancestor of `node`. Used by D20d's held-focus check. */
  contains(node: FakeElement): boolean {
    for (let n: FakeElement | null = node; n; n = n.parent) if (n === this) return true;
    return false;
  }
  replaceChildren(...cs: FakeElement[]): void {
    for (const c of this.children) c.parent = null;
    this.children = [];
    for (const c of cs) this.appendChild(c);
  }
  addEventListener(t: string, fn: Listener): void {
    (this.listeners[t] ??= []).push(fn);
  }
  /** `opts` is recorded on the element itself so a test can assert `{ preventScroll: true }` (D20a). */
  lastFocusOpts: { preventScroll?: boolean } | undefined;
  focus(opts?: { preventScroll?: boolean }): void {
    activeDoc.activeElement = this;
    this.lastFocusOpts = opts;
  }
  getBoundingClientRect() {
    return { left: 0, bottom: 0 };
  }
  scrollIntoView(): void {
    // No layout in this fake DOM; existing and callable is all history.js needs.
  }
  *walk(): Generator<FakeElement> {
    for (const c of this.children) {
      yield c;
      yield* c.walk();
    }
  }
  querySelector(sel: string): FakeElement | null {
    return this.querySelectorAll(sel)[0] ?? null;
  }
  querySelectorAll(sel: string): FakeElement[] {
    const out: FakeElement[] = [];
    let m: RegExpExecArray | null;
    for (const n of this.walk()) {
      if (sel === 'button:not([disabled])') {
        if (n.tagName === 'BUTTON' && !n.hasAttribute('disabled')) out.push(n);
      } else if ((m = /^tr\[tabindex="(.*)"\]$/.exec(sel))) {
        if (n.tagName === 'TR' && n.getAttribute('tabindex') === m[1]) out.push(n);
      } else if ((m = /^tr\[data-id="(.*)"\]$/.exec(sel))) {
        if (n.tagName === 'TR' && n.getAttribute('data-id') === m[1]) out.push(n);
      } else if (/^\.[\w-]+$/.test(sel)) {
        if (n.className === sel.slice(1)) out.push(n);
      } else {
        throw new Error('unsupported selector in this fake DOM: ' + sel);
      }
    }
    return out;
  }
}

/** Whichever fake `document` most recently called `.focus()` on an element. */
let activeDoc: { activeElement: FakeElement };

/** Fires `type` at `target`, bubbling toward the document unless stopped -- close enough to real DOM dispatch for this script's needs. */
function fire(
  target: FakeElement,
  doc: { listeners: Record<string, Listener[]> },
  type: string,
  extra: Partial<FakeEvent> = {},
): FakeEvent {
  const ev: FakeEvent = {
    type,
    target,
    clientX: 5,
    clientY: 5,
    shiftKey: false,
    stopped: false,
    preventDefault() {
      /* no layout to prevent */
    },
    stopPropagation() {
      ev.stopped = true;
    },
    ...extra,
  };
  for (let n: FakeElement | null = target; n && !ev.stopped; n = n.parent) {
    for (const fn of (n.listeners[type] ?? []).slice()) fn(ev);
  }
  if (!ev.stopped) for (const fn of (doc.listeners[type] ?? []).slice()) fn(ev);
  return ev;
}

/** For events history.js registers directly on `document` (keydown, click-outside). */
function fireOnDocument(doc: { listeners: Record<string, Listener[]> }, type: string, extra: Partial<FakeEvent> = {}): void {
  const ev: FakeEvent = {
    type,
    clientX: 0,
    clientY: 0,
    shiftKey: false,
    stopped: false,
    preventDefault() {},
    stopPropagation() {},
    ...extra,
  };
  for (const fn of (doc.listeners[type] ?? []).slice()) fn(ev);
}

interface FakeState {
  title: string;
  mode: 'file' | 'folder';
  rows: unknown[];
  selected?: number;
  details?: unknown;
  more: boolean;
  loading: boolean;
  error?: string;
  /** D18c: the details pane's own failure, independent of the page banner above. */
  detailsError?: string;
  empty: boolean;
  labels: Record<string, string>;
}

/** One fresh page: its own closures, its own fake document/window/body. */
function createPage() {
  const body = new FakeElement('body');
  const app = new FakeElement('main');
  app.setAttribute('id', 'app');
  body.appendChild(app);
  const doc = {
    body,
    activeElement: body as FakeElement,
    listeners: {} as Record<string, Listener[]>,
    createElement: (t: string) => new FakeElement(t),
    getElementById: (id: string) => (id === 'app' ? app : null),
    addEventListener(t: string, fn: Listener) {
      (this.listeners[t] ??= []).push(fn);
    },
  };
  activeDoc = doc;
  // `window` only ever hears 'message' (a MessageListener) and 'blur' (a
  // plain Listener) from this script; kept untyped here rather than unioning
  // the two shapes for every caller.
  const winListeners: Record<string, ((e: unknown) => void)[]> = {};
  const win = {
    addEventListener: (t: string, fn: (e: unknown) => void) => {
      (winListeners[t] ??= []).push(fn);
    },
  };
  const posted: { type: string; [k: string]: unknown }[] = [];
  const acquireVsCodeApi = () => ({ postMessage: (m: unknown) => posted.push(m as { type: string }) });

  // eslint-disable-next-line @typescript-eslint/no-implied-eval -- loading the real script text under test, not arbitrary code
  new Function('acquireVsCodeApi', 'document', 'window', SCRIPT)(acquireVsCodeApi, doc, win);

  return {
    app,
    body,
    doc,
    posted,
    deliver(state: FakeState) {
      for (const fn of (winListeners.message ?? []).slice()) fn({ data: { type: 'state', state } });
    },
    dispatch: (target: FakeElement, type: string, extra?: Partial<FakeEvent>) => fire(target, doc, type, extra),
    fireDoc: (type: string, extra?: Partial<FakeEvent>) => fireOnDocument(doc, type, extra),
    trs(): FakeElement[] {
      return [...app.walk()].filter((n) => n.tagName === 'TR' && n.hasAttribute('data-id'));
    },
    menuOpen(): boolean {
      return body.children.some((c) => c.className === 'menu');
    },
  };
}

const labels = {
  compare: 'Compare with Previous Version',
  view: 'View This Version',
  getVersion: 'Get This Version',
  changeset: 'Changeset',
  user: 'User',
  date: 'Date',
  comment: 'Comment',
  change: 'Change',
  path: 'Path',
  loadMore: 'Load more',
  loading: 'Loading…',
  empty: 'No history.',
  details: 'Changeset details',
  selectPrompt: 'Select a changeset to see its files.',
};

function row(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    user: 'A',
    date: 'd' + id,
    comment: 'comment ' + id,
    firstLine: 'comment ' + id,
    canCompare: true,
    canView: true,
    canGet: true,
    ...overrides,
  };
}

function baseState(overrides: Partial<FakeState> = {}): FakeState {
  return {
    title: 'History - a.vb',
    mode: 'file',
    rows: [row(9), row(8), row(7)],
    selected: undefined,
    details: undefined,
    more: false,
    loading: false,
    error: undefined,
    detailsError: undefined,
    empty: false,
    labels,
    ...overrides,
  };
}

describe('media/history.js against a minimal fake DOM', () => {
  it("right-click on an unselected row opens the menu, and the extension's state echo keeps it open (D16b)", () => {
    const p = createPage();
    expect(p.posted[0]).toEqual({ type: 'ready' });
    p.deliver(baseState());
    const tr8 = p.trs().find((t) => t.getAttribute('data-id') === '8')!;
    p.dispatch(tr8, 'contextmenu');
    expect(p.menuOpen()).toBe(true);
    // The right-click also selected the row; the extension echoes that back.
    expect(p.posted).toContainEqual({ type: 'select', id: 8 });
    p.deliver(baseState({ selected: 8 }));
    expect(p.menuOpen()).toBe(true); // survives the rebuild the echo triggers
  });

  it('Escape closes the menu', () => {
    const p = createPage();
    p.deliver(baseState());
    const tr8 = p.trs().find((t) => t.getAttribute('data-id') === '8')!;
    p.dispatch(tr8, 'contextmenu');
    expect(p.menuOpen()).toBe(true);
    p.fireDoc('keydown', { key: 'Escape' });
    expect(p.menuOpen()).toBe(false);
    // And it stays closed across a render -- it is a real close, not a redraw.
    p.deliver(baseState({ selected: 8 }));
    expect(p.menuOpen()).toBe(false);
  });

  it('a click outside the menu closes it', () => {
    const p = createPage();
    p.deliver(baseState());
    const tr8 = p.trs().find((t) => t.getAttribute('data-id') === '8')!;
    p.dispatch(tr8, 'contextmenu');
    expect(p.menuOpen()).toBe(true);
    p.dispatch(p.body, 'click'); // bubbles to document, which closes the menu
    expect(p.menuOpen()).toBe(false);
  });

  it('renders server text -- including a comment crafted to look like markup -- as text, never as an element', () => {
    const p = createPage();
    const evil = '<img src=x onerror=alert(1)>';
    p.deliver(baseState({ rows: [row(8, { comment: evil, firstLine: evil })] }));
    expect([...p.app.walk()].some((n) => n.tagName === 'IMG')).toBe(false);
    const commentCell = [...p.app.walk()].find((n) => n.tagName === 'TD' && n.className === 'comment');
    expect(commentCell?.textContent).toBe(evil);
    // Selecting the row renders the same text again in the details pane's <pre>.
    p.dispatch(p.trs().find((t) => t.getAttribute('data-id') === '8')!, 'click');
    p.deliver(baseState({ rows: [row(8, { comment: evil, firstLine: evil })], selected: 8 }));
    const pre = [...p.app.walk()].find((n) => n.tagName === 'PRE');
    expect(pre?.textContent).toBe(evil);
    expect([...p.app.walk()].some((n) => n.tagName === 'IMG')).toBe(false);
  });

  it('posts only intents from the allowlist historyModel.parseIntent accepts', () => {
    const p = createPage();
    p.deliver(baseState({ more: true }));
    const tr8 = p.trs().find((t) => t.getAttribute('data-id') === '8')!;
    p.dispatch(tr8, 'click');
    p.dispatch(tr8, 'contextmenu');
    for (const b of [...p.body.walk()].filter((n) => n.tagName === 'BUTTON' && !n.hasAttribute('disabled'))) {
      p.dispatch(b, 'click');
    }
    p.dispatch(tr8, 'dblclick');
    const loadMore = [...p.app.walk()].find((n) => n.tagName === 'BUTTON' && n.textContent === labels.loadMore);
    if (loadMore) p.dispatch(loadMore, 'click');
    const allowed = new Set(['ready', 'select', 'loadMore', 'compare', 'view', 'getVersion', 'details']);
    expect(p.posted.length).toBeGreaterThan(1);
    for (const m of p.posted) expect(allowed.has(m.type)).toBe(true);
  });

  it('with nothing selected, the first row is the only tab stop', () => {
    const p = createPage();
    p.deliver(baseState());
    const tabbable = p.app.querySelectorAll('tr[tabindex="0"]');
    expect(tabbable).toHaveLength(1);
    expect(tabbable[0].getAttribute('data-id')).toBe('9');
  });

  it('once a row is selected, IT is the tab stop instead of the first row', () => {
    const p = createPage();
    p.deliver(baseState({ selected: 7 }));
    const tabbable = p.app.querySelectorAll('tr[tabindex="0"]');
    expect(tabbable).toHaveLength(1);
    expect(tabbable[0].getAttribute('data-id')).toBe('7');
  });

  it('preserves the grid and details scroll position across a render (D16e)', () => {
    const p = createPage();
    p.deliver(baseState({ selected: 7 }));
    const gridWrap = p.app.querySelector('.grid-wrap')!;
    const details = p.app.querySelector('.details')!;
    gridWrap.scrollTop = 42;
    details.scrollTop = 17;
    p.deliver(baseState({ selected: 7, error: 'a transient error' })); // any re-render
    expect(p.app.querySelector('.grid-wrap')!.scrollTop).toBe(42);
    expect(p.app.querySelector('.details')!.scrollTop).toBe(17);
  });

  it('scrolls the selected row into view when the selection changes via a state message, not a click (D16e)', () => {
    // render() builds a brand new element for the row every time, so the
    // call is observed on the prototype rather than on one instance.
    const calls: string[] = [];
    const original = FakeElement.prototype.scrollIntoView;
    FakeElement.prototype.scrollIntoView = function (this: FakeElement) {
      calls.push(this.getAttribute('data-id') ?? '');
    };
    try {
      const p = createPage();
      p.deliver(baseState());
      p.deliver(baseState({ selected: 7 })); // e.g. Annotate's "Changeset details" hover
      expect(calls).toEqual(['7']);
    } finally {
      FakeElement.prototype.scrollIntoView = original;
    }
  });

  it('does not force-scroll when the selection changes because of a user click', () => {
    const calls: string[] = [];
    const original = FakeElement.prototype.scrollIntoView;
    FakeElement.prototype.scrollIntoView = function () {
      calls.push('scrolled');
    };
    try {
      const p = createPage();
      p.deliver(baseState());
      const tr7 = p.trs().find((t) => t.getAttribute('data-id') === '7')!;
      p.dispatch(tr7, 'click'); // the local, optimistic render -- the row is already in view
      expect(calls).toEqual([]);
      p.deliver(baseState({ selected: 7 })); // the extension's echo just confirms it
      expect(calls).toEqual([]);
    } finally {
      FakeElement.prototype.scrollIntoView = original;
    }
  });

  it('a refused (dimmed) action button still posts its intent on click (D18a)', () => {
    const p = createPage();
    p.deliver(baseState({ rows: [row(8, { canCompare: false, canView: false, canGet: false })] }));
    const tr8 = p.trs().find((t) => t.getAttribute('data-id') === '8')!;
    p.dispatch(tr8, 'click'); // select it so its action buttons render in the details pane
    p.deliver(baseState({ rows: [row(8, { canCompare: false, canView: false, canGet: false })], selected: 8 }));
    const getBtn = [...p.app.walk()].find((n) => n.tagName === 'BUTTON' && n.textContent === labels.getVersion)!;
    // Dimmed, not disabled: the class is a hint, never a barrier to the click.
    expect(getBtn.hasAttribute('disabled')).toBe(false);
    expect(getBtn.className).toBe('dim');
    p.dispatch(getBtn, 'click');
    expect(p.posted).toContainEqual({ type: 'getVersion', id: 8 });
  });

  it('double-click and Enter post Compare even on a row that cannot compare (D18a)', () => {
    const p = createPage();
    p.deliver(baseState({ rows: [row(8, { canCompare: false })] }));
    const tr8 = p.trs().find((t) => t.getAttribute('data-id') === '8')!;
    p.dispatch(tr8, 'dblclick');
    expect(p.posted).toContainEqual({ type: 'compare', id: 8 });
    p.deliver(baseState({ rows: [row(8, { canCompare: false })], selected: 8 }));
    const grid = [...p.app.walk()].find((n) => n.tagName === 'TABLE' && n.className === 'grid')!;
    p.dispatch(grid, 'keydown', { key: 'Enter' });
    expect(p.posted.filter((m) => m.type === 'compare' && m.id === 8)).toHaveLength(2);
  });

  it('the in-page menu takes focus once when it opens, and keeps it across a rebuild that only touches unrelated state (D20d)', () => {
    const p = createPage();
    p.deliver(baseState());
    p.dispatch(p.trs().find((t) => t.getAttribute('data-id') === '8')!, 'contextmenu');
    expect(p.menuOpen()).toBe(true);
    const firstButton = () => [...p.body.walk()].find((n) => n.tagName === 'BUTTON' && n.parent && n.parent.className === 'menu')!;
    expect(activeDoc.activeElement).toBe(firstButton());
    expect(firstButton().lastFocusOpts).toEqual({ preventScroll: true }); // D20a
    // The state echo the right-click's own `select` causes rebuilds the menu
    // (D16b), discarding its old DOM node -- since that node still held
    // focus, D20d re-focuses the REBUILT menu rather than silently dropping
    // keyboard focus to nowhere.
    p.deliver(baseState({ selected: 8 }));
    expect(p.menuOpen()).toBe(true);
    expect(activeDoc.activeElement).toBe(firstButton());
    // A second, unrelated rebuild: focus is still in the (again rebuilt) menu.
    p.deliver(baseState({ selected: 8, error: 'unrelated' }));
    expect(activeDoc.activeElement).toBe(firstButton());
  });

  it('a rebuild does NOT steal focus into the menu when focus was somewhere else, e.g. the grid (D20d)', () => {
    const p = createPage();
    p.deliver(baseState({ selected: 8 }));
    p.dispatch(p.trs().find((t) => t.getAttribute('data-id') === '8')!, 'contextmenu');
    expect(p.menuOpen()).toBe(true);
    // The user tabs back to the grid row without closing the menu (no click,
    // no Escape -- this fake DOM's focus() is the only thing that would move
    // real focus here). render()'s OWN focus-preservation (unrelated to the
    // menu) then keeps re-focusing the grid row across the rebuilds below,
    // which is what this test wants: the row, never the menu, holds it.
    p.trs().find((t) => t.getAttribute('data-id') === '8')!.focus();
    p.deliver(baseState({ selected: 8, error: 'unrelated' })); // rebuilds the still-open menu
    expect(p.menuOpen()).toBe(true); // the menu itself is untouched by this
    const menuButton = [...p.body.walk()].find((n) => n.tagName === 'BUTTON' && n.parent && n.parent.className === 'menu')!;
    expect(activeDoc.activeElement).not.toBe(menuButton); // focus was not stolen into the menu
    expect(activeDoc.activeElement).toBe(p.trs().find((t) => t.getAttribute('data-id') === '8'));
  });

  it('arrow-key navigation scrolls the newly selected row into view explicitly (D20a)', () => {
    const calls: string[] = [];
    const original = FakeElement.prototype.scrollIntoView;
    FakeElement.prototype.scrollIntoView = function (this: FakeElement) {
      calls.push(this.getAttribute('data-id') ?? '');
    };
    try {
      const p = createPage();
      p.deliver(baseState({ selected: 9 })); // the initial state message also scrolls (D16e); not what this test is about
      calls.length = 0;
      const grid = [...p.app.walk()].find((n) => n.tagName === 'TABLE' && n.className === 'grid')!;
      p.dispatch(grid, 'keydown', { key: 'ArrowDown' });
      expect(calls).toEqual(['8']); // moved from row 9 to row 8, and scrolled it into view
    } finally {
      FakeElement.prototype.scrollIntoView = original;
    }
  });

  it('the selected row is refocused with preventScroll on a re-render while it already has focus (D20a)', () => {
    const p = createPage();
    p.deliver(baseState({ selected: 8 }));
    const tr8 = p.trs().find((t) => t.getAttribute('data-id') === '8')!;
    tr8.focus(); // simulates the browser's own focus after a real click, which this fake DOM does not
    p.deliver(baseState({ selected: 8, error: 'a transient error' })); // any re-render while it is focused
    const rebuiltTr8 = p.trs().find((t) => t.getAttribute('data-id') === '8')!; // render() rebuilds every row
    expect(activeDoc.activeElement).toBe(rebuiltTr8);
    expect(rebuiltTr8.lastFocusOpts).toEqual({ preventScroll: true });
  });

  it('focus returns to the selected row after Escape closes the menu (D18e)', () => {
    const p = createPage();
    p.deliver(baseState({ selected: 8 }));
    p.dispatch(p.trs().find((t) => t.getAttribute('data-id') === '8')!, 'contextmenu');
    expect(p.menuOpen()).toBe(true);
    p.fireDoc('keydown', { key: 'Escape' });
    expect(p.menuOpen()).toBe(false);
    const tr8 = p.trs().find((t) => t.getAttribute('data-id') === '8')!;
    expect(activeDoc.activeElement).toBe(tr8);
  });

  it('focus returns to the selected row after a menu action (D18e)', () => {
    const p = createPage();
    p.deliver(baseState());
    p.dispatch(p.trs().find((t) => t.getAttribute('data-id') === '8')!, 'contextmenu');
    expect(p.menuOpen()).toBe(true);
    const menuButton = [...p.body.walk()].find((n) => n.tagName === 'BUTTON' && n.parent && n.parent.className === 'menu')!;
    p.dispatch(menuButton, 'click');
    expect(p.menuOpen()).toBe(false); // a real action closed it
    const tr8 = p.trs().find((t) => t.getAttribute('data-id') === '8')!;
    expect(activeDoc.activeElement).toBe(tr8);
  });

  it('focus returns to the selected row after clicking Load more (D18e)', () => {
    const p = createPage();
    p.deliver(baseState({ selected: 8, more: true }));
    const loadMoreBtn = [...p.app.walk()].find((n) => n.tagName === 'BUTTON' && n.textContent === labels.loadMore)!;
    p.dispatch(loadMoreBtn, 'click');
    const tr8 = p.trs().find((t) => t.getAttribute('data-id') === '8')!;
    expect(activeDoc.activeElement).toBe(tr8);
  });

  it('shows the details pane failure independently of the page banner (D18c)', () => {
    const p = createPage();
    p.deliver(baseState({ selected: 8, error: 'page banner failure', detailsError: 'details pane failure' }));
    const nodes = [...p.app.walk()];
    expect(nodes.some((n) => n.tagName === 'P' && n.className === 'error' && n.textContent === 'page banner failure')).toBe(true);
    expect(nodes.some((n) => n.tagName === 'P' && n.className === 'error' && n.textContent === 'details pane failure')).toBe(true);
  });

  it('shows the loading hint in the details pane while state.loading is true, not a stale detailsError', () => {
    const p = createPage();
    p.deliver(baseState({ selected: 8, loading: true, detailsError: 'a previous failure' }));
    const nodes = [...p.app.walk()];
    expect(nodes.some((n) => n.tagName === 'P' && n.className === 'hint' && n.textContent === labels.loading)).toBe(true);
    expect(nodes.some((n) => n.textContent === 'a previous failure')).toBe(false);
  });
});
