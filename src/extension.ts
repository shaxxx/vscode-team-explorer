import * as vscode from 'vscode';
import { basename, join } from 'node:path';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { homedir, hostname, tmpdir } from 'node:os';
import { TfClient, scrubSecrets, findUnsafeArgs, type TfError } from './tf/TfClient.js';
import type { Platform } from './tf/PathMapper.js';
import { TfvcService } from './TfvcService.js';
import { ScmProvider } from './ui/ScmProvider.js';
import { DecorationProvider } from './ui/DecorationProvider.js';
import { ActiveFileState } from './ui/ActiveFileState.js';
import { DEFAULT_IGNORE, type Ignorer } from './ignore/IgnoreMatcher.js';
import { findTfIgnore, combineIgnoreSources, hasControlChar } from './ignore/readTfIgnore.js';
import { UnversionedScan } from './scan/UnversionedScan.js';
import { ServerContentProvider, TFVC_SCHEME, decodeWithCodePage, type ShelvedRef } from './ui/ServerContentProvider.js';
import { VersionStore, versionTextFrom } from './history/VersionStore.js';
import { QuickDiff } from './ui/QuickDiff.js';
import { compareVerdict, localLooksLikeText } from './ui/compareTarget.js';
import { registerCommands } from './commands/index.js';
import { unwrapTargets } from './commands/resolveTarget.js';
import { registerCheckIn } from './commands/checkIn.js';
import { registerFileOps } from './commands/fileOps.js';
import { FileOpsService } from './fileops/FileOpsService.js';
import { HistoryService } from './history/HistoryService.js';
import { registerHistory, VERSION_TEMP_DIR, versionDocument } from './commands/history.js';
import { Annotator } from './annotate/Annotator.js';
import { registerAnnotate } from './commands/annotate.js';
import { registerSetPat, storedPat } from './commands/setPat.js';
import { migrateStateKeys } from './migrateState.js';
import { writePatFile, defaultPatFilePath } from './pat/PatStore.js';
import { AutoCheckout, type AutoCheckoutMode } from './commands/autoCheckout.js';
import { EncodingFixer } from './commands/encodingFixer.js';
import { S, INSTALL_GUIDE_URL } from './tf/strings.js';
import { messageFor } from './tf/errorMessage.js';
import { WorkspaceService } from './workspace/WorkspaceService.js';
import { manageWorkspace, mapServerFolder, type WorkspaceDeps } from './commands/workspace.js';
import { workspaceUi } from './ui/workspaceUi.js';
import { ExplorerService } from './explorer/ExplorerService.js';
import { filesUnder, isServerPath } from './explorer/explorerModel.js';
import { SourceControlExplorer, EXPLORER_VIEW_TYPE } from './ui/SourceControlExplorer.js';
import { registerShowInExplorer } from './commands/showInExplorer.js';
import { registerRevealInExplorer } from './commands/revealInExplorer.js';
import { ShelveService } from './shelve/ShelveService.js';
import { ShelvesetsView, SHELVESETS_VIEW_TYPE } from './ui/ShelvesetsView.js';
import { registerShelve } from './commands/shelve.js';
import { ConflictService } from './conflicts/ConflictService.js';
import { ConflictsView } from './ui/ConflictsView.js';
import { createConflictActions, registerConflictCommands } from './commands/conflicts.js';
import { lookForConflictsAfterGet } from './conflicts/afterGet.js';
import { defaultWrapperPath } from './tf/wrapperPath.js';

/**
 * Injected by esbuild. Declared, not imported: under vitest the bundle is never
 * built, so the fallback is what the tests see.
 */
declare const __BUILD_STAMP__: string | undefined;

/** Local wall-clock time, to the millisecond. */
function stamp(d = new Date()): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return (
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `.${pad(d.getMilliseconds(), 3)}`
  );
}

/**
 * Wraps the output channel so every line carries the time it was written.
 *
 * Ten seconds passed between focusing the window and the panel updating, and
 * the log could not say where they went: the debounce is 300 ms and `status`
 * reported 800 ms, so roughly nine seconds are unaccounted for and every
 * candidate explanation - the event arriving late, a queue of refreshes, a
 * slow seed - looks identical in an unstamped log. TfClient already times each
 * command; this makes the GAPS BETWEEN commands visible, which is where the
 * missing time has to be.
 *
 * Local time on purpose: it is compared against the user's own clock and
 * against what they just did in Visual Studio.
 *
 * Stops forwarding `append`/`appendLine` once `subscriptions` is disposed, by
 * pushing a disposable onto it that flips a flag: a scan or a command can
 * still be finishing its own async work after deactivation (nothing cancels
 * an in-flight `tf`), and writing to a channel VS Code has already torn down
 * is worse than losing that last line.
 */
export function timestamped(
  inner: vscode.OutputChannel,
  subscriptions: { push(d: { dispose(): void }): void } = [],
): vscode.OutputChannel {
  let disposed = false;
  subscriptions.push({ dispose: () => { disposed = true; } });
  return {
    name: inner.name,
    append: (value: string) => { if (!disposed) inner.append(value); },
    appendLine: (value: string) => { if (!disposed) inner.appendLine(`${stamp()} ${value}`); },
    replace: (value: string) => inner.replace(value),
    clear: () => inner.clear(),
    // The overloads on show() are not worth reproducing to forward them.
    show: ((...args: unknown[]) =>
      (inner.show as (...a: unknown[]) => void)(...args)) as vscode.OutputChannel['show'],
    hide: () => inner.hide(),
    dispose: () => inner.dispose(),
  };
}

