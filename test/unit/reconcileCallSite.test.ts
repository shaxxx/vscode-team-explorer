import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { codeOnly } from '../helpers/codeOnly.js';

// Not imported from checkinCallSite.test.ts: these are two independent
// static guards over the same source tree, and importing one test file from
// another would make a change to either one silently able to break the
// other's assumptions.
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return full.endsWith('.ts') ? [full] : [];
  });
}

describe('reconcile call site (S2 defence in depth)', () => {
  const files = sourceFiles(join(__dirname, '../../src'));

  it('the reconcile verb appears in code in exactly two files: the scan and its guard', () => {
    // Case-sensitive and lowercase on purpose: `reconcile` is the tf verb.
    // `parseReconcile` and similar identifiers are spelled with a capital R
    // and do not match. This is what keeps the guard from silently dropping
    // back to one file if TfClient.ts's own check is ever refactored away.
    //
    // If the refusal MESSAGE text moves into strings.ts, the expected list
    // below only grows to three: isReconcileMissingPreview still compares
    // against the literal 'reconcile' either way, so TfClient.ts can't drop
    // out of this list on its own.
    const withReconcile = files.filter((f) =>
      /\breconcile\b/.test(codeOnly(readFileSync(f, 'utf8'))),
    );

    expect(withReconcile.map((f) => f.replace(/\\/g, '/').split('/src/')[1]).sort())
      .toEqual(['scan/UnversionedScan.ts', 'tf/TfClient.ts']);
  });

  it("UnversionedScan.ts's reconcile call includes the literal '/preview'", () => {
    // /preview is what makes `tf vc reconcile /promote /adds` inert. This
    // does not prove the argument reaches tf in the right position — only
    // that the literal is present in the file's actual code, not merely
    // described in a comment above it.
    const source = codeOnly(
      readFileSync(join(__dirname, '../../src/scan/UnversionedScan.ts'), 'utf8'),
    );
    expect(source).toContain("'/preview'");
  });
});
