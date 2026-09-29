import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { GLYPHS, excluded, type Glyph } from '../../src/ui/decorations.js';
import { DEFAULT_IGNORE } from '../../src/ignore/IgnoreMatcher.js';

/**
 * `src/ui/decorations.ts` names ThemeColor ids that package.json has to
 * contribute, and `DecorationProvider.ts` reads a setting package.json has to
 * declare. Neither side notices the other drifting: an unregistered
 * ThemeColor id does not throw (see test below), and an uncontributed
 * setting just returns the code's own fallback default forever. All 411
 * tests elsewhere in this suite stay green either way, which is the whole
 * reason this file exists - see Task 6 in the plan.
 */

const ROOT = join(__dirname, '../..');

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
  contributes: {
    colors?: { id: string; description: string; defaults: Record<string, string> }[];
    configuration: { properties: Record<string, { default?: unknown }> };
    menus?: Record<string, { command: string; when: string; group?: string }[]>;
  };
};

const drawn = Object.values(GLYPHS).filter((g): g is Glyph => g !== null);

describe('decoration colours', () => {
  const contributedColorIds = new Set((pkg.contributes.colors ?? []).map((c) => c.id));

  // GLYPHS is the STATIC table, but `excluded()` produces a colour at
  // runtime that appears in no table entry -- every drawn glyph can be
  // dimmed, so the set of colours actually reachable is GLYPHS's own colours
  // plus whatever `excluded()` maps each of them to.
  const used = new Set([...drawn.map((g) => g.color), ...drawn.map((g) => excluded(g).color)]);

  it('every colour GLYPHS or excluded() uses is contributed', () => {
    // An unregistered ThemeColor id does not throw - VS Code just falls back
    // to the default foreground colour. The badge still renders, in the
    // wrong colour, with no error anywhere: a typo here is invisible without
    // this test.
    for (const id of used) {
      expect(contributedColorIds.has(id), `${id} is used by a glyph but not contributed in package.json`).toBe(true);
    }
  });

  it('every contributed colour is used by some glyph', () => {
    // The reverse direction: a colour left behind by a removed or renamed
    // state lingers in the user's theme-customisation UI forever, offering
    // to recolour a badge nothing draws any more. `used` already includes the
    // excluded variant (see above) -- built from a table AND a function, not
    // from the static table alone -- so a colour that is only ever produced by
    // `excluded()` still counts as used, rather than reading as dead code.
    for (const id of contributedColorIds) {
      expect(used.has(id), `${id} is contributed but no glyph uses it`).toBe(true);
    }
  });

  it('contributes exactly the six colours the glyph table and excluded() use today', () => {
    // Pins the count too, so a seventh colour added to one side without the
    // other cannot pass the two tests above by coincidence (e.g. both sides
    // drifting to the same wrong number). Five come straight from GLYPHS;
    // `excluded()` maps every glyph to the SAME dimmed colour regardless of
    // its own, so it contributes exactly one more, not five.
    expect(contributedColorIds.size).toBe(6);
    expect(used.size).toBe(6);
  });
});

/**
 * Every `.ts` file under src/, so the scan below cannot be fooled by moving a
 * read into a new file.
 */
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) {
      walk(abs, out);
    } else if (entry.endsWith('.ts')) {
      out.push(abs);
    }
  }
  return out;
}

/**
 * Every `teamExplorer.<key>` the code actually reads.
 *
 * Two shapes appear in this codebase and both are matched:
 *
 *   - chained straight off the call, possibly across lines (DecorationProvider.ts,
 *     and the autoCheckout reader in extension.ts):
 *       vscode.workspace
 *         .getConfiguration('teamExplorer')
 *         .get<boolean>('decorations', true)
 *
 *   - read later through a variable the call was assigned to (extension.ts):
 *       const config = vscode.workspace.getConfiguration('teamExplorer');
 *       ...
 *       config.get<string>('wrapperPath')
 */
