# CLAUDE.md

VS Code extension giving Team Explorer-style TFVC support, on Windows (Visual Studio's `TF.exe`) and on
Linux (the same `TF.exe` under Wine). Not affiliated with Microsoft.

## Start here

1. [README.md](README.md): what it does.
2. [docs/development.md](docs/development.md): build, test, package, architecture, the decisions and why,
   and the tf and Wine behaviour that matters.
3. If `LOCAL.md` exists, read it: it describes THIS machine's environment (collections, wrapper paths,
   other machines). It is git-ignored and must never be committed.

[skills/tfs-workflow/SKILL.md](skills/tfs-workflow/SKILL.md) is an AI agent skill shipped with the repo (not
in the .vsix). It uses the same `tfp` wrapper and PAT file as the extension; its install and update page is
[docs/install/skill.md](docs/install/skill.md).

## Hard rules

- **Nothing may ever check in automatically.** `tf vc checkin` has exactly one call site, reachable only
  from the Check In button's confirm dialog (`checkinCallSite.test.ts` pins it). No command-palette entry,
  no keybinding, no exported API, no watcher/timer/save-handler path.
- **The extension never embeds a PAT** and never constructs auth arguments. It spawns the `tfp` wrapper,
  which appends credentials itself. This keeps the token out of the logs.
- **Never `chmod u+w` (or `attrib -r`) a TFVC workspace file** instead of checking it out: the edit
  becomes invisible to TFVC.
- Do not disturb Visual Studio's view of a workspace, or another machine's workspace.
- Stage explicit paths when committing; never `git add -A` or `git add .`.

## Architecture invariant

Only `src/tf/TfClient.ts` knows that `tf` exists. Only `src/tf/PathMapper.ts` knows that Wine exists.
Everything above them is platform-blind. `TfClient`, `PathMapper`, `parse*`, `strings` and `wrapperPath`
do not import `vscode` (`pureModules.test.ts`) and are unit-testable with no network and no workspace.

## Commands

`npm ci` · `npm run typecheck` · `npm run build` · `npx vitest run` · `npm run package`

## Language

Code comments and UI strings: English. All user-visible strings live in `src/tf/strings.ts`.
