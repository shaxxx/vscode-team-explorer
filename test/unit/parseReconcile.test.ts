import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseReconcile } from '../../src/tf/parseReconcile.js';

const fixture = (name: string) =>
  readFileSync(join(__dirname, '../fixtures/windows', name), 'utf8');

describe('a scan run from ABOVE the root', () => {
  // reconcile-adds.txt: OPS, cwd C:\work. 33 headers, 88 adds, 32 blanks
  // (88 + 33 + 32 = 153 = wc -l; the final block has no trailing blank line).
  const out = parseReconcile(fixture('reconcile-adds.txt'));

  it('finds every Pending add line, and nothing else', () => {
    expect(out.items).toHaveLength(88);
  });

  it('joins each item to the header above it, with forward slashes', () => {
    // tf emits backslashes even under Wine; the caller resolves these against
    // the cwd, so they come back platform-neutral.
    expect(out.items[0]).toBe('OPS/OPS2013/Inventory/Connected Services');
  });

  it('keeps a name that contains a space', () => {
    // `Connected Services`. A split on whitespace would eat this.
    expect(out.items.filter((p) => p.endsWith('/Connected Services'))).toHaveLength(1);
  });

  it('carries the last header, not the first', () => {
    expect(out.items[out.items.length - 1]).toBe('OPS/OPS2023/Hospitality/FodyWeavers.xsd');
  });

  it('collects every distinct folder header, relative and forward-slashed', () => {
    expect(out.headers).toHaveLength(33);
    expect(out.headers).toContain('OPS/OPS2013/Inventory');
    expect(out.headers).toContain('OPS/OPS2023/docs/planning/plans');
  });

  it('is a real capture, so it has no problems', () => {
    expect(out.problems).toEqual([]);
  });
});

describe('a scan run from the root ITSELF, where there is no header', () => {
  // reconcile-cwd-is-root.txt: Personnel, cwd C:\work\Personnel. The root's own
  // items are emitted with NO header line above them. Dropping those would
  // discard every new file in the workspace root.
  const out = parseReconcile(fixture('reconcile-cwd-is-root.txt'));

  it('keeps the items that have no header at all', () => {
    expect(out.items).toContain('Personnel.Data');
    expect(out.items).toContain('Personnel.Model');
    expect(out.items).toContain('Customers');
    expect(out.items).toContain('Nexus');
  });

  it('finds all nine items across both shapes', () => {
    expect(out.items).toHaveLength(9);
  });

  it('still nests the items that DO have a header', () => {
    expect(out.items).toContain('Customers/Customers2020');
    expect(out.items).toContain('Customers/Customers2020/Customers.Data');
    expect(out.items).toContain('Nexus/Nexus.Client');
  });

  it('lists a directory both as a root item and as the header it opens', () => {
    // `Customers` is a directory, not a naming coincidence: it is listed as a
    // root-level add, and the very next block opens `Customers:` as a header
    // over its own contents. Both the directory entry and everything nested
    // under it must survive; neither may swallow the other.
    expect(out.items).toContain('Customers');
    expect(out.items.filter((p) => p.startsWith('Customers/'))).toHaveLength(3);
  });

  it('collects the three distinct headers', () => {
    expect(out.headers).toEqual(['Customers', 'Customers/Customers2020', 'Nexus']);
  });

  it('is a real capture, so it has no problems', () => {
    expect(out.problems).toEqual([]);
  });
});

describe('a /noignore capture with a nested header (finding 19)', () => {
  const out = parseReconcile(fixture('reconcile-noignore-vspscc.txt'));

  it('parses the one item under its one header', () => {
    expect(out.items).toEqual([
      'CardGatewayTool/CardGatewayTool/CardGatewayTool.csproj.vspscc',
    ]);
    expect(out.headers).toEqual(['CardGatewayTool/CardGatewayTool']);
    expect(out.problems).toEqual([]);
  });
});

