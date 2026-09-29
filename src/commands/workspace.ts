import { join } from 'node:path';
import { S } from '../tf/strings.js';
import { checkMapping, whereMapped } from '../workspace/mappingRules.js';
import type { WorkspaceService } from '../workspace/WorkspaceService.js';
import type { WorkingFolder, WorkspaceInfo } from '../tf/types.js';

export interface PickItem<T> {
  label: string;
  description?: string;
  value: T;
}

/** Everything the flows ask of the user. `ui/workspaceUi.ts` is the VS Code implementation. */
export interface WorkspaceUi {
  pick<T>(title: string, items: PickItem<T>[]): Promise<T | undefined>;
  pickMany<T>(title: string, items: PickItem<T>[]): Promise<T[] | undefined>;
  input(title: string, value: string, validate: (v: string) => string | undefined): Promise<string | undefined>;
  /** A native folder path, or undefined when dismissed. */
  pickLocalFolder(title: string): Promise<string | undefined>;
  /** Modal. True only when the user chose `yes`. */
  confirm(message: string, detail: string, yes: string): Promise<boolean>;
  info(message: string): void;
  warn(message: string): void;
  progress<T>(title: string, task: (report: (message: string) => void, signal: AbortSignal) => Promise<T>): Promise<T>;
}

export interface WorkspaceDeps {
  service: Pick<WorkspaceService, 'list' | 'create' | 'map' | 'unmap' | 'folders' | 'get' | 'toTf' | 'fromTf'>;
  ui: WorkspaceUi;
  collectionUrl: string;
  /** Default name for a new workspace. */
  computerName: string;
  /** A fresh empty folder under the OS temp dir (design P1). */
  makeEmptyDir: () => string;
  /** Creates a local folder, after the confirm. */
  ensureDir: (nativePath: string) => void;
  /** Re-initialise Team Explorer after a workspace change. */
  afterChange: () => Promise<void>;
  /** Phase 5: look for conflicts under what a Get got. Optional so the tests of other flows need not care. */
  lookForConflicts?: (serverPaths: readonly string[]) => void;
  log: (line: string) => void;
}

const childOf = (server: string, name: string) => (server === '$/' ? `$/${name}` : `${server}/${name}`);
const parentOf = (server: string) => (server.lastIndexOf('/') <= 1 ? '$/' : server.slice(0, server.lastIndexOf('/')));
const nameOf = (server: string): string => (server === '$/' ? '$/' : server.slice(server.lastIndexOf('/') + 1));
/** Case-insensitive equality for both local paths (`\`) and server paths (`/`), ignoring a trailing separator. */
const same = (a: string, b: string) => a.replace(/[\\/]+$/, '').toLowerCase() === b.replace(/[\\/]+$/, '').toLowerCase();

