# Developing Team Explorer (TFVC)

## What this is

Team Explorer (TFVC) is a VS Code extension that gives Team Explorer-style TFVC support:
pending changes, checkout/undo/get, history and annotate, a Source Control Explorer, shelvesets
and conflict resolution. It drives TFVC only by spawning Microsoft's `tf.exe` through a small
wrapper script — native on Windows, and under Wine on Linux. It is not affiliated with Microsoft.

## Build, test, package, release

```
npm ci
npm run typecheck
npm run build          # esbuild -> dist/extension.js
npx vitest run          # also: npm test
npm run package         # build + scripts/package.mjs -> the .vsix
```

Development needs **Node 22**: `vitest` 5 requires Node `^22.12.0` (or `^24`/`>=26`), `@vscode/vsce`
4 requires Node `>=22`, and CI runs on Node 22.

`vitest run` must pass on both Windows and Linux; CI runs both (see `.github/workflows/ci.yml`).
See "Testing lessons" below for what Linux runs have found.
`test/unit/packaging.test.ts` inspects the real `dist/` tree against `.vscodeignore`, so it needs a
build first: without one it fails the assertion `run 'node esbuild.mjs' first - this test inspects
the real tree` (or a plain ENOENT reading `dist/`, in a completely fresh clone that was never
built).

`npm run package` builds, then runs `scripts/package.mjs`, which calls `vsce package
--no-dependencies` with `--readme-path docs/features.md` (the Marketplace/Details-tab readme
lives outside the repo root) and `--baseContentUrl` / `--baseImagesUrl` pointed at
`https://github.com/shaxxx/vscode-team-explorer/blob(or raw)/v<version>/docs` — so the Details
tab's relative links and images resolve against the tag being released, not against `main`. That
means the tag (with its images) has to exist on GitHub before or at the same time as the release;
publishing the `.vsix` from a tag whose images have not been pushed yet leaves broken images in
the Details tab.

**Running it (F5).** `.vscode/launch.json` has two configurations, both of which ask you to *type*
a folder path (a VS Code `${input:...}` text prompt, not a folder-picker dialog) when you start
debugging:

- **Run Extension** — a normal Extension Development Host against the folder you typed.
- **Run Extension (deliberately bad PAT)** — the same, but with `TFS_PAT_FILE` pointed at a temp
  file you create yourself with a syntactically plausible but invalid token. It shows the
  rejected-token error path without ever touching your real PAT file.

**Making a release:**

1. Bump the version in `package.json` and add its entry to `CHANGELOG.md`.
2. `npm run package` to build the `.vsix`.
3. Tag the release, `v<version>`.
4. Push the tag (its `docs/` images are what the Details tab's `--baseImagesUrl` points at).
5. `gh release create v<version> <vsix-path> --notes-file <file with that version's CHANGELOG entry>`.

## Architecture

The layers, bottom to top:

- **`src/tf/TfClient.ts`** — the only file that knows `tf.exe` exists and actually spawns the
  wrapper (sixteen other files build the `['vc', ...]` argument lists that flow through it).
  Captures raw `Buffer`s, classifies errors, enforces the safety guards described below.
- **`src/tf/PathMapper.ts`** — the only file that knows Wine exists. Translates between an
  editor's local path, tf's `Z:\...` view of that path under Wine, and TFVC's `$/...` server
  path.
- **The `parse*` modules** (`parse.ts`, `parseDir.ts`, `parseGet.ts`, `parseHistory.ts`,
  `parseInfo.ts`, `parseReconcile.ts`, `parseResolve.ts`, `parseShelvesets.ts`,
  `streamedGet.ts`) — turn tf's XML or text output into typed objects. Nothing here imports
  `vscode`.
- **Services**, one per area: `TfvcService` (pending changes, the status cache), `WorkspaceService`
  (mappings, create/manage workspace), `ExplorerService` (Source Control Explorer), `ShelveService`,
  `ConflictService`, `HistoryService`, `FileOpsService` (rename/move/delete).
- **UI**: `src/ui/ScmProvider.ts` drives the native Source Control panel (Included/Excluded
  groups, the comment box, Check In); `DecorationProvider` draws the file-tree badges;
  `ServerContentProvider` + `QuickDiff` back the `teamExplorer:` URI scheme and gutter diff. Four
  webviews cover what the native SCM panel has no analogue for: `SourceControlExplorer.ts`,
  `HistoryView.ts`, `ShelvesetsView.ts`, `ConflictsView.ts`.
- **`src/commands/`** — the command handlers VS Code's palette and menus call into (checkout,
  undo, get latest, add, check-in, exclude/include, history, annotate, workspace management,
  shelve, conflicts, ...).

