import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codeOnly } from '../helpers/codeOnly.js';
import { HistoryService } from '../../src/history/HistoryService.js';
import { VersionStore } from '../../src/history/VersionStore.js';

const ROOT = join(__dirname, '../..');

const PHASE2_SOURCES = [
  'src/tf/parseHistory.ts',
  'src/history/HistoryService.ts',
  'src/history/VersionStore.ts',
  'src/history/historyModel.ts',
  'src/ui/historyHtml.ts',
  'src/ui/HistoryView.ts',
  // D18j: the safety review's other reviewed surface -- it runs `vc view`/`vc
  // info` too (View, Compare with Latest), so the same verb/flag pins apply.
  'src/ui/ServerContentProvider.ts',
  'src/annotate/blame.ts',
  'src/annotate/remap.ts',
  'src/annotate/walk.ts',
  'src/annotate/margin.ts',
  'src/annotate/Annotator.ts',
  'src/commands/history.ts',
  'src/commands/annotate.ts',
];

/** The only tf verbs Phase 2 may spawn. */
const ALLOWED_VERBS = new Set(['history', 'view', 'info', 'get']);

/**
 * Never built by Phase 2. The first three would let `get` overwrite work; the
 * next two are how `tf changeset` rewrites history; the last two are the
 * wrapper's job alone (hard rule: the extension never constructs auth).
 */
const FORBIDDEN_FLAGS = ['/overwrite', '/force', '/all', '/comment', '/notes', '/login', '/noprompt'];

/**
 * D18j: a plain `/'vc',\s*'x'/` scan only ever caught a SINGLE-quoted argv
 * literal. The final review's own mutants -- `"vc", "undo"` in TypeScript,
 * `type: "details"` in the page script -- are both double-quoted and would
 * have sailed through unnoticed. Each side's quote is matched with its own
 * backreference (`\1`, `\2`) so `'vc", "x'` -- not valid JS -- is never
 * mistaken for a call; the two sides are free to use DIFFERENT quote
 * characters from each other, since `'vc', "history"` is valid JS too.
 *
 * D20g: the re-review's own mutant spelled the verb `"VC"` -- every real call
 * site in this codebase spells it lowercase, so a case-sensitive scan let a
 * differently-cased literal (nobody's typo today, but nothing stops one
 * tomorrow) straight through. The `i` flag only affects `vc` itself here:
 * `[A-Za-z]+` already matched either case.
 */
