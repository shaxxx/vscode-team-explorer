import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TFVC_SCHEME } from '../../src/ui/ServerContentProvider.js';

/**
 * The public namespace is `teamExplorer`, not `tfvc`.
 *
 * `tfvc.*` is shared: qodev.tfvc claims seven of the same command ids and the
 * `tfvc.autoCheckout` setting, and it activates on `onCommand:tfvc.checkout`
 * among others, so it wakes up precisely when ours is used and then cannot
 * register. A third extension's `tfvc.location` and `tfvc.restrictWorkspace`
 * are still sitting in the user's settings although it is long uninstalled.
 *
 * This file exists because the rename passed all 298 other tests while the
 * code still read `getConfiguration('tfvc')` — settings declared under one
 * name and read from another fall back to their defaults in silence. Nothing
 * failed. Nothing would have.
 */

const ROOT = join(__dirname, '../..');
const PREFIX = 'teamExplorer';

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
  contributes: {
    commands: { command: string }[];
    configuration: { properties: Record<string, unknown> };
    menus: Record<string, { command?: string; when?: string }[]>;
  };
};

const extensionSource = readFileSync(join(ROOT, 'src/extension.ts'), 'utf8');

describe('the declared namespace', () => {
  it('uses teamExplorer for every command id', () => {
    const wrong = pkg.contributes.commands
      .map((c) => c.command)
      .filter((id) => !id.startsWith(`${PREFIX}.`));
    expect(wrong, 'these command ids are outside the namespace').toEqual([]);
  });

  it('uses teamExplorer for every setting', () => {
    const wrong = Object.keys(pkg.contributes.configuration.properties).filter(
      (key) => !key.startsWith(`${PREFIX}.`),
    );
    expect(wrong, 'these settings are outside the namespace').toEqual([]);
  });

  it('claims no tfvc identifier anywhere in the manifest', () => {
    // The first version of this required a quote immediately before `tfvc`,
    // which is true of a command id and false of `scmProvider == tfvc` — where
    // the token sits at the END of the string, after a space. Ten of those
    // survived the rename and this test passed.
    //
    // Any `tfvc` at a word boundary, anywhere in the manifest except the
    // search keywords, which exist precisely so people searching "tfvc" find it.
    const { keywords: _keywords, ...rest } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    const manifest = JSON.stringify(rest, null, 2);
    const hits = [...manifest.matchAll(/\btfvc\b/g)].map((m) =>
      manifest.slice(Math.max(0, m.index - 60), m.index + 20),
    );
    expect(hits, 'these lines still name the old namespace').toEqual([]);
  });

  it('points every SCM menu entry at the provider id the code registers', () => {
    // The one that got away. `createSourceControl(id, label)` is what
    // `scmProvider == <id>` binds to, and the rename moved the id while
    // leaving all ten when-clauses behind — so the Check In button vanished
    // from the panel, and since it has no palette entry and no keybinding by
    // hard rule 1, check-in became unreachable from the extension entirely.
    //
    // Worse than vanishing: qodev.tfvc registers `createSourceControl('tfvc',
    // ...)`, so the stale clauses matched ITS panel. Our Check In button would
    // have rendered in another extension's title bar.
    const scmSource = readFileSync(join(ROOT, 'src/ui/ScmProvider.ts'), 'utf8');
    const registered = /createSourceControl\(\s*'([^']+)'/.exec(scmSource)?.[1];
    expect(registered, 'could not find the createSourceControl id').toBeDefined();
    expect(registered).toBe(PREFIX);

    const manifest = readFileSync(join(ROOT, 'package.json'), 'utf8');
    const referenced = [...manifest.matchAll(/scmProvider\s*==\s*(\w+)/g)].map((m) => m[1]);
    expect(referenced.length, 'no scmProvider clause found at all').toBeGreaterThan(0);
    for (const id of referenced) expect(id, 'a menu points at a provider nobody registers').toBe(registered);
  });
});