`test/unit/pureModules.test.ts` enforces the "no `vscode` import" rule mechanically: it starts
from a fixed list of pure modules, follows every relative import transitively, and fails if
anything in that closure imports `vscode`. All user-visible strings live in `src/tf/strings.ts`.

## Hard rules

1. **There is exactly one check-in call site**, and it is reached only from the Check In button's
   confirm dialog — no command-palette entry, no keybinding, no exported API, no
   watcher/timer/save-handler path. `test/unit/checkinCallSite.test.ts` pins this several ways: it
   scans every source file for the exact `checkin` / `Checkin` / `CHECKIN` / `CheckIn` spellings
   `tf.exe` accepts (deliberately *not* `checkIn`, which is reserved for the camelCase identifiers
   built from it, like `checkInFromButton`) and asserts the verb appears in exactly one file, called
   exactly once — by the test's own admission "a static, syntactic check, not a real evasion guard",
   not proof nothing could ever call `checkin` some other way. It also asserts that the command is
   hidden from the palette (`"when": "false"`) with no keybinding, that the SCM input box's
   `acceptInputCommand` is left unset (so Ctrl+Enter cannot check in), that the
   `checkInFromButton` command id is named in only one source file, that it appears in only two
   menu contributions total — the hidden palette entry and the real `scm/title` button — and that
   no `viewsWelcome` link offers it either.
2. **The extension never builds authentication arguments.** It never embeds a PAT and never
   constructs `/login:...` itself; the wrapper appends that on its own line, which is what keeps
   the token out of the extension's logs.
3. **Never make a workspace file writable as a substitute for checking it out** (`chmod u+w` on
   Linux, clearing the read-only attribute on Windows). In a server workspace, `tf checkout` does
   two things: it records a pending change on the *server*, and it makes the local file writable.
   Clearing the read-only bit yourself only does the second half — the file becomes editable, but
   no pending change is ever recorded, so the edit stays invisible to TFVC (and to anyone else
   looking at the workspace) until something else notices.
4. **Never disturb another TFVC client's view of a workspace.** A workspace is shared state on the
   server; do nothing that another tool (Visual Studio, or `tf.exe` run by hand) would not expect.

## The wrapper contract

Both wrapper scripts (`wrappers/tfp.cmd` on Windows, `wrappers/tfp` on Linux) exist so the
extension, a terminal and an AI agent can all use the same entry point: append the login arguments
themselves, print nothing of their own on stdout, and return `tf`'s own exit code. Anything they
print goes to stderr, prefixed `[tfp]`, so it can be told apart from `tf`'s own output.
"Pass every argument through" is exactly true of the Windows wrapper, but not quite of the Linux
one: `wrappers/tfp` rewrites any argument that starts with `/` *and* names a file or directory that
actually exists on disk into its Wine form via `winepath -w` (so a real local path survives being
handed to a Windows binary); everything else — switches, `$/` itemspecs, anything that doesn't
resolve to a real path — passes through unchanged.

`TfClient.ts` classifies failures from that contract:

- `WRAPPER_PATTERNS` matches the `[tfp]` prefixes (`PAT file not found/empty`, `TF.exe not found`,
  `Wine prefix not found`) to error kinds (`patMissing`, `tfNotFound`, `wineMissing`).
