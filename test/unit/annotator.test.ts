import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Annotator, ANNOTATED_KEY, REMAP_DEBOUNCE_MS, RENDER_INTERVAL_MS } from '../../src/annotate/Annotator.js';
import { parseHistory, type Changeset } from '../../src/tf/parseHistory.js';
import { PathMapper } from '../../src/tf/PathMapper.js';
import { SHOW_CHANGESET, COMPARE_VERSIONS, NBSP } from '../../src/annotate/margin.js';
import { lineMapCalls } from '../../src/annotate/remap.js';
import { VersionStore } from '../../src/history/VersionStore.js';
import type { PendingChange } from '../../src/tf/types.js';
import {
  recorder,
  hooks,
  window,
  workspace,
  executed,
  createdDecorationTypes,
  progressRuns,
  Uri,
  MarkdownString,
  hoverProviders,
  Hover,
  TabInputText,
  TabInputTextDiff,
} from '../vscode-mock.js';
import { S } from '../../src/tf/strings.js';

const HISTORY = parseHistory(
  readFileSync(join(__dirname, '../fixtures/windows/history-workspace-version.txt')).toString('utf8'),
).changesets;
const OLD_NAME = '$/Shop/Shop2023/ShopModel/Till/tillPOSReplies.vb';
// The post-rename name C18547 (and every newer changeset) prints (finding 20).
const NEW_NAME = '$/Shop/Shop2023/ShopModel/Till/tillPOSReply.vb';
/**
 * `Annotator.annotate` derives the margin's display name with the HOST's own
 * `basename` (src/annotate/Annotator.ts), not the mapper. A Windows-only
 * `C:\work\...` literal has no `/` for posix `basename` to split on, so on
 * Linux it would return the whole path instead of just the file name -- a
 * test artefact (production's `document.uri.fsPath` is always a genuine host
 * path). So `LOCAL` and `mapper` are chosen per platform here, same as the
 * "a Wine mapper" describe block below and historyCommands.test.ts; `isWin`
 * keeps Windows byte-for-byte as today.
 */
const isWin = process.platform === 'win32';
const LOCAL = isWin
  ? 'C:\\work\\Shop\\Shop2023\\ShopModel\\Till\\tillPOSReply.vb'
  : '/home/u/work/Shop/Shop2023/ShopModel/Till/tillPOSReply.vb';
const mapper = new PathMapper(
  [{ serverItem: '$/', localPath: isWin ? 'C:\\work' : 'Z:\\home\\u\\work' }],
  isWin ? 'win32' : 'linux',
);
/** A second document elsewhere under the SAME mapping root, for the "two documents" tests below.
 *  Named `otherLocal`, not `other`, because those tests each declare their own local `other`. */
const otherLocal = (name: string): string => (isWin ? `C:\\work\\Other\\${name}` : `/home/u/work/Other/${name}`);

// SYNTHETIC file contents per changeset: a, b, c and d each arrive in a different changeset.
const TEXTS: Record<number, string> = {
  18659: ['a', 'b', 'c', 'd'].join('\n'),
  18617: ['a', 'b', 'c'].join('\n'),
  18588: ['a', 'b', 'c'].join('\n'),
  18558: ['a', 'b', 'c'].join('\n'),
  18552: ['a', 'b', 'c'].join('\n'),
  18547: ['a', 'b'].join('\n'),
  18544: 'a',
};

interface Options {
  change?: Partial<PendingChange>;
  codePage?: number;
  failAt?: number;
  holdAt?: number;
}

function build(opts: Options = {}) {
  const historyCalls: unknown[][] = [];
  const textCalls: [string, number][] = [];
  const codePageCalls: [string, number][] = [];
  const logs: string[] = [];
  let release: () => void = () => {};
  const held = new Promise<void>((r) => (release = r));
  const annotator = new Annotator({
    history: {
      all: async (target: unknown, options: unknown) => {
        historyCalls.push([target, options]);
        return HISTORY;
      },
    },
    versions: {
      textAt: async (path: string, id: number, codePage: () => Promise<number | undefined>) => {
        textCalls.push([path, id]);
        if (id === opts.holdAt) await held;
        if (id === opts.failAt) throw new Error('TF400813: not authorized');
        // The rename (F9): C18544 exists only under the old name.
        if (id === 18544 && path !== OLD_NAME) throw new Error('No file matches.');
        return { text: TEXTS[id], codePage: await codePage() };
      },
      codePageAt: async (path: string, id: number) => {
        codePageCalls.push([path, id]);
        return opts.codePage ?? 65001;
      },
    },
    mapper: () => mapper,
    changeFor: () =>
      opts.change ? ({ changes: new Set(), encoding: 65001, ...opts.change } as unknown as PendingChange) : undefined,
    log: (line: string) => logs.push(line),
  });
  return { annotator, historyCalls, textCalls, codePageCalls, logs, release };
}

function editorFor(fsPath: string, initial: string) {
  let text = initial;
  // Real vscode.TextDocument.version increments on every edit; D17b keys the
  // Annotator's lineMap cache on it, so a fake document that never changed it
  // would hide a stale-cache bug (the remap would silently keep using the
  // PREVIOUS buffer's map after a real edit).
  let version = 1;
  // D19e: defaults to `true` -- most tests here model an in-progress EDIT
  // (the ordinary case a real, unsaved document is in while its text
  // changes). Tests for the reload path (D19e) flip this to `false` to model
  // a document that matches disk again (a Get, an Undo, another program).
  let dirty = true;
  const calls: { options: any[] }[] = [];
  const document = {
    uri: Uri.file(fsPath),
    getText: () => text,
    get version() {
      return version;
    },
    get isDirty() {
      return dirty;
    },
  };
  const editor = {
    document,
    setDecorations: (_type: unknown, options: any[]) => void calls.push({ options }),
  };
  return {
    editor,
    document,
    calls,
    setText: (t: string) => {
      text = t;
      version++;
    },
    setDirty: (d: boolean) => {
      dirty = d;
    },
    labels: () => (calls.at(-1)?.options ?? []).map((o) => (o.renderOptions.before.contentText as string).split(NBSP).join(' ').trimEnd()),
  };
}

let current: ReturnType<typeof editorFor>;

beforeEach(() => {
  recorder.reset();
  current = editorFor(LOCAL, TEXTS[18659]);
  window.visibleTextEditors = [current.editor];
  recorder.activeTextEditor = current.editor as never;
});

afterEach(() => {
  vi.useRealTimers();
  window.visibleTextEditors = [];
});

const contextValues = () => executed.filter((e) => e.id === 'setContext' && e.args[0] === ANNOTATED_KEY).map((e) => e.args[1]);
const listenerCount = () =>
  hooks.didChangeTextDocument.count +
  hooks.didChangeVisibleTextEditors.count +
  hooks.didChangeActiveTextEditor.count +
  hooks.didCloseTextDocument.count +
  // D19d: the tabGroups listener joins the D5 "off means zero work" set.
  hooks.didChangeTabs.count;

