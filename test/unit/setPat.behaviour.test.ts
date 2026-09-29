import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { registerSetPat } from '../../src/commands/setPat.js';
import { defaultPatFilePath, writePatFile } from '../../src/pat/PatStore.js';
import { recorder, window } from '../vscode-mock.js';
import { S } from '../../src/tf/strings.js';

/**
 * SAFETY: every test here points TFS_PAT_FILE at a throwaway file. The real
 * ~/.tfs/pat.txt is a live credential and is never read or written.
 */
const FAKE = 'zz7fakefaketokenfake4example5678';

let dir: string;
let patFile: string;
let previousEnv: string | undefined;

beforeEach(() => {
  recorder.reset();
  dir = mkdtempSync(join(tmpdir(), 'tfvc-pat-'));
  patFile = join(dir, 'pat.txt');
  previousEnv = process.env.TFS_PAT_FILE;
  process.env.TFS_PAT_FILE = patFile;
});

afterEach(() => {
  if (previousEnv === undefined) delete process.env.TFS_PAT_FILE;
  else process.env.TFS_PAT_FILE = previousEnv;
  rmSync(dir, { recursive: true, force: true });
});

/** Registers the command with a stubbed input box returning `typed`. */
function harness(typed: string | undefined) {
  const stored: Record<string, string> = {};
  const context = {
    subscriptions: [] as { dispose(): void }[],
    secrets: {
      store: async (k: string, v: string) => void (stored[k] = v),
      get: async (k: string) => stored[k],
    },
  };
  window.showInputBox = () => Promise.resolve(typed) as never;
  registerSetPat(context as never);
  return { stored };
}

describe('Set PAT', () => {
  it('stores and writes an ordinary token', async () => {
    const { stored } = harness(FAKE);

    await recorder.invoke('teamExplorer.setPat');

    expect(readFileSync(patFile, 'utf8')).toBe(FAKE + '\n');
    expect(stored['teamExplorer.pat']).toBe(FAKE);
    expect(recorder.shown).toContain(S.patSaved);
  });

  it('accepts a token pasted with surrounding whitespace', async () => {
    // The overwhelmingly common paste. It must be TRIMMED and accepted, not
    // rejected as "contains whitespace" -- so the trim has to happen before
    // both guards, not only inside writePatFile.
    const { stored } = harness(`  ${FAKE}\r\n`);

    await recorder.invoke('teamExplorer.setPat');

    expect(readFileSync(patFile, 'utf8')).toBe(FAKE + '\n');
    expect(stored['teamExplorer.pat']).toBe(FAKE);
    expect(recorder.shown).toContain(S.patSaved);
  });

  it('a whitespace-only entry destroys NOTHING and does not claim success', async () => {
    // `!token` is false for "   ", so this used to pass the guard: SecretStorage
    // was overwritten with '' and pat.txt with a single "\n" -- both copies of a
    // live token gone, behind a "saved" toast, with the rewrite offer then
    // suppressed because storedPat trims '' back to undefined.
    writePatFile(patFile, FAKE);

    for (const junk of ['   ', '\t', '\n', ' \r\n ']) {
      recorder.reset();
      const { stored } = harness(junk);

      await recorder.invoke('teamExplorer.setPat');

      expect(readFileSync(patFile, 'utf8'), `clobbered by ${JSON.stringify(junk)}`)
        .toBe(FAKE + '\n');
      expect(stored['teamExplorer.pat']).toBeUndefined();
      expect(recorder.shown).not.toContain(S.patSaved);
    }
  });

  it('refuses a token with interior whitespace instead of writing a broken file', async () => {
    // `set /p` reads the first line only, so this could never authenticate --
    // and the rewrite flow would reproduce the broken file on every activation.
    const { stored } = harness('zz7fake token');

    await recorder.invoke('teamExplorer.setPat');

    expect(existsSync(patFile)).toBe(false);
    expect(stored['teamExplorer.pat']).toBeUndefined();
    expect(recorder.shown.join('\n')).toContain('space or a line break');
  });

  it('a cancelled prompt changes nothing', async () => {
    writePatFile(patFile, FAKE);
    const { stored } = harness(undefined);

    await recorder.invoke('teamExplorer.setPat');

    expect(readFileSync(patFile, 'utf8')).toBe(FAKE + '\n');
    expect(stored['teamExplorer.pat']).toBeUndefined();
  });
});

