import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  decodeWithCodePage,
  parseInfoEncoding,
  labelForCodePage,
  isUnsupportedCodePage,
  vscodeEncodingFor,
  isValidUtf8,
} from '../../src/ui/decode.js';

/** windows-1250 bytes for žščćđ. Non-ASCII on purpose — see below. */
const CROATIAN_1250 = Buffer.from([0x9e, 0x9a, 0xe8, 0xe6, 0xf0]);

describe('decodeWithCodePage', () => {
  it('decodes windows-1250 Croatian characters correctly', () => {
    expect(decodeWithCodePage(CROATIAN_1250, 1250)).toBe('žščćđ');
  });

  it('mangles those same bytes as UTF-8 — the bug this prevents', () => {
    // Asserting only `.not.toBe('žščćđ')` passed for '' and for a throw turned
    // into empty. The exact wrong answer is known, so assert it.
    expect(decodeWithCodePage(CROATIAN_1250, undefined)).toBe('�'.repeat(5));
  });

  it('treats 65001 as UTF-8', () => {
    expect(decodeWithCodePage(Buffer.from('žš', 'utf8'), 65001)).toBe('žš');
  });

  it('strips a UTF-8 BOM, which VS Code also strips from the local side', () => {
    // Buffer.toString('utf8') keeps the BOM; TextDecoder drops it. Keeping it
    // gave the server pane one invisible leading character the local pane did
    // not have, so the diff reported the first line as changed for every
    // UTF-8-with-BOM file — essentially everything Visual Studio wrote.
    const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('žš', 'utf8')]);
    expect(decodeWithCodePage(withBom, 65001)).toBe('žš');
  });

  it('falls back to UTF-8 for the -1 binary and -3 folder sentinels', () => {
    // NON-ASCII payload: 'abc' is byte-identical in UTF-8, latin1 and every
    // windows-125x page, so the old assertion held whichever encoding was used
    // and constrained nothing. Mutating the fallback to latin1 left it green.
    const utf8 = Buffer.from('žš', 'utf8');
    expect(decodeWithCodePage(utf8, -1)).toBe('žš');
    expect(decodeWithCodePage(utf8, -3)).toBe('žš');
  });

  it('reads UTF-8 bytes as UTF-8 even when TFVC still records 1250', () => {
    // sqlModule.vb: added as windows-1250, later saved as UTF-8 with no BOM, and
    // `enc` stayed 1250. Decoded as 1250 every Croatian letter became mojibake
    // (ž -> Ĺľ, č -> ÄŤ) and the diff marked each such line as changed, while
    // the local pane showed the identical text correctly.
    const line = "'sadržava tekst i broj za sve vrste PDV, podaci za eRačune";
    expect(decodeWithCodePage(Buffer.from(line, 'utf8'), 1250)).toBe(line);
    // Real cp1250 Croatian is never valid UTF-8, so it still goes to 1250.
    expect(decodeWithCodePage(Buffer.from([0x52, 0x61, 0xe8, 0x75, 0x6e]), 1250)).toBe('Račun');
  });

  it('falls back to UTF-8 for an unknown code page rather than throwing', () => {
    expect(decodeWithCodePage(Buffer.from('žš', 'utf8'), 99999)).toBe('žš');
  });

  describe('code pages beyond the windows-125x family', () => {
    // `windows-${cp}` is only a valid label for 874 and 1250-1258. Everything
    // else threw and fell silently into UTF-8.
    it('decodes ISO-8859-2, which windows-28592 never could', () => {
      expect(decodeWithCodePage(Buffer.from([0xbe, 0xb9]), 28592)).toBe('žš');
    });

    it('decodes UTF-16LE, the case U+FFFD cannot detect', () => {
      // Read as UTF-8 this produces NO replacement characters at all, so the
      // heuristic the rest of the design leans on is blind to it. SSMS writes
      // .sql as UTF-16LE by default and this collection contains .sql files.
      const utf16 = Buffer.from('žš', 'utf16le');
      expect(decodeWithCodePage(utf16, 1200)).toBe('žš');
      expect(decodeWithCodePage(utf16, undefined)).not.toBe('žš');
      expect(decodeWithCodePage(utf16, undefined)).not.toContain('�');
    });

    it('knows which code pages it cannot honour', () => {
      expect(isUnsupportedCodePage(1250)).toBe(false);
      expect(isUnsupportedCodePage(28592)).toBe(false);
      expect(isUnsupportedCodePage(99999)).toBe(true);
      expect(isUnsupportedCodePage(undefined)).toBe(false);
      expect(labelForCodePage(1250)).toBe('windows-1250');
      expect(labelForCodePage(99999)).toBeUndefined();
    });
  });
});

