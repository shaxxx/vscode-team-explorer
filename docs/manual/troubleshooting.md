# Troubleshooting

[Back to the manual](README.md).

## Check the output channel first

Almost everything this extension logs goes to its own output channel. Open **View > Output**, and
in the dropdown at the top of that panel choose **Team Explorer**. Every line is stamped with the
time it was written, and the first line, written every time VS Code starts, looks like:

```
14:32:07.123 TFVC extension activated (build <build stamp>)
```

If that line is missing, the extension did not activate — check the Extensions view for an
activation error. If it's there but everything else looks wrong, the rest of the channel usually
has the raw output of the last `tf` command that failed, which is often more specific than the
notification VS Code showed.

## Common error messages

These come from anywhere in the extension, not from one specific feature — messages tied to a
particular command (creating a workspace, shelving, resolving a conflict) appear next to that
command and are explained on that feature's own manual page instead of repeated here. Every message
below is quoted exactly as this extension shows it.

| Message | What it means and what to do |
|---|---|
| "No personal access token found. Run "Team Explorer: Set Personal Access Token"." | No token is saved yet. Run that command, or create `pat.txt` as [pat.md](../install/pat.md) describes. |
| "The personal access token was rejected. Run "Team Explorer: Set Personal Access Token"." | `tf` returned TF30063 or TF400813 (not authorised). Usually the token expired, was revoked, or does not have **Full access** scope — a token scoped to **Code (Read & Write)** causes the same TF30063 and is rejected the same way, because `tf.exe` talks to endpoints that scope does not cover. Create a new Full access token (see [pat.md](../install/pat.md)) and set it again. |
| "That does not look like a personal access token: it contains a space or a line break. …" | Shown only by "Team Explorer: Set Personal Access Token" checking what you just typed; nothing was saved. Run it again and paste just the token, with no extra spaces or line breaks. |
| "TF.exe was not found. Set TF_EXE for the tfp wrapper, or see the install guide." | **Windows:** either no Visual Studio with Team Explorer was found, or `TF_EXE` is set but points to a file that does not exist — install Visual Studio 2022 (any edition), or fix or unset `TF_EXE`. **Linux:** TF.exe was not found in the wrapper's Team Explorer folder — copy it there from a Windows Visual Studio 2022 install (see [linux.md](../install/linux.md)), or set `TF_DIR` to wherever you put it. Restart VS Code after changing an environment variable; it only reads them at startup. |
| "The Wine prefix was not found. See the Linux install guide." | The 64-bit Wine prefix that runs TF.exe under Wine has not been created yet. Follow [linux.md](../install/linux.md). |
| "The tfp wrapper was not found. Install it as the install guide describes, or set "teamExplorer.wrapperPath"." | The `tfp` (or `tfp.cmd`) script is not where the extension expects it. Install it, or point `teamExplorer.wrapperPath` at your own copy. |
| "Team Explorer (TFVC) needs your collection URL. Set "teamExplorer.collectionUrl" …, then reload the window." | The extension stays off until this setting is filled in. Set it to your organisation's URL and reload the window. |
| "The tfp wrapper ran, but a program it needs was not found (exit code 127). On Linux this is usually Wine." | Something the wrapper calls is missing — normally Wine itself. Check the Linux install steps. |
| "This VS Code is a Flatpak, and Wine is not available inside it. Set "teamExplorer.wrapperPath" to the tfp-flatpak shim …" | See [Flatpak VS Code](#flatpak-vs-code) below. |
| "This folder is not mapped in a TFVC workspace." | The open folder has no TFVC mapping. Use **Manage Workspace** to add one, or open a folder that is already mapped. |
| "No file selected. Open a file or right-click one in the Source Control panel." | The command needs a specific file; run it from an open editor or from a right-click in the panel instead of the Command Palette. |
| "The tf command could not be started." | `tf` (via the wrapper) never ran at all. Check `teamExplorer.wrapperPath` and, on Linux, that the wrapper is executable. |
| "The tf command timed out after &lt;n&gt;ms." | A single `tf` call took too long. A cold Wine prefix or a very large operation can be slow; wait and try again. |
| "The command was stopped (&lt;signal&gt;) before it could report its result. …" | VS Code or the OS stopped the command mid-flight. The panel refreshes itself right after, so check there whether the action actually completed before retrying. |
| "The saved list of excluded files could not be read and has been treated as empty. …" | Your Excluded list (see [limitations.md](limitations.md)) could not be loaded. Everything shows as included; re-exclude what you need before checking in. |
| "Couldn't read tf's history output. Its first lines are in the Team Explorer output channel." | The History view got output it could not parse. Check the output channel (above) for `tf`'s raw text. |
| "&lt;file&gt; was not decoded correctly — &lt;n&gt; character(s) are already lost in the editor, …" | VS Code opened the file with the wrong text encoding. Close it without saving, change `files.encoding` to the encoding the message names, and reopen it — the file on disk is untouched. |
| "This version cannot be shown yet: the extension has not finished starting." | The extension is still activating. Wait a moment and try again. |

A `tf` error code that is not one of the above (for example TF14098, "access denied", or TF14061,
"not in a workspace") is shown using `tf`'s own message text, unedited.

## A stale build after reinstalling

If you rebuild or reinstall the extension and VS Code still behaves like the old version, the
installed files on disk can be correct while a window that was already running keeps the old code
loaded in memory — a reload of that window is not always enough to pick up the new build.

Check the build stamp in the output channel (see above) against the one you just installed. If it
still shows the old stamp, **close every VS Code window** (not just reload) and reopen. Only after
every window is closed does the next one load the new build.

## VS Code's pending update

A per-user install of VS Code can refuse to open a new window or a second instance while it has
already downloaded an update and is waiting to apply it, with a message that "Code is currently
being updated" (VS Code's own wording, not this extension's). Close every VS Code window and start
it again once; that lets the pending update finish, after which VS Code opens normally. A portable
VS Code install is not affected.

## Flatpak VS Code

A Flatpak VS Code runs inside a sandbox that has no Wine, so the normal Linux wrapper (`tfp`, which
calls Wine directly) cannot work there. Install the `tfp-flatpak` shim outside the sandbox and point
`teamExplorer.wrapperPath` at its full path (this setting is machine-scoped, so set it in your user
settings, not in a workspace). See [linux.md](../install/linux.md) for the exact steps. Fedora can
have both an RPM and a Flatpak VS Code installed side by side; they read different settings, so make
sure you are editing the settings of the VS Code you are actually running.

## A stuck Wine prefix

If every `tf` command hangs or times out on Linux, a `wineserver` process left over from a previous
run can be the cause. Kill it for the wrapper's own Wine prefix — `~/.wine-tf` by default, or
whatever you set `WINEPREFIX` to:

```
WINEPREFIX=~/.wine-tf wineserver -k
```

This only kills the Wine background process, not any pending changes — those live on the server —
and `wineserver` starts again automatically the next time `tf` runs (the first call after that is
slower, since it starts cold).

## VS Code's "Overwrite" trap

When VS Code fails to save a file because it is read-only, it offers an **Overwrite** button. On a
TFVC file, **do not use it.** Overwrite simply clears the read-only bit and writes the file directly
— it does not check the file out, so TFVC never learns the file changed. The edit becomes invisible
to source control: it will not appear as a pending change, so it will not be included in your next
check-in either.

If a save fails on a read-only file, cancel the Overwrite prompt and run **Team Explorer: Check Out
for Edit** first, then save again. A file that is already writable without being checked out (for
example, because Overwrite was used before this was known, or the file was made writable outside
VS Code) shows the `!` badge described in
[editing-files.md](editing-files.md#explorer-badges) — checking it out clears the badge and brings
it back under TFVC's tracking.

## Reporting a bug

Open an issue at <https://github.com/shaxxx/vscode-team-explorer/issues>. Include:

- What you did, what you expected, and what happened instead.
- The build stamp from the first line of the **Team Explorer** output channel (see above).
- The rest of that output channel, if it's not too long — but **read through it first** and remove
  anything private: your collection URL, local file paths (these contain your Windows user name),
  server paths, and project, computer or workspace names, or anything else you would not otherwise
  post publicly. The channel logs `tf`'s own command lines and output, which can include any of
  these.
