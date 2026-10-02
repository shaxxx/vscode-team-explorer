import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseInfo, type InfoItem } from '../../src/tf/parseInfo.js';
import { parseStatusOwned } from '../../src/tf/parse.js';
import type { OwnedPendingChange } from '../../src/tf/types.js';
import type { DirListing } from '../../src/tf/parseDir.js';
import {
  ACTIONS,
  ExplorerModel,
  allowedActions,
  buildRows,
  changeLabel,
  childPath,
  crumbs,
  filesUnder,
  isServerPath,
  nameOf,
  parentPath,
  parseExplorerIntent,
  refusal,
  sortRows,
  treeRows,
  type ExplorerRow,
} from '../../src/explorer/explorerModel.js';
import { S } from '../../src/tf/strings.js';

const text = (name: string) => readFileSync(join(__dirname, '../fixtures', name)).toString('utf8');
const bytes = (name: string) => readFileSync(join(__dirname, '../fixtures', name));

const FOLDER = '$/Shop/Shop2023/Enterprise.Till.Server';
const INFO = parseInfo(text('windows/info-folder-star.txt'));
const STATUS = parseStatusOwned(bytes('windows/status-folder-star-allusers.xml'));
/** The folder's `dir`, rebuilt from its `info`: the same items, split by type. */
const LISTING: DirListing = {
  path: FOLDER,
  folders: INFO.filter((i) => i.type === 'folder').map((i) => nameOf(i.serverPath)),
  files: INFO.filter((i) => i.type === 'file').map((i) => nameOf(i.serverPath)),
};
const isMine = (c: OwnedPendingChange) => c.workspace === 'DEVPC' && c.computer === 'DEVPC';
/** DEVPC's real mapping: `$/` -> `C:\work`. */
const mappedAll = (p: string) => 'C:\\work\\' + p.slice(2).split('/').join('\\');

const rows = (over: Partial<Parameters<typeof buildRows>[0]> = {}) =>
  buildRows({ listing: LISTING, info: INFO, status: STATUS, isMine, localPathOf: mappedAll, ...over });
const row = (list: ExplorerRow[], name: string) => list.find((r) => r.name === name)!;

const fakeRow = (over: Partial<ExplorerRow>): ExplorerRow => ({
  name: 'a.txt',
  serverPath: '$/A/a.txt',
  isFolder: false,
  pending: '',
  users: [],
  userDetails: [],
  statusKnown: true,
  latest: 'yes',
  lastCheckIn: '',
  serverChangeset: 5,
  localPath: 'C:\\work\\A\\a.txt',
  ...over,
});

describe('paths', () => {
  it('joins, splits and names server paths, with $/ as its own parent', () => {
    expect(childPath('$/', 'Shop')).toBe('$/Shop');
    expect(childPath('$/Shop', 'Shop2023')).toBe('$/Shop/Shop2023');
    expect(parentPath('$/Shop/Shop2023')).toBe('$/Shop');
    expect(parentPath('$/Shop')).toBe('$/');
    expect(parentPath('$/')).toBe('$/');
    expect(nameOf('$/Shop/a.txt')).toBe('a.txt');
    expect(nameOf('$/')).toBe('$/');
  });

  it('builds the breadcrumb from $/ down', () => {
    expect(crumbs('$/')).toEqual([{ name: '$/', path: '$/' }]);
    expect(crumbs('$/Shop/Shop2023')).toEqual([
      { name: '$/', path: '$/' },
      { name: 'Shop', path: '$/Shop' },
      { name: 'Shop2023', path: '$/Shop/Shop2023' },
    ]);
  });

  it('accepts only server paths from the page', () => {
    expect(isServerPath('$/Shop')).toBe(true);
    for (const bad of ['C:\\work', '/home', 'Shop', 42, undefined, '$/a\nb', '$/' + 'x'.repeat(5000)]) {
      expect(isServerPath(bad)).toBe(false);
    }
  });

  it('keeps real paths valid but rejects tf wildcards, junk segments and a trailing slash (review finding 3)', () => {
    for (const good of ['$/', '$/Shop', '$/Shop/Shop2023', '$/Shop/Shop2023/Enterprise.Till.Server', '$/A/a.b.c', '$/A/-x', '$/A/.hidden']) {
      expect(isServerPath(good)).toBe(true);
    }
    for (const bad of [
      // tf wildcards and itemspec syntax -- never legal in a single path.
      '$/Shop/*',
      '$/Shop/?',
      '$/Shop/X;C1',
      // Path traversal and empty/degenerate segments.
      '$/Shop/Shop2023/..',
      '$/Shop/.',
      '$/./Shop',
      '$/Shop//X',
      '$/Shop/',
      // A lone root is fine, but nothing else may end in a slash.
    ]) {
      expect(isServerPath(bad)).toBe(false);
    }
  });
});

