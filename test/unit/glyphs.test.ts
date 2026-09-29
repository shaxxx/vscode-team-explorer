import { describe, it, expect } from 'vitest';
import { GLYPHS, excluded, type Glyph } from '../../src/ui/decorations.js';
import { S } from '../../src/tf/strings.js';
import type { FileState } from '../../src/state/FileState.js';

// Shared by every test below that must not trip over a `null` (silent) entry
// while iterating the table.
const drawn = Object.entries(GLYPHS).filter(
  (entry): entry is [string, Glyph] => entry[1] !== null,
);

describe('every badge fits what VS Code will render', () => {
  // Two UTF-16 units is our budget; VS Code's own limit is two grapheme
  // clusters, enforced by FileDecoration.validate, which THROWS -- and the
  // extension host catches it and drops the whole decoration. Exceeding it
  // renders nothing at all rather than rendering short.
  it('is at most two UTF-16 units', () => {
    for (const [state, glyph] of drawn) {
      expect(glyph.badge.length, `${state} badge ${JSON.stringify(glyph.badge)}`)
        .toBeLessThanOrEqual(2);
    }
  });

  it('uses the exact codepoints its comments name', () => {
    // Swapping U+2212 MINUS SIGN for an ASCII hyphen passed every other test in
    // this file, which would have left the comment "minus sign, not a hyphen"
    // sitting above a hyphen. Three of these six are non-ASCII lookalikes, so
    // the bytes are pinned rather than described.
    expect(GLYPHS.versioned?.badge).toBe('\u{1F512}');
    expect(GLYPHS.checkedOut?.badge).toBe('✓');
    expect(GLYPHS.pendingAdd?.badge).toBe('+');
    expect(GLYPHS.pendingDelete?.badge).toBe('−');
    expect(GLYPHS.pendingRename?.badge).toBe('→');
    expect(GLYPHS.writableNotCheckedOut?.badge).toBe('!');
  });

  it('never has an empty badge', () => {
    // An empty badge does not draw a blank -- `decorationsService.ts` guards
    // with `else if (letter)`. The colour rule is unconditional though, so an
    // empty entry tints the filename and attaches a tooltip with no badge to
    // explain either, and propagates that up every ancestor. A state that
    // should draw nothing must be `null` in the table, not an empty badge.
    for (const [, glyph] of drawn) {
      expect(glyph.badge).not.toBe('');
    }
  });

  it('gives every glyph a tooltip', () => {
    for (const [state, glyph] of drawn) {
      expect(glyph.tooltip, state).toBeTruthy();
    }
  });

  it('draws exactly the six states the codepoint test pins', () => {
    // A seventh entry would slip past every other test here, including the
    // codepoint assertions, which are six hand-written lines.
    expect(drawn).toHaveLength(6);
  });
});

describe('what is deliberately not drawn', () => {
  const silent: FileState[] = [
    'notVersioned', 'ignored', 'folderNotPending', 'unmapped', 'unknown',
  ];

  // `GLYPHS` is `Record<FileState, Glyph | null>`, so TypeScript itself now
  // rejects a missing or duplicated FileState member (TS2741 / TS1117) -- the
  // exhaustiveness check that used to live here as a runtime test is now a
  // compile error instead. What is left to pin at runtime is only WHICH five
  // are the null ones, since `null` and a real `Glyph` are both assignable to
  // `Glyph | null` and only a test tells them apart.
  it.each(silent)('draws nothing for %s', (state) => {
    // Absence IS the signal: a file not in source control has no badge
    // BECAUSE everything else has one. Giving any of these a glyph breaks it.
    expect(GLYPHS[state]).toBeNull();
  });
});

describe('the excluded() variant', () => {
  // Task 7: a file deliberately held back from check-in keeps its badge and
  // still bubbles the same way -- only its colour and tooltip change. A
  // separate colour rather than a separate badge, because the file's STATE
  // has not changed, only its fate at the next check-in.
  it('changes only the colour and tooltip, for every drawn glyph', () => {
    for (const [state, glyph] of drawn) {
      const dimmed = excluded(glyph);
      expect(dimmed.badge, state).toBe(glyph.badge);
      expect(dimmed.propagate, state).toBe(glyph.propagate);
      expect(dimmed.color, state).toBe('teamExplorer.excludedForeground');
      // Sourced from `S`, not a literal here or in decorations.ts (Task 6,
      // U8) -- if the two ever disagree, this is the assertion that notices.
      expect(dimmed.tooltip, state).toBe(`${glyph.tooltip}${S.excludedTooltipSuffix}`);
    }
  });

  it('leaves the original glyph in GLYPHS untouched', () => {
    const original = GLYPHS.checkedOut!;
    const before = { ...original };
    excluded(original);
    expect(original).toEqual(before);
  });
});

describe('the versioned lock', () => {
  it('does not propagate to parent folders', () => {
    // VS Code bubbles a decoration's COLOUR to parents. Nearly every file in
    // the workspace is versioned, so propagating this would colour every
    // folder in the tree and destroy the signal it carries.
    expect(GLYPHS.versioned?.propagate).toBe(false);
  });

  it('is the only glyph that does not propagate', () => {
    for (const [state, glyph] of drawn) {
      if (state === 'versioned') continue;
      expect(glyph.propagate, state).toBe(true);
    }
  });
});