describe('Annotator: off means zero work (D5)', () => {
  it('creates no decoration type and registers no listener until something is annotated', () => {
    build();
    expect(createdDecorationTypes).toHaveLength(0);
    expect(listenerCount()).toBe(0);
    // D19b: the hover provider is part of the same "off" set.
    expect(hoverProviders).toHaveLength(0);
  });

  it('drops them all again when the last annotation is hidden', async () => {
    const h = build();
    await h.annotator.annotate(current.document as never);
    expect(listenerCount()).toBe(5);
    expect(hoverProviders).toHaveLength(1);
    h.annotator.hide(current.document.uri as never);
    expect(listenerCount()).toBe(0);
    expect(hoverProviders).toHaveLength(0);
    expect(createdDecorationTypes[0].disposed).toBe(true);
    expect(current.calls.at(-1)?.options).toEqual([]);
  });
});

describe('Annotator: the margin', () => {
  it('labels each line with the changeset that introduced it, following the rename', async () => {
    const h = build();
    await h.annotator.annotate(current.document as never);
    expect(current.labels()).toEqual(['18544 Boris', '18547 Filip', '18552 Boris', '18659 Boris']);
    expect(h.textCalls).toContainEqual([OLD_NAME, 18544]);
  });

  it('asks for history up to the workspace version, by local path in tf form', async () => {
    const h = build();
    await h.annotator.annotate(current.document as never);
    expect(h.historyCalls[0][0]).toEqual({ mode: 'file', itemspec: mapper.toWinePath(LOCAL) });
    expect(h.historyCalls[0][1]).toMatchObject({ workspace: true });
  });

  it('sets the context key while annotated and clears it on hide', async () => {
    const h = build();
    await h.annotator.annotate(current.document as never);
    h.annotator.hide(current.document.uri as never);
    expect(contextValues()).toEqual([true, false]);
  });

  it('does not start a second walk for a file already annotated', async () => {
    const h = build();
    await h.annotator.annotate(current.document as never);
    await h.annotator.annotate(current.document as never);
    expect(h.historyCalls).toHaveLength(1);
  });

  it('marks lines typed since the workspace version local, after a pause', async () => {
    const h = build();
    await h.annotator.annotate(current.document as never);
    vi.useFakeTimers();
    const before = current.calls.length;
    current.setText(['a', 'NEW', 'b', 'c', 'd'].join('\n'));
    hooks.didChangeTextDocument.emit({ document: current.document, contentChanges: [{}] });
    vi.advanceTimersByTime(REMAP_DEBOUNCE_MS - 1);
    expect(current.calls.length).toBe(before);
    vi.advanceTimersByTime(1);
    expect(current.labels()).toEqual(['18544 Boris', 'local', '18547 Filip', '18552 Boris', '18659 Boris']);
  });

  it('draws again when the editor becomes visible again', async () => {
    const h = build();
    await h.annotator.annotate(current.document as never);
    const before = current.calls.length;
    hooks.didChangeVisibleTextEditors.emit([current.editor]);
    expect(current.calls.length).toBe(before + 1);
  });

  it('hides when the document closes', async () => {
    const h = build();
    await h.annotator.annotate(current.document as never);
    hooks.didCloseTextDocument.emit(current.document);
    expect(contextValues().at(-1)).toBe(false);
    expect(listenerCount()).toBe(0);
  });

  it('drops everything on dispose', async () => {
    const h = build();
    await h.annotator.annotate(current.document as never);
    h.annotator.dispose();
    expect(listenerCount()).toBe(0);
    expect(createdDecorationTypes[0].disposed).toBe(true);
  });
});

describe('Annotator: refusals', () => {
  it.each([
    [{ changes: new Set(['Add']) }, S.annotatePendingAdd('tillPOSReply.vb')],
    [{ changes: new Set(['Delete']) }, S.annotatePendingDelete('tillPOSReply.vb')],
    [{ changes: new Set(['Rename']) }, S.annotatePendingRename('tillPOSReply.vb')],
    [{ changes: new Set(['Edit']), encoding: -1 }, S.annotateBinary('tillPOSReply.vb')],
  ])('refuses %o without running tf', async (change, message) => {
    const h = build({ change: change as Partial<PendingChange> });
    await h.annotator.annotate(current.document as never);
    expect(recorder.shown).toContain(message);
    expect(h.historyCalls).toEqual([]);
    expect(createdDecorationTypes).toHaveLength(0);
  });

  it('refuses a file outside the workspace', async () => {
    const h = build();
    const outside = editorFor('D:\\elsewhere\\x.vb', 'x');
    await h.annotator.annotate(outside.document as never);
    expect(recorder.shown).toContain(S.noWorkspaceMapping);
    expect(h.historyCalls).toEqual([]);
  });

  it('refuses a binary it only learns about from the code page, and hides', async () => {
    const h = build({ codePage: -1 });
    await h.annotator.annotate(current.document as never);
    expect(recorder.shown).toContain(S.annotateBinary('tillPOSReply.vb'));
    expect(contextValues().at(-1)).toBe(false);
  });
});