function teamExplorerKeysRead(): string[] {
  const keys: string[] = [];

  for (const file of walk(join(ROOT, 'src'))) {
    const source = readFileSync(file, 'utf8');

    for (const m of source.matchAll(
      /getConfiguration\('teamExplorer'\)\s*\.get<[^>]*>\(\s*'([^']+)'/g,
    )) {
      keys.push(m[1]);
    }

    for (const bind of source.matchAll(
      /(?:const|let)\s+(\w+)\s*=\s*vscode\.workspace\.getConfiguration\('teamExplorer'\)/g,
    )) {
      const varName = bind[1];
      const getCall = new RegExp(`\\b${varName}\\.get<[^>]*>\\(\\s*'([^']+)'`, 'g');
      for (const m of source.matchAll(getCall)) keys.push(m[1]);
    }
  }

  return keys;
}

describe('teamExplorer settings', () => {
  const reads = teamExplorerKeysRead();
  const distinctKeys = [...new Set(reads)];

  it('actually found some reads - a broken regex would make this whole file vacuous', () => {
    expect(reads.length).toBeGreaterThan(0);
    // wrapperPath, commandTimeoutMs, collectionUrl (all via extension.ts's
    // `config` variable), autoCheckout and decorations (both chained
    // directly) - measured against today's source.
    expect(distinctKeys.length).toBeGreaterThanOrEqual(5);
  });

  it('every setting the code reads is contributed', () => {
    // Reading an uncontributed setting is not an error: WorkspaceConfiguration
    // just returns the code's own fallback, so the feature keeps working and
    // the setting simply never appears in the Settings UI - untyped, so a
    // user who finds it anyway and types "false" as a string gets `true`.
    const properties = pkg.contributes.configuration.properties;
    for (const key of distinctKeys) {
      expect(
        Object.prototype.hasOwnProperty.call(properties, `teamExplorer.${key}`),
        `teamExplorer.${key} is read by the code but not contributed in package.json`,
      ).toBe(true);
    }
  });
});

describe('teamExplorer.decorations', () => {
  it('the contributed default agrees with the code\'s fallback', () => {
    const decorationProviderSource = readFileSync(
      join(ROOT, 'src/ui/DecorationProvider.ts'),
      'utf8',
    );
    // Extracted from the source rather than hard-coded, so this test cannot
    // pass by asserting `true === true` regardless of what either side says.
    const fallbackMatch = decorationProviderSource.match(
      /\.get<boolean>\('decorations',\s*(true|false)\)/,
    );
    expect(fallbackMatch, 'could not find the decorations fallback in DecorationProvider.ts').not.toBeNull();
    const codeFallback = fallbackMatch![1] === 'true';

    const contributed = pkg.contributes.configuration.properties['teamExplorer.decorations'];
    expect(contributed, 'teamExplorer.decorations is not contributed').toBeDefined();

    // Pinned both ways: change either the manifest default or the code's
    // fallback alone, and this fails.
    expect(contributed.default).toBe(codeFallback);
  });
});

describe('teamExplorer.ignore', () => {
  it("the contributed default is exactly DEFAULT_IGNORE, in order", () => {
    // Two lists that must agree and are edited in different files is how they
    // drift. If package.json's default is short of the code's, a user who has
    // never opened Settings gets the code's list, and one who has ever
    // toggled the setting gets package.json's -- silently scanning 6,950
    // node_modules folders, or not skipping the `nul` files that make the
    // whole scan exit 100.
    expect(pkg.contributes.configuration.properties['teamExplorer.ignore']?.default).toEqual([
      ...DEFAULT_IGNORE,
    ]);
  });

  it('is contributed as an array of strings, so the Settings UI can edit it', () => {
    const prop = pkg.contributes.configuration.properties['teamExplorer.ignore'] as
      | { type?: string; items?: { type?: string } }
      | undefined;
    expect(prop?.type).toBe('array');
    expect(prop?.items?.type).toBe('string');
  });

  it('contributes teamExplorer.scanForNewFiles, defaulting to on', () => {
    // The off switch for the whole feature. Off by default would mean nobody
    // ever sees it; the scan is background and never blocks activation.
    expect(
      pkg.contributes.configuration.properties['teamExplorer.scanForNewFiles']?.default,
    ).toBe(true);
  });

  it('contributes teamExplorer.showNotInSourceControl, defaulting to OFF', () => {
    // Matches Visual Studio's Pending Changes, which lists no such group. The
    // manifest default is what real VS Code uses -- ScmProvider's own
    // code-side fallback (`get('showNotInSourceControl', false)`) is not
    // enough on its own: a mismatch here would only show up in the Settings
    // UI, never in a test that only drives the code path.
    expect(
      pkg.contributes.configuration.properties['teamExplorer.showNotInSourceControl']?.default,
    ).toBe(false);
  });
});