describe('a Pending edit line (finding 27): a writable, edited, versioned file', () => {
  // reconcile-pending-edit.txt: a real capture, one file made writable and
  // edited with no checkout pended. `Pending edit:` is a DIFFERENT verb from
  // `Pending add:` -- tf saying the item IS versioned and differs locally,
  // not that it is new.
  const out = parseReconcile(fixture('reconcile-pending-edit.txt'));

  it('is not a problem', () => {
    expect(out.problems).toEqual([]);
  });

  it('is not reported as a new (unversioned) item', () => {
    expect(out.items).toEqual([]);
  });

  it('is reported in editedItems instead, folder-prefixed like an item would be', () => {
    expect(out.editedItems).toEqual(['src/DemoShop/Models/Product.cs']);
  });

  it('still records the header above it', () => {
    expect(out.headers).toEqual(['src/DemoShop/Models']);
  });
});

describe('an unknown Pending verb still makes the scan distrust the listing', () => {
  // Pins the conservative default that parseReconcile's own doc comment and
  // README finding 27 promise: only `add` and `edit` are recognised verbs,
  // because no real capture has ever shown `reconcile` emit `Pending delete:`
  // (or any other `Pending <verb>:`). Nothing else in this file catches a
  // regex widened to `/^Pending [a-z]+: (.+)$/` -- every other test here uses
  // only `add` and `edit`, so that widening would pass them all and silently
  // start trusting a shape nobody has ever seen tf print.
  it('reports Pending delete as exactly one problem, not an item or an editedItem', () => {
    const out = parseReconcile('src:\r\nPending delete: x.cs\r\n');
    expect(out.problems).toHaveLength(1);
    expect(out.items).toEqual([]);
    expect(out.editedItems).toEqual([]);
  });
});

describe('a Pending edit line mixed with a real Pending add in the same block (synthetic)', () => {
  // Not a capture -- no real listing combining both verbs has been seen --
  // but this is exactly what UnversionedScan needs to be true: a Pending edit
  // line must not cause a real add elsewhere in the same output to be lost.
  const input =
    'DemoShop\\Models:\r\nPending edit: Product.cs\r\nPending add: NewFile.cs\r\n';
  const out = parseReconcile(input);

  it('keeps the real add as an item', () => {
    expect(out.items).toEqual(['DemoShop/Models/NewFile.cs']);
  });

  it('keeps the edit out of items, in editedItems', () => {
    expect(out.editedItems).toEqual(['DemoShop/Models/Product.cs']);
  });

  it('raises no problem', () => {
    expect(out.problems).toEqual([]);
  });
});

describe('the results that are not listings', () => {
  it('reads an empty scan as empty, not as an error', () => {
    // `No matching changes found to pend.` is exit 0 and means nothing to do.
    const out = parseReconcile(fixture('reconcile-empty.txt'));
    expect(out.items).toEqual([]);
    expect(out.headers).toEqual([]);
    expect(out.problems).toEqual([]);
  });

  it('flags an exit-100 error line as a problem rather than silently dropping it', () => {
    // reconcile-exit100.txt is what the CALLER must never hand over (see the
    // doc comment) -- the exit code is checked first. This pins what happens
    // if that guard is ever bypassed: the single error line matches none of
    // "Pending add:", a header, or the empty-result sentinel, so it is a
    // problem rather than a silent empty list.
    const out = parseReconcile(fixture('reconcile-exit100.txt'));
    expect(out.items).toEqual([]);
    expect(out.problems).toHaveLength(1);
    expect(out.problems[0]).toContain('There is no working folder mapping for \\\\.\\nul.');
  });

  it('survives an empty string', () => {
    const out = parseReconcile('');
    expect(out.items).toEqual([]);
    expect(out.headers).toEqual([]);
    expect(out.problems).toEqual([]);
  });

  it('a foreign line ending in a colon is still read as a header, not flagged a problem', () => {
    // Known limitation, not a defense here: the header regex cannot tell a
    // real folder header from any other line that happens to end in `:`, so
    // "The following items could not be reconciled:" is read as a header and
    // silently re-roots the item after it. Closing this is the caller's job
    // (UnversionedScan checks every header names a real directory), not
    // parseReconcile's -- this header is neither absolute nor has a `..`
    // component, so it is not a problem on its own.
    const input =
      'A:\r\nPending add: one\r\n\r\n' +
      'The following items could not be reconciled:\r\nPending add: two\r\n';
    const out = parseReconcile(input);
    expect(out.items).toEqual(['A/one', 'The following items could not be reconciled/two']);
    expect(out.headers).toEqual(['A', 'The following items could not be reconciled']);
    expect(out.problems).toEqual([]);
  });
});