describe('Annotator: stopping early', () => {
  it('keeps what it has when cancelled, marking the rest at-or-before, without a warning', async () => {
    const h = build({ holdAt: 18558 });
    const annotating = h.annotator.annotate(current.document as never);
    // All four first fetches START at once, so wait for three versions to be
    // FOLDED (progress "3/7"), leaving the walk parked on the held C18558.
    const folded = () => progressRuns[0]?.reports.some((r) => (r as { message?: string }).message === '3/7');
    while (!folded()) await new Promise((r) => setImmediate(r));
    progressRuns[0].cancel();
    h.release();
    await annotating;
    expect(current.labels()).toEqual(['≤ C18588', '', '', '18659 Boris']);
    expect(recorder.messages.filter((m) => m.kind === 'warning')).toEqual([]);
    expect(contextValues().at(-1)).toBe(true);
  });

  it('warns, and keeps what it has, when a version cannot be fetched', async () => {
    const h = build({ failAt: 18552 });
    await h.annotator.annotate(current.document as never);
    expect(current.labels()).toEqual(['≤ C18558', '', '', '18659 Boris']);
    const warning = recorder.messages.find((m) => m.kind === 'warning');
    expect(warning?.message).toBe(S.annotateStopped('tillPOSReply.vb', 'TF400813: not authorized'));
  });

  // D15: a Cancel that lands before any version is folded ends the session
  // quietly -- no message at all, margin hidden, context key false. SYNTHETIC
  // fakes below (not from build()) hold the FIRST fetch this walk makes, so
  // Cancel always arrives before runBlame folds anything.
  it('is quiet when Cancel lands while history.all is still pending', async () => {
    let releaseHistory: (list: typeof HISTORY) => void = () => {};
    const held = new Promise<typeof HISTORY>((r) => (releaseHistory = r));
    const historyCalls: unknown[][] = [];
    const annotator = new Annotator({
      history: {
        all: async (target: unknown, options: unknown) => {
          historyCalls.push([target, options]);
          return held;
        },
      },
      versions: {
        textAt: async () => {
          throw new Error('must not be called: cancel landed before any fetch');
        },
        codePageAt: async () => 65001,
      },
      mapper: () => mapper,
      changeFor: () => undefined,
      log: () => {},
    });

    const annotating = annotator.annotate(current.document as never);
    while (progressRuns.length === 0) await new Promise((r) => setImmediate(r));
    progressRuns[0].cancel();
    releaseHistory([]);
    await annotating;

    expect(recorder.messages).toEqual([]);
    expect(contextValues().at(-1)).toBe(false);
    expect(current.calls.at(-1)?.options).toEqual([]);
  });

  it('is quiet when Cancel lands before the first version resolves', async () => {
    let releaseText: () => void = () => {};
    const held = new Promise<void>((r) => (releaseText = r));
    const textCalls: number[] = [];
    const annotator = new Annotator({
      history: {
        all: async () => HISTORY,
      },
      versions: {
        // history.all must resolve, and the walk must reach runBlame's first
        // fetch, BEFORE cancel fires -- otherwise this exercises the same
        // pre-runBlame D15 check as the test above, not the post-runBlame one.
        textAt: async (_path: string, id: number) => {
          textCalls.push(id);
          await held;
          return { text: TEXTS[id], codePage: 65001 };
        },
        codePageAt: async () => 65001,
      },
      mapper: () => mapper,
      changeFor: () => undefined,
      log: () => {},
    });

    const annotating = annotator.annotate(current.document as never);
    while (textCalls.length === 0) await new Promise((r) => setImmediate(r));
    progressRuns[0].cancel();
    releaseText();
    await annotating;

    expect(recorder.messages).toEqual([]);
    expect(contextValues().at(-1)).toBe(false);
    expect(current.calls.at(-1)?.options).toEqual([]);
  });
});

/** A position with the shape the mock's HoverProvider entries are called with. */
const at = (line: number, character: number) => ({ line, character }) as never;

describe('Annotator: the hover', () => {
  it('adds server text as text, and trusts exactly the two hover commands', async () => {
    const h = build();
    await h.annotator.annotate(current.document as never);
    const provider = hoverProviders[0];
    const result = provider.provideHover(current.document as never, at(3, 0)); // line 3 -> C18659, the newest
    const hover = result as InstanceType<typeof Hover>;
    const md = hover.contents as MarkdownString;
    expect(md.isTrusted).toEqual({ enabledCommands: [SHOW_CHANGESET, COMPARE_VERSIONS] });
    const text = md.parts.filter((p) => p.kind === 'text').map((p) => p.value);
    expect(text).toContain('Teller_ID');
    expect(md.parts.filter((p) => p.kind === 'markdown').some((p) => p.value.includes('Teller_ID'))).toBe(false);
    expect(md.value).toContain(`command:${SHOW_CHANGESET}?`);
    expect(md.value).toContain(`command:${COMPARE_VERSIONS}?`);
    // The heading -- "Changeset <id> · <user> · <date>" -- goes through
    // appendText, same as the comment body, never appendMarkdown.
    expect(md.parts[0].kind).toBe('text');
    expect(md.parts[0].value).toContain('Changeset');
  });

  it('never puts a hoverMessage on a decoration -- hovers come from the HoverProvider instead (D19b)', async () => {
    const h = build();
    await h.annotator.annotate(current.document as never);
    const options = current.calls.at(-1)!.options;
    expect(options.length).toBeGreaterThan(0);
    expect(options.every((o: { hoverMessage?: unknown }) => !('hoverMessage' in o))).toBe(true);
  });

  // D19b supersedes D17a: since hovers no longer cost VS Code a per-decoration
  // hoverMessage conversion, every line of a block answers now, not just the
  // one that carries the label.
  it('answers at character 0 on ANY line of a block, not only its first', async () => {
    const SERVER = mapper.toServerPath(LOCAL)!;
    const changesets: Changeset[] = [
      { id: 202, user: 'Boris', date: 'today', comment: 'newest', items: [{ change: ['edit'], serverPath: SERVER }] },
      { id: 201, user: 'Filip', date: 'today', comment: 'oldest', items: [{ change: ['add'], serverPath: SERVER }] },
    ];
    // Both versions are byte-identical: nothing is ever claimed during the
    // diff step, so all three lines end up owned by the SAME (oldest)
    // changeset via BlameWalk.finish() -- one run of three equal owners.
    const text = ['a', 'a', 'b'].join('\n');
    const ed = editorFor(LOCAL, text);
    window.visibleTextEditors = [ed.editor];
    recorder.activeTextEditor = ed.editor as never;
    const annotator = new Annotator({
      history: { all: async () => changesets },
      versions: {
        textAt: async (_p: string, id: number, codePage: () => Promise<number | undefined>) => ({
          text,
          codePage: await codePage(),
        }),
        codePageAt: async () => 65001,
      },
      mapper: () => mapper,
      changeFor: () => undefined,
      log: () => {},
    });
    await annotator.annotate(ed.document as never);
    expect(ed.labels()).toEqual(['201 Filip', '', '']); // one block of three lines

    const provider = hoverProviders[0];
    for (const line of [0, 1, 2]) {
      const hover = provider.provideHover(ed.document as never, at(line, 0)) as InstanceType<typeof Hover>;
      expect(hover, `line ${line}`).toBeDefined();
      expect((hover.contents as MarkdownString).isTrusted).toEqual({
        enabledCommands: [SHOW_CHANGESET, COMPARE_VERSIONS],
      });
    }
    expect(provider.provideHover(ed.document as never, at(1, 1))).toBeUndefined(); // past column 0
  });

  it('returns undefined for a non-annotated document, and once no session exists at all', async () => {
    const h = build();
    await h.annotator.annotate(current.document as never);
    const provider = hoverProviders[0];
    const other = editorFor(otherLocal('untouched.vb'), 'x');
    expect(provider.provideHover(other.document as never, at(0, 0))).toBeUndefined();
  });

  it('returns undefined on an atOrBefore line, and defined on a changeset line, once a walk stops early', async () => {
    const h = build({ holdAt: 18558 });
    const annotating = h.annotator.annotate(current.document as never);
    const folded = () => progressRuns[0]?.reports.some((r) => (r as { message?: string }).message === '3/7');
    while (!folded()) await new Promise((r) => setImmediate(r));
    progressRuns[0].cancel();
    h.release();
    await annotating;
    // The FINAL draw after a stop is always done at once (D17c), so this
    // state is guaranteed to be what the provider answers from.
    expect(current.labels()).toEqual(['≤ C18588', '', '', '18659 Boris']);

    const provider = hoverProviders[0];
    expect(provider.provideHover(current.document as never, at(0, 0))).toBeUndefined(); // atOrBefore
    expect(provider.provideHover(current.document as never, at(3, 0))).toBeDefined(); // changeset
  });

  it('returns undefined on a local line (one the user edited since the base)', async () => {
    const h = build();
    await h.annotator.annotate(current.document as never);
    vi.useFakeTimers();
    current.setText(['a', 'NEW', 'b', 'c', 'd'].join('\n'));
    hooks.didChangeTextDocument.emit({ document: current.document, contentChanges: [{}] });
    vi.advanceTimersByTime(REMAP_DEBOUNCE_MS);
    expect(current.labels()).toEqual(['18544 Boris', 'local', '18547 Filip', '18552 Boris', '18659 Boris']);

    const provider = hoverProviders[0];
    expect(provider.provideHover(current.document as never, at(1, 0))).toBeUndefined(); // local
    expect(provider.provideHover(current.document as never, at(0, 0))).toBeDefined(); // changeset
  });

  // The Compare link must use each version's OWN printed path, not the
  // document's current one: at C18547 (the rename) the file printed under its
  // NEW name, and its previous version, C18544, printed under OLD_NAME.
  it("the Compare link pairs each version's own printed path across the rename", async () => {
    const h = build();
    await h.annotator.annotate(current.document as never);
    expect(current.labels()).toEqual(['18544 Boris', '18547 Filip', '18552 Boris', '18659 Boris']);
    const provider = hoverProviders[0];
    const hover = provider.provideHover(current.document as never, at(1, 0)) as InstanceType<typeof Hover>; // line 1 -> C18547
    const md = hover.contents as MarkdownString;
    const links = md.parts.filter((p) => p.kind === 'markdown').map((p) => p.value).join('');
    const match = links.match(/command:teamExplorer\.compareVersions\?([^)]+)\)/);
    expect(match).not.toBeNull();
    const args = JSON.parse(decodeURIComponent(match![1]).replace(/\\u0025/g, '%'));
    expect(args).toEqual([OLD_NAME, 18544, NEW_NAME, 18547]);
  });
});

