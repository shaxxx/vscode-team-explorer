import { writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';

/**
 * True only for a path under the OS temp directory. The guard in writePatFile
 * uses this to tell a throwaway file from the user's live credential.
 */
function isDisposablePath(filePath: string): boolean {
  const temp = resolve(tmpdir()).toLowerCase();
  return resolve(filePath).toLowerCase().startsWith(temp);
}

/** The file both tfp wrappers read by default. */
export function defaultPatFilePath(): string {
  // The wrapper honours TFS_PAT_FILE and reads only that file. Ignoring it
  // meant Set PAT wrote a second, live, plaintext copy of the token to a
  // location the user never chose and the wrapper never reads -- doubling the
  // credential-at-rest surface while the original failure went unchanged, and
  // then reporting a true sentence about the wrong file.
  const override = process.env.TFS_PAT_FILE?.trim();
  return override ? override : join(homedir(), '.tfs', 'pat.txt');
}

/**
 * Writes the PAT as the only line of the file, UTF-8, **without a BOM**.
 *
 * tfp.cmd reads this with `set /p TFSPAT=<file`. A BOM would be read as part
 * of the token, and every tf command would then fail with an opaque 401.
 */
export function writePatFile(filePath: string, token: string): void {
  // A TEST MUST NEVER REACH THE REAL PAT FILE. This is not hypothetical: a
  // mutation test that deliberately broke defaultPatFilePath's TFS_PAT_FILE
  // redirection, run against the Set PAT tests, wrote a fake token straight
  // over the user's live credential. The test suite reported the mutant as
  // killed; it was killed by destroying the token.
  //
  // Redirection that a mutant can switch off is not protection. This guard is
  // on the WRITE itself, so no change to path resolution can get past it.
  if (process.env.VITEST && !isDisposablePath(filePath)) {
    throw new Error(
      `Refusing to write a PAT to ${filePath} from a test. ` +
        'Tests must write only under the OS temp directory.',
    );
  }

  const value = token.trim();
  if (!value || /\s/.test(value)) {
    // A whitespace-only value would write an empty first line, which the
    // wrapper reports as "PAT file is empty"; an interior space or newline
    // would write a token `set /p` truncates. Refusing beats writing a file
    // that can only ever fail to authenticate.
    throw new Error('Refusing to write a PAT containing whitespace.');
  }

  // 0o700 on the directory and 0o600 on the FILE ITSELF, not only afterwards.
  // writeFileSync with no mode creates at 0o666 & ~umask -- typically 0644 --
  // so the token existed world-readable for the window between the write and
  // the chmod. On an overwrite it is worse: writeFileSync does not change the
  // mode of an existing file at all, so a hand-created 0644 pat.txt stayed
  // 0644 until the chmod below. Both are short windows on a live credential,
  // and both close for free.
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  writeFileSync(filePath, value + '\n', { encoding: 'utf8', mode: 0o600 });

  if (process.platform !== 'win32') {
    // Still needed: `mode` is ignored when the file already exists.
    chmodSync(filePath, 0o600);
  }
}