/**
 * `buildIgnorer`'s "log only on change" dedup state. Owned by whoever calls
 * `buildIgnorer` repeatedly over time -- normally one object per
 * `activate()` call, threaded through every call site in that activation, so
 * a second activation (a fresh object) always logs again rather than
 * inheriting a first activation's memory of what it already said. Left
 * absent (a fresh `{}` per call, the default), `buildIgnorer` behaves as if
 * nothing were ever logged before, which is exactly right for a one-off or
 * test call.
 */
export interface TfIgnoreLogState {
  lastTfIgnoreKey?: string;
  /** Same "log only on change" treatment for the setting's own dropped entries. */
  lastSettingIssues?: string;
}

export interface BuildIgnorerOptions {
  /**
   * Passed through to `findTfIgnore` as its `stopDir`: the local root of the
   * workspace mapping containing the folder, once `service.pathMapper` knows
   * it. Omitted before the mapping is known (at activation), which keeps
   * today's unbounded upward walk for that case.
   */
  readonly stopDir?: string;
  readonly logState?: TfIgnoreLogState;
}

/**
 * The ignore rules in force: the `teamExplorer.ignore` setting, plus a
 * `.tfignore` if the workspace has one.
 *
 * Logs what the `.tfignore` contributed, and every line it could not parse.
 * `readTfIgnore` is deliberately vscode-free and silent, so this is the only
 * place a user can find out that a file on disk is changing what they see --
 * which is the whole failure mode of honouring one.
 *
 * Exported for one test only. A lifecycle test can prove a `.tfignore` was
 * READ -- the log line says so -- but not that it was USED: the logging
 * happens before `combineIgnoreSources` is called, so passing `undefined` in
 * its place kept the whole suite green. Observing the returned `Ignorer`
 * directly is the only way to pin that without a successful `tf` call, which
 * tests are forbidden from making.
 *
 * Unparseable lines FAIL OPEN: they are skipped rather than guessed at. A
 * `.tfignore` we half understand, silently hiding a file the user needed to
 * check in, loses work; one we half ignore merely shows a file that did not
 * need showing. The `teamExplorer.ignore` setting is normalised the same
 * way a `.tfignore` line is: a non-string entry is dropped (with one log
 * line naming how many); each string is trimmed and has a single trailing
 * `/` or `\` stripped; an entry that is then empty, still contains a path
 * separator, still contains a control character (below U+0020 -- a NUL would
 * otherwise reach `TfClient.run()`'s argument list and make `spawn` throw),
 * or still contains a character `TfClient` refuses as a tf argument is
 * dropped, named in a log line, rather than silently disabling the whole
 * scan (I8) or being sent to tf mangled. Both the `.tfignore` summary and
 * these "dropped" lines log only on change, via `logState`.
 */
export function buildIgnorer(
  root: string,
  output: vscode.OutputChannel,
  options: BuildIgnorerOptions = {},
): Ignorer {
  const { stopDir, logState = {} } = options;

  // `get(section, default)` substitutes the default only for `undefined`, so a
  // hand-edited settings.json containing `"teamExplorer.ignore": null` -- or a
  // bare string, which is the natural typo for a one-entry list -- hands that
  // value straight through. `IgnoreMatcher`'s constructor then calls `.flatMap`
  // on it and throws, and because this runs inside `activate()` that rejects
  // the whole activation: no panel, no decorations, no commands, no Check In,
  // and nothing but a line in the extension-host log to say why.
  const raw = vscode.workspace.getConfiguration('teamExplorer').get<unknown>('ignore');
  let patterns: string[];
  if (Array.isArray(raw)) {
    const nonStringCount = raw.filter((p) => typeof p !== 'string').length;
    const dropped: string[] = [];
    patterns = [];
    for (const p of raw) {
      if (typeof p !== 'string') continue;
      let entry = p.trim();
      if (entry.endsWith('/') || entry.endsWith('\\')) {
        entry = entry.slice(0, -1);
      }
      if (entry === '') continue; // empty once normalised: nothing to report
      // A control character (a NUL from a stray bad edit, a TAB, ...) must
      // never reach `/exclude:` any more than one in a .tfignore line may --
      // an unfiltered NUL there makes `spawn` throw and loses the scan
      // entirely, not just this one pattern. `findUnsafeArgs` separately
      // catches %, ^, ! and CR/LF, but not a plain control character below
      // U+0020, hence the extra check.
      if (
        entry.includes('/') ||
        entry.includes('\\') ||
        hasControlChar(entry) ||
        findUnsafeArgs([entry]).length > 0
      ) {
        dropped.push(entry);
        continue;
      }
      patterns.push(entry);
    }

    // Logged only on change, exactly like the .tfignore summary below:
    // startScan() rebuilds the ignorer on every scan, and an unconditional
    // line here would repeat the same complaint about a persistently bad
    // setting every 0.8-20 s forever.
    const settingIssuesKey =
      nonStringCount > 0 || dropped.length > 0
        ? JSON.stringify({ nonStringCount, dropped })
        : undefined;
    if (settingIssuesKey !== undefined && settingIssuesKey !== logState.lastSettingIssues) {
      logState.lastSettingIssues = settingIssuesKey;
      if (nonStringCount > 0) {
        output.appendLine(
          `teamExplorer.ignore: dropped ${nonStringCount} non-string entr${
            nonStringCount === 1 ? 'y' : 'ies'
          }`,
        );
      }
      if (dropped.length > 0) {
        output.appendLine(
          `teamExplorer.ignore: dropped entr${
            dropped.length === 1 ? 'y' : 'ies'
          } still containing a path separator or a character tf cannot accept: ${dropped.join(', ')}`,
        );
      }
    } else if (settingIssuesKey === undefined) {
      logState.lastSettingIssues = undefined;
    }
  } else {
    patterns = [...DEFAULT_IGNORE];
    if (raw !== undefined) {
      output.appendLine(
        `teamExplorer.ignore is ${raw === null ? 'null' : typeof raw}, not an array of strings; ` +
          'using the built-in list instead',
      );
    }
  }

  const loaded = findTfIgnore(root, stopDir);
  if (loaded) {
    // Keyed on the WHOLE parse result -- path, rules and skipped lines -- not
    // just a rule count: two different .tfignore contents can share a rule
    // count (e.g. one rule swapped for another), and a summary keyed on the
    // count alone would never notice and never log the new content. This
    // runs again on every scan, so an unconditional line would repeat the
    // same facts every 0.8-20 s forever.
    const key = JSON.stringify({ path: loaded.path, rules: loaded.rules, skipped: loaded.skipped });
    if (key !== logState.lastTfIgnoreKey) {
      logState.lastTfIgnoreKey = key;
      output.appendLine(`.tfignore: ${loaded.path} contributed ${loaded.rules.length} pattern(s)`);
      for (const line of loaded.skipped) {
        output.appendLine(`.tfignore: skipped a line this extension does not understand: ${line}`);
      }
    }
  } else {
    logState.lastTfIgnoreKey = undefined;
  }
  return combineIgnoreSources(patterns, loaded);
}

