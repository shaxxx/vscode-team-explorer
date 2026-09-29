import { describe, it, expect, beforeEach } from 'vitest';
import { recorder, Uri } from '../vscode-mock.js';
import { registerShowInExplorer } from '../../src/commands/showInExplorer.js';
import { PathMapper } from '../../src/tf/PathMapper.js';
import { S } from '../../src/tf/strings.js';

function setup() {
  const shown: { path?: string; select?: string }[] = [];
  const context = { subscriptions: [] as { dispose(): unknown }[] };
  const service = { pathMapper: new PathMapper([{ serverItem: '$/Shop', localPath: 'C:\\work\\Shop' }], 'win32') };
  registerShowInExplorer(context, service, { show: async (path?: string, select?: string) => void shown.push({ path, select }) });
  return shown;
}

beforeEach(() => recorder.reset());

describe('Show in Source Control Explorer (design X5)', () => {
  it("opens the item's folder with the item selected", async () => {
    const shown = setup();
    await recorder.invoke('teamExplorer.showInExplorer', Uri.file('C:\\work\\Shop\\Shop2023\\a.vb'));
    expect(shown).toEqual([{ path: '$/Shop/Shop2023', select: '$/Shop/Shop2023/a.vb' }]);
  });

  it('says so for a file outside every mapping, and when there is nothing to show', async () => {
    const shown = setup();
    await recorder.invoke('teamExplorer.showInExplorer', Uri.file('D:\\elsewhere\\a.vb'));
    await recorder.invoke('teamExplorer.showInExplorer');
    expect(shown).toEqual([]);
    expect(recorder.shown).toEqual([S.noWorkspaceMapping, S.noTarget]);
  });

  // Review: a real local folder literally named `*` or `;` is legal on
  // Fedora's ext4, and PathMapper.toServerPath happily turns it into
  // e.g. `$/Shop/*` -- tf itemspec syntax, not a real item. Opening that
  // unchecked would hand `show()` a wildcard as the current folder.
  it('warns instead of opening when the mapped path is not a valid server path', async () => {
    const shown = setup();
    await recorder.invoke('teamExplorer.showInExplorer', Uri.file('C:\\work\\Shop\\*'));
    expect(shown).toEqual([]);
    expect(recorder.shown).toContain(S.sceUnknownPath);
  });
});
