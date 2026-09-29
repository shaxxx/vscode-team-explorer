# Install or update with an AI agent

[Back to the install guide](README.md)

This page is written for an AI coding agent installing or updating Team Explorer (TFVC) on a
human's behalf - not for a person reading along. It is safe to run twice: every step checks what
is already there before changing anything, so following this page again later brings an existing
install up to date. If you are a person, use [the rest of the install guide](README.md)
instead, starting with [Create a PAT](pat.md).

## Rules

- **Never** ask the human to paste their personal access token into chat, and never put it on a
  command line. A token on a command line sits in shell history and is visible, while a `tf` command
  runs, to anyone who can list processes on the machine. The human creates and saves the token
  themselves, at the STOP point below - never you.
- **Never** open, read, or print the contents of the PAT file yourself. Check only whether it
  exists and is non-empty (see the STOP step below).
- **Never** run `tf vc checkin`, or anything that checks changes in. In this project, checking in is
  reachable only through the **Check In** button's own confirmation dialog inside VS Code. There is no
  command-line or scripted path, and an agent must not create one.
- **Never** clear a workspace file's read-only bit directly (`chmod`, `attrib -r`) to edit it. Use
  `tf checkout` (through the wrapper) instead - clearing the bit outside TFVC makes the edit invisible
  to source control.
- **Never** overwrite a setting, a wrapper, or a PAT file that is already there without asking
  first - an update should change only what is missing or genuinely out of date.
- **Stop and ask the human** at every point marked STOP below. Do not guess, skip ahead, or substitute
  your own judgement for the human's at those points.

## Ask first

Before doing anything, ask the human:

1. Which OS is this: Windows or Linux?
2. On Windows only: is Visual Studio already installed, and which version? This extension is tested
   with **Visual Studio 2022** (any edition - Community is free). 2019 and 2026 also carry TF.exe in
   the same place but are untested with this extension. If the human does not know, check yourself
   (Windows step 1 below) rather than guessing.
3. Also install the `tfs-workflow` agent skill, alongside the extension? It lets an AI agent run TFVC
   commands itself (checkout, status, get latest, and so on) through this same wrapper and PAT, and
   it never checks in on its own either. If yes, this page installs it as its last step, reusing
   everything already done below - see [skill.md](skill.md) for what it does on its own.

## Windows steps

**1. Find TF.exe.** The wrapper looks for a Visual Studio 2022 install first, then falls back to the
newest Visual Studio it can find of any version. Run the first search yourself:

```powershell
& "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe" -nologo -sort -products * -version "[17.0,18.0)" -find "Common7\IDE\CommonExtensions\Microsoft\TeamFoundation\Team Explorer\TF.exe"
```

Expected output: one line, a path ending in `TF.exe`, for example:
```
C:\Program Files\Microsoft Visual Studio\2022\Community\Common7\IDE\CommonExtensions\Microsoft\TeamFoundation\Team Explorer\TF.exe
```

If that prints nothing, run the same search again without `-version "[17.0,18.0)"` - this is the
wrapper's own fallback, and picks up an older or newer Visual Studio that still has TF.exe in the
same place:

```powershell
& "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe" -nologo -sort -products * -find "Common7\IDE\CommonExtensions\Microsoft\TeamFoundation\Team Explorer\TF.exe"
```

If that also prints nothing, **STOP**: ask the human to install Visual Studio 2022 (any edition -
Community is free). TF.exe comes with every edition's default install; there is no separate installer
component to pick. Wait for confirmation before continuing.

**2. Get the wrapper scripts.** The GitHub Release ships only the `.vsix`, not `wrappers/tfp.cmd` - get
them from the repository itself. Prefer `git clone` if `git` is available, because it applies this
repository's line-ending rules automatically; `tfp.cmd` is stored as a batch file that needs CRLF line
endings, and a plain file download (for example `raw.githubusercontent.com`) would hand you it with
LF endings instead, which a `.cmd` file does not reliably run with.

