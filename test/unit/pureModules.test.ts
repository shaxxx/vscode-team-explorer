import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { codeOnly } from '../helpers/codeOnly.js';

/**
 * The architecture invariant in CLAUDE.md: only TfClient.ts knows `tf`
 * exists, only PathMapper.ts knows Wine exists, and everything reachable
 * from these modules is meant to be unit-testable with no workspace and no
 * `vscode` module at all. Nothing enforced that promise before this test
 * (S8) -- vitest.config.ts aliases `vscode` to a mock for every test file,
 * so an accidental `import type { X } from 'vscode'` in one of these files
 * would compile, run, and pass every existing test in the suite without
 * anyone noticing the boundary had been crossed.
 */
const PURE_MODULES = [
  'tf/TfClient.ts',
  'tf/PathMapper.ts',
  'tf/parse.ts',
  'tf/strings.ts',
  'tf/wrapperPath.ts',
  'tf/parseReconcile.ts',
  'tf/streamedGet.ts',
  'ignore/IgnoreMatcher.ts',
  'ignore/readTfIgnore.ts',
  'fileops/renamePlan.ts',
  'scan/ScanResult.ts',
  'state/FileState.ts',
  'paths/relativeToRoot.ts',
  'tf/parseHistory.ts',
  'history/HistoryService.ts',
  'history/VersionStore.ts',
  'history/historyModel.ts',
  'ui/historyHtml.ts',
  'annotate/blame.ts',
  'annotate/remap.ts',
  'annotate/walk.ts',
  'annotate/margin.ts',
  'tf/parseDir.ts',
  'tf/parseGet.ts',
  'tf/parseInfo.ts',
  'workspace/mappingRules.ts',
  'workspace/WorkspaceService.ts',
  'explorer/ExplorerService.ts',
  'commands/workspace.ts',
  'explorer/getVersion.ts',
  'explorer/explorerModel.ts',
  'fileops/FileOpsService.ts',
  'tf/parseShelvesets.ts',
  'shelve/shelveRules.ts',
  'shelve/shelvesetsModel.ts',
  'shelve/ShelveService.ts',
  'tf/parseResolve.ts',
  'conflicts/resolveArgs.ts',
  'conflicts/conflictModel.ts',
];

const SRC_ROOT = join(__dirname, '../../src');

/**
 * The relative import specifiers this file's CODE contains -- `'./x.js'` /
 * `'../y.js'` -- in any of the forms IMPORTS_VSCODE below also watches for:
 * `from '...'`, the bare side-effect `import '...'`, dynamic `import('...')`
 * and `require('...')`. A pure module reaching another one through any form
 * but the first would otherwise fall outside the closure this test follows.
 */
function relativeImports(code: string): string[] {
  const specifiers: string[] = [];
  const pattern =
    /\bfrom\s+['"](\.[^'"]+)['"]|\bimport\s*\(\s*['"](\.[^'"]+)['"]|\brequire\(\s*['"](\.[^'"]+)['"]|\bimport\s+['"](\.[^'"]+)['"]/g;
  for (let m = pattern.exec(code); m; m = pattern.exec(code)) {
    specifiers.push((m[1] ?? m[2] ?? m[3] ?? m[4])!);
  }
  return specifiers;
}

/**
 * Every file reached from `entryPoints` by following relative imports
 * transitively, resolving a `./x.js` specifier to the `.ts` source it
 * actually refers to. Checking only the listed modules and not what they
 * import missed `tf/types.ts` entirely -- imported by PathMapper, parse and
 * FileState, but never checked on its own, so a `vscode` import placed there
 * would have compiled, run and passed every test in the suite.
 */
function closure(entryPoints: readonly string[]): string[] {
  const visited = new Set<string>();
  const stack = entryPoints.map((rel) => join(SRC_ROOT, rel));

  while (stack.length > 0) {
    const full = stack.pop()!;
    if (visited.has(full)) continue;
    visited.add(full);
    if (!existsSync(full)) continue; // reported by the `it` below instead of dropped here

    const code = codeOnly(readFileSync(full, 'utf8'));
    for (const specifier of relativeImports(code)) {
      stack.push(resolve(dirname(full), specifier).replace(/\.js$/, '.ts'));
    }
  }
  return [...visited];
}

// `from 'vscode'` / `from "vscode"` (any named or type-only import form),
// `import('vscode')` / `import ('vscode')` (dynamic, whitespace before the
// parenthesis allowed), `require('vscode')`, and the bare side-effect form
// `import 'vscode';` (no `from`, no parens).
const IMPORTS_VSCODE =
  /\bfrom\s+['"]vscode['"]|\bimport\s*\(\s*['"]vscode['"]|\brequire\(\s*['"]vscode['"]|\bimport\s+['"]vscode['"]/;

describe('pure modules stay free of vscode (S8)', () => {
  for (const full of closure(PURE_MODULES)) {
    const rel = full.slice(SRC_ROOT.length + 1).replace(/\\/g, '/');

    it(`src/${rel} exists and does not import vscode`, () => {
      // Fails loudly, naming the missing file, rather than dropping it from
      // the check silently if a future rename or move loses track of it.
      expect(existsSync(full), `expected src/${rel} to exist`).toBe(true);

      const code = codeOnly(readFileSync(full, 'utf8'));
      // Names the file AND the exact match, rather than a bare true/false,
      // so a failure says what was found and where without re-running by hand.
      expect(code.match(IMPORTS_VSCODE)?.[0], rel).toBeUndefined();
    });
  }
});
