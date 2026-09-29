---
name: tfs-workflow
description: Manage Team Foundation Server (TFVC) source control against Azure DevOps Services through the shared tfp wrapper and a Personal Access Token. Authenticates non-interactively, checks files out on read-only errors, and never checks in on its own.
allowed-tools: Bash, PowerShell
---

# TFS Workflow Helper

Collection URL: <COLLECTION_URL>

Installing this skill replaces the placeholder above with your Azure DevOps collection URL
(format `https://dev.azure.com/your-org/` or `https://your-org.visualstudio.com/`). If it still
shows the placeholder in angle brackets when you first need it — or if an older installed copy
has no `Collection URL:` line at all — ask the human for their collection URL, then add or
rewrite that line with it, right after the title.

This skill helps you work with Team Foundation Server (TFS/TFVC) source control against Azure
DevOps Services. It authenticates **non-interactively with a Personal Access Token (PAT)** — no
Microsoft login popups, no MFA re-prompts — through a small wrapper script shared with the
"Team Explorer (TFVC)" VS Code extension.

## Authentication — ALWAYS use the `tfp` wrapper, never raw `tf`

Raw `tf.exe` against Azure DevOps Services pops an interactive Microsoft login dialog that **you
cannot see or interact with from the terminal — it will hang**. Instead, use the `tfp` wrapper,
which:

- reads the PAT from `~/.tfs/pat.txt` (`%USERPROFILE%\.tfs\pat.txt` on Windows; override with
  `TFS_PAT_FILE`),
- appends `/noprompt /loginType:OAuth /login:.,<PAT>` to every command.

`/loginType:OAuth` is what makes PAT auth work with the Visual Studio `tf.exe`; `/noprompt` makes
auth failures **error out in the terminal instead of hanging on a popup**.

**How to invoke it** — this is the extension's own default wrapper location, not a copy bundled
with this skill:

- **Windows: run it from PowerShell**, not Bash. If your terminal tool on Windows is Git Bash
  (MSYS), it silently rewrites arguments that look like POSIX paths before a native `.exe` ever
  sees them — verified: `'$/MyProject'` arrives as `'$C:/Program Files/Git/MyProject'`, and a
  bare switch like `/recursive` arrives as `C:/Program Files/Git/recursive`. That breaks server
  paths and switches alike, and can make `vc dir` wrongly report a real file as "not found" (see
  the checkout step below) — which then leads to clearing the read-only bit on a file that
  actually is under TFVC. Use PowerShell:
  `& "$env:USERPROFILE\bin\tfp.cmd" vc <command>`, e.g.
  `& "$env:USERPROFILE\bin\tfp.cmd" vc status /recursive`.
  If only a POSIX shell is available on this Windows machine, prefix **every** `tfp` call with
  `MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'` to stop the rewrite, e.g.
  `MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' "$USERPROFILE/bin/tfp.cmd" vc status /recursive`.
- Linux (bash): `~/bin/tfp vc <command>`, e.g. `~/bin/tfp vc status . /recursive` — ordinary bash
  on Linux does not rewrite arguments this way, so no extra flags are needed there.

The rest of this skill writes just `tfp` for brevity — it always means the full command above
(PowerShell on Windows, `~/bin/tfp` on Linux); `tfp` alone is not on `PATH` by default.

If the wrapper is not at that path, **stop** and point the human at
`https://github.com/shaxxx/vscode-team-explorer/blob/main/docs/install/skill.md` — do not guess
at another location, and do not fall back to raw `tf`.

### One-time PAT setup (per user / per machine)

1. Create a PAT at `<the collection URL>_usersSettings/tokens` → **New Token** → scope
   **Full access**. (`tf.exe` talks to older SOAP endpoints that reject a narrower
   **Code (Read & Write)** token with error `TF30063`; **Full access** is the scope that actually
   works.) Pick a long expiry.
