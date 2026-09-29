import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const pkg = JSON.parse(
  readFileSync(join(__dirname, '../../package.json'), 'utf8'),
);

const menuCommands = (): (string | undefined)[] =>
  Object.entries(pkg.contributes?.menus ?? {})
    // commandPalette entries HIDE commands; they are not a route to one.
    .filter(([key]) => key !== 'commandPalette')
    .flatMap(([, entries]) => entries as any[])
    // A submenu reference has no command; the submenu's own entries do. Named
    // explicitly rather than filtering out non-string `command`s afterwards:
    // that would also silently drop an entry whose `command` key was
    // misspelled (e.g. "comand"), which must fail 'every menu entry refers to
    // a declared command' below, not vanish before that test ever sees it.
    .filter((e) => e.submenu === undefined)
    .map((e) => e.command);

describe('command contributions', () => {
  it('every mutating command is reachable from at least one menu', () => {
    const reachable = new Set(menuCommands());

    for (const id of ['teamExplorer.checkout', 'teamExplorer.undo', 'teamExplorer.getLatest', 'teamExplorer.add']) {
      expect(reachable.has(id), `${id} is declared but has no menu route`).toBe(true);
    }
  });

  it('every menu entry refers to a declared command', () => {
    const declared = new Set(
      (pkg.contributes?.commands ?? []).map((c: any) => c.command),
    );

    for (const id of menuCommands()) {
      expect(declared.has(id), `${id} is in a menu but not declared`).toBe(true);
    }
  });

  it('include and exclude are reachable from the SCM resource context menu', () => {
    const scmMenu = pkg.contributes?.menus?.['scm/resourceState/context'] ?? [];
    const byId = (id: string) => scmMenu.find((m: any) => m.command === id);

    expect(byId('teamExplorer.exclude')).toBeDefined();
    expect(byId('teamExplorer.include')).toBeDefined();

    // Each must only appear on the group it actually applies to, or the panel
    // offers "Exclude" on an already-excluded file.
    expect(byId('teamExplorer.exclude').when).toContain('scmResourceGroup == included');
    expect(byId('teamExplorer.include').when).toContain('scmResourceGroup == excluded');
  });
});

describe('menu contributions are actually reachable', () => {
  const pkg = JSON.parse(
    readFileSync(join(__dirname, '../../package.json'), 'utf8'),
  );
  const menus = pkg.contributes.menus as Record<string, { command: string; when?: string; group?: string }[]>;
  const scmContext = menus['scm/resourceState/context'] ?? [];

  it('every SCM row action also has a real context-menu entry', () => {
    // `inline` renders as an icon button on the row and does NOT appear in the
    // right-click menu. Exclude, Include and Undo were contributed to `inline`
    // only, so right-clicking a pending change offered just "Compare with
    // Latest Version" — found while running the acceptance checklist.
    const inlineOnly = [...new Set(scmContext.filter((e) => e.group?.startsWith('inline')).map((e) => e.command))]
      .filter((cmd) => !scmContext.some((e) => e.command === cmd && !e.group?.startsWith('inline')));

    expect(inlineOnly, 'these are unreachable from the right-click menu').toEqual([]);
  });

  it('no SCM context entry uses a group that menu does not recognise', () => {
    // `navigation` is not a group for scm/resourceState/context, so an entry
    // using it sorted arbitrarily against the others.
    const bad = scmContext.filter((e) => e.group === 'navigation').map((e) => e.command);
    expect(bad).toEqual([]);
  });

  it('every inline action declares an icon, or it renders as nothing', () => {
    const commands = pkg.contributes.commands as { command: string; icon?: string }[];
    const missing = scmContext
      .filter((e) => e.group?.startsWith('inline'))
      .map((e) => e.command)
      .filter((cmd) => !commands.find((c) => c.command === cmd)?.icon);

    expect(missing).toEqual([]);
  });

  it('explorer and editor menus are gated on the TFVC context key', () => {
    // activationEvents is onStartupFinished, so without a gate these appear in
    // every window and every folder, TFVC or not.
    const ungated = [...(menus['explorer/context'] ?? []), ...(menus['editor/context'] ?? [])]
      .filter((e) => !e.when?.includes('teamExplorer:enabled'))
      .map((e) => e.command);

    expect(ungated).toEqual([]);
  });
});

