import { describe, it, expect } from 'vitest';
import { classifyError, scanAffectedItems, scrubSecrets, TfClient } from '../../src/tf/TfClient.js';

describe('classifyError', () => {
  it('recognises a wrapper failure by its [tfp] prefix', () => {
    const e = classifyError(1, '', '[tfp] PAT file not found: C:\\Users\\x\\.tfs\\pat.txt');
    expect(e!.kind).toBe('patMissing');
  });

  it('recognises a missing Wine prefix', () => {
    const e = classifyError(1, '', '[tfp] Wine prefix not found: /home/shax/.wine-tf');
    expect(e!.kind).toBe('wineMissing');
  });

  it('classifies on the TF code, not the message language', () => {
    const croatian = classifyError(100, 'TF14098: Pristup je odbijen.', '');
    const english = classifyError(100, 'TF14098: Access denied.', '');
    expect(croatian!.kind).toBe(english!.kind);
    expect(croatian!.code).toBe('TF14098');
  });

  it('ALWAYS keeps the original message verbatim', () => {
    const original = 'TF10120: The value xml is not supported for option format.';
    expect(classifyError(100, original, '')!.originalMessage).toBe(original);
  });

  it('falls back to unknown, with the raw text as the message', () => {
    const e = classifyError(100, 'something nobody anticipated', '');
    expect(e!.kind).toBe('unknown');
    expect(e!.originalMessage).toBe('something nobody anticipated');
  });

  it('scrubs a token out of the message it builds, so consumers cannot leak it', () => {
    // The wrapper appends /login: to tf's command line, so a tf error that
    // quotes the command back at us would otherwise carry the PAT into every
    // output channel and dialog that prints originalMessage.
    const leaked = 'TF14098: failed running TF.exe status /login:.,abc123secret /noprompt';
    const e = classifyError(100, leaked, '');

    expect(e!.originalMessage).not.toContain('abc123secret');
    expect(e!.originalMessage).toContain('/login:***');
    expect(e!.code).toBe('TF14098');
  });

  it('returns undefined when the command succeeded', () => {
    expect(classifyError(0, '', '')).toBeUndefined();
  });

  it('never returns an empty message, which would show a blank dialog', () => {
    const e = classifyError(-1, '', '');
    expect(e!.originalMessage).not.toBe('');
    expect(e!.originalMessage).toContain('-1');
  });

  it('recognises our own wrapper-not-found refusal', () => {
    const e = classifyError(-1, '', '[tfvc] Wrapper not found: C:\\Users\\user1\\bin\\tfp.cmd');
    expect(e?.kind).toBe('wrapperMissing');
    expect(e?.originalMessage).toContain('C:\\Users\\user1\\bin\\tfp.cmd');
  });

  it('classifies exit 127 as a command the wrapper needs but could not find', () => {
    const e = classifyError(127, '', '/home/user1/bin/tfp: line 73: exec: wine: not found');
    expect(e?.kind).toBe('commandNotFound');
    expect(e?.originalMessage).toContain('wine: not found');
  });

  it('prefers a TF code over exit 127', () => {
    expect(classifyError(127, '', 'TF30063: You are not authorized')?.kind).toBe('patRejected');
  });
});

describe('scanAffectedItems', () => {
  it('reads the items out of checkout output', () => {
    const out = [
      'C:\\work\\Shop\\Shop2023\\Raverus.FiskalizacijaDEV.Standard\\PopratneFunkcije:',
      'Potpisivanje.cs',
      '',
    ].join('\r\n');

    expect(scanAffectedItems(out)).toEqual([
      'C:\\work\\Shop\\Shop2023\\Raverus.FiskalizacijaDEV.Standard\\PopratneFunkcije\\Potpisivanje.cs',
    ]);
  });

  it('reads the items out of undo output, stripping the verb', () => {
    const out = ['C:\\work\\Shop:', 'Undoing edit: Potpisivanje.cs', ''].join('\r\n');
    expect(scanAffectedItems(out)).toEqual(['C:\\work\\Shop\\Potpisivanje.cs']);
  });

  it('returns nothing for empty output', () => {
    expect(scanAffectedItems('')).toEqual([]);
  });
});

describe('scrubSecrets', () => {
  it('removes a login argument even though we never build one', () => {
    expect(scrubSecrets('TF.exe status /login:.,abc123secret /noprompt'))
      .toBe('TF.exe status /login:*** /noprompt');
  });
});

describe('scrubSecrets covers the shapes that actually occur', () => {
  const T = 'zz7fakefaketokenfake4example5678';

  // runMutation logs tf's OWN stdout and stderr, not just our argv, so this is
  // load-bearing. The original pattern matched one shape and let six through.
  const shapes: [string, string][] = [
    ['the wrapper form', `/noprompt /loginType:OAuth /login:.,${T}`],
    ['uppercase', `/LOGIN:.,${T}`],
    ['dash prefix, which TF also accepts', `-login:.,${T}`],
    ['equals separator', `/login=.,${T}`],
    ['a space after the colon', `/login: .,${T}`],
    ['a set dump', `TFSPAT=${T}`],
    ['a URL query parameter', `https://acme.visualstudio.com/?pat=${T}`],
    ['URL userinfo', `https://user:${T}@acme.visualstudio.com/`],
  ];

  for (const [name, text] of shapes) {
    it(`redacts ${name}`, () => {
      expect(scrubSecrets(text)).not.toContain(T);
    });
  }

  it('leaves ordinary output alone', () => {
    const ok = 'TF14098: Access denied. $/Vesta/Racun.cs is not checked out.';
    expect(scrubSecrets(ok)).toBe(ok);
  });
});

describe('the command log', () => {
  it('records every invocation and its outcome', async () => {
    // The TFVC output channel was completely EMPTY in the real extension host:
    // nothing logged unless a command failed or a mutation ran. That left no
    // diagnostic trail at all, and made "the log contains no token"
    // unverifiable, because there was no log.
    const lines: string[] = [];
    const client = new TfClient({
      wrapperPath: process.execPath,
      timeoutMs: 10_000,
      argsPrefix: ['-e', 'process.stdout.write("hi")'],
      log: (l) => lines.push(l),
    });

    await client.run(['vc', 'status']);

    expect(lines[0]).toContain('tfp');
    expect(lines[0]).toContain('vc status');
    expect(lines.join('\n')).toMatch(/-> exit 0/);
    expect(lines.join('\n')).toMatch(/\d+ bytes/);
  });

  it('never writes a token into the log, even when one is in the arguments', async () => {
    const lines: string[] = [];
    const client = new TfClient({
      wrapperPath: process.execPath,
      timeoutMs: 10_000,
      argsPrefix: ['-e', 'process.stdout.write("")'],
      log: (l) => lines.push(l),
    });

    // The extension never builds /login:, but the log must hold regardless.
    await client.run(['vc', 'status', '/login:.,zz7fakefaketokenfake4example5678']);

    expect(lines.join('\n')).not.toContain('zz7fakefaketokenfake4example5678');
    expect(lines.join('\n')).toContain('/login:***');
  });
});
