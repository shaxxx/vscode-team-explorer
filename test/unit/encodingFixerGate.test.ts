import { describe, it, expect } from 'vitest';
import { certainlyDecodedCorrectly } from '../../src/commands/encodingFixer.js';

/**
 * The gate in front of `tf vc info`. Getting it wrong in the permissive
 * direction is silent: the file renders as mojibake and nothing ever asks tf
 * what encoding it actually is.
 *
 * The first version was `isValidUtf8(bytes)` alone, which answers a different
 * question — whether the BYTES are valid UTF-8, not whether VS Code's read of
 * them produced the right characters.
 */

/** A real windows-1250 line: "' Izračunaj za županiju". */
const CP1250 = Buffer.from([
  0x27, 0x20, 0x49, 0x7a, 0x72, 0x61, 0xe8, 0x75, 0x6e, 0x61, 0x6a,
  0x20, 0x7a, 0x61, 0x20, 0x8e, 0x75, 0x70, 0x61, 0x6e, 0x69, 0x6a, 0x75,
]);

const UTF8 = Buffer.from('Račun za Đakovo — čćžšđ', 'utf8');
const UTF8_BOM = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), UTF8]);
const ASCII = Buffer.from('const x = 1;', 'utf8');

/** UTF-16LE with no BOM, as SSMS writes .sql by default. */
const UTF16LE_NO_BOM = Buffer.from('SELECT 1', 'utf16le');
const UTF16LE_BOM = Buffer.concat([Buffer.from([0xff, 0xfe]), UTF16LE_NO_BOM]);

describe('when the read is certainly correct', () => {
  it('accepts UTF-8 bytes read as UTF-8', () => {
    expect(certainlyDecodedCorrectly(UTF8, 'utf8')).toBe(true);
  });

  it('accepts a BOM, which VS Code strips and still reads as UTF-8', () => {
    expect(certainlyDecodedCorrectly(UTF8_BOM, 'utf8bom')).toBe(true);
  });

  it('accepts plain ASCII, which every candidate encoding agrees on', () => {
    expect(certainlyDecodedCorrectly(ASCII, 'utf8')).toBe(true);
  });

  it('accepts an empty file', () => {
    expect(certainlyDecodedCorrectly(Buffer.alloc(0), 'utf8')).toBe(true);
  });
});

describe('when it cannot be certain, and must ask tf', () => {
  it('rejects UTF-8 bytes read as something else', () => {
    // THE HOLE. `files.encoding` is global; setting it to windows1250 is a
    // reasonable thing to try in a collection that is mostly windows-1250, and
    // it makes every UTF-8 file render as mojibake. The bytes are valid UTF-8,
    // so the old gate returned early and never asked tf.
    expect(certainlyDecodedCorrectly(UTF8, 'windows1250')).toBe(false);
  });

  it('rejects UTF-16 with no BOM, even though those bytes ARE valid UTF-8', () => {
    // The case decode.ts calls dangerous: no U+FFFD appears anywhere, so
    // nothing downstream can notice it either.
    expect(certainlyDecodedCorrectly(UTF16LE_NO_BOM, 'utf8')).toBe(false);
  });

  it('rejects windows-1250 bytes read as UTF-8', () => {
    // Already handled before this change, and must stay handled: 0xe8 begins a
    // 3-byte sequence that the following ASCII byte cannot continue.
    expect(certainlyDecodedCorrectly(CP1250, 'utf8')).toBe(false);
  });

  it('rejects an undefined encoding rather than assuming UTF-8', () => {
    expect(certainlyDecodedCorrectly(UTF8, undefined)).toBe(false);
  });

  it('rejects a correct non-UTF-8 read too, which costs one cached lookup', () => {
    // windows-1250 bytes read as windows1250 IS right, but nothing local can
    // prove that, so it goes on to ask tf — which answers 1250, matches, and
    // returns without reopening. Erring this way costs a lookup; erring the
    // other way shows the user mojibake.
    expect(certainlyDecodedCorrectly(CP1250, 'windows1250')).toBe(false);
  });
});

describe('the UTF-8 validity check still carries its own weight', () => {
  it('a BOM-carrying UTF-16 file fails on its first two bytes', () => {
    expect(certainlyDecodedCorrectly(UTF16LE_BOM, 'utf8')).toBe(false);
  });

  it('a lone continuation byte is not valid UTF-8', () => {
    expect(certainlyDecodedCorrectly(Buffer.from([0x41, 0x80, 0x42]), 'utf8')).toBe(false);
  });
});