2. Save the token as the only line of `~/.tfs/pat.txt` (`%USERPROFILE%\.tfs\pat.txt` on Windows),
   UTF-8, no BOM, no trailing blank lines — or run the VS Code command **Team Explorer: Set
   Personal Access Token**, which writes the same file. Never ask the human to paste the token
   into chat, and never put it on a command line.
3. Verify: `tfp vc workspaces /collection:<the collection URL>`. Either outcome below means
   authentication works, with no popup:
   - a table of workspaces, exit code 0; or
   - a message starting `No workspace matching ...`, exit code **1** — this is normal when the
     account has no workspace on this collection yet, not a failure.

   A message starting `TF30063` means the token is wrong, expired, not scoped to **Full access**,
   or created for a different organisation — the human needs to renew it, see
   `https://github.com/shaxxx/vscode-team-explorer/blob/main/docs/install/pat.md#renew-it`.

## Core Workflow

When editing files under TFVC:

1. **Attempt to edit the file** normally.
2. **If you get a read-only / "not checked out" error**: check it out, then edit.
   ```
   tfp vc checkout <filepath>
   ```
   - If checkout fails with *"could not be found in your workspace"*, don't assume it's a
     local-only file yet — confirm it properly:
     1. Run `tfp vc workfold <the file's folder>` to get the real server path for that folder
        from the mapping it prints (don't guess at the `$/...` path).
     2. Run `tfp vc dir "<that server path>" /collection:<the collection URL>` (always pass
        `/collection:`, so the check can't accidentally target the wrong collection).
     3. Only if the output is exactly **"No items match"** is the file confirmed **not under
        TFVC** — clear the read-only attribute and edit it directly, no checkout needed.
     4. **Any other outcome — a different error, no output, a network/auth failure — means
        stop and ask the human.** Do not clear the read-only attribute on the strength of an
        unclear result; on Linux in particular, a real tracked file can produce this same
        "could not be found in your workspace" message purely from a path-casing mismatch
        (TFVC is case-insensitive, Linux file systems are not — see
        `https://github.com/shaxxx/vscode-team-explorer/blob/main/docs/install/linux.md`,
        the case-insensitivity row of the troubleshooting table), which this check rules out
        before you touch the file's permissions.
3. **Edit the file**: make your changes.
4. **Build**: verify the changes compile. A newly created file needs to be in the Visual Studio
   solution first — see New File Workflow below.
5. **Test**: run relevant unit tests (**NEVER** integration tests).
6. **Check-in**: the **user** performs check-in manually when ready — never you (see Critical
   Constraints).

## TF Command Reference (run via `tfp vc`)

| Command | Description |
|---------|-------------|
| `tfp vc checkout <file>` | Check out a file for editing |
| `tfp vc status [/recursive]` | Check pending changes in the workspace |
| `tfp vc undo <file>` | Undo a checkout, discarding its pending change — **only for a checkout you made yourself**; it discards whatever is pending on the file, including a human's unsaved change, so ask first if you didn't make the change |
| `tfp vc add <file>` | Add a new file to TFVC |
| `tfp vc get <path> /recursive` | Get the latest version of a folder from the server — always name the folder; a bare `tfp vc get` with no path fetches the **entire workspace** (possibly the whole collection) |
| `tfp vc diff <file>` | View differences between versions |
| `tfp vc workfold` | Show workspace → local folder mappings |
| `tfp vc dir "$/MyProject"` | List what the server has under a path |
| `tfp vc workspaces /collection:<url>` | List workspaces (good auth test) |

## Windows and Linux

Same commands, same rules, on both. The only difference is what the wrapper runs underneath:

- **Windows**: `tfp.cmd` finds `TF.exe` from a Visual Studio install (via `vswhere`, or the
  `TF_EXE` override) and runs it directly. Run it from PowerShell, not Bash — see Authentication
  above for why.
- **Linux**: `tfp` runs the same Windows `TF.exe` under **Wine**, from `TF_DIR` (default
  `/opt/teamexplorer`) inside the Wine prefix `WINEPREFIX` (default `~/.wine-tf`, which needs the
  real .NET Framework 4.8 — Wine's built-in Mono does not work). Normal Linux paths work in
  commands: the wrapper converts an absolute path that exists into the Windows form `TF.exe`
  expects. Quote server paths, e.g. `"$/MyProject"` (as in the examples throughout this skill) —
  not because bash would expand `$/` (it doesn't; `$` only starts an expansion before a name,
  `{`, `(`, or a special parameter character, and `/` is none of those), but so the whole path
  stays one argument if it contains spaces. If a run looks stuck,
  `WINEPREFIX=~/.wine-tf wineserver -k` kills it.

Full setup (Wine prefix, .NET Framework, workspace mapping, a troubleshooting table) is at
`https://github.com/shaxxx/vscode-team-explorer/blob/main/docs/install/linux.md`.

## Error Handling

### Read-Only File Error

**Symptom**: editing fails with a permission/read-only error.

**Solution**: if the file is under TFVC, check it out (`tfp vc checkout <file>`). If checkout
reports the item isn't in your workspace, confirm it properly before touching its permissions —
see Core Workflow step 2 above (`workfold` + `vc dir /collection:` + the exact "No items match"
check) — and only then clear the read-only attribute and edit directly.

### Authentication errors (TF30063 / TF400813 / 401 Unauthorized)

**Cause**: the PAT is missing, empty, expired, or scoped too narrowly.

**Solution — ask the human to refresh the PAT** (you cannot do this yourself):

1. Tell them: *"Your Azure DevOps PAT is missing, expired, or doesn't have the right scope.
   Please create a new one at `<the collection URL>_usersSettings/tokens` (scope: **Full
   access**) and save it as the only line of `~/.tfs/pat.txt` — or run **Team Explorer: Set
   Personal Access Token**."* Details:
   `https://github.com/shaxxx/vscode-team-explorer/blob/main/docs/install/pat.md#renew-it`.
2. Once they confirm, re-run the `tfp` command.

Because the wrapper uses `/noprompt`, these failures return promptly with an error — they do
**not** hang. Never fall back to raw `tf` to "fix" auth; that reintroduces the popup.

## Critical Constraints

1. **NEVER check in automatically.** Do not run `tfp vc checkin` / `tf checkin` under any
   circumstances — check-in is always a manual action by the user. In VS Code, with the
   "Team Explorer (TFVC)" extension installed, the only way to check in is its **Check In**
   button; there is no command-line or scripted path.
2. **Always use the `tfp` wrapper**, never raw `tf.exe` / `wine tf.exe` (a raw call triggers the
   hanging popup).
3. **Never clear a workspace file's read-only bit (or `chmod`) instead of checking it out** — the
   edit becomes invisible to TFVC. Clearing it directly is only correct for a file confirmed
   **not** to be under TFVC (see Error Handling above).
4. **Visual Studio Solution**: files must be in the VS solution for proper building.
5. **Testing**: run relevant unit tests, but **NEVER** integration tests.
6. **Workspaces are per machine.** Don't touch a workspace that belongs to a different computer
   than the one you're running on.

## New File Workflow

When creating new files that belong in source control:
1. Create the file in the appropriate location.
2. Add to TFVC: `tfp vc add <newfile>`
3. Include the file in the Visual Studio Solution.
4. The user will check in when ready.

## The VS Code extension

The "Team Explorer (TFVC)" VS Code extension uses this same `tfp` wrapper and the same PAT file.
In VS Code, checking in is only ever done through its **Check In** button — nothing automated
there either.

## When This Skill Activates

This skill automatically activates when:
- Edit operations fail with permission/read-only errors
- You mention TFS, TFVC, checkout, or related terms
- Working in directories under TFVC source control
- You need guidance on TF commands or Azure DevOps authentication
