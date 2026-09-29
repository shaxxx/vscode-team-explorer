# Install on Windows

TF.exe (the command-line client this extension drives) is not something we can ship: it belongs
to Visual Studio. This page gets it onto your machine and proves it can talk to your Azure DevOps
organisation, before you install the VS Code extension itself.

Before you start this page, [create a Personal Access Token](pat.md) — the terminal test at the
end needs it.

## 1. Install Visual Studio

Install Visual Studio 2022, any edition — Community is free, at
<https://visualstudio.microsoft.com/downloads/>.

TF.exe comes with every Visual Studio 2022 installation. There is no separate component to
tick during setup: it belongs to the core editor, which every installation includes.

This extension is tested with Visual Studio 2022. Visual Studio 2019 and Visual Studio 2026
also install TF.exe in the same place, but have not been tested with this extension.

## 2. Find TF.exe

TF.exe lives at:

```
<Visual Studio install>\Common7\IDE\CommonExtensions\Microsoft\TeamFoundation\Team Explorer\TF.exe
```

For a default Visual Studio 2022 Community install, that is usually:

```
C:\Program Files\Microsoft Visual Studio\2022\Community\Common7\IDE\CommonExtensions\Microsoft\TeamFoundation\Team Explorer\TF.exe
```

You do not need to find it by hand — the wrapper you install below does that for you, with its
own `vswhere` search. Optional: run the same search yourself now, just to confirm Visual Studio is
where the wrapper will expect it:

```powershell
& "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe" -nologo -sort -products * -version "[17.0,18.0)" -find "Common7\IDE\CommonExtensions\Microsoft\TeamFoundation\Team Explorer\TF.exe"
```

Expected output: one line, a path ending in `TF.exe`, for example:
```
C:\Program Files\Microsoft Visual Studio\2022\Community\Common7\IDE\CommonExtensions\Microsoft\TeamFoundation\Team Explorer\TF.exe
```
If it prints nothing, that is not itself a problem — the wrapper's own fallback search (no version
restriction) may still find an older or newer Visual Studio.

The wrapper's search order:

1. If the `TF_EXE` environment variable is set, it is used as-is — no search.
2. Otherwise, `vswhere` looks for a Visual Studio 2022 installation (version range `[17.0,18.0)`)
   that has `TF.exe` under `Common7\IDE\CommonExtensions\Microsoft\TeamFoundation\Team Explorer`.
3. If none is found, `vswhere` looks again with no version restriction, so an older or newer
   Visual Studio is still picked up.
4. If that still finds nothing, the wrapper stops with an error telling you to install Visual
   Studio with Team Explorer, or set `TF_EXE`.

## 3. Get the wrapper scripts

The wrapper scripts are not part of the released `.vsix` — that only contains the packaged
extension. Get them from the source repository instead:

- In a browser: go to <https://github.com/shaxxx/vscode-team-explorer>, click **Code**, then
  **Download ZIP**, and extract it.
- Or from a terminal: `git clone https://github.com/shaxxx/vscode-team-explorer`

The wrapper scripts are in its `wrappers` folder; `cd` into the folder that directly contains
`wrappers` before running the commands below:

- After **Download ZIP**, Windows Explorer's **Extract All** creates a folder named after the zip
  and puts the archive's contents inside it — the repository's own top level is already called
  `vscode-team-explorer-main`, so you can end up with it nested twice, for example
  `vscode-team-explorer-main\vscode-team-explorer-main`. `cd` into whichever one directly contains
  `wrappers`:
  ```powershell
  cd $env:USERPROFILE\Downloads\vscode-team-explorer-main
  ```
  (adjust the path to wherever you extracted it, and add the second `vscode-team-explorer-main` if
  Explorer nested it twice).
- After `git clone`, the folder is named `vscode-team-explorer`, with no nesting:
  ```powershell
  cd vscode-team-explorer
  ```

Check you're in the right place before continuing — this should list `tfp.cmd`:
```powershell
Get-ChildItem wrappers
```

Do not save `tfp.cmd` on its own from GitHub's single-file "Raw" view (for example with a
right-click "Save As" on the raw text page). That serves the file with LF line endings, and a
Windows batch file needs CRLF (see the repository's `.gitattributes`). Downloading the ZIP or
using `git clone` gives you the correct CRLF version.

## 4. Install the wrapper

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\bin" | Out-Null
copy wrappers\tfp.cmd $env:USERPROFILE\bin\
```

`%USERPROFILE%\bin\tfp.cmd` is where the extension looks for the wrapper by default. Add
`%USERPROFILE%\bin` to your `PATH` too, so you can run `tfp` directly in a terminal:

```powershell
[Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path', 'User') + ";$env:USERPROFILE\bin", 'User')
```

Expected output: nothing on success. Close this terminal and open a new one — the change only
takes effect in new terminals (a new terminal's `Get-Command tfp` should then resolve). Do not
use `setx` for this: it silently truncates the `PATH` value if the result would be longer than
1024 characters.

If `vswhere` cannot find your Visual Studio install (for example, a custom install location, or
more than one Visual Studio on the machine), set `TF_EXE` to the full path of `TF.exe` from step
2, and the wrapper uses that instead of searching.

## 5. Test it in a terminal

With your [PAT](pat.md) saved and the wrapper installed, open a new terminal and run this with
your own [collection URL](README.md#glossary):

```powershell
tfp vc workspaces /collection:https://dev.azure.com/your-org/
```

(replace `your-org` with your own organisation.)

| Output | Meaning |
|---|---|
| A message like `No workspace matching *;<your account> on computer <this computer> found ...` (exit code 1) | Authentication worked — this computer just does not have a TFVC workspace yet, which is expected before you have created one. |
| A table listing one or more workspaces (exit code 0) | Authentication also worked — this computer (or PAT owner) already has a workspace against this collection, which is just as valid a result. |
| `[tfp] PAT file not found: ...` or `[tfp] PAT file is empty: ...` | `pat.txt` itself is missing or empty — this is the wrapper's own message. Revisit [pat.md](pat.md). |
| `TF30063` | The token is wrong, expired, or does not have the Full access scope. Revisit [pat.md](pat.md). |

Next: [Install the extension and set it up](vscode.md).

---

Back to the [install guide](README.md).