describe('plan 3: the Explorer submenu and the editor menu', () => {
  const pkg3 = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf8'));
  const menus = pkg3.contributes.menus as Record<
    string,
    { command?: string; submenu?: string; when?: string; group?: string }[]
  >;

  it('puts the Explorer entries under one Team Explorer submenu', () => {
    expect(menus['explorer/context']).toEqual([
      { submenu: 'teamExplorer.explorer', when: 'teamExplorer:enabled', group: '7_modification' },
    ]);
    expect(pkg3.contributes.submenus).toEqual([{ id: 'teamExplorer.explorer', label: 'Team Explorer' }]);
  });

  it('holds the file commands, with Compare and Annotate offered on files only', () => {
    const inside = menus['teamExplorer.explorer'];
    expect(inside.map((e) => e.command).sort()).toEqual([
      'teamExplorer.add',
      'teamExplorer.annotate',
      'teamExplorer.checkout',
      'teamExplorer.compareWithLatest',
      'teamExplorer.getLatest',
      'teamExplorer.showInExplorer',
      'teamExplorer.undo',
      'teamExplorer.viewHistory',
    ]);
    const filesOnly = ['teamExplorer.compareWithLatest', 'teamExplorer.annotate'];
    for (const e of inside) {
      expect(e.when, e.command).toBe(filesOnly.includes(e.command!) ? '!explorerResourceIsFolder' : undefined);
    }
  });

  it("gates the editor menu on the active file's state", () => {
    const base = 'teamExplorer:enabled && resourceScheme == file';
    // `unknown` (writable, nothing pending, not covered by the scan) is
    // reachable with the scan turned off, for up to 20 s before the first
    // scan lands, and after a failed scan -- and covers the hazard, a file
    // edited without being checked out. Both Check Out and Check for Server
    // Changes must still offer themselves there. Check Out additionally
    // covers `pendingRename`: a rename leaves the file read-only, and Check
    // Out is what makes it editable.
    const checkoutWhen = `${base} && teamExplorer.activeFileState =~ /^(versioned|writableNotCheckedOut|unknown|pendingRename)$/`;
    const checkForServerChangesWhen = `${base} && teamExplorer.activeFileState =~ /^(versioned|writableNotCheckedOut|unknown)$/`;
    const edited = `${base} && teamExplorer.activeFileState == checkedOut`;
    const historyWhen = `${base} && teamExplorer.activeFileState =~ /^(versioned|checkedOut|writableNotCheckedOut|unknown)$/`;
    expect(menus['editor/context']).toEqual([
      { command: 'teamExplorer.checkout', when: checkoutWhen, group: 'teamExplorer@1' },
      { command: 'teamExplorer.compareWithLatest', when: edited, group: 'teamExplorer@2' },
      { command: 'teamExplorer.checkForServerChanges', when: checkForServerChangesWhen, group: 'teamExplorer@2' },
      { command: 'teamExplorer.viewHistory', when: historyWhen, group: 'teamExplorer@3' },
      { command: 'teamExplorer.annotate', when: `${historyWhen} && !teamExplorer.annotated`, group: 'teamExplorer@4' },
      { command: 'teamExplorer.hideAnnotations', when: `${base} && teamExplorer.annotated`, group: 'teamExplorer@4' },
      { command: 'teamExplorer.showInExplorer', when: historyWhen, group: 'teamExplorer@5' },
    ]);
  });

  it('declares Check for Server Changes and keeps it out of the palette, which already has Compare', () => {
    const commands = pkg3.contributes.commands as { command: string; title: string }[];
    expect(commands.find((c) => c.command === 'teamExplorer.checkForServerChanges')?.title).toBe(
      'Check for Server Changes',
    );
    expect(menus.commandPalette).toContainEqual({ command: 'teamExplorer.checkForServerChanges', when: 'false' });
  });

  it('every submenu a menu refers to is declared', () => {
    const declared = new Set((pkg3.contributes.submenus ?? []).map((s: { id: string }) => s.id));
    const referenced = Object.values(menus)
      .flat()
      .map((e) => e.submenu)
      .filter((id): id is string => typeof id === 'string');
    for (const id of referenced) expect(declared.has(id), id).toBe(true);
  });

  it('offers View History on SCM rows the server knows, never on a pending Add or rename', () => {
    const entry = menus['scm/resourceState/context'].find((e) => e.command === 'teamExplorer.viewHistory');
    expect(entry).toEqual({
      command: 'teamExplorer.viewHistory',
      when: 'scmProvider == teamExplorer && scmResourceState =~ /^(checkedOut|pendingDelete)$/',
      group: '3_history@1',
    });
  });

  it('keeps the two hover-only commands out of the palette (D7)', () => {
    expect(menus.commandPalette).toContainEqual({ command: 'teamExplorer.showChangeset', when: 'false' });
    expect(menus.commandPalette).toContainEqual({ command: 'teamExplorer.compareVersions', when: 'false' });
  });
});

