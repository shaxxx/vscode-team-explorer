import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseWorkspaces } from '../../src/tf/parse.js';
import { PathMapper } from '../../src/tf/PathMapper.js';

/**
 * A CLOAK is a working folder that says "this subtree is NOT in my workspace".
 * `tf vc workfold /cloak serverfolder` takes no local folder, because there is
 * nothing for it to map to — verified against the real 17.14 client's help.
 *
 * The parser turned every WorkingFolder into a mapping regardless, and
 * `String(f['@_local'])` on a missing attribute yields the literal string
 * `"undefined"`.
 *
 * The shape was GUESSED until 2026-09-23, when a cloak was finally captured
 * from a throwaway workspace (`workspaces-cloaked.xml`). tf writes exactly
 * what the guards assumed:
 *
 *     <WorkingFolder item="$/.../order-kiosk" type="Cloak" />
 *
 * -- `type="Cloak"`, and NO `local` attribute at all. The synthetic fixture is
 * kept because it places a cloak inside the `$/` mapping, which is the case
 * that makes the bug visible; the real capture pins the spelling.
 */

const CLOAKED = readFileSync(
  join(__dirname, '../fixtures/windows/workspaces-cloaked-SYNTHETIC.xml'),
);
const REAL = readFileSync(join(__dirname, '../fixtures/windows/workspaces.xml'));

describe('a cloaked working folder', () => {
  it('is not turned into a mapping', () => {
    const folders = parseWorkspaces(CLOAKED)[0].folders;

    expect(folders.map((f) => f.serverItem)).toEqual([
      '$/',
      '$/Vesta/DatabaseFirst/Insight.Database',
    ]);
  });

  it('never produces the string "undefined" as a local path', () => {
    // What the bug actually looked like on disk.
    const folders = parseWorkspaces(CLOAKED)[0].folders;
    for (const f of folders) {
      expect(f.localPath).not.toContain('undefined');
      expect(f.localPath).not.toBe('');
    }
  });

  it('does not answer for a path inside the cloaked subtree', () => {
    // The consequence, and why it is not inert: PathMapper picks the LONGEST
    // matching server item, and a cloak is deeper than the mapping containing
    // it — so it would win, and hand back `undefined\...`.
    const mapper = new PathMapper(parseWorkspaces(CLOAKED)[0].folders, 'win32');

    const local = mapper.toLocalPath('$/Shop/Shop2023/Distribution/bin/App.dll');

    // It still maps, via the `$/` root — but to the REAL path under it.
    expect(local).toBe('C:\\work\\Shop\\Shop2023\\Distribution\\bin\\App.dll');
    expect(local).not.toContain('undefined');
  });
});

describe('the real capture (2026-09-23), taken from a throwaway workspace', () => {
  const CAPTURED = readFileSync(join(__dirname, '../fixtures/windows/workspaces-cloaked.xml'));

  it('is spelled type="Cloak" with no local attribute', () => {
    // Byte-exact from tf, so this is the claim the two guards rest on.
    const xml = CAPTURED.toString('utf8');
    expect(xml).toContain('<WorkingFolder item="$/Shop/Shop2023/Enterprise.Till.Server/Web/order-kiosk" type="Cloak" />');
  });

  it('leaves the workspace with its one real mapping and nothing else', () => {
    const probe = parseWorkspaces(CAPTURED).find((w) => w.name === 'TFVC-PROBE-FIX');
    expect(probe, 'the captured workspace must be in the fixture').toBeDefined();
    expect(probe!.folders).toEqual([
      {
        localPath: 'C:\\Users\\user1\\AppData\\Local\\Temp\\tfvc-probe-fix',
        serverItem: '$/Shop/Shop2023/Enterprise.Till.Server/Web',
      },
    ]);
  });

  it('maps a path inside the cloaked subtree through the parent mapping', () => {
    const probe = parseWorkspaces(CAPTURED).find((w) => w.name === 'TFVC-PROBE-FIX')!;
    const mapper = new PathMapper(probe.folders, 'win32');

    const local = mapper.toLocalPath(
      '$/Shop/Shop2023/Enterprise.Till.Server/Web/order-kiosk/browser/index.html',
    );

    expect(local).toBe(
      'C:\\Users\\user1\\AppData\\Local\\Temp\\tfvc-probe-fix\\order-kiosk\\browser\\index.html',
    );
    expect(local).not.toContain('undefined');
  });
});

/** A workspace with exactly one extra WorkingFolder, spelled as given. */
function withFolder(attrs: string): Buffer {
  return Buffer.from(
    `<Workspaces><Workspace computer="DEVPC" name="DEVPC">` +
      `<Folders>` +
      `<WorkingFolder local="C:\\work" item="$/" />` +
      `<WorkingFolder ${attrs} />` +
      `</Folders></Workspace></Workspaces>`,
    'utf8',
  );
}

describe('each guard has to work on its own', () => {
  // The two are deliberately redundant, and the fixture trips both — so
  // removing either one still passed. That hid the thing that matters: the
  // `type` spelling is a GUESS, and if it is wrong the local-attribute guard
  // is the only thing standing. These pin them separately.

  it('rejects a cloak that carries no type attribute at all', () => {
    // Only the local/item guard can catch this one.
    const folders = parseWorkspaces(withFolder('item="$/Shop/bin"'))[0].folders;
    expect(folders.map((f) => f.serverItem)).toEqual(['$/']);
  });

  it('rejects an empty local path, not just a missing one', () => {
    const folders = parseWorkspaces(withFolder('local="" item="$/Shop/bin"'))[0].folders;
    expect(folders.map((f) => f.serverItem)).toEqual(['$/']);
  });

  it('rejects a non-Map type even when a local path IS present', () => {
    // Only the type guard can catch this one. It exists because nothing has
    // verified that tf omits `local` on a cloak in the XML — the help text
    // proves the COMMAND takes no local folder, which is not the same claim.
    const folders = parseWorkspaces(
      withFolder('local="C:\\work\\Shop\\bin" item="$/Shop/bin" type="Cloak"'),
    )[0].folders;
    expect(folders.map((f) => f.serverItem)).toEqual(['$/']);
  });

  it('keeps an explicit type="Map"', () => {
    // The guard must not reject a mapping that merely spells out what it is.
    const folders = parseWorkspaces(
      withFolder('local="C:\\other" item="$/Other" type="Map"'),
    )[0].folders;
    expect(folders.map((f) => f.serverItem)).toEqual(['$/', '$/Other']);
  });
});

describe('the real workspaces, which have no cloak', () => {
  it('are unchanged by the guard', () => {
    const folders = parseWorkspaces(REAL)[0].folders;

    expect(folders).toEqual([
      { localPath: 'C:\\work', serverItem: '$/' },
      {
        localPath: 'C:\\Users\\user1\\Downloads\\Insight.Database-main\\Insight.Database',
        serverItem: '$/Vesta/DatabaseFirst/Insight.Database',
      },
    ]);
  });
});