const VERB_CALL = /(['"`])vc\1\s*,\s*(['"`])([A-Za-z]+)\2/gi;
const CHANGESET_CALL = /(['"`])vc\1\s*,\s*(['"`])changeset\2/i;

/** Every `'vc', '<verb>'` argv literal named in `code`, whatever quotes it uses. */
function verbsFound(code: string): string[] {
  return [...code.matchAll(VERB_CALL)].map((m) => m[3]);
}

/** Every forbidden flag literal present in `code`, in any of the three quote styles. */
function flagsFound(code: string): string[] {
  const lower = code.toLowerCase();
  const quotes = ["'", '"', '`'];
  return FORBIDDEN_FLAGS.filter((flag) => quotes.some((q) => lower.includes(`${q}${flag}`)));
}

/**
 * Every `type: '<name>'` literal media/history.js could post, whatever quotes
 * it uses -- and D20g: whatever quotes the KEY `type` itself uses too, since
 * `{"type": "details"}` is exactly as postable as `{type: "details"}` and an
 * unquoted-key-only scan missed it outright (the two sides are independent:
 * `'type'` need not match the value's own quote character).
 */
function intentTypesFound(script: string): string[] {
  return [...script.matchAll(/(['"`])?type\1?\s*:\s*(['"`])([A-Za-z]+)\2/g)].map((m) => m[3]);
}

/**
 * D18j: `DOMParser` and `createContextualFragment` build a DOM/DocumentFragment
 * from a markup STRING exactly like `innerHTML` does -- a second route to the
 * same hazard the design already forbids, so the reviewer added them to the
 * sink list even though nothing here uses them today.
 */
const FORBIDDEN_SINKS = [
  'innerHTML',
  'outerHTML',
  'insertAdjacentHTML',
  'document.write',
  'eval(',
  'new Function',
  'srcdoc',
  'DOMParser',
  'createContextualFragment',
  // D20g: newer DOM APIs that parse a markup STRING exactly like `innerHTML`
  // does -- `Element.setHTMLUnsafe` and `Document.parseHTMLUnsafe` -- added
  // even though nothing here uses them today, same reasoning as the pair above.
  'setHTMLUnsafe',
  'parseHTMLUnsafe',
];

function sinksFound(script: string): string[] {
  return FORBIDDEN_SINKS.filter((sink) => script.includes(sink));
}

describe('phase 2 spawns only history, view, info and get', () => {
  it('names no other tf verb, and none of the forbidden flags, in its source', () => {
    for (const rel of PHASE2_SOURCES) {
      const code = codeOnly(readFileSync(join(ROOT, rel), 'utf8'));
      for (const verb of verbsFound(code)) {
        expect(ALLOWED_VERBS.has(verb), `${rel}: vc ${verb}`).toBe(true);
      }
      expect(flagsFound(code), rel).toEqual([]);
      // Narrowed from a bare /'changeset'/i scan (the task list's original
      // form): D16/D17 gave HistoryService a `changeset()` METHOD and Owner a
      // `'changeset'` discriminant `kind` (blame.ts, margin.ts, Annotator.ts),
      // plus `Pick<HistoryService, 'page' | 'changeset'>` in HistoryView.ts --
      // all legitimate identifiers/type tags, none of them a tf argv element.
      // What must never appear is the verb actually spawned next to 'vc', the
      // same shape every real call in this codebase uses (`['vc', 'history',
      // ...]` etc.), which is also exactly the forbidden shape `tf changeset`
      // (rewriting a changeset via /comment: or /notes:) would take.
      expect(CHANGESET_CALL.test(code), `${rel} spawns the changeset verb`).toBe(false);
    }
  });

  it('builds only allowed argv at run time, through every history and version path', async () => {
    const runs: string[][] = [];
    const client = {
      timeoutMs: 1,
      run: async (args: string[]) => {
        runs.push(args);
        return { stdout: Buffer.from(''), stderr: Buffer.alloc(0), exitCode: 0, timedOut: false };
      },
    };
    const history = new HistoryService(client);
    await history.page({ mode: 'file', itemspec: '$/A/b.vb' });
    await history.page({ mode: 'folder', itemspec: '$/A' }, { before: 10 });
    await history.all({ mode: 'file', itemspec: 'C:\\work\\A\\b.vb' }, { workspace: true });
    await history.changeset(5).catch(() => undefined);
    const store = new VersionStore(client, undefined);
    await store.textAt('$/A/b.vb', 3, () => store.codePageAt('$/A/b.vb', 3));

    expect(runs.length).toBeGreaterThanOrEqual(6);
    // D12: every page's itemspec is pinned, or a renamed file's history ends silently at the rename.
    for (const args of runs.filter((a) => a[1] === 'history' && a[2] !== '$/')) {
      expect(/;[TW]$/.test(args[2]), args.join(' ')).toBe(true);
    }
    for (const args of runs) {
      expect(args[0], args.join(' ')).toBe('vc');
      expect(ALLOWED_VERBS.has(args[1]), args.join(' ')).toBe(true);
      for (const flag of FORBIDDEN_FLAGS) {
        expect(args.some((a) => a.toLowerCase().startsWith(flag)), `${args.join(' ')}: ${flag}`).toBe(false);
      }
    }
  });
});

describe('the History tab never renders server text as HTML', () => {
  const script = readFileSync(join(ROOT, 'media/history.js'), 'utf8');

  it('uses no HTML-parsing sink and no dynamic code', () => {
    expect(sinksFound(script)).toEqual([]);
    expect(script).not.toMatch(/setAttribute\(\s*['"]on/i);
  });

  it('loads nothing remote', () => {
    expect(script).not.toMatch(/https?:\/\//);
  });

  it('can post only the intents the extension accepts', () => {
    const types = new Set(intentTypesFound(script));
    expect([...types].sort()).toEqual(['compare', 'getVersion', 'loadMore', 'ready', 'select', 'view']);
  });
});

/**
 * D18j: proves the scans above actually catch the final review's own
 * mutants, both double-quoted. Each mutant is applied to a SCRATCH copy --
 * never the real file on disk -- built from the real source text plus one
 * injected line, so the real sources under src/ and media/ are never touched.
 */
describe('D18j: the static scans catch a double-quoted mutant, not just a single-quoted one', () => {
  const scratchDirs: string[] = [];
  function scratchDir(): string {
    const d = mkdtempSync(join(tmpdir(), 'phase2-safety-mutant-'));
    scratchDirs.push(d);
    return d;
  }

  afterEach(() => {
    for (const d of scratchDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('flags a double-quoted `type: "details"` post added to a SCRATCH copy of media/history.js', () => {
    const real = readFileSync(join(ROOT, 'media/history.js'), 'utf8');
    // The mutant: a double-quoted post the OLD single-quote-only regex missed
    // entirely. 'details' is not in the allowlist either way, but the point
    // here is that the scan notices it is there AT ALL.
    const mutated = real.replace(
      "'use strict';",
      "'use strict';\n  post({ type: \"details\" }); // D18j mutant -- double-quoted, never in the allowlist",
    );
    const scratchFile = join(scratchDir(), 'history.mutant.js');
    writeFileSync(scratchFile, mutated);
    expect(mutated).not.toBe(real); // the mutant actually changed something
    const foundOnReal = intentTypesFound(readFileSync(join(ROOT, 'media/history.js'), 'utf8'));
    const foundOnMutant = intentTypesFound(readFileSync(scratchFile, 'utf8'));
    expect(foundOnReal).not.toContain('details'); // the real file is clean
    expect(foundOnMutant).toContain('details'); // the scratch mutant is caught
  });

  it('flags a double-quoted `"vc", "undo"` call added to a SCRATCH copy of commands/history.ts', () => {
    const real = readFileSync(join(ROOT, 'src/commands/history.ts'), 'utf8');
    // The mutant: a double-quoted argv literal for a verb this file has no
    // business spawning (`undo` is not in ALLOWED_VERBS). Kept syntactically
    // valid TypeScript so `codeOnly`'s real parse does not choke on it.
    const mutated = real.replace(
      'export interface HistoryDeps {',
      [
        '// D18j mutant -- double-quoted, never a verb this file may spawn',
        'function phase2SafetyMutant(client: { run(a: string[]): unknown }): unknown {',
        '  return client.run(["vc", "undo"]);',
        '}',
        '',
        'export interface HistoryDeps {',
      ].join('\n'),
    );
    const scratchFile = join(scratchDir(), 'history.commands.mutant.ts');
    writeFileSync(scratchFile, mutated);
    expect(mutated).not.toBe(real);
    const foundOnReal = verbsFound(codeOnly(readFileSync(join(ROOT, 'src/commands/history.ts'), 'utf8')));
    const foundOnMutant = verbsFound(codeOnly(readFileSync(scratchFile, 'utf8')));
    expect(foundOnReal).not.toContain('undo'); // the real file is clean
    expect(foundOnMutant).toContain('undo'); // the scratch mutant is caught
    expect(ALLOWED_VERBS.has('undo')).toBe(false); // and it would fail the real check
  });
});

/** D20g: three more scan gaps found in the re-review of D18. */
describe('D20g: the static scans also catch a case-differing verb, a quoted `"type":` key, and the *Unsafe DOM sinks', () => {
  const scratchDirs: string[] = [];
  function scratchDir(): string {
    const d = mkdtempSync(join(tmpdir(), 'phase2-safety-mutant-'));
    scratchDirs.push(d);
    return d;
  }

  afterEach(() => {
    for (const d of scratchDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('flags `"VC", "undo"` even though the real code always spells it lowercase', () => {
    const real = readFileSync(join(ROOT, 'src/commands/history.ts'), 'utf8');
    const mutated = real.replace(
      'export interface HistoryDeps {',
      [
        '// D20g mutant -- a case-differing verb literal, never a verb this file may spawn',
        'function phase2SafetyMutantCase(client: { run(a: string[]): unknown }): unknown {',
        '  return client.run(["VC", "undo"]);',
        '}',
        '',
        'export interface HistoryDeps {',
      ].join('\n'),
    );
    const scratchFile = join(scratchDir(), 'history.commands.case.mutant.ts');
    writeFileSync(scratchFile, mutated);
    expect(mutated).not.toBe(real);
    const foundOnReal = verbsFound(codeOnly(readFileSync(join(ROOT, 'src/commands/history.ts'), 'utf8')));
    const foundOnMutant = verbsFound(codeOnly(readFileSync(scratchFile, 'utf8')));
    expect(foundOnReal).not.toContain('undo');
    expect(foundOnMutant.map((v) => v.toLowerCase())).toContain('undo');
  });

  it('flags a fully-quoted `{"type": "details"}` post -- not just an unquoted key -- on a SCRATCH copy of media/history.js', () => {
    const real = readFileSync(join(ROOT, 'media/history.js'), 'utf8');
    const mutated = real.replace(
      "'use strict';",
      "'use strict';\n  post({\"type\": \"details\"}); // D20g mutant -- the KEY is quoted too, never in the allowlist",
    );
    const scratchFile = join(scratchDir(), 'history.quotedkey.mutant.js');
    writeFileSync(scratchFile, mutated);
    expect(mutated).not.toBe(real);
    const foundOnReal = intentTypesFound(readFileSync(join(ROOT, 'media/history.js'), 'utf8'));
    const foundOnMutant = intentTypesFound(readFileSync(scratchFile, 'utf8'));
    expect(foundOnReal).not.toContain('details');
    expect(foundOnMutant).toContain('details');
  });

  it('flags `setHTMLUnsafe` and `parseHTMLUnsafe` as HTML-parsing sinks, not just `innerHTML`', () => {
    const real = readFileSync(join(ROOT, 'media/history.js'), 'utf8');
    const mutated = real.replace(
      "'use strict';",
      "'use strict';\n  // D20g mutant -- app.setHTMLUnsafe(evilMarkup);\n  void app.setHTMLUnsafe;",
    );
    const scratchFile = join(scratchDir(), 'history.unsafehtml.mutant.js');
    writeFileSync(scratchFile, mutated);
    expect(mutated).not.toBe(real);
    expect(sinksFound(real)).toEqual([]);
    expect(sinksFound(mutated)).toContain('setHTMLUnsafe');
  });
});