describe('changeLabel', () => {
  it('reads like Visual Studio: lower case, Encoding only when alone, SourceRename as rename', () => {
    expect(changeLabel(new Set(['Edit']))).toBe('edit');
    // Visual Studio says just "add": a new file's Edit and Encoding are implied.
    expect(changeLabel(new Set(['Add', 'Edit', 'Encoding']))).toBe('add');
    expect(changeLabel(new Set(['Encoding']))).toBe('encoding');
    expect(changeLabel(new Set(['SourceRename']))).toBe('rename');
  });
});

describe('buildRows', () => {
  it('lists folders then files, every item of the listing', () => {
    const list = rows();
    expect(list).toHaveLength(23);
    expect(list.slice(0, 6).every((r) => r.isFolder)).toBe(true);
  });

  it('shows your own change as Pending Change, and everyone, you first, as User', () => {
    const xml = row(rows(), 'Enterprise.Till.Server.xml');
    expect(xml.pending).toBe('edit');
    expect(xml.users).toEqual(['Filip', 'Boris', 'Ivan', 'Zoran']);
    expect(xml.userDetails[1]).toBe('Boris (BORIS/BORIS): edit, 2026-08-24');
  });

  it("does not call someone else's change yours", () => {
    const vspscc = row(rows(), 'Enterprise.Till.Server.csproj.vspscc');
    expect(vspscc.pending).toBe('');
    expect(vspscc.users).toEqual(['Boris']);
  });

  it('reads Latest from the local and server changesets, and keeps the date verbatim', () => {
    const claude = row(rows(), 'CLAUDE.md');
    expect(claude.latest).toBe('yes');
    expect(claude.serverChangeset).toBe(20493);
    expect(claude.lastCheckIn).toBe('9. travnja 2026. 10:06:48');
    const older: InfoItem[] = INFO.map((i) => (i.serverPath.endsWith('/CLAUDE.md') ? { ...i, localChangeset: 100 } : i));
    expect(row(rows({ info: older }), 'CLAUDE.md').latest).toBe('no');
  });

  it('says Not downloaded for an empty local half, Not mapped from the mappings (design Q3, Q8)', () => {
    const notDownloaded = parseInfo(text('fedora/info-not-downloaded.txt'));
    const listing: DirListing = { path: '$/Ledger', folders: ['dbo', 'docs', 'Security'], files: ['CLAUDE.md', 'Ledger.sln', 'Ledger.sqlproj'] };
    const down = buildRows({ listing, info: notDownloaded, status: [], isMine, localPathOf: mappedAll });
    expect(down.every((r) => r.latest === 'notDownloaded')).toBe(true);
    const unmapped = buildRows({ listing, info: notDownloaded, status: [], isMine, localPathOf: () => undefined });
    expect(unmapped.every((r) => r.latest === 'notMapped' && r.localPath === undefined)).toBe(true);
  });

  it('says unknown while info is loading or failed, and shows no one while status is', () => {
    const loading = rows({ info: undefined, status: undefined });
    expect(loading.every((r) => r.latest === 'unknown' && r.pending === '' && r.users.length === 0)).toBe(true);
  });
});

describe('sortRows', () => {
  it('keeps folders first in both directions', () => {
    const desc = sortRows(rows(), { key: 'name', dir: 'desc' });
    expect(desc.slice(0, 6).every((r) => r.isFolder)).toBe(true);
    expect(desc[0].name).toBe('Web');
  });

  it('sorts Last Check-in by changeset number, never by the localized date text (X6)', () => {
    const files = sortRows(rows(), { key: 'lastCheckIn', dir: 'desc' }).filter((r) => !r.isFolder);
    const changesets = files.map((r) => r.serverChangeset ?? -1);
    expect([...changesets].sort((a, b) => b - a)).toEqual(changesets);
  });
});