- `[tfvc] Wrapper not found: <path>` is the extension's *own* refusal, not the wrapper's (kind
  `wrapperMissing`) — it is what `TfClient` prints when the configured wrapper path is absolute and
  does not exist on disk, so spawning is skipped rather than failing with a raw ENOENT. This also
  fires for the *default* path (`~/bin/tfp.cmd` / `~/bin/tfp`) when `teamExplorer.wrapperPath` is
  left empty, since that default is itself an absolute path.
- Exit code **127** (the POSIX shell's "command not found") is classified `commandNotFound` by
  `TfClient`; `src/tf/errorMessage.ts` then swaps in a Flatpak-specific message
  (`S.flatpakNoHost` instead of `S.commandNotFound`) when `process.env.FLATPAK_ID` is set, since
  127 there almost always means the wrapper tried to run `wine` from inside a sandbox that does not
  have it.

**`!`, `%`, `^` and CR/LF are refused outright in any argument, when the configured wrapper is a
`.cmd`/`.bat` file on Windows**, rather than escaped. That wrapper has to run under `cmd.exe` with
`setlocal enabledelayedexpansion`. `%` is expanded once, on the outer `cmd /d /s /c` line, before
the wrapper ever runs. `!` and `^` are consumed by delayed expansion's *second* pass over the
wrapper's own line once it starts running — and that pass always fires, because the real wrapper's
own `/login:.,!TFSPAT!` always contains a `!`. A caret is therefore stripped even when none of the
extension's own arguments contains a `!`, and an odd `!` count can swallow the wrapper's own
trailing `/noprompt` and `/login:`, which opens a sign-in dialog that `windowsHide` then hides. CR
and LF are refused for the analogous reason: a newline ends the wrapper's line early, and a lone CR
is silently dropped. These are all verified against the real quoting logic in `TfClient.ts`
(`CMD_UNSAFE`, `quoteForCmd`), not assumed.

## Decisions and why

- **`tf.exe` under Wine, not REST, not the TFVC client object model.** The TFVC REST API has no
  workspace or pending-change endpoints — probed live, every one of them returned 404. Hosting the
  legacy client object model directly on a modern .NET runtime was tried and got partway: several
  blockers (event logging, configuration, one legacy type) could be shimmed, but the API surface a
  version-control client actually needs next — the registry and file-ACL APIs the credential cache
  and permission checks touch — throws `PlatformNotSupportedException` outside Windows. That is
  exactly the platform this project needs to run on, so the route was abandoned rather than pursued
  to the point of working on Windows and failing on Linux.
- **Per-command spawn, no daemon.** A single `tf` invocation costs roughly half a second to a
  second and a half depending on the command and the machine (see the baselines below); that was
  measured to be fast enough, and a daemon would add a long-lived process to manage and a second
  place authentication could go wrong.
- **Server workspaces**, not local workspaces: pending changes live on the server, and files on
  disk are read-only until checked out. The extension never tries to make that transparent — a
  read-only file is the correct default state.
- **Hybrid UI**: the native Source Control panel for pending changes, checkout, undo and check-in
  (VS Code has a first-class SCM API for this), and webviews only where VS Code has no built-in
  analogue — Source Control Explorer, History, Shelvesets, Conflicts.
- **The Excluded list is the extension's own, kept in `workspaceState`, and is not shared with
  Visual Studio.** `tf.exe` has no concept of it — Visual Studio's Excluded Changes is purely
  client-side too, just in a different client, so this mirrors that rather than trying to
  interoperate with it.
- **Exclusions are keyed on the item's server id, not its path.** A rename changes the path but not
  the id; keying on path meant a renamed excluded file silently rejoined Included, where the next
  Check In takes it irreversibly. The one exception is a pending Add, which has no server id yet (tf
  gives it a negative placeholder), so those are still keyed on path.
- **Check-in is user-driven only** — see Hard rule 1.
- **Build, don't fork an existing extension.** A REST-based TFVC extension on the Marketplace
  (checked as tested in September 2026) keeps no real TFVC workspace at all — its pending changes
  are its own local JSON file, invisible to any other TFVC client — handles one team project at a
  time, and needs its own separate folder tree. None of that fits a large multi-project mapping
  shared with another TFVC client.
- **Auto-checkout on the first keystroke**, mirroring Visual Studio's own default behaviour, and
  overridable by a setting.
- **One codebase for both platforms**, but not because the platforms barely differ — several files
  branch on it deliberately: `src/tf/wrapperPath.ts` (and `src/extension.ts`, which calls it)
  choose a different default wrapper path per platform; `TfClient.ts` branches on Windows for
  `.cmd`/`.bat` quoting and the unsafe-character refusal described above, and on POSIX for the
  process-group spawn and kill (`SPAWN_DETACHED`, `killTree`); `PathMapper.ts`'s `localKey`
  compares local paths case-insensitively on Windows and case-sensitively on Linux. The one thing
  that belongs to `PathMapper.ts` alone is translating a local path to and from tf's `Z:\...` view
  of it under Wine — that translation is a no-op on Windows.
- **PAT storage: SecretStorage plus a file, written only by one command.** *Set Personal Access
  Token* stores the token in VS Code's `SecretStorage` and writes it to the file the wrapper reads
  (`src/commands/setPat.ts`, `src/pat/PatStore.ts`) — never at activation, never in the background,
  so a hand-edited `pat.txt` is never fought. That write honours `TFS_PAT_FILE` when it's set,
  which is what makes the bad-PAT launch configuration safe (it redirects the write, not just the
  read). `writePatFile` also refuses to write anywhere outside the OS temp directory while running
  under `vitest` — added after a mutation test once overwrote a live token by exercising this exact
  path, which is worth remembering before writing a test that touches PAT storage.
- **Manage Workspace can always create a workspace.** Like Visual Studio's Manage Workspaces,
  *Create Workspace…* is reachable whatever the computer already has: with no workspace it is the
  only choice, with one it is the last row of that workspace's list (so the common case keeps its
  one-step path), with several it is in the workspace picker. A name this computer already uses is
  refused case-insensitively before tf is asked. An earlier version offered Create only on a
  computer with no workspace at all, which left a user with an old Visual Studio workspace no way
  to make a second one (`src/commands/workspace.ts`).