describe('Annotator: D5 -- two documents share one decoration type and one listener set', () => {
  it('hiding one document keeps the other; hiding the last drops everything', async () => {
    const other = editorFor(otherLocal('file.vb'), TEXTS[18659]);
    window.visibleTextEditors = [current.editor, other.editor];
    const h = build();
    await h.annotator.annotate(current.document as never);
    expect(createdDecorationTypes).toHaveLength(1);
    expect(listenerCount()).toBe(5);

    await h.annotator.annotate(other.document as never);
    expect(createdDecorationTypes).toHaveLength(1); // still just one decoration type
    expect(listenerCount()).toBe(5); // still just one listener set

    h.annotator.hide(current.document.uri as never);
    expect(listenerCount()).toBe(5); // B is still annotated
    expect(createdDecorationTypes[0].disposed).toBe(false);
    expect(other.calls.at(-1)?.options.length).toBeGreaterThan(0); // B's margin untouched

    h.annotator.hide(other.document.uri as never);
    expect(listenerCount()).toBe(0);
    expect(createdDecorationTypes[0].disposed).toBe(true);
  });
});

describe('Annotator: the context key follows the active editor', () => {
  it('switching to a non-annotated editor sets it false; switching back sets it true', async () => {
    const other = editorFor(otherLocal('file2.vb'), 'x');
    window.visibleTextEditors = [current.editor, other.editor];
    const h = build();
    await h.annotator.annotate(current.document as never);
    expect(contextValues().at(-1)).toBe(true);

    recorder.activeTextEditor = other.editor as never;
    hooks.didChangeActiveTextEditor.emit(other.editor);
    expect(contextValues().at(-1)).toBe(false);

    recorder.activeTextEditor = current.editor as never;
    hooks.didChangeActiveTextEditor.emit(current.editor);
    expect(contextValues().at(-1)).toBe(true);
  });
});

describe('Annotator: D8 through the Annotator -- the code-page plan', () => {
  it('a version older than an encoding change asks codePageAt for itself; the rest share the base, asked once even with 4 fetches starting together', async () => {
    const SERVER = mapper.toServerPath(LOCAL)!;
    // Newest first. The 'encoding' change sits at index 2 (id 103): index 0-2
    // share the base's (105's) code page; 3 and 4 -- OLDER than it -- ask for
    // their own (D8/needsOwnCodePage).
    const rows = [
      { id: 105, change: ['edit'] },
      { id: 104, change: ['edit'] },
      { id: 103, change: ['edit', 'encoding'] },
      { id: 102, change: ['edit'] },
      { id: 101, change: ['add'] },
    ];
    const texts: Record<number, string> = { 105: 'e', 104: 'e', 103: 'e', 102: 'e', 101: 'e' };
    const changesets: Changeset[] = rows.map((r) => ({
      id: r.id,
      user: 'Boris',
      date: 'today',
      comment: '',
      items: [{ change: r.change, serverPath: SERVER }],
    }));
    const codePageCalls: [string, number][] = [];
    const ed = editorFor(LOCAL, texts[105]);
    window.visibleTextEditors = [ed.editor];
    recorder.activeTextEditor = ed.editor as never;
    const annotator = new Annotator({
      history: { all: async () => changesets },
      versions: {
        textAt: async (_p: string, id: number, codePage: () => Promise<number | undefined>) => ({
          text: texts[id],
          codePage: await codePage(),
        }),
        codePageAt: async (path: string, id: number) => {
          codePageCalls.push([path, id]);
          return 65001;
        },
      },
      mapper: () => mapper,
      changeFor: () => undefined,
      log: () => {},
    });
    await annotator.annotate(ed.document as never);
    // The shared call is keyed by the BASE (newest, 105) regardless of which
    // of 105/104/103 needed it first.
    expect(codePageCalls.filter(([, id]) => id === 105)).toHaveLength(1);
    expect(codePageCalls.filter(([, id]) => id === 104)).toHaveLength(0);
    expect(codePageCalls.filter(([, id]) => id === 103)).toHaveLength(0);
    expect(codePageCalls.filter(([, id]) => id === 102)).toHaveLength(1);
    expect(codePageCalls.filter(([, id]) => id === 101)).toHaveLength(1);
    expect(codePageCalls).toHaveLength(3);
  });
});

