import * as ts from 'typescript';

/**
 * Strips comments from TypeScript source using a REAL parse, not a
 * hand-rolled scanner loop -- a raw scanner has no parser telling it when a
 * `/` starts a regular expression rather than division, so it reads `//` or
 * `/*` inside a regex literal as a comment. Measured against this
 * codebase: `/^!?[A-Za-z0-9_./*-]+$/` in test/unit/packaging.test.ts opens a
 * block comment at its own `/*` and hides 13 real lines, and
 * `replace(/\//g, '\\')` in src/tf/PathMapper.ts and src/scan/ScanResult.ts
 * loses the rest of its line to a fake `//` comment. A full parse resolves
 * `/` the same way a real compiler does, so a regex is a REGEX, not a
 * mis-scanned comment start.
 *
 * `ts.createSourceFile` builds the AST; every node's own leading and
 * trailing trivia (collected via `getLeadingCommentRanges` /
 * `getTrailingCommentRanges`, exactly where the compiler itself looks for
 * them) is gathered into a map keyed by start position, so a comment
 * reachable from two adjacent nodes' trivia is not double-counted. The
 * result is the original source with those ranges cut out -- not a
 * re-print of the parsed tree, so nothing else about the text changes.
 */
export function codeOnly(source: string): string {
  const sourceFile = ts.createSourceFile('x.ts', source, ts.ScriptTarget.Latest, /* setParentNodes */ true);
  const ranges = new Map<number, ts.CommentRange>();

  function collect(node: ts.Node): void {
    for (const range of ts.getLeadingCommentRanges(source, node.getFullStart()) ?? []) {
      ranges.set(range.pos, range);
    }
    for (const range of ts.getTrailingCommentRanges(source, node.getEnd()) ?? []) {
      ranges.set(range.pos, range);
    }
    for (const child of node.getChildren(sourceFile)) collect(child);
  }
  collect(sourceFile);

  const sorted = [...ranges.values()].sort((a, b) => a.pos - b.pos);
  let out = '';
  let cursor = 0;
  for (const range of sorted) {
    out += source.slice(cursor, range.pos);
    cursor = Math.max(cursor, range.end);
  }
  out += source.slice(cursor);
  return out;
}
