import { describe, it, expect } from 'vitest';
import { storedPat } from '../../src/commands/setPat.js';

function secrets(value: string | undefined) {
  return { get: async () => value } as never;
}

describe('storedPat', () => {
  it('returns the saved token', async () => {
    expect(await storedPat(secrets('abc123'))).toBe('abc123');
  });

  it('trims, because the keychain round trip can carry whitespace', async () => {
    expect(await storedPat(secrets('  abc123\n'))).toBe('abc123');
  });

  it('treats an EMPTY saved token as no token at all', async () => {
    // Otherwise the extension offers "Rewrite pat.txt from saved token" and
    // then writes an empty file -- turning a recoverable auth failure into
    // the exact state the wrapper reports as "PAT file is empty".
    expect(await storedPat(secrets(''))).toBeUndefined();
    expect(await storedPat(secrets('   \n'))).toBeUndefined();
  });

  it('returns undefined when nothing was ever saved', async () => {
    expect(await storedPat(secrets(undefined))).toBeUndefined();
  });
});
