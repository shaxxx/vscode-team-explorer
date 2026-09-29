# Installing Team Explorer (TFVC)

[Back to the project readme](../../README.md)

## What you need

- An Azure DevOps Services organisation with a TFVC project. A brand-new organisation does not
  allow TFVC by default: an organisation administrator first has to turn it on under
  **Organization settings -> Repositories**, by turning off the **Disable creation of TFVC
  repositories** option.
- A Personal Access Token (PAT) for that organisation. See [Create a PAT](pat.md).
- VS Code 1.100 or later.
- **On Windows**: Visual Studio 2022, any edition (Community is free). TF.exe ships with every
  edition, and there is no separate component to install or tick. Visual Studio 2019 and Visual
  Studio 2026 also include TF.exe, but only Visual Studio 2022 is tested.
- **On Linux**: Wine, and access to a Windows machine with Visual Studio 2022, to copy the Team
  Explorer folder from (Microsoft's binaries are never shipped with this extension).

## Glossary

- **TFVC** (Team Foundation Version Control) — the older, centralized Microsoft source control
  system this extension supports (not Git).
- **Workspace** / **server workspace** — a named mapping between server folders and a local folder
  on one computer; this extension supports only the **server** kind, where files stay read-only
  until checked out.
- **Mapping** and **`$/` server paths** — a mapping links one server folder to one local folder;
  server paths always start with `$/`, the root of a TFVC project collection.
- **Collection URL** — the address of your Azure DevOps organisation's TFVC collection, for
  example `https://dev.azure.com/your-org/` or the older `https://your-org.visualstudio.com/`.
- **PAT** (Personal Access Token) — the credential this extension uses instead of an interactive
  sign-in; see [Create a PAT](pat.md).
- **The wrapper (`tfp`)** — the small script (`tfp.cmd` on Windows, `tfp` on Linux) that runs
  `TF.exe` with your PAT attached.
- **Wine prefix** (Linux only) — an isolated, self-contained Windows-like environment that Wine
  runs `TF.exe` inside of.
- **`.vsix`** — the packaged file format a VS Code extension installs from.

## How it fits together

```
VS Code extension
  -> tfp wrapper (adds your PAT)
  -> tf.exe (native on Windows, under Wine on Linux) -> Azure DevOps Services
```

The extension never talks to Azure DevOps directly. It runs Microsoft's own `tf.exe` through a
small wrapper script, exactly as if you had typed the command yourself in a terminal.

## Why a wrapper?

Run without credentials, `tf.exe` tries to open an interactive Microsoft-account sign-in window.
Nothing in VS Code can click that window, and under Wine on Linux it just hangs. So every call
goes through a wrapper script (`wrappers/tfp.cmd` on Windows, `wrappers/tfp` on Linux) that adds
`/noprompt /loginType:OAuth /login:.,<PAT>` to the command line itself. The extension never puts
the token on a command line and never logs it; the wrapper is what adds it to each `tf` call, by
reading it from the PAT file (see [Create a PAT](pat.md)). One wrapper serves VS Code, a terminal
and this project's own `tfs-workflow` agent skill alike (see
[Add the AI agent skill](skill.md)) — all three read the same wrapper and the same PAT file, so
the skill never needs a copy of its own. Unlike the extension, the skill always looks for the
wrapper at its default location and does not read `teamExplorer.wrapperPath`, so if you set that
to something other than the default, keep the wrapper at the default location too if you plan to
use the skill as well.

The wrapper contract, the same on both platforms:

1. **What the extension passes.** Only the `tf` command and its arguments (for example `vc status
   . /recursive`) — it never builds or passes any authentication arguments itself.
2. **What the wrapper adds.** The wrapper appends the login arguments on its own,
   `/noprompt /loginType:OAuth /login:.,<PAT>`, reading the token from the PAT file (see
   [Create a PAT](pat.md)).
3. **What comes back.** The wrapper prints nothing of its own to stdout and returns `tf`'s own
   exit code unchanged; anything it needs to say itself goes to stderr, prefixed `[tfp]`, so it is
   never mistaken for `tf`'s own output.
4. **Where the token lives.** In the PAT file — `~/.tfs/pat.txt` on Linux,
   `%USERPROFILE%\.tfs\pat.txt` on Windows, or wherever `TFS_PAT_FILE` points — which is what the
   wrapper reads before every `tf` call. See [Create a PAT](pat.md) for how it gets there, and how
   the extension itself can also read or rewrite it as part of recovering from a rejected token.

## The steps, in order

1. [Create a PAT](pat.md)
2. [Windows](windows.md) or [Linux](linux.md)
3. [Install the extension and set it up](vscode.md)
4. [Check that it works](verify.md)
5. Optional: ask an AI coding agent that supports skills to follow [skill.md](skill.md)

Want an AI coding agent to install or update this for you instead? See
[Let an AI agent do it](agent.md).