describe('phase 3 part 1: Manage Workspace', () => {
  it('is declared, and the palette never hides it: it is the way out of an unmapped folder', () => {
    expect(pkg.contributes.commands).toContainEqual(
      expect.objectContaining({ command: 'teamExplorer.manageWorkspace', title: 'Manage Workspace', category: 'Team Explorer' }),
    );
    const palette = (pkg.contributes.menus.commandPalette as { command: string; when?: string }[]).find(
      (e) => e.command === 'teamExplorer.manageWorkspace',
    );
    expect(palette === undefined || palette.when === undefined).toBe(true);
  });
});

describe('phase 3 part 2: Source Control Explorer', () => {
  const pkgJson = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf8'));
  const commands = (pkgJson.contributes.commands as { command: string; title: string }[]).map((c) => c.command);
  const palette = pkgJson.contributes.menus.commandPalette as { command: string; when?: string }[];
  const whenOf = (id: string) => palette.find((p) => p.command === id)?.when;

  it('declares the four commands; the two internal ones never show in the palette', () => {
    for (const id of ['teamExplorer.openExplorer', 'teamExplorer.showInExplorer', 'teamExplorer.viewVersion', 'teamExplorer.mapServerFolder']) {
      expect(commands).toContain(id);
    }
    expect(whenOf('teamExplorer.viewVersion')).toBe('false');
    expect(whenOf('teamExplorer.mapServerFolder')).toBe('false');
  });

  it('offers the explorer only in a mapped folder: palette, Explorer submenu, editor menu, Source Control title', () => {
    expect(whenOf('teamExplorer.openExplorer')).toBe('teamExplorer:enabled');
    expect(whenOf('teamExplorer.showInExplorer')).toBe('teamExplorer:enabled');
    const sub = pkgJson.contributes.menus['teamExplorer.explorer'] as { command: string }[];
    expect(sub.map((e) => e.command)).toContain('teamExplorer.showInExplorer');
    const editor = (pkgJson.contributes.menus['editor/context'] as { command: string; when: string }[]).find((e) => e.command === 'teamExplorer.showInExplorer')!;
    expect(editor.when).toContain('teamExplorer:enabled');
    const scm = (pkgJson.contributes.menus['scm/title'] as { command: string; when: string }[]).find((e) => e.command === 'teamExplorer.openExplorer')!;
    expect(scm.when).toBe('scmProvider == teamExplorer && teamExplorer:enabled');
  });

  it('adds a Team Explorer activity bar icon, off by default and never shown outside a mapped folder (X4; user, 2026-09-23)', () => {
    const containers = pkgJson.contributes.viewsContainers.activitybar as { id: string; title: string; icon: string }[];
    expect(containers).toEqual([{ id: 'teamExplorer', title: 'Team Explorer', icon: 'media/team-explorer.svg' }]);
    // Both halves, in this order: the setting turns it on, and a folder that
    // is not mapped hides it whatever the setting says.
    expect(pkgJson.contributes.views.teamExplorer).toEqual([
      { id: 'teamExplorer.home', name: 'Home', when: 'config.teamExplorer.showActivityBar && teamExplorer:enabled' },
    ]);
    const setting = pkgJson.contributes.configuration.properties['teamExplorer.showActivityBar'];
    expect(setting.type).toBe('boolean');
    expect(setting.default, 'the icon must be off until the user asks for it').toBe(false);
    const welcome = (pkgJson.contributes.viewsWelcome as { view: string; contents: string }[]).find((w) => w.view === 'teamExplorer.home')!;
    expect(welcome.contents).toContain('command:teamExplorer.openExplorer');
    expect(welcome.contents).toContain('command:workbench.view.scm');
    expect(welcome.contents).toContain('command:teamExplorer.manageWorkspace');
    expect(JSON.stringify(pkgJson.contributes.viewsContainers)).not.toMatch(/tfvc/i);
  });

  it('activates to restore the explorer tab after a restart', () => {
    expect(pkgJson.activationEvents).toContain('onWebviewPanel:teamExplorer.sourceControlExplorer');
  });

  it('keeps the rename and delete commands out of the palette (phase 3 part 3)', () => {
    const ids: string[] = (pkgJson.contributes.commands as { command: string }[]).map((c) => c.command);
    expect(ids).toContain('teamExplorer.renameItem');
    expect(ids).toContain('teamExplorer.deleteItems');
    const palette = pkgJson.contributes.menus.commandPalette as { command: string; when: string }[];
    for (const id of ['teamExplorer.renameItem', 'teamExplorer.deleteItems']) {
      expect(palette.find((m) => m.command === id)?.when, id).toBe('false');
    }
  });
});

