import { readFileSync } from 'node:fs';
import type { PendingChange } from '../tf/types.js';
import { isBinary, isPendingAdd } from '../tf/types.js';
import { looksLikeText } from './decode.js';

export type CompareVerdict = 'ok' | 'unmapped' | 'pendingAdd' | 'binary';

/**
 * Whether "Compare with Latest Version" can show anything, and if not, why.
 *
 * The command used to reuse QuickDiff.provideOriginalResource, which returns
 * undefined for any file with NO PENDING CHANGE — correct for gutter bars,
 * since an unmodified file has nothing to draw, but wrong here. `tf vc view
 * /version:T` works for any item under version control, and comparing a file
 * you have not checked out yet is a normal thing to want. The command did
 * nothing at all for those files, with no message: indistinguishable from the
 * extension being broken.
 *
 * `localIsText` is asked only for a file TFVC labels binary, which can be
 * plain text (Shop.Api.xml); it reads the disk, so nothing else pays for it.
 *
 * Pure apart from that, so the decision is testable without the extension host.
 */
export function compareVerdict(
  mapped: boolean,
  change: PendingChange | undefined,
  localIsText: () => boolean = () => false,
): CompareVerdict {
  if (!mapped) return 'unmapped';
  // A pending Add exists only locally — there is no server version to diff.
  if (change && isPendingAdd(change)) return 'pendingAdd';
  if (change && isBinary(change) && !localIsText()) return 'binary';
  // No pending change is FINE: compare the working file against the tip.
  return 'ok';
}

/** The local file's bytes look like text; false when it cannot be read. */
export function localLooksLikeText(fsPath: string): boolean {
  try {
    return looksLikeText(readFileSync(fsPath));
  } catch {
    return false;
  }
}
