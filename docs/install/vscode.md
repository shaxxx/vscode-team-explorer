# Install the extension and set it up

[Back to the install guide](README.md)

This is step 3: [Create a PAT](pat.md), then [Windows](windows.md) or [Linux](linux.md), come first.

## Install the .vsix

Team Explorer (TFVC) is not on the VS Code Marketplace. Download the `.vsix` file from the
[GitHub Releases page](https://github.com/shaxxx/vscode-team-explorer/releases). The current version
is `teamExplorer-1.0.0.vsix`; later releases follow the same pattern, `teamExplorer-<version>.vsix`.
(A `.vsix` is the packaged file format a VS Code extension installs from — see the
[glossary](README.md#glossary).)

Install it either way:

- **From VS Code**: open the Extensions view, click the `...` menu in its top-right corner, choose
  **Install from VSIX...**, and pick the file you downloaded.
- **From a terminal**:
  ```
  code --install-extension teamExplorer-<version>.vsix
  ```
  Expected output: a line reporting the extension installed successfully, echoing the file name as
  given, for example `Extension 'teamExplorer-1.0.0.vsix' was successfully installed.` (exact
  wording varies by VS Code version).

## Settings

Open **Settings** and search for `teamExplorer`, or edit `settings.json` directly. Two settings
matter for setup:

- **`teamExplorer.collectionUrl`** - required: your [collection URL](README.md#glossary) (see the
  glossary if that term is new). Its description in Settings:

  > Your TFVC collection URL, for example `https://dev.azure.com/your-org/` or
  > `https://your-org.visualstudio.com/`. Required: TFVC stays off until it is set. Reload the window
  > after changing it.

- **`teamExplorer.wrapperPath`** - only needed if the wrapper is not where the extension looks for it.
  Its description:

  > Path to the tfp wrapper. Empty means ~/bin/tfp.cmd on Windows and ~/bin/tfp on Linux. See the
  > install guide.

  This setting is machine-scoped, so it lives in your user settings, not in a workspace. Set it if you
  installed the wrapper somewhere else, or if you are using the Flatpak shim (see
  [linux.md](linux.md)).

The full list of settings, with every default, is on the manual's
[Settings](../manual/settings.md) page.

## Reload

The first time you set `teamExplorer.collectionUrl`, reload the window (Command Palette >
**Developer: Reload Window**, or close and reopen VS Code) so the extension finishes starting.

Do this **before** the Map a folder step below: the extension reads `teamExplorer.collectionUrl`
only once, when it starts up. Skip the reload and Manage Workspace will still say the collection
URL is missing, even though the setting shows the value you just typed.

## Map a folder

Team Explorer (TFVC) needs a folder that is mapped in a TFVC **server workspace** - the same kind of
workspace Visual Studio's Team Explorer uses.

- If a server workspace already maps a folder on this computer (for example, one Visual Studio
  created), just open that folder: **File > Open Folder...**. There is nothing else to do; Visual
  Studio and this extension share the same workspace.

  This extension supports only server workspaces. Visual Studio can create a **local** workspace
  instead - which one it offers by default depends on the collection's own workspace-type setting.
  In a local workspace every file stays writable all the time, so the checkout/lock behaviour
  described on this page and in the manual does not apply there. Not sure which kind an existing
  workspace is? Run `tfp vc workspaces /format:detailed /collection:<your collection URL>` in a
  terminal (`/format:detailed` needs `/collection`; see [pat.md](pat.md) for `tfp`) — Microsoft's
  own guidance is to use this detailed listing to tell a local workspace from a server one. If you
  are still not sure, create a new one below instead: **Manage Workspace**'s own **Create
  Workspace…** always creates a server workspace.
- If not, run **Team Explorer: Manage Workspace** from the Command Palette. What it shows depends on
  what this computer already has:
  - No workspace yet: it offers **Create Workspace…** only.
  - Exactly one workspace: it goes straight to that workspace's list of mappings, with **Create
    Workspace…** added as the last row.
  - Two or more: it first asks which workspace to open (also offering **Create Workspace…** there);
    picking one opens its list of mappings.

  ![Picking a workspace on this computer, with Create Workspace as the last row](../images/manage-workspace.png)

  From a workspace's mapping list, pick **Add Mapping…** to map another server folder, or pick an
  existing mapping to get it or remove it:

  ![A workspace's mappings, with Add Mapping as the last row](../images/manage-workspace-2.png)

  A new workspace's name cannot repeat one this computer already has (matched without regard to
  case).

  **Create Workspace…** maps and gets a folder for you, but it does not open it. Once it finishes,
  open that same local folder in VS Code (**File > Open Folder...**) so Team Explorer picks it up.

Next: [Check that it works](verify.md).
