/**
 * A minimal fake DOM for running a webview page script (media/*.js) under
 * vitest with no new dependency: historyPage.test.ts's approach, in a form
 * other page tests can share. The script is loaded as TEXT and run with
 * `new Function` against fake `document` / `window` / `acquireVsCodeApi`.
 * It supports only what the scripts use; an unsupported selector throws, so a
 * test can never pass by matching nothing.
 */
export type Listener = (e: FakeEvent) => void;

export interface FakeEvent {
  type: string;
  target?: FakeElement;
  clientX: number;
  clientY: number;
  key?: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  stopped: boolean;
  preventDefault(): void;
  stopPropagation(): void;
}

/** The element `focus()` was last called on: what `document.activeElement` returns. One page at a time. */
let focused: FakeElement | null = null;

export class FakeElement {
  tagName: string;
  children: FakeElement[] = [];
  parent: FakeElement | null = null;
  attrs: Record<string, string> = {};
  listeners: Record<string, Listener[]> = {};
  style: Record<string, string> = {};
  className = '';
  type = '';
  value = '';
  checked = false;
  scrollTop = 0;
  private text = '';

  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }
  set textContent(v: string) {
    this.text = String(v);
    this.children = [];
  }
  get textContent(): string {
    return this.text + this.children.map((c) => c.textContent).join('');
  }
  setAttribute(k: string, v: unknown): void {
    this.attrs[k] = String(v);
  }
  getAttribute(k: string): string | null {
    return k in this.attrs ? this.attrs[k] : null;
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
  replaceChildren(...cs: FakeElement[]): void {
    for (const c of this.children) c.parent = null;
    this.children = [];
    for (const c of cs) this.appendChild(c);
  }
  addEventListener(t: string, fn: Listener): void {
    (this.listeners[t] ??= []).push(fn);
  }
  focus(): void {
    focused = this;
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
    for (const n of this.walk()) if (matches(n, sel)) out.push(n);
    return out;
  }
}

function matches(n: FakeElement, sel: string): boolean {
  let m: RegExpExecArray | null;
  if (/^\.[\w-]+$/.test(sel)) return n.className.split(/\s+/).includes(sel.slice(1));
  if (/^[a-z]+$/.test(sel)) return n.tagName === sel.toUpperCase();
  if ((m = /^([a-z]+)\[data-path="(.*)"\]$/.exec(sel))) {
    return n.tagName === m[1].toUpperCase() && n.getAttribute('data-path') === m[2];
  }
  throw new Error('unsupported selector in this fake DOM: ' + sel);
}

export interface FakeDocument {
  body: FakeElement;
  readonly activeElement: FakeElement | null;
  listeners: Record<string, Listener[]>;
  createElement(t: string): FakeElement;
  getElementById(id: string): FakeElement | null;
  addEventListener(t: string, fn: Listener): void;
}

/** Fires `type` at `target`, bubbling to the document unless stopped. */
export function fire(target: FakeElement, doc: FakeDocument, type: string, extra: Partial<FakeEvent> = {}): FakeEvent {
  const ev: FakeEvent = {
    type,
    target,
    clientX: 5,
    clientY: 5,
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    stopped: false,
    preventDefault() {},
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

/** Runs `script` against a fresh fake page. */
export function loadPage(script: string) {
  const body = new FakeElement('body');
  const app = new FakeElement('main');
  app.setAttribute('id', 'app');
  body.appendChild(app);
  focused = null;
  const doc: FakeDocument = {
    body,
    get activeElement() {
      return focused;
    },
    listeners: {},
    createElement: (t) => new FakeElement(t),
    getElementById: (id) => (id === 'app' ? app : null),
    addEventListener(t, fn) {
      (this.listeners[t] ??= []).push(fn);
    },
  };
  const winListeners: Record<string, ((e: { data: unknown }) => void)[]> = {};
  const win = {
    addEventListener: (t: string, fn: (e: { data: unknown }) => void) => {
      (winListeners[t] ??= []).push(fn);
    },
  };
  const posted: Record<string, unknown>[] = [];
  const saved: unknown[] = [];
  const api = {
    postMessage: (m: unknown) => void posted.push(m as Record<string, unknown>),
    setState: (s: unknown) => void saved.push(s),
    getState: () => saved[saved.length - 1],
  };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval -- running the real page script under test
  new Function('acquireVsCodeApi', 'document', 'window', script)(() => api, doc, win);
  return {
    app,
    body,
    doc,
    posted,
    saved,
    /** Delivers a state the way the extension's postMessage does. */
    send(state: unknown): void {
      for (const fn of winListeners.message ?? []) fn({ data: state });
    },
    fire: (target: FakeElement, type: string, extra: Partial<FakeEvent> = {}) => fire(target, doc, type, extra),
  };
}
