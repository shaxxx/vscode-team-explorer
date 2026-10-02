import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { recorder, executed, Uri } from '../vscode-mock.js';
import { registerRevealInExplorer } from '../../src/commands/revealInExplorer.js';
import { S } from '../../src/tf/strings.js';

const pkg = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf8'));
const menus = pkg.contributes.menus as Record<string, { command: string; when?: string; group?: string }[]>;

function setup() {
  const context = { subscriptions: [] as { dispose(): unknown }[] };
  registerRevealInExplorer(context);
}

beforeEach(() => recorder.reset());

describe('Reveal in Explorer, from a Source Control row', () => {
  it("hands the row's file to VS Code's own revealInExplorer", async () => {
    setup();
    const row = { resourceUri: Uri.file('C:\\work\\Shop\\Classes\\NewModule.vb') };
    await recorder.invoke('teamExplorer.revealInExplorer', row, [row]);
    expect(executed.map((e) => [e.id, (e.args[0] as { fsPath: string }).fsPath])).toEqual([
      ['revealInExplorer', 'C:\\work\\Shop\\Classes\\NewModule.vb'],
    ]);
  });

  it('reveals the first of a multi-selection', async () => {
    setup();
    const a = { resourceUri: Uri.file('C:\\work\\a.vb') };
    const b = { resourceUri: Uri.file('C:\\work\\b.vb') };
    await recorder.invoke('teamExplorer.revealInExplorer', a, [a, b]);
    expect(executed.map((e) => (e.args[0] as { fsPath: string }).fsPath)).toEqual(['C:\\work\\a.vb']);
  });

  it('says so when there is nothing to reveal', async () => {
    setup();
    await recorder.invoke('teamExplorer.revealInExplorer');
    expect(executed).toEqual([]);
    expect(recorder.shown).toEqual([S.noTarget]);
  });

  it('is on every row with a file on disk, so not on a pending Delete, and not in the palette', () => {
    expect(pkg.contributes.commands).toContainEqual({ command: 'teamExplorer.revealInExplorer', title: S.revealInExplorer, category: 'Team Explorer' });
    expect(menus['scm/resourceState/context']).toContainEqual({
      command: 'teamExplorer.revealInExplorer',
      when: 'scmProvider == teamExplorer && scmResourceState =~ /^(checkedOut|pendingAdd|pendingRename|conflict|untracked)$/',
      group: '4_reveal@1',
    });
    expect(menus.commandPalette).toContainEqual({ command: 'teamExplorer.revealInExplorer', when: 'false' });
  });
});