describe('phase 4 contributions', () => {
  const pkg4 = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf8'));
  const commands = pkg4.contributes.commands as { command: string; title: string; category?: string; icon?: string }[];
  const palette = pkg4.contributes.menus.commandPalette as { command: string; when?: string }[];
  const title = pkg4.contributes.menus['scm/title'] as { command: string; when?: string; group?: string }[];

  it('declares Shelve with an icon and Find Shelvesets', () => {
    expect(commands).toContainEqual(expect.objectContaining({ command: 'teamExplorer.shelve', category: 'Team Explorer', icon: '$(archive)' }));
    expect(commands).toContainEqual(expect.objectContaining({ command: 'teamExplorer.findShelvesets', category: 'Team Explorer' }));
  });

  it('puts Shelve next to Check In, and Find Shelvesets in the ... menu, both only in a mapped folder', () => {
    const shelve = title.find((m) => m.command === 'teamExplorer.shelve')!;
    expect(shelve.group).toBe('navigation@1.5');
    expect(shelve.when).toBe('scmProvider == teamExplorer && teamExplorer:enabled');
    const find = title.find((m) => m.command === 'teamExplorer.findShelvesets')!;
    expect(find.group?.startsWith('navigation')).toBe(false);
    expect(find.when).toBe('scmProvider == teamExplorer && teamExplorer:enabled');
    for (const id of ['teamExplorer.shelve', 'teamExplorer.findShelvesets']) {
      expect(palette.find((m) => m.command === id)?.when, id).toBe('teamExplorer:enabled');
    }
  });

  it('activates to restore the Shelvesets tab after a restart', () => {
    expect(pkg4.activationEvents).toContain('onWebviewPanel:teamExplorer.shelvesets');
  });

  it('never gives Shelve or Find Shelvesets a keybinding', () => {
    const keybindings = (pkg4.contributes.keybindings ?? []) as { command: string }[];
    const bound = keybindings.map((k) => k.command);
    expect(bound).not.toContain('teamExplorer.shelve');
    expect(bound).not.toContain('teamExplorer.findShelvesets');
  });
});
