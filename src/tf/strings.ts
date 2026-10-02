/** Up to three names, then how many more: a 500-row selection must not become a 500-name message. */
function nameList(names: readonly string[]): string {
  if (names.length <= 3) return names.join(', ');
  return `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`;
}

/** Linked from setup failures. Public once the repo is. */
export const INSTALL_GUIDE_URL = 'https://github.com/shaxxx/vscode-team-explorer/blob/main/docs/install/README.md';

/** Every user-visible string. English, mirroring Team Explorer wording. */
export const S = {
  includedChanges: 'Included Changes',
  excludedChanges: 'Excluded Changes',
  notInSourceControl: 'Not in source control',
  notInSourceControlTooltip:
    'Not in source control. There is no pending change, and Check In will not include this file.',
  open: 'Open File',
  revealInExplorer: 'Reveal in Explorer',
  checkIn: 'Check In',
  // Must NOT promise a key chord. VS Code binds Ctrl+Enter in the SCM input to
  // the SourceControl's acceptInputCommand, and hard rule 1 forbids reaching
  // check-in by keybinding - so acceptInputCommand is deliberately never set,
  // Ctrl+Enter does nothing here, and the old text promised otherwise.
  checkInPlaceholder: 'Check-in comment (use the Check In button above)',
  checkInConfirmTitle: 'Check in these changes?',
  checkInConfirmDetail: (count: number) =>
    `${count} item${count === 1 ? '' : 's'} will be checked in to the server. This cannot be undone.`,
  checkInConfirmYes: 'Check In',
  commentFileFailed: (detail: string) =>
    [
      'The check-in comment could not be written, so nothing was checked in.',
      detail,
    ].join('\n\n'),
  refresh: 'Refresh',
  checkOut: 'Check Out for Edit',
  undo: 'Undo Pending Changes',
  getLatest: 'Get Latest Version',
  add: 'Add to Source Control',
  compareWithLatest: 'Compare with Latest Version',
  setPat: 'Set Personal Access Token',
  patPrompt: 'Azure DevOps Personal Access Token',
  patSaved: 'Personal access token saved.',
  patNotAToken:
    'That does not look like a personal access token: it contains a space or a ' +
    'line break. The wrapper reads only the first line of the file, so a value ' +
    'like this can never authenticate. Nothing was changed.',
  patFileDiffers: (path: string) =>
    `${path} already contains a different token. Overwrite it with the one saved in VS Code?`,
  patFileDiffersYes: 'Overwrite',
  rewritePatFile: 'Rewrite pat.txt from saved token',
  patFileRewritten: (path: string) => `Rewrote ${path} from the saved token.`,
  patMissing: 'No personal access token found. Run "Team Explorer: Set Personal Access Token".',
  patExpired: 'The personal access token was rejected. Run "Team Explorer: Set Personal Access Token".',
  tfNotFound: 'TF.exe was not found. Set TF_EXE for the tfp wrapper, or see the install guide.',
  wineMissing: 'The Wine prefix was not found. See the Linux install guide.',
  wrapperMissing:
    'The tfp wrapper was not found. Install it as the install guide describes, or set "teamExplorer.wrapperPath".',
  noCollectionUrl:
    'Team Explorer (TFVC) needs your collection URL. Set "teamExplorer.collectionUrl" (for example https://dev.azure.com/your-org/), then reload the window.',
  openSettings: 'Open Settings',
  installGuide: 'Install Guide',
  commandNotFound:
    'The tfp wrapper ran, but a program it needs was not found (exit code 127). On Linux this is usually Wine.',
  flatpakNoHost:
    'This VS Code is a Flatpak, and Wine is not available inside it. Set "teamExplorer.wrapperPath" to the tfp-flatpak shim (see the Linux install guide).',
  noWorkspaceMapping: 'This folder is not mapped in a TFVC workspace.',
  noTarget: 'No file selected. Open a file or right-click one in the Source Control panel.',
  encodingHazard: (file: string, count: number) =>
    [
      `${file} was not decoded correctly — ${count} character${count === 1 ? '' : 's'} ` +
        'are already lost in the editor, and saving would destroy them in the file.',
      'Most files in this collection are windows-1250, but VS Code read this one as UTF-8. ' +
        'Close it without saving, set "files.encoding" to "windows1250", and reopen it.',
      'TFVC did not check the file out, so the file on disk is still intact.',
    ].join('\n\n'),
  compareNoServerVersion: (file: string) =>
    `${file} is a pending Add. It does not exist on the server yet, so there is nothing to compare with.`,
  compareBinary: (file: string) =>
    `${file} is a binary file. TFVC does not text-diff binaries.`,
  versionUnavailable: 'This version cannot be shown yet: the extension has not finished starting.',
  viewStopped: (signal: string) => `tf was stopped (${signal}) before the file was read.`,
  undoConfirmTitle: 'Undo pending changes?',
  undoConfirmDetail: (count: number) =>
    `${count} item${count === 1 ? '' : 's'} will be reverted to the server version. ` +
    'Your edits to them will be discarded and cannot be recovered.',
  undoConfirmYes: 'Undo Changes',
  undoNothingPending: 'Nothing under that folder has pending changes.',
  nothingPendingOn: (names: readonly string[]) => `Nothing is pending on ${nameList(names)}.`,
  alreadyCheckedOut: (names: readonly string[]) =>
    `${nameList(names)} ${names.length === 1 ? 'is' : 'are'} already checked out.`,
  alreadyAdded: (names: readonly string[]) =>
    `${nameList(names)} ${names.length === 1 ? 'is' : 'are'} already added, not checked in yet.`,
  alreadyInSourceControl: (names: readonly string[]) =>
    `${nameList(names)} ${names.length === 1 ? 'is' : 'are'} already in source control.`,
  addFolderConfirmTitle: (count: number) =>
    count === 1 ? 'Add this folder and everything in it?' : `Add ${count} folders and everything in them?`,
  addFolderConfirmDetail: (names: string[]) =>
    `${names.join('\n')}\n\n` +
    'Every file underneath, including subfolders, will be pended as an Add. ' +
    'Files already under source control are skipped, and so are build output and ' +
    'temporary files: tf ignores *.exe, *.dll, *.pdb, bin, obj, Debug, Release and ' +
    '15 other patterns, the same way a folder add behaves in Visual Studio.\n\n' +
    'It does NOT ignore node_modules or packages. Check the panel before you check in.\n\n' +
    'To add a file the exclusions skip, right-click the file itself instead of the folder.',
  addFolderConfirmYes: 'Add Recursively',
  commandFailed: (detail: string) =>
    ['The tf command could not be started.', detail].join('\n\n'),
  exclusionsUnreadable:
    'The saved list of excluded files could not be read and has been treated as empty. ' +
    'Anything you had excluded is now shown as included - check the panel before checking in.',
  autoCheckoutFailed: (file: string) => `Could not check out ${file}.`,
  saveParticipantOverran: (file: string, ms: number) =>
    [
      `Checking out ${file} is taking longer than the ${ms}ms VS Code allows before it saves anyway.`,
      'If the save fails with a read-only error, do NOT choose Overwrite. ' +
        'Overwrite clears the read-only bit and writes the file behind TFVC’s back, ' +
        'so the change becomes invisible to source control.',
      'The checkout is still running. Wait a moment and save again, or run ' +
        '"Team Explorer: Check Out for Edit" first. Switching teamExplorer.autoCheckout to "onEdit" avoids this entirely.',
    ].join('\n\n'),
  outcomeUnknown: (signal: string) =>
    `The command was stopped (${signal}) before it could report its result. ` +
    'It may or may not have completed - the panel is refreshing to show what actually happened.',
  commandTimedOut: (ms: number) => `The tf command timed out after ${ms}ms.`,
  historyUnreadable:
    "Couldn't read tf's history output. Its first lines are in the Team Explorer output channel.",
  changesetNotFound: (id: number) => `Changeset ${id} was not found.`,
  historyStopped: (signal: string) => `tf was stopped (${signal}) before the history was complete.`,
  glyphVersioned: 'Under source control',
  glyphCheckedOut: 'Checked out for edit',
  glyphPendingAdd: 'Added, not checked in yet',
  glyphPendingDelete: 'Pending delete',
  glyphPendingRename: 'Pending rename',
  glyphHazard: 'Edited without being checked out — TFVC cannot see this change',
  /** Appended by `excluded()` in decorations.ts to any glyph's tooltip. */
  excludedTooltipSuffix: ' (excluded from check-in)',
  annotatePending: '…',
  annotateLocal: 'local',
  annotateAtOrBefore: (id: number) => `≤ C${id}`,
  annotateHoverHeading: (id: number, user: string, date: string) => `Changeset ${id} · ${user} · ${date}`,
  annotateHoverDetails: 'Changeset details',
  annotateHoverCompare: 'Compare with previous',
  annotateTooDifferent: (id: number) => `changeset ${id} changed too much of the file to compare quickly`,
  annotateReloaded: (name: string) =>
    `${name} changed on disk (a Get, an Undo or another program). Annotate it again to see who changed what.`,
  historyTitle: (name: string) => `History - ${name}`,
  historyLabels: {
    changeset: 'Changeset',
    user: 'User',
    date: 'Date',
    comment: 'Comment',
    change: 'Change',
    path: 'Path',
    loadMore: 'Load more',
    loading: 'Loading…',
    empty: 'No history.',
    details: 'Changeset details',
    selectPrompt: 'Select a changeset to see its files.',
    compare: 'Compare with Previous Version',
    view: 'View This Version',
    getVersion: 'Get This Version',
  },
  historyShowingOf: (shown: number, total: number) => `Showing ${shown} of ${total} items.`,
  historyStale: 'That changeset is not in this list any more. Reopen the History tab.',
  noPreviousVersion: (id: number) =>
    `Changeset ${id} is where this file began (added, branched or undeleted), so there is no previous version.`,
  previousNotLoaded: (id: number) =>
    `The version before changeset ${id} is not loaded yet. Load more, then try again.`,
  versionDeleted: (id: number) => `The file was deleted in changeset ${id}, so that version has no content.`,
  compareRenamedItem: (name: string) =>
    `${name} was renamed in this changeset, so its previous version is under another name. ` +
    "Open the file's own History, which follows renames.",
  folderRowAction: "A folder's history shows changeset details only. Open a file's History to compare, view or get a version.",
  getVersionRenamed:
    'This version of the file had a different name. Get This Version works only on versions under the current name.',
  historyPendingAdd: (name: string) => `${name} is a pending Add. It has no history on the server yet.`,
  historyPendingRename: (name: string) =>
    `${name} is a pending rename. Its new name has no history until the rename is checked in or undone.`,
  getVersionPending: (name: string) =>
    `${name} has pending changes. Undo them, or check them in, before getting another version.`,
  getVersionWritable: (name: string) =>
    `${name} is writable but not checked out, so getting another version would overwrite edits TFVC cannot see. ` +
    'Get This Version works on a file with no edits.',
  getVersionChecking: (name: string) => `Checking pending changes before getting ${name}`,
  getVersionOutsideFolder: (name: string) =>
    `${name} is outside the opened folder, so its pending changes are not known here. Open its own folder to get another version.`,
  getVersionStatusUnknown: (name: string) =>
    `Couldn't read your pending changes, so ${name} was left as it is. Try again once Team Explorer can read the status.`,
  getVersionMissing: (name: string) =>
    `${name} is not on disk. If it was renamed or moved since this History tab opened, open History from its new name.`,
  getVersionConfirmTitle: (name: string, id: number) => `Replace your copy of ${name} with changeset ${id}?`,
  getVersionConfirmDetail:
    'Your workspace will hold this older version until you Get Latest. Nothing is checked in.',
  getVersionConfirmYes: 'Get This Version',
  compareVersionsTitle: (name: string, older: number, newer: number) => `${name} (C${older}) ↔ (C${newer})`,
  annotating: (name: string) => `Annotating ${name}`,
  annotateFolder: 'Annotate works on a file, not a folder.',
  annotatePendingAdd: (name: string) => `${name} is a pending Add. It has no history to annotate.`,
  annotatePendingDelete: (name: string) => `${name} is pending delete. Undo the delete to annotate it.`,
  annotatePendingRename: (name: string) =>
    `${name} is a pending rename. Annotate works once the rename is checked in or undone.`,
  annotateBinary: (name: string) => `${name} is a binary file. There are no lines to annotate.`,
  annotateCannotOpen: (name: string, detail: string) => `Annotate cannot open ${name}: ${detail}`,
  annotateNoHistory: (name: string) => `${name} has no history to annotate.`,
  annotateStopped: (name: string, reason: string) =>
    `Annotate stopped early for ${name}: ${reason}\n\nLines older than the last version reached show ≤ C<n>.`,

  // Phase 3 part 1: workspace and mappings
  wsUnreadable: (detail: string) => `Could not read the workspace list.\n\n${detail}`,
  wsCreateStrayMapping: (name: string, dir: string, detail: string) =>
    `Workspace ${name} was created, but tf's automatic mapping of $/ to ${dir} could not be removed. ` +
    `Remove it with Manage Workspace before adding mappings.\n\n${detail}`,
  manageWorkspace: 'Manage Workspace',
  wsPickWorkspace: 'Choose a workspace on this computer',
  wsTitle: (name: string, owner: string | undefined, computer: string) =>
    `Workspace ${name}${owner ? ` (${owner})` : ''} on ${computer}`,
  wsNone: 'This computer has no workspace in the collection yet.',
  wsCreateItem: '$(add) Create Workspace…',
  wsAddMappingItem: '$(add) Add Mapping…',
  wsGetItem: '$(cloud-download) Get…',
  wsRemoveItem: '$(trash) Remove Mapping',
  wsNamePrompt: 'Name of the new workspace',
  wsNameEmpty: 'Enter a name.',
  wsNameInvalid: 'A workspace name cannot contain ; / \\ : * ? " < > |',
  wsCreateConfirm: (name: string) => `Create server workspace ${name}?`,
  wsCreateDetail: (collection: string) =>
    `In ${collection}. Nothing is downloaded until you add a mapping and choose what to get.`,
  wsCreateYes: 'Create Workspace',
  wsBrowseTitle: (path: string) => `Server folder to map: ${path}`,
  wsUseThisFolder: (path: string) => `$(check) Map ${path}`,
  wsUpOneLevel: '$(arrow-up) ..',
  wsPickLocal: (server: string) => `Local folder for ${server}`,
  wsMapConfirm: (ws: string, server: string, local: string) => `Map ${server} to ${local} in workspace ${ws}?`,
  wsMapShared: 'Visual Studio uses this workspace too; it will see this mapping.',
  wsMapNew: 'Nothing is downloaded until you choose what to get.',
  wsMapYes: 'Map',
  wsMoveConfirm: (server: string, from: string, to: string) => `${server} is mapped to ${from}. Move it to ${to}?`,
  wsMoveYes: 'Move Mapping',
  wsMapRedundant: (server: string, parentServer: string, parentLocal: string) =>
    `${server} is already mapped there, through ${parentServer} → ${parentLocal}. Nothing was changed.`,
  wsMapAlreadyThere: (server: string, local: string) => `${server} is already mapped to ${local}. Nothing was changed.`,
  wsMapLocalInUse: (local: string, server: string, ws: string) =>
    `${local} is already the local folder of ${server} in workspace ${ws}. Choose another folder.`,
  wsMapInsideOther: (local: string, parentLocal: string, server: string, ws: string) =>
    `${local} is inside ${parentLocal}, which workspace ${ws} maps to ${server}. ` +
    'A second server folder there would give one folder two meanings. Choose a folder outside it.',
  wsMapContainsOther: (local: string, otherLocal: string, server: string, ws: string) =>
    `${local} contains ${otherLocal}, which workspace ${ws} maps to ${server}. Choose a folder that does not contain it.`,
  wsMapNotAsAsked: (server: string, local: string) =>
    `tf reported success, but the workspace does not show ${server} → ${local}. Check the mappings with Manage Workspace.`,
  wsMapped: (server: string, local: string) => `Mapped ${server} to ${local}.`,
  wsUnmapConfirm: (ws: string, server: string, local: string) => `Remove ${server} → ${local} from workspace ${ws}?`,
  wsUnmapDetail: 'The files stay on disk; TFVC stops tracking them in this workspace. Visual Studio sees the change too.',
  wsUnmapYes: 'Remove Mapping',
  wsUnmapped: (server: string) => `Removed the mapping of ${server}. Its files are still on disk.`,
  wsGetWhich: (server: string) => `What to get from ${server} now? Nothing is ticked; Escape gets nothing.`,
  wsGetEverything: (server: string) => `Everything under ${server}`,
  wsGetNowConfirm: (server: string) => `Get ${server} now?`,
  wsGetNowYes: 'Get',
  wsGetting: (server: string) => `Getting ${server}`,
  wsGettingCount: (n: number) => `${n.toLocaleString('en-US')} item(s)…`,
  wsGetCancelled: (server: string, n: number) =>
    `Get of ${server} cancelled after ${n} item(s). Run Get again to finish; tf skips what is already there.`,
  wsGetDone: (server: string, n: number) => `Got ${server}: ${n} item(s).`,
  wsCreateUnknown: (name: string, dir: string, unmapped: boolean, detail: string) =>
    `tf's result for creating workspace ${name} in ${dir} is unknown -- it may or may not have been created. ` +
    (unmapped
      ? `Its automatic $/ mapping was removed, in case the workspace exists.`
      : `Its automatic $/ mapping could NOT be removed either.`) +
    ` Check with Manage Workspace before trying again.\n\n${detail}`,
  wsTempUnsafe: (dir: string) =>
    `Cannot create a workspace in ${dir}: its path cannot be passed safely through the tf wrapper. ` +
    'Nothing was run. Choose a different temp location, or use Visual Studio for this workspace.',
  wsGetPartial: (items: number, detail: string) => `tf stopped with problems after ${items} item(s):\n\n${detail}`,

  // Task 6 review fixes: honest move/override confirms, re-check before tf, exact
  // after-check, Get targets via mappings. Appended after the block above; none of
  // the existing Phase 3 part 1 strings above this line were changed.
  wsNameLeadingDash: 'A workspace name cannot start with -; tf would read it as an option.',
  wsNameBadChars: 'A workspace name cannot contain ! % ^',
  wsNameTooLong: 'A workspace name cannot be longer than 64 characters.',
  wsNameDuplicate: (name: string) => `This computer already has a workspace named ${name}.`,
  wsMoveDetail: (ws: string, server: string, from: string, to: string) =>
    `In workspace ${ws}, the next Get of ${server} moves its files out of ${from} into ${to}; ` +
    'Visual Studio, which shares this workspace, will find them only at the new place.',
  wsUnmapMovesBack: (parentServer: string, to: string) =>
    `The files stay on disk. ${parentServer} already covers this path, so the next Get of ${parentServer} ` +
    `moves them back under it, to ${to}. Visual Studio sees the change too.`,
  wsUnmappedMovesBack: (server: string, parentServer: string, to: string) =>
    `Removed the mapping of ${server}. Its files are still on disk; ${parentServer} already covers this path, ` +
    `so the next Get of ${parentServer} moves them back to ${to}.`,
  wsUnmapNotAsAsked: (server: string) =>
    `tf reported success, but ${server} is still mapped. Check the mappings with Manage Workspace.`,
  wsMapChangedBeforeApply: (server: string, ws: string) =>
    `${server} in workspace ${ws} changed just now, before this could run. Nothing was sent to tf; ` +
    'open Manage Workspace again to see the current mappings.',
  wsUnmapChangedBeforeApply: (server: string, ws: string) =>
    `${server} in workspace ${ws} is no longer mapped the way it was a moment ago. Nothing was sent to tf; ` +
    'open Manage Workspace again to see the current mappings.',
  wsMapUnverified: (server: string, local: string, detail: string) =>
    `${server} may or may not be mapped to ${local} now: tf did not report a failure, but the workspace list ` +
    `could not be re-read to check.\n\n${detail}`,
  wsUnmapUnverified: (server: string, detail: string) =>
    `${server} may or may not still be mapped: tf did not report a failure, but the workspace list could not ` +
    `be re-read to check.\n\n${detail}`,
  wsMapSideEffects: (lines: string[]) =>
    `tf also changed ${lines.length === 1 ? 'a mapping' : 'mappings'} nobody asked to change:\n\n${lines.join('\n')}`,
  wsGetNowConfirmMoved: (server: string, from: string, to: string) => `Get ${server} now? This moves its files from ${from} to ${to}.`,
  wsGetMovedNotice: (server: string, from: string, to: string) =>
    `${server} moved from ${from} to ${to}. Getting a ticked folder below moves its files there; ` +
    'Visual Studio will find them only at the new place.',
  wsGetElsewhere: (server: string, at: string) =>
    `${server} is mapped to ${at}, not under the folder just Got - skipped. Use its own mapping's Get.`,
  wsGetUnmapped: (server: string) => `${server} is not mapped anywhere right now - skipped.`,
  wsGetNotAttempted: (servers: string) => `Not attempted: ${servers}.`,

  // Phase 3 part 2: Source Control Explorer.
  sceTitle: 'Source Control Explorer',
  /** Posted to the page with every state, like historyLabels: strings only, so it survives postMessage. */
  sceLabels: {
    refresh: 'Refresh',
    getLatest: 'Get Latest Version',
    getSpecific: 'Get Specific Version…',
    history: 'View History',
    checkout: 'Check Out for Edit',
    undo: 'Undo Pending Changes…',
    compare: 'Compare with Latest',
    view: 'View',
    annotate: 'Annotate',
    addItems: 'Add Items to Folder…',
    rename: 'Rename…',
    delete: 'Delete',
    map: 'Map to Local Folder…',
    copyPath: 'Copy Server Path',
    name: 'Name',
    pending: 'Pending Change',
    user: 'User',
    latest: 'Latest',
    lastCheckIn: 'Last Check-in',
    yes: 'Yes',
    no: 'No',
    notDownloaded: 'Not downloaded',
    notMapped: 'Not mapped',
    unavailable: 'unavailable',
    loading: 'Loading…',
    empty: 'This folder is empty.',
    retry: 'Retry',
    gsvTitle: 'Get Specific Version',
    gsvType: 'Type',
    gsvValue: 'Version',
    gsvChangeset: 'Changeset',
    gsvDate: 'Date',
    gsvLabel: 'Label',
    gsvLatest: 'Latest Version',
    gsvWorkspace: 'Workspace Version',
    gsvPick: '…',
    gsvDateHint: 'As of 00:00 on that day.',
    gsvOverwriteWritable: 'Overwrite writable files that are not checked out',
    gsvGetAll: 'Overwrite all files even if the local version matches the specified version',
    gsvGet: 'Get',
    cancel: 'Cancel',
  },
  sceFooter: (items: number, loadedAt: string | undefined) =>
    loadedAt === undefined ? `${items} item(s)` : `${items} item(s) · status loaded at ${loadedAt}`,
  sceWhat: (names: readonly string[]) => nameList(names),
  /**
   * Shown once per session when the scan refuses tf's own list of new files.
   * `reconcile` reports EVERY local file as new in a workspace whose mapped
   * folder has never been downloaded (probes R28-R31), and saying so would
   * put the whole tree in "Not in source control".
   */
  scanListingUntrusted: (folder: string) =>
    `Team Explorer is ignoring tf's list of new files in ${folder}: tf is reporting files as new that it also has at a real changeset. Run Get Latest Version on the folder to fix it.`,
  sceNeedsSelection: 'Select an item first.',
  sceNeedsOne: 'Select exactly one item for this.',
  sceNotAFile: (name: string) => `${name} is a folder; this works on files.`,
  sceNotAFolder: (name: string) => `${name} is a file; this works on folders.`,
  sceNotMappedAction: (name: string) => `${name} is not mapped in this workspace. Use Map to Local Folder… first.`,
  sceAlreadyMapped: (name: string, local: string) =>
    `${name} is already mapped, to ${local}. To change that, use Manage Workspace.`,
  sceNotDownloaded: (name: string) => `${name} has not been downloaded yet. Get it first.`,
  sceNotLoaded: (name: string) => `The status of ${name} is not loaded yet. Wait a moment, or press Refresh.`,
  scePendingAdd: (name: string) => `${name} is a pending Add. It does not exist on the server yet.`,
  sceUnknownPath: 'That item is no longer listed. Press Refresh and try again.',
  sceCheckoutFolderConfirm: (names: readonly string[]) =>
    `Check out everything in ${nameList(names)}, including its subfolders?`,
  sceCheckoutFolderDetail: 'Every file under it becomes editable and is listed as a pending edit.',
  sceCheckoutFolderYes: 'Check Out',
  sceGetting: (what: string) => `Getting ${what}`,
  sceGettingCount: (n: number) => `${n} item(s)`,
  sceGetDone: (what: string, items: number, deleted: number) =>
    deleted === 0
      ? `Got ${what}: ${items} item(s).`
      : `Got ${what}: ${items} item(s); ${deleted} removed, because they did not exist at that version.`,
  sceGetCancelled: (what: string, items: number) =>
    `Get of ${what} cancelled after ${items} item(s). Run it again to finish; tf skips what is already there.`,
  sceGetFailed: (what: string, items: number, detail: string) =>
    `Get of ${what} stopped after ${items} item(s).\n\n${detail}`,
  sceOverwriteConfirm: (count: number) => `Overwrite local files for ${count} selected item(s)?`,
  sceOverwriteWritableDetail:
    'Writable files that are not checked out will be replaced by the server version; edits in them that TFVC does not know about are lost.',
  sceOverwriteAllDetail: 'Every file is downloaded again, even where your copy already matches that version.',
  sceOverwriteYes: 'Overwrite',
  gsvBadChangeset: 'Enter a changeset number, for example 16730.',
  gsvBadDate: 'Enter a date as YYYY-MM-DD, for example 2026-09-01.',
  gsvBadLabel: 'Enter a label name, up to 64 characters. It cannot start with - or contain " / \\ : < > | * ? ; @ ! % ^',
  scePickChangeset: (name: string) => `Changesets of ${name}`,
  sceNoChangesets: (name: string) => `No changesets found for ${name}.`,
  sceNoUnversioned: (folder: string) =>
    `No files in ${folder} that are not in source control were found. Only the folder open in VS Code is scanned for them.`,
  scePickUnversioned: (folder: string) => `Add to source control, from ${folder}`,
  sceCopied: (n: number) => (n === 1 ? 'Server path copied.' : `${n} server paths copied.`),
  wsNoWorkspaceForMap: 'This computer has no workspace yet. Use Manage Workspace to create one first.',

  // Phase 3 part 3: rename, move and delete.
  fileOpsRenameTitle: 'Rename',
  fileOpsRenamePrompt: (name: string) => `New name for ${name}`,
  fileOpsBadNameEmpty: 'Enter a name.',
  fileOpsBadNameChars: 'A name cannot contain $ / \\ : * ? " < > | or a tab.',
  fileOpsBadNameEdge: 'A name cannot start with a space, or end with a space or a dot.',
  fileOpsBadNameLong: 'A name can be at most 255 characters.',
  fileOpsBadNameTaken: (name: string) => `${name} already exists in this folder.`,
  /** The user's own rename always stands; only TFVC's record of it can fail. */
  fileOpsRenameFailed: (name: string, detail: string) =>
    `${name} was renamed, but TFVC did not record the rename.\n\n${detail}`,
  fileOpsRepairBlocked: (name: string) =>
    `${name} was renamed, but TFVC did not record the rename: the old name is in use again.`,
  fileOpsRepairMissing: (name: string) =>
    `TFVC did not record the rename of ${name}: it is no longer where VS Code left it.`,
  /**
   * tf refused the rename, and restoring the item to `newName` (so the
   * user's own rename still stands) turned out to be unsafe too: something
   * else -- a save from the still-open editor is the likely case, and often
   * the very reason tf just failed -- is now using that name. The item is
   * left under its OLD name rather than risk overwriting that.
   */
  fileOpsRestoreBlocked: (oldName: string, newName: string) =>
    `${oldName} stays under its old name: TFVC could not record the rename to ${newName}, because something else is already using the name ${newName}.`,
  fileOpsDeleteFailed: (names: readonly string[], detail: string) =>
    `TFVC did not record the deletion of ${nameList(names)}.\n\n${detail}`,
  fileOpsDeleteConfirmFile: (names: readonly string[]) => `Delete ${nameList(names)}?`,
  fileOpsDeleteConfirmFolder: (names: readonly string[]) =>
    `Delete ${nameList(names)} and everything in it?`,
  fileOpsDeleteDetail:
    'It becomes a pending delete. Nothing leaves the server until you check in, and Undo Pending Changes… restores it.',
  fileOpsDeleteYes: 'Delete',

  // Phase 4: shelvesets.
  shelveTitle: 'Shelve',
  shelveNothingIncluded: 'There are no included changes to shelve.',
  shelveSaveFirst: (names: readonly string[]) => `Save ${nameList(names)} before shelving?`,
  shelveSaveFirstDetail: 'tf shelves each file as it is on disk, so unsaved edits would be left out.',
  shelveSaveYes: 'Save and Shelve',
  shelveSaveFailed: (name: string) => `${name} could not be saved, so nothing was shelved.`,
  shelveNamePrompt: (count: number) =>
    `Shelveset name. ${count} included change${count === 1 ? '' : 's'} will be shelved.`,
  shelveBadNameEmpty: 'Enter a name.',
  shelveBadNameChars: 'A shelveset name cannot contain " / : < > \\ | * ? ; % ^ ! or a control character.',
  shelveBadNameDash: 'A shelveset name cannot start with -.',
  shelveBadNameLong: 'A shelveset name can be at most 64 characters.',
  shelveKeep: 'Shelve and keep my pending changes',
  shelveKeepDetail: 'Nothing changes on disk.',
  shelveUndo: 'Shelve and undo my pending changes',
  shelveUndoDetail:
    'The files return to their workspace version and new files are removed from disk. All of it stays in the shelveset.',
  shelveReplaceConfirm: (name: string) => `You already have a shelveset named "${name}". Replace it?`,
  shelveReplaceDetail: 'What it holds now is lost.',
  shelveReplaceYes: 'Replace',
  shelveLookupFailed: (detail: string) =>
    `Could not check whether that shelveset name is taken, so nothing was shelved.\n\n${detail}`,
  shelveCommentFailed: (detail: string) =>
    `The comment could not be written, so nothing was shelved.\n\n${detail}`,
  shelveNoItems: 'Nothing to shelve was named, so nothing was run.',
  shelveDone: (name: string, count: number) =>
    `Shelved ${count} change${count === 1 ? '' : 's'} as "${name}".`,
  shelveDoneUndone: (name: string, count: number) =>
    `Shelved ${count} change${count === 1 ? '' : 's'} as "${name}", and undid them here.`,
  shelveFailed: (name: string, detail: string) =>
    `Shelving "${name}" did not finish cleanly. Before shelving again, check the Shelvesets tab and your pending changes: tf may have shelved or undone part of it.\n\n${detail}`,
  shelvesetsTitle: 'Shelvesets',
  shelvesetsLabels: {
    owner: 'Owner',
    find: 'Find',
    filter: 'Filter',
    refresh: 'Refresh',
    name: 'Name',
    date: 'Date',
    comment: 'Comment',
    loading: 'Loading…',
    none: 'No shelvesets found.',
    noMatch: 'No shelveset matches the filter.',
    pickOne: 'Select a shelveset to see its changes.',
    retry: 'Retry',
    folder: 'Folder',
    change: 'Change',
    compareUnmodified: 'Compare with Unmodified',
    compareWorkspace: 'Compare with Workspace Version',
    viewShelved: 'View Shelved Version',
    unshelve: 'Unshelve',
    preserve: 'Preserve shelveset on server',
    delete: 'Delete Shelveset…',
    working: 'Working…',
  },
  shelvesetsBadOwner: 'An owner cannot contain " ; % ^ ! or a control character.',
  shelvesetsStale: 'That shelveset or change is not listed any more. Press Refresh.',
  shelvesetUnpassable: (name: string) =>
    `"${name}" cannot be opened here: its name or owner cannot be passed to tf safely (a leading - or /, or one of " ; % ^ !). Visual Studio can open it.`,
  shelvedCompareTitle: (name: string, left: string, right: string) => `${name} (${left}) ↔ ${name} (${right})`,
  shelvedLeftVersion: (changeset: number) => `C${changeset}`,
  shelvedLeftNone: 'new',
  shelvedLeftWorkspace: 'workspace',
  shelvedRight: (shelveset: string) => `shelveset "${shelveset}"`,
  shelvedRightDeleted: (shelveset: string) => `deleted in "${shelveset}"`,
  shelvedNoBase: (name: string) => `${name} has no unmodified version to compare with.`,
  shelvedIsDelete: (name: string) => `${name} is deleted in this shelveset, so nothing of it was shelved.`,
  shelvedIsFolder: (name: string) => `${name} is a folder, so there is nothing to compare or view.`,
  shelvedNotMapped: (name: string) => `${name} is not mapped in this workspace, so there is no workspace version.`,
  shelvedNotOnDisk: (name: string) => `${name} is not on disk in this workspace.`,
  unshelveNothingTicked: 'Tick at least one change to unshelve.',
  unshelveUnmapped: (names: readonly string[]) =>
    `Not mapped in this workspace: ${nameList(names)}. Untick them to unshelve the rest.`,
  unshelveSaveFirst: (names: readonly string[]) => `Save ${nameList(names)} before unshelving?`,
  unshelveSaveFirstDetail: 'tf works on what is on disk, so unsaved edits must be saved first.',
  unshelveSaveYes: 'Save and Unshelve',
  unshelveSaveFailed: (name: string) => `${name} could not be saved, so nothing was unshelved.`,
  /**
   * Asked BEFORE tf runs (design's WANTED, 2026-09-23): unlike tf's own
   * `unshelve /move` and Visual Studio, this extension never silently drops
   * the unticked changes of the user's own shelveset just because they exist
   * only there.
   */
  unshelvePartialConfirm: (name: string, ticked: number, total: number) =>
    `Unshelve ${ticked} of ${total} changes from "${name}", and delete "${name}" from the server?`,
  unshelvePartialDetail: (unticked: readonly string[]) =>
    `Not ticked: ${nameList(unticked)}. ${unticked.length === 1 ? 'That change exists' : 'These changes exist'} only in this shelveset: deleting it loses ${unticked.length === 1 ? 'it' : 'them'} for good. Unshelve and Keep leaves the shelveset on the server.`,
  unshelvePartialKeep: 'Unshelve and Keep',
  unshelvePartialDelete: 'Unshelve and Delete',
  unshelveDone: (name: string) => `Unshelved "${name}".`,
  unshelveDoneDeleted: (name: string) => `Unshelved "${name}" and deleted it from the server.`,
  unshelveFailed: (name: string, detail: string) => `Unshelving "${name}" did not finish cleanly.\n\n${detail}`,
  unshelveConflicts: (name: string, count: number) =>
    `Unshelved "${name}". ${count} conflict${count === 1 ? ' needs' : 's need'} resolving.`,
  unshelveConflictsUnknown: (name: string) =>
    `Unshelved "${name}", but whether it left conflicts could not be checked. Look for conflicts before checking in.`,
  unshelveKept: (name: string, why: string) => `"${name}" was kept on the server: ${why}`,
  unshelveKeptExit: 'tf reported a problem.',
  unshelveKeptConflicts: 'the unshelve left conflicts.',
  unshelveKeptUnknown: 'whether the unshelve left conflicts could not be checked.',
  unshelveKeptLookup: 'the pending changes could not be read back.',
  /** Unlike unshelveKeptLookup (the pending-changes read-back): this is the shelveset's OWN contents, re-read right before the delete (keepWhole). */
  unshelveKeptReread: 'the shelveset could not be read again before deleting it.',
  unshelveKeptMissing: (names: readonly string[]) =>
    `these did not arrive as pending changes: ${nameList(names)}.`,
  unshelveKeptNotYours: 'it belongs to someone else.',
  unshelveKeptPartial: 'not every change in it was unshelved.',
  unshelveKeptChanged: 'it changed on the server after it was opened.',
  unshelveConflictCheckUnavailable: 'Resolve Conflicts is not available in this build.',
  shelvesetDeleteConfirm: (name: string) => `Delete shelveset "${name}"?`,
  shelvesetDeleteDetail: 'A deleted shelveset cannot be restored.',
  shelvesetDeleteYes: 'Delete',
  shelvesetDeleteNotYours: (name: string) =>
    `"${name}" belongs to someone else. Only your own shelvesets can be deleted here.`,
  shelvesetDeleted: (name: string) => `Deleted shelveset "${name}".`,
  shelvesetDeleteFailed: (name: string, detail: string) => `"${name}" was not deleted.\n\n${detail}`,
  // Phase 5: conflict resolution.
  conflictsGroup: 'Conflicts',
  conflictsTitle: 'Resolve Conflicts',
  conflictsNone: 'No conflicts.',
  conflictsRefresh: 'Refresh',
  conflictsAutoMergeAll: 'Auto-merge all',
  /** Visual Studio's Compare drop-down: the button, then its three choices (`compare` is the default). */
  conflictsLabels: {
    compareMenu: 'Compare',
    compare: 'Local and Server',
    compareServerBase: 'Server and Base',
    compareLocalBase: 'Local and Base',
    autoMerge: 'Auto-merge',
    takeTheirs: 'Take Server',
    keepYours: 'Keep Local',
    mergeManually: 'Merge manually',
    overwriteLocal: 'Overwrite local file',
    resolved: 'Resolved',
    cancelMerge: 'Cancel',
  },
  /** "yours from C18319, server at C18325"; a half `info` did not give is left out. */
  conflictsVersions: (base: number | undefined, theirs: number | undefined) =>
    [base === undefined ? '' : `yours from C${base}`, theirs === undefined ? '' : `server at C${theirs}`]
      .filter((s) => s !== '')
      .join(', '),
  conflictsMergingHint: 'Edit your file until it holds both changes, then:',
  conflictsCompareTitle: (name: string, theirs: number) => `${name}: Server C${theirs} ↔ Local`,
  conflictsCompareServerBaseTitle: (name: string, base: number, theirs: number) =>
    `${name}: Base C${base} ↔ Server C${theirs}`,
  conflictsCompareLocalBaseTitle: (name: string, base: number) => `${name}: Base C${base} ↔ Local`,
  conflictsTakeTheirsConfirm: (name: string) => `Take the server's version of ${name}?`,
  /** C13: TakeTheirs runs an undo of the pending change. */
  conflictsTakeTheirsDetail: 'Your pending change to it is undone, and your edits to the file are lost.',
  conflictsTakeTheirsYes: 'Take Server',
  conflictsKeepYoursConfirm: (name: string) => `Keep your version of ${name}?`,
  /** C14: KeepYours moves the pending change onto the server's changeset, so Check In overwrites theirs. */
  conflictsKeepYoursDetail: (theirs: number | undefined) =>
    `It stays exactly as it is, and your next Check In replaces what others checked in${
      theirs === undefined ? '' : ` up to C${theirs}`
    } — their changes are not merged.`,
  conflictsKeepYoursYes: 'Keep Local',
  conflictsOverwriteConfirm: (name: string) => `Replace ${name} with the server's version?`,
  conflictsOverwriteDetail: 'The file on disk is not in source control, and it will be lost.',
  conflictsOverwriteYes: 'Overwrite',
  conflictsResolvedConfirm: (name: string) => `Mark ${name} as merged?`,
  conflictsResolvedDetail: 'Your next Check In sends the file exactly as it is now.',
  conflictsResolvedYes: 'Resolved',
  /** A conflict of no known family: who "theirs" is, and so what is lost, is not known. */
  conflictsUnknownConfirm: (action: string, name: string) => `${action}: ${name}?`,
  conflictsUnknownDetail: (reason: string) =>
    `This extension does not know this kind of conflict, so it cannot say exactly what changes: your file, or your pending change to it, may be replaced. tf says: ${reason}`,
  conflictsUnsaved: (name: string) => `Save or revert ${name} first: it has unsaved changes.`,
  conflictsSaveFailed: (name: string) => `${name} could not be saved, so it was not marked as merged.`,
  conflictsActionFailed: (name: string, detail: string) => `tf did not resolve ${name}.\n\n${detail}`,
  conflictsAutoMergeAllResult: (resolved: number, total: number) =>
    `Auto-merge resolved ${resolved} of ${total} conflict${total === 1 ? '' : 's'}.`,
  conflictsAutoMergeAllNone: (detail: string) =>
    detail === '' ? 'Auto-merge resolved nothing.' : `Auto-merge resolved nothing.\n\n${detail}`,
  conflictsCheckFailed: (detail: string) => `Could not look for conflicts.\n\n${detail}`,
  conflictsNotUnderstood: (detail: string) => `tf's list of conflicts was not understood: ${detail}`,
} as const;
