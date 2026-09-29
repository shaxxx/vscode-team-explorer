import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerCommands } from '../../src/commands/index.js';
import { PathMapper } from '../../src/tf/PathMapper.js';
import { recorder, outputChannel, Uri } from '../vscode-mock.js';
import { S } from '../../src/tf/strings.js';

/**
 * Adding a FOLDER. The explorer menu carried `!explorerResourceIsFolder`, so
 * the gesture Team Explorer users reach for first was not offered at all, and
 * the handler sent no `/recursive` — meaning that even when the command was
 * reached from the palette, a folder went in without its subfolders.
 *
 * These use a real temp directory because the decision is made by statSync.
 * NEVER point them at C:\work\... — those are live TFVC workspaces.
 */

const ON_WINDOWS = process.platform === 'win32';
const PLATFORM = ON_WINDOWS ? 'win32' : 'linux';

/** A working folder's localPath is in tf.exe's terms: a Z: path under Wine. */
const toWine = (p: string) => (ON_WINDOWS ? p : 'Z:' + p.replace(/\//g, '\\'));

let root: string;
let folder: string;
let file: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'tfvc-add-'));
  folder = join(root, 'probe');
  mkdirSync(join(folder, 'nested'), { recursive: true });
  writeFileSync(join(folder, 'a.txt'), 'a');
  writeFileSync(join(folder, 'nested', 'b.txt'), 'b');
  file = join(root, 'loose.txt');
  writeFileSync(file, 'loose');
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

interface Run {
  args: string[];
}

function harness() {
  const runs: Run[] = [];
  const mapper = new PathMapper([{ serverItem: '$/Probe', localPath: toWine(root) }], PLATFORM);

  const client = {
    timeoutMs: 1000,
    run: async (args: string[]) => {
      runs.push({ args });
      return { stdout: Buffer.from(''), stderr: Buffer.from(''), exitCode: 0, timedOut: false };
    },
  };
  const service = { pathMapper: mapper, requestRefresh() {}, refresh: async () => undefined };
  const scm = { setExcluded: async () => {} };
  const context = { subscriptions: [] as { dispose(): void }[] };

  registerCommands(
    context as never,
    client as never,
    service as never,
    scm as never,
    outputChannel as never,
    undefined,
    { invalidate: () => {} },
  );

  return { runs };
}

beforeEach(() => {
  recorder.reset();
  outputChannel.clear();
});

describe('teamExplorer.add on a folder', () => {
  it('sends /recursive, so subfolders are not silently left behind', async () => {
    const { runs } = harness();
    recorder.answers.push(S.addFolderConfirmYes);

    await recorder.invoke('teamExplorer.add', Uri.file(folder));

    expect(runs).toHaveLength(1);
    expect(runs[0].args).toEqual(['vc', 'add', toWine(folder), '/recursive']);
  });

  it('asks first, and runs NOTHING if the user declines', async () => {
    const { runs } = harness();
    recorder.answers.push(undefined); // dismissed

    await recorder.invoke('teamExplorer.add', Uri.file(folder));

    expect(runs).toHaveLength(0);
    const dialog = recorder.messages.at(-1)!;
    expect(dialog.modal, 'a dismissible warning is not a confirmation').toBe(true);
    expect(dialog.items).toContain(S.addFolderConfirmYes);
  });

  it('says how to add a file the exclusions skip', async () => {
    // Measured on the live collection, all three cases:
    //   folder add, no flag          -> app.exe ignored, readme.txt added
    //   folder add /noignore         -> both added
    //   naming app.exe directly      -> added, no flag needed
    //
    // The third is the one that matters, because it is both what Visual Studio
    // does and something this extension already supports. So the fix for "my
    // .exe did not go in" is a sentence, not a /noignore option — and without
    // that sentence the user has no way to discover it.
    const { runs } = harness();
    recorder.answers.push(undefined);

    await recorder.invoke('teamExplorer.add', Uri.file(folder));

    expect(runs).toHaveLength(0);
    const detail = recorder.messages.at(-1)!.message;
    expect(detail).toContain('.exe');
    expect(detail).toContain('right-click the file itself');
  });
});

describe('teamExplorer.add on a file', () => {
  it('sends no /recursive and shows no dialog at all', async () => {
    // The file case must keep exactly the command it has always sent, and must
    // not acquire a confirmation step it never had.
    const { runs } = harness();

    await recorder.invoke('teamExplorer.add', Uri.file(file));

    expect(runs).toHaveLength(1);
    expect(runs[0].args).toEqual(['vc', 'add', toWine(file)]);
    expect(recorder.messages).toHaveLength(0);
  });

  it('treats a path that does not exist as a file, not a folder', async () => {
    // statSync throws for a missing path. Letting that propagate would abort
    // the whole Add instead of letting tf report on it.
    const { runs } = harness();

    await recorder.invoke('teamExplorer.add', Uri.file(join(root, 'never-created.txt')));

    expect(runs).toHaveLength(1);
    expect(runs[0].args).not.toContain('/recursive');
    expect(recorder.messages).toHaveLength(0);
  });
});

describe('a folder and a file selected together', () => {
  it('asks once and sends both, with /recursive last', async () => {
    const { runs } = harness();
    recorder.answers.push(S.addFolderConfirmYes);

    await recorder.invoke('teamExplorer.add', Uri.file(folder), [Uri.file(folder), Uri.file(file)]);

    expect(recorder.messages).toHaveLength(1);
    expect(runs[0].args).toEqual(['vc', 'add', toWine(folder), toWine(file), '/recursive']);
  });
});

describe('the explorer menu', () => {
  it('no longer hides Add on folders', () => {
    // The command being reachable is the whole point; a handler that supports
    // folders behind a `when` clause that hides it is the bug this fixes.
    //
    // Plan 3 moved the Explorer's per-file commands off `explorer/context`
    // (now just a pointer at the `teamExplorer.explorer` submenu) and into
    // that submenu itself, so this reads the entry from there instead.
    const pkg = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf8')) as {
      contributes: { menus: Record<string, { command: string; when?: string }[]> };
    };
    const entry = pkg.contributes.menus['teamExplorer.explorer'].find((e) => e.command === 'teamExplorer.add');
    expect(entry, 'teamExplorer.add is not contributed to the Team Explorer submenu').toBeDefined();
    expect(entry!.when ?? '').not.toContain('explorerResourceIsFolder');
  });
});
