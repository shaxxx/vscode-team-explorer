# Install the tfs-workflow agent skill

[Back to the install guide](README.md)

This page is written for an AI coding agent installing (or updating) the `tfs-workflow` skill on
a human's behalf - not for a person reading along. The skill lets an AI agent run TFVC commands
itself - checkout, status, get latest, and so on - through the same `tfp` wrapper and the same
saved PAT that the Team Explorer (TFVC) VS Code extension uses. If the extension is not installed
yet either, [agent.md](agent.md) does that, and offers to install this skill as its last step -
you can follow that page instead and skip this one.

## Rules

- **Never** ask the human to paste their personal access token into chat, and never put it on a
  command line. The human creates and saves the token themselves, at the STOP point below - never
  you. Never read or print the contents of the PAT file yourself.
- **Never** run `tf vc checkin`, or anything that checks changes in. The only way to check in in
  this project is the VS Code extension's own **Check In** button and its confirmation dialog; an
  agent must never create another path to it. The skill you are installing carries this same rule.
- **Never** clear a workspace file's read-only bit directly (`chmod`, `attrib -r`) to edit it. Use
  `tf checkout` (through the wrapper) instead.
- **Stop and ask the human** at every point marked STOP below.

## 1. Get the repo

- With `git` (Windows):
  ```powershell
  Remove-Item -Recurse -Force "$env:TEMP\vscode-team-explorer" -ErrorAction SilentlyContinue
  git clone --depth 1 https://github.com/shaxxx/vscode-team-explorer "$env:TEMP\vscode-team-explorer"
  ```
- With `git` (Linux):
  ```bash
  rm -rf /tmp/vscode-team-explorer
  git clone --depth 1 https://github.com/shaxxx/vscode-team-explorer /tmp/vscode-team-explorer
  ```
  The delete first is needed if you are running this page again (an update): `git clone` refuses
  to clone into a folder that already exists and is non-empty.
- Without `git`, download and expand the ZIP instead - `-Force` / `-o` overwrite files left over
  from an earlier run, the same reason as above:
  - Windows: `Invoke-WebRequest -Uri "https://github.com/shaxxx/vscode-team-explorer/archive/refs/heads/main.zip" -OutFile "$env:TEMP\vte.zip"` then `Expand-Archive -Path "$env:TEMP\vte.zip" -DestinationPath "$env:TEMP" -Force`.
  - Linux: `curl -fsSL -o /tmp/vte.zip "https://github.com/shaxxx/vscode-team-explorer/archive/refs/heads/main.zip"` then `unzip -q -o /tmp/vte.zip -d /tmp`.

  A ZIP lands under a `vscode-team-explorer-main` folder (note the `-main` suffix) instead of
  `vscode-team-explorer` - adjust the paths below to match whichever you used. The rest of this
  page assumes `$env:TEMP\vscode-team-explorer` (Windows) / `/tmp/vscode-team-explorer` (Linux).

Expected: no error, exit code 0.

## 2. Check the wrapper

The skill calls the same wrapper the extension uses, at its default path: `~/bin/tfp.cmd` on
Windows, `~/bin/tfp` on Linux.

