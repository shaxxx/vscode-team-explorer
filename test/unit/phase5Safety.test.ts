import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { codeOnly } from '../helpers/codeOnly.js';
import { AUTO_RESOLUTIONS } from '../../src/conflicts/resolveArgs.js';
import { parseConflictIntent } from '../../src/conflicts/conflictModel.js';

const ROOT = join(__dirname, '../..');
const NEW_FILES = [
  'src/tf/parseResolve.ts',
  'src/conflicts/resolveArgs.ts',
  'src/conflicts/conflictModel.ts',
  'src/conflicts/ConflictService.ts',
  'src/conflicts/afterGet.ts',
  'src/commands/conflicts.ts',
  'src/ui/ConflictsView.ts',
];
const code = (rel: string) => codeOnly(readFileSync(join(ROOT, rel), 'utf8'));
// tf takes a command name in any case, as TfClient's guard does.
const VERB_CALL = /(['"`])vc\1\s*,\s*(['"`])([A-Za-z]+)\2/gi;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return full.endsWith('.ts') ? [full] : [];
  });
}
const rel = (f: string) => f.replace(/\\/g, '/').split('/src/')[1];
const SRC = sourceFiles(join(ROOT, 'src'));

describe('phase 5 safety', () => {
  it('every listed file exists', () => {
    for (const f of NEW_FILES) expect(existsSync(join(ROOT, f)), f).toBe(true);
  });

  it('spawns resolve from resolveArgs.ts and nowhere else in src', () => {
    const spawning = SRC.filter((f) => [...codeOnly(readFileSync(f, 'utf8')).matchAll(VERB_CALL)].some((m) => m[3].toLowerCase() === 'resolve'));
    expect(spawning.map(rel)).toEqual(['conflicts/resolveArgs.ts']);
  });

  it("names 'resolve' as a string only in resolveArgs.ts and TfClient's guard", () => {
    const naming = SRC.filter((f) => /(['"`])resolve\1/i.test(codeOnly(readFileSync(f, 'utf8'))));
    expect(naming.map(rel).sort()).toEqual(['conflicts/resolveArgs.ts', 'tf/TfClient.ts']);
  });

  it('builds /auto: only in resolveArgs.ts and the guard', () => {
    const naming = SRC.filter((f) => /\/auto:/i.test(codeOnly(readFileSync(f, 'utf8'))));
    expect(naming.map(rel).sort()).toEqual(['conflicts/resolveArgs.ts', 'tf/TfClient.ts']);
  });

  it('the new files spawn nothing but resolve and info', () => {
    for (const f of NEW_FILES) {
      for (const m of code(f).matchAll(VERB_CALL)) expect(['resolve', 'info'], `${f}: vc ${m[3]}`).toContain(m[3].toLowerCase());
    }
  });

  it('offers only the four resolutions, and names none of the others anywhere', () => {
    expect([...AUTO_RESOLUTIONS]).toEqual(['AutoMerge', 'TakeTheirs', 'KeepYours', 'OverwriteLocal']);
    for (const f of [...NEW_FILES, 'media/conflicts.js']) {
      const c = f.endsWith('.js') ? readFileSync(join(ROOT, f), 'utf8') : code(f);
      for (const word of ['AutoMergeForced', 'DeleteConflict', 'KeepYoursRenameTheirs', '/newname', '/overridetype', '/converttotype', '/properties']) {
        expect(c.includes(word), `${f} names ${word}`).toBe(false);
      }
    }
  });

  it('never names check-in, in any spelling', () => {
    for (const f of NEW_FILES) expect(code(f), f).not.toMatch(/check-?in/i);
    expect(readFileSync(join(ROOT, 'media/conflicts.js'), 'utf8')).not.toMatch(/check-?in/i);
  });

  it('deletes and writes nothing on disk itself, and starts no process of its own', () => {
    for (const f of NEW_FILES) {
      const c = code(f);
      expect(c, f).not.toMatch(/\b(rmSync|unlinkSync|rmdirSync|writeFileSync|renameSync|chmodSync)\b/);
      expect(c, f).not.toMatch(/child_process/);
      // No file-system access at all, sync or async: none of these files needs any.
      expect(c, f).not.toMatch(/from\s+['"](node:)?fs(\/promises)?['"]|require\(\s*['"](node:)?fs/);
      expect(c, f).not.toMatch(/\bWorkspaceEdit\b|workspace\.fs\./);
    }
  });
});

describe('the Resolve Conflicts page never renders tf text as HTML', () => {
  const script = readFileSync(join(ROOT, 'media/conflicts.js'), 'utf8');

  it('uses no HTML-parsing sink and no dynamic code', () => {
    for (const sink of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function', 'srcdoc', 'DOMParser', 'createContextualFragment', 'setHTMLUnsafe', 'parseHTMLUnsafe']) {
      expect(script.includes(sink), sink).toBe(false);
    }
    expect(script).not.toMatch(/setAttribute\(\s*['"]on/i);
  });

  it('loads nothing remote', () => {
    expect(script).not.toMatch(/https?:\/\//);
  });

  it('can post only the intents the extension accepts', () => {
    const types = [...new Set([...script.matchAll(/(['"`])?type\1?\s*:\s*(['"`])([A-Za-z]+)\2/g)].map((m) => m[3]))].sort();
    expect(types).toEqual(['act', 'autoMergeAll', 'ready', 'refresh', 'select']);
    for (const type of types) {
      expect(parseConflictIntent({ type, key: 'k', action: 'compare' }), type).toBeDefined();
    }
  });
});
