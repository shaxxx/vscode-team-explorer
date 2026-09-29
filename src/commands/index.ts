import * as vscode from 'vscode';
import { statSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { win32 } from 'node:path';
import { isReadOnly } from '../watch/readOnly.js';
import { S } from '../tf/strings.js';
import {
  classifyError,
  scanAffectedItems,
  scrubSecrets,
  type TfClient,
  type TfError,
} from '../tf/TfClient.js';
import type { TfvcService } from '../TfvcService.js';
import type { ScmProvider } from '../ui/ScmProvider.js';
import { unwrapTargets } from './resolveTarget.js';
import { messageFor } from '../tf/errorMessage.js';
import { lookForConflictsAfterGet } from '../conflicts/afterGet.js';

/**
 * Runs `afterSuccess`, logging rather than throwing if it does.
 *
 * A throw here would reject `runMutation`'s own promise, and every caller
 * awaits it BEFORE its own follow-up work: Undo's `revertOpenBuffers`,
 * Check In's `scm.clearInputBox()`/cache invalidation/auto-checkout reset.
 * The re-scan callback is a courtesy, not part of the mutation that already
 * succeeded -- it must never be able to skip any of that.
 */
function runAfterSuccess(afterSuccess: (() => void) | undefined, output: vscode.OutputChannel): void {
  try {
    afterSuccess?.();
  } catch (e) {
    output.appendLine(
      scrubSecrets(`re-scan callback threw: ${e instanceof Error ? e.message : String(e)}`),
    );
  }
}

/** Distinct URIs, compared the way the host compares paths. */
function dedupeUris(uris: readonly vscode.Uri[]): vscode.Uri[] {
  const seen = new Set<string>();
  const out: vscode.Uri[] = [];
  for (const uri of uris) {
    const key = process.platform === 'win32' ? uri.fsPath.toLowerCase() : uri.fsPath;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(uri);
  }
  return out;
}

export interface MutationResult {
  ok: boolean;
  /**
   * The items tf reported it touched, in tf's own terms — `Z:\...` under Wine.
   *
   * This is the ONLY authoritative account of what happened. The status cache
   * is what we believed before the command ran, and on Fedora a `status` takes
   * seconds, so a file checked out moments earlier is absent from it.
   */
  affected: string[];
}

/**
 * Runs a mutating tf command and reports failures without swallowing them.
 *
 * `afterSuccess`, when given, runs after `service.requestRefresh()` -- on a
 * clean success AND on the killed/outcome-unknown path, never on a plain
 * failure or a timeout. This is how Add, Undo and Get Latest trigger a
 * re-scan: their own mutation can make the unversioned-files scan's last
 * answer wrong (Undo of an Add leaves a false `!`; Add and Get can create or
 * remove an unversioned file), and `requestRefresh()` alone only re-runs
 * `status`, which says nothing about files that are not in source control at
 * all.
 */
export async function runMutation(
  client: TfClient,
  service: TfvcService,
  output: vscode.OutputChannel,
  args: string[],
  afterSuccess?: () => void,
): Promise<MutationResult> {
  // client.run resolves on a failed command, but it can still REJECT: spawn
  // throws synchronously for a bad cwd or a malformed environment, and that
  // throw happens inside the promise executor. Without this, the rejection
  // propagated out of an async registerCommand handler, where VS Code logs it
  // to a channel the user never opens — a mutating command that appears to do
  // nothing at all, with no error anywhere the user can see.
  let result;
  try {
    result = await client.run(args);
  } catch (err) {
    const detail = scrubSecrets(err instanceof Error ? err.message : String(err));
    output.appendLine(scrubSecrets(`tfp ${args.join(' ')}`));
    output.appendLine(detail);
    void vscode.window.showErrorMessage(S.commandFailed(detail));
    return FAILED;
  }

  const stdout = result.stdout.toString('utf8');
  const stderr = result.stderr.toString('utf8');

  // TfClient logs the command and its outcome; re-logging it here produced the
  // duplicate `tfp vc undo ...` pair visible in the channel.
  if (stdout.trim()) output.appendLine(scrubSecrets(stdout));

  if (result.timedOut) {
    void vscode.window.showErrorMessage(S.commandTimedOut(client.timeoutMs));
    return FAILED;
  }

  // tf names affected items relative to the directory it ran in, and sees
  // that directory in its own terms (`Z:\...` under Wine). No mapper means no
  // way to say what those terms are, and then relative names are dropped.
  const tfCwd = client.cwd === undefined ? undefined : service.pathMapper?.toWinePath(client.cwd);
  const affected = scanAffectedItems(stdout, tfCwd);

  // KILLED, not failed. Node reports a signalled child as `code === null`, and
  // the exit code that replaces it says nothing at all -- so neither can we.
  //
  // Treating it as a failure is not merely imprecise, it is actively wrong in
  // the direction that costs the user something: the message becomes tf's own
  // SUCCESS output inside a red error dialog (observed on FEDORA 2026-09-18 --
  // a checkout that had already made the file writable, reported as exit -1),
  // and for a mutation "it failed" invites a retry. For `checkin`, retrying an
  // operation that may already have committed is the one thing that must not
  // happen.
  if (result.terminatedBy) {
    output.appendLine(
      scrubSecrets(
        `killed by ${result.terminatedBy} after writing ${stdout.length} bytes; ` +
          'outcome unknown, refreshing to find out',
      ),
    );
    void vscode.window.showWarningMessage(S.outcomeUnknown(result.terminatedBy));
    // The refresh is what resolves it: `status` is the authority on what is
    // pending, and it is about to say so.
    service.requestRefresh();
    runAfterSuccess(afterSuccess, output);
    return FAILED;
  }

  const error = classifyError(result.exitCode, stdout, stderr);

  if (error && !isIgnoredItemsNotice(args, stderr)) {
    output.appendLine(scrubSecrets(error.originalMessage));
    void vscode.window.showErrorMessage(messageFor(error), { modal: false });
    return FAILED;
  }

  if (error) {
    // The whole failure text, not just the headline: tf lists one line per
    // exclusion group, and reporting only the first told the user about
    // `*.exe` while silently dropping `*.dll` and `bin`.
    output.appendLine(scrubSecrets(`add completed with exclusions (exit ${result.exitCode})`));
    output.appendLine(scrubSecrets(error.originalMessage));
    void vscode.window.showInformationMessage(scrubSecrets(ignoredNoticeLine(stderr)));
  }

  service.requestRefresh();
  runAfterSuccess(afterSuccess, output);
  return { ok: true, affected };
}

const FAILED: MutationResult = { ok: false, affected: [] };

/** tf's own wording when `add` skips files matching its default exclusions. */
const IGNORED_ITEMS = 'Items matching the following exclusions were ignored';

/**
 * Whether a non-zero exit is nothing worse than `add` skipping excluded files.
 *
 * This started life as a general rule — "non-zero but tf listed items it
 * touched, so call it partial success" — and that was far too broad. Driving
 * the real code proved it downgraded a REFUSED CHECK-IN to an information
 * message: `Access Denied: ... needs Check in permission(s)` carries no
 * TF##### code, so it classified as `unknown`, the caller saw success, and the
 * user's typed check-in comment was cleared for a check-in that never
 * happened. It did the same for `401 Unauthorized` and `Authentication
 * failed`, none of which carry a code either.
 *
 * `scanAffectedItems` could not be the guard: it treats ANY line ending in `:`
 * as a directory header, so `Unable to connect to https://host/:` yields a
 * phantom item — and its English two-word heuristic cannot match a Croatian
 * TF.exe at all, which is the locale of both machines here.
 *
 * So: one command, one message, and if tf is ever localized this stops
 * matching and the old fatal behaviour returns. That is the safe direction to
 * fail in — a red error on a successful add is an annoyance; a green light on
 * a failed check-in is not.
 */
function isIgnoredItemsNotice(args: string[], stderr: string): boolean {
  if (args[0] !== 'vc' || args[1] !== 'add') return false;
  return stderr.includes(IGNORED_ITEMS);
}

/** The exclusion notice itself, not whatever Wine printed to stderr first. */
function ignoredNoticeLine(stderr: string): string {
  const lines = stderr.split(/\r?\n/).map((l) => l.trim());
  return lines.find((l) => l.includes(IGNORED_ITEMS)) ?? lines.find((l) => l !== '') ?? '';
}

/**
 * Discards the editor buffer for files an Undo has just reverted on disk.
 *
 * `tf vc undo` rewrites the working file, but a DIRTY editor keeps the user's
 * typed characters in memory — so the confirmation said "your edits will be
 * discarded and cannot be recovered" and then visibly did not discard them.
 *
 * Leaving them is not merely confusing, it is the forbidden path: the file is
 * read-only again, so saving fails, and VS Code answers a failed save with an
 * **Overwrite** action that force-clears the read-only bit and writes anyway.
 * That is `chmod u+w` instead of checking out, offered by the editor itself,
 * and the resulting edit is invisible to TFVC.
 *
 * Clean documents need nothing: VS Code reloads them from disk on its own.
 */
async function revertOpenBuffers(
  uris: readonly vscode.Uri[],
  output: vscode.OutputChannel,
  autoCheckout?: { suppress(fsPath: string): void },
): Promise<void> {
  // Case-insensitive on Windows. The URI here comes from tf's `local`
  // attribute, and tf is demonstrably inconsistent: one real capture mixed
  // `C:\work` 79,920 times with `c:\work` 9 times. An exact compare found no
  // document, so the revert silently did nothing and the typed characters
  // stayed on screen — the same casing trap as the exclusion key.
  const samePath = (a: string, b: string) =>
    process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;

  for (const uri of uris) {
    const doc = vscode.workspace.textDocuments.find(
      (d) => samePath(d.uri.fsPath, uri.fsPath) && d.isDirty,
    );

    // Only revert a file tf actually made read-only again.
    //
    // The caller's list comes from parsing tf's text output, and that parser
    // treats any line ending in `:` as a directory header — so a failure
    // message can manufacture an item that was never touched. Reverting on a
    // phantom would discard edits for no reason at all.
    //
    // The filesystem settles it without trusting the parser: an undone Edit is
    // read-only again, and a file tf left alone is still writable. (An undone
    // Add is deleted, and THAT should still be reverted -- the dialog
    // promised the edits would go, and a missing file is tf having done
    // exactly what it said. So the skip needs both: still there, and
    // still writable.)
    if (doc && existsSync(doc.uri.fsPath) && !isReadOnly(doc.uri.fsPath)) {
      output.appendLine(
        `not reverting ${uri.fsPath}: still writable, so tf did not undo it`,
      );
      continue;
    }
    if (doc) {
      // Tell auto-checkout the next change to this file is OURS. A
      // programmatic revert raises onDidChangeTextDocument exactly like a
      // keystroke, so it checked the file straight back out and re-pended it
      // seconds after the user confirmed the undo.
      autoCheckout?.suppress(doc.uri.fsPath);
    }
    if (!doc) {
      const open = vscode.workspace.textDocuments.filter((d) => d.isDirty).length;
      output.appendLine(
        `no dirty editor to revert for ${uri.fsPath} (${open} dirty document(s) open)`,
      );
      continue;
    }
    try {
      await vscode.window.showTextDocument(doc, { preview: false });
      // Named, not implicit. Without the argument this acts on whatever
      // editor is active when it runs, and a folder undo now drives this
      // loop over many files in sequence — so a showTextDocument that
      // resolves before focus lands would revert the wrong editor and
      // discard unrelated unsaved work.
      await vscode.commands.executeCommand('workbench.action.files.revert', doc.uri);
      output.appendLine(`reverted the editor buffer for ${uri.fsPath}`);
    } catch (e) {
      output.appendLine(
        `could not revert the editor buffer for ${uri.fsPath}: ${(e as Error).message}`,
      );
    }
  }
}

export function registerCommands(
  context: vscode.ExtensionContext,
  client: TfClient,
  service: TfvcService,
  scm: ScmProvider,
  output: vscode.OutputChannel,
  autoCheckout?: { reset(fsPath: string): void; suppress(fsPath: string): void },
  serverContent?: { invalidate(serverItem?: string): void },
  /**
   * Re-scans for unversioned files: run when the user presses Refresh, and
   * passed to `runMutation` as `afterSuccess` for `add`, `undo` and
   * `getLatest`, whose own mutation can leave the scan's last answer wrong.
   * `checkout` does not receive it -- it changes nothing about what is
   * versioned. Optional so every existing call site, and every test, keeps
   * compiling.
   *
   * Deliberately not awaited anywhere it runs: a status refresh takes about a
   * second and a scan can take 17-20 s, so awaiting either would make the
   * command that triggered it feel broken.
   */
  /**
   * Re-runs the unversioned scan alongside a pending-changes refresh. The
   * boolean says whether a PERSON asked, which only the Refresh command
   * passes: see `UnversionedScan.run`.
   */
  alsoRefresh?: (userAsked?: boolean) => void,
): void {
  const serverPathOf = (uri: vscode.Uri): string | undefined =>
    service.pathMapper?.toServerPath(uri.fsPath);

  /**
   * Resolves every target the invocation refers to.
   *
   * The multi-select shapes matter: the SCM panel and the explorer both pass
   * (first, all[]) when several files are selected. An earlier version handled
   * only the single shapes and returned undefined for an array, so the caller
   * fell back to the ACTIVE EDITOR — meaning a multi-select Undo discarded
   * edits on a file the user had not selected. Falling back to the active
   * editor is correct only when the invocation carried no target at all, i.e.
   * the command palette.
   */
  const resolveAll = (args: readonly unknown[]): vscode.Uri[] => {
    const targets = unwrapTargets(args) as vscode.Uri[];
    if (targets.length > 0) return targets;
    const active = vscode.window.activeTextEditor?.document.uri;
    return active ? [active] : [];
  };

  const register = (id: string, handler: (uris: vscode.Uri[]) => Promise<void>) =>
    context.subscriptions.push(
      vscode.commands.registerCommand(id, async (...args: unknown[]) => {
        const resolved = resolveAll(args);
        if (resolved.length === 0) {
          void vscode.window.showWarningMessage(S.noTarget);
          return;
        }
        await handler(resolved);
      }),
    );

  /**
   * Maps targets to server paths, telling the user about any that are not
   * mapped rather than silently doing nothing — previously four of these
   * commands returned in silence, which is indistinguishable from a no-op.
   */
  /**
   * The pending FILES at or under the given server paths, as local URIs.
   *
   * Files only, deliberately: `tf` reports a pending folder Add as a change of
   * its own, but the panel shows files and so should the number in a warning
   * the user is meant to check against it.
   *
   * The local path comes back from `tf` in tf.exe's terms — `Z:\home\...`
   * under Wine — so it has to come back out through the mapper before it can
   * be compared with an open document's path.
   */
  /**
   * Whether `candidate` is at or under `item`, by TFVC's rules.
   *
   * Case-INSENSITIVE, like every other server-path comparison here
   * (`PathMapper.isUnderServer`, `ScmProvider.key`, `TfvcService`'s index) and
   * unlike the first version of this one. The two sides genuinely come from
   * different places: `item` is built by `toServerPath`, whose tail is sliced
   * out of the path ON DISK, while `serverItem` is tf's raw attribute, in the
   * SERVER's casing. A case-only difference in a directory name made Undo
   * refuse a legitimate folder as "nothing pending".
   */
  const covers = (item: string, candidate: string): boolean => {
    const a = item.toLowerCase().replace(/[\\/]+$/, '');
    const b = candidate.toLowerCase();
    return a === '$/' || b === a || b.startsWith(`${a}/`);
  };

  const pendingUnder = (items: string[]) =>
    // `?? []` because this can be reached before the first status resolves,
    // and a crash inside a command handler is invisible to the user.
    (service.pendingChanges ?? []).filter((change) =>
      items.some((item) => covers(item, change.serverItem)),
    );

  /** Any pending change at or under these paths, folders included. */
  const anythingPendingUnder = (items: string[]): boolean => pendingUnder(items).length > 0;

  /**
   * The pending FILES at or under the given server paths, as local URIs.
   *
   * Files only, deliberately: `tf` reports a pending folder Add as a change of
   * its own, but the panel shows files and so should the number in a warning
   * the user is meant to check against it. The RUN is gated separately, on any
   * change of either kind — a folder whose contents were all excluded pends
   * only the folder, and gating on this count made it un-undoable.
   */
  const pendingFilesUnder = (items: string[]): vscode.Uri[] => {
    const mapper = service.pathMapper;
    if (!mapper) return [];
    return pendingUnder(items)
      .filter((change) => change.itemType === 'File')
      .map((change) => vscode.Uri.file(mapper.fromWinePath(change.localPath)));
  };

  /** A folder by the filesystem, or by what tf says if the path is unreadable. */
  const isFolderTarget = (uri: vscode.Uri): boolean => {
    try {
      return statSync(uri.fsPath).isDirectory();
    } catch {
      // statSync throws for a deleted path, a denied ACL, an offline
      // placeholder or a broken junction. Answering "file" there silently
      // dropped /recursive and turned the warning back into "1 item" for a
      // whole tree — so fall back to what the server already told us.
      const item = serverPathOf(uri);
      return item !== undefined && pendingUnder([item]).some((c) => c.itemType === 'Folder');
    }
  };

  const serverPathsOf = (uris: vscode.Uri[]): string[] => {
    const items: string[] = [];
    const unmapped: vscode.Uri[] = [];
    for (const uri of uris) {
      const item = serverPathOf(uri);
      if (item) items.push(item); else unmapped.push(uri);
    }
    if (unmapped.length > 0) {
      void vscode.window.showWarningMessage(
        `${S.noWorkspaceMapping} (${unmapped.length} of ${uris.length})`,
      );
    }
    return items;
  };

  /**
   * File names for a message. win32.basename splits on both separators, so a
   * Linux path works too; only a Linux name containing a backslash would read
   * oddly, and only in a message.
   */
  const namesOf = (uris: readonly vscode.Uri[]): string[] => uris.map((uri) => win32.basename(uri.fsPath));

  /**
   * Only items with a pending change. VS Code passes the whole selection
   * whichever row was right-clicked, and an exclusion stored for a file with
   * nothing pending would send it straight to Excluded once it is added.
   */
  const pendingItemsOf = (uris: vscode.Uri[]): string[] =>
    serverPathsOf(uris).filter((item) => anythingPendingUnder([item]));

  register('teamExplorer.checkout', async (targets) => {
    // A file already checked out gets a plain sentence, not tf's
    // answer. Judged from the status cache; a checkout made seconds ago may be
    // missing from it, and then tf answers instead, harmlessly. A rename
    // without an edit is NOT checked out: its file is read-only until it is.
    //
    // The cache alone is not enough: a checkout undone OUTSIDE this extension
    // (another IDE, `tf` on the command line) leaves the file read-only again
    // without ever refreshing our copy of the pending set. In a server
    // workspace a read-only file is certainly not checked out regardless of
    // what the cache still believes, so that disk fact overrides a stale Edit.
    const already = targets.filter((uri) => {
      if (isFolderTarget(uri)) return false;
      const item = serverPathOf(uri);
      return (
        item !== undefined &&
        pendingUnder([item]).some((c) => c.changes.has('Edit')) &&
        !isReadOnly(uri.fsPath)
      );
    });
    if (already.length > 0) {
      void vscode.window.showInformationMessage(S.alreadyCheckedOut(namesOf(already)));
    }
    const uris = targets.filter((uri) => !already.includes(uri));
    if (uris.length === 0) return;

    const items = serverPathsOf(uris);
    if (items.length === 0) return;
    // An explicit checkout lifts the auto-checkout one-shot guard.
    // Without this the guard can stick for the session, because the save that
    // would otherwise clear it fails while the file is still read-only.
    for (const uri of uris) autoCheckout?.reset(uri.fsPath);
    // Checking out a folder is the harmless half of the pair Add's fix left
    // behind: it only makes files editable, and nothing is lost if it was not
    // what you meant. Without /recursive tf stops at the folder's own
    // children, so a subfolder would be quietly left read-only.
    const recursive = uris.some((uri) => isFolderTarget(uri));
    await runMutation(client, service, output, [
      'vc',
      'checkout',
      ...items,
      ...(recursive ? ['/recursive'] : []),
    ]);
  });

  register('teamExplorer.undo', async (targets) => {
    // A FILE with nothing pending gets a plain sentence instead of
    // the "cannot be recovered" dialog followed by tf's own error. This is
    // also what keeps an untracked row out of a selection that spans groups:
    // VS Code passes the whole selection, whichever row was right-clicked.
    // Judged from the status cache, which can lag a checkout made seconds ago
    // -- so the error is always a refusal the user can retry, never a discard.
    const idle = targets.filter((uri) => {
      if (isFolderTarget(uri)) return false;
      const item = serverPathOf(uri);
      return item !== undefined && !anythingPendingUnder([item]);
    });
    if (idle.length > 0) {
      output.appendLine(`undo: nothing pending on ${idle.length} file(s), skipped`);
      void vscode.window.showInformationMessage(S.nothingPendingOn(namesOf(idle)));
    }
    const uris = targets.filter((uri) => !idle.includes(uri));
    if (uris.length === 0) return;

    const items = serverPathsOf(uris);
    if (items.length === 0) return;

    const folders = uris.filter((uri) => isFolderTarget(uri));
    const recursive = folders.length > 0;

    // What the undo will destroy, which for a folder the selection cannot tell
    // you: one folder is one URI and the edits underneath may be fifty files.
    //
    // A UNION, not a choice. Deciding `recursive ? underTheFolders : uris`
    // meant that adding one folder to a multi-select silently dropped every
    // selected FILE from the count — and from the revert set, while still
    // passing it to tf.
    const files = uris.filter((uri) => !folders.includes(uri));
    const estimate = dedupeUris([...files, ...pendingFilesUnder(serverPathsOf(folders))]);
    const count = estimate.length;

    // Gate on ANY pending change, count only files. `tf vc add` on a folder
    // whose contents are all excluded pends the FOLDER and nothing else, and
    // gating on the file count meant those pending adds could not be undone
    // from this extension at all.
    if (recursive && !anythingPendingUnder(items)) {
      output.appendLine('undo: nothing pending under the selection — nothing was run');
      void vscode.window.showInformationMessage(S.undoNothingPending);
      return;
    }

    // Undo throws the user's edits away with no way back — `tf vc undo`
    // overwrites the working file with the server version and there is no
    // shelveset, no local history, nothing. Check In warns before an
    // irreversible act; this is the other irreversible act and it was one
    // click with no warning at all, right next to Exclude in the same menu.
    output.appendLine(`confirm: undo ${count} item(s) — showing modal`);
    const choice = await vscode.window.showWarningMessage(
      S.undoConfirmTitle,
      { modal: true, detail: S.undoConfirmDetail(count) },
      S.undoConfirmYes,
    );
    output.appendLine(`confirm: undo answered ${JSON.stringify(choice)}`);
    if (choice !== S.undoConfirmYes) {
      output.appendLine('confirm: undo declined — nothing was run');
      return;
    }

    // Undo makes the file read-only again, so a later edit must be allowed to
    // trigger a fresh checkout rather than hitting a stale guard entry.
    for (const uri of estimate) autoCheckout?.reset(uri.fsPath);
    const args = ['vc', 'undo', ...items, ...(recursive ? ['/recursive'] : [])];
    const result = await runMutation(client, service, output, args, alsoRefresh);
    if (!result.ok) return;

    // Revert off tf's OWN account of what it undid, not off the estimate.
    //
    // The two diverge in both directions and both are harmful. The cache is
    // what we believed before the command ran, and on Fedora a status takes
    // seconds — a file checked out moments ago is missing from it, so tf
    // undoes it, the dirty buffer is never reverted, the file is read-only
    // again, and the failed save offers Overwrite. In the other direction a
    // stale-inclusive cache would revert a buffer for a file tf never
    // touched, destroying edits for no reason.
    //
    // A partial undo makes this sharper still: tf can undo B while refusing A
    // and exit non-zero, and A's edits must survive.
    const undone = dedupeUris(
      result.affected
        .map((item) => service.pathMapper?.fromWinePath(item))
        .filter((p): p is string => p !== undefined)
        .map((p) => vscode.Uri.file(p)),
    );
    output.appendLine(`undo: tf reported ${undone.length} item(s) undone`);
    await revertOpenBuffers(undone, output, autoCheckout);
  });

  register('teamExplorer.getLatest', async (uris) => {
    const items = serverPathsOf(uris);
    if (items.length === 0) return;
    // Drop the cached server copies FIRST, and for the whole cache.
    //
    // A get is the user saying "bring me up to date", which only does anything
    // when somebody else has checked in - and that is exactly the event that
    // changes what `view /version:T` returns. Without this, a diff opened
    // afterwards compares the freshly updated local file against a server copy
    // cached up to 60 s ago, and shows differences that are not there.
    //
    // Everything, not just `items`: /recursive means a folder target updates
    // files that were never named here.
    serverContent?.invalidate();
    await runMutation(client, service, output, ['vc', 'get', ...items, '/recursive'], alsoRefresh);
    // Phase 5: the exit code cannot say whether a conflict was left (C1, C2).
    lookForConflictsAfterGet(items);
  });

  register('teamExplorer.add', async (uris) => {
    // LOCAL paths, not server paths. tf's own help: "Adds new files and
    // folders from a local file system location to Team Foundation version
    // control." The item being added does not exist on the server yet, so a
    // $/... itemspec has nothing to resolve against — this command could
    // never have added a file. Every other command here takes either form;
    // add is the exception.
    //
    // "Local" means local to TF.EXE, not to us. On Fedora tf runs under Wine
    // and sees the disk as Z:, so /home/shax/... is a path it cannot resolve.
    // toWinePath is the one translation, and it is a no-op on Windows.
    const mapper = service.pathMapper;
    if (!mapper) {
      void vscode.window.showWarningMessage(S.noWorkspaceMapping);
      return;
    }

    // The mapping is still checked, so a file outside the workspace is
    // reported rather than handed to tf to reject.
    const mapped = uris.filter((uri) => mapper.toServerPath(uri.fsPath) !== undefined);
    if (mapped.length < uris.length) {
      void vscode.window.showWarningMessage(
        `${S.noWorkspaceMapping} (${uris.length - mapped.length} of ${uris.length})`,
      );
    }
    if (mapped.length === 0) return;

    // Add on a file TFVC already has ends in a plain sentence, not
    // in tf's error -- but only when that is CERTAIN. Judged from the status
    // cache exactly like Undo and Check Out, deliberately NOT from the
    // unversioned-files scan: `reconcile /adds /preview` does not list a file
    // that is already pending Add, so once that Add is undone the file stays
    // unlisted until the NEXT scan (17-20 s later, or until Refresh) --
    // reading that silence as "in source control" told a user their freshly
    // un-added file was already versioned, which is false for as long as the
    // scan is stale. A pending change is never stale in that direction: the
    // cache is refreshed by the same status call every other command trusts.
    // Folders are never skipped: adding a partly versioned tree is how its
    // new files get in, and tf skips what it already has.
    const known = (uri: vscode.Uri): 'added' | 'versioned' | undefined => {
      if (isFolderTarget(uri)) return undefined;
      const item = serverPathOf(uri);
      if (item === undefined) return undefined;
      const pending = pendingUnder([item]);
      if (pending.length === 0) return undefined;
      return pending.some((c) => c.changes.has('Add')) ? 'added' : 'versioned';
    };
    const added = mapped.filter((uri) => known(uri) === 'added');
    const versioned = mapped.filter((uri) => known(uri) === 'versioned');
    if (added.length > 0) {
      void vscode.window.showInformationMessage(S.alreadyAdded(namesOf(added)));
    }
    if (versioned.length > 0) {
      void vscode.window.showInformationMessage(S.alreadyInSourceControl(namesOf(versioned)));
    }
    const toAdd = mapped.filter((uri) => !added.includes(uri) && !versioned.includes(uri));
    if (toAdd.length === 0) return;

    // Adding a folder is the normal Team Explorer gesture and was unreachable:
    // the explorer menu carried `!explorerResourceIsFolder`, which arrived with
    // a menu-wiring fix rather than from any decision in the spec. `tf vc add`
    // takes a folder happily, but without /recursive it stops at the folder's
    // own children, so a tree added this way silently loses its subfolders.
    const folders = toAdd.filter((uri) => isFolderTarget(uri));

    if (folders.length > 0) {
      // No count, deliberately. tf skips items already under version control
      // and obeys .tfignore (hence /noignore existing as an opt-out), so a
      // count taken off the disk would overstate — wildly, for a folder that
      // is mostly versioned already. A number that is wrong in the alarming
      // direction is worse than no number.
      //
      // The dialog itself is not paranoia: this collection already carries
      // 79,929 pending changes from one accidental bulk add, and unlike Team
      // Explorer there is no checkbox list here showing what is about to go in.
      //
      // tf does apply exclusions of its own -- measured on the live collection,
      // where *.exe and bin were both ignored with no .tfignore anywhere near
      // the folder -- so this is not as sharp an edge as it first looked. But
      // that list is tf's, not Visual Studio's, and nothing here enumerates it,
      // so the dialog reports what was observed and points at the panel rather
      // than claiming equivalence with the Visual Studio gesture.
      const names = folders.map((uri) => uri.fsPath);
      output.appendLine(`confirm: recursive add of ${folders.length} folder(s) — showing modal`);
      const choice = await vscode.window.showWarningMessage(
        S.addFolderConfirmTitle(folders.length),
        { modal: true, detail: S.addFolderConfirmDetail(names) },
        S.addFolderConfirmYes,
      );
      output.appendLine(`confirm: recursive add answered ${JSON.stringify(choice)}`);
      if (choice !== S.addFolderConfirmYes) {
        output.appendLine('confirm: recursive add declined — nothing was run');
        return;
      }
    }

    await runMutation(
      client,
      service,
      output,
      [
        'vc',
        'add',
        ...toAdd.map((uri) => mapper.toWinePath(uri.fsPath)),
        // Only when a folder is actually involved, so adding a file keeps the
        // exact command it has always sent.
        ...(folders.length > 0 ? ['/recursive'] : []),
      ],
      alsoRefresh,
    );
  });

  register('teamExplorer.exclude', async (uris) => {
    await scm.setExcludedMany(pendingItemsOf(uris), true);
  });

  register('teamExplorer.include', async (uris) => {
    await scm.setExcludedMany(pendingItemsOf(uris), false);
  });

  context.subscriptions.push(
    vscode.commands.registerCommand('teamExplorer.refresh', () => {
      // The one call site that passes `true`: this is the user asking.
      alsoRefresh?.(true);
      return service.refresh();
    }),
  );
}