```powershell
Remove-Item -Recurse -Force "$env:TEMP\vscode-team-explorer" -ErrorAction SilentlyContinue
git clone --depth 1 https://github.com/shaxxx/vscode-team-explorer "$env:TEMP\vscode-team-explorer"
```

The `Remove-Item` first is needed if you are running this page again (an update): `git clone`
refuses to clone into a folder that already exists and is non-empty. Expected output: a few lines
starting with `Cloning into ...` and ending with no error (exit code 0).

If `git` is not available, download the repository as a zip instead (GitHub builds this from the same
source, so the line endings are still correct) and expand it:

```powershell
Invoke-WebRequest -Uri "https://github.com/shaxxx/vscode-team-explorer/archive/refs/heads/main.zip" -OutFile "$env:TEMP\vte.zip"
Expand-Archive -Path "$env:TEMP\vte.zip" -DestinationPath "$env:TEMP" -Force
```

Expected output: nothing on success; the files land under `$env:TEMP\vscode-team-explorer-main\`
instead of `$env:TEMP\vscode-team-explorer\` (note the `-main` suffix) - adjust the next command's
source path to match whichever you used.

**3. Install or update the wrapper.** Check whether it is already there:

```powershell
Test-Path "$env:USERPROFILE\bin\tfp.cmd"
```

- **`False`**: install it.
  ```powershell
  New-Item -ItemType Directory -Force "$env:USERPROFILE\bin" | Out-Null
  Copy-Item "$env:TEMP\vscode-team-explorer\wrappers\tfp.cmd" "$env:USERPROFILE\bin\tfp.cmd"
  ```
  Expected output: nothing; `%USERPROFILE%\bin\tfp.cmd` now exists.
- **`True`**: compare it with this release's copy by hash before touching anything - **not** with
  the bare `fc` command: in PowerShell that name is an alias for `Format-Custom`, a completely
  different cmdlet, and errors out on two file paths.
  ```powershell
  (Get-FileHash "$env:USERPROFILE\bin\tfp.cmd").Hash -eq (Get-FileHash "$env:TEMP\vscode-team-explorer\wrappers\tfp.cmd").Hash
  ```
  - `True`: it already matches this release; leave it alone.
  - `False` - **STOP**: this may be the human's own wrapper, an older copy, or even the same text
    saved with the wrong line endings (which a text-mode compare would call identical, but a batch
    file needs CRLF - see [windows.md](windows.md)). Show the human both files, for example with
    `fc.exe /b "$env:USERPROFILE\bin\tfp.cmd" "$env:TEMP\vscode-team-explorer\wrappers\tfp.cmd"`
    (note the `.exe`, to bypass the `Format-Custom` alias), and ask before replacing it. Only run
    the `Copy-Item` command above if they say yes.

If `vswhere` cannot find your Visual Studio install (for example, a custom install location, or
more than one Visual Studio on the machine), set `TF_EXE` to the full path of `TF.exe` from step
1, and the wrapper uses that instead of searching.

## Linux steps

**1. Check Wine.**

```bash
wine --version
```

Expected: `wine-11.0` or newer (this extension is tested against WineHQ 11.0 on Fedora 44; other
distributions' own `wine` packages work too, just with different version numbers). If `wine` is not
found, **STOP** and ask the human to install it - package names differ enough between distributions
(and between a distribution's own `wine` package and a WineHQ build) that this is not something to
guess at.

**2. Get TF.exe onto this machine.** Check first whether it is already there from an earlier
install:

```bash
test -f "${TF_DIR:-/opt/teamexplorer}/TF.exe" && echo present
```

If that prints `present`, skip the rest of this step. Otherwise: this project never ships or
downloads Microsoft's files, so TF.exe comes only from a Visual Studio install. **STOP** and ask
the human either to install Visual Studio somewhere themselves and tell you how to reach that
machine, or to copy the `Common7\IDE\CommonExtensions\Microsoft\TeamFoundation\Team Explorer`
folder from a Windows machine that has Visual Studio onto this one - to `/opt/teamexplorer`, the
location `tfp` looks for TF.exe in by default (a different location needs the `TF_DIR` environment
variable set to it, and the check above needs the same variable to look in the right place) - and
confirm when it is in place. Do not proceed until the human confirms TF.exe is on this machine.

**3. Set up a 64-bit Wine prefix with the real .NET Framework 4.8.** Skip this step if
`WINEPREFIX=~/.wine-tf wine uninstaller --list` already shows **Microsoft .NET Framework 4.8** (see
the verification command below). Otherwise, Wine's built-in Mono runtime is not enough; TF.exe needs
the real .NET Framework 4.8 installed into the prefix. Install `winetricks` as a standalone script
rather than through the distribution's package manager - on some distributions (Fedora included)
that package conflicts with a WineHQ install:

```bash
sudo dnf install cabextract   # or this distribution's equivalent, e.g. apt install cabextract
mkdir -p ~/bin
curl -fsSL -o ~/bin/winetricks https://raw.githubusercontent.com/Winetricks/winetricks/master/src/winetricks
chmod +x ~/bin/winetricks

