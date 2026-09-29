import { describe, it, expect } from 'vitest';
import { relativeToRoot } from '../../src/paths/relativeToRoot.js';
import type { Platform } from '../../src/tf/PathMapper.js';

/**
 * Direct tests for the shared module. Before this file existed it was
 * covered only transitively, through `ScanResult` (whose constructor
 * canonicalises `root` before ever calling this) and `DecorationProvider`
 * (which did not) -- and a spec review of Task 5 found that the transitive
 * coverage had missed two rows a table like this one would have caught: a
 * trailing separator on `root`, and a bare drive root. Both are below,
 * reproduced this session against the pre-fix code (both returned
 * `undefined`) and confirmed fixed against the current code (both resolve to
 * `'a.vb'`).
 */
const cases: Array<{
  name: string;
  root: string;
  absolute: string;
  platform: Platform;
  expected: string | undefined;
}> = [
  {
    name: 'an ordinary nested path',
    root: 'C:/work/Proj',
    absolute: 'C:/work/Proj/sub/a.vb',
    platform: 'win32',
    expected: 'sub/a.vb',
  },
  {
    name: 'the root itself, with nothing relative to report',
    root: 'C:/work/Proj',
    absolute: 'C:/work/Proj',
    platform: 'win32',
    expected: undefined,
  },
  {
    name: 'a path above the root',
    root: 'C:/work/Proj',
    absolute: 'C:/work',
    platform: 'win32',
    expected: undefined,
  },
  {
    name: "a sibling that merely shares the root's name as a string prefix",
    root: 'C:/work/Proj',
    absolute: 'C:/work/Proj2/a.vb',
    platform: 'win32',
    expected: undefined,
  },
  {
    // Finding 1: DecorationProvider passes `folder.uri.fsPath` raw, with no
    // canonicalisation, so a workspace root spelled with a trailing separator
    // used to return `undefined` for every file in it.
    name: 'a trailing separator on the root',
    root: 'C:\\work\\Proj\\',
    absolute: 'C:\\work\\Proj\\a.vb',
    platform: 'win32',
    expected: 'a.vb',
  },
  {
    // Finding 1's other row: a workspace opened at a drive root. `C:\` is
    // itself a trailing separator on the bare root `C:`.
    name: 'a bare drive root',
    root: 'C:\\',
    absolute: 'C:\\a.vb',
    platform: 'win32',
    expected: 'a.vb',
  },
  {
    name: 'a doubled separator right after the root',
    root: 'C:/work/Proj',
    absolute: 'C:/work/Proj//a.vb',
    platform: 'win32',
    expected: 'a.vb',
  },
  {
    name: 'a leading .. component',
    root: 'C:/work/Proj',
    absolute: 'C:/work/Proj/../a.vb',
    platform: 'win32',
    expected: undefined,
  },
  {
    name: 'a .. component in the middle',
    root: 'C:/work/Proj',
    absolute: 'C:/work/Proj/sub/../a.vb',
    platform: 'win32',
    expected: undefined,
  },
  {
    name: 'a trailing .. component',
    root: 'C:/work/Proj',
    absolute: 'C:/work/Proj/sub/..',
    platform: 'win32',
    expected: undefined,
  },
  {
    name: 'mixed separators -- root spelled with /, absolute native with \\',
    root: 'C:/work/Proj',
    absolute: 'C:\\work\\Proj\\sub\\a.vb',
    platform: 'win32',
    expected: 'sub/a.vb',
  },
  {
    name: 'a case-mixed root on win32, folded away',
    root: 'c:/WORK/proj',
    absolute: 'C:/work/Proj/a.vb',
    platform: 'win32',
    expected: 'a.vb',
  },
  {
    name: 'on linux, a case mismatch is NOT folded and reads as outside the root',
    root: '/home/user/Proj',
    absolute: '/home/user/proj/a.vb',
    platform: 'linux',
    expected: undefined,
  },
  {
    name: 'on linux, matching case resolves normally',
    root: '/home/user/Proj',
    absolute: '/home/user/Proj/a.vb',
    platform: 'linux',
    expected: 'a.vb',
  },
];

describe('relativeToRoot', () => {
  it.each(cases)('$name', ({ root, absolute, platform, expected }) => {
    expect(relativeToRoot(root, absolute, platform)).toBe(expected);
  });
});
