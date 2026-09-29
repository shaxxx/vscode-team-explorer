import * as vscode from 'vscode';
import { basename, join } from 'node:path';
import { chmodSync, existsSync, mkdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import type { TfClient } from '../tf/TfClient.js';
import type { TfvcService } from '../TfvcService.js';
import type { HistoryService } from '../history/HistoryService.js';
import type { VersionPointer } from '../history/historyModel.js';
import { VersionStore } from '../history/VersionStore.js';
import { ENC_BINARY } from '../tf/types.js';
import { HistoryViews } from '../ui/HistoryView.js';
import { ServerContentProvider } from '../ui/ServerContentProvider.js';
import { isReadOnly } from '../watch/readOnly.js';
import { runMutation } from './index.js';
import { unwrapTargets } from './resolveTarget.js';
import { S } from '../tf/strings.js';

export interface HistoryDeps {
  client: TfClient;
  service: TfvcService;
  output: vscode.OutputChannel;
  history: HistoryService;
  versions: Pick<VersionStore, 'bytesAt' | 'codePageAt'>;
  /** Re-scan after Get This Version, as after Get Latest. */
  alsoRefresh?: (userAsked?: boolean) => void;
  /** Where View This Version writes a binary version's bytes (D25). */
  tempDir?: string;
}

const nameOf = (serverPath: string): string => serverPath.slice(serverPath.lastIndexOf('/') + 1);

/**
 * Validates a hover link's (path, id) pair with D14's own rules (phase 2
 * D16g) -- `ServerContentProvider.parseVersionUri` is already the one place
 * that decides what a versioned URI may name, so a crafted `showChangeset` /
 * `compareVersions` invocation is held to exactly the same int32 cap and
 * forbidden-character set as a versioned URI, rather than a second,
 * possibly-looser copy of those rules.
 */
function parsedVersion(path: unknown, id: unknown): VersionPointer | undefined {
  if (typeof path !== 'string' || typeof id !== 'number') return undefined;
  const parsed = ServerContentProvider.parseVersionUri({ path: '/' + path, query: `v=C${id}` });
  return parsed ? { serverPath: parsed.serverPath, changeset: parsed.changeset } : undefined;
}

function isFolder(fsPath: string): boolean {
  try {
    return statSync(fsPath).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Writes a binary version's bytes to `file` for `vscode.open`, reusing what
 * is already there when it is the same size -- View clicked twice on the same
 * version must not re-fetch or re-write anything. Written to a temp name and
 * renamed, like VersionStore.write, so a reader never sees a half-written
 * file, then made read-only: this is a checked-in version, and the read-only
 * bit matches how Get This Version leaves a working copy. An older,
 * different-size read-only copy (a stale run of this same folder) is chmod'd
 * writable first, or the rename over it fails on Windows.
 */
function writeBinaryVersion(folder: string, file: string, bytes: Buffer): void {
  try {
    const existing = statSync(file);
    if (existing.size === bytes.length) return;
    chmodSync(file, 0o644);
  } catch {
    // Nothing there yet.
  }
  mkdirSync(folder, { recursive: true });
  const temp = join(folder, `${randomBytes(4).toString('hex')}.tmp`);
  writeFileSync(temp, bytes);
  renameSync(temp, file);
  chmodSync(file, 0o444);
}

/** Where a binary version's bytes are written for VS Code to open (D25). */
export const VERSION_TEMP_DIR = join(tmpdir(), 'vscode-tfvc');

/**
 * The file for one binary version. The changeset plus an 8-hex-char prefix of
 * VersionStore's own cache key keep two different server paths that share a
 * file name apart, while the folder keeps the REAL name as the file name so
 * VS Code picks its viewer by extension.
 */
function binaryVersionFile(tempDir: string, version: VersionPointer, bytes: Buffer): string {
  const hash = VersionStore.key(version.serverPath, version.changeset).slice(0, 8);
  const folder = join(tempDir, `C${version.changeset}-${hash}`);
  const file = join(folder, nameOf(version.serverPath));
  writeBinaryVersion(folder, file, bytes);
  return file;
}

/**
 * A URI VS Code can open, or diff, for one version: the `teamExplorer:`
 * content provider's for text, and for what TFVC calls binary a read-only
 * copy of its bytes on disk (D25) -- which VS Code then shows as text when it
 * IS text (an XML file tf labels Binary), and with its own binary notice when
 * it is not, as Visual Studio's diff does. Throws VersionStore's user-worded
 * errors.
 */
export async function versionDocument(
  versions: Pick<VersionStore, 'bytesAt' | 'codePageAt'>,
  tempDir: string,
  version: VersionPointer,
): Promise<vscode.Uri> {
  const got = await versions.bytesAt(version.serverPath, version.changeset, () =>
    versions.codePageAt(version.serverPath, version.changeset),
  );
  if (got.codePage !== ENC_BINARY) return ServerContentProvider.versionUri(version.serverPath, version.changeset);
  return vscode.Uri.file(binaryVersionFile(tempDir, version, got.bytes));
}

export function registerHistory(context: vscode.ExtensionContext, deps: HistoryDeps): HistoryViews {
  const { client, service, output, versions, tempDir = VERSION_TEMP_DIR } = deps;

  const compare = async (left: VersionPointer, right: VersionPointer, name: string): Promise<void> => {
    await vscode.commands.executeCommand(
      'vscode.diff',
      ServerContentProvider.versionUri(left.serverPath, left.changeset),
      ServerContentProvider.versionUri(right.serverPath, right.changeset),
      S.compareVersionsTitle(name, left.changeset, right.changeset),
    );
  };

  // D25 (acceptance item 25): View This Version used to go only through the
  // `teamExplorer:` TextDocumentContentProvider, which can hand VS Code text
  // and nothing else -- `versionTextFrom` refuses a binary rather than decode
  // it as one. `bytesAt` is called unconditionally, before the branch below:
  // it warms the exact disk cache entry `versionTextFrom` reads next, so a
  // TEXT version still costs no extra `tf` call, only now it is this call
  // site (not the content provider) that makes it.
  const view = async (version: VersionPointer): Promise<void> => {
    let got: { bytes: Buffer; codePage: number | undefined };
    try {
      got = await versions.bytesAt(version.serverPath, version.changeset, () =>
        versions.codePageAt(version.serverPath, version.changeset),
      );
    } catch (e) {
      // VersionStore errors are already user-worded (VersionError / messageFor).
      void vscode.window.showWarningMessage(e instanceof Error ? e.message : String(e));
      return;
    }
    if (got.codePage === ENC_BINARY) {
      const file = binaryVersionFile(tempDir, version, got.bytes);
      await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(file), { preview: true });
      return;
    }
    await vscode.window.showTextDocument(ServerContentProvider.versionUri(version.serverPath, version.changeset), {
      preview: true,
    });
  };

  // D1, extended by D16a. Each refusal is a way `get /version` could lose
  // work or leave the workspace somewhere the user did not ask for.
  const getVersion = async (version: VersionPointer, name: string): Promise<void> => {
    // D16a: a tab left open across a rename or a check-in made elsewhere is
    // exactly the case the model's own `getVersionRenamed` check (D1c) cannot
    // catch by itself -- it only sees the row's OWN printed path, not what
    // has happened to the file since. A stale pending-changes cache would
    // hide a pending change entirely, so status is re-read first and its
    // failure refuses outright rather than acting on data that might be wrong.
    //
    // D18g: wrapped in a window progress message -- re-reading the whole
    // workspace's pending changes is the same `vc status` `requestRefresh()`
    // debounces elsewhere, and on FEDORA that is measured in seconds.
    const error = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: S.getVersionChecking(name) },
      () => service.refresh(),
    );
    if (error) {
      void vscode.window.showWarningMessage(S.getVersionStatusUnknown(name));
      return;
    }
    // Computed before the pending-change check: a pending Rename or
    // SourceRename is indexed under the item's NEW identity, so a tab still
    // open on the OLD name finds nothing via `changeFor(serverPath)` alone.
    const local = service.pathMapper?.toLocalPath(version.serverPath);
    // D18i, corrected by D20f: the pending-change cache above only covers the
    // OPENED workspace folder's own `vc status` (TfvcService.doRefresh scopes
    // it to `workspaceRoot`) -- a path outside it could have a pending lock or
    // merge this cache has never seen, so acting on "nothing pending" here
    // would be silently unsafe. Compared on SERVER paths, not local ones: a
    // second working-folder mapping can put an unrelated server subtree's
    // local folder physically UNDER the opened folder's own local folder
    // (e.g. `$/Lib` mapped to `C:\work\Proj\lib`, nested inside `$/Proj`'s own
    // `C:\work\Proj`), which a local-path containment check would wrongly
    // call "inside" even though `vc status $/Proj /recursive` never scans it.
    const root = service.pathMapper?.toServerPath(service.workspaceRoot);
    const insideOpenedFolder =
      root !== undefined &&
      (version.serverPath.toLowerCase() === root.toLowerCase() ||
        version.serverPath.toLowerCase().startsWith(root.toLowerCase() + '/'));
    // `local` guards this exactly as it did before D20f: a version whose OWN
    // server path is not mappable at all (no working folder covers it) is a
    // plain `noWorkspaceMapping` refusal below, not "outside the folder" --
    // those are different problems with different fixes.
    if (local && !insideOpenedFolder) {
      void vscode.window.showWarningMessage(S.getVersionOutsideFolder(name));
      return;
    }
    if (service.changeFor(version.serverPath) || (local && service.changeForLocal(local))) {
      void vscode.window.showInformationMessage(S.getVersionPending(name));
      return;
    }
    if (!local) {
      void vscode.window.showWarningMessage(S.noWorkspaceMapping);
      return;
    }
    // D16a: the rename case above still slips past both pending-change checks
    // when the rename is not itself pending (checked in elsewhere) -- the
    // tell here is that the OLD local path this tab still knows about is
    // simply gone.
    if (!existsSync(local)) {
      void vscode.window.showWarningMessage(S.getVersionMissing(name));
      return;
    }
    if (!isReadOnly(local)) {
      void vscode.window.showWarningMessage(S.getVersionWritable(name));
      return;
    }
    const answer = await vscode.window.showWarningMessage(
      S.getVersionConfirmTitle(name, version.changeset),
      { modal: true, detail: S.getVersionConfirmDetail },
      S.getVersionConfirmYes,
    );
    if (answer !== S.getVersionConfirmYes) return;
    // The server path, like Get Latest. Never /overwrite, /force or /all: if
    // something is in the way tf refuses, and runMutation shows why.
    await runMutation(
      client,
      service,
      output,
      ['vc', 'get', version.serverPath, `/version:C${version.changeset}`],
      deps.alsoRefresh,
    );
  };

  const views = new HistoryViews(
    () => context.extensionUri,
    deps.history,
    { compare, view, getVersion },
    (line) => output.appendLine(line),
  );

  context.subscriptions.push(
    views,
    vscode.commands.registerCommand('teamExplorer.viewHistory', async (...args: unknown[]) => {
      const target =
        (unwrapTargets(args)[0] as vscode.Uri | undefined) ?? vscode.window.activeTextEditor?.document.uri;
      if (!target) {
        void vscode.window.showWarningMessage(S.noTarget);
        return;
      }
      const serverPath = service.pathMapper?.toServerPath(target.fsPath);
      if (!serverPath) {
        void vscode.window.showWarningMessage(S.noWorkspaceMapping);
        return;
      }
      const name = basename(target.fsPath);
      const change = service.changeFor(serverPath);
      if (change?.changes.has('Add')) {
        void vscode.window.showInformationMessage(S.historyPendingAdd(name));
        return;
      }
      // D16h: a pending SourceRename is the OTHER side of the same rename a
      // pending Rename names -- the item this tab would open has just as
      // little history under its new name either way.
      if (change?.changes.has('Rename') || change?.changes.has('SourceRename')) {
        void vscode.window.showInformationMessage(S.historyPendingRename(name));
        return;
      }
      await views.show({ mode: isFolder(target.fsPath) ? 'folder' : 'file', serverPath, name });
    }),
    // D7, tightened by D16g: the two commands Annotate's hover links run.
    // Globally invocable, so every argument is checked; each only opens a
    // view or a diff. `parsedVersion` holds them to D14's own rules for a
    // versioned URI -- the int32 cap and the forbidden-character set -- so
    // there is exactly one definition of "a valid (path, changeset) pair".
    vscode.commands.registerCommand('teamExplorer.showChangeset', async (serverPath: unknown, id: unknown) => {
      const v = parsedVersion(serverPath, id);
      if (!v) {
        output.appendLine('history: showChangeset ignored an invalid argument');
        return;
      }
      await views.show({ mode: 'file', serverPath: v.serverPath, name: nameOf(v.serverPath) }, v.changeset);
    }),
    vscode.commands.registerCommand(
      'teamExplorer.compareVersions',
      async (leftPath: unknown, leftId: unknown, rightPath: unknown, rightId: unknown) => {
        const left = parsedVersion(leftPath, leftId);
        const right = parsedVersion(rightPath, rightId);
        if (!left || !right) {
          output.appendLine('history: compareVersions ignored an invalid argument');
          return;
        }
        await compare(left, right, nameOf(right.serverPath));
      },
    ),
    // Phase 3 part 2: the Source Control Explorer's own `view`, on the version
    // `info` reported. Globally invocable, so it is held to `parsedVersion`'s
    // rules like the two above.
    vscode.commands.registerCommand('teamExplorer.viewVersion', async (serverPath: unknown, id: unknown) => {
      const v = parsedVersion(serverPath, id);
      if (!v) {
        output.appendLine('history: viewVersion ignored an invalid argument');
        return;
      }
      await view(v);
    }),
  );
  return views;
}