const INVALID_NAME = /[;/\\:*?"<>|]/;
const BAD_CHARS = /[!%^]/;
const MAX_NAME_LENGTH = 64;

/**
 * Every check tf itself or `TfClient` would refuse, applied here TOO so a
 * hostile or buggy UI layer that skips (or mis-wires) the input box's own
 * `validate` callback can never reach `service.create` with a bad name
 * (Task 5 review M4/M5; Task 6 review M5). `existingNames` (this computer's
 * OWN workspace names, case-insensitive) catches the name Create's own
 * default (`d.computerName`) can collide with, now that Create is offered
 * even when this computer already has workspaces.
 */
function nameProblem(raw: string, existingNames: readonly string[] = []): string | undefined {
  const t = raw.trim();
  if (!t) return S.wsNameEmpty;
  if (t.length > MAX_NAME_LENGTH) return S.wsNameTooLong;
  if (t.startsWith('-')) return S.wsNameLeadingDash;
  if (INVALID_NAME.test(t)) return S.wsNameInvalid;
  if (BAD_CHARS.test(t)) return S.wsNameBadChars;
  if (existingNames.some((n) => n.toLowerCase() === t.toLowerCase())) return S.wsNameDuplicate(t);
  return undefined;
}

/**
 * A small standalone copy of the deepest-ancestor check, for MESSAGES ONLY: which of `folders`
 * (a workspace's OWN mappings) is the deepest ancestor-or-self of `server`.
 * The actual move/redundant/ok/refuse decision always comes from
 * `checkMapping`/`whereMapped` in `mappingRules.ts` -- this is only used to
 * NAME that ancestor in a confirm or info message.
 */
function findCoveringFolder(server: string, folders: readonly WorkingFolder[]): WorkingFolder | undefined {
  const key = (s: string) => (s === '$/' ? '$/' : s.replace(/\/+$/, '')).toLowerCase();
  const S_ = key(server);
  let best: WorkingFolder | undefined;
  let bestLen = -1;
  for (const f of folders) {
    const fk = key(f.serverItem);
    const ancestorOrSelf = fk === S_ || fk === '$/' || S_.startsWith(`${fk}/`);
    if (ancestorOrSelf && fk.length > bestLen) {
      best = f;
      bestLen = fk.length;
    }
  }
  return best;
}

/**
 * Everything that changed between two workspace snapshots, in ANY workspace,
 * EXCEPT the one pair `skipWs`/`skipServer` this action intentionally
 * changed. Design P2-P4: tf can silently rewire a mapping other than the one
 * asked for, and I2 requires naming the exact difference when it does.
 */
function diffOtherMappings(
  before: readonly WorkspaceInfo[],
  after: readonly WorkspaceInfo[],
  skipWs: string,
  skipServer: string,
): string[] {
  const key = (ws: string, server: string) => `${ws.toLowerCase()}\u0000${server.replace(/\/+$/, '').toLowerCase()}`;
  const skipKey = key(skipWs, skipServer);
  const entries = (all: readonly WorkspaceInfo[]) => {
    const m = new Map<string, { ws: string; server: string; local: string }>();
    for (const w of all) for (const f of w.folders) m.set(key(w.name, f.serverItem), { ws: w.name, server: f.serverItem, local: f.localPath });
    return m;
  };
  const b = entries(before);
  const a = entries(after);
  const lines: string[] = [];
  for (const k of new Set([...b.keys(), ...a.keys()])) {
    if (k === skipKey) continue;
    const bv = b.get(k);
    const av = a.get(k);
    if (bv && av && same(bv.local, av.local)) continue;
    if (!bv && !av) continue;
    if (bv && !av) lines.push(`${bv.server} in ${bv.ws}: was mapped to ${bv.local}, now unmapped`);
    else if (!bv && av) lines.push(`${av.server} in ${av.ws}: newly mapped to ${av.local}`);
    else lines.push(`${av!.server} in ${av!.ws}: was ${bv!.local}, now ${av!.local}`);
  }
  return lines;
}

type Row = { kind: 'create' } | { kind: 'add' } | { kind: 'mapping'; folder: WorkingFolder };

/**
 * One action per invocation; every workspace change is behind a modal confirm.
 *
 * Create is always reachable, like Visual Studio's Manage Workspaces dialog -- not only when
 * this computer has no workspace yet. With exactly one existing workspace, the one-workspace
 * shortcut still applies (straight to its mapping list, no extra pick); Create just becomes
 * that list's own last row instead of a separate item. With two or more, the picker in between
 * (which workspace?) carries Create as its own last row instead.
 */
export async function manageWorkspace(d: WorkspaceDeps): Promise<void> {
  const listed = await d.service.list();
  if (!listed.ok) return d.ui.warn(listed.message);
  const all = listed.value;

  if (all.length === 0) {
    const row = await d.ui.pick<Row>(S.wsNone, [{ label: S.wsCreateItem, value: { kind: 'create' } }]);
    if (row?.kind === 'create') await createWorkspace(d);
    return;
  }

  let ws: WorkspaceInfo;
  if (all.length === 1) {
    // The pre-existing shortcut: skip straight to the one workspace's own mapping list. Create
    // is folded into that list below instead of a separate pick.
    ws = all[0];
  } else {
    type WsPick = { kind: 'create' } | { kind: 'existing'; ws: WorkspaceInfo };
    const wsPick = await d.ui.pick<WsPick>(S.wsPickWorkspace, [
      ...all.map((w) => ({ label: w.name, description: w.computer, value: { kind: 'existing' as const, ws: w } })),
      { label: S.wsCreateItem, value: { kind: 'create' as const } },
    ]);
    if (!wsPick) return;
    if (wsPick.kind === 'create') return createWorkspace(d, all);
    ws = wsPick.ws;
  }

  const row = await d.ui.pick<Row>(S.wsTitle(ws.name, ws.owner, ws.computer), [
    ...ws.folders.map((f) => ({ label: f.serverItem, description: d.service.fromTf(f.localPath), value: { kind: 'mapping' as const, folder: f } })),
    { label: S.wsAddMappingItem, value: { kind: 'add' } },
    // Only the one-workspace shortcut skipped a chance to Create above; with 2+ workspaces the
    // picker above already offered it, so it is not repeated here.
    ...(all.length === 1 ? [{ label: S.wsCreateItem, value: { kind: 'create' as const } }] : []),
  ]);
  if (!row) return;
  if (row.kind === 'create') return createWorkspace(d, all);
  if (row.kind === 'add') return addMapping(d, ws, all, true);
  if (row.kind !== 'mapping') return;

  const action = await d.ui.pick(row.folder.serverItem, [
    { label: S.wsGetItem, value: 'get' as const },
    { label: S.wsRemoveItem, value: 'remove' as const },
  ]);
  if (action === 'get') return offerGet(d, row.folder.serverItem, d.service.fromTf(row.folder.localPath), ws.folders);
  if (action === 'remove') return removeMapping(d, ws, row.folder);
}

/**
 * Phase 3 part 2: the Source Control Explorer's "Map to Local Folder…". Part
 * 1's Add Mapping, with the server path already chosen, so it starts at the
 * local folder picker; every check and confirm after that is the same.
 */
export async function mapServerFolder(d: WorkspaceDeps, server: string): Promise<void> {
  const listed = await d.service.list();
  if (!listed.ok) return d.ui.warn(listed.message);
  const all = listed.value;
  if (all.length === 0) return d.ui.warn(S.wsNoWorkspaceForMap);
  const ws =
    all.length === 1
      ? all[0]
      : await d.ui.pick(S.wsPickWorkspace, all.map((w) => ({ label: w.name, description: w.computer, value: w })));
  if (!ws) return;
  return addMapping(d, ws, all, true, server);
}

async function createWorkspace(d: WorkspaceDeps, existing: readonly WorkspaceInfo[] = []): Promise<void> {
  const existingNames = existing.map((w) => w.name);
  const name = await d.ui.input(S.wsNamePrompt, d.computerName, (v) => nameProblem(v, existingNames));
  if (!name) return;
  const trimmed = name.trim();
  // M5: re-checked here too, never trusting the UI layer's own validate alone.
  const problem = nameProblem(trimmed, existingNames);
  if (problem) return d.ui.warn(problem);

  if (!(await d.ui.confirm(S.wsCreateConfirm(trimmed), S.wsCreateDetail(d.collectionUrl), S.wsCreateYes))) return;

  const created = await d.service.create(trimmed, d.makeEmptyDir());
  if (!created.ok) {
    d.ui.warn(created.message);
    await d.afterChange();
    return;
  }
  d.log(`workspace ${trimmed} created`);
  await d.afterChange();

  const again = await d.service.list();
  const ws = again.ok ? again.value.find((w) => same(w.name, trimmed)) : undefined;
  if (again.ok && ws) await addMapping(d, ws, again.value, false);
}

async function browseServer(d: WorkspaceDeps): Promise<string | undefined> {
  let path = '$/';
  for (;;) {
    const listed = await d.service.folders(path);
    if (!listed.ok) {
      d.ui.warn(listed.message);
      return undefined;
    }
    type Step = { use: string } | { open: string };
    const items: PickItem<Step>[] = [
      { label: S.wsUseThisFolder(path), value: { use: path } },
      ...(path === '$/' ? [] : [{ label: S.wsUpOneLevel, value: { open: parentOf(path) } }]),
      ...listed.value.map((f) => ({ label: `$(folder) ${f}`, value: { open: childOf(path, f) } })),
    ];
    const step = await d.ui.pick(S.wsBrowseTitle(path), items);
    if (!step) return undefined;
    if ('use' in step) return step.use;
    path = step.open;
  }
}

async function addMapping(
  d: WorkspaceDeps,
  ws: WorkspaceInfo,
  all: WorkspaceInfo[],
  existed: boolean,
  preset?: string,
): Promise<void> {
  const server = preset ?? (await browseServer(d));
  if (!server) return;
  const local = await d.ui.pickLocalFolder(S.wsPickLocal(server));
  if (!local) return;
  const tfLocal = d.service.toTf(local);

  const verdict = checkMapping({ serverItem: server, localPath: tfLocal }, ws, all);
  if (verdict.kind === 'refuse') {
    const m = verdict.mapping;
    const mLocal = d.service.fromTf(m.localPath);
    if (verdict.reason === 'localInUse') return d.ui.warn(S.wsMapLocalInUse(local, m.serverItem, verdict.workspace));
    if (verdict.reason === 'insideOther') return d.ui.warn(S.wsMapInsideOther(local, mLocal, m.serverItem, verdict.workspace));
    return d.ui.warn(S.wsMapContainsOther(local, mLocal, m.serverItem, verdict.workspace));
  }
  if (verdict.kind === 'redundant') {
    const parentLocal = d.service.fromTf(verdict.parent.localPath);
    // The exact explicit pair again: its "parent" is itself, and naming it as
    // the mapping it goes through reads as nonsense (FEDORA acceptance item 6).
    if (verdict.parent.serverItem.toLowerCase() === server.toLowerCase()) {
      return d.ui.info(S.wsMapAlreadyThere(server, parentLocal));
    }
    return d.ui.info(S.wsMapRedundant(server, verdict.parent.serverItem, parentLocal));
  }

  // Review (phase 3 part 2): the explorer's Map to Local Folder (`preset` is
  // the server path the explorer already listed) may never MOVE an existing
  // mapping -- moving one is Manage Workspace's own Add Mapping, which the
  // user reaches deliberately and still gets the move confirm below. Refuse
  // outright rather than showing that confirm here, whether the existing
  // mapping is this exact server path or an ancestor's.
  if (preset !== undefined && verdict.kind === 'move') {
    return d.ui.warn(S.sceAlreadyMapped(nameOf(server), d.service.fromTf(verdict.from)));
  }

  const isMove = verdict.kind === 'move';
  const fromLocal = verdict.kind === 'move' ? d.service.fromTf(verdict.from) : undefined;
  // I1: a move/override confirm names the workspace, where it is now, and where it would go,
  // and says a Get after this MOVES the files there (P11) and Visual Studio will only find
  // them at the new place. A plain add still distinguishes an existing (shared) workspace
  // from one just created in this same command.
  const confirmed = isMove
    ? await d.ui.confirm(S.wsMoveConfirm(server, fromLocal!, local), S.wsMoveDetail(ws.name, server, fromLocal!, local), S.wsMoveYes)
    : await d.ui.confirm(S.wsMapConfirm(ws.name, server, local), existed ? S.wsMapShared : S.wsMapNew, S.wsMapYes);
  if (!confirmed) return;

  // I2: re-check right before tf runs -- nothing else may have changed the mapping
  // table between the confirm and this call.
  const fresh = await d.service.list();
  if (!fresh.ok) return d.ui.warn(fresh.message);
  const freshWs = fresh.value.find((w) => same(w.name, ws.name));
  if (!freshWs) return d.ui.warn(S.wsMapChangedBeforeApply(server, ws.name));
  const recheck = checkMapping({ serverItem: server, localPath: tfLocal }, freshWs, fresh.value);
  // Same guard as above, for the mapping that appeared between the initial
  // check and this re-check (e.g. someone else mapped it while the confirm
  // was on screen): a preset path still may not move.
  if (preset !== undefined && recheck.kind === 'move') {
    return d.ui.warn(S.sceAlreadyMapped(nameOf(server), d.service.fromTf(recheck.from)));
  }
  const unchanged = recheck.kind === verdict.kind && (recheck.kind !== 'move' || same(recheck.from, (verdict as { from: string }).from));
  if (!unchanged) return d.ui.warn(S.wsMapChangedBeforeApply(server, ws.name));

  d.ensureDir(local);
  const mapped = await d.service.map(ws.name, server, local);
  if (!mapped.ok) return d.ui.warn(mapped.message);
  d.log(`mapped ${server} -> ${local} in ${ws.name}`);

  // I2 / follow-up 1: verify with `whereMapped`, not "an explicit pair exists" --
  // a move back to where the parent naturally puts it is dropped by tf as
  // redundant (P4) and an explicit-pair check would false-warn on that.
  const after = await d.service.list();
  if (!after.ok) {
    await d.afterChange();
    return d.ui.warn(S.wsMapUnverified(server, local, after.message));
  }
  const now = after.value.find((w) => same(w.name, ws.name));
  const resolved = now ? whereMapped(server, now.folders) : undefined;
  const there = resolved !== undefined && same(resolved, tfLocal);
  const sideEffects = now ? diffOtherMappings(fresh.value, after.value, ws.name, server) : [];
  await d.afterChange();
  if (!there) return d.ui.warn(S.wsMapNotAsAsked(server, local));
  if (sideEffects.length > 0) d.ui.warn(S.wsMapSideEffects(sideEffects));
  d.ui.info(S.wsMapped(server, local));
  await offerGet(d, server, local, now!.folders, isMove ? fromLocal : undefined);
}

async function removeMapping(d: WorkspaceDeps, ws: WorkspaceInfo, folder: WorkingFolder): Promise<void> {
  const local = d.service.fromTf(folder.localPath);
  const remaining = ws.folders.filter((f) => f !== folder);
  const parent = findCoveringFolder(folder.serverItem, remaining);
  const movesBackTo = parent ? whereMapped(folder.serverItem, remaining) : undefined;
  const detail =
    parent && movesBackTo !== undefined ? S.wsUnmapMovesBack(parent.serverItem, d.service.fromTf(movesBackTo)) : S.wsUnmapDetail;

  if (!(await d.ui.confirm(S.wsUnmapConfirm(ws.name, folder.serverItem, local), detail, S.wsUnmapYes))) return;

  // I2: re-check right before tf runs -- confirm the exact pair is still there.
  const fresh = await d.service.list();
  if (!fresh.ok) return d.ui.warn(fresh.message);
  const freshWs = fresh.value.find((w) => same(w.name, ws.name));
  const stillThere = freshWs?.folders.some((f) => same(f.serverItem, folder.serverItem) && same(f.localPath, folder.localPath));
  if (!stillThere) return d.ui.warn(S.wsUnmapChangedBeforeApply(folder.serverItem, ws.name));

  const r = await d.service.unmap(ws.name, local);
  if (!r.ok) return d.ui.warn(r.message);
  d.log(`unmapped ${folder.serverItem} (${local}) from ${ws.name}`);

  // I2: re-check after tf runs too, and use ITS state (not the pre-confirm guess)
  // for the P11 "moves back" note, since that is the more accurate snapshot.
  const after = await d.service.list();
  if (!after.ok) {
    await d.afterChange();
    return d.ui.warn(S.wsUnmapUnverified(folder.serverItem, after.message));
  }
  const afterWs = after.value.find((w) => same(w.name, ws.name));
  const stillMapped = afterWs?.folders.some((f) => same(f.serverItem, folder.serverItem));
  await d.afterChange();
  if (stillMapped) return d.ui.warn(S.wsUnmapNotAsAsked(folder.serverItem));

  const parentAfter = afterWs ? findCoveringFolder(folder.serverItem, afterWs.folders) : undefined;
  const toAfter = parentAfter && afterWs ? whereMapped(folder.serverItem, afterWs.folders) : undefined;
  if (parentAfter && toAfter !== undefined) {
    d.ui.info(S.wsUnmappedMovesBack(folder.serverItem, parentAfter.serverItem, d.service.fromTf(toAfter)));
  } else {
    d.ui.info(S.wsUnmapped(folder.serverItem));
  }
}

/**
 * Design W4: subfolders as a checklist, nothing ticked; a folder with none gets a yes/no.
 * `folders` is the target workspace's OWN mapping table (fresh as of the caller), used to
 * resolve each ticked subfolder through `whereMapped` (M1): a subfolder that a DIFFERENT,
 * more specific mapping sends elsewhere (or that resolves nowhere) is skipped, not silently
 * downloaded into the wrong place or folded into a whole-tree Get.
 */
async function offerGet(
  d: WorkspaceDeps,
  server: string,
  local: string,
  folders: readonly WorkingFolder[],
  movedFrom?: string,
): Promise<void> {
  const sub = await d.service.folders(server);
  // M2: a folders() failure stops here -- never falls back to a whole-tree Get.
  if (!sub.ok) return d.ui.warn(sub.message);

  let targets: { server: string; local: string }[];
  if (sub.value.length === 0) {
    const confirmMessage = movedFrom ? S.wsGetNowConfirmMoved(server, movedFrom, local) : S.wsGetNowConfirm(server);
    if (!(await d.ui.confirm(confirmMessage, '', S.wsGetNowYes))) return;
    targets = [{ server, local }];
  } else {
    if (movedFrom) d.ui.info(S.wsGetMovedNotice(server, movedFrom, local));

    const EVERYTHING = '';
    const picked = await d.ui.pickMany(S.wsGetWhich(server), [
      { label: S.wsGetEverything(server), value: EVERYTHING },
      ...sub.value.map((f) => ({ label: f, value: f })),
    ]);
    if (!picked || picked.length === 0) return;

    if (picked.includes(EVERYTHING)) {
      targets = [{ server, local }];
    } else {
      targets = [];
      for (const f of picked) {
        const childServer = childOf(server, f);
        const resolved = whereMapped(childServer, folders);
        const expected = d.service.toTf(join(local, f));
        if (resolved === undefined) {
          d.ui.warn(S.wsGetUnmapped(childServer));
        } else if (!same(resolved, expected)) {
          d.ui.warn(S.wsGetElsewhere(childServer, d.service.fromTf(resolved)));
        } else {
          targets.push({ server: childServer, local: join(local, f) });
        }
      }
      if (targets.length === 0) return;
    }
  }

  const attempted: string[] = [];
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    attempted.push(t.server);
    const r = await d.ui.progress(S.wsGetting(t.server), (report, signal) =>
      d.service.get(t.local, (n) => report(S.wsGettingCount(n)), signal),
    );
    const remaining = targets.slice(i + 1).map((x) => x.server);
    const notAttempted = remaining.length > 0 ? `\n\n${S.wsGetNotAttempted(remaining.join(', '))}` : '';
    if (!r.ok) {
      d.ui.warn(`${r.message}${notAttempted}`);
      break;
    }
    if (r.value.cancelled) {
      d.ui.info(`${S.wsGetCancelled(t.server, r.value.items)}${notAttempted}`);
      break;
    }
    d.ui.info(S.wsGetDone(t.server, r.value.items));
  }
  await d.afterChange();
  // After afterChange, not before: a Get after a NEW mapping needs Team
  // Explorer reinitialised before anything can map the paths it got.
  d.lookForConflicts?.(attempted);
}