## tf and Wine behaviour worth knowing

| Trap | Why | Do this |
|---|---|---|
| Whole-workspace `status` | Cost tracks the size of the *pending* set, not the tree — a workspace with tens of thousands of stale pending changes measured over ten seconds and tens of megabytes; the same command against a clean workspace is well under a second | Always scope `status` to an opened folder as a `$/` itemspec |
| Exit codes | `status` exits **0** whether or not anything is pending | Parse the XML for emptiness; never read the exit code as a proxy |
| Encoding | `tf.exe`'s own XML/text output on stdout is always UTF-8 with no `<?xml?>` declaration — decode it as UTF-8 explicitly. A tracked *file*'s content is a separate question: `enc` in the status XML is that file's own code page, and `vc view` output has to be decoded with it (`decodeWithCodePage`) or non-ASCII (Croatian `č ć ž š đ`) turns to mojibake. But `enc` is set at add time and survives later check-ins: a file added as 1250 and since saved as UTF-8 without a BOM is still `enc="1250"`, and decoding it as 1250 makes every line with a Croatian letter show as changed in the diff | Decode stdout as UTF-8 unconditionally; decode `vc view` output as UTF-8 when the bytes are valid UTF-8 (unless `enc` is UTF-16), otherwise with the item's `enc` code page |
| Arguments starting with `/` | `tf.exe` parses them as switches | Use `$/` itemspecs — they start with `$`. Verified to work from any cwd for `status`; not every command is that forgiving — e.g. `resolve` with a `$/` itemspec exits 100 ("Unable to determine the workspace") when run from outside the workspace, while a local-path itemspec for the same command works from anywhere |
| Case sensitivity | TFVC is case-insensitive; Linux is not | Compare local paths case-insensitively on Windows, case-sensitively on Linux; compare server paths case-insensitively on both |
| Included/Excluded | Visual Studio keeps this locally; `tf.exe` cannot read or write it | The extension keeps its own list — see Decisions above |
| `chg` | It is a **space-separated flag set** (e.g. `"Add Edit Encoding"`), not an enum | Split on spaces, or read the `chgEx` bitmask instead |
| Diffing a pending Add | Adds carry **no `ver`** and a **negative `itemid`** — there is no server baseline | Treat a missing `ver` as "new file, no baseline" |
| `enc="-1"` / `enc="-3"` | `-1` means **binary**; `-3` means folder / not applicable | Suppress text diff on `-1`; never treat either as a real code page |
| Folders in `status` | Folders appear as `type="Folder"` elements too | Never offer them as editable files |
| Parsing dates out of text output | `tf.exe`'s text output is locale-dependent — the same client prints Croatian month names on one machine and English on another (Wine takes its culture from `LANG`) | Prefer `/format:xml` where it's supported; where text is the only option, never parse the date — display it verbatim |
| Assuming `/format:xml` everywhere | Only `status`, `workspaces` and `shelvesets` support it (`src/shelve/ShelveService.ts` uses it for both listing and reading a shelveset) | `workfold`, `dir`, `info` and `history` are text-only |

