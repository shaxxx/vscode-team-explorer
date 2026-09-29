# Known limitations

[Back to the manual](README.md).

## Tested scope

This extension has been tested against:

- **Azure DevOps Services**, with a Personal Access Token. Azure DevOps Server (on-premises) and
  other authentication methods have not been tried.
- **Server workspaces**. Local workspaces are not supported.
- **Windows 11 with Visual Studio 2022**, and **Fedora 44 with WineHQ 11.0**. Other Windows
  versions, other Visual Studio versions, and other Linux distributions are expected to work but
  have not been verified.
- **tf's output in English or Croatian.** History and Annotate dates are never parsed — both show
  them exactly as `tf` prints them, in whatever language and format Windows (or Wine) is set to;
  history order comes from changeset numbers, not from the date text. The history parser does need
  its own field labels ("Changeset:", "User:", "Date:", "Comment:", "Items:") to be in English,
  since `tf` prints those in English regardless of locale. Tested with `tf` on English and Croatian
  Windows.

Anything outside this list may work, but has not been checked.

## Accepted limitations

These are known, deliberate, and not going to change without a specific reason to revisit them.

- **No cloak/uncloak.** TFVC lets you exclude part of a mapped folder from Get without removing the
  mapping ("cloaking" it); this extension does not offer that. A workspace that was already cloaked
  from Visual Studio keeps working normally otherwise.
- **The Excluded list is not shared with Visual Studio.** TFVC has no server-side concept of
  included vs. excluded changes — Visual Studio keeps that list in its own local settings, which
  `tf.exe` can neither read nor write. This extension's Excluded list therefore lives only in this
  copy of VS Code. The pending changes themselves are on the server and stay in sync everywhere;
  only which ones you've excluded from the next check-in does not travel.
- **Only the nearest `.tfignore` is read.** Starting from the folder open in VS Code, this extension
  walks upward for the nearest `.tfignore`, stopping at the TFVC mapping's root — a `.tfignore` in a
  subfolder below that starting point is not read.
- **`packages` is ignored by default.** The default value of `teamExplorer.ignore` includes
  `packages`, so a versioned, edited file under a folder named `packages` shows no change badge in
  the tree (it still appears correctly in the Source Control panel itself). Remove `packages` from
  the setting if your project keeps versioned files there.
- **The Source Control Explorer lists server items only.** A file you've just added (a pending Add)
  does not appear in the Source Control Explorer until it is checked in.
- **The History grid's "Changeset" column header can be cut off** (reading "Changese"): its columns
  have a fixed width that cannot be resized. This is cosmetic and does not affect the data.
- **Annotate stops at a whole-file reformat.** If a changeset reformatted an entire file (for
  example, changed its indentation throughout), the diff for that changeset is too large to walk
  accurately, and Annotate stops there. Lines above that point are shown as "at or before" that
  changeset rather than attributed exactly.
- **View This Version and Compare tabs close on restart.** These open as read-only content tabs;
  VS Code does not restore that kind of tab across a restart, so reopen them from History again
  after restarting VS Code.
- **Shelve and Unshelve have no Cancel**, and run under the same command timeout as any other `tf`
  call. A very large shelve or unshelve could in principle be interrupted partway through; this has
  not been seen in practice.
- **A very large shelveset (roughly over 100 paths) is kept on the server after an unshelve**, even
  when you asked to delete it. Just before deleting it, the extension checks which of its paths are
  now pending in this workspace with one `tf vc status` command naming every path; above roughly
  8,191 characters the extension itself refuses to run that command (this is not `tf` refusing), so
  the check — and the delete — is skipped and the shelveset is left in place.
- **The Source Control panel's Refresh and the Source Control Explorer's Refresh do different
  things.** The panel's Refresh rescans your pending changes (and, if enabled, files not in source
  control), and also updates an open Source Control Explorer's status columns; it does not reload
  the Source Control Explorer's cached folder listings. To see folders or files added or removed on
  the server, use the Source Control Explorer's own Refresh.
- **A newly created file shows no change badge until the next scan.** Nothing rescans automatically
  just because a file was created; press Refresh, or wait for the next automatic scan (which also
  runs after Add, Undo, Get Latest Version, and a few other mutating commands).
- **Large groups in the Source Control panel render at most 500 rows** at a time; the group's title
  then reads "(showing 500 of &lt;total&gt;)". This limits only what is drawn — Check In and every
  other command still act on the true full set, not just the visible rows — except that Exclude or
  Include from a folder row acts only on the rows currently rendered, not on rows past the cap.

See [troubleshooting.md](troubleshooting.md) for problems that have a fix, rather than being
accepted as-is.