- **Missing entirely** (Wine, TF.exe, or the wrapper file itself is not there yet): **STOP** here
  and follow [agent.md](agent.md)'s [Windows steps](agent.md#windows-steps) or
  [Linux steps](agent.md#linux-steps) instead - they are not repeated on this page. You already
  have the repository from step 1: skip agent.md's own download step and use that copy. Steps
  there that find something already in place (Visual Studio, TF.exe, Wine) are quick checks.
  Come back to step 3 once the wrapper file exists - check with
  `Test-Path "$env:USERPROFILE\bin\tfp.cmd"` (Windows) or `test -f ~/bin/tfp && echo present`
  (Linux). "Works" here just means the file is in place - it cannot actually authenticate yet,
  since that needs the PAT from step 3.
- **Present**: compare it with this release's copy before touching anything - by hash, not with
  the bare `fc` command: in PowerShell that name is an alias for `Format-Custom`, a completely
  different cmdlet, and errors out on two file paths.
  - Windows:
    ```powershell
    (Get-FileHash "$env:USERPROFILE\bin\tfp.cmd").Hash -eq (Get-FileHash "$env:TEMP\vscode-team-explorer\wrappers\tfp.cmd").Hash
    ```
  - Linux: `diff -u ~/bin/tfp /tmp/vscode-team-explorer/wrappers/tfp`
  - Windows `True`, or Linux no output (exit code 0): already up to date - leave it alone.
  - Windows `False`, or Linux any diff output: **STOP**. This may be the human's own copy, an
    older one, or even the same text saved with the wrong line endings (a text-mode compare would
    call that identical, but `tfp.cmd` needs CRLF). On Windows, show the human both files with
    `fc.exe /b "$env:USERPROFILE\bin\tfp.cmd" "$env:TEMP\vscode-team-explorer\wrappers\tfp.cmd"`
    (the `.exe` bypasses the `Format-Custom` alias); on Linux, show them the diff already printed.
    Ask before replacing it - only overwrite it if they say yes.

## 3. Check the PAT

Default file: `~/.tfs/pat.txt` on Linux, `%USERPROFILE%\.tfs\pat.txt` on Windows - or wherever
the `TFS_PAT_FILE` environment variable points, if it is set. Check only that the file exists and
is non-empty; never open or print its contents.

- Windows (PowerShell):
  ```powershell
  $f = if ($env:TFS_PAT_FILE) { $env:TFS_PAT_FILE } else { "$env:USERPROFILE\.tfs\pat.txt" }
  (Test-Path $f) -and ((Get-Item $f).Length -gt 0)
  ```
- Linux (bash): `test -s "${TFS_PAT_FILE:-$HOME/.tfs/pat.txt}" && echo present`

If it is missing or empty, **STOP** and relay this to the human, essentially word for word - do
not create, request, or type the token yourself:

> Create a Personal Access Token in Azure DevOps: open your user settings (top right) -> **Personal
> access tokens** -> **New Token**. Pick the organisation, set an expiry you are comfortable with,
> and under **Scopes** choose **Full access** - a narrower scope such as Code (Read & Write) is
> rejected by `tf.exe` with error TF30063. Select **Create** and copy the token; it will not be
> shown again.
>
> Save it yourself, one of two ways - never paste it into this chat, and please don't ask me to
> run either of these for you:
> - If the Team Explorer (TFVC) VS Code extension is installed, run **Team Explorer: Set Personal
>   Access Token** from its Command Palette and paste the token into the box it opens.
> - Or save it as the only line of `~/.tfs/pat.txt` (Linux) / `%USERPROFILE%\.tfs\pat.txt`
>   (Windows), as UTF-8 with **no byte-order mark**. See
>   https://github.com/shaxxx/vscode-team-explorer/blob/main/docs/install/pat.md for exact
>   commands.
>
> Tell me only when it is done.

Wait for their confirmation before continuing.

## 4. Find the collection URL

**Updating an already-installed copy of this skill** (see step 5) that has a real value on its
`Collection URL:` line - not the literal placeholder `<COLLECTION_URL>`, and not a copy so old it
has no such line at all: read that value and reuse it as-is. Skip the rest of this step. Any other
case (nothing installed yet, or an installed copy whose placeholder was never filled in) counts as
a first install - follow the rest of this step instead.

**Installing for the first time**: find the collection URL instead of guessing it, using the
wrapper and the PAT from steps 2 and 3. Run this with no `/collection` argument, from a folder
that is not inside any TFVC workspace (for example the home folder):

- Windows: `& "$env:USERPROFILE\bin\tfp.cmd" vc workspaces`
- Linux: `~/bin/tfp vc workspaces`

Always run the real wrapper here, even if the Flatpak shim is also installed - `tfp-flatpak` only
makes sense run *from inside* a Flatpak-sandboxed VS Code, where Wine is unreachable; a terminal
session you are running commands in yourself is not that sandbox, so `~/bin/tfp` is always correct
here. Never run `tf.exe` directly for this either - without the wrapper's login arguments it can
hang on an invisible sign-in window. Do not read tf's own cache file directly either; its location
and format vary with the tf version and, on Linux, the Wine prefix.

Expected: exit code 0. When the local cache knows about one or more collections, the output is
grouped under header lines like:

```
Collection: https://your-org.visualstudio.com/
```

(one per collection, each followed by a Workspace/Owner/Computer/Comment table - empty tables are
fine, only the header lines matter here). Collect the distinct `Collection:` URLs:

- **One URL**: ask "Use `<url>` as your collection URL?" and wait for a yes.
- **Several URLs**: list them plus an "another URL" option, and ask the human to pick.
- **None listed, or the command fails**: ask the human to type their collection URL directly (for
  example `https://dev.azure.com/your-org/` or `https://your-org.visualstudio.com/`).

Whichever way you got it, make sure the URL ends with a trailing `/` before writing it anywhere -
add one if it is missing. A URL typed by a human easily omits it, but the installed skill builds
`<the collection URL>_usersSettings/tokens` directly onto the end of it, which only comes out
right with the slash there.

This list is only a suggestion from a local cache - it can include a deleted workspace or an old
organisation, and a brand new machine (or a fresh Wine prefix) has no cache at all, so the human
always types it there. Always let the human confirm or override the choice; never pick silently.
A PAT that does not match the collection it is used against shows up later, in step 7, as a
`TF30063` error.

## 5. Copy the skill into your own skills directory

The skill folder holds exactly one file, `SKILL.md` - so copy that one file, not the folder
itself. Copying the folder with a recursive copy (`Copy-Item -Recurse`, `cp -r`) onto a
`tfs-workflow` folder that already exists nests it into `tfs-workflow/tfs-workflow/SKILL.md`
instead of replacing `tfs-workflow/SKILL.md`, leaving the old copy the one actually in effect.

Your own skills directory - this page does not name one, since it depends on which agent you are
and how you are configured, and you already know where you look for your own skills:

- **Nothing installed there yet**: create a `tfs-workflow` folder in it, then copy
  `skills/tfs-workflow/SKILL.md` from the clone (step 1) into it as `tfs-workflow/SKILL.md`.
- **`tfs-workflow` already installed there**: tell the human that any edits they made to their
  installed `SKILL.md` will be replaced by this release's version, and ask before overwriting it.
  Once they agree, copy `skills/tfs-workflow/SKILL.md` from the clone directly over the existing
  `tfs-workflow/SKILL.md` - a plain file copy, not a folder copy. Only the `Collection URL:`
  line's value is preserved (via step 4); nothing else the human may have edited is.

### An older, self-contained copy

Some installed copies predate this shared wrapper: instead of a `Collection URL:` line (the
organisation URL is written into their prose instead), they carry their own wrapper, at
`scripts/tfp.cmd` (Windows) or `scripts/tfp` (Linux) next to their `SKILL.md`, and that `scripts`
folder is often on the human's own PATH, so a plain `tfp` in a terminal runs it. Check for this in
the folder you are updating (sibling of `SKILL.md`):

- Windows: `Test-Path "<installed tfs-workflow folder>\scripts\tfp.cmd"`
- Linux: `test -f "<installed tfs-workflow folder>/scripts/tfp" && echo present`

If it is there, **STOP** and ask the human before touching the PATH or that file. The `SKILL.md`
copy above already replaces only that one file, so left alone, the old wrapper and its PATH entry
would keep working - which is exactly the problem: a terminal `tfp` would keep running an old,
unmaintained copy instead of the shared one this page just installed for the skill itself. Once
they agree, do both of the following:

1. **Point the PATH at the shared wrapper instead of the old one.** Replace the old `scripts`
   folder's entry with the shared wrapper's folder (`%USERPROFILE%\bin` on Windows, `~/bin` on
   Linux), keeping every other entry in the same order.
   - Windows (PowerShell) - read, edit and write back the *User* PATH; never `setx`, which
     silently truncates it past 1024 characters:
     ```powershell
     $old = [Environment]::GetEnvironmentVariable('Path', 'User')
     $new = ($old -split ';' | ForEach-Object { if ($_ -ieq $scriptsDir) { "$env:USERPROFILE\bin" } else { $_ } }) -join ';'
     [Environment]::SetEnvironmentVariable('Path', $new, 'User')
     ```
     (`$scriptsDir` is the old `scripts` folder's full path, from the check above.)
   - Linux: find the line in `~/.bashrc` (or `~/.zshrc`, if that is the human's shell) that adds
     the old `scripts` folder to `PATH`, and edit it to add `~/bin` instead.
   - Either way, tell the human to open a new terminal afterwards - the change only applies there.
2. **Replace the old wrapper file with a small forwarder**, so anything that still calls it by its
   old path keeps working instead of silently running an unmaintained copy:
   - Windows, `scripts\tfp.cmd` (CRLF line endings - a batch file needs them):
     ```powershell
     $lines = @(
       '@echo off',
       'REM Forwarder: the tfp wrapper now lives in %USERPROFILE%\bin, shared with the VS Code extension.',
       '"%USERPROFILE%\bin\tfp.cmd" %*',
       'exit /b %ERRORLEVEL%'
     )
     [IO.File]::WriteAllText("$scriptsDir\tfp.cmd", ($lines -join "`r`n") + "`r`n", [Text.Encoding]::ASCII)
     ```
   - Linux, `scripts/tfp` (made executable):
     ```bash
     cat > "$scripts_dir/tfp" <<'EOF'
     #!/bin/sh
     exec "$HOME/bin/tfp" "$@"
     EOF
     chmod +x "$scripts_dir/tfp"
     ```

Mention this in the step 8 report either way: whether an older self-contained copy was found, and
if so, whether the human agreed to have the PATH and the old wrapper file updated.

## 6. Write the collection URL

In the copy you just installed, replace the line

```
Collection URL: <COLLECTION_URL>
```

with

```
Collection URL: <the URL from step 4>
```

This is the only place the URL is written; every other instruction in the skill says "the
collection URL" instead of repeating it. If you ever open an installed copy of this skill and its
`Collection URL:` line still reads the literal placeholder `<COLLECTION_URL>`, ask the human for
the URL at that point and write it here in the same way.

## 7. Verify

Run a read-only command with the wrapper's full path and the URL from step 4 - always the real
wrapper, even if the Flatpak shim is also installed (it only makes sense run from inside a
Flatpak-sandboxed VS Code, not from a terminal you are typing into yourself):

- Windows: `& "$env:USERPROFILE\bin\tfp.cmd" vc workspaces /collection:<the collection URL>`
- Linux: `~/bin/tfp vc workspaces /collection:<the collection URL>`

Both of these are success:
- A message starting with `No workspace matching` (exit code 1) - this computer has no TFVC workspace yet.
- A table of one or more workspaces (exit code 0) - this computer (or PAT owner) already has a workspace against
  this collection, which is just as valid a result.

A message starting with `TF30063` means the PAT and the collection URL do not match each other, or
the token is missing, wrong, or scoped too narrowly (Full access is required). This is not
something step 3 will catch by re-running it - a PAT file that already exists there is treated as
fine, whether or not it still works. Instead, tell the human either to renew the token following
https://github.com/shaxxx/vscode-team-explorer/blob/main/docs/install/pat.md#renew-it, or, if the
URL might be the mismatched half, to re-pick the collection URL by going back to
[step 4](#4-find-the-collection-url); wait for them to confirm, then re-run this step.

## 8. Report

Tell the human:
- whether this was a fresh install or an update, and what (if anything) you asked them to confirm
  along the way;
- where the skill folder ended up;
- the collection URL now written into it;
- whether an older, self-contained copy (with its own `scripts/tfp` wrapper) was found in step 5,
  and if so, whether the PATH and the old wrapper file were updated to point at the shared one;
- the result of the step 7 verification;
- anything you stopped and asked about that is not yet resolved.