describe('what the code actually reads', () => {
  it('reads the configuration section it declares', () => {
    // The whole reason this file exists. Declaring `teamExplorer.autoCheckout`
    // and reading section `tfvc` is not a type error, not a test failure, and
    // not visible at runtime except as every setting quietly having no effect.
    expect(extensionSource).toContain(`getConfiguration('${PREFIX}')`);
    expect(extensionSource, 'still reading the old section').not.toContain(
      "getConfiguration('tfvc')",
    );
  });

  it('uses only when-clause terms that something actually defines', () => {
    // A `when` naming a key nobody sets hides the command forever, silently.
    //
    // The first version of this pre-filtered to clauses containing ':enabled',
    // which is circular: it could only ever check the clauses that already
    // used the key it was looking for. `scmProvider == tfvc` was filtered out
    // of the very test meant to catch it. No filter now — every distinct term
    // must be accounted for.
    const scmSource = readFileSync(join(ROOT, 'src/ui/ScmProvider.ts'), 'utf8');
    const groups = [...scmSource.matchAll(/createResourceGroup\(\s*'([^']+)'/g)].map((m) => m[1]);
    const providerId = /createSourceControl\(\s*'([^']+)'/.exec(scmSource)?.[1];

    // Plan 3: rows also carry a `contextValue` naming their PendingState (or
    // one of ScmProvider's own literals, 'untracked' and 'conflict', for a row
    // that is not a pending change), which `scmResourceState` clauses key on.
    // Read from FileState.ts and ScmProvider.ts rather than hard-coded here,
    // for the same reason `groups` is read from ScmProvider.ts above: a typo'd
    // or removed state must fail this test, not silently pass because the
    // whitelist was never updated to match.
    const fileStateSource = readFileSync(join(ROOT, 'src/state/FileState.ts'), 'utf8');
    const pendingStateMatch = /type PendingState = ([^;]+);/.exec(fileStateSource);
    expect(pendingStateMatch, 'could not find the PendingState union in FileState.ts').not.toBeNull();
    const rowLiterals = [...scmSource.matchAll(/contextValue: '(\w+)'/g)].map((m) => m[1]);
    expect(rowLiterals.sort()).toEqual(['conflict', 'untracked']);
    const knownStates = new Set([
      ...[...pendingStateMatch![1].matchAll(/'(\w+)'/g)].map((m) => m[1]),
      ...rowLiterals,
    ]);

    // Plan 3: the editor menu and the Explorer submenu's Compare entry gate on
    // `teamExplorer.activeFileState`, keyed on the FULL FileState union (not
    // just PendingState -- 'versioned' and 'writableNotCheckedOut' are states
    // with no pending change at all). Same treatment as knownStates above: read
    // from the source rather than hard-coded, so a typo'd or removed state
    // fails this test instead of the whitelist quietly drifting out of sync.
    const fileStateMatch = /export type FileState =([\s\S]*?);/.exec(fileStateSource);
    expect(fileStateMatch, 'could not find the FileState union in FileState.ts').not.toBeNull();
    const knownFileStates = new Set(
      [...fileStateMatch![1].matchAll(/'(\w+)'/g)].map((m) => m[1]),
    );

    // The other half of the same check: the KEY STRING itself. A when-clause
    // can only ever match a context key that something actually calls
    // `setContext` with, and ActiveFileState.ts is that one call site. Typo
    // either side -- the manifest's key name or the string this file sets --
    // and this line is what catches it; validating the STATES above never
    // would, since both sides would still agree on a wrong key name.
    const activeFileStateSource = readFileSync(join(ROOT, 'src/ui/ActiveFileState.ts'), 'utf8');
    expect(
      activeFileStateSource,
      "ActiveFileState.ts does not set 'teamExplorer.activeFileState'",
    ).toContain("'teamExplorer.activeFileState'");

    // Phase 2: Annotate's toggle. Annotator.ts is the one place that sets it.
    const annotatorSource = readFileSync(join(ROOT, 'src/annotate/Annotator.ts'), 'utf8');
    expect(annotatorSource, "Annotator.ts does not set 'teamExplorer.annotated'").toContain("'teamExplorer.annotated'");

    const known = new Set([
      'false',
      'resourceScheme == file',
      `${PREFIX}:enabled`,
      `scmProvider == ${providerId}`,
      ...groups.map((g) => `scmResourceGroup == ${g}`),
      // Task 6: Undo/Checkout/Compare with Latest exclude the untracked group
      // with `!=` rather than naming the groups they DO apply to with `==`,
      // so a real group compared the other way is just as legitimate here.
      ...groups.map((g) => `scmResourceGroup != ${g}`),
      // Plan 3: a built-in VS Code Explorer context key (true when the
      // right-clicked row is a file), not something this extension defines --
      // there is no source to read it from.
      '!explorerResourceIsFolder',
      'teamExplorer.annotated',
      '!teamExplorer.annotated',
    ]);

    const terms = new Set(
      Object.values(pkg.contributes.menus)
        .flat()
        .flatMap((e) => (e.when ?? '').split('&&'))
        .map((t) => t.trim())
        .filter((t) => t !== ''),
    );
    expect(terms.size).toBeGreaterThan(0);

    const unknown = [...terms].filter((t) => {
      if (known.has(t)) return false;
      // A `scmResourceState` clause names one or more states rather than a
      // resource group, either as `== state` or `=~ /^(a|b)$/` -- checked
      // against the real union above so this test does not need a manual
      // update every time a new combination of states appears in package.json.
      const eq = /^scmResourceState == (\w+)$/.exec(t);
      if (eq) return !knownStates.has(eq[1]);
      const re = /^scmResourceState =~ \/\^\(([\w|]+)\)\$\/$/.exec(t);
      if (re) return re[1].split('|').some((s) => !knownStates.has(s));
      // Same two shapes again, for teamExplorer.activeFileState against the
      // full FileState union.
      const activeEq = /^teamExplorer\.activeFileState == (\w+)$/.exec(t);
      if (activeEq) return !knownFileStates.has(activeEq[1]);
      const activeRe = /^teamExplorer\.activeFileState =~ \/\^\(([\w|]+)\)\$\/$/.exec(t);
      if (activeRe) return activeRe[1].split('|').some((s) => !knownFileStates.has(s));
      return true;
    });
    expect(unknown, 'these when-clause terms are not defined anywhere').toEqual([]);
  });

  it('uses teamExplorer as the document scheme', () => {
    // Two extensions cannot register a content provider for one scheme, and
    // this is what the diff opens through.
    expect(TFVC_SCHEME).toBe(PREFIX);
  });
});

