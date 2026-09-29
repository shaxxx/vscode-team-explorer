import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { codeOnly } from '../helpers/codeOnly.js';

const ROOT = join(__dirname, '../..');
const SOURCES = [
  'src/tf/parseDir.ts',
  'src/tf/parseGet.ts',
  'src/workspace/mappingRules.ts',
  'src/workspace/WorkspaceService.ts',
  'src/commands/workspace.ts',
  'src/ui/workspaceUi.ts',
];

/** The only tf verbs part 1 may spawn. */
const ALLOWED_VERBS = new Set(['workspaces', 'workspace', 'workfold', 'dir', 'get']);
/** W7 and the wrapper's own job. `/delete` covers `workspace /delete`; `/location:local` a local workspace (W6). */
const FORBIDDEN_FLAGS = ['/delete', '/force', '/overwrite', '/all', '/login', '/noprompt', '/comment', '/location:local', '/cloak'];
const VERB_CALL = /(['"`])vc\1\s*,\s*(['"`])([A-Za-z]+)\2/gi;

const code = (rel: string) => codeOnly(readFileSync(join(ROOT, rel), 'utf8'));

describe('phase 3 part 1 spawns only workspaces, workspace, workfold, dir and get', () => {
  it('every listed source exists', () => {
    for (const rel of SOURCES) {
      expect(existsSync(join(ROOT, rel)), `expected ${rel} to exist`).toBe(true);
    }
  });

  it('names no other verb and no forbidden flag', () => {
    for (const rel of SOURCES) {
      const c = code(rel);
      const verbs = [...c.matchAll(VERB_CALL)].map((m) => m[3].toLowerCase());
      expect(verbs.filter((v) => !ALLOWED_VERBS.has(v)), rel).toEqual([]);
      const lower = c.toLowerCase();
      expect(
        FORBIDDEN_FLAGS.filter((f) => ["'", '"', '`'].some((q) => lower.includes(`${q}${f}`))),
        rel,
      ).toEqual([]);
    }
  });

  it('never names checkin anywhere in its code', () => {
    for (const rel of SOURCES) expect(code(rel).toLowerCase().includes('checkin'), rel).toBe(false);
  });

  it('never deletes files or folders', () => {
    for (const rel of SOURCES) {
      const c = code(rel);
      // Word boundary before `rm(`: `d.ui.confirm(` contains the literal
      // substring `rm(` (...co-`nfi`-`rm(`) and must not be misread as a
      // delete call. `\b` requires a word boundary just before `r`, which
      // `confirm(` does not have (the preceding `i` is a word character) but
      // a bare `rm(<expr>)` call does.
      for (const call of [/rmSync/, /rmdirSync/, /unlinkSync/, /\brm\(/, /unlink\(/]) {
        expect(call.test(c), `${rel}: ${call}`).toBe(false);
      }
    }
  });
});