describe('refusal and allowedActions', () => {
  it('offers everything that fits one downloaded, mapped file', () => {
    // fakeRow's default has nothing pending, so Undo does not fit it either (see the Undo tests below).
    expect(allowedActions([fakeRow({})])).toEqual([
      'getLatest', 'getSpecific', 'checkout', 'undo', 'history', 'compare', 'view', 'annotate', 'rename', 'delete', 'map', 'copyPath', 'open',
    ].filter((a) => a !== 'map' && a !== 'undo'));
  });

  it('offers only History, View, Copy Server Path, Map and open outside every mapping', () => {
    expect(allowedActions([fakeRow({ latest: 'notMapped', localPath: undefined })])).toEqual(['history', 'view', 'map', 'copyPath', 'open']);
    expect(refusal('checkout', [fakeRow({ name: 'x.txt', latest: 'notMapped', localPath: undefined })])).toBe(S.sceNotMappedAction('x.txt'));
  });

  it('refuses what needs a local copy on an item never downloaded, but still gets it', () => {
    const r = fakeRow({ latest: 'notDownloaded' });
    expect(refusal('checkout', [r])).toBe(S.sceNotDownloaded('a.txt'));
    expect(refusal('compare', [r])).toBe(S.sceNotDownloaded('a.txt'));
    expect(refusal('getLatest', [r])).toBeUndefined();
  });

  it('asks for exactly one item where only one makes sense', () => {
    const two = [fakeRow({}), fakeRow({ name: 'b.txt', serverPath: '$/A/b.txt' })];
    for (const a of ['open', 'history', 'compare', 'view', 'annotate', 'addItems', 'map'] as const) {
      expect(refusal(a, two)).toBe(S.sceNeedsOne);
    }
    expect(refusal('checkout', two)).toBeUndefined();
    expect(refusal('getLatest', [])).toBe(S.sceNeedsSelection);
  });

  it('keeps file-only and folder-only actions apart', () => {
    const folder = fakeRow({ name: 'Web', isFolder: true, serverPath: '$/A/Web' });
    expect(refusal('compare', [folder])).toBe(S.sceNotAFile('Web'));
    expect(refusal('view', [folder])).toBe(S.sceNotAFile('Web'));
    expect(refusal('addItems', [fakeRow({})])).toBe(S.sceNotAFolder('a.txt'));
    expect(refusal('addItems', [folder])).toBeUndefined();
  });

  it('offers Map only where nothing is mapped yet: an existing mapping is Manage Workspace business (part 1 P11)', () => {
    expect(refusal('map', [fakeRow({})])).toBe(S.sceAlreadyMapped('a.txt', 'C:\\work\\A\\a.txt'));
  });

  it('waits for status before checking out or comparing', () => {
    expect(refusal('checkout', [fakeRow({ latest: 'unknown' })])).toBe(S.sceNotLoaded('a.txt'));
    expect(refusal('view', [fakeRow({ serverChangeset: undefined })])).toBe(S.sceNotLoaded('a.txt'));
  });

  it('offers Undo only where something of mine is pending, and always on a folder (recursive)', () => {
    const clean = row(rows(), 'CLAUDE.md');
    expect(clean.pending).toBe('');
    expect(refusal('undo', [clean])).toBe(S.nothingPendingOn(['CLAUDE.md']));

    const othersOnly = row(rows(), 'Enterprise.Till.Server.csproj.vspscc');
    expect(othersOnly.pending).toBe('');
    expect(refusal('undo', [othersOnly])).toBe(S.nothingPendingOn(['Enterprise.Till.Server.csproj.vspscc']));

    const mine = row(rows(), 'Enterprise.Till.Server.xml');
    expect(mine.pending).toBe('edit');
    expect(refusal('undo', [mine])).toBeUndefined();

    const folder = row(rows(), 'Web');
    expect(folder.isFolder).toBe(true);
    expect(refusal('undo', [folder])).toBeUndefined();
  });

  it('waits for status before undoing', () => {
    expect(refusal('undo', [fakeRow({ statusKnown: false })])).toBe(S.sceNotLoaded('a.txt'));
  });
});

