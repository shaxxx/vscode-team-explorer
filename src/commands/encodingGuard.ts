/**
 * Detects a document VS Code has already mis-decoded, where saving would
 * permanently destroy bytes.
 *
 * THE HAZARD, measured:
 *
 *   66,678 of 79,929 items in this collection are `enc="1250"` (windows-1250).
 *   VS Code's `files.encoding` defaults to `utf8` and `files.autoGuessEncoding`
 *   defaults to `false`, so it reads those files as UTF-8. Every byte that is
 *   not valid UTF-8 becomes U+FFFD in the editor buffer, and saving writes that
 *   back as EF BF BD. The original byte is gone.
 *
 *     on disk (cp1250)  27 20 49 7a 72 61 e8 75 ...   "' Izračunaj"
 *     saved as utf8     27 20 49 7a 72 61 efbfbd 75   "' Izra?unaj"
 *
 *   Before this extension, the read-only bit was what prevented that: VS Code
 *   cannot silently save over a read-only file. Auto-checkout clears the bit on
 *   the first keystroke — so the extension removes the only thing standing
 *   between a mis-decoded buffer and a destroyed file, before the user has
 *   typed a second character. The corruption then becomes a pending Edit, sits
 *   in Included Changes, and is one Check In from permanent and shared.
 *
 * The detector is the decoded text itself rather than the `enc` attribute:
 * U+FFFD is present exactly when the decode was lossy, it needs no round trip
 * to the server, and it works before the file is pending. A genuine UTF-8 file
 * containing a real U+FFFD is possible but rare, and warning about it is the
 * right response anyway.
 *
 * Deliberately `vscode`-free so it can be unit-tested.
 */

/** U+FFFD REPLACEMENT CHARACTER — what a lossy decode leaves behind. */
const REPLACEMENT = '�';

export function wouldCorruptOnSave(text: string): boolean {
  return text.includes(REPLACEMENT);
}

/** How many bytes would be destroyed, for a message worth reading. */
export function countReplacements(text: string): number {
  let n = 0;
  for (const ch of text) if (ch === REPLACEMENT) n++;
  return n;
}