/**
 * Where Create Workspace makes the empty folder `vc workspace /new` runs in
 * (design P1). Not tmpdir() on Linux: the Flatpak VS Code on FEDORA has a
 * PRIVATE /tmp that the host cannot see (checked 2026-09-22), and tf runs on
 * the host through flatpak-spawn --host -- so `/new` would run in a folder
 * that does not exist there. The home folder is shared (filesystems=host).
 */
export function newWorkspaceDirBase(platform: Platform, home: string, tmp: string): string {
  return platform === 'win32' ? tmp : join(home, '.cache', 'vscode-tfvc');
}

export interface ReinitialiseDeps {
  service: Pick<TfvcService, 'initialize'>;
  output: vscode.OutputChannel;
  setEnabled: (on: boolean) => void;
  startScan: () => void;
}

/**
 * I3: re-runs initialize() after a workspace change (Manage Workspace) or a
 * Set PAT / rewrite retry, and REPORTS a failure instead of just turning the
 * menus off. Before this, `afterChange` was `const again = await
 * service.initialize(); setEnabled(!again); if (!again) startScan();` -- a
 * `vc status` timeout mid-session (a Get from Manage Workspace, say) hid every
 * menu for the rest of the session with nothing in the log or on screen to
 * say why.
 *
 * `service.initialize()` itself clears the pending-change cache and fires
 * `onDidChange` when it fails, so the SCM panel never keeps the previous
 * status's pending set -- and its Check In button -- on screen once this
 * runs. Observed after Remove Mapping of the opened folder's own mapping,
 * which fails the very check `initialize()` re-runs.
 *
 * Exported and given its own dependency object -- rather than staying a
 * closure over `activate()`'s locals -- so a test can drive a real failure
 * here directly, with a real `TfvcService` and a fake `tf`, instead of
 * scripting the whole Manage Workspace UI flow to reach it.
 */
export async function reinitialise(deps: ReinitialiseDeps): Promise<void> {
  const err = await deps.service.initialize();
  deps.setEnabled(!err);
  if (!err) {
    deps.startScan();
    return;
  }
  deps.output.appendLine(scrubSecrets(err.originalMessage));
  void vscode.window.showErrorMessage(scrubSecrets(messageFor(err)));
}

/**
 * Phase 5's `teamExplorer.resolveConflicts`, extracted so its one
 * hard requirement -- "phase 5 is not in this build" must never be read as
 * "zero conflicts" -- has a test that does not need a real VS Code command
 * registry. `execute` is `vscode.commands.executeCommand` in production;
 * before phase 5 merges that call REJECTS ("command 'teamExplorer.resolveConflicts'
 * not found"), and this deliberately has no catch of its own, so the
 * rejection propagates to ShelvesetsView unchanged rather than being read as
 * "no conflicts", which would let it delete a shelveset an S7 conflict still
 * refers to.
 */
export async function countConflicts(
  execute: (id: string, ...args: unknown[]) => Thenable<unknown>,
  paths: string[],
): Promise<number> {
  const found = await execute('teamExplorer.resolveConflicts', paths);
  if (typeof found !== 'number') throw new Error(S.unshelveConflictCheckUnavailable);
  return found;
}

/**
 * A shelved file's text, for the Shelvesets tab's Compare and View.
 * Extracted for its own test: inlined in `activate()`, a failed
 * `view` used to be one edit away from `return ''` instead of `throw` -- and
 * an empty string is exactly what this codebase already uses to mean "this
 * side of the compare has nothing" (ServerContentProvider's empty-query
 * side), so that failure would have read as "this shelveset deletes the
 * whole file" instead of showing the real fetch error.
 */
