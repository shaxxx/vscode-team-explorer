import { diffArrays } from 'diff';
import { DIFF_LIMITS, type DiffLimits, type Owner } from './blame.js';

/**
 * Test-only visibility into how many times `lineMap` actually ran a diff, as
 * opposed to the Annotator reusing a cached result (D17b). Not read by any
 * production code; a plain counter is simpler and less brittle under ESM than
 * spying on the module's own export.
 */
export let lineMapCalls = 0;

/**
 * Where each buffer line came from, against the base version. `-1` means
 * the user inserted or changed that line; otherwise the
 * value is the BASE line index it matches.
 *
 * Split out of `remap()` so the Annotator can cache the map itself (keyed on
 * the document's `version` and the session's `baseLines`) and skip this diff
 * entirely on a progress render that only has new owners to show -- the map
 * from base lines to buffer lines does not change just because more of the
 * walk has folded in. In memory, no tf: this runs after every pause in
 * typing, so the diff is bounded (D11) the same way the blame walk is -- a
 * huge paste or a fully rewritten file must not block typing.
 */
export function lineMap(
  baseLines: readonly string[],
  buffer: readonly string[],
  limits: DiffLimits = DIFF_LIMITS,
): number[] {
  lineMapCalls++;
  const parts = diffArrays([...baseLines], [...buffer], limits);
  if (parts === undefined) return lineMapByPrefixSuffix(baseLines, buffer);
  const out: number[] = [];
  let base = 0;
  for (const part of parts) {
    const n = part.value.length;
    if (part.added) {
      for (let k = 0; k < n; k++) out.push(-1);
    } else if (part.removed) {
      base += n;
    } else {
      for (let k = 0; k < n; k++) out.push(base++);
    }
  }
  return out;
}

/**
 * The base attribution, moved onto what the editor holds now.
 *
 * Lines the user inserted or changed are `local`; unchanged lines keep the
 * owner of the base line they match.
 */
export function remap(
  baseLines: readonly string[],
  owners: readonly Owner[],
  buffer: readonly string[],
  limits: DiffLimits = DIFF_LIMITS,
): Owner[] {
  return lineMap(baseLines, buffer, limits).map((i): Owner => (i === -1 ? { kind: 'local' } : (owners[i] ?? { kind: 'pending' })));
}

/**
 * The diff gave up: rather than guess at the middle, keep the map only for
 * the common prefix and common suffix (plain `===`, no diff) and mark every
 * buffer line between them `-1` (local). The two never overlap: each is
 * capped at `min(baseLines.length, buffer.length)` minus the other.
 */
function lineMapByPrefixSuffix(baseLines: readonly string[], buffer: readonly string[]): number[] {
  const shorter = Math.min(baseLines.length, buffer.length);

  let prefix = 0;
  while (prefix < shorter && baseLines[prefix] === buffer[prefix]) prefix++;

  const maxSuffix = shorter - prefix;
  let suffix = 0;
  while (suffix < maxSuffix && baseLines[baseLines.length - 1 - suffix] === buffer[buffer.length - 1 - suffix]) {
    suffix++;
  }

  const out: number[] = new Array(buffer.length);
  for (let i = 0; i < prefix; i++) out[i] = i;
  for (let i = 0; i < suffix; i++) out[buffer.length - 1 - i] = baseLines.length - 1 - i;
  for (let i = prefix; i < buffer.length - suffix; i++) out[i] = -1;
  return out;
}