export WINEPREFIX=~/.wine-tf WINEARCH=win64
wineboot -i
~/bin/winetricks -q dotnet48
```

Expected: `wineboot` creates `~/.wine-tf` (an `err:ole:start_rpcss ...` line is harmless); `winetricks`
finishes with no error after several minutes. **STOP** if `winetricks` reports it needs a display and
none is available here: ask the human to either run this one step themselves on a machine with a
desktop session, or make one available to you (for example a VNC session).

Verify it actually worked:

```bash
WINEPREFIX=~/.wine-tf wine uninstaller --list
```

Expected: a line containing "Microsoft .NET Framework 4.8", and no "Wine Mono Runtime" line. If Wine
Mono is still listed, `dotnet48` did not finish - re-run `~/bin/winetricks -q dotnet48` (drop `-q` and
read its own output if it keeps failing).

**4. Get the wrapper scripts.** As on Windows, the GitHub Release ships only the
`.vsix`; get `wrappers/tfp` from the repository itself:

```bash
rm -rf /tmp/vscode-team-explorer
git clone --depth 1 https://github.com/shaxxx/vscode-team-explorer /tmp/vscode-team-explorer
```

The `rm -rf` first is needed if you are running this page again (an update): `git clone` refuses
to clone into a folder that already exists and is non-empty. Expected output: a few lines starting
with `Cloning into ...` and ending with no error. If `git` is not available:

```bash
curl -fsSL -o /tmp/vte.zip https://github.com/shaxxx/vscode-team-explorer/archive/refs/heads/main.zip
unzip -q -o /tmp/vte.zip -d /tmp
```

(`-o` overwrites files from a previous run instead of silently keeping the old ones.)

Expected output: nothing on success (the `-fsSL` flags suppress curl's progress meter, and `-q`
silences unzip's file listing); the files land under `/tmp/vscode-team-explorer-main/` instead of
`/tmp/vscode-team-explorer/` - adjust the next command's source path to match whichever you used.

**5. Install or update the wrapper.** Check whether it is already there:

```bash
test -f ~/bin/tfp && echo present
```

- **Nothing printed**: install it.
  ```bash
  mkdir -p ~/bin
  cp /tmp/vscode-team-explorer/wrappers/tfp ~/bin/tfp
  chmod +x ~/bin/tfp
  ```
  Expected output: nothing; `~/bin/tfp` now exists and is executable.
- **`present`**: compare it with this release's copy before touching anything.
  ```bash
  diff -u ~/bin/tfp /tmp/vscode-team-explorer/wrappers/tfp
  ```
  - No output (exit code 0): it already matches this release; leave it alone.
  - Any diff output - **STOP**: this may be the human's own wrapper, or an older copy. Show them
    the diff and ask before replacing it. Only run the `cp` command above if they say yes.

If VS Code here is a Flatpak, also install `wrappers/tfp-flatpak` from the same clone or zip, the
same way (check/compare/copy against `~/bin/tfp-flatpak`) - Wine is not reachable from inside the
Flatpak sandbox, so this shim runs the real wrapper on the host instead. See
[linux.md](linux.md) for the reasoning.

## Install or update the extension

**Find the latest release**, unless the human asked for a specific version - do not assume any
hard-coded version number, since this page outlives every release:

- Windows (PowerShell):
  ```powershell
  $latest = (Invoke-RestMethod -Uri "https://api.github.com/repos/shaxxx/vscode-team-explorer/releases/latest").tag_name.TrimStart('v')
  $latest
  ```
- Linux (bash):
  ```bash
  latest=$(curl -fsSL https://api.github.com/repos/shaxxx/vscode-team-explorer/releases/latest | grep -m1 '"tag_name"' | sed -E 's/.*"tag_name": *"v?([^"]+)".*/\1/')
  echo "$latest"
  ```

Expected: a version number such as `1.0.0`, with no leading `v`.

**Check what is already installed:**

```
code --list-extensions --show-versions
```

If `code` is not on the PATH (for example VS Code installed as a Flatpak), try
`flatpak run com.visualstudio.code --list-extensions --show-versions` instead of guessing - do not
substitute a different command by assumption alone.

Look for a line starting `integrator.teamexplorer@` (VS Code lowercases extension ids in this
listing, even though `package.json` spells the id `integrator.teamExplorer`), and compare the
version after the `@` with `$latest`:

- **Same version**: already up to date - skip straight to
  [the PAT step](#stop-the-human-creates-the-pat-and-saves-it) below.
- **Older version, or no matching line at all**: continue below.
- **Newer version than `$latest`** (for example a pre-release build): leave it alone - do **not**
  downgrade it with `--force` - note this in the report at the end, and skip straight to
  [the PAT step](#stop-the-human-creates-the-pat-and-saves-it).

  (Compare two version numbers with, for example, `[version]"1.2.0" -gt [version]"1.0.0"` in
  PowerShell, or `[ "$(printf '%s\n%s\n' "$a" "$b" | sort -V | tail -1)" = "$a" ]` in bash.)

Download the `.vsix` for that version from the GitHub Release:

- Windows (PowerShell):
  ```powershell
  Invoke-WebRequest -Uri "https://github.com/shaxxx/vscode-team-explorer/releases/download/v$latest/teamExplorer-$latest.vsix" -OutFile "$env:TEMP\teamExplorer-$latest.vsix"
  ```
- Linux (bash):
  ```bash
  curl -fsSL -o "/tmp/teamExplorer-$latest.vsix" "https://github.com/shaxxx/vscode-team-explorer/releases/download/v$latest/teamExplorer-$latest.vsix"
  ```

Expected output: nothing on success.

Then install it, with `--force` so an older installed version is replaced instead of refused:

```
code --install-extension <path to the downloaded .vsix> --force
```

Expected output: a line reporting the extension installed successfully, echoing the file name as
given, for example `Extension 'teamExplorer-1.0.0.vsix' was successfully installed.` (exact wording
varies by VS Code version). If `code` is not on the PATH, try
`flatpak run com.visualstudio.code --install-extension <path> --force` the same way. Only if both
are unavailable, ask the human to use VS Code's own **Install from VSIX...** command instead (see
[vscode.md](vscode.md)) - you cannot click that yourself.

**If this was an update** (an older version was found above), tell the human to close every VS Code
window and reopen it - a window left open from before the update keeps running the old build in
memory, even though the files on disk are now the new version.

## STOP: the human creates the PAT and saves it

Check first whether a PAT is already saved: `~/.tfs/pat.txt` on Linux,
`%USERPROFILE%\.tfs\pat.txt` on Windows - or wherever `TFS_PAT_FILE` points, if it is set - already
exists and is non-empty. Check only that it exists and is non-empty; never open or print it.

- Windows (PowerShell):
  ```powershell
  $f = if ($env:TFS_PAT_FILE) { $env:TFS_PAT_FILE } else { "$env:USERPROFILE\.tfs\pat.txt" }
  (Test-Path $f) -and ((Get-Item $f).Length -gt 0)
  ```
- Linux (bash): `test -s "${TFS_PAT_FILE:-$HOME/.tfs/pat.txt}" && echo present`

If it is already there, **never touch or ask about it** - leave it exactly as it is and skip to
[Find the collection URL](#find-the-collection-url) below; [Verify](#verify) at the end will show
whether it still works.

Otherwise, do not create, request, or type the token yourself. Relay this to the human, essentially
word for word, and wait for their confirmation before continuing:

> Create a Personal Access Token in Azure DevOps: open your user settings (top right) -> **Personal
> access tokens** -> **New Token**. Give it a name, pick the organisation, set an expiry you are
> comfortable with, and under **Scopes** choose **Full access** - a narrower scope such as Code
> (Read & Write) is not enough; tf.exe talks to older APIs that reject it with error TF30063. Select
> **Create** and copy the token; it will not be shown again.
>
> Now that the extension is installed, save it one of two ways - both are things only you should do,
> never me:
> - Run **Team Explorer: Set Personal Access Token** from the Command Palette and paste the token
>   into the box it opens. That box is a masked input; nothing is echoed to a terminal or a log.
> - Or save it as the only line of `~/.tfs/pat.txt` (Linux) / `%USERPROFILE%\.tfs\pat.txt`
>   (Windows), as UTF-8 with **no byte-order mark (BOM)**. Use a text editor, or one of the
>   masked-input recipes at
>   https://github.com/shaxxx/vscode-team-explorer/blob/main/docs/install/pat.md#save-it - not a
>   command with the token typed directly into it, which would sit in your shell history.
>
> Either way, tell me only when it is done. Never paste the token itself into this chat, and please
> don't ask me to run either of the commands above for you - I should never see the token.

## Find the collection URL

**On an update** (a value is already set - see [Configure](#configure) for where to look): keep
the existing `teamExplorer.collectionUrl` setting exactly as it is. Skip the rest of this step.

**On a first install**, find it instead of asking the human to type it, using the wrapper and the
PAT from the steps above. Run this with no `/collection` argument, from a folder that is not
inside any TFVC workspace (for example the home folder) - only there does it list every
collection the local cache knows about, rather than just the one folder it is inside:

- Windows: `& "$env:USERPROFILE\bin\tfp.cmd" vc workspaces`
- Linux: `~/bin/tfp vc workspaces`

Always run the real wrapper here, even if you also installed the `tfp-flatpak` shim - that shim
only makes sense run *from inside* a Flatpak-sandboxed VS Code, where Wine is unreachable; a
terminal session you are running commands in yourself is not that sandbox, so `~/bin/tfp` is
always correct here. Never run `tf.exe` directly for this either - without the wrapper's login
arguments it can hang on an invisible sign-in window. Do not read tf's own cache file directly
either; its location and format vary with the tf version and, on Linux, the Wine prefix.

Expected: exit code 0, with the output grouped under header lines like:

```
Collection: https://your-org.visualstudio.com/
```

one per collection the cache knows about, each followed by a Workspace/Owner/Computer/Comment
table (an empty table is fine - only the header lines matter here). Collect the distinct
`Collection:` URLs and offer them to the human:

- **One URL**: ask "Use `<url>` as your collection URL?" and wait for a yes.
- **Several URLs**: show them as a list, plus an "another URL" option, and ask the human to pick.
- **None listed, or the command fails**: ask the human to type their collection URL directly (for
  example `https://dev.azure.com/your-org/` or `https://your-org.visualstudio.com/`).

Whichever way you got it, make sure the URL ends with a trailing `/` before using it anywhere else
on this page - add one if it is missing. A URL typed by a human easily omits it, but other pages
build paths directly onto the end of it (for example `<the collection URL>_usersSettings/tokens`),
which only comes out right with the slash there.

This list is only a suggestion from a local cache - it can include a deleted workspace, or an old
organisation the human no longer uses, and a brand new machine (or a fresh Wine prefix) has no
cache at all, so the human types it there instead. Always let the human confirm or override the
choice; never pick silently on their behalf. A PAT that does not match the collection it is used
against shows up later, in [Verify](#verify), as a `TF30063` error.

## Configure

Write the collection URL - and the wrapper path, only if you installed the wrapper somewhere other
than the default - into the human's **user** settings.json, not a workspace's `.vscode/settings.json`:
`teamExplorer.wrapperPath` is a machine-scoped setting and is only read from the user settings file.
Its location:

- Windows: `%APPDATA%\Code\User\settings.json`
- Linux: `~/.config/Code/User/settings.json` (or, for a Flatpak install,
  `~/.var/app/com.visualstudio.code/config/Code/User/settings.json`)

**Write each key only if it is missing from that file.** If `teamExplorer.collectionUrl` or
`teamExplorer.wrapperPath` is already set to something there, leave it exactly as it is - do not
overwrite an existing value, even with the URL you just found above. Merge in whatever is missing,
without touching the rest of the file:

```json
{
  "teamExplorer.collectionUrl": "<the collection URL from the previous step>"
}
```

Add `teamExplorer.wrapperPath` only if it is missing AND the wrapper is not at the default location
the extension looks for (`~/bin/tfp.cmd` on Windows, `~/bin/tfp` on Linux) - for example the
Flatpak shim:

```json
{
  "teamExplorer.wrapperPath": "/home/<user>/bin/tfp-flatpak"
}
```

## Verify

Now that the PAT is saved, run the terminal test with the wrapper's full path (it may not be on this
shell's PATH yet). Always run `tfp` itself here, even on a Flatpak setup - `tfp-flatpak` is only
for `teamExplorer.wrapperPath`, so that VS Code's own sandboxed process can reach it; a terminal
you are typing into is not inside that sandbox:

- Windows: `& "$env:USERPROFILE\bin\tfp.cmd" vc workspaces /collection:<the collection URL>`
- Linux: `~/bin/tfp vc workspaces /collection:<the collection URL>`

Both of these are success:
- A message that starts with `No workspace matching` (exit code 1) - this computer has no TFVC workspace yet.
- A table of one or more workspaces (exit code 0) - this computer (or PAT owner) already has a workspace against
  this collection, which is just as valid a result.

Either way, authentication worked. A message starting with `TF30063` means the token is missing,
wrong, or scoped too narrowly (Full access is required) - this is not something to send the human
back to the STOP step for, since an existing PAT file is deliberately left alone there. Instead,
tell the human to renew the token following
[pat.md's Renew section](pat.md#renew-it), wait for them to confirm, then re-run this Verify step.

Then ask the human to open (or reload) VS Code on a folder mapped in a TFVC workspace, and confirm:
- the **Team Explorer** output channel's first line reads `TFVC extension activated (build ...)`
  (after a leading timestamp);
- the Source Control panel shows a **Team Explorer** provider with **Included Changes** / **Excluded
  Changes**.

You cannot see the VS Code window yourself. Do not report the install as finished until the human
confirms these. Full detail, and a troubleshooting table, are in [verify.md](verify.md).

## Also install the tfs-workflow skill

If the human said yes to this in [Ask first](#ask-first), continue now with
[Install the tfs-workflow skill](skill.md), reusing what is already done above - the cloned
repository, the installed wrapper, the saved PAT, and the collection URL. Do not clone the
repository again, and do not ask the human anything this page already asked.

## Report

When everything above is done, tell the human:
- whether this was a fresh install or an update, and what changed;
- what you did: whether TF.exe was already there or Visual Studio was installed; where the wrapper
  ended up (installed, updated, or left alone); that the extension was installed or updated (or
  already current); the exact settings keys and values you wrote (and which ones you left alone
  because they were already set);
- whether you also installed the tfs-workflow skill, and where;
- what still needs them: confirming the VS Code checks above, and anything you stopped and asked
  about that is not yet resolved.
