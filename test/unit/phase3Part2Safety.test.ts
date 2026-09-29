import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { codeOnly } from '../helpers/codeOnly.js';
import { parseExplorerIntent } from '../../src/explorer/explorerModel.js';

const ROOT = join(__dirname, '../..');
const SOURCES = [
  'src/tf/parseInfo.ts',
  'src/tf/streamedGet.ts',
  'src/explorer/getVersion.ts',
  'src/explorer/explorerModel.ts',
  'src/explorer/ExplorerService.ts',
  'src/ui/SourceControlExplorer.ts',
  'src/commands/showInExplorer.ts',
];
const PAGE = 'media/explorer.js';

/** The verbs part 2's own files may spawn (checkout, undo, add, history, view come through the reused commands). */
const ALLOWED_VERBS = new Set(['dir', 'info', 'status', 'get', 'workspaces']);
const FORBIDDEN_FLAGS = ['/force', '/delete', '/cloak', '/decloak', '/remove', '/login', '/noprompt', '/comment', '/location:local', '/lock'];
const VERB_CALL = /(['"`])vc\1\s*,\s*(['"`])([A-Za-z]+)\2/gi;
const code = (rel: string) => codeOnly(readFileSync(join(ROOT, rel), 'utf8'));

describe('phase 3 part 2 safety', () => {
  it('every listed file exists', () => {
    for (const rel of [...SOURCES, PAGE]) expect(existsSync(join(ROOT, rel)), rel).toBe(true);
  });

  it('spawns only dir, info, status, get and workspaces', () => {
    const seen = new Set<string>();
    for (const rel of SOURCES) {
      for (const m of code(rel).matchAll(VERB_CALL)) {
        const verb = m[3].toLowerCase();
        seen.add(verb);
        expect(ALLOWED_VERBS.has(verb), `${rel} spawns vc ${verb}`).toBe(true);
      }
    }
    // The scan itself must be finding something, or it proves nothing.
    expect([...seen].sort()).toEqual(['dir', 'get', 'info', 'status', 'workspaces']);
  });

  it('never names check-in, in any spelling', () => {
    // `lastCheckIn` is the grid's own sort key / field name for TFVC's read-only
    // "Last Check-in" date column (explorerModel.ts, explorer.js) -- a display
    // value sourced from `info`'s lastModified, not an invocation of the
    // check-in verb. Stripped by exact token match so the pin still catches any
    // real "checkin"/"check-in" spelling elsewhere.
    const withoutColumnName = (s: string) => s.replace(/lastCheckIn/gi, '');
    for (const rel of [...SOURCES, PAGE]) expect(withoutColumnName(code(rel)), rel).not.toMatch(/check-?in/i);
  });

  it('passes no forbidden flag anywhere', () => {
    for (const rel of SOURCES) {
      const c = code(rel).toLowerCase();
      for (const flag of FORBIDDEN_FLAGS) expect(c.includes(`'${flag}`) || c.includes(`"${flag}`), `${rel} passes ${flag}`).toBe(false);
    }
  });

  it('keeps /overwrite and /all inside getVersion.ts', () => {
    for (const rel of SOURCES.filter((r) => r !== 'src/explorer/getVersion.ts')) {
      expect(code(rel), rel).not.toMatch(/['"`]\/(overwrite|all)['"`]/);
    }
    expect(code('src/explorer/getVersion.ts')).toMatch(/'\/overwrite'/);
  });

  it('deletes nothing on disk', () => {
    for (const rel of SOURCES) expect(code(rel), rel).not.toMatch(/\b(rmSync|unlinkSync|rmdirSync|unlink|rmdir)\s*\(|\brm\(|fs\.delete|workspace\.fs\.delete/);
  });

  it('the page never parses text as HTML', () => {
    expect(code(PAGE)).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  });

  it('the page posts only intents the extension accepts', () => {
    const types = [...code(PAGE).matchAll(/\btype:\s*'([A-Za-z]+)'/g)].map((m) => m[1]);
    expect(types.length).toBeGreaterThan(5);
    const accepted = new Set(['ready', 'refresh', 'closeDialog', 'navigate', 'toggle', 'sort', 'select', 'action', 'submitDialog', 'pickChangeset']);
    for (const t of types) expect(accepted.has(t), `the page posts ${t}`).toBe(true);
    // And each one really parses, with a minimal valid body.
    expect(parseExplorerIntent({ type: 'toggle', path: '$/' })).toBeDefined();
  });
});
