/**
 * `enc` is a code page, with two sentinels: -1 binary, -3 not applicable.
 * 1250 is by far the most common value in this collection (66,678 of 79,929).
 */

/** Sentinels tf uses in place of a code page. */
export const ENC_BINARY = -1;
export const ENC_NOT_APPLICABLE = -3;

/**
 * Code page -> WHATWG label.
 *
 * `new TextDecoder(\`windows-${cp}\`)` only produces a valid label for 874 and
 * 1250-1258. Everything else threw and fell into a silent `toString('utf8')`:
 *
 *   28591 (ISO-8859-1)  <e9 e8>  -> 2 x U+FFFD
 *   932   (Shift-JIS)   <82 a0>  -> 2 x U+FFFD
 *   1200  (UTF-16LE)    "žš"     -> "~a"  and NO U+FFFD at all
 *
 * The 1200/1201 rows are the dangerous ones: UTF-16 read as UTF-8 leaves no
 * replacement characters, so the U+FFFD heuristic this design leans on cannot
 * see it. SSMS writes .sql as UTF-16LE by default and this collection contains
 * .sql files, so it is not hypothetical.
 */
const LABELS: Readonly<Record<number, string>> = {
  437: 'ibm866', // closest supported; DOS US, rare here
  850: 'ibm866',
  866: 'ibm866',
  874: 'windows-874',
  932: 'shift_jis',
  936: 'gbk',
  949: 'euc-kr',
  950: 'big5',
  1200: 'utf-16le',
  1201: 'utf-16be',
  1250: 'windows-1250',
  1251: 'windows-1251',
  1252: 'windows-1252',
  1253: 'windows-1253',
  1254: 'windows-1254',
  1255: 'windows-1255',
  1256: 'windows-1256',
  1257: 'windows-1257',
  1258: 'windows-1258',
  10000: 'macintosh',
  20866: 'koi8-r',
  21866: 'koi8-u',
  28591: 'iso-8859-1',
  28592: 'iso-8859-2',
  28595: 'iso-8859-5',
  28597: 'iso-8859-7',
  28599: 'iso-8859-9',
  28605: 'iso-8859-15',
  65000: 'utf-8', // UTF-7 is unsupported; utf-8 is the least-wrong fallback
  65001: 'utf-8',
};

/** The WHATWG label for a tf code page, or undefined if we have none. */
export function labelForCodePage(codePage: number): string | undefined {
  return LABELS[codePage];
}

/**
 * True when we cannot decode this code page faithfully, so the caller should
 * say so rather than render mojibake as if it were the file.
 */
export function isUnsupportedCodePage(codePage: number | undefined): boolean {
  if (codePage === undefined) return false;
  if (codePage < 0) return false; // sentinels are handled separately
  return labelForCodePage(codePage) === undefined;
}

/**
 * Whether these bytes are UTF-8 although TFVC records another code page.
 *
 * `enc` is set when the item is added and survives later check-ins, so a file
 * added as windows-1250 and since saved as UTF-8 with no BOM stays enc=1250
 * while its bytes are UTF-8. Decoding them as 1250 turned every č/ž into
 * ÄŤ/Ĺľ, and the diff marked each such line as changed, against a local pane
 * that EncodingFixer leaves as UTF-8 for the same valid-UTF-8 bytes.
 *
 * Valid UTF-8 is decisive for the legacy pages: a cp1250 č (E8) or ž (9E)
 * next to an ASCII letter is never a valid UTF-8 sequence, and pure ASCII
 * decodes identically either way. Not for UTF-16: 'žš' in UTF-16LE is
 * 7E 01 61 01, which is valid UTF-8, so there TFVC's code page stands.
 */
function isUtf8DespiteCodePage(bytes: Buffer, codePage: number): boolean {
  if (codePage === 1200 || codePage === 1201) return false;
  return isValidUtf8(bytes);
}

