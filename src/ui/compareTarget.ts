import type { PendingChange } from '../tf/types.js';
import { isBinary, isPendingAdd } from '../tf/types.js';

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
 * Pure, so the decision is testable without the extension host.
 */
export function compareVerdict(
  mapped: boolean,
  change: PendingChange | undefined,
): CompareVerdict {
  if (!mapped) return 'unmapped';
  // A pending Add exists only locally — there is no server version to diff.
  if (change && isPendingAdd(change)) return 'pendingAdd';
  if (change && isBinary(change)) return 'binary';
  // No pending change is FINE: compare the working file against the tip.
  return 'ok';
}
