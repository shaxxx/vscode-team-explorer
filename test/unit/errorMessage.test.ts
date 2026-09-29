import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { messageFor } from '../../src/tf/errorMessage.js';
import { S } from '../../src/tf/strings.js';

/**
 * Observed on DEVPC with a deliberately invalid token: the notification read
 *
 *     TF30063: You are not authorized to access acme.visualstudio.com\acme.
 *
 * and nothing else. That is a server-side permissions message as far as the
 * user is concerned - the next move it suggests is checking Azure DevOps group
 * membership, not the token. The wording helper existed, but it was private to
 * the command layer and the activation path did not use it, so the same
 * failure said two different things depending on where it came from.
 */

const TF30063 = 'TF30063: You are not authorized to access acme.visualstudio.com\\work.';

describe('messageFor', () => {
  it('names the token for a rejected PAT, and keeps tf\'s own message', () => {
    const text = messageFor({ kind: 'patRejected', originalMessage: TF30063 });

    expect(text).toContain(S.patExpired);
    expect(text, "tf's message is the evidence; never drop it").toContain(TF30063);
    // "not authorized" alone sends the user to the wrong place entirely.
    expect(text.toLowerCase()).toContain('personal access token');
  });

  it('names the token for a missing PAT too', () => {
    const text = messageFor({ kind: 'patMissing', originalMessage: 'no token' });
    expect(text).toContain(S.patMissing);
    expect(text).toContain('no token');
  });

  it('explains a missing tf and a missing Wine prefix', () => {
    expect(messageFor({ kind: 'tfNotFound', originalMessage: 'x' })).toContain(S.tfNotFound);
    expect(messageFor({ kind: 'wineMissing', originalMessage: 'y' })).toContain(S.wineMissing);
  });

  it('shows an unrecognised failure verbatim, adding nothing', () => {
    // A wrong guess dressed up as an explanation is worse than none.
    const raw = 'TF14044: Access denied: user needs CheckIn permission.';
    expect(messageFor({ kind: 'unknown', originalMessage: raw })).toBe(raw);
  });

  it('returns an empty string for no error at all', () => {
    expect(messageFor(undefined)).toBe('');
  });

  it('explains a missing wrapper and keeps the path it tried', () => {
    const text = messageFor({ kind: 'wrapperMissing', originalMessage: '[tfvc] Wrapper not found: /home/user1/bin/tfp' });
    expect(text).toContain(S.wrapperMissing);
    expect(text).toContain('/home/user1/bin/tfp');
  });

  it('points a missing Wine prefix and a missing TF.exe at the install guide, not a private file', () => {
    expect(S.wineMissing).not.toMatch(/references\//);
    expect(S.tfNotFound).toMatch(/TF_EXE/);
  });

  it('names the Flatpak shim for exit 127 inside a Flatpak', () => {
    const e = { kind: 'commandNotFound' as const, originalMessage: 'exec: wine: not found' };
    const text = messageFor(e, { FLATPAK_ID: 'com.visualstudio.code' });
    expect(text).toContain(S.flatpakNoHost);
    expect(text).toContain('tfp-flatpak');
    expect(text).toContain('exec: wine: not found');
  });

  it('says only "a program is missing" for exit 127 outside a Flatpak', () => {
    const e = { kind: 'commandNotFound' as const, originalMessage: 'exec: wine: not found' };
    const text = messageFor(e, {});
    expect(text).toContain(S.commandNotFound);
    expect(text).not.toContain('tfp-flatpak');
  });
});

describe('the wording is defined in exactly one place', () => {
  /**
   * The bug was duplication, not the text. Two call sites presented the same
   * classified error and only one of them explained it, for months, invisibly.
   */
  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) return sourceFiles(full);
      return full.endsWith('.ts') ? [full] : [];
    });
  }

  const SRC = join(__dirname, '../../src');

  it('only errorMessage.ts builds the PAT explanations', () => {
    const users = sourceFiles(SRC)
      .filter((f) => /\bS\.patExpired\b|\bS\.patMissing\b/.test(readFileSync(f, 'utf8')))
      .map((f) => f.replace(/\\/g, '/').split('/src/')[1]);

    // strings.ts DEFINES them; errorMessage.ts is the only consumer.
    expect(users.sort()).toEqual(['tf/errorMessage.ts']);
  });

  it('no caller reaches past it to show originalMessage on its own', () => {
    // The precise shape of the original defect: showErrorMessage handed the
    // raw text while a helper that would have explained it sat unused.
    const offenders = sourceFiles(SRC)
      .filter((f) =>
        /show(Error|Warning)Message\(\s*(scrubSecrets\(\s*)?\w+\.originalMessage/.test(
          readFileSync(f, 'utf8'),
        ),
      )
      .map((f) => f.replace(/\\/g, '/').split('/src/')[1]);

    expect(offenders).toEqual([]);
  });
});