export function shelvedTextFrom(shelve: Pick<ShelveService, 'view'>): (ref: ShelvedRef) => Promise<string> {
  return async (ref: ShelvedRef): Promise<string> => {
    const r = await shelve.view(ref.shelveset, ref.owner, ref.serverPath);
    if (!r.ok) throw new Error(r.message);
    return decodeWithCodePage(r.value, ref.codePage);
  };
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const channel = vscode.window.createOutputChannel('Team Explorer');
  context.subscriptions.push(channel);
  const output = timestamped(channel, context.subscriptions);

  // Which build is actually loaded. Two acceptance retests in a row came back
  // as "nothing happened" with no way to tell from the log whether the host
  // window was even running the build that contained the fix.
  const stamp = typeof __BUILD_STAMP__ === 'string' ? __BUILD_STAMP__ : 'dev';
  output.appendLine(`TFVC extension activated (build ${stamp})`);

  // Before anything reads either key. ScmProvider loads the excluded list in
  // its constructor, so a migration running after that would be reading a
  // Memento whose contents had already been decided.
  await migrateStateKeys(context.workspaceState, context.secrets, output);

  registerSetPat(context);

  const config = vscode.workspace.getConfiguration('teamExplorer');
  // Required, and deliberately without a default: the old default was one
  // organisation's URL. Read once; the message asks for a reload.
  const raw = config.get<unknown>('collectionUrl', '');
  const collectionUrl = typeof raw === 'string' ? raw.trim() : '';

  /** One warning per window at activation, and again whenever a workspace command needs the URL. */
  const askForCollectionUrl = async (): Promise<void> => {
    output.appendLine(S.noCollectionUrl);
    const choice = await vscode.window.showWarningMessage(S.noCollectionUrl, S.openSettings);
    if (choice === S.openSettings) {
      await vscode.commands.executeCommand('workbench.action.openSettings', 'teamExplorer.collectionUrl');
    }
  };

  const folder = vscode.workspace.workspaceFolders?.[0];

  // I2: registered here, before the folder check below, and given its OWN
  // TfClient. `registerSetPat` is already registered this early for the same
  // reason -- the natural first move on a brand-new machine is an empty
  // window, then "Team Explorer: Manage Workspace", and that must not fail
  // with "command not found" when it is this command's whole job to be the
  // way out of an unmapped folder. Every workspace argv already carries an
  // explicit local path or `/collection:`, so this client's cwd only has to
  // exist, not mean anything to tf.
  const workspacePlatform: Platform = process.platform === 'win32' ? 'win32' : 'linux';
  const workspaceClient = new TfClient({
    wrapperPath: config.get<string>('wrapperPath') || defaultWrapperPath(process.platform, homedir()),
    timeoutMs: config.get<number>('commandTimeoutMs', 60_000),
    cwd: folder?.uri.fsPath ?? homedir(),
    log: (line) => output.appendLine(line),
  });
  const workspaces = new WorkspaceService(
    workspaceClient,
    collectionUrl,
    workspacePlatform,
    (line) => output.appendLine(line), // F6: the constructor's own log sink.
  );

  // I2/I3: a no-op until a folder is open and `reinitialise` below replaces
  // it. Without this hook, Get/Map/Unmap run from a folder-less window would
  // try to reinitialise a TfvcService that was never constructed.
  let afterWorkspaceChange: () => Promise<void> = async () => {};

  const workspaceDeps = (): WorkspaceDeps => ({
    service: workspaces,
    ui: workspaceUi,
    collectionUrl,
    computerName: hostname().split('.')[0].toUpperCase(),
    // F7: `.native` resolves the physical path. On Fedora, Wine
    // converts the cwd it is actually spawned with -- the RESOLVED
    // path -- while our own path conversion sees whatever
    // mkdtempSync returned, unresolved; when TMPDIR is a symlink the
    // two disagree, and the `/unmap` that follows `/new` in
    // WorkspaceService.create() fails against a path tf never saw.
    makeEmptyDir: () => {
      const base = newWorkspaceDirBase(workspacePlatform, homedir(), tmpdir());
      mkdirSync(base, { recursive: true });
      return realpathSync.native(mkdtempSync(join(base, 'tfvc-new-ws-')));
    },
    ensureDir: (p) => mkdirSync(p, { recursive: true }),
    afterChange: () => afterWorkspaceChange(),
    // Phase 5: a Get after mapping onto an existing folder is the
    // likeliest way to meet a blocked file (C3).
    lookForConflicts: lookForConflictsAfterGet,
    log: (line) => output.appendLine(line),
  });

  // I1: wrapped so a throw inside a flow -- ensureDir failing with EPERM, say
  // -- is caught here instead of becoming an unhandled rejection that VS Code
  // reports as its own, unrelated extension-host error.
  const runFlow = async (flow: (d: WorkspaceDeps) => Promise<void>): Promise<void> => {
    if (!collectionUrl) {
      await askForCollectionUrl();
      return;
    }
    try {
      await flow(workspaceDeps());
    } catch (e) {
      const detail = scrubSecrets(String((e as Error)?.message ?? e));
      output.appendLine(detail);
      void vscode.window.showErrorMessage(detail);
    }
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('teamExplorer.manageWorkspace', () => runFlow(manageWorkspace)),
    // Phase 3 part 2: the Source Control Explorer's "Map to Local Folder…".
    // Internal (hidden from the palette) but globally invocable, so the
    // argument is checked before part 1's flow ever sees it.
    vscode.commands.registerCommand('teamExplorer.mapServerFolder', (serverPath: unknown) => {
      if (!isServerPath(serverPath)) {
        output.appendLine('mapServerFolder: ignored an invalid argument');
        return;
      }
      return runFlow((d) => mapServerFolder(d, serverPath));
    }),
  );

  if (!collectionUrl) {
    // Not awaited, for the reason offerRecovery gives: activate() must never
    // wait on a notification. Before `if (!folder) return;` on purpose: an
    // EMPTY window (no folder open) still needs the warning -- a first-time
    // install opens exactly that window, and this used to say nothing at all.
    void askForCollectionUrl().catch((e) =>
      output.appendLine(scrubSecrets(String((e as Error)?.message ?? e))),
    );
    return;
  }

  if (!folder) return;

  const client = new TfClient({
    wrapperPath: config.get<string>('wrapperPath') || defaultWrapperPath(process.platform, homedir()),
    timeoutMs: config.get<number>('commandTimeoutMs', 60_000),
    cwd: folder.uri.fsPath,
    log: (line) => output.appendLine(line),
  });

  const service = new TfvcService(client, folder, collectionUrl, output);
  context.subscriptions.push(service);

  // Built here, rebuilt when the setting changes AND immediately before every
  // scan (see startScan). The contract is
  // "re-read per call", which does NOT mean re-CONSTRUCT per call: building an
  // IgnoreMatcher compiles 16-plus regexes at 7.48 us, and
  // provideFileDecoration runs once per visible Explorer row on every refresh,
  // so constructing per call measured 3.44 ms per 500 rows against 0.62 ms
  // cached (measured 2026-09-18).
  //
  // A `.tfignore` is read here too, if the workspace has one. It is never
  // created or modified: Visual Studio and the other machine read the same
  // file.
  //
  // `tfIgnoreLogState` is owned by THIS activation alone -- a fresh object
  // every time `activate()` runs, never a module-level `let` -- so a second
  // activation logs its own findings again instead of silently inheriting
  // the first activation's memory of what it already said.
  const tfIgnoreLogState: TfIgnoreLogState = {};
  // Before `service.initialize()` succeeds, `service.pathMapper` is
  // undefined and `findTfIgnore` gets no `stopDir`, exactly like before this
  // task: the walk is unbounded until the workspace mapping tells us where
  // to stop.
  const rebuildIgnorer = (): Ignorer =>
    buildIgnorer(folder.uri.fsPath, output, {
      stopDir: service.pathMapper?.localRootFor(folder.uri.fsPath),
      logState: tfIgnoreLogState,
    });
  let ignorer = rebuildIgnorer();
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('teamExplorer.ignore')) return;
      // Rebuilt AND re-scanned. Rebuilding alone leaves the tree filtering by
      // the new list while the panel's third group still holds a ScanResult
      // built with the old one, so the two disagree until the next Refresh.
      ignorer = rebuildIgnorer();
      startScan();
    }),
  );

  const scan = new UnversionedScan(
    client,
    folder.uri.fsPath,
    service.platform,
    () => ignorer,
    output,
    // "Local" means local to TF.EXE, not to us. On Fedora tf runs under Wine
    // and sees the disk as Z:, so /home/shax/... is a path it cannot resolve.
    //
    // NEVER fall back to the untranslated path when the mapper is missing.
    // toWinePath is the IDENTITY on Windows, so a fallback looks perfectly
    // correct on DEVPC and is wrong only on FEDORA -- which is precisely how
    // this shipped wrong the first time. doRun's try/catch turns this into one
    // honest log line instead of a silently empty scan.
    (p) => {
      const mapper = service.pathMapper;
      if (!mapper) throw new Error('scan ran before the workspace mapping was known');
      return mapper.toWinePath(p);
    },
  );
  context.subscriptions.push(scan);

  // The FileSystemWatcher always intended here. The scan itself is a
  // SNAPSHOT: a file created, or
  // renamed/moved into place, after it started was never seen, and a creation
  // timestamp alone is not enough to catch that -- a rename or a same-volume
  // move keeps the file's birthtime (measured on NTFS: 312 ms before the scan
  // start after a rename), which used to put the hazard badge on every file
  // inside a folder renamed in after the scan. `noteArrival`/`noteDeparture`
  // are the fix; this is what feeds them. Unconditional on `initialize()`
  // succeeding, like `scan` itself: a file can appear before the workspace
  // mapping is even known.
  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(folder, '**/*'),
  );
  context.subscriptions.push(watcher);
  context.subscriptions.push(watcher.onDidCreate((uri) => scan.noteArrival(uri.fsPath)));
  context.subscriptions.push(watcher.onDidDelete((uri) => scan.noteDeparture(uri.fsPath)));

  /**
   * Starts a scan, unless the user has turned it off.
   *
   * Deliberately NOT awaited. The panel, the tree and every command work
   * before this finishes; the badges and the third group fill in when it
   * lands. It costs ~0.8 s for a small project and 17-20 s for the whole
   * collection, and the user should never wait for either.
   *
   * `.catch` rather than bare `void`: `run()` propagates a rejection, and a
   * fire-and-forget call site would turn one into an unhandled rejection that
   * VS Code reports as an extension crash. `doRun` already catches its own
   * failures, so this only fires for something truly unexpected.
   */
  const startScan = (userAsked = false): void => {
    const on = vscode.workspace
      .getConfiguration('teamExplorer')
      .get<boolean>('scanForNewFiles', true);
    if (!on) return;
    // Re-read the ignore rules HERE, not just on a settings change: a
    // `.tfignore` is a file on disk that Visual Studio and the other machine
    // also edit, and nothing watches it. Rebuilding costs ~7.5 us plus one
    // statSync against a scan that costs 0.8-20 s, so this is what makes
    // "takes effect on the next scan" true rather than merely claimed. By the
    // time this runs, `service.pathMapper` is usually known -- initialize()
    // ran first (see below) -- so this is also usually the first rebuild that
    // passes a real `stopDir`.
    ignorer = rebuildIgnorer();
    scan.run({ userAsked }).catch((e: unknown) => {
      output.appendLine(`scan for new files: ${scrubSecrets(String(e))}`);
    });
  };

  const scm = new ScmProvider(
    service,
    folder,
    context.workspaceState,
    output,
    () => scan.result,
    scan.onDidChange,
  );
  context.subscriptions.push(scm);

  // After ScmProvider so both are listening before initialize() fires the first
  // onDidChange.
  //
  // Registered even when initialize() later fails, though what the tree then
  // shows depends on WHICH failure. A failed initialize leaves `this.mapper`
  // undefined, so every path resolves to `unmapped` and NOTHING is drawn --
  // correct, if unhelpful. Locks appear in the other case: initialize()
  // succeeded and the status call failed, so there is a mapper but no pending
  // set, and every read-only file reads as `versioned`.
  const decorations = new DecorationProvider(
    service,
    () => ignorer,
    () => scan.result,
    folder.uri.fsPath,
    scm.isExcludedPath.bind(scm),
    scm.onDidChangeExcluded,
    scan.onDidChange,
  );
  context.subscriptions.push(decorations);

  // The editor's context menu gates on the active file's state. Same
  // source as the badges, so the menu and the tree cannot disagree. The
  // single trigger is the DECORATIONS' own change event, not the service's or
  // the scan's directly: DecorationProvider already re-fires that on a status
  // refresh, a landed scan, an exclusion change AND a `teamExplorer.ignore`/
  // `teamExplorer.decorations` settings change, so the key follows the badges
  // exactly -- listening to only two of those sources let the context key and
  // the tree disagree whenever a re-read came from one of the others (an
  // ignore-pattern edit while the scan is off, for instance).
  context.subscriptions.push(
    new ActiveFileState(decorations, [decorations.onDidChangeFileDecorations]),
  );

  // Phase 2: old versions, for the History tab and Annotate. Global storage,
  // so every window shares one cache and it survives a restart. Absent under
  // test, where the store simply runs without a disk cache.
  const versions = new VersionStore(
    client,
    context.globalStorageUri ? join(context.globalStorageUri.fsPath, 'versions') : undefined,
    (line) => output.appendLine(line),
  );

  // Phase 4. Built here, before
  // the content provider, which serves shelved content through it.
  const shelveService = new ShelveService(client, collectionUrl);

  const contentProvider = new ServerContentProvider(
    client,
    () => service.pathMapper,
    (serverItem) => service.changeFor(serverItem)?.encoding,
    versionTextFrom(versions),
    shelvedTextFrom(shelveService),
  );
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(TFVC_SCHEME, contentProvider),
  );

  const quickDiff = new QuickDiff(service);
  scm.quickDiffProvider = quickDiff;

  // Constructed before registerCommands so the explicit checkout/undo commands
  // can clear its one-shot guard. The guard lifts on a save OR an
  // explicit checkout; wiring only the save leaves a document stuck forever
  // after a FAILED auto-checkout, because the file stays read-only, so the save
  // fails too, so onDidSaveTextDocument never fires.
  const autoCheckout = new AutoCheckout(
    client,
    service,
    output,
    // Re-read on every call. A WorkspaceConfiguration is a SNAPSHOT taken when
    // getConfiguration was called, so the captured `config` never sees a later
    // settings change -- and this setting is the escape hatch for the accepted
    // risk that onEdit pends every file a formatter touches. Turning it off had
    // no effect until the window was reloaded, which is precisely when someone
    // is trying to stop it mid-incident.
    () =>
      vscode.workspace
        .getConfiguration('teamExplorer')
        .get<AutoCheckoutMode>('autoCheckout', 'onEdit'),
  );
  context.subscriptions.push(autoCheckout);

  // Opens mis-decoded files with the code page TFVC records, before the user
  // can see mojibake or type into a buffer that already lost bytes.
  context.subscriptions.push(new EncodingFixer(client, service, output));

  registerCommands(
    context,
    client,
    service,
    scm,
    output,
    autoCheckout,
    contentProvider,
    startScan,
  );
  // Phase 3 part 3: F2, drag-and-drop and Delete in the file tree become TFVC
  // pending changes, and the explorer's Rename…/Delete run through the same
  // two commands.
  registerFileOps(context, {
    service,
    ops: new FileOpsService(client),
    output,
    scan: () => scan.result,
    refresh: () => {
      service.requestRefresh();
      startScan();
    },
  });
  registerCheckIn(context, client, service, scm, output, autoCheckout, contentProvider, startScan);

  // Phase 2: the History tab, and the two commands Annotate's hover links run.
  const history = new HistoryService(client, (line) => output.appendLine(line));
  const historyViews = registerHistory(context, { client, service, output, history, versions, alsoRefresh: startScan });

  // Phase 2: Annotate. Constructing it does nothing -- no listener, no
  // decoration type, no tf -- until a file is annotated (D5).
  registerAnnotate(
    context,
    new Annotator({
      history,
      versions,
      mapper: () => service.pathMapper,
      changeFor: (serverPath) => service.changeFor(serverPath),
      log: (line) => output.appendLine(line),
    }),
  );

  const compareWithLatest = async (...args: unknown[]): Promise<void> => {
    // Reachable from the SCM panel (a resource state, possibly a multi-select
    // array), the editor context menu (a Uri) and the palette (nothing).
    // Diffing is single-file, so take the first target rather than silently
    // substituting the active editor when a selection was made.
    const target =
      (unwrapTargets(args)[0] as vscode.Uri | undefined) ??
      vscode.window.activeTextEditor?.document.uri;
    if (!target) {
      void vscode.window.showWarningMessage(S.noTarget);
      return;
    }

    // NOT quickDiff.provideOriginalResource: that returns undefined for any
    // file with no pending change, which is right for gutter bars and wrong
    // here. `view /version:T` works for anything under version control, and
    // this command previously did nothing, silently, for every unmodified
    // file the user tried it on.
    const serverItem = service.pathMapper?.toServerPath(target.fsPath);
    const verdict = compareVerdict(serverItem !== undefined, service.changeFor(serverItem ?? ''), () =>
      localLooksLikeText(target.fsPath),
    );
    const name = basename(target.fsPath);

    if (verdict === 'unmapped') {
      void vscode.window.showWarningMessage(S.noWorkspaceMapping);
      return;
    }
    if (verdict === 'pendingAdd') {
      void vscode.window.showInformationMessage(S.compareNoServerVersion(name));
      return;
    }
    if (verdict === 'binary') {
      void vscode.window.showInformationMessage(S.compareBinary(name));
      return;
    }

    await vscode.commands.executeCommand(
      'vscode.diff',
      // 'compare', not the bare URI: QuickDiff owns the bare one for the
      // gutter bars, and VS Code keeps one text model per URI. Sharing it
      // made Compare fail on any file that was already open.
      ServerContentProvider.uriFor(target.fsPath, 'compare'),
      target,
      'Team Explorer: server ↔ local',
    );
  };
  // Two ids, one handler. A menu entry cannot retitle a command, and the
  // editor menu names it by what it answers: "Compare with Latest Version" on
  // a file with pending changes, "Check for Server Changes" on one without
  // The palette lists only the first.
  context.subscriptions.push(
    vscode.commands.registerCommand('teamExplorer.compareWithLatest', compareWithLatest),
    vscode.commands.registerCommand('teamExplorer.checkForServerChanges', compareWithLatest),
  );

  // Phase 3 part 2: the Source Control Explorer. The same
  // client as every other command: its cwd is the opened folder, which is how
  // `info` resolves local versions in this workspace.
  const explorerService = new ExplorerService(client, collectionUrl);
  const sce = new SourceControlExplorer(() => context.extensionUri, {
    explorer: explorerService,
    mapper: () => service.pathMapper,
    showHistory: (target) => historyViews.show(target),
    recentChangesets: async (serverPath, folder) =>
      (await history.page({ mode: folder ? 'folder' : 'file', itemspec: serverPath }, {})).changesets.map((c) => ({
        id: c.id,
        user: c.user,
        date: c.date,
        comment: c.comment,
      })),
    mapServerFolder: async (serverPath) => {
      await vscode.commands.executeCommand('teamExplorer.mapServerFolder', serverPath);
    },
    unversionedUnder: (nativeFolder) => filesUnder(scan.result.unversionedPaths(), nativeFolder, service.platform),
    // What Phase 1's Get Latest does after a get: drop cached server copies,
    // refresh the pending changes, re-scan for files not in source control.
    afterGet: () => {
      contentProvider.invalidate();
      service.requestRefresh();
      startScan();
    },
    log: (line) => output.appendLine(line),
  });
  context.subscriptions.push(
    sce,
    service.onDidChange(() => sce.scheduleReload()),
    vscode.window.registerWebviewPanelSerializer(EXPLORER_VIEW_TYPE, {
      deserializeWebviewPanel: (panel, state) => sce.restore(panel, state),
    }),
    vscode.commands.registerCommand('teamExplorer.openExplorer', () =>
      sce.show(service.pathMapper?.toServerPath(folder.uri.fsPath) ?? '$/'),
    ),
    // X4: the activity bar home's only view. Empty on purpose: an empty view
    // shows its viewsWelcome content, the three buttons in package.json.
    vscode.window.registerTreeDataProvider<vscode.TreeItem>('teamExplorer.home', {
      getChildren: () => [],
      getTreeItem: (item) => item,
    }),
  );
  registerShowInExplorer(context, service, sce);
  registerRevealInExplorer(context);

  // Phase 4: shelvesets. Shelve from the Source Control title bar, and the
  // Shelvesets tab (Find Shelvesets). Unshelve hands its conflicts to phase 5.
  const shelvesets = new ShelvesetsView(() => context.extensionUri, {
    shelve: shelveService,
    workspaces: () => explorerService.workspaces(),
    mapper: () => service.pathMapper,
    afterUnshelve: () => {
      contentProvider.invalidate();
      service.requestRefresh();
      startScan();
    },
    // Until phase 5 is in the build this rejects ("command not
    // found"), or answers something that is not a count; either reads as
    // "could not check", and the shelveset is then never deleted.
    resolveConflicts: (paths) => countConflicts((id, ...a) => vscode.commands.executeCommand(id, ...a), paths),
    log: (line) => output.appendLine(line),
  });
  registerShelve(context, {
    service,
    scm,
    shelve: shelveService,
    output,
    autoCheckout,
    rescan: startScan,
    afterShelve: () => shelvesets.refreshIfOpen(),
  });
  context.subscriptions.push(
    shelvesets,
    vscode.window.registerWebviewPanelSerializer(SHELVESETS_VIEW_TYPE, {
      deserializeWebviewPanel: (panel, state) => shelvesets.restore(panel, state),
    }),
    vscode.commands.registerCommand('teamExplorer.findShelvesets', () => shelvesets.show()),
  );

  // Phase 5: conflict resolution.
  // ConflictService looks again after every status refresh (U3); the Conflicts
  // group and the Resolve Conflicts tab both follow its one change event.
  // Constructed before `service.initialize()` below, so the first refresh is
  // already a first look.
  const conflicts = new ConflictService(client, service, (line) => output.appendLine(line));
  const conflictsView = new ConflictsView(
    () => context.extensionUri,
    conflicts,
    createConflictActions({
      conflicts,
      // A resolution changes pending changes (C13) and files on disk (C16).
      afterAction: () => {
        service.requestRefresh();
        startScan();
      },
      platform: service.platform,
      versionDocument: (serverPath, changeset) => versionDocument(versions, VERSION_TEMP_DIR, { serverPath, changeset }),
    }),
    service.platform,
  );
  registerConflictCommands(context, { conflicts, showTab: (select) => conflictsView.show(select) });
  context.subscriptions.push(
    conflicts,
    conflictsView,
    conflicts.onDidChange(() => scm.setConflicts(conflicts.conflicts)),
  );

  // Gates every menu contribution. Without it, "Undo Pending Changes" and the
  // other three appeared in the right-click menu of every file in every VS Code
  // window, TFVC or not, because activationEvents is onStartupFinished.
  const setEnabled = (on: boolean) =>
    void vscode.commands.executeCommand('setContext', 'teamExplorer:enabled', on);
  setEnabled(false);

  // I2/I3: now that a folder is open, Get/Map/Unmap from Manage Workspace
  // reinitialise the REAL service instead of doing nothing.
  const doReinitialise = (): Promise<void> => reinitialise({ service, output, setEnabled, startScan });
  afterWorkspaceChange = doReinitialise;

  /**
   * The FIRST activation's own recovery flow, offering the actions
   * `reinitialise`'s generic failure handling does not: Set PAT, rewrite
   * pat.txt, or Set Up Workspace. Split out of `activate()` for I1: it used
   * to run inline, and `await`ing it there -- through a sticky notification
   * and, on "Set Up Workspace", the whole Manage Workspace flow including a
   * Get with no time limit -- held `activate()`'s own promise. VS Code
   * resolves activation only when that promise settles, so every OTHER
   * palette command of this extension did nothing until the user answered,
   * then fired late; a throw anywhere in here rejected activate() itself,
   * which VS Code reports as "Activating extension failed".
   */
  async function offerRecovery(error: TfError): Promise<void> {
    output.appendLine(scrubSecrets(messageFor(error)));
    const canRetry = error.kind === 'patMissing' || error.kind === 'patRejected';

    // A saved token means the FILE is what is broken — deleted,
    // emptied, or saved with a BOM, which `set /p` does not strip, so every
    // command fails with an opaque 401. Offer to rewrite it. Offer, never do
    // it silently: pat.txt is shared with the user's terminal workflow and
    // hand-edits there are never fought.
    // SecretStorage.get rejects when the Linux keyring is locked or absent --
    // a well-known state on exactly the Fedora machine this targets. Unguarded,
    // it rejected activate() and killed the extension at the moment the user
    // was being offered the recovery they needed.
    let saved: string | undefined;
    if (canRetry) {
      try {
        saved = await storedPat(context.secrets);
      } catch (e) {
        output.appendLine(`Could not read the saved token: ${(e as Error).message}`);
      }
    }
    // A folder that is simply not mapped is not a failure to recover from
    // (user, 2026-09-23): git folders and folders under no source control at
    // all are opened in the same VS Code, and a popup on each of them is
    // noise. It stays in the log, and Manage Workspace from the palette is
    // how such a folder gets mapped when the user wants it.
    if (error.originalMessage === S.noWorkspaceMapping) return;
    // A setup problem is fixed in settings or by following the guide; offer both.
    const setupProblem =
      error.kind === 'wrapperMissing' || error.kind === 'commandNotFound' ||
      error.kind === 'tfNotFound' || error.kind === 'wineMissing';
    const actions = canRetry
      ? (saved ? [S.setPat, S.rewritePatFile] : [S.setPat])
      : setupProblem ? [S.openSettings, S.installGuide] : [];

    // messageFor, not the raw text. A rejected token used to surface here as
    // "TF30063: You are not authorized to access ..." and nothing else, which
    // reads as a server-side permissions problem - so the same failure said
    // one thing from a command and something quite different at activation.
    const choice = await vscode.window.showErrorMessage(
      scrubSecrets(messageFor(error)),
      ...actions,
    );

    if (choice === S.openSettings) {
      await vscode.commands.executeCommand('workbench.action.openSettings', 'teamExplorer.wrapperPath');
      return;
    }
    if (choice === S.installGuide) {
      await vscode.env.openExternal(vscode.Uri.parse(INSTALL_GUIDE_URL));
      return;
    }

    if (choice === S.rewritePatFile && saved) {
      const path = defaultPatFilePath();

      // Never fight a hand-edit. This notification is modeless, so it can sit
      // there while the user fixes pat.txt from a terminal -- the documented
      // recovery. Clicking the button afterwards would overwrite their fresh
      // token with the stale one from SecretStorage. Ask when the file already
      // holds something else.
      let onDisk: string | undefined;
      try {
        onDisk = readFileSync(path, 'utf8').split(/\r?\n/)[0]?.trim();
      } catch {
        onDisk = undefined;
      }
      if (onDisk && onDisk !== saved) {
        const ok = await vscode.window.showWarningMessage(
          S.patFileDiffers(path),
          { modal: true },
          S.patFileDiffersYes,
        );
        if (ok !== S.patFileDiffersYes) return;
      }

      try {
        writePatFile(path, saved);
      } catch (e) {
        const detail = scrubSecrets((e as Error).message);
        output.appendLine(detail);
        void vscode.window.showErrorMessage(detail);
        return;
      }
      output.appendLine(S.patFileRewritten(path));
      void vscode.window.showInformationMessage(S.patFileRewritten(path));
    } else if (choice === S.setPat) {
      await vscode.commands.executeCommand('teamExplorer.setPat');
    } else {
      return;
    }

    await doReinitialise();
  }

  const error = await service.initialize();
  setEnabled(!error);
  // Only once the workspace mapping is known: the scan's itemspec translation
  // reads `service.pathMapper`, and a failed initialize leaves it undefined.
  if (!error) startScan();
  if (error) {
    // I1: detached, never awaited -- see offerRecovery's own comment. Any
    // throw inside is caught here instead of rejecting activate().
    void offerRecovery(error).catch((e) =>
      output.appendLine(scrubSecrets(String((e as Error)?.message ?? e))),
    );
  }
}

export function deactivate(): void {
  // All disposables are registered on the context.
}