describe('what the user actually sees', () => {
  it('does not put two identical entries in the command palette', () => {
    // qodev.tfvc also uses category "TFVC", and also contributes a command
    // titled "Refresh" — so the palette offered `TFVC: Refresh` twice, from two
    // extensions, indistinguishable. Renaming the ids fixed the crash and left
    // that untouched, which is the worse half: an error tells you something is
    // wrong, a duplicate label just gets picked at random.
    const categories = new Set(
      (pkg.contributes.commands as { category?: string }[])
        .map((c) => c.category)
        .filter((c): c is string => c !== undefined && c !== 'None'),
    );
    expect([...categories]).toEqual(['Team Explorer']);
  });

  it('is not called exactly what the other extension is called', () => {
    // Both were `displayName: "TFVC"`, so the Extensions list showed two rows
    // with the same name. Keeping TFVC in the name keeps it searchable.
    const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      displayName: string;
    };
    expect(manifest.displayName).not.toBe('TFVC');
    expect(manifest.displayName).toContain('TFVC');
  });

  it('names its output channel and SCM panel distinctly', () => {
    expect(extensionSource).toContain("createOutputChannel('Team Explorer')");
    const scm = readFileSync(join(ROOT, 'src/ui/ScmProvider.ts'), 'utf8');
    expect(scm).toContain("'Team Explorer', folder.uri");
  });

  it('never tells the user to run a command or set a setting that is not ours', () => {
    // The relabel renamed the category and missed the strings that QUOTE it.
    // Both failures are worse than cosmetic with qodev installed: `Run "TFVC:
    // Set Personal Access Token"` now matches only qodev's command, and the
    // advice to change `tfvc.autoCheckout` sends the user to edit qodev's
    // setting while ours goes on doing what they were trying to stop.
    //
    // These fire on the error paths — a rejected token, a save that overran —
    // which is exactly when the instruction has to be literally followable.
    const strings = readFileSync(join(ROOT, 'src/tf/strings.ts'), 'utf8');
    expect(strings, 'quotes a palette command from the old category').not.toContain('"TFVC:');
    expect(strings, 'names a setting in the old namespace').not.toMatch(/\btfvc\.\w/);

    // And nothing user-visible anywhere else in src/ either.
    const extension = readFileSync(join(ROOT, 'src/extension.ts'), 'utf8');
    expect(extension).not.toContain("'TFVC:");
  });

  it('still keeps Check In out of the palette', () => {
    // Hard rule 1. The rename touched every command contribution, and this is
    // the one whose visibility is a safety property rather than a preference.
    const entry = pkg.contributes.menus.commandPalette.find(
      (e) => e.command === `${PREFIX}.checkInFromButton`,
    );
    expect(entry, 'check-in has no commandPalette entry at all').toBeDefined();
    expect(entry!.when).toBe('false');
  });
});

describe('the private storage keys', () => {
  it('names the old keys in exactly one place — the migration', () => {
    // These two are Memento and SecretStorage entries, scoped to this
    // extension, so they could not collide and did not have to move. They move
    // for consistency, which means the ONLY place `tfvc.` may still appear is
    // as the source side of the migration. An old key surviving anywhere else
    // is a consumer that was never switched over.
    for (const file of ['src/ui/ScmProvider.ts', 'src/commands/setPat.ts']) {
      const source = readFileSync(join(ROOT, file), 'utf8');
      expect(source, `${file} still reads an old storage key`).not.toContain("'tfvc.");
    }

    const migration = readFileSync(join(ROOT, 'src/migrateState.ts'), 'utf8');
    expect(migration).toContain("'tfvc.excluded'");
    expect(migration).toContain("'tfvc.pat'");
  });

  it('runs the migration before anything can read the new keys', () => {
    // ScmProvider loads the excluded list in its constructor. A migration
    // running after that would move the data correctly and still show an empty
    // Excluded group for the rest of the session.
    const migrateAt = extensionSource.indexOf('migrateStateKeys(');
    const scmAt = extensionSource.indexOf('new ScmProvider(');
    expect(migrateAt, 'the migration is not called at all').toBeGreaterThan(-1);
    expect(scmAt).toBeGreaterThan(-1);
    expect(migrateAt, 'the migration runs after ScmProvider reads the key').toBeLessThan(scmAt);
  });

  it('awaits the migration, so the read cannot race it', () => {
    expect(extensionSource).toMatch(/await\s+migrateStateKeys\(/);
  });
});
