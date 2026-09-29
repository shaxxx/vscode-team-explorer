import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Writes a check-in comment to a temp file for `tf vc checkin /comment:@file`.
 *
 * WHY a file rather than the command line: even correctly quoted, an argument
 * passed through cmd.exe is still subject to `%VAR%` expansion, so a comment
 * mentioning `%PATH%` or `%TEMP%` is silently replaced with the variable's
 * value and that lands permanently in TFVC history. A newline in a pasted
 * comment truncates it. The file form sidesteps the command line entirely.
 *
 * ENCODING — note this is the OPPOSITE of the rule for pat.txt:
 *
 *   pat.txt      must have NO BOM. tfp.cmd reads it with `set /p`, which does
 *                not strip one, so a BOM becomes part of the token.
 *   commentfile  is written WITH a BOM. tf.exe is .NET, and .NET's text readers
 *                detect a BOM and decode accordingly. Without one the encoding
 *                is whatever tf happens to default to, which on this Croatian
 *                machine risks mangling č ć ž š đ in the comment. A BOM makes
 *                it unambiguous.
 *
 * Deliberately `vscode`-free so it can be unit-tested.
 */
export function writeCommentFile(comment: string): { path: string; dispose: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'tfvc-comment-'));
  const path = join(dir, 'comment.txt');

  // The BOM is written from its code point rather than as a literal U+FEFF in
  // the source. It worked as a literal, but it is invisible in a diff and in
  // an editor, so any "strip invisible characters" pass or a copy through a
  // sanitising tool would delete it in a change nobody could read.
  const BOM = '﻿';
  writeFileSync(path, BOM + comment, { encoding: 'utf8' });

  return {
    path,
    dispose: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // A leftover temp file is not worth failing a check-in over.
      }
    },
  };
}