describe('Annotator: a Wine mapper', () => {
  it('history.all receives the itemspec in the Z:\\... form', async () => {
    // A working folder's localPath is in tf.exe's own terms: a Z: path under Wine.
    const wineMapper = new PathMapper([{ serverItem: '$/', localPath: 'Z:\\home\\shax\\work' }], 'linux');
    const wineLocal = '/home/shax/work/Shop/Shop2023/ShopModel/Till/tillPOSReply.vb';
    const historyCalls: unknown[][] = [];
    const ed = editorFor(wineLocal, TEXTS[18659]);
    window.visibleTextEditors = [ed.editor];
    recorder.activeTextEditor = ed.editor as never;
    const annotator = new Annotator({
      history: {
        all: async (target: unknown, options: unknown) => {
          historyCalls.push([target, options]);
          return HISTORY;
        },
      },
      versions: {
        textAt: async (path: string, id: number, codePage: () => Promise<number | undefined>) => {
          if (id === 18544 && path !== OLD_NAME) throw new Error('No file matches.');
          return { text: TEXTS[id], codePage: await codePage() };
        },
        codePageAt: async () => 65001,
      },
      mapper: () => wineMapper,
      changeFor: () => undefined,
      log: () => {},
    });
    await annotator.annotate(ed.document as never);
    expect(historyCalls[0][0]).toEqual({ mode: 'file', itemspec: wineMapper.toWinePath(wineLocal) });
    expect((historyCalls[0][0] as { itemspec: string }).itemspec.startsWith('Z:\\')).toBe(true);
  });
});

describe('Annotator: D17c/D17b -- coalesced renders and a cached remap', () => {
  it('a walk of many versions draws far fewer times than there are versions, exactly once after the last, and diffs the base against the buffer only once', async () => {
    const N = 50;
    const SERVER = mapper.toServerPath(LOCAL)!;
    const ids = Array.from({ length: N }, (_, i) => 20000 - i); // newest first
    const texts: Record<number, string> = {};
    for (const id of ids) texts[id] = `line ${id}`; // single-line "file": every version differs
    const changesets: Changeset[] = ids.map((id, i) => ({
      id,
      user: 'Boris',
      date: 'today',
      comment: '',
      items: [{ change: i === N - 1 ? ['add'] : ['edit'], serverPath: SERVER }],
    }));
    const ed = editorFor(LOCAL, texts[ids[0]]);
    window.visibleTextEditors = [ed.editor];
    recorder.activeTextEditor = ed.editor as never;
    const annotator = new Annotator({
      history: { all: async () => changesets },
      versions: {
        textAt: async (_p: string, id: number, codePage: () => Promise<number | undefined>) => ({
          text: texts[id],
          codePage: await codePage(),
        }),
        codePageAt: async () => 65001,
      },
      mapper: () => mapper,
      changeFor: () => undefined,
      log: () => {},
    });
    const before = lineMapCalls;
    await annotator.annotate(ed.document as never);
    const drawsAfterWalk = ed.calls.length;
    expect(drawsAfterWalk).toBeLessThan(10); // far fewer than N = 50
    expect(ed.labels()).toEqual([`${ids[0]} Boris`]); // correct FINAL state
    // The document never changed and the walk fed baseLines exactly once, so
    // the base->buffer diff runs exactly once for the whole walk, no matter
    // how many progress renders were coalesced into it.
    expect(lineMapCalls - before).toBe(1);
    // Nothing more is drawn once the coalescing window has had time to elapse.
    await new Promise((r) => setTimeout(r, RENDER_INTERVAL_MS + 50));
    expect(ed.calls.length).toBe(drawsAfterWalk);
  });
});

describe('Annotator: D17c -- a text-change event with no content changes schedules no render', () => {
  it('a save or a dirty-flag flip (empty contentChanges) draws nothing', async () => {
    const h = build();
    await h.annotator.annotate(current.document as never);
    vi.useFakeTimers();
    const before = current.calls.length;
    current.setText(['a', 'NEW', 'b', 'c', 'd'].join('\n'));
    hooks.didChangeTextDocument.emit({ document: current.document, contentChanges: [] });
    vi.advanceTimersByTime(REMAP_DEBOUNCE_MS + 10);
    expect(current.calls.length).toBe(before);
  });
});