describe('defaultPatFilePath', () => {
  it('honours TFS_PAT_FILE, which is the file the wrapper actually reads', () => {
    // Ignoring it wrote a second live copy of the token to a path the user did
    // not choose and the wrapper never reads, then reported success.
    expect(defaultPatFilePath()).toBe(patFile);
  });

  it('falls back to ~/.tfs/pat.txt when the override is unset or blank', () => {
    process.env.TFS_PAT_FILE = '   ';
    expect(defaultPatFilePath().endsWith(join('.tfs', 'pat.txt'))).toBe(true);
    delete process.env.TFS_PAT_FILE;
    expect(defaultPatFilePath().endsWith(join('.tfs', 'pat.txt'))).toBe(true);
  });
});

describe('writePatFile', () => {
  it('refuses whitespace rather than writing a file that cannot authenticate', () => {
    expect(() => writePatFile(patFile, '   ')).toThrow(/whitespace/i);
    expect(() => writePatFile(patFile, 'a b')).toThrow(/whitespace/i);
    expect(() => writePatFile(patFile, 'a\nb')).toThrow(/whitespace/i);
    expect(existsSync(patFile)).toBe(false);
  });

  it('writes no BOM, of any kind, and exactly one line', () => {
    writePatFile(patFile, FAKE);
    const bytes = readFileSync(patFile);

    // Asserting only bytes[0] !== 0xef would pass on a UTF-16 BOM.
    expect(bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(false);
    expect(bytes.subarray(0, 2).equals(Buffer.from([0xff, 0xfe]))).toBe(false);
    expect(bytes.subarray(0, 2).equals(Buffer.from([0xfe, 0xff]))).toBe(false);
    expect(bytes.toString('utf8')).toBe(FAKE + '\n');
  });

  it('TRUNCATES a longer previous token', () => {
    // The old test wrote 'first' then 'second' -- longer second, so a
    // non-truncating write would have passed it.
    writePatFile(patFile, FAKE + 'MUCHLONGERTAILTHATMUSTNOTSURVIVE');
    writePatFile(patFile, 'zz7short');

    expect(readFileSync(patFile, 'utf8')).toBe('zz7short\n');
  });

  it.skipIf(process.platform === 'win32')('creates the file 0600 and the dir 0700', () => {
    const nested = join(dir, 'nested', 'pat.txt');
    writePatFile(nested, FAKE);

    const { statSync } = require('node:fs');
    expect(statSync(nested).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'nested')).mode & 0o777).toBe(0o700);
  });

  it.skipIf(process.platform === 'win32')('tightens an existing world-readable file', () => {
    const { chmodSync, statSync } = require('node:fs');
    writeFileSync(patFile, 'placeholder\n');
    chmodSync(patFile, 0o644);

    writePatFile(patFile, FAKE);

    expect(statSync(patFile).mode & 0o777).toBe(0o600);
  });
});

describe('the guard that exists because a test destroyed a live credential', () => {
  it('REFUSES to write a PAT outside the temp directory while under test', () => {
    // On 2026-09-16 a mutation test deliberately broke defaultPatFilePath's
    // TFS_PAT_FILE redirection and then ran the Set PAT tests against it. They
    // wrote a fake token over the user's real ~/.tfs/pat.txt. The suite
    // recorded the mutant as killed -- it was killed by destroying the token.
    //
    // Redirection a mutant can switch off is not protection, so the guard is
    // on the write itself.
    const real = join(homedir(), '.tfs', 'pat.txt');
    expect(() => writePatFile(real, 'zz7fakefaketokenfake4example5678')).toThrow(
      /Refusing to write a PAT/,
    );
  });

  it('still refuses when TFS_PAT_FILE points at the real file', () => {
    process.env.TFS_PAT_FILE = join(homedir(), '.tfs', 'pat.txt');
    expect(() => writePatFile(defaultPatFilePath(), 'zz7fake')).toThrow(/Refusing/);
  });

  it('survives the exact mutation: path resolution ignoring the override', () => {
    // Simulates the mutant by calling with the unredirected path directly.
    expect(() => writePatFile(join(homedir(), '.tfs', 'pat.txt'), 'zz7fake')).toThrow();
    // And a temp path still works, so the guard is not blanket-off.
    expect(() => writePatFile(patFile, 'zz7fakefaketokenfake4example5678')).not.toThrow();
  });
});