describe('problem kinds', () => {
  it('flags an absolute header with a drive letter', () => {
    const out = parseReconcile('C:\\work:\r\nPending add: one\r\n');
    expect(out.problems).toHaveLength(1);
    expect(out.problems[0]).toContain('C:/work');
  });

  it('flags an absolute header with a leading backslash (UNC-shaped)', () => {
    const out = parseReconcile('\\\\server\\share:\r\nPending add: one\r\n');
    expect(out.problems).toHaveLength(1);
  });

  it('flags an absolute header with a leading forward slash', () => {
    const out = parseReconcile('/etc/foo:\r\nPending add: one\r\n');
    expect(out.problems).toHaveLength(1);
  });

  it('flags a header with a .. component', () => {
    const out = parseReconcile('Foo\\..\\Bar:\r\nPending add: one\r\n');
    expect(out.problems).toHaveLength(1);
    expect(out.problems[0]).toContain('Foo/../Bar');
  });

  it('flags an item name containing a colon', () => {
    const out = parseReconcile('Pending add: weird:name.txt\r\n');
    expect(out.problems).toHaveLength(1);
    expect(out.problems[0]).toContain('weird:name.txt');
    // Still recorded as an item -- problems are reported, not silently dropped.
    expect(out.items).toEqual(['weird:name.txt']);
  });

  it('flags an item name with a .. component', () => {
    const out = parseReconcile('Pending add: ..\r\n');
    expect(out.problems).toHaveLength(1);
  });

  it('flags an EDITED item name containing a colon, the same as an added one', () => {
    const out = parseReconcile('Pending edit: weird:name.txt\r\n');
    expect(out.problems).toHaveLength(1);
    expect(out.problems[0]).toContain('weird:name.txt');
    // Still recorded, in editedItems -- not items, and not silently dropped.
    expect(out.editedItems).toEqual(['weird:name.txt']);
    expect(out.items).toEqual([]);
  });

  it('flags an EDITED item name with a .. component, the same as an added one', () => {
    const out = parseReconcile('Pending edit: ..\r\n');
    expect(out.problems).toHaveLength(1);
  });

  it('flags an unrecognised non-blank line that is not an add, a header, or the empty sentinel', () => {
    const out = parseReconcile('Warning: something tf never printed before\r\n');
    expect(out.problems).toEqual([
      'unrecognised line: Warning: something tf never printed before',
    ]);
    expect(out.items).toEqual([]);
    expect(out.headers).toEqual([]);
  });

  it('accumulates more than one problem', () => {
    const out = parseReconcile(
      'C:\\work:\r\nPending add: bad:name\r\nGarbage line\r\n',
    );
    expect(out.problems).toHaveLength(3);
  });

  it('collapses a header seen twice into one entry in headers', () => {
    const out = parseReconcile(
      'Foo:\r\nPending add: a\r\n\r\nFoo:\r\nPending add: b\r\n',
    );
    expect(out.headers).toEqual(['Foo']);
    expect(out.items).toEqual(['Foo/a', 'Foo/b']);
  });
});