Other behaviour worth knowing, verified against `tf.exe`'s real output and this codebase:

- **`history` has no XML form at all** (`/format:xml` fails with `TF10120`) — only
  `/format:brief` and `/format:detailed`. `brief` truncates the comment to fit its column, so
  `detailed` is the only format actually usable, and it needs its own text parser.
- **Pending Adds carry no `ver`** (see the table above) — there is no server baseline to diff
  against.
- **stderr is captured to a temporary file, not a pipe.** Under Wine, `tf`'s stderr pipe is
  inherited by `wineserver`, which holds it open for its own persistence timeout well after `tf`
  itself has exited — so waiting on a pipe's `close` event made every single command look several
  seconds slower than it actually was. A file descriptor isn't a stream, so nothing can hold it
  open; `TfClient` falls back to a pipe (with a short idle grace period) only if the temp file
  cannot be opened at all.
- **The child is spawned into its own process group on Linux**, and a timeout or cancellation
  signals the whole group (`SIGTERM`, then `SIGKILL` after a short grace period if anything in the
  group is still alive) rather than just the direct child. `tfp` under Wine `exec`s into `wine`,
  which starts a `wineserver` that outlives the shell script and keeps holding inherited file
  descriptors — signalling only the direct child left it running.
- **`reconcile` must always carry `/preview`.** Without it, `tf vc reconcile /promote /adds` PENDS
  every change it lists instead of merely listing them. `TfClient.run` refuses to execute a
  `reconcile` call missing `/preview` at all, on both platforms, independent of whatever built the
  argument list — defence in depth after exactly this once pended tens of thousands of changes
  against a real workspace.
- **A workspace whose mapped root folder itself was never downloaded makes `reconcile` lie.** If
  only sub-folders under a mapping were ever fetched — easy to end up with when getting files one
  folder at a time — `reconcile /promote /adds /preview` reports every already-versioned file
  under it as a new "Pending add", identically and repeatably, while `tf info` on those same files
  correctly shows them at a real changeset with no pending change. The extension's unversioned-file
  scan guards against this: when the listing claims something is new, it asks `tf info` about one
  such item, and if `info` disagrees, the *whole* listing is dropped as unreliable rather than
  trusted. One `tf get` of the mapping root clears the underlying condition. Note that checking
  `info` on the mapping root itself is not equivalent — a mapping at the very top of the server
  tree has no local half to report even when the workspace is completely healthy, which would
  otherwise disable the guard permanently on exactly that shape of mapping.
- **`resolve` needs `/recursive` to see a conflict inside a folder.** Without it, a folder
  containing a conflicted file answers "none" — a false negative. Only `resolve <items>
  /recursive /preview` reliably lists conflicts; `status` shows nothing about them, and `get` just
  exits non-zero even when it merged cleanly on its own.
