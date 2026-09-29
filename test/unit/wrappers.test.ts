import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The extension relies on four things from a wrapper: arguments passed through
 * unchanged, the login arguments appended by the wrapper itself, tf's exit code
 * returned, and nothing extra on stdout. These pin the parts a careless edit
 * would break.
 */
const read = (f: string) => readFileSync(join(__dirname, '../../wrappers', f), 'utf8');
const echoLines = (s: string) => s.split(/\r?\n/).filter((l) => /^\s*echo\b/i.test(l));

describe('wrappers/', () => {
  it('tfp.cmd keeps delayed expansion and appends the login arguments itself', () => {
    const cmd = read('tfp.cmd');
    // TfClient refuses !, % and ^ precisely because of this line.
    expect(cmd).toMatch(/^setlocal enabledelayedexpansion\r?$/m);
    expect(cmd).toMatch(/^"%TF%" %\* \/noprompt \/loginType:OAuth \/login:\.,!TFSPAT!\r?$/m);
  });

  it('tfp appends the login arguments itself', () => {
    expect(read('tfp')).toMatch(
      /^exec wine "\$TF_EXE" "\$\{args\[@\]\}" \/noprompt \/loginType:OAuth "\/login:\.,\$PAT"$/m,
    );
  });

  it('never echoes the token', () => {
    expect(echoLines(read('tfp.cmd')).filter((l) => /TFSPAT/i.test(l))).toEqual([]);
    expect(echoLines(read('tfp')).filter((l) => /\$\{?PAT\b/.test(l))).toEqual([]);
  });

  it('the Flatpak shim runs ~/bin/tfp on the host, for any user', () => {
    const shim = read('tfp-flatpak');
    expect(shim).toMatch(/^exec flatpak-spawn --host "\$HOME\/bin\/tfp" "\$@"$/m);
    expect(shim).not.toMatch(/\/home\//);
  });

  it('uses CRLF for the batch file and LF for the shell scripts', () => {
    expect(read('tfp.cmd')).toContain('\r\n');
    expect(read('tfp')).not.toContain('\r');
    expect(read('tfp-flatpak')).not.toContain('\r');
  });
});