describe('rename and delete (phase 3 part 3)', () => {
  it('renames one item at a time, and only one that is downloaded (design R13)', () => {
    expect(refusal('rename', [fakeRow({ latest: 'yes' })])).toBeUndefined();
    expect(refusal('rename', [fakeRow({ latest: 'yes' }), fakeRow({ name: 'b.txt', serverPath: '$/K/b.txt' })])).toBe(
      S.sceNeedsOne,
    );
    expect(refusal('rename', [fakeRow({ latest: 'notDownloaded' })])).toBe(S.sceNotDownloaded('a.txt'));
    expect(refusal('rename', [fakeRow({ latest: 'unknown' })])).toBe(S.sceNotLoaded('a.txt'));
    expect(refusal('rename', [fakeRow({ latest: 'notMapped' })])).toBe(S.sceNotMappedAction('a.txt'));
  });

  it('deletes without a local copy, but never outside a mapping (design R15)', () => {
    expect(refusal('delete', [fakeRow({ latest: 'notDownloaded' })])).toBeUndefined();
    expect(refusal('delete', [fakeRow({ latest: 'yes' }), fakeRow({ name: 'b.txt', serverPath: '$/K/b.txt' })])).toBeUndefined();
    expect(refusal('delete', [fakeRow({ latest: 'notMapped' })])).toBe(S.sceNotMappedAction('a.txt'));
    expect(refusal('delete', [])).toBe(S.sceNeedsSelection);
  });

  it('offers both in the menu order the page uses', () => {
    expect(ACTIONS).toContain('rename');
    expect(ACTIONS).toContain('delete');
    expect(ACTIONS.indexOf('rename')).toBeLessThan(ACTIONS.indexOf('delete'));
  });
});

describe('treeRows', () => {
  const children: Record<string, string[]> = { '$/': ['Ledger', 'Shop'], '$/Shop': ['Shop2013', 'Shop2023'] };
  const childrenOf = (p: string) => children[p];

  it('shows $/ and the children of every expanded folder, depth by depth', () => {
    const t = treeRows(new Set(['$/', '$/shop']), childrenOf, '$/Shop/Shop2023');
    expect(t.map((r) => `${r.depth}:${r.name}`)).toEqual(['0:$/', '1:Ledger', '1:Shop', '2:Shop2013', '2:Shop2023']);
    expect(t.find((r) => r.name === 'Shop2023')!.current).toBe(true);
  });

  it('marks an expanded folder whose children are not listed yet as loading', () => {
    const t = treeRows(new Set(['$/', '$/ledger']), childrenOf, '$/');
    expect(t.find((r) => r.name === 'Ledger')).toMatchObject({ expanded: true, loading: true });
  });
});

describe('filesUnder', () => {
  it('matches case-insensitively on Windows, and never a sibling that only shares a prefix', () => {
    const paths = ['C:\\work\\Shop\\a.txt', 'C:\\WORK\\shop\\sub\\b.txt', 'C:\\work\\Shop2\\c.txt'];
    expect(filesUnder(paths, 'C:\\work\\Shop', 'win32')).toEqual(['C:\\work\\Shop\\a.txt', 'C:\\WORK\\shop\\sub\\b.txt']);
    expect(filesUnder(paths, 'C:\\work\\Shop\\', 'win32')).toHaveLength(2);
  });

  it('is case-sensitive on Linux', () => {
    expect(filesUnder(['/home/shax/work/Shop/a', '/home/shax/work/shop/b'], '/home/shax/work/Shop', 'linux')).toEqual(['/home/shax/work/Shop/a']);
  });
});

describe('parseExplorerIntent', () => {
  const request = { kind: 'changeset', value: '5', overwriteWritable: false, getAll: false };
  it('accepts each intent the page posts', () => {
    expect(parseExplorerIntent({ type: 'ready' })).toEqual({ type: 'ready' });
    expect(parseExplorerIntent({ type: 'navigate', path: '$/Shop' })).toEqual({ type: 'navigate', path: '$/Shop' });
    expect(parseExplorerIntent({ type: 'toggle', path: '$/Shop' })).toEqual({ type: 'toggle', path: '$/Shop' });
    expect(parseExplorerIntent({ type: 'sort', key: 'latest' })).toEqual({ type: 'sort', key: 'latest' });
    expect(parseExplorerIntent({ type: 'select', paths: ['$/A'] })).toEqual({ type: 'select', paths: ['$/A'] });
    expect(parseExplorerIntent({ type: 'action', action: 'checkout', paths: [] })).toEqual({ type: 'action', action: 'checkout', paths: [] });
    expect(parseExplorerIntent({ type: 'submitDialog', request })).toEqual({ type: 'submitDialog', request });
    expect(parseExplorerIntent({ type: 'pickChangeset', request })).toEqual({ type: 'pickChangeset', request });
    expect(parseExplorerIntent({ type: 'closeDialog' })).toEqual({ type: 'closeDialog' });
    expect(parseExplorerIntent({ type: 'refresh' })).toEqual({ type: 'refresh' });
  });

  it('refuses anything malformed', () => {
    for (const bad of [
      null,
      'ready',
      { type: 'checkin' },
      { type: 'navigate', path: 'C:\\work' },
      { type: 'sort', key: 'size' },
      { type: 'select', paths: '$/A' },
      { type: 'action', action: 'destroy', paths: [] },
      { type: 'action', action: 'checkout', paths: ['C:\\x'] },
      { type: 'submitDialog', request: { kind: 'force' } },
    ]) {
      expect(parseExplorerIntent(bad)).toBeUndefined();
    }
  });
});

