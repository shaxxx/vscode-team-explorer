import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A dedicated file, not folded into tfIgnore.test.ts: `vi.mock('node:fs', ...)`
 * is hoisted to the top of whichever file calls it and applies to EVERY test
 * in that file (see readOnlyWatcher.stats.test.ts for the same reasoning),
 * and tfIgnore.test.ts leans on real fs calls throughout its much larger
 * suite -- a single shared mock there would be a much larger blast radius for
 * one narrow case.
 */
const h = vi.hoisted(() => ({ failFor: undefined as string | undefined }));

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  return {
    ...real,
    statSync: (p: string, ...rest: unknown[]) => {
      if (h.failFor !== undefined && String(p) === h.failFor) {
        const err = new Error('EACCES: permission denied, stat ' + String(p)) as NodeJS.ErrnoException;
        err.code = 'EACCES';
        throw err;
      }
      return (real.statSync as (...a: unknown[]) => unknown)(p, ...rest);
    },
  };
});

import { findTfIgnore } from '../../src/ignore/readTfIgnore.js';

/**
 * Review item 5: `findTfIgnore`'s doc comment (and requirement 6 of the
 * original task) promise that a `.tfignore` that "cannot be read" resolves to
 * `undefined`, not to silently trying an ancestor's file instead -- but the
 * code caught EVERY `statSync` failure the same way, including EACCES/EPERM,
 * and treated all of them as "nothing here, keep walking up" (the correct
 * behaviour only for ENOENT). A permission error looks nothing like "this
 * directory has no .tfignore"; it looks like "there is one here and we are
 * not allowed to know what it says", and treating those the same silently
 * substitutes the wrong file's rules for the directory actually being asked
 * about.
 */
describe('findTfIgnore: only ENOENT continues the walk upward; any other stat failure means unreadable', () => {
  const dirs: string[] = [];
  function tempDir(prefix: string): string {
    const d = mkdtempSync(join(tmpdir(), prefix));
    dirs.push(d);
    return d;
  }

  beforeEach(() => {
    h.failFor = undefined;
  });
  afterEach(() => {
    h.failFor = undefined;
    while (dirs.length) {
      const d = dirs.pop()!;
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('does not fall through to an ancestor when statSync fails with EACCES, unlike a genuine ENOENT', () => {
    const parent = tempDir('tfignore-statfail-parent-');
    writeFileSync(join(parent, '.tfignore'), 'vendor\n', 'utf8');
    const child = join(parent, 'child');
    mkdirSync(child, { recursive: true });
    const candidate = join(child, '.tfignore');

    // Sanity: without the injected failure, the walk finds the parent's real
    // file -- proving the failure below is what changes the answer, not some
    // other difference between this test and the ordinary ancestor-walk ones.
    expect(findTfIgnore(child)).toBeDefined();

    h.failFor = candidate;
    expect(findTfIgnore(child)).toBeUndefined();
  });
});
