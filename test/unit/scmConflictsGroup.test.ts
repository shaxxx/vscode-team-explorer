import { describe, it, expect, beforeEach } from 'vitest';
import { ScmProvider, MAX_RENDERED } from '../../src/ui/ScmProvider.js';
import { ScanResult } from '../../src/scan/ScanResult.js';
import { outputChannel, recorder, scm, Uri } from '../vscode-mock.js';
import { S } from '../../src/tf/strings.js';

function provider() {
  const service = {
    pendingChanges: [],
    pathMapper: undefined,
    onDidChange: () => ({ dispose() {} }),
    changeForLocal: () => undefined,
  };
  const state = { get: () => undefined, update: async () => undefined };
  return new ScmProvider(
    service as never,
    { uri: Uri.file(String.raw`C:\work\Shop`) } as never,
    state as never,
    outputChannel as never,
    () => ScanResult.notRun(),
    (() => ({ dispose() {} })) as never,
  );
}

beforeEach(() => recorder.reset());

describe('the Conflicts group (U4)', () => {
  it('is created first, so it sits above Included Changes, and hides while empty', () => {
    const p = provider();
    expect([...scm.last!.groups.keys()][0]).toBe('conflicts');
    const group = scm.last!.groups.get('conflicts')!;
    expect(group.label).toBe(S.conflictsGroup);
    expect(group.hideWhenEmpty).toBe(true);
    expect(group.resourceStates).toEqual([]);
    p.dispose();
  });

  it("shows one row per conflict: the file, tf's reason as the tooltip, a click opens the tab on it", () => {
    const p = provider();
    const path = String.raw`C:\work\Shop\Startup.cs`;
    p.setConflicts([{ localPath: path, reason: 'You have a conflicting pending change.' }]);
    expect(scm.last!.groups.get('conflicts')!.resourceStates).toEqual([
      {
        resourceUri: Uri.file(path),
        decorations: { tooltip: 'You have a conflicting pending change.' },
        contextValue: 'conflict',
        command: { command: 'teamExplorer.showConflicts', title: S.conflictsTitle, arguments: [path] },
      },
    ]);
    p.setConflicts([]);
    expect(scm.last!.groups.get('conflicts')!.resourceStates).toEqual([]);
    p.dispose();
  });

  it('caps the rows like the other groups, with the true count in the label', () => {
    const p = provider();
    const many = Array.from({ length: MAX_RENDERED + 1 }, (_, i) => ({ localPath: `C:\\work\\f${i}.cs`, reason: 'r' }));
    p.setConflicts(many);
    const group = scm.last!.groups.get('conflicts')!;
    expect(group.resourceStates).toHaveLength(MAX_RENDERED);
    expect(group.label).toContain(String(MAX_RENDERED + 1));
    p.dispose();
  });
});