describe('parseInfoEncoding', () => {
  const INFO = readFileSync(join(__dirname, '../fixtures/windows/info.txt'), 'utf8');

  it('reads the code page from a REAL tf vc info capture', () => {
    // That capture is of a file with `Change : none` — not pending — which is
    // exactly the case the pending-changes cache cannot answer, and where the
    // content was previously decoded as UTF-8.
    expect(parseInfoEncoding(INFO)).toBe(1250);
  });

  it('maps the labels tf actually emits', () => {
    expect(parseInfoEncoding('  File type    : utf-8')).toBe(65001);
    expect(parseInfoEncoding('  File type    : binary')).toBe(-1);
    expect(parseInfoEncoding('  File type    : utf-16le')).toBe(1200);
    expect(parseInfoEncoding('  File type    : iso-8859-2')).toBe(28592);
    expect(parseInfoEncoding('  File type    : US-ASCII')).toBe(65001);
  });

  it('returns undefined rather than guessing', () => {
    expect(parseInfoEncoding('')).toBeUndefined();
    expect(parseInfoEncoding('Local information:\n  Type : file')).toBeUndefined();
    expect(parseInfoEncoding('  File type    : something-new')).toBeUndefined();
  });
});

describe('vscodeEncodingFor', () => {
  it('uses VS Code ids, which are NOT the WHATWG labels', () => {
    // windows-1250 vs windows1250, iso-8859-2 vs iso88592. Deriving one table
    // from the other would be a guess in both directions.
    expect(vscodeEncodingFor(1250)).toBe('windows1250');
    expect(vscodeEncodingFor(28592)).toBe('iso88592');
    expect(vscodeEncodingFor(65001)).toBe('utf8');
    expect(vscodeEncodingFor(1200)).toBe('utf16le');
  });

  it('returns undefined rather than guessing, including for the sentinels', () => {
    expect(vscodeEncodingFor(-1)).toBeUndefined();
    expect(vscodeEncodingFor(-3)).toBeUndefined();
    expect(vscodeEncodingFor(99999)).toBeUndefined();
    expect(vscodeEncodingFor(undefined)).toBeUndefined();
  });
});

describe('isValidUtf8 — the gate that keeps the encoding fix free', () => {
  it('accepts ASCII and real UTF-8', () => {
    expect(isValidUtf8(Buffer.from('plain ascii'))).toBe(true);
    expect(isValidUtf8(Buffer.from('Račun za Đakovo', 'utf8'))).toBe(true);
    expect(isValidUtf8(Buffer.alloc(0))).toBe(true);
  });

  it('rejects windows-1250 bytes, which is the whole point', () => {
    // 0x9e is ž in cp1250 and an invalid UTF-8 start byte — exactly what made
    // frmDeposits.vb render as mojibake.
    expect(isValidUtf8(Buffer.from([0x4f, 0x73, 0x76, 0x6a, 0x65, 0x9e, 0x69]))).toBe(false);
  });

  it('is FATAL, not lenient', () => {
    // A non-fatal decoder returns U+FFFD instead of throwing, so this would
    // report every mis-encoded file as valid and the fix would never fire.
    expect(isValidUtf8(Buffer.from([0xff, 0xfe, 0x9e]))).toBe(false);
  });
});
