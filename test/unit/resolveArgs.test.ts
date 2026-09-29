import { describe, it, expect } from 'vitest';
import {
  AUTO_RESOLUTIONS,
  autoMergeAllArgs,
  isAbsoluteTfPath,
  listArgs,
  resolveOneArgs,
} from '../../src/conflicts/resolveArgs.js';
import { isResolveOutOfShape } from '../../src/tf/TfClient.js';

const WORK = String.raw`C:\work`;
const INSIGHT = String.raw`C:\Users\user1\Downloads\Insight.Database-main\Insight.Database`;
const FILE = String.raw`C:\work\Shop\Startup.cs`;
const WINE = String.raw`Z:\home\shax\work\Shop\Startup.cs`;

describe('resolveArgs', () => {
  it('lists every root with /recursive and /preview (C9: without /recursive a folder answers "none")', () => {
    expect(listArgs([WORK, INSIGHT])).toEqual(['vc', 'resolve', WORK, INSIGHT, '/recursive', '/preview']);
  });

  it('resolves one item with exactly one /auto:, never /recursive', () => {
    for (const how of AUTO_RESOLUTIONS) {
      expect(resolveOneArgs(FILE, how)).toEqual(['vc', 'resolve', FILE, `/auto:${how}`]);
    }
    expect(resolveOneArgs(WINE, 'KeepYours')).toEqual(['vc', 'resolve', WINE, '/auto:KeepYours']);
  });

  it('auto-merges all over the mapping roots, the one folder-level resolution', () => {
    expect(autoMergeAllArgs([WORK])).toEqual(['vc', 'resolve', WORK, '/recursive', '/auto:AutoMerge']);
  });

  it('offers exactly the four resolutions', () => {
    expect([...AUTO_RESOLUTIONS]).toEqual(['AutoMerge', 'TakeTheirs', 'KeepYours', 'OverwriteLocal']);
  });

  it('refuses what it must never build', () => {
    // No roots would be a bare resolve over the working directory.
    expect(() => listArgs([])).toThrow();
    expect(() => autoMergeAllArgs([])).toThrow();
    // A $/ itemspec fails from outside the workspace (C10); a native Linux path is not tf's form.
    expect(() => listArgs(['$/Shop'])).toThrow();
    expect(() => resolveOneArgs('/home/shax/work/a.cs', 'TakeTheirs')).toThrow();
    expect(() => resolveOneArgs(String.raw`Shop\a.cs`, 'TakeTheirs')).toThrow();
    expect(() => resolveOneArgs(String.raw`C:\work\*.cs`, 'TakeTheirs')).toThrow();
    expect(() => resolveOneArgs('/preview', 'TakeTheirs')).toThrow();
    // `how` can come from a webview message: checked at run time too.
    expect(() => resolveOneArgs(FILE, 'AutoMergeForced' as never)).toThrow();
  });

  it('knows a local path in tf form when it sees one', () => {
    expect(isAbsoluteTfPath(WORK)).toBe(true);
    expect(isAbsoluteTfPath(WINE)).toBe(true);
    expect(isAbsoluteTfPath(String.raw`\\server\share\a.cs`)).toBe(true);
    expect(isAbsoluteTfPath(String.raw`Shop\a.cs`)).toBe(false);
    expect(isAbsoluteTfPath('$/Shop')).toBe(false);
    expect(isAbsoluteTfPath('/home/shax/work')).toBe(false);
  });

  it('builds only what TfClient lets through', () => {
    const built = [
      listArgs([WORK, INSIGHT]),
      autoMergeAllArgs([WORK, INSIGHT]),
      ...AUTO_RESOLUTIONS.map((how) => resolveOneArgs(FILE, how)),
    ];
    for (const args of built) expect(isResolveOutOfShape(args), args.join(' ')).toBe(false);
  });
});