/**
 * Task 6 (U5): an untracked row -- a file with no pending change at all --
 * used to offer Undo (which opens a "cannot be undone" modal and then a tf
 * error on something tf never pended), Checkout and Compare with Latest
 * (nothing to compare against). None of those apply to a row in the
 * "Not in source control" group, so every menu entry for those three
 * commands must exclude that group. Exclude/Include are untouched: they are
 * how a row LEAVES the untracked group's territory in the first place
 * (moving a pending change between Included/Excluded), and neither ever
 * targets `notInSourceControl` to begin with.
 */
const PENDING_STATES = ['checkedOut', 'pendingAdd', 'pendingDelete', 'pendingRename'];

/**
 * Turns a `when` clause from the two SCM menus into a predicate over one
 * row's group and contextValue (`undefined` for a folder node, which has
 * none). Knows only the clause shapes package.json uses and throws on any
 * other, so a new shape must be taught here rather than silently counted as
 * a match. Parsing happens when this is called, so calling it on every entry
 * up front checks every clause, not just those before the first match.
 */
function parseWhen(when: string | undefined): (group: string, state: string | undefined) => boolean {
  const tests = (when ?? '').split(' && ').map((clause): ((g: string, s: string | undefined) => boolean) => {
    if (clause === 'scmProvider == teamExplorer') return () => true;
    const parts = clause.split(' ');
    // A clause with a fourth token, e.g. an `||`-joined pair VS Code's `when`
    // syntax genuinely allows, would otherwise silently parse as its own
    // first three tokens instead of failing -- exactly the shape this
    // function's own doc comment already promises never to guess at.
    if (parts.length !== 3) throw new Error(`unrecognised when clause: ${clause}`);
    const [key, op, value] = parts;
    if (key === 'scmResourceGroup' && op === '==') return (g) => g === value;
    if (key === 'scmResourceGroup' && op === '!=') return (g) => g !== value;
    if (key === 'scmResourceState' && op === '==') return (_g, s) => s === value;
    if (key === 'scmResourceState' && op === '=~' && value.startsWith('/^(') && value.endsWith(')$/')) {
      const allowed = value.slice(3, -3).split('|');
      return (_g, s) => s !== undefined && allowed.includes(s);
    }
    throw new Error(`unrecognised when clause: ${clause}`);
  });
  return (group, state) => tests.every((t) => t(group, state));
}

