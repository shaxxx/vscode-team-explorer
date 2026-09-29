import { describe, it, expect, vi } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { codeOnly } from '../helpers/codeOnly.js';
import { ShelveService } from '../../src/shelve/ShelveService.js';
import { parseShelvesetsIntent } from '../../src/shelve/shelvesetsModel.js';

const ROOT = join(__dirname, '../..');
const NEW_FILES = [
  'src/tf/parseShelvesets.ts',
  'src/shelve/shelveRules.ts',
  'src/shelve/shelvesetsModel.ts',
  'src/shelve/ShelveService.ts',
  'src/commands/shelve.ts',
  'src/ui/ShelvesetsView.ts',
];
const PAGE = 'media/shelvesets.js';
const SERVICE = 'src/shelve/ShelveService.ts';
const code = (rel: string) => codeOnly(readFileSync(join(ROOT, rel), 'utf8'));
const VERB_CALL = /(['"`])vc\1\s*,\s*(['"`])([A-Za-z]+)\2/gi;

/**
 * Every .ts file under src/, walked recursively the way checkinCallSite.test.ts's
 * `sourceFiles` does -- NEW_FILES alone only watches the files this task
 * touched, so a `vc`, `unshelve`/`shelve`/`shelvesets` call (or a bare
 * `/move`) added to an EXISTING file outside that list, e.g. src/commands/index.ts,
 * passed every pin above this one (coordinator review, Task 9).
 */
function allSourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return allSourceFiles(full);
    return full.endsWith('.ts') ? [full] : [];
  });
}
const relOf = (full: string) => full.slice(ROOT.length + 1).replace(/\\/g, '/');
const SRC_FILES = allSourceFiles(join(ROOT, 'src')).map(relOf).sort();