describe('Annotator: D17d -- nothing starts after Hide, Cancel, close or dispose', () => {
  it('Hide mid-walk starts no further textAt or codePageAt, draws nothing more, shows no message, and the progress task resolves', async () => {
    const h = build({ holdAt: 18558 });
    const annotating = h.annotator.annotate(current.document as never);
    // Wait for three versions to fold (progress "3/7"): the walk is parked on
    // the held C18558, which -- with FETCH_CONCURRENCY 4 -- has already started.
    const folded = () => progressRuns[0]?.reports.some((r) => (r as { message?: string }).message === '3/7');
    while (!folded()) await new Promise((r) => setImmediate(r));
    const textCallsAtHide = h.textCalls.length;
    const codePageCallsAtHide = h.codePageCalls.length;
    const drawsAtHide = current.calls.length;

    h.annotator.hide(current.document.uri as never);
    await annotating; // resolves promptly -- does not wait for the held fetch

    expect(recorder.messages).toEqual([]);
    expect(current.calls.length).toBe(drawsAtHide + 1); // exactly hide()'s own clearing draw
    expect(current.calls.at(-1)?.options).toEqual([]);

    h.release(); // the tf call already running finishes on its own (D17d)
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(h.textCalls.length).toBe(textCallsAtHide); // no NEW textAt call
    expect(h.codePageCalls.length).toBe(codePageCallsAtHide); // no NEW codePageAt call
    expect(h.historyCalls).toHaveLength(1); // no NEW history.all call
    expect(current.calls.length).toBe(drawsAtHide + 1); // still nothing drawn
  });

  it('dispose() mid-walk starts no further tf, same as Hide', async () => {
    const h = build({ holdAt: 18558 });
    const annotating = h.annotator.annotate(current.document as never);
    const folded = () => progressRuns[0]?.reports.some((r) => (r as { message?: string }).message === '3/7');
    while (!folded()) await new Promise((r) => setImmediate(r));
    const textCallsAtDispose = h.textCalls.length;
    const codePageCallsAtDispose = h.codePageCalls.length;

    h.annotator.dispose();
    await annotating;
    expect(recorder.messages).toEqual([]);

    h.release();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(h.textCalls.length).toBe(textCallsAtDispose);
    expect(h.codePageCalls.length).toBe(codePageCallsAtDispose);
  });

  // The base's SHARED code page is memoized after the newest version's own
  // fetch, so a held CONTENT fetch for a later version that shares it can
  // never prove the codePage callback itself is guarded -- the memoized
  // value would be reused either way. This uses D8's per-version code page
  // (own[i] = true) instead, holding the OLDEST version (whose own codePageAt
  // has certainly not run yet, unlike the shared base's): releasing it after
  // Hide would call a codePageAt that was never started before, if it were
  // not guarded. Concurrency starts every version's FETCH well ahead of where
  // the walk is FOLDING, so the held one is the oldest, not the third.
  it('Hide mid-walk starts no NEW per-version codePageAt for a version whose own code page had not been asked for yet', async () => {
    const SERVER = mapper.toServerPath(LOCAL)!;
    const rows = [
      { id: 105, change: ['edit'] },
      { id: 104, change: ['edit'] },
      { id: 103, change: ['edit', 'encoding'] },
      { id: 102, change: ['edit'] }, // own[3] = true: OLDER than the encoding change
      { id: 101, change: ['add'] }, // own[4] = true: the one held below
    ];
    const texts: Record<number, string> = { 105: 'e', 104: 'e', 103: 'e', 102: 'e', 101: 'e' };
    const changesets: Changeset[] = rows.map((r) => ({
      id: r.id,
      user: 'Boris',
      date: 'today',
      comment: '',
      items: [{ change: r.change, serverPath: SERVER }],
    }));
    let release: () => void = () => {};
    const held = new Promise<void>((r) => (release = r));
    const codePageCalls: number[] = [];
    const ed = editorFor(LOCAL, texts[105]);
    window.visibleTextEditors = [ed.editor];
    recorder.activeTextEditor = ed.editor as never;
    const annotator = new Annotator({
      history: { all: async () => changesets },
      versions: {
        textAt: async (_p: string, id: number, codePage: () => Promise<number | undefined>) => {
          if (id === 101) await held; // the bytes for the oldest version are still "in flight"
          return { text: texts[id], codePage: await codePage() };
        },
        codePageAt: async (_p: string, id: number) => {
          codePageCalls.push(id);
          return 65001;
        },
      },
      mapper: () => mapper,
      changeFor: () => undefined,
      log: () => {},
    });
    const annotating = annotator.annotate(ed.document as never);
    // 105, 104, 103, 102 fold; 101's fetch has started (concurrency 4 lets it
    // start as soon as an earlier one resolves) but is held.
    while (!progressRuns[0]?.reports.some((r) => (r as { message?: string }).message === '4/5')) {
      await new Promise((r) => setImmediate(r));
    }
    expect(codePageCalls.slice().sort()).toEqual([102, 105]); // the shared base, and 102's own -- never 101's
    annotator.hide(ed.document.uri as never);
    await annotating;
    release(); // 101's bytes "arrive" only after Hide
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(codePageCalls.slice().sort()).toEqual([102, 105]); // still just those two: 101's own codePageAt never started
  });

  it('Hide while history.all is pending resolves the annotate promise at once; releasing the history later starts nothing', async () => {
    let releaseHistory: (cs: typeof HISTORY) => void = () => {};
    const held = new Promise<typeof HISTORY>((r) => (releaseHistory = r));
    const historyCalls: unknown[][] = [];
    const textCalls: number[] = [];
    const annotator = new Annotator({
      history: {
        all: async (target: unknown, options: unknown) => {
          historyCalls.push([target, options]);
          return held;
        },
      },
      versions: {
        textAt: async (_p: string, id: number) => {
          textCalls.push(id);
          return { text: TEXTS[id], codePage: 65001 };
        },
        codePageAt: async () => 65001,
      },
      mapper: () => mapper,
      changeFor: () => undefined,
      log: () => {},
    });

    const annotating = annotator.annotate(current.document as never);
    while (progressRuns.length === 0) await new Promise((r) => setImmediate(r));
    annotator.hide(current.document.uri as never);
    await annotating; // resolves BEFORE the history is released

    expect(recorder.messages).toEqual([]);
    expect(contextValues().at(-1)).toBe(false);

    releaseHistory(HISTORY);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(textCalls).toEqual([]); // nothing started once the old history finally lands
  });

  it('Hide then a quick re-annotate while the old history is still pending: releasing the old history later leaves the new session untouched', async () => {
    let releaseOld: (cs: typeof HISTORY) => void = () => {};
    const oldHeld = new Promise<typeof HISTORY>((r) => (releaseOld = r));
    const historyCalls: unknown[][] = [];
    let call = 0;
    const annotator = new Annotator({
      history: {
        all: async (target: unknown, options: unknown) => {
          historyCalls.push([target, options]);
          call++;
          return call === 1 ? oldHeld : HISTORY;
        },
      },
      versions: {
        textAt: async (path: string, id: number, codePage: () => Promise<number | undefined>) => {
          if (id === 18544 && path !== OLD_NAME) throw new Error('No file matches.');
          return { text: TEXTS[id], codePage: await codePage() };
        },
        codePageAt: async () => 65001,
      },
      mapper: () => mapper,
      changeFor: () => undefined,
      log: () => {},
    });

    const first = annotator.annotate(current.document as never);
    while (historyCalls.length === 0) await new Promise((r) => setImmediate(r));
    annotator.hide(current.document.uri as never);
    await first;

    const second = annotator.annotate(current.document as never); // fresh session, its own history.all
    await second;
    expect(contextValues().at(-1)).toBe(true);
    expect(current.labels()).toEqual(['18544 Boris', '18547 Filip', '18552 Boris', '18659 Boris']);

    releaseOld(HISTORY); // the abandoned FIRST call finally lands
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(contextValues().at(-1)).toBe(true); // the new session is untouched
    expect(current.labels()).toEqual(['18544 Boris', '18547 Filip', '18552 Boris', '18659 Boris']);
  });
});

describe('Annotator: D17e -- once aborted, even a real failure that surfaces afterward stays quiet', () => {
  it('a genuine history failure that races the Cancel button is suppressed, not shown', async () => {
    const annotator = new Annotator({
      history: {
        all: async () => {
          // The Cancel button, clicked WHILE this history.all is in flight
          // (not Hide -- the session stays registered, which is what makes
          // this exercise the outer catch's `session.abort.signal.aborted`
          // check rather than the "session already gone" early return).
          progressRuns[0].cancel();
          throw new Error('TF400813: not authorized');
        },
      },
      versions: {
        textAt: async () => {
          throw new Error('must not be called: nothing may start after abort');
        },
        codePageAt: async () => 65001,
      },
      mapper: () => mapper,
      changeFor: () => undefined,
      log: () => {},
    });

    await annotator.annotate(current.document as never);

    expect(recorder.messages).toEqual([]);
    expect(contextValues().at(-1)).toBe(false);
  });
});

describe('Annotator: D17f -- a stop or a failure writes one log line', () => {
  it('logs the changeset a mid-walk stop happened at', async () => {
    const h = build({ failAt: 18552 });
    await h.annotator.annotate(current.document as never);
    const warning = recorder.messages.find((m) => m.kind === 'warning');
    expect(warning).toBeDefined();
    expect(h.logs).toHaveLength(1);
    expect(h.logs[0]).toContain('annotate:');
    expect(h.logs[0]).toContain('tillPOSReply.vb');
    expect(h.logs[0]).toContain('C18552');
    expect(h.logs[0]).toContain('TF400813: not authorized');
  });

  it('logs an outright failure (the newest version cannot be fetched at all)', async () => {
    const h = build({ failAt: 18659 });
    await h.annotator.annotate(current.document as never);
    expect(recorder.messages.some((m) => m.kind === 'error')).toBe(true);
    expect(h.logs).toHaveLength(1);
    expect(h.logs[0]).toContain('annotate:');
    expect(h.logs[0]).toContain('failed');
    expect(h.logs[0]).toContain('TF400813: not authorized');
  });
});