- **`checkout`, `undo` and `add` name items relative to the directory tf runs in** (the opened
  folder). Under it the folder header is relative (`src\Models:`), an item directly in it gets no
  header at all, and only outside it is the header absolute; a trailing `$/...:` block lists other
  users' checkouts of the item. `get` is different: its headers are always absolute.
  `scanAffectedItems` resolves all of this against the client's cwd. Reading a relative header as
  absolute left Undo unable to find the open editor, so the typed edit stayed on screen over a
  file tf had just made read-only again.
- **`vc delete` of a folder by local path works even after VS Code has already removed the folder
  from disk** (a delete needs no local copy to still succeed) — **unless a child under it still has
  a pending change of its own**, in which case it fails with `TF14060`: "The item ... cannot be
  deleted. One or more children have pending changes."
- **The Flatpak build of VS Code has a private `/tmp`** and no Wine inside its sandbox at all — a
  host file placed in `/tmp` is not visible inside it, and running the Linux wrapper directly from
  inside the sandbox fails at exit code 127 because there is no `wine` to find. The sandbox does
  have host filesystem access and permission to talk to the host process (`org.freedesktop.Flatpak`),
  which is what `wrappers/tfp-flatpak` uses: a small shim that runs the real wrapper on the host via
  `flatpak-spawn --host`.
- **Git Bash rewrites a bare `/recursive` into a filesystem path** (`C:\Program
  Files\Git\recursive`) unless `MSYS_NO_PATHCONV=1` is set, because it treats any argument
  starting with `/` as a POSIX path to convert. This is purely a Git Bash artifact when testing
  `tf` by hand from that shell — Node's `child_process.spawn`, which is what the extension
  actually uses, has no such rewriting.
- **`TfClient` refuses two more command shapes outright**, the same defence-in-depth style as the
  `reconcile`-without-`/preview` refusal above: a `resolve` call in any shape but the `/preview
  /recursive` listing or exactly one `/auto:` resolution (`isResolveOutOfShape`) is refused before
  it runs, because a bare `resolve` prompts (which `/noprompt` turns into a failure at best), a
  listing without `/recursive` can miss a real conflict, and `/auto:KeepYours` over a whole folder
  would overwrite everyone else's changes under it with no confirmation. Separately, a command line
  measured over `cmd.exe`'s ~8191-character limit — or, on Linux, over what Wine's own rebuilt
  Windows command line can carry, capped at 32,767 characters — is refused with a "Too many items"
  message rather than split across several `tf` calls: splitting a check-in's item list would turn
  one changeset into several, silently, on an operation that cannot be undone.

## Measured baselines

So a regression is recognisable as a regression rather than assumed to be normal:

| Command | Windows (native) | Linux (Wine) |
|---|---|---|
| `vc status <folder> /recursive /format:xml` | 0.65–0.67 s | 0.76–0.81 s |
| `vc status $/ /recursive /format:xml` (whole workspace, few dozen pending changes) | 0.69 s / 20 KB | 1.15 s (workspace with 0 pending changes) |
| same, before a one-time cleanup of ~80,000 accidental pending Adds (largely a `node_modules` tree that was never actually checked in — see below) | 12.0 s / 38.4 MB | n/a |
| `vc view ... /console /version:T` | 1.56 s | 1.09 s |
| `vc workfold .` | 0.78 s | 1.21 s |
| bare `wine cmd /c ver` | n/a | 0.31 s |

Native Windows measures faster than Wine for most of these — folder `status` (0.65–0.67 s vs
0.76–0.81 s), whole-workspace `status` (0.69 s vs 1.15 s) and `workfold` (0.78 s vs 1.21 s). `view`
is the exception, faster under Wine (1.09 s vs 1.56 s). The "before cleanup" row is not a
platform comparison at all — it shows the server evaluating every `status` against a much larger
pending set on the machine that happened to have accumulated one; that cost tracks the pending set,
not the platform, which is also the argument for always scoping `status` calls (see the first table
above): the pending set can grow back.