describe('scm/resourceState/context gating for untracked rows', () => {
  const entries = pkg.contributes.menus?.['scm/resourceState/context'] ?? [];

  function entryFor(command: string, group: string) {
    const found = entries.filter((e) => e.command === command && e.group === group);
    expect(found, `expected exactly one ${command} entry in group ${group}`).toHaveLength(1);
    return found[0];
  }

  it('offers Undo on every pending row, and Check Out and Compare only where they can work', () => {
    const expected: [string, string, string][] = [
      ['teamExplorer.undo', 'inline@2', 'scmProvider == teamExplorer && scmResourceGroup != notInSourceControl'],
      ['teamExplorer.undo', '1_modification@3', 'scmProvider == teamExplorer && scmResourceGroup != notInSourceControl'],
      // A rename leaves the file read-only: Check Out is what makes it editable.
      ['teamExplorer.checkout', '1_modification@2', 'scmProvider == teamExplorer && scmResourceState == pendingRename'],
      // A pending Add has no server version, a pending Delete no local file,
      // and a rename's new name has none until check-in.
      [
        'teamExplorer.compareWithLatest',
        '1_modification@1',
        'scmProvider == teamExplorer && scmResourceState == checkedOut',
      ],
    ];
    for (const [command, group, when] of expected) {
      expect(entryFor(command, group).when, `${command} (${group})`).toBe(when);
    }
  });

  it('leaves the Exclude and Include entries exactly as they were', () => {
    const untouched: [string, string, string][] = [
      ['teamExplorer.exclude', 'inline@1', 'included'],
      ['teamExplorer.exclude', '2_exclude@1', 'included'],
      ['teamExplorer.include', 'inline@1', 'excluded'],
      ['teamExplorer.include', '2_exclude@1', 'excluded'],
    ];
    for (const [command, group, resourceGroup] of untouched) {
      const when = entryFor(command, group).when;
      expect(when, `${command} (${group})`).toBe(
        `scmProvider == teamExplorer && scmResourceGroup == ${resourceGroup}`,
      );
    }
  });

  it('offers Add on an untracked row, inline and in the right-click menu, and nowhere else', () => {
    const adds = entries.filter((e) => e.command === 'teamExplorer.add');
    expect(adds.map((e) => e.group).sort()).toEqual(['1_modification@1', 'inline@1']);
    for (const e of adds) {
      expect(e.when).toBe('scmProvider == teamExplorer && scmResourceGroup == notInSourceControl');
    }
  });

  /**
   * Acceptance item 41 failed on this: VS Code reuses row widgets and only
   * resets a row's inline icons when that row's menu has at least one entry.
   * So every KIND of row -- each group, with each contextValue it can carry --
   * needs one.
   */
  it("gives every kind of row at least one entry, so no row inherits another row's icons", () => {
    const rows: [string, string][] = [
      ...['included', 'excluded'].flatMap((g) => PENDING_STATES.map((s): [string, string] => [g, s])),
      ['notInSourceControl', 'untracked'],
      ['conflicts', 'conflict'],
    ];
    const parsed = entries.map((e) => parseWhen(e.when));
    for (const [group, state] of rows) {
      expect(parsed.some((applies) => applies(group, state)), `${group} / ${state}`).toBe(true);
    }
  });
});

describe('the excluded() tooltip suffix (Task 6, U8)', () => {
  it('decorations.ts sources it from strings.ts rather than a local literal', () => {
    const source = readFileSync(join(ROOT, 'src/ui/decorations.ts'), 'utf8');
    expect(source).not.toContain('(excluded from check-in)');
    expect(source).toContain('S.excludedTooltipSuffix');
  });
});

describe("scm/resourceFolder/context: folder nodes in the panel's tree view (plan 3)", () => {
  const folderEntries = pkg.contributes.menus?.['scm/resourceFolder/context'] ?? [];

  it("gives every group's folder nodes at least one entry, so none inherits a stray icon", () => {
    const parsed = folderEntries.map((e) => parseWhen(e.when));
    for (const group of ['included', 'excluded', 'notInSourceControl']) {
      expect(parsed.some((applies) => applies(group, undefined)), group).toBe(true);
    }
  });

  it('puts nothing inline: one click on a folder node must never act on every row under it', () => {
    expect(folderEntries.filter((e) => e.group?.startsWith('inline'))).toEqual([]);
  });

  it('offers only the actions that move rows between groups, never Undo, Check Out or Compare', () => {
    expect(new Set(folderEntries.map((e) => e.command))).toEqual(
      new Set(['teamExplorer.add', 'teamExplorer.exclude', 'teamExplorer.include']),
    );
  });
});
