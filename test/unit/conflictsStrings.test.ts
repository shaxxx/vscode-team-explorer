import { describe, it, expect } from 'vitest';
import { S } from '../../src/tf/strings.js';

describe('phase 5 strings', () => {
  it('names the group, the tab and its toolbar', () => {
    expect(S.conflictsGroup).toBe('Conflicts');
    expect(S.conflictsTitle).toBe('Resolve Conflicts');
    expect(S.conflictsNone).toBe('No conflicts.');
    expect(S.conflictsRefresh).toBe('Refresh');
    expect(S.conflictsAutoMergeAll).toBe('Auto-merge all');
  });

  it('has a label for every button a row can show', () => {
    expect(Object.keys(S.conflictsLabels).sort()).toEqual(
      [
        'autoMerge', 'cancelMerge', 'compare', 'compareLocalBase', 'compareMenu', 'compareServerBase',
        'keepYours', 'mergeManually', 'overwriteLocal', 'resolved', 'takeTheirs',
      ],
    );
    // Visual Studio's Compare drop-down, by its own names.
    expect(S.conflictsLabels.compareMenu).toBe('Compare');
    expect(S.conflictsLabels.compare).toBe('Local and Server');
    expect(S.conflictsLabels.compareServerBase).toBe('Server and Base');
    expect(S.conflictsLabels.compareLocalBase).toBe('Local and Base');
    expect(S.conflictsLabels.takeTheirs).toBe('Take Server');
    expect(S.conflictsLabels.keepYours).toBe('Keep Local');
  });

  it('says which changesets are involved, leaving out what info did not say', () => {
    expect(S.conflictsVersions(18319, 18325)).toBe('yours from C18319, server at C18325');
    expect(S.conflictsVersions(undefined, 14353)).toBe('server at C14353');
    expect(S.conflictsVersions(undefined, undefined)).toBe('');
  });

  it('says what each destructive resolution loses (C13, C14)', () => {
    expect(S.conflictsTakeTheirsConfirm('a.cs')).toContain('a.cs');
    expect(S.conflictsTakeTheirsDetail).toMatch(/undone/);
    expect(S.conflictsTakeTheirsDetail).toMatch(/lost/);
    expect(S.conflictsKeepYoursDetail(18325)).toContain('C18325');
    expect(S.conflictsKeepYoursDetail(18325)).toMatch(/not merged/);
    expect(S.conflictsKeepYoursDetail(18325)).toMatch(/Check In replaces/);
    expect(S.conflictsKeepYoursDetail(undefined)).toMatch(/Check In replaces/);
    expect(S.conflictsKeepYoursDetail(undefined)).not.toContain('undefined');
    expect(S.conflictsOverwriteDetail).toMatch(/not in source control/);
    expect(S.conflictsOverwriteDetail).toMatch(/lost/);
    expect(S.conflictsResolvedDetail).toMatch(/exactly as it is now/);
    expect(S.conflictsUnknownConfirm('Take Server', 'a.cs')).toBe('Take Server: a.cs?');
    expect(S.conflictsUnknownDetail('why')).toMatch(/may be replaced/);
    expect(S.conflictsUnknownDetail('why')).toContain('why');
  });

  it("reports tf's own words and counts", () => {
    expect(S.conflictsActionFailed('a.cs', 'tf said no')).toContain('tf said no');
    expect(S.conflictsAutoMergeAllResult(1, 2)).toBe('Auto-merge resolved 1 of 2 conflicts.');
    expect(S.conflictsAutoMergeAllResult(1, 1)).toBe('Auto-merge resolved 1 of 1 conflict.');
    expect(S.conflictsAutoMergeAllNone('')).toBe('Auto-merge resolved nothing.');
    expect(S.conflictsAutoMergeAllNone('why')).toContain('why');
    expect(S.conflictsCheckFailed('boom')).toContain('boom');
    expect(S.conflictsNotUnderstood('odd line')).toContain('odd line');
    expect(S.conflictsUnsaved('a.cs')).toContain('a.cs');
    expect(S.conflictsSaveFailed('a.cs')).toContain('a.cs');
    expect(S.conflictsCompareTitle('a.cs', 18325)).toBe('a.cs: Server C18325 ↔ Local');
    expect(S.conflictsCompareServerBaseTitle('a.cs', 18319, 18325)).toBe('a.cs: Base C18319 ↔ Server C18325');
    expect(S.conflictsCompareLocalBaseTitle('a.cs', 18319)).toBe('a.cs: Base C18319 ↔ Local');
  });
});
