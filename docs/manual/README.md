# Manual

Team Explorer (TFVC) gives you the same day-to-day TFVC actions Visual Studio's Team Explorer
does, from inside VS Code. If you have not installed it yet, start with the
[install guide](../install/README.md). For the feature tour with screenshots, see
[features.md](../features.md).

## Contents

- [Pending changes](pending-changes.md) — the Source Control panel: Included, Excluded,
  Conflicts, the comment box, Check In.
- [Editing files](editing-files.md) — Explorer badges, auto-checkout, the editor and Explorer
  menus, encoding protection, rename/move/delete.
- [History and Annotate](history-annotate.md)
- [Source Control Explorer](source-control-explorer.md)
- [Workspaces](workspaces.md)
- [Shelvesets](shelvesets.md)
- [Conflicts](conflicts.md)
- [Settings](settings.md) — every setting, every command, the badge colours.
- [Limitations](limitations.md)
- [Troubleshooting](troubleshooting.md)

## Concepts

### Server workspaces

This extension works with TFVC **server workspaces** (not local workspaces). That shapes almost
everything else on these pages:

- A file that is under source control is **read-only on disk until you check it out**. Checking
  out does two things at once: it records a pending change on the server, and it clears the
  read-only bit so you can edit the file.
- **Pending changes live on the server**, not only on your machine. Anyone else with access to the
  same TFVC collection — a colleague, another one of your own machines, Visual Studio — can see
  that an item has a pending change the moment you make it, not only after you check in. A TFVC
  workspace itself, though, belongs to a single computer: your other machine has its own
  workspace, not this one.

A TFVC "workspace" here is not the same thing as a VS Code workspace (an opened folder). A TFVC
workspace is the named mapping between server folders and a local folder, that the server keeps
track of; see [workspaces.md](workspaces.md).

### What is shared with Visual Studio, and what is not

If Visual Studio is set up on this same computer, pointed at this same workspace, it sees the
identical workspace and mappings — the two are, literally, one and the same object on the server.
More broadly, any TFVC client with access to the collection — Visual Studio anywhere, `tf.exe` run
by hand, another machine's own workspace — can see:

- pending changes
- shelvesets

One thing is **not** shared, because `tf.exe` has no concept of it at all — each TFVC client keeps
its own copy, purely locally:

- The **Excluded** list (which files are deliberately held back from the next check-in). Visual
  Studio has its own local Excluded Changes; this extension's list is separate from it.

The **"Not in source control"** list is a different case, not really a sharing question: it does
come from `tf.exe` — a background scan asks tf to reconcile the open folder against the server —
but this extension is the one that turns that scan into a visible group, off by default. Visual
Studio's own Pending Changes does not show an equivalent group at all. See
[pending-changes.md](pending-changes.md).

### The two Refresh buttons

There are two separate Refresh actions, and they do not mirror each other:

- The **Source Control panel's** own Refresh, in its title bar, re-reads the pending changes for
  the open folder, and also re-scans it for files that are not in source control. If the Source
  Control Explorer is open at the time, this also makes it reload the pending-change details
  (checked out, added, and so on) for whatever folder it is showing — but not that folder's
  contents, which stay as they were last listed.
- The **Source Control Explorer's** own Refresh, inside that separate view, reloads both the
  listing and the details for whatever folder it is showing. It does not touch the Source Control
  panel.