describe('ExplorerModel', () => {
  const make = () => {
    const listings: Record<string, string[]> = { '$/': ['Shop'], '$/Shop': ['Shop2023'], '$/Shop/Shop2023': ['Enterprise.Till.Server'] };
    const model = new ExplorerModel({ isMine, localPathOf: mappedAll, childrenOf: (p) => listings[p] });
    model.navigate(FOLDER);
    model.listing = LISTING;
    model.listState = 'ok';
    model.info = INFO;
    model.infoState = 'ok';
    model.status = STATUS;
    model.statusState = 'ok';
    return model;
  };

  it('opens a folder with its ancestors expanded and nothing selected', () => {
    const m = make();
    expect(m.isExpanded('$/Shop/Shop2023')).toBe(true);
    expect(m.selection).toEqual([]);
    expect(m.state().crumbs.map((c) => c.name)).toEqual(['$/', 'Shop', 'Shop2023', 'Enterprise.Till.Server']);
  });

  it('acts only on rows it listed', () => {
    const m = make();
    expect(m.rowsFor([`${FOLDER}/CLAUDE.md`])).toHaveLength(1);
    expect(m.rowsFor([`${FOLDER}/CLAUDE.md`, '$/Other/secret.txt'])).toBeUndefined();
  });

  it('knows the folders an intent may open: the tree, the crumbs, and the listed folders', () => {
    const m = make();
    expect(m.knows('$/Shop')).toBe(true);
    expect(m.knows(`${FOLDER}/Web`)).toBe(true);
    expect(m.knows(`${FOLDER}/CLAUDE.md`)).toBe(false);
    expect(m.knows('$/Secret')).toBe(false);
  });

  it('flips the direction on a second click of the same column', () => {
    const m = make();
    m.sortBy('latest');
    expect(m.sort).toEqual({ key: 'latest', dir: 'asc' });
    m.sortBy('latest');
    expect(m.sort).toEqual({ key: 'latest', dir: 'desc' });
  });

  it('bumps the dialog revision on every host change, so the page rebuilds it only then', () => {
    const m = make();
    const target = m.rowsFor([`${FOLDER}/Web`])!;
    m.openDialog(target);
    const first = m.dialog!.rev;
    expect(m.dialog).toMatchObject({ paths: [`${FOLDER}/Web`], recursive: true, what: 'Web' });
    m.updateDialog({ error: 'x' });
    expect(m.dialog!.rev).toBeGreaterThan(first);
    m.navigate('$/');
    expect(m.dialog).toBeUndefined();
  });

  it('posts labels, a footer, the allowed actions and the toolbar actions', () => {
    const m = make();
    m.selection = [`${FOLDER}/CLAUDE.md`];
    const s = m.state();
    expect(s.labels).toBe(S.sceLabels);
    expect(s.footer).toBe(S.sceFooter(23, undefined));
    expect(s.allowed).toContain('checkout');
    expect(s.folderAllowed).toEqual(expect.arrayContaining(['getLatest', 'getSpecific', 'history']));
  });

  it('never offers Rename or Delete for the folder being browsed, only for a selected item (review: a folder-menu delete would be recursive on the whole open folder)', () => {
    const m = make();
    m.selection = [`${FOLDER}/CLAUDE.md`];
    const s = m.state();
    // CLAUDE.md is a selected, downloaded, mapped file: both remain offered there.
    expect(s.allowed).toContain('rename');
    expect(s.allowed).toContain('delete');
    // The folder itself -- FOLDER, mapped -- must never offer either.
    expect(s.folderAllowed).not.toContain('rename');
    expect(s.folderAllowed).not.toContain('delete');
    // Nor at $/, even though root is mapped too (mappedAll maps every path).
    m.navigate('$/');
    expect(m.state().folderAllowed).not.toContain('rename');
    expect(m.state().folderAllowed).not.toContain('delete');
  });

  it('offers only what needs no local copy and no loaded status while info is still loading', () => {
    const m = make();
    m.info = undefined;
    m.infoState = 'loading';
    m.selection = [`${FOLDER}/CLAUDE.md`];
    expect(m.state().allowed).toEqual(['getLatest', 'getSpecific', 'history', 'delete', 'copyPath', 'open']);
  });

  it('allows Checkout but not Undo while status is still loading', () => {
    const m = make();
    m.status = undefined;
    m.statusState = 'loading';
    m.selection = [`${FOLDER}/CLAUDE.md`];
    const allowed = m.state().allowed;
    expect(allowed).not.toContain('undo');
    expect(allowed).toContain('checkout');
  });
});

