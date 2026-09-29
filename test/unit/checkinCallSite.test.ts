import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ScmProvider } from '../../src/ui/ScmProvider.js';
import { PathMapper } from '../../src/tf/PathMapper.js';
import { S } from '../../src/tf/strings.js';
import { ScanResult } from '../../src/scan/ScanResult.js';
import { scm, Uri, outputChannel } from '../vscode-mock.js';
import { codeOnly } from '../helpers/codeOnly.js';

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return full.endsWith('.ts') ? [full] : [];
  });
}

/**
 * The tf verb, however it is cased in practice: `checkin`, `Checkin`,
 * `CHECKIN` or `CheckIn` — TF.exe accepts all four. Deliberately NOT
 * `checkIn` (lowercase c, capital I) — that spelling is reserved, everywhere
 * in this codebase, for the camelCase identifiers built from it
 * (registerCheckIn, checkInFromButton, checkInPlaceholder,
 * ./commands/checkIn.js). Listing the real spellings explicitly, rather than
 * matching case-insensitively, is what keeps `checkIn` itself out — a
 * case-insensitive `\bcheckin\b` would catch the plumbing along with the
 * argument, which is the opposite of useful here.
 *
 * No `g` flag on the constant: a global regex carries `lastIndex` between
 * calls to `.test()`, so reusing one instance across `files.filter(...)`
 * silently skips matches. `new RegExp(source, flags)` at each call site
 * avoids that trap instead of relying on remembering to reset it.
 */
const CHECKIN_VERB_SOURCE = String.raw`\b(?:checkin|Checkin|CHECKIN|CheckIn)\b`;

describe('check-in safety (hard rule 1)', () => {
  const files = sourceFiles(join(__dirname, '../../src'));

  it("passes 'checkin' to tf from exactly one source file", () => {
    // This is a static, syntactic check, not a real evasion guard:
    // `'check' + 'in'` built at runtime, or any casing not in
    // CHECKIN_VERB_SOURCE's list, is exactly as invisible to this regex as
    // ever.
    const withCheckin = files.filter((f) =>
      new RegExp(CHECKIN_VERB_SOURCE).test(codeOnly(readFileSync(f, 'utf8'))),
    );

    expect(withCheckin.map((f) => f.replace(/\\/g, '/').split('/src/')[1]))
      .toEqual(['commands/checkIn.ts']);
  });

  it('calls it exactly once within that file', () => {
    const source = codeOnly(
      readFileSync(join(__dirname, '../../src/commands/checkIn.ts'), 'utf8'),
    );
    expect(source.match(new RegExp(CHECKIN_VERB_SOURCE, 'g'))).toHaveLength(1);
  });

  it('catches Checkin, CHECKIN and CheckIn as well as the plain lowercase verb', () => {
    const verb = new RegExp(CHECKIN_VERB_SOURCE);
    expect(verb.test('checkin')).toBe(true);
    expect(verb.test('Checkin')).toBe(true);
    expect(verb.test('CHECKIN')).toBe(true);
    expect(verb.test('CheckIn')).toBe(true);
  });

  it('does not mistake the camelCase identifiers for the verb', () => {
    const verb = new RegExp(CHECKIN_VERB_SOURCE);
    expect(verb.test('checkIn')).toBe(false);
    expect(verb.test('registerCheckIn')).toBe(false);
    expect(verb.test('checkInFromButton')).toBe(false);
    expect(verb.test('checkInPlaceholder')).toBe(false);
  });

  it('the check-in command is hidden from the command palette', () => {
    const pkg = JSON.parse(
      readFileSync(join(__dirname, '../../package.json'), 'utf8'),
    );
    const ids: string[] = (pkg.contributes?.commands ?? []).map((c: any) => c.command);
    const checkInIds = ids.filter((id) => /checkin/i.test(id));

    // There is exactly one check-in command, and it is the button's.
    expect(checkInIds).toEqual(['teamExplorer.checkInFromButton']);

    // Hard rule 1: no command-palette entry. VS Code shows every contributed
    // command in the palette unless a `when: false` entry hides it.
    const palette = pkg.contributes?.menus?.['commandPalette'] ?? [];
    const hidden = palette.find((m: any) => m.command === 'teamExplorer.checkInFromButton');
    expect(hidden).toBeDefined();
    expect(hidden.when).toBe('false');
  });

  it('the SCM input box does not accept Ctrl+Enter as a check-in', () => {
    // package.json is not the only way to bind a key to check-in. VS Code
    // binds Ctrl+Enter in the SCM input to the SourceControl's
    // acceptInputCommand, so setting that would reach check-in by keybinding
    // without any keybindings entry for the package.json guard below to catch.
    // It must stay unset.
    const mapper = new PathMapper(
      [{ serverItem: '$/Vesta', localPath: 'C:\\work\\Vesta' }],
      'win32',
    );
    new ScmProvider(
      { pendingChanges: [], pathMapper: mapper, onDidChange: () => ({ dispose() {} }) } as never,
      { uri: Uri.file('C:\\work\\Vesta') } as never,
      { get: <T>(_k: string, d: T) => d, update: async () => {} } as never,
      outputChannel as never,
      () => ScanResult.notRun(),
      () => ({ dispose() {} }),
    );

    expect(scm.last!.acceptInputCommand, 'Ctrl+Enter would check in').toBeUndefined();
  });

  it('the input placeholder does not promise a key chord that does nothing', () => {
    // It used to read "Message (press Ctrl+Enter to check in)" while
    // acceptInputCommand was deliberately never set - so the placeholder
    // advertised the one route hard rule 1 forbids, and pressing it did
    // nothing at all.
    expect(S.checkInPlaceholder).not.toMatch(/ctrl\+|cmd\+|⌘|shift\+|alt\+/i);
    expect(S.checkInPlaceholder).toMatch(/button/i);
  });

  it("names the Check In button's command only where it is registered", () => {
    // CHECKIN_VERB_SOURCE deliberately skips `checkInFromButton`, so an
    // `executeCommand('teamExplorer.checkInFromButton')` added anywhere else
    // would reach check-in past every other pin here (phase 3 part 2 review).
    const naming = files.filter((f) => /checkInFromButton/i.test(codeOnly(readFileSync(f, 'utf8'))));
    expect(naming.map((f) => f.replace(/\\/g, '/').split('/src/')[1])).toEqual(['commands/checkIn.ts']);
  });

  it('puts the Check In button in the Source Control title bar and nowhere else', () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf8'));
    const places = Object.entries(pkg.contributes?.menus ?? {}).flatMap(([menu, entries]) =>
      (entries as any[]).filter((e) => /checkin/i.test(e.command ?? '')).map((e) => `${menu} ${e.when}`),
    );
    expect(places.sort()).toEqual(['commandPalette false', 'scm/title scmProvider == teamExplorer']);
    // A welcome view's `command:` link would be one more click-to-check-in.
    expect(JSON.stringify(pkg.contributes?.viewsWelcome ?? [])).not.toMatch(/checkin/i);
  });

  it('no check-in command has a keybinding', () => {
    const pkg = JSON.parse(
      readFileSync(join(__dirname, '../../package.json'), 'utf8'),
    );
    const bindings: string[] = (pkg.contributes?.keybindings ?? []).map((k: any) => k.command);
    expect(bindings.filter((id) => /checkin/i.test(id))).toEqual([]);
  });
});