describe('Annotator: D19a -- over the REAL VersionStore, Hide then re-annotate while old fetches are in flight', () => {
  // Reproduces the bug the final review found: the in-flight map used to
  // share the FULL {bytes, codePage} result, so a second session joining the
  // same still-running `view` fetches got its codePage from whichever
  // caller's callback happened to be attached FIRST -- the first (now
  // hidden/aborted) session's. That callback throws once its own session is
  // aborted (`guardAbort`), which poisoned the shared promise for every
  // sibling, including a brand new session that had nothing to do with the
  // abort. Fails against the pre-D19a VersionStore; passes once `entryAt`
  // shares only the bytes and lets each caller resolve its own code page.
  it('a fresh session started right after Hide folds every version normally once the old fetches land', async () => {
    const started: string[][] = [];
    const gates: (() => void)[] = [];
    let hold = true;
    const tf = {
      timeoutMs: 60_000,
      run: async (args: string[]) => {
        started.push(args);
        if (hold) await new Promise<void>((r) => gates.push(r));
        if (args[1] === 'view') {
          const id = Number(/C(\d+)$/.exec(args.find((a) => a.startsWith('/version:'))!)![1]);
          const path = args[2];
          if (id === 18544 && path !== OLD_NAME) {
            return { stdout: Buffer.alloc(0), stderr: Buffer.from('No file matches.'), exitCode: 1, timedOut: false };
          }
          return { stdout: Buffer.from(TEXTS[id], 'utf8'), stderr: Buffer.alloc(0), exitCode: 0, timedOut: false };
        }
        return {
          stdout: Buffer.from('Server information:\n  File type    : utf-8\n'),
          stderr: Buffer.alloc(0),
          exitCode: 0,
          timedOut: false,
        };
      },
    };
    const releaseAll = () => {
      hold = false;
      for (const g of gates.splice(0)) g();
    };
    const store = new VersionStore(tf as never, undefined);
    const logs: string[] = [];
    const annotator = new Annotator({
      history: { all: async () => HISTORY },
      versions: store,
      mapper: () => mapper,
      changeFor: () => undefined,
      log: (l) => logs.push(l),
    });

    const first = annotator.annotate(current.document as never);
    while (started.filter((a) => a[1] === 'view').length < 4) await new Promise((r) => setImmediate(r));
    annotator.hide(current.document.uri as never);
    await first;

    const second = annotator.annotate(current.document as never); // re-annotates at once, joining the same in-flight fetches
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    releaseAll(); // the OLD (first session's) views and infos land now, alongside the new ones

    await second;

    expect(recorder.messages).toEqual([]);
    expect(logs).toEqual([]);
    expect(current.labels()).toEqual(['18544 Boris', '18547 Filip', '18552 Boris', '18659 Boris']);
  });
});

describe('Annotator: D19c -- draw spacing scales with how long the last draw took', () => {
  // Old code measured the wait from the START of the previous draw and used a
  // flat RENDER_INTERVAL_MS: a slow draw's own duration alone could already
  // exceed that gap by the time the NEXT progress tick ran, so it drew again
  // immediately -- no throttling at all for exactly the files where it
  // mattered (a heavily annotated, many-blocks file). Fails against that code
  // (gap tiny); passes once the wait is measured from the END of the draw and
  // scales with it (`Math.max(RENDER_INTERVAL_MS, 2 * lastDrawMs)`).
  it('a slow draw pushes the next progress draw out by at least twice its own duration', async () => {
    const SLOW_MS = 150;
    const N = 4;
    const SERVER = mapper.toServerPath(LOCAL)!;
    const ids = Array.from({ length: N }, (_, i) => 20200 - i); // newest first
    const texts: Record<number, string> = {};
    for (const id of ids) texts[id] = `line ${id}`;
    const changesets: Changeset[] = ids.map((id, i) => ({
      id,
      user: 'Boris',
      date: 'today',
      comment: '',
      items: [{ change: i === N - 1 ? ['add'] : ['edit'], serverPath: SERVER }],
    }));
    const ed = editorFor(LOCAL, texts[ids[0]]);
    window.visibleTextEditors = [ed.editor];
    recorder.activeTextEditor = ed.editor as never;

    const drawTimes: number[] = [];
    let slowedOnce = false;
    const record = ed.editor.setDecorations.bind(ed.editor);
    ed.editor.setDecorations = (type: unknown, options: unknown[]) => {
      if (!slowedOnce) {
        slowedOnce = true;
        const until = Date.now() + SLOW_MS; // busy-wait: gives this draw a real, measurable cost
        while (Date.now() < until) {
          /* empty */
        }
      }
      record(type, options as never);
      drawTimes.push(Date.now());
    };

    let releaseOldest: () => void = () => {};
    const held = new Promise<void>((r) => (releaseOldest = r));
    const annotator = new Annotator({
      history: { all: async () => changesets },
      versions: {
        textAt: async (_p: string, id: number, codePage: () => Promise<number | undefined>) => {
          if (id === ids[N - 1]) await held; // the oldest version never arrives until released below
          return { text: texts[id], codePage: await codePage() };
        },
        codePageAt: async () => 65001,
      },
      mapper: () => mapper,
      changeFor: () => undefined,
      log: () => {},
    });

    const annotating = annotator.annotate(ed.document as never);
    // The initial "…" draw (drawTimes[0]) is made artificially slow above.
    // Wait for the coalesced intermediate draw (drawTimes[1]) to land -- real
    // time, since both RENDER_INTERVAL_MS and D19c's math run on the wall
    // clock. The walk cannot finish (and force a bypassing final draw) while
    // the oldest version is held, so this can only be the throttled one.
    while (drawTimes.length < 2) await new Promise((r) => setTimeout(r, 5));

    const gap = drawTimes[1] - drawTimes[0];
    expect(gap).toBeGreaterThanOrEqual(2 * SLOW_MS - 30);

    releaseOldest();
    await annotating;
  });
});

