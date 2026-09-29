import { describe, it, expect } from 'vitest';
import { ServerContentProvider, TFVC_SCHEME } from '../../src/ui/ServerContentProvider.js';
import { QuickDiff } from '../../src/ui/QuickDiff.js';
import { PathMapper } from '../../src/tf/PathMapper.js';
import { Uri } from '../vscode-mock.js';
import type { PendingChange } from '../../src/tf/types.js';

/**
 * Observed on DEVPC. Compare with Latest Version on a pending file that was
 * ALREADY OPEN failed with:
 *
 *   The editor could not be opened due to an unexpected error.
 *   ModelService: Cannot add model because it already exists!
 *
 * Nothing appeared in our own log, because the provider was never called - VS
 * Code failed before reaching it. A file that was not open compared fine,
 * which made it look file-specific.
 *
 * The cause: QuickDiff and the Compare command handed VS Code the SAME
 * `tfvc:` URI, and VS Code keeps one text model per URI. Opening the file
 * caused QuickDiff to create that model for the gutter bars; Compare then
 * asked for it again as an editor input.
 */

const LOCAL = 'C:\\work\\Vesta\\Form1.vb';

const change = (over: Partial<PendingChange> = {}): PendingChange =>
  ({
    serverItem: '$/Vesta/Form1.vb',
    localPath: LOCAL,
    itemType: 'File',
    changes: new Set(['Edit']),
    changeFlags: 2,
    encoding: 1250,
    version: 42,
    ...over,
  }) as PendingChange;

const quickDiff = () =>
  new QuickDiff({
    pathMapper: new PathMapper([{ serverItem: '$/Vesta', localPath: 'C:\\work\\Vesta' }], 'win32'),
    changeFor: () => change(),
  } as never);

describe('the gutter bars and Compare must not share a text model', () => {
  it('Compare gets a DIFFERENT uri from the one QuickDiff owns', () => {
    const bars = quickDiff().provideOriginalResource(Uri.file(LOCAL) as never)!;
    const compare = ServerContentProvider.uriFor(LOCAL, 'compare');

    expect(bars.toString()).not.toBe(compare.toString());
  });

  it('both still point at the same file, so the provider resolves one server item', () => {
    // The discriminator must be invisible to fsPath, or Compare would fetch a
    // different item - or nothing at all.
    const bars = quickDiff().provideOriginalResource(Uri.file(LOCAL) as never)!;
    const compare = ServerContentProvider.uriFor(LOCAL, 'compare');

    expect(compare.fsPath).toBe(LOCAL);
    expect(bars.fsPath).toBe(compare.fsPath);
    expect(compare.scheme).toBe(TFVC_SCHEME);
  });

  it('the bare uri is unchanged, because VS Code caches quick-diff by uri', () => {
    // Changing the quick-diff URI would invalidate every gutter baseline
    // VS Code already holds, for no benefit.
    expect(ServerContentProvider.uriFor(LOCAL).toString()).toBe(
      Uri.file(LOCAL).with({ scheme: TFVC_SCHEME }).toString(),
    );
  });

  it('asking twice for the same variant gives a stable uri', () => {
    // A uri that varied per call - a timestamp, say - would leak one text
    // model per Compare, which is the opposite mistake.
    expect(ServerContentProvider.uriFor(LOCAL, 'compare').toString()).toBe(
      ServerContentProvider.uriFor(LOCAL, 'compare').toString(),
    );
  });
});