## Testing lessons

- **Fixtures are byte-exact captures of real `tf.exe` output**, unless the filename says
  `SYNTHETIC` (e.g. `status-croatian-SYNTHETIC.xml`, `workspaces-cloaked-SYNTHETIC.xml`) — those are
  hand-written, for shapes no real workspace had. Even the real captures are sometimes trimmed to a
  representative subset, or have identities and GUIDs redacted/zeroed; see `test/fixtures/README.md`
  for what each file is and isn't. `.gitattributes` marks the fixtures directory `-text`, which
  stops Git from normalizing their line endings — it has no effect on file *encoding*, which Git
  never touches regardless; a fixture is meant to be byte-identical to what the real tool printed.
- **Mutation testing found tests that could not fail.** Several tests turned out to assert
  something their own inputs could never reach — a guard tested against a path that was never
  created, a default that every test happened to override — and a green run never revealed it. A
  mutation pass, which deliberately breaks the code under test and checks that some test notices,
  is what caught these; a passing suite on its own did not.
- **A comment that justifies a guard is not proof the guard is needed** — a review round found
  nine comments doing exactly this, each one wrong in the direction that made a load-bearing check
  look unnecessary. Treat such comments as claims to verify, not as documentation to trust.
- **Tests have to pass on Linux, not just Windows.** CI runs both `windows-latest` and
  `ubuntu-latest`. Before CI existed, the suite was run by hand on a Linux machine, and platform
  assumptions surfaced more than once: a first manual run turned up seven
  failures, every one a test defect — six tests in `lifecycle.test.ts` were asserting against a
  service that had never started, because it reads its platform from `process.platform` and the
  tests were feeding it Windows fixtures and paths; a drive-letter-casing test was only ever true on
  `win32` and is now `skipIf`'d there; and `packaging.test.ts` needed a build first (see above). One
  finding from that same run was a genuine *product* defect, not a test defect: `killTree` had no
  Linux implementation at all — `child.kill()` only reached the wrapper script, leaving `wine` and
  `wineserver` running, because Windows' `taskkill /T` (which walks the whole process tree) has no
  Linux equivalent that a bare `kill()` gets for free; fixed by spawning into its own process group
  and signalling the group (see "process group" above). Later passes found more suites that quietly
  assumed a Windows host (for example a hard-coded `win32` mapper over a real temp folder, or a
  hard-coded `C:\` path given to the host's `path.basename`). The pattern to avoid: a test that
  builds a HOST path by hand instead of from `os.tmpdir()`/`path.join`, or that pins the mapper's
  platform while the paths come from the real host.

## Writing docs with Windows paths

This project has largely been developed with an AI coding agent, and two things in *that agent's
own tool layer* — not in anything specific to this project — can silently corrupt text containing
Windows paths or regular expressions before it ever reaches a file on disk:

1. Piping multi-line content through the agent's shell/heredoc tool can halve backslashes: a
   correctly-escaped JavaScript string literal for the path `C:\dir\Proj`, written as `'C:` and two
   backslashes and `dir` and two backslashes and `Proj'`, can arrive on disk with each doubled pair
   reduced to one — a string literal that still parses, but now silently evaluates to `C:dirProj`
   instead of `C:\dir\Proj`.
2. The agent's own file-write/edit tool can decode a literal `\` + `u` + four hex digits written
   into the requested content into a real control character, instead of leaving it as the four
   literal characters it was meant to be.

Neither failure is visible in the rendered Markdown, and both survive a human review by eye — a
plain text editor or a normal `git diff` would not show anything wrong. Write documents containing
Windows paths or backslash-bearing code with the agent's plain file-write tool rather than a
heredoc, and run `scripts/check-doc-escapes.py <file>` on the result before treating it as final —
it flags control characters, single backslashes inside quoted paths, and other shapes that do not
survive both hazards intact.