describe('your pending Adds, which `dir` cannot list (VS shows them with a +)', () => {
  // `tf vc dir` lists what is on the server; a pending Add is not there yet,
  // so NewModule.vb was missing from the list while Visual Studio showed it.
  // `status` for the same folder has it.
  const add = (name: string, over: Partial<OwnedPendingChange> = {}): OwnedPendingChange => ({
    serverItem: `${FOLDER}/${name}`,
    localPath: mappedAll(`${FOLDER}/${name}`),
    changes: new Set(['Add', 'Edit', 'Encoding']),
    changeFlags: 7,
    itemType: 'File',
    encoding: 65001,
    itemId: -418371,
    date: '2026-10-02T08:42:59.92+02:00',
    owner: 'Filip',
    computer: 'DEVPC',
    workspace: 'DEVPC',
    ...over,
  });
  const withAdds = (...adds: OwnedPendingChange[]) => rows({ status: [...STATUS, ...adds] });

  it('lists a file you added, as Visual Studio does', () => {
    const r = row(withAdds(add('NewModule.vb')), 'NewModule.vb');
    expect(r).toEqual({
      name: 'NewModule.vb',
      serverPath: `${FOLDER}/NewModule.vb`,
      isFolder: false,
      added: true,
      pending: 'add',
      users: ['Filip'],
      userDetails: ['Filip (DEVPC/DEVPC): add, 2026-10-02'],
      statusKnown: true,
      latest: 'yes',
      lastCheckIn: '',
      localPath: mappedAll(`${FOLDER}/NewModule.vb`),
    });
  });

  it('lists a folder you added as a folder', () => {
    const r = row(withAdds(add('Novo', { itemType: 'Folder', changes: new Set(['Add']), changeFlags: 1 })), 'Novo');
    expect(r.isFolder).toBe(true);
    expect(r.added).toBe(true);
  });

  it("lists neither someone else's Add, nor one deeper down, nor one dir already listed", () => {
    const theirs = add('Theirs.vb', { owner: 'Boris', computer: 'BORIS', workspace: 'BORIS' });
    const deeper = add('Sub/Deep.vb');
    const listed = add('CLAUDE.md');
    const list = withAdds(theirs, deeper, listed);
    expect(list).toHaveLength(23);
    expect(list.filter((r) => r.added)).toEqual([]);
  });

  it('lists a folder only a deeper Add implies once, with no change of its own, and only right here', () => {
    const list = rows({
      status: [...STATUS, add('Novo', { itemType: 'Folder', changes: new Set(['Add']), changeFlags: 1 })],
      addedFolders: [`${FOLDER}/test`, `${FOLDER}/Novo`, `${FOLDER}/test/Deeper`, '$/Elsewhere/x', `${FOLDER}/CLAUDE.md`],
    });
    const implied = row(list, 'test');
    expect([implied.isFolder, implied.added, implied.pending, implied.users, implied.latest]).toEqual([true, true, '', [], 'yes']);
    // Novo has its own Add from status, which wins: one row, saying "add".
    expect(list.filter((r) => r.name === 'Novo').map((r) => r.pending)).toEqual(['add']);
    expect(list.filter((r) => r.added).map((r) => r.name).sort()).toEqual(['Novo', 'test']);
  });

  it('marks no listed row as added', () => {
    expect(rows().some((r) => r.added)).toBe(false);
  });

  it('dims what needs a server version, and allows the rest', () => {
    const added = fakeRow({ name: 'NewModule.vb', added: true, pending: 'add', serverChangeset: undefined });
    for (const action of ['getLatest', 'getSpecific', 'checkout', 'history', 'compare', 'view', 'annotate'] as const) {
      expect(refusal(action, [added]), action).toBe(S.scePendingAdd('NewModule.vb'));
    }
    for (const action of ['open', 'undo', 'rename', 'delete', 'copyPath'] as const) {
      expect(refusal(action, [added]), action).toBeUndefined();
    }
    expect(refusal('getLatest', [fakeRow({}), added])).toBe(S.scePendingAdd('NewModule.vb'));
  });
});