describe('Annotator: D19d -- a session with no tab left is hidden', () => {
  it('closing the last tab for a document hides its session, dropping everything when it was the last one open', async () => {
    const h = build();
    window.tabGroups.all = [{ tabs: [{ input: new TabInputText(current.document.uri as never) }] }];
    await h.annotator.annotate(current.document as never);
    expect(listenerCount()).toBe(5);
    expect(contextValues().at(-1)).toBe(true);

    window.tabGroups.all = [{ tabs: [] }]; // the tab closed
    hooks.didChangeTabs.emit({ opened: [], closed: [], changed: [] });

    expect(contextValues().at(-1)).toBe(false);
    expect(listenerCount()).toBe(0);
    expect(current.calls.at(-1)?.options).toEqual([]);
  });

  it('keeps a session whose document is still open under a TabInputTextDiff (modified side)', async () => {
    const h = build();
    window.tabGroups.all = [
      { tabs: [{ input: new TabInputTextDiff(Uri.file('C:\\work\\other.vb') as never, current.document.uri as never) }] },
    ];
    await h.annotator.annotate(current.document as never);
    hooks.didChangeTabs.emit({ opened: [], closed: [], changed: [] });
    expect(contextValues().at(-1)).toBe(true);
    expect(listenerCount()).toBe(5);
  });

  it('leaves an unrelated open session alone when only its own tab closes', async () => {
    const other = editorFor(otherLocal('file.vb'), TEXTS[18659]);
    window.visibleTextEditors = [current.editor, other.editor];
    window.tabGroups.all = [
      { tabs: [{ input: new TabInputText(current.document.uri as never) }, { input: new TabInputText(other.document.uri as never) }] },
    ];
    const h = build();
    await h.annotator.annotate(current.document as never);
    await h.annotator.annotate(other.document as never);

    window.tabGroups.all = [{ tabs: [{ input: new TabInputText(other.document.uri as never) }] }]; // only A's tab closed
    hooks.didChangeTabs.emit({ opened: [], closed: [], changed: [] });

    expect(current.calls.at(-1)?.options).toEqual([]); // A hidden
    expect(other.calls.at(-1)?.options.length).toBeGreaterThan(0); // B untouched
    expect(listenerCount()).toBe(5); // B keeps the shared set alive
  });
});

describe('Annotator: D19e/D21 -- a reload from disk hides the session, judged at the debounce', () => {
  // D21: the OLD code hid the session the instant a not-dirty, reasonless
  // change arrived. But VS Code sends exactly that shape for the FIRST edit
  // of a clean document too (traced in 1.138: the main thread reads
  // `isDirty` before the text-file model marks itself dirty -- a SEPARATE
  // `{ contentChanges: [] }` event flips it moments later), and for
  // EncodingFixer re-decoding a just-opened document. The fix defers the
  // judgment to the existing REMAP_DEBOUNCE_MS timer, where the document's
  // settled state (dirty, or matching the base again) is actually known.
  it('hides and shows annotateReloaded once the debounce confirms the document is still not dirty and its text no longer matches the base', async () => {
    const h = build();
    await h.annotator.annotate(current.document as never);
    workspace.textDocuments = [current.document as never];
    vi.useFakeTimers();
    current.setDirty(false);
    current.setText(['a', 'b', 'c', 'd', 'e'].join('\n')); // differs from the base (a,b,c,d)
    hooks.didChangeTextDocument.emit({ document: current.document, contentChanges: [{}], reason: undefined });

    // Not judged yet -- only at the debounce.
    expect(recorder.shown).not.toContain(S.annotateReloaded('tillPOSReply.vb'));
    vi.advanceTimersByTime(REMAP_DEBOUNCE_MS);

    expect(recorder.shown).toContain(S.annotateReloaded('tillPOSReply.vb'));
    expect(contextValues().at(-1)).toBe(false);
    expect(current.calls.at(-1)?.options).toEqual([]);
  });

  // The real first-edit sequence: a content change reporting `isDirty` still
  // false and no reason, then a SEPARATE event (no content changes of its
  // own) once the model actually flips dirty. Must NOT hide.
  it('does not hide on the first edit of a clean document, even though the first event alone looks like a reload', async () => {
    const h = build();
    current.setDirty(false); // annotate a CLEAN document -- editorFor defaults isDirty true otherwise
    await h.annotator.annotate(current.document as never);
    workspace.textDocuments = [current.document as never];
    vi.useFakeTimers();

    current.setText(['a', 'NEW', 'b', 'c', 'd'].join('\n'));
    hooks.didChangeTextDocument.emit({ document: current.document, contentChanges: [{}], reason: undefined });
    current.setDirty(true);
    hooks.didChangeTextDocument.emit({ document: current.document, contentChanges: [] }); // the later dirty-flip event

    expect(recorder.shown).not.toContain(S.annotateReloaded('tillPOSReply.vb'));
    vi.advanceTimersByTime(REMAP_DEBOUNCE_MS);

    expect(recorder.shown).not.toContain(S.annotateReloaded('tillPOSReply.vb'));
    expect(contextValues().at(-1)).toBe(true);
    expect(current.labels()).toEqual(['18544 Boris', 'local', '18547 Filip', '18552 Boris', '18659 Boris']);
  });

  // A re-decode (EncodingFixer's own `openTextDocument(uri, { encoding })`)
  // or a TFVC Undo back to the workspace version: not dirty, no reason, but
  // the text still equals the base -- must NOT hide.
  it('does not hide when a not-dirty, reasonless change lands but the text still equals the base', async () => {
    const h = build();
    await h.annotator.annotate(current.document as never);
    workspace.textDocuments = [current.document as never];
    vi.useFakeTimers();
    const before = current.calls.length;

    current.setDirty(false); // text left as TEXTS[18659], same as session.baseLines
    hooks.didChangeTextDocument.emit({ document: current.document, contentChanges: [{}], reason: undefined });
    vi.advanceTimersByTime(REMAP_DEBOUNCE_MS);

    expect(recorder.shown).not.toContain(S.annotateReloaded('tillPOSReply.vb'));
    expect(contextValues().at(-1)).toBe(true);
    expect(current.calls.length).toBeGreaterThan(before); // rendered as usual, not hidden
  });

  it('does not treat a normal (dirty) edit as a reload', async () => {
    const h = build();
    await h.annotator.annotate(current.document as never);
    vi.useFakeTimers();
    current.setText(['a', 'NEW', 'b', 'c', 'd'].join('\n')); // editorFor defaults isDirty to true
    hooks.didChangeTextDocument.emit({ document: current.document, contentChanges: [{}] });
    vi.advanceTimersByTime(REMAP_DEBOUNCE_MS);

    expect(recorder.shown).not.toContain(S.annotateReloaded('tillPOSReply.vb'));
    expect(contextValues().at(-1)).toBe(true);
  });

  it('does not treat an undo as a reload, even though the document is no longer dirty', async () => {
    const h = build();
    await h.annotator.annotate(current.document as never);
    current.setDirty(false);
    vi.useFakeTimers();
    current.setText(['a', 'b', 'c'].join('\n'));
    hooks.didChangeTextDocument.emit({ document: current.document, contentChanges: [{}], reason: 1 }); // TextDocumentChangeReason.Undo
    vi.advanceTimersByTime(REMAP_DEBOUNCE_MS);

    expect(recorder.shown).not.toContain(S.annotateReloaded('tillPOSReply.vb'));
    expect(contextValues().at(-1)).toBe(true);
  });

  it('does nothing for a not-dirty, reasonless change on a document with no session', async () => {
    build();
    const other = editorFor(otherLocal('untouched.vb'), 'x');
    other.setDirty(false);
    hooks.didChangeTextDocument.emit({ document: other.document, contentChanges: [{}], reason: undefined });
    expect(recorder.messages).toEqual([]);
  });
});