describe('phase 4 safety', () => {
  it('every listed file exists', () => {
    for (const rel of [...NEW_FILES, PAGE]) expect(existsSync(join(ROOT, rel)), rel).toBe(true);
  });

  it('names shelve, unshelve and shelvesets in ShelveService and nowhere else, beside only status and view', () => {
    const verbs = [...new Set([...code(SERVICE).matchAll(VERB_CALL)].map((m) => m[3].toLowerCase()))].sort();
    expect(verbs).toEqual(['shelve', 'shelvesets', 'status', 'unshelve', 'view']);
    for (const rel of NEW_FILES.filter((r) => r !== SERVICE)) {
      expect([...code(rel).matchAll(VERB_CALL)].map((m) => m[3]), rel).toEqual([]);
    }
  });

  it('names shelve, unshelve or shelvesets nowhere in the whole of src except ShelveService.ts', () => {
    const named = SRC_FILES.filter((rel) =>
      [...code(rel).matchAll(VERB_CALL)].some((m) => ['shelve', 'unshelve', 'shelvesets'].includes(m[3].toLowerCase())),
    );
    expect(named).toEqual([SERVICE]);
  });

  it("passes the literal '/move' nowhere in the whole of src except ShelveService.ts", () => {
    const withMove = SRC_FILES.filter((rel) => /(['"`])\/move\1/i.test(code(rel)));
    expect(withMove).toEqual([SERVICE]);
  });

  it("never names resolve: that verb is phase 5's", () => {
    for (const rel of [...NEW_FILES, PAGE]) expect(code(rel), rel).not.toMatch(/(['"`])resolve\1/i);
  });

  it("never registers phase 5's resolveConflicts: a stub would read as 0 conflicts and let the delete run", () => {
    for (const rel of [...NEW_FILES, 'src/extension.ts']) {
      expect(code(rel), rel).not.toMatch(/registerCommand\(\s*(['"`])teamExplorer\.resolveConflicts\1/);
    }
  });

  it('never names check-in, in any spelling', () => {
    for (const rel of [...NEW_FILES, PAGE]) expect(code(rel), rel).not.toMatch(/check-?in/i);
  });

  it('passes no forbidden flag, and /comment and /recursive only from ShelveService', () => {
    const everywhere = ['/force', '/overwrite', '/all', '/noprompt', '/login', '/nomerge', '/noautoresolve', '/destroy', '/lock'];
    for (const rel of NEW_FILES) {
      const c = code(rel).toLowerCase();
      for (const flag of everywhere) expect(c.includes(`'${flag}`) || c.includes(`"${flag}`) || c.includes(`\`${flag}`), `${rel} passes ${flag}`).toBe(false);
      if (rel === SERVICE) continue;
      for (const flag of ['/comment', '/recursive', '/replace', '/move', '/delete', '/owner', '/shelveset']) {
        expect(c.includes(`'${flag}`) || c.includes(`"${flag}`) || c.includes(`\`${flag}`), `${rel} passes ${flag}`).toBe(false);
      }
    }
  });

  it('deletes nothing from disk itself, and spawns nothing of its own', () => {
    for (const rel of NEW_FILES) {
      const c = code(rel);
      expect(c, rel).not.toMatch(/\b(rmSync|unlinkSync|rmdirSync|writeFileSync|renameSync)\b|\brm\(|\bunlink\(|\brmdir\(|workspace\.fs\.delete/);
      expect(c, rel).not.toMatch(/child_process/);
    }
  });

  it('builds only the allowed argv, whatever it is asked, at run time', async () => {
    const runs: string[][] = [];
    const client = {
      timeoutMs: 1,
      run: vi.fn(async (args: string[]) => {
        runs.push(args);
        return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0, timedOut: false };
      }),
    };
    const s = new ShelveService(client, 'https://example/');
    await s.list('');
    await s.list('*');
    await s.exists('x');
    await s.contents('x', 'o');
    await s.view('x', 'o', '$/a.txt');
    await s.pendingIn(['$/a.txt']);

    // Each of the four (replace, move) combinations, checked against its OWN
    // exact argv right after the call. A filter over the whole `runs` array
    // AFTERWARDS cannot tell "this call asked for /replace" from "that call
    // asked for /move": swapping the two conditions in ShelveService.shelve
    // (coordinator review, Task 9 follow-up) produces the very same two argv
    // SHAPES, just from the other calls, so a filter-based count or an
    // unordered toEqual still passes. Only checking each request's own
    // outcome, immediately, catches the swap.
    await s.shelve({ name: 'x', paths: ['C:\\a.txt'], replace: false, move: false });
    expect(runs.at(-1)).toEqual(['vc', 'shelve', 'x', 'C:\\a.txt']);
    await s.shelve({ name: 'x', paths: ['C:\\a.txt'], replace: true, move: false });
    expect(runs.at(-1)).toEqual(['vc', 'shelve', '/replace', 'x', 'C:\\a.txt']);
    await s.shelve({ name: 'x', paths: ['C:\\a.txt'], replace: false, move: true });
    expect(runs.at(-1)).toEqual(['vc', 'shelve', '/move', 'x', 'C:\\a.txt']);
    await s.shelve({ name: 'x', paths: ['C:\\a.txt'], commentPath: 'C:\\c.txt', replace: true, move: true });
    expect(runs.at(-1)).toEqual(['vc', 'shelve', '/replace', '/move', 'x', 'C:\\a.txt', '/comment:@C:\\c.txt']);

    await s.unshelve({ name: 'x', ownerUnique: 'o' });
    await s.unshelve({ name: 'x', ownerUnique: 'o', items: ['$/a.txt'] });
    await s.deleteOwn('x');

    // 2 lists + exists + contents + view + pendingIn + 4 shelves + 2 unshelves + deleteOwn.
    expect(runs).toHaveLength(13);
    const ALLOWED_VERBS = new Set(['shelve', 'shelvesets', 'status', 'unshelve', 'view']);
    for (const args of runs) {
      expect(args[0], args.join(' ')).toBe('vc');
      expect(ALLOWED_VERBS.has(args[1]), args.join(' ')).toBe(true);
    }
    // A shelve always names at least one item, except /delete, which names exactly one shelveset and no owner.
    for (const args of runs.filter((a) => a[1] === 'shelve')) {
      if (args.includes('/delete')) {
        expect(args).toEqual(['vc', 'shelve', '/delete', 'x']);
      } else {
        expect(args.filter((a) => !a.startsWith('/') && a !== 'vc' && a !== 'shelve' && a !== 'x').length, args.join(' ')).toBeGreaterThan(0);
      }
    }
    // A leading '-' is a switch to tf exactly like a leading '/' (S9's own
    // wording), so a mutation writing '-move' instead of '/move' must be
    // caught here too, not just the literal spelling.
    const normalizeSwitch = (a: string) => (a.startsWith('-') ? `/${a.slice(1)}` : a);
    for (const args of runs.filter((a) => a[1] === 'unshelve')) {
      expect(args.some((a) => ['/move', '/nomerge', '/noautoresolve'].includes(normalizeSwitch(a).toLowerCase())), args.join(' ')).toBe(false);
    }
  });

  it('confirms a replace and a delete modally', () => {
    const shelve = code('src/commands/shelve.ts');
    expect(shelve).toMatch(/shelveReplaceYes/);
    expect(shelve).toMatch(/modal:\s*true/);
    const view = code('src/ui/ShelvesetsView.ts');
    expect(view).toMatch(/shelvesetDeleteYes/);
    expect(view).toMatch(/modal:\s*true/);
  });

  it('the page never parses text as HTML', () => {
    expect(code(PAGE)).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|DOMParser|createContextualFragment|setHTMLUnsafe|eval\(|new Function/);
  });

  it('the page posts only intents the extension accepts', () => {
    const types = [...code(PAGE).matchAll(/(['"`])?type\1?\s*:\s*(['"`])([A-Za-z]+)\2/g)].map((m) => m[3]);
    expect(new Set(types)).toEqual(new Set(['ready', 'find', 'refresh', 'select', 'delete', 'tick', 'file', 'preserve', 'unshelve']));
    const minimal: Record<string, Record<string, unknown>> = {
      ready: {},
      refresh: {},
      unshelve: {},
      find: { owner: 'x' },
      select: { key: 'a;b' },
      delete: { key: 'a;b' },
      tick: { paths: ['$/a'], ticked: true },
      preserve: { value: true },
      file: { action: 'viewShelved', path: '$/a' },
    };
    for (const t of types) expect(parseShelvesetsIntent({ type: t, ...minimal[t] }), t).toBeDefined();
  });
});
