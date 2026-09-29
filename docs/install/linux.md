# Install on Linux (with Wine)

TF.exe is a Windows program; there is no Linux build. This extension does not ship Microsoft's
files — you copy the Team Explorer folder from your own Visual Studio install and run it under
Wine. You need a Windows machine with Visual Studio
(see [Install Visual Studio](windows.md#1-install-visual-studio)) to get the files from, even
though you do all the actual work here on Linux.

This page is tested on **Fedora 44 with WineHQ 11.0**, against Visual Studio 2022 Community's
Team Explorer. Other distributions have Wine too, but package names and paths for things like
winetricks may differ.

Before you start, [create a Personal Access Token](pat.md).

## 1. Copy Team Explorer off a Windows PC

There is no standalone download of TF.exe: take the whole "Team Explorer" folder from a machine
that has Visual Studio 2022 installed. It is self-contained enough to run elsewhere (roughly
1300 files, ~260 MB).

On the Windows machine (PowerShell):

```powershell
$src = "C:\Program Files\Microsoft Visual Studio\2022\Community\Common7\IDE\CommonExtensions\Microsoft\TeamFoundation\Team Explorer"
Test-Path "$src\TF.exe"        # must be True before you archive it
```

(Adjust `Community` / `2022` in the path for a different edition or Visual Studio version.)

```powershell
tar -c -z -f "$env:USERPROFILE\Desktop\TeamExplorer.tar.gz" -C "$src" .
```

Expected output: nothing — `tar` is silent unless something goes wrong. Transfer the archive to
the Linux machine (`scp`, USB, a shared folder — anything works).

## 2. Install Wine

Either your distribution's `wine` package or a WineHQ build works. This was verified with
WineHQ:

```bash
wine --version    # expect wine-11.0 or newer
```

If you use `winehq-stable` from WineHQ's own repository, note that on some distributions (Fedora
included) the distribution's `winetricks` **package** cannot be installed alongside it, because
it depends on a `wine` package that conflicts with `winehq-stable`. Do not resolve that by
forcing the package manager to remove the conflicting package — that would remove WineHQ's Wine
too. Step 4 installs the `winetricks` script directly instead, which avoids the conflict.

## 3. Unpack Team Explorer to `/opt/teamexplorer`

This is the path the `tfp` wrapper looks for TF.exe in by default (override with the `TF_DIR`
environment variable if you want a different location):

```bash
sudo mkdir -p /opt/teamexplorer
sudo tar -xzf TeamExplorer.tar.gz -C /opt/teamexplorer   # path to wherever you put the archive
sudo chmod -R a+rX /opt/teamexplorer
ls /opt/teamexplorer/TF.exe        # must exist
```

## 4. Create a 64-bit Wine prefix with real .NET Framework 4.8

TF.exe is a 64-bit .NET Framework 4.7.2 application. Wine's built-in Mono runtime is not enough
for it: with Mono, `tf` reaches the server but fails with
`This collection holds request headers and cannot contain the specified response header.` The
real .NET Framework has to be installed, which also removes Wine Mono from the prefix.

The `tfp` wrapper uses `~/.wine-tf` as the Wine prefix by default (override with the `WINEPREFIX`
environment variable):

```bash
sudo dnf install cabextract   # or your distribution's equivalent
mkdir -p ~/bin
curl -L -o ~/bin/winetricks https://raw.githubusercontent.com/Winetricks/winetricks/master/src/winetricks
chmod +x ~/bin/winetricks

export WINEPREFIX=~/.wine-tf WINEARCH=win64
wineboot -i                    # an "err:ole:start_rpcss ..." line here is harmless
~/bin/winetricks -q dotnet48   # 10-20 minutes, several installer windows
```

Verify:

```bash
WINEPREFIX=~/.wine-tf wine uninstaller --list
```

Expected: a line containing **Microsoft .NET Framework 4.8**, and no **Wine Mono Runtime** line.
If Wine Mono is still listed, `dotnet48` did not finish — re-run it without `-q` and read the
installer's own output.

## 5. Save the PAT

If you have not already, [create a Personal Access Token](pat.md) and save it on this machine as
`~/.tfs/pat.txt` (mode 600), the token as the only line. That is the file the `tfp` wrapper reads
by default; override the location with `TFS_PAT_FILE`.

## 6. Get the wrapper scripts

The wrapper scripts are not part of the released `.vsix` — that only contains the packaged
extension. Get them from the source repository instead:

- In a browser: go to <https://github.com/shaxxx/vscode-team-explorer>, click **Code**, then
  **Download ZIP**, and extract it.
- Or from a terminal: `git clone https://github.com/shaxxx/vscode-team-explorer`

The wrapper scripts are in its `wrappers` folder; the commands below (and the Flatpak section
further down) assume you are in that extracted or cloned folder.

## 7. Install the wrapper

```bash
cp wrappers/tfp ~/bin/tfp
chmod +x ~/bin/tfp
grep -q 'HOME/bin' ~/.bashrc || echo 'export PATH="$HOME/bin:$PATH"' >> ~/.bashrc
exec bash          # reload PATH
```

Using zsh instead of bash? Add the same `export PATH=...` line to `~/.zshrc` and run `exec zsh`
instead — or, for another shell, add it to whatever startup file that shell reads and restart it.

Smoke test — this both proves authentication works and shows that this computer has no
workspace yet:

```bash
tfp vc workspaces /collection:https://dev.azure.com/your-org/
```

Expected on a fresh machine: a message like
`No workspace matching *;<your account> on computer <this computer> found ...` — that means
authentication succeeded. A `TF30063` (or a 401) instead means the PAT is wrong, expired, or does
not have the Full access scope; revisit [pat.md](pat.md).

## 8. Create a workspace and map `$/`

Workspaces belong to a computer: the Windows machine from step 1 already has its own, so this
Linux machine needs its own too, even against the same collection. Mirroring the same relative
layout keeps server paths predictable across machines — for example, if Windows maps `$/` to
`C:\work`, map it to `~/work` here.

```bash
mkdir -p ~/work && cd ~/work

tfp vc workspace /new Linux /collection:https://dev.azure.com/your-org/ /location:server
tfp vc workfold /workspace:Linux /collection:https://dev.azure.com/your-org/
```

Expected: `workspace /new` exits 0 with nothing to report on success. It also maps `$/` to the
current directory by itself, which is what the `workfold` command right after it is checking.

`/location:server` matches what the extension itself always passes when it creates a workspace
(only server workspaces are supported); leaving it out would ask tf for its own default instead.

`workfold` should print something like `$/: Z:\home\<user>\work`. If a different mapping was
created, fix it:

```bash
tfp vc workfold /unmap "<the server path it printed>" /workspace:Linux /collection:https://dev.azure.com/your-org/
tfp vc workfold /map "$/" . /workspace:Linux /collection:https://dev.azure.com/your-org/
```

Mapping `$/` downloads nothing by itself. Fetch only the project you need, from `~/work`:

```bash
tfp vc get MyProject /recursive
```

Expected: for each folder it downloads into, a `<local path>:` header line, followed by one
`Getting <name>` line per file.

Inside a mapped folder, `/collection:` is no longer needed — the workspace supplies it.

## 9. Verify

```bash
cd ~/work/MyProject
tfp vc status . /recursive              # "There are no pending changes." on a clean tree
tfp vc workfold .                       # shows the workspace and mapping for this folder
tfp vc checkout <file> && tfp vc undo <file>   # round-trip test
```

Expected for the round trip: both commands exit 0; `checkout` makes `<file>` writable, and `undo`
makes it read-only again and discards the edit (`ls -l <file>` shows the write bit toggle either
way, if you want to confirm it).

This creates a **server** workspace, so files arrive read-only. `tfp vc checkout` makes a file
writable; `tfp vc undo` reverts both the edit and the permission. Never `chmod u+w` a workspace
file instead of checking it out — the edit becomes invisible to TFVC.

## VS Code as a Flatpak

Wine is not available inside the Flatpak sandbox, so `~/bin/tfp` fails there with exit code 127.
Install the Flatpak-aware shim instead, which runs `tfp` on the host through Flatpak's own
`flatpak-spawn --host` (a permission the VS Code Flatpak already has):

```bash
cp wrappers/tfp-flatpak ~/bin/tfp-flatpak
chmod +x ~/bin/tfp-flatpak
```

Then set `teamExplorer.wrapperPath` to the shim's full path (for example
`/home/<user>/bin/tfp-flatpak` — VS Code settings do not expand `~`). This setting is
machine-scoped, so it goes in your User settings, not a workspace's `.vscode/settings.json`.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `This collection holds request headers and cannot contain the specified response header.` | Wine Mono instead of the real .NET Framework | Step 4 (`winetricks -q dotnet48`) |
| Installing `winetricks` fails, complaining about a conflict with `winehq-stable` | WineHQ vs. distribution Wine packaging | Install the `winetricks` script directly (step 4); do not force the conflicting package to install |
| `[tfp] TF.exe not found at: ...` | `TF_DIR` (default `/opt/teamexplorer`) does not have `TF.exe` | Step 1 and 3 |
| `[tfp] Wine prefix not found: ...` | `WINEPREFIX` (default `~/.wine-tf`) does not exist yet | Step 4 |
| `[tfp] PAT file not found or empty: ...` | `~/.tfs/pat.txt` is missing or empty | Step 5 |
| `No workspace matching *;<your account> on computer <this computer> found ...` | This computer has no TFVC workspace yet | Step 8 |
| `TF14061: The workspace <name>;<your account> does not exist.` | Named a workspace that was never created here, or that belongs to another computer | Step 8; check with `tfp vc workspaces /computer:*` |
| `[tfp] PAT file not found or empty: ...` | No token saved yet, or the file is empty | [pat.md](pat.md), save it |
| `TF30063`, `TF400813`, or a 401 | PAT wrong, expired, without Full access, or for another organisation | [pat.md](pat.md), get a new token |
| The command hangs with no output | A bare `tf.exe` call without `/noprompt` is waiting on an invisible sign-in window | Always use `tfp`, never `tf.exe` directly; kill a stuck run with `WINEPREFIX=~/.wine-tf wineserver -k` |
| "The item ... could not be found in your workspace" for a file that exists | TFVC is case-insensitive, Linux file systems are not | Match the server's casing; check with `tfp vc workfold .` |
| TLS/SSL errors reaching the server | Wine is missing GnuTLS | Install your distribution's `gnutls` package |
| Exit code 127 when the extension runs `tfp` from a Flatpak VS Code | Wine is not reachable inside the Flatpak sandbox | Use the `tfp-flatpak` shim above |
| Something is stuck, or the prefix is acting strangely | Stale Wine processes, or a stale workspace cache | `WINEPREFIX=~/.wine-tf wineserver -k`; if that is not enough, delete the cache under `~/.wine-tf/drive_c/users/<user>/AppData/Local/Microsoft/Team Foundation/*/Cache` |

Starting over: `rm -rf ~/.wine-tf` and redo step 4. Workspaces live on the server, so they
survive a prefix rebuild, and the local files under `~/work` are untouched too.

Next: [Install the extension and set it up](vscode.md).

---

Back to the [install guide](README.md).