export function decodeWithCodePage(bytes: Buffer, codePage: number | undefined): string {
  const label =
    codePage === undefined || codePage < 0 || isUtf8DespiteCodePage(bytes, codePage)
      ? 'utf-8'
      : (labelForCodePage(codePage) ?? 'utf-8');

  try {
    // TextDecoder strips a leading BOM; Buffer.toString('utf8') does NOT, and
    // VS Code strips it from the local document — so the server pane gained an
    // invisible leading character the local pane lacked, and the diff reported
    // the first line as changed for every UTF-8-with-BOM file, i.e. essentially
    // every file Visual Studio wrote.
    return new TextDecoder(label).decode(bytes);
  } catch {
    return bytes.toString('utf8');
  }
}

/**
 * Reads the code page out of `tf vc info` text output.
 *
 * Real capture (test/fixtures/windows/info.txt), for a file with
 * `Change     : none` — i.e. NOT pending, which is the whole point:
 *
 *   Server information:
 *     File type    : windows-1250
 *
 * tf reports a LABEL here, not a number, so it is mapped back to the code page
 * the rest of the pipeline speaks. Returns undefined when there is no usable
 * value, so the caller can fall back rather than assert a wrong encoding.
 *
 * This is text, not XML, so it deliberately does not live in parse.ts.
 */
export function parseInfoEncoding(stdout: string): number | undefined {
  const match = /^\s*File type\s*:\s*(\S+)/im.exec(stdout);
  if (!match) return undefined;

  const label = match[1].toLowerCase();
  if (label === 'binary') return ENC_BINARY;
  if (label === 'utf-8' || label === 'utf8') return 65001;
  if (label === 'utf-16' || label === 'utf-16le' || label === 'unicode') return 1200;
  if (label === 'utf-16be') return 1201;
  // ASCII is a strict subset of UTF-8, so decoding it as UTF-8 is lossless.
  if (label === 'us-ascii' || label === 'ascii') return 65001;

  const windows = /^windows-(\d{3,5})$/.exec(label);
  if (windows) return Number(windows[1]);

  const iso = /^iso-8859-(\d{1,2})$/.exec(label);
  if (iso) return 28590 + Number(iso[1]);

  return undefined;
}

/**
 * VS Code's own encoding id for a tf code page, for
 * `workspace.openTextDocument(uri, { encoding })`.
 *
 * These ids are NOT the WHATWG labels used above — VS Code spells them
 * 'windows1250', 'iso88592', 'utf16le'. Keep the two tables separate rather
 * than deriving one from the other; they disagree in enough places that a
 * transformation would be a guess.
 */
const VSCODE_IDS: Readonly<Record<number, string>> = {
  866: 'cp866',
  874: 'windows874',
  932: 'shiftjis',
  936: 'gbk',
  949: 'euckr',
  950: 'big5',
  1200: 'utf16le',
  1201: 'utf16be',
  1250: 'windows1250',
  1251: 'windows1251',
  1252: 'windows1252',
  1253: 'windows1253',
  1254: 'windows1254',
  1255: 'windows1255',
  1256: 'windows1256',
  1257: 'windows1257',
  1258: 'windows1258',
  10000: 'macroman',
  20866: 'koi8r',
  21866: 'koi8ru',
  28591: 'iso88591',
  28592: 'iso88592',
  28595: 'iso88595',
  28597: 'iso88597',
  28599: 'iso88599',
  28605: 'iso885915',
  65001: 'utf8',
};

export function vscodeEncodingFor(codePage: number | undefined): string | undefined {
  if (codePage === undefined || codePage < 0) return undefined;
  return VSCODE_IDS[codePage];
}

/**
 * Whether the bytes are valid UTF-8.
 *
 * This is the cheap local gate that keeps the whole encoding fix free for the
 * files that do not need it. Measured over C:\work (up to 4,000 files per
 * type, excluding node_modules/bin/obj):
 *
 *   .ts .sql .js .json .md .xml   0% invalid
 *   .cs                           0.8% invalid   (30 of 4,000)
 *   .vb                          11.7% invalid  (468 of 4,000)
 *
 * So for the overwhelming majority we answer "VS Code read it correctly"
 * without touching the network at all, and only ask tf for the code page when
 * the bytes prove VS Code cannot have been right.
 */
export function isValidUtf8(bytes: Buffer): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}
