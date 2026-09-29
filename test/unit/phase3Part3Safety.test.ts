import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { codeOnly } from '../helpers/codeOnly.js';

const ROOT = join(__dirname, '../..');
const NEW_FILES = [
  'src/fileops/FileOpsService.ts',
  'src/fileops/renamePlan.ts',
  'src/commands/fileOps.ts',
];
const code = (rel: string) => codeOnly(readFileSync(join(ROOT, rel), 'utf8'));
const VERB_CALL = /(['"`])vc\1\s*,\s*(['"`])([A-Za-z]+)\2/g;

describe('phase 3 part 3 safety', () => {
  it('every listed file exists', () => {
    for (const rel of NEW_FILES) expect(existsSync(join(ROOT, rel)), rel).toBe(true);
  });

  it('names rename and delete in FileOpsService and nowhere else', () => {
    const verbs = [...code('src/fileops/FileOpsService.ts').matchAll(VERB_CALL)].map((m) => m[3]);
    expect(verbs.sort()).toEqual(['delete', 'rename']);
    for (const rel of NEW_FILES.filter((r) => !r.endsWith('FileOpsService.ts'))) {
      expect([...code(rel).matchAll(VERB_CALL)], rel).toHaveLength(0);
    }
  });

  it('never names check-in, in any spelling', () => {
    for (const rel of NEW_FILES) expect(code(rel), rel).not.toMatch(/check-?in/i);
  });

  it('passes no forbidden flag', () => {
    const forbidden = ['/force', '/recursive', '/destroy', '/lock', '/noprompt', '/login', '/comment'];
    for (const rel of NEW_FILES) {
      const c = code(rel).toLowerCase();
      for (const flag of forbidden) {
        expect(c.includes(`'${flag}`) || c.includes(`"${flag}`), `${rel} passes ${flag}`).toBe(false);
      }
    }
  });

  it('deletes nothing from disk itself: tf owns that', () => {
    // The ONE disk operation this part performs is renameSync, putting an item
    // back so tf can redo the move. Removing a file is tf's job.
    for (const rel of NEW_FILES) {
      expect(code(rel), rel).not.toMatch(/\b(rmSync|unlinkSync|rmdirSync|rm\(|unlink\(|rmdir\()/);
      expect(code(rel), rel).not.toMatch(/workspace\.fs\.delete/);
    }
  });

  it('imports only READ-ONLY helpers from node:fs, plus renameSync, and never child_process', () => {
    // The forbidden-flag and no-disk-deletion pins above read by NAME, which a
    // `rmSync as existsSync` import alias -- or a plain `require('child_process')`
    // spawning `rm` itself -- would slip past. This checks the IMPORTED name,
    // not whatever local name it is aliased to, and refuses `child_process`
    // outright: nothing in this part ever needs a subprocess of its own, tf is
    // reached only through FileOpsService's `client.run`.
    const FS_NAMED_IMPORT = /import\s*\{([^}]*)\}\s*from\s*(['"])(?:node:)?fs\2/g;
    // Everything here either only READS the disk (`existsSync`, `statSync`,
    // `readdirSync`, and `Dirent` for its result type) or is `renameSync`, the
    // one write this part performs -- putting an item back so tf can redo the
    // move. `readdirSync` was added for the folder rule in `wasVersioned`
    // (acceptance item 4): a folder's own read-only bit says nothing, so the
    // evidence is the read-only FILES inside it. Nothing that removes or
    // writes may ever join this set.
    const ALLOWED_FS_IMPORTS = new Set(['existsSync', 'renameSync', 'statSync', 'readdirSync', 'Dirent']);
    for (const rel of NEW_FILES) {
      const c = code(rel);
      for (const m of c.matchAll(FS_NAMED_IMPORT)) {
        const names = m[1]
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
          .map((s) => s.split(/\s+as\s+/)[0].trim())
          // `import { type Dirent }` is still an import of `Dirent`.
          .map((s) => s.replace(/^type\s+/, ''));
        for (const name of names) {
          expect(ALLOWED_FS_IMPORTS.has(name), `${rel} imports ${name} from node:fs`).toBe(true);
        }
      }
      expect(c, rel).not.toMatch(/child_process/);
    }
  });

  it('asks before deleting, modally', () => {
    const c = code('src/commands/fileOps.ts');
    expect(c).toMatch(/modal:\s*true/);
    expect(c).toMatch(/fileOpsDeleteYes/);
  });
});
