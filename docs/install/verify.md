# Check that it works

[Back to the install guide](README.md)

This is step 4, after [installing the extension and setting it up](vscode.md).

## 1. Terminal

Run the wrapper directly, with your own [collection URL](README.md#glossary):

```
tfp vc workspaces /collection:https://dev.azure.com/your-org/
```

| Output | Meaning |
|---|---|
| A message that starts with `No workspace matching` (exit code 1) | Authentication worked: tf reached the server and answered honestly that this computer has no workspace yet. |
| A table listing one or more workspaces (exit code 0) | Authentication also worked: this computer (or PAT owner) already has a workspace against this collection, which is just as valid a result. |
| `[tfp] PAT file not found: ...` or `[tfp] PAT file is empty: ...` (Windows), `[tfp] PAT file not found or empty: ...` (Linux) | `pat.txt` itself is missing or empty — this is the wrapper's own message, printed before it ever calls `tf`. Save the token as [pat.md](pat.md) describes. |
| A message that starts with `TF30063` | The PAT is present but wrong, expired, or does not have enough access. See the table below. |

If `tfp` itself is "not found" in the terminal, `~/bin` (or `%USERPROFILE%\bin`) is not on your
shell's PATH; that does not affect VS Code, which runs the wrapper by its full path.

## 2. VS Code

Open a folder that is mapped in a TFVC workspace (see [vscode.md](vscode.md)).

- **Output channel**: open the Output panel and pick **Team Explorer** from its dropdown. Every line
  there starts with the time it was logged, so its first line reads something like:
  ```
  14:02:03.117 TFVC extension activated (build ...)
  ```
  (the time is when the extension started; `...` in `build ...` is a timestamp for when the `.vsix`
  you installed was built.)
- **Source Control panel**: open it. It shows a **Team Explorer** provider, with **Included Changes**
  and **Excluded Changes** groups (and a **Conflicts** group, when there are any).
- **Explorer badges**: files under source control show a small lock badge in the Explorer.
- **Auto-checkout**: with the default setting, typing in a file checks it out for edit automatically -
  its badge changes and the file becomes writable. **Undo Pending Changes** on that file reverts it to
  the server version and removes the pending change.

If any of this does not happen, open the **Team Explorer** output channel and look for the message it
logged, then find it below.

## Troubleshooting

Every message below is quoted exactly as the extension shows it.

| Message | Fix |
|---|---|
| "Team Explorer (TFVC) needs your collection URL. Set \"teamExplorer.collectionUrl\" (for example https://dev.azure.com/your-org/), then reload the window." | Set `teamExplorer.collectionUrl` in Settings (see [vscode.md](vscode.md)), then reload the window. This shows even in an empty window, with no folder open. |
| "The tfp wrapper was not found. Install it as the install guide describes, or set \"teamExplorer.wrapperPath\"." | Install the wrapper where the extension expects it - `~/bin/tfp.cmd` on Windows, `~/bin/tfp` on Linux (see [windows.md](windows.md) / [linux.md](linux.md)) - or point `teamExplorer.wrapperPath` at wherever you put it. |
| "The tfp wrapper ran, but a program it needs was not found (exit code 127). On Linux this is usually Wine." | Install Wine (see [linux.md](linux.md)). |
| "This VS Code is a Flatpak, and Wine is not available inside it. Set \"teamExplorer.wrapperPath\" to the tfp-flatpak shim (see the Linux install guide)." | Install the `tfp-flatpak` shim and set `teamExplorer.wrapperPath` to its full path (see [linux.md](linux.md)). |
| "TF.exe was not found. Set TF_EXE for the tfp wrapper, or see the install guide." | On Windows: install Visual Studio with Team Explorer (see [windows.md](windows.md)), or set the `TF_EXE` environment variable to TF.exe's full path. On Linux: copy TF.exe to where `tfp` looks for it - `/opt/teamexplorer` by default (see [linux.md](linux.md)) - or set `TF_DIR` to the folder that holds it (`tfp` builds `TF_DIR/TF.exe`; it does not read `TF_EXE`). Either way, restart VS Code completely afterwards - reloading the window does not pick up a changed environment variable, only relaunching the process does. |
| "The Wine prefix was not found. See the Linux install guide." | Set up the Wine prefix as [linux.md](linux.md) describes. |
| "No personal access token found. Run \"Team Explorer: Set Personal Access Token\"." | Run **Team Explorer: Set Personal Access Token** from the Command Palette, or save the token yourself (see [pat.md](pat.md)). |
| "The personal access token was rejected. Run \"Team Explorer: Set Personal Access Token\"." | The token is expired, revoked, or does not have enough access - tf.exe needs a **Full access** token, not just Code (Read & Write) (see [pat.md](pat.md)). Create a new one and run **Team Explorer: Set Personal Access Token** again. |
| "This folder is not mapped in a TFVC workspace." | Run **Team Explorer: Manage Workspace** and map the folder, or open a folder that is already mapped (see [vscode.md](vscode.md)). |

More messages, and what to do about a stale build after reinstalling or a stuck Wine prefix, are on
the manual's [Troubleshooting](../manual/troubleshooting.md) page.
