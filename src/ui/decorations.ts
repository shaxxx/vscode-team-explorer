import type { FileState } from '../state/FileState.js';
import { S } from '../tf/strings.js';

export interface Glyph {
  /**
   * At most two UTF-16 units.
   *
   * VS Code's own limit is two GRAPHEME CLUSTERS:
   * `FileDecoration.validate` in `extHostTypes.ts` throws
   * "The 'badge'-property must be undefined or a short character", and
   * `extHostDecorations.ts` catches that and drops the ENTIRE decoration --
   * badge, colour and tooltip -- leaving one line in the extension-host log.
   * An over-long badge therefore renders NOTHING, silently. (Read 2026-09-17.)
   *
   * Two UTF-16 units is a stricter budget than two graphemes, deliberately: it
   * is simple to test, and it is what fits at the end of a tree row. The lock
   * is a surrogate pair and already spends both, so a swap has no headroom.
   */
  readonly badge: string;
  /**
   * A ThemeColor id. Task 6 contributes these in package.json; until it
   * does, nothing resolves them.
   */
  readonly color: string;
  readonly tooltip: string;
  /**
   * Whether VS Code bubbles this decoration up to the parent folders.
   *
   * What bubbling does, at source (read 2026-09-17): the ancestor takes this
   * decoration's COLOUR, and its badge becomes a grey dot -- the codicon at
   * U+EA71, 0.4 opacity -- with the tooltip "Contains emphasized items".
   *
   * That replacement is UNCONDITIONAL, and it is the part worth knowing.
   * `decorationsService.getDecoration` sets its `containsChildren` flag
   * whenever any descendant bubbles, without checking whether the ancestor has
   * a decoration of its own, and `asDecoration` then overwrites both badge and
   * tooltip. So a folder with a pending Add shows the dot rather than `+` as
   * soon as anything inside it is pending: propagation costs the ancestor its
   * OWN state, it does not merely add to it.
   */
  readonly propagate: boolean;
}

/**
 * Visual Studio's Solution Explorer glyphs, at the user's request.
 *
 * ABSENCE IS THE SIGNAL. Five states -- `notVersioned`, `ignored`,
 * `folderNotPending`, `unmapped` and `unknown` -- are explicit `null` entries
 * below, not missing keys. A file that is not in source control has no badge
 * BECAUSE everything else has one. That is what makes the lock load-bearing
 * rather than decorative, and it is why giving any of those five a glyph
 * would quietly break the scheme.
 *
 * One consequence, accepted deliberately: no badge is ambiguous. It covers a
 * genuinely addable new file, a file inside node_modules, and a file outside
 * any mapping. The SCM panel's "Not in source control" group is what separates
 * them -- the tree answers "is this tracked?", the panel answers "what can I
 * add?".
 *
 * The lock is PROVISIONAL. The user's words: "we can always change lock with
 * something else in the future." Changing it means editing this table and the
 * codepoint assertion in glyphs.test.ts -- deliberately two places, so a swap
 * is a decision rather than a typo.
 */
export const GLYPHS: Readonly<Record<FileState, Glyph | null>> = {
  versioned: {
    badge: '\u{1F512}', // 🔒 -- kept as an escape because the literal is unreadable
    color: 'teamExplorer.versionedForeground',
    tooltip: S.glyphVersioned,
    // NOT propagated, unlike every other glyph here. See the test.
    propagate: false,
  },
  // checkedOut and pendingRename deliberately share this colour id: both mean
  // "you have this open for change", and Task 6 should contribute one
  // ThemeColor for that meaning rather than two that always render the same.
  checkedOut: {
    badge: '✓',
    color: 'teamExplorer.checkedOutForeground',
    tooltip: S.glyphCheckedOut,
    propagate: true,
  },
  pendingAdd: {
    badge: '+',
    color: 'teamExplorer.addedForeground',
    tooltip: S.glyphPendingAdd,
    propagate: true,
  },
  pendingDelete: {
    badge: '−', // minus sign, not a hyphen
    color: 'teamExplorer.deletedForeground',
    tooltip: S.glyphPendingDelete,
    propagate: true,
  },
  pendingRename: {
    badge: '→',
    color: 'teamExplorer.checkedOutForeground',
    tooltip: S.glyphPendingRename,
    propagate: true,
  },
  writableNotCheckedOut: {
    badge: '!',
    color: 'teamExplorer.hazardForeground',
    tooltip: S.glyphHazard,
    propagate: true,
  },

  // The five below draw NOTHING, and that is the design, not an omission.
  // Absence is the signal: a file not in source control has no badge BECAUSE
  // everything else has one. `null` rather than a missing key so that adding a
  // twelfth FileState is a compile error here, not a silent no-badge.
  notVersioned: null,      // genuinely new. The SCM panel lists it; the tree stays quiet.
  ignored: null,           // matched an ignore pattern. Never ours to talk about.
  folderNotPending: null,  // a folder with nothing pending. Final, not "not yet known".
  unmapped: null,          // outside every workspace mapping.
  unknown: null,           // nothing has answered yet.
};

/**
 * The same glyph, dimmed, for a file deliberately held back from check-in.
 *
 * A separate colour rather than a separate badge: the file's STATE has not
 * changed -- it is still checked out, still added -- only its fate at the next
 * check-in has. Changing the letter would say the wrong thing.
 *
 * A function rather than a second table, so the two cannot drift: every entry
 * `GLYPHS` draws is reachable through here with the same badge and
 * propagation, and only the colour and tooltip change.
 */
export function excluded(glyph: Glyph): Glyph {
  return { ...glyph, color: 'teamExplorer.excludedForeground', tooltip: `${glyph.tooltip}${S.excludedTooltipSuffix}` };
}
