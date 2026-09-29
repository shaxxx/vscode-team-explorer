import { describe, it, expect } from 'vitest';
import { codeOnly } from '../helpers/codeOnly.js';

describe('codeOnly (string-aware comment stripping)', () => {
  it('does not let a glob string swallow the code that follows it', () => {
    // The exact shape that broke the naive regex stripper (see
    // src/watch/ReadOnlyWatcher.ts's '**/*'): the two characters `/*` occur
    // inside an ordinary string, and a `/\/\*[\s\S]*?\*\//` regex reads that
    // as the START of a block comment. It then searches non-greedily for the
    // next literal `*/` anywhere later in the file to close it -- which a
    // real file the size of ReadOnlyWatcher.ts always has (a later doc
    // comment), so everything in between, including real code, vanishes.
    // A source with no LATER `*/` at all does not reproduce this: the naive
    // regex simply fails to match, which is why a real doc comment is
    // included below.
    const source = [
      "const pattern = '**/*';",
      "function realCode() { return 'reconcile'; }",
      '/** a later, unrelated doc comment */',
      "const after = 'checkin';",
    ].join('\n');

    const stripped = codeOnly(source);

    expect(stripped).toContain("'**/*'");
    expect(stripped).toContain('realCode');
    expect(stripped).toContain("'reconcile'");
    expect(stripped).toContain("'checkin'");
  });

  it('removes // line comments', () => {
    const stripped = codeOnly('const x = 1; // checkin\nconst y = 2;');
    expect(stripped).not.toContain('checkin');
    expect(stripped).toContain('const x = 1;');
    expect(stripped).toContain('const y = 2;');
  });

  it('removes /* block */ comments', () => {
    const stripped = codeOnly('/* reconcile */ const x = 1;');
    expect(stripped).not.toContain('reconcile');
    expect(stripped).toContain('const x = 1;');
  });

  it('does not let a template literal with a substitution swallow a later comment', () => {
    // A template literal WITH a `${...}` substitution is not one token. The
    // raw scanner, with no parser driving it, does not know that the literal's
    // own closing backtick continues the SAME template -- it reads that
    // backtick as the START of a brand new one, which then runs until the
    // next backtick anywhere later in the file, silently absorbing whatever
    // comment (or code) sits in between as if it were template text.
    const source = [
      'const s = `a${b}c`;',
      '// checkin should still be removed',
      "const t = 'reconcile stays';",
    ].join('\n');

    const stripped = codeOnly(source);

    expect(stripped).not.toContain('checkin');
    expect(stripped).toContain("const t = 'reconcile stays';");
  });

  it('does not let a regex containing / or * swallow a later doc comment', () => {
    // A raw scanner has no parser telling it that a `/` here starts a regex
    // rather than division, so it reads the `/*` inside `/[./*-]+/` (the
    // exact shape of the pattern in test/unit/packaging.test.ts) as a block
    // comment start and hides everything up to the next `*/` -- a later doc
    // comment, in a real file -- exactly like the glob-string bug above, but
    // via a regex literal instead of a string.
    const source = [
      'const ok = /[./*-]+/.test(x);',
      'function hidden() { return "reconcile"; }',
      '/** doc */',
    ].join('\n');

    const stripped = codeOnly(source);

    expect(stripped).toContain('/[./*-]+/');
    expect(stripped).toContain('reconcile');
    expect(stripped).not.toContain('doc');
  });

  it('does not let a regex containing a slash swallow the rest of its own line', () => {
    // `replace(/\//g, '\\')` (the exact shape in src/tf/PathMapper.ts and
    // src/scan/ScanResult.ts): a raw scanner reads the escaped `/` inside the
    // character class as closing the "division", then the very next `/`
    // (before `g`) as opening a `//` line comment, deleting the rest of the
    // line -- including code on the SAME line, not just a later one.
    const source = "const x = s.replace(/\\//g, '\\\\'); const y = 'reconcile';";

    const stripped = codeOnly(source);

    expect(stripped).toContain('replace(/\\//g');
    expect(stripped).toContain("'reconcile'");
  });

  it('does not mistake a backtick inside a regex for a template literal', () => {
    const source = "const r = /`/.test(x); const y = 'reconcile';";

    const stripped = codeOnly(source);

    expect(stripped).toContain('/`/');
    expect(stripped).toContain("'reconcile'");
  });
});
