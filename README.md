# Team Explorer (TFVC)

Team Explorer-style TFVC support for VS Code, on Windows and on Linux under Wine.

Not affiliated with or endorsed by Microsoft.

![Pending changes](docs/images/pending-changes.png)

## Features

- [Pending changes](docs/features.md#pending-changes) — Included/Excluded Changes, Check In, Undo, Compare
- [Editing files](docs/features.md#editing-files) — Explorer badges, auto-checkout, Check Out from the editor, Undo/Add/Get Latest from the Explorer menu
- [History and annotate](docs/features.md#history-and-annotate) — the changeset grid, and who changed each line
- [Source Control Explorer](docs/features.md#source-control-explorer) — browse the server tree, Get Specific Version, map, rename, delete
- [Workspaces](docs/features.md#workspaces) — create and map a server workspace, shared with Visual Studio
- [Shelvesets](docs/features.md#shelvesets) — Shelve, Find Shelvesets, Unshelve, Delete
- [Conflicts](docs/features.md#conflicts) — Take Server, Keep Local, auto-merge and manual merge
- [Settings](docs/features.md#settings) — every `teamExplorer.*` setting and the badge colors

See [docs/features.md](docs/features.md) for a full tour with screenshots.

## How it works

This extension drives Microsoft's own `TF.exe` — the command-line client that ships with Visual
Studio — so your workspace, pending changes and shelvesets are exactly what Visual Studio would
show. A small wrapper (`tfp`) appends your saved credentials to every call, so `TF.exe` never shows
an interactive sign-in prompt. On Windows `TF.exe` runs natively from a Visual Studio install; on
Linux it runs under Wine, using a copy of `TF.exe` taken from a Windows machine's Visual Studio.

## Requirements

- VS Code 1.100 or later
- An Azure DevOps Services organisation with a TFVC project, and a Personal Access Token with
  **Full access** scope
- On Windows: Visual Studio 2022 (any edition, including Community), which brings `TF.exe`
- On Linux: Wine with a 64-bit prefix that has .NET Framework 4.8, and the Team Explorer folder
  copied from a Windows machine's Visual Studio 2022 installation (not just `TF.exe`)

Tested on Windows 11 with Visual Studio 2022 and on Fedora 44 with WineHQ 11.0, against Azure
DevOps Services with PAT authentication and server workspaces, with tf output in English or
Croatian. See [docs/manual/limitations.md](docs/manual/limitations.md) for what is untested.

## Install

See the [install guide](docs/install/README.md): create a PAT, install Visual Studio or Wine,
install the extension, and check that it works.

## Install or update with an AI agent

If you use an AI coding agent, you can point it at the install guide written for one:

```
Install or update the Team Explorer (TFVC) extension by following https://github.com/shaxxx/vscode-team-explorer/blob/main/docs/install/agent.md
```

The agent will stop and ask you for anything it cannot do itself — creating and saving your
Personal Access Token, above all. Run it again later to pick up a new release: every step checks
what is already there first, so nothing already set up is disturbed.

### AI agent skill

This repo also has a `tfs-workflow` agent skill, so an AI coding agent can run TFVC commands
itself — checkout, status, get latest, and so on — through the very same wrapper and saved PAT the
extension uses. Like the extension, it never checks in on its own: the only way to check in is
still the extension's own Check In button (or Visual Studio, since the skill can be used without
the extension installed at all).

```
Install or update the tfs-workflow skill by following https://github.com/shaxxx/vscode-team-explorer/blob/main/docs/install/skill.md
```

## Documentation

- [Features](docs/features.md)
- [Install guide](docs/install/README.md)
- [tfs-workflow agent skill](docs/install/skill.md)
- [Manual](docs/manual/README.md)
- [Development](docs/development.md)

## Licence

MIT — see [LICENSE](LICENSE).

## Credits

Icon: [Tabler Icons](https://tabler.io/icons) (MIT). See
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) for full licence texts.
