# TFVC fixtures

Captured from live `tf.exe` against `https://acme.visualstudio.com/` during Phase 0, then had every
real name, comment and file layout replaced by an invented one before publishing. The **shape** --
encoding, line endings, field labels, column widths -- is still byte-exact to what `tf.exe` printed,
unless the filename says `SYNTHETIC`.

Client: `Microsoft (R) TF - Team Foundation Version Control Tool, Version 17.14.37530.1`
(VS 2022 Community). Captured on **both** machines: `DEVPC` (Windows 11, native) and `FEDORA`
(Fedora 44, the same binary under Wine).

## Windows (`windows/`)

| File | Command | Notes |
|---|---|---|
| `status-journals.xml` | `vc status $/Journals /recursive /format:xml` | The **empty** case: `<Status />`. Exit code **0**. |
| `status-mixed.xml` | trimmed from `vc status $/ /recursive /format:xml` | 6 representative `PendingChange` elements. Identities redacted. |
| `status-croatian-SYNTHETIC.xml` | **hand-written** | No real pending change has a non-ASCII path (verified: 0 non-ASCII bytes across all 79,929). Shape copied from a real element. |
| `workspaces.xml` | `vc workspaces /collection:<url> /format:xml` | Identities redacted. Contains `<WorkingFolder>` mappings. |
| `workfold.txt` | `vc workfold` | Text only — no XML support. |
| `dir-root.txt` | `vc dir $/` | Text only. CRLF. |
| `dir-croatian.txt` | `vc dir "$/Urudžbeni zapisnik"` | Proves UTF-8 round-trip of a non-ASCII **argument**. |
| `history-detailed.txt` | `vc history <item> /stopafter:3 /format:detailed` | **No XML support.** Croatian-localized date. |
| `info.txt` | `vc info <item>` | Text only. Reports `File type: windows-1250`. |
| `reconcile-noignore-vspscc.txt` | `vc reconcile /promote /adds /preview /noignore /recursive /exclude:<tf's 22 + DEFAULT_IGNORE> C:\work\Shop\CardGatewayTool\CardGatewayTool`, cwd `C:\work\Shop`, via `cmd` redirection | 2026-09-18. The SAME command without `/noignore` (and without tf's 22 in `/exclude:`) printed bytes identical to `reconcile-empty.txt`. See finding 19. |
| `reconcile-pending-edit.txt` | `vc reconcile /promote /adds /preview /noignore /recursive <root>`, cwd the repo root | 2026-09-29. `src\DemoShop\Models\Product.cs` made writable (`attrib -r`) and edited, with no checkout. One `Pending edit:` line, no `Pending add:` at all. See finding 27. |
| `shelvesets-list.xml` | `vc shelvesets [/owner:*] /format:xml` | Six real rows (finding 18): the user's own, a colleague's, the build service's. Identities redacted. |
| `status-shelveset.xml` | `vc status /shelveset:<name> /format:xml /recursive` | A shelveset's contents: two edits and an add. No `local` on any change (finding 18). |
| `status-shelveset-rename-delete.xml` | the same | An edit, an add, a rename with `srcitem`, a binary delete. |

## Fedora / Wine (`fedora/`)

Same command set, captured over SSH on 2026-09-16. Workspace `Fedora`, `$/` -> `Z:\home\shax\work`.

| File | Notes |
|---|---|
| `workspaces.xml` | The `Z:\` path shape. **One** mapping, vs two on Windows. Identities redacted. |
| `workfold.txt` | `$/: Z:\home\shax\work` |
| `status-journals.xml` | `<Status />` |
| `status-all.xml` | **Whole-workspace** `status $/` - also `<Status />`: this workspace has **zero** pending changes |
| `dir-root.txt` | **Byte-identical** to the Windows capture |
| `dir-croatian.txt` | **Byte-identical** to the Windows capture |
| `history-detailed.txt` | Same changeset as Windows, **different date format** - see finding 13 |
| `info.txt` | Also reports `File type: windows-1250` |

`view-out.bin` is deliberately **not** committed - it is a proprietary source file. See finding 11
for the round-trip check instead.

## Cross-machine findings

### 13. Date localization differs *between the two machines*
The same changeset, `history /format:detailed`:

| Machine | Output |
|---|---|
| `DEVPC` (Windows) | `Date: 11. ožujka 2013. 13:52:15` |
| `FEDORA` (Wine) | `Date: Monday, March 11, 2013 1:52:15 PM` |

Fedora runs `LANG=en_US.UTF-8` with `LC_NUMERIC=hr_HR.UTF-8`. So a text parser for `history`
(which has no XML form - finding 7) must tolerate **both** Croatian and English date formats, or
the spawn must pin a locale. This is the strongest argument for keeping dates out of the text
parsing path wherever possible.

### 14. `view` is byte-transparent under Wine too - R3 is closed
`view $/Deposits/Deposits/frmDeposits.vb /console /version:T` produced identical bytes on
**all three** of: the local Windows file, Windows `view`, and Wine `view`. Wine adds no
transcoding.

### 15. `dir` output is byte-identical across machines
Both `dir-root.txt` (197 B) and `dir-croatian.txt` (141 B) `cmp` clean between the two captures.
Server-side text comes back the same regardless of platform.

### 16. Non-ASCII arguments work on both machines
`dir "$/Urudžbeni zapisnik"` succeeds natively on Windows and under Wine. (An earlier failure
under Wine was an artifact of passing the argument through an SSH transport that mangled the byte -
not a Wine issue. Build such arguments locally to the machine running `tf`.)

### 17. Whole-workspace `status` cost is driven by the pending set, not the tree
`status $/ /recursive` on Fedora - same server, same `$/` tree - took **1.15 s** and returned
`<Status />`, against **12.0 s / 38.4 MB** on Windows. The Windows cost is entirely the 79,929
pending changes (spec R6), which also means the Fedora side will look deceptively fast in testing.

### 18. `workspaces /collection:<url>` returns only the local computer's workspace
Neither capture listed the other machine's workspace. Add `/computer:*` to see all. For PathMapper
this is the desired default.

### 19. Without `/noignore`, `reconcile` hides files by rules we cannot see
Measured on DEVPC 2026-09-18, all with `/preview` (pending count 49 before and 49 after every run):

- **A `.tfignore` in a SUBFOLDER is obeyed.** Itemspec
  `C:\work\Shop\Shop2023\Accommodation\flutter`, cwd `C:\work\Shop`: default output was
  `No matching changes found to pend.`; with `/noignore`, 497 lines (`.idea`, `.claude`,
  `.screenshots`, `trak.iml`, `coverage`, ...). Even `.metadata`, which no rule in that `.tfignore`
  names, was hidden by default. tf's `.tfignore` semantics are not ours to reimplement.
- **But not when the itemspec is BELOW the `.tfignore`'s folder.** Itemspec `...\flutter\.idea`
  listed every file in `.idea` by default, although the parent `.tfignore` says `.idea/`.
- **`*.vssscc`, `*.vspscc` and `*.dbmdl` are hidden by default** and are NOT in the 22-item list
  tf prints (`TF_BUILTIN_EXCLUSIONS`). `reconcile-noignore-vspscc.txt` is the capture.
- **`/noignore` also drops tf's 22 built-in exclusions** (`flutter_01.log` was listed; `*.log` is
  one of the 22). **`/exclude:` still applies under `/noignore`** (`dist` stayed out).
- Cost is not worse: `C:\work\Shop` 2.7 s default vs 2.1 s `/noignore` (249 vs 753 lines);
  `C:\work\Rex` 3.2 s vs 2.5 s (1,088 vs 1,092 lines).

So a scan WITHOUT `/noignore` is silent about files tf skipped for reasons we cannot know, and
the scan's silence is what `ScanResult` reads as "in source control".

## Phase 2 captures (2026-09-21)

History and `info` for Phase 2, captured on **both** machines with identical commands, byte-exact.
Windows: spawned exactly as `TfClient` does (`cmd /d /s /c "<tfp.cmd> ..."`, stdout piped to a
Buffer). Fedora: `~/bin/tfp ... > file` over SSH. Every capture exited **0** with empty stderr.
User names are first names only, as in `history-detailed.txt`; nothing to redact.

| File (both `windows/` and `fedora/`) | Command | Shows |
|---|---|---|
| `history-file-renamed-itemmode.txt` | `vc history $/Shop/Shop2023/ShopModel/Till/tillPOSReply.vb /format:detailed /stopafter:50 /itemmode` | Follows the rename in C18547 back to C18544, whose record prints the **old** path `tillPOSReplies.vb` |
| `history-file-renamed-no-itemmode.txt` | the same without `/itemmode` | Stops AT the rename: C18547 is the oldest record |
| `history-workspace-version.txt` | `vc history <local path of the same file> /version:W /itemmode /format:detailed /stopafter:50` | Local-path itemspec; Windows `C:\work\...`, Fedora `Z:\home\shax\work\...` |
| `history-changeset-multiline.txt` | `vc history $/ /version:C13559~C13559 /recursive /format:detailed /stopafter:1` | A multi-line comment whose blank middle line is two spaces |
| `history-changeset-rename-delete.txt` | `vc history $/ /version:C20213~C20213 /recursive /format:detailed /stopafter:1` | `delete, source rename $/...;X703` - a deletion id suffix - and a padded change column |
| `history-folder-page1.txt` | `vc history $/Shop/Shop2023/Distribution /recursive /format:detailed /stopafter:5` | A folder page |
| `history-folder-page2.txt` | the same plus `/version:C1~C21017` | The next page (page 1 ended at C21018) |
| `history-no-entries.txt` | `vc history $/Shop/Shop2023/Distribution/Forms/frmInvoice.vb /version:C1~C100 /format:detailed /stopafter:5` | The empty result: a sentence on **stdout**, exit **0** |
| `info-at-version.txt` | `vc info $/Shop/Shop2023/Distribution/Forms/frmInvoice.vb /version:C20545` | `info` accepts `/version:`; `File type` is the code page at that version |

### 20. History of a renamed file needs `/itemmode`, and `view` needs the OLD path
Without `/itemmode` the history of a renamed file ends at the rename. With it, older records print
the path the item had **then**. `view $/<new path> /console /version:C18544` fails, exit 1,
`No file matches.`; `view $/<old path> ... /version:C18544` returns the content (13,066 B, not
committed). So a version must be fetched by the path its own record printed.

### 21. `/itemmode` is ignored for folders
`vc history $/Shop/Shop2023/Distribution /recursive /itemmode` exits 0 and writes
`Ignoring the /itemmode option.` to **stderr**, on both machines. Pass it for files only.

### 22. Comment lines and item lines have the same indentation
Both are indented two spaces, and a comment may itself contain `$/...` (seen in 3 of 1,140
records of `$/Shop`, e.g. `Branched from $/...`). A history parser must track which section it is
in; a line regex alone reads those comments as items.

### 23. FEDORA's history dates stay English even with `LC_TIME=hr_HR.UTF-8`
The SSH session had `LANG=en_US.UTF-8`, `LC_TIME=hr_HR.UTF-8`, and dates still printed as
`Monday, September 21, 2026 8:58:49 AM`. Wine takes its culture from `LANG`. Finding 13 stands:
dates are shown verbatim, never parsed.

### 24. Paging a renamed file needs the item pinned (`;T` / `;W`), or every page past the rename is empty
Captured later the same day, after the Task 2 review, on both machines, same method:

| File (both `windows/` and `fedora/`) | Command | Shows |
|---|---|---|
| `history-itemmode-range-unpinned.txt` | `vc history $/Shop/Shop2023/ShopModel/Till/tillPOSReply.vb /format:detailed /stopafter:50 /itemmode /version:C1~C18546` | **No history entries**, exit 0. The local-path form printed the same bytes |
| `history-itemmode-range-pinned.txt` | the same with the itemspec `$/...tillPOSReply.vb;T` | C18544, printed under the OLD name |
| `history-itemmode-range-pinned-local.txt` | `vc history <local path>;W /format:detailed /stopafter:50 /itemmode /version:C1~C18546` | C18544, identical to the server-path form |
| `history-itemmode-pinned-local-page1.txt` | `vc history <local path>;W /format:detailed /stopafter:3 /itemmode /version:W` | 18659, 18617, 18588: the pin does not change page 1 |

tf resolves an unpinned itemspec at the TOP of the `/version:` range. The file had its new name
only from C18547, so a range ending at C18546 names nothing, and tf says so with exit 0: a page
query past a rename silently ends the history there. With the item pinned at a version where
the name exists (`;T` for a server path, `;W` for a local path, or `;C<n>`), `/itemmode` follows
the item back across the rename. A range that still contains the rename (`/version:C1~C18551`)
works either way. Not committed but checked: `$/Shop/Shop2023/Distribution;T` with `/recursive`
printed bytes identical to `history-folder-page1.txt` and `history-folder-page2.txt` on both
machines, so every history itemspec can carry the pin.

### 25. Workspace and mapping behaviour (phase 3 part 1 probe, 2026-09-22)
Captured on FEDORA (raw bash redirect) with a throwaway workspace `TFVC-PROBE-FEDORA` mapped only
under `/tmp`, deleted afterwards; DEVPC printed the same text with `TFVC-PROBE-DEVPC` (its captures went
through PowerShell, so they are not committed). The real workspaces were never touched.

| File (`fedora/`) | Command | Shows |
|---|---|---|
| `workfold-new-workspace.txt` | `vc workfold /workspace:<new>` right after `vc workspace /new <new> /collection:<url> /location:server` | `$/` mapped to the **current directory**: `/new` adds that mapping by itself |
| `workfold-empty.txt` | `vc workfold /workspace:<new>` after `vc workfold /unmap <cwd> /workspace:<new>` | `This workspace has no working folder mappings.` |
| `workfold-after-local-takeover.txt` | `vc workfold /map <other server path> <an already-mapped local folder> ...`, then `workfold` | the old mapping is **gone**, replaced by the new one; the `/map` exited 0 |
| `get-recursive.txt` | `vc get <local> /recursive` on a two-file folder | `<folder>:` headers and one `Getting <name>` per item |
| `get-up-to-date.txt` | the same again | `All files are up to date.` |

Also seen, not committed: `/map` of an already-mapped server path moves it to the new folder, exit 0;
a redundant child mapping is dropped, exit 0; another project mapped inside a mapped folder is
accepted; `vc workfold /unmap` refuses `/collection:` ("The option collection is not allowed.",
exit 100); files stay on disk after `/unmap` and after `workspace /delete`.

### 26. Folder `info` and everyone's `status` (phase 3 part 2 captures, 2026-09-22)
Read-only, against the real workspaces. The DEVPC files came through `cmd` redirection and the FEDORA
files through bash redirection, with stdout and stderr in separate files. In the two `status` files
the `owner`, `owneruniq` and `pso` GUIDs are zeroed, as in `status-mixed.xml`; nothing else is changed.
Display names are first names only.

| File | Command | Shows |
|---|---|---|
| `windows/info-folder-star.txt` | `vc info $/Shop/Shop2023/Enterprise.Till.Server/*`, cwd `C:\work` | 24 blocks: the **folder itself first, with an EMPTY server half** (Changeset 0), then one per item. `Last modified` is Croatian (`10. studenog 2023. 8:27:45`) |
| `fedora/info-folder-star.txt` | the same, cwd `~/work` | the same shape; `Last modified` in English (`Friday, November 10, 2023 8:27:45 AM`) |
| `fedora/info-not-downloaded.txt` | `vc info '$/Ledger/*'` (mapped through `$/`, never downloaded) | every block has an **empty local half** (`Local path :` empty, Changeset 0) and a full server half |
| `windows/status-folder-star-allusers.xml` | `vc status $/Shop/Shop2023/Enterprise.Till.Server/* /user:* /format:xml` | one `PendingSet` per workspace, with `ownerdisp` / `computer` / `name`, including the user's own sets on other machines |
| `fedora/status-folder-star-allusers.xml` | the same, from FEDORA | the same content |

- **With `/user:*`, tf writes a notice to STDERR, not stdout** ("Changes from local workspaces will not be
  displayed when using the /user option…", 156 bytes, exit 0). stdout starts at `<Status>`.
- **`info` for a folder outside every mapping** (checked on a throwaway workspace mapping only
  `…/Web/assets`, deleted afterwards) looks exactly like not downloaded: exit 0 with an empty local
  half. So "not mapped" has to come from the mappings, not from `info`.
- **`get /version:D2026-01-01T00:00` and `/version:D2026-01-01`** are both accepted on DEVPC and FEDORA.
  A version from before the item existed prints `Deleting <path>` and removes the local copy.

### 27. `reconcile` has a `Pending edit:` verb, not just `Pending add:`
Captured on DEVPC 2026-09-29 from a real run, found by a real defect: one file,
`src\DemoShop\Models\Product.cs`, was made writable (`attrib -r`) and its content edited, with no
checkout pended. `reconcile ... /preview` (exit 0, stdout only, `reconcile-pending-edit.txt`, 48
bytes, CRLF, no BOM, pure ASCII) printed:

    src\DemoShop\Models:
    Pending edit: Product.cs

not a `Pending add:` line. `parseReconcile` (before this fix) recognised only `Pending add:`, so it
read `Pending edit:` as an unrecognised line and reported the whole scan a problem -- discarding
every real add in the same listing along with it, and leaving the edited file's own hazard badge
(`writableNotCheckedOut`) undrawn, which is the one case the scan-driven red `!` exists to catch.
`Pending edit:` means tf considers the item VERSIONED and different from the server with no pending
change registered for it -- the opposite of what `Pending add:` means -- so the fix reads it as a
distinct, recognised verb whose name is kept OUT of the unversioned list, not merged into it.

No real capture has ever shown `Pending delete:`, `Pending rename:`, or any other `Pending <verb>:`
out of `reconcile` -- only `add` and now `edit`. Those two are the only verbs this parser accepts;
every other `Pending <verb>:` line still falls through to "unrecognised line" (whole scan discarded,
previous result kept), the same conservative default as before this fix.

## Findings that change the design

### 1. `chg` is a space-separated flag set, not an enum
Observed values across 79,929 changes:

| `chg` | `chgEx` | count |
|---|---|---|
| `Add Edit Encoding` | 7 | 70,427 |
| `Add Encoding` | 5 | 9,459 |
| `Edit` | 2 | 43 |

`chgEx` is the matching bitmask (`Add`=1, `Edit`=2, `Encoding`=4). **Parse `chg` by splitting on
spaces, or prefer `chgEx`.** No `Delete` or `Rename` exists in this workspace, so those shapes are
still unverified.

### 2. `ver` is absent on pending Adds
Only **43 of 79,929** elements carry `ver` — exactly the `chg="Edit"` ones. A pending Add has **no
server baseline**, so quick-diff must render it as a new file rather than diffing against `ver`.

### 3. `itemid` is negative for pending Adds
79,886 of 79,929 have a negative `itemid` — i.e. "not yet on the server".

### 4. `enc` is a code page, with two sentinels

| `enc` | meaning | count |
|---|---|---|
| `1250` | windows-1250 (the common case) | 66,678 |
| `65001` | UTF-8 | 3,567 |
| `-1` | **binary** (`.png`, `.tgz`, …) | 225 |
| `-3` | not applicable (every `type="Folder"`) | 9,459 |

Decode `view` output with this value. `-1` must suppress text diff entirely.

### 5. `type="Folder"` appears in status
9,459 elements are folders. The SCM panel must not offer them as editable files.

### 6. Mixed drive-letter casing in `local`
79,920 say `C:`, **9 say `c:`** — in the same output. PathMapper must compare paths
case-insensitively.

### 7. Only `status` and `workspaces` support `/format:xml`
`workfold`, `dir`, `info` and `history` are text-only on this client. `history /format:xml` fails
with `TF10120`.

### 8. `tf.exe` output is partly Croatian-localized
`info` and `history /format:detailed` print dates as `11. ožujka 2013. 13:52:15`. Field labels stay
English; **month names do not.** Any text parser must handle Croatian month names, or the design
must avoid parsing dates out of text output.

### 9. Seed PathMapper from `workspaces /format:xml`, not `workfold`
`workspaces /collection:<url> /format:xml` returns the same mappings as structured
`<WorkingFolder local="…" item="…"/>` elements — no text parsing, no localization exposure.
`/format:xml` requires `/collection`.

### 10. stdout is UTF-8; there is no XML declaration
Redirected `tf.exe` stdout is UTF-8 with CRLF. The status XML starts directly at `<Status>` with
**no `<?xml?>` declaration**, so an XML parser gets no encoding hint — decode the buffer as UTF-8
explicitly.

### 11. `view /console` is byte-transparent (verified on Windows)
`vc view $/Deposits/Deposits/frmDeposits.vb /console /version:T` returned output
**byte-identical** to the local CP1250 file (`cmp` clean), with `0x9E` (`ž`) preserved. Read stdout
as a `Buffer`; never as a string.

### 12. Exit codes: errors do set them, `status` does not
`status` exits 0 whether or not anything is pending. Genuine errors exit **100**
(`TF10120`, the `workspaces /format:xml` collection error). So: parse XML for emptiness, but a
non-zero exit is still a real failure worth surfacing.

### 13. `reconcile` calls EVERY file new until the mapping itself is downloaded
Measured on DEVPC, 2026-09-23 (probes R28-R31), against a workspace mapping
`$/Shop/Shop2023/Enterprise.Till.Server/Web` whose contents were fetched one sub-folder at a time,
never as the mapping itself:

    tf vc reconcile /promote /adds /preview /noignore /recursive <root>
    Pending add: hello.html
    order-kiosk:            Pending add: 3rdpartylicenses.txt
    order-kiosk\browser:  Pending add: favicon.ico, index.html, main-*.js, polyfills-*.js, styles-*.css

Every one of those is versioned: `tf info` puts `order-kiosk\browser\index.html` at changeset
18338 with `Change: none`. The listing is **identical 20 seconds later**, so it is not a race, and
**one `tf get` of the mapping clears it completely** -- after which the same command answers "No
matching changes found to pend."

`info` on the mapped folder tells the two states apart in one call, which is what the scan now uses
(`info-root-never-fetched.txt` vs `info-root-fetched.txt`):

| | `Local path` | `Changeset` |
|---|---|---|
| Never downloaded | *(empty)* | `0` |
| Downloaded | the local path | `18312` |

`reconcile-root-never-fetched.txt` is the listing itself, from the same run.

This was first misread as "a pending rename into a folder poisons reconcile for that folder"
(the shape it happens to take once a rename exists). Probes R26-R27 disproved that: in a fully
fetched workspace, no rename -- in place, moved, renamed-and-moved, or nested -- makes reconcile
report anything.

**`info` on a mapping ROOT is not a usable test for this**, though it looks like one. The real
`Fedora` workspace maps `$/` to `Z:\home\shax\work`, and `tf vc info 'Z:\home\shax\work'`
returns an EMPTY local half with `Changeset : 0` however complete that workspace is -- `$/` is
never an item anybody downloads. A check built on it would switch the unversioned scan off on a
perfectly healthy machine (measured 2026-09-23, before it shipped). What `UnversionedScan` tests
instead is the contradiction itself: it asks `info` about one item the listing just called new, and
disbelieves the whole listing if tf also has that item at a local changeset.

### 14. A rename's source is in `status /format:xml`, as `srcitem`
`status-rename-inplace.xml` and `status-rename-moved.xml` are the first real captures of a pending
rename (the "Still missing" note below is now half answered). Both carry `chg="Rename"`, `chgEx="8"`
and a `srcitem` attribute holding the server path the item is being renamed FROM, alongside `item`
for where it is going. A move and an in-place rename differ only in those two paths. `parse.ts`
does not read `srcitem` today; nothing needs it yet.

### 15. A cloak really is `type="Cloak"` with no `local`, and it DELETES local files
Captured 2026-09-23 from a throwaway workspace (`workspaces-cloaked.xml`, `workfold-cloaked.txt`),
which closes a guess `PathMapper` had been defending against since phase 1:

    <WorkingFolder local="C:\...\tfvc-probe-fix" item="$/Shop/.../Web" />
    <WorkingFolder item="$/Shop/.../Web/order-kiosk" type="Cloak" />

No `local` attribute at all, and `type="Cloak"` exactly as inferred. `workfold` text spells it
` (cloaked) $/Shop/.../Web/order-kiosk:` (P10 confirmed).

**The part worth knowing before anyone offers cloaking in the UI:** the next Get after a cloak does
not merely skip the subtree, it REMOVES it --

    Deleting C:\...\tfvc-probe-fix\order-kiosk\browser\index.html
    ... every file, then the folders themselves

so cloaking a folder someone is working in throws their local copy away. Anything unshelved or not
checked in goes with it. (Phase 3 part 4 would have exposed this; it was dropped on 2026-09-23, but
a user can still cloak from Visual Studio and arrive here with the result.)

### 16. A pending `Delete` shape, for a file and a folder
`status-delete.xml`, captured in the same run, closes the last "Still missing" entry:

    chgEx="16" chg="Delete" type="File"   ... ver="18312" len="304" hash=...
    chgEx="16" chg="Delete" type="Folder" ... ver="18312" enc="-3"   (no len, no hash)

`ver` and a positive `itemid` are present, unlike a pending Add -- the item exists on the server,
which is what the delete is against.

### 17. Conflicts: only `resolve /recursive /preview` sees them, and it lists them on stderr
Captured 2026-09-23 on both machines (phase 5, C1-C20) from throwaway workspaces created and deleted for the purpose, plus two read-only runs
against the real DEVPC workspace. The `resolve-*` files:

- **The listing (C6-C9).** None: exit 0, `resolve-preview-none.stdout.txt` (both machines). Some:
  exit 1, empty stdout, one `<path>: <reason>` line per conflict on **stderr**
  (`resolve-preview-relative.stderr.txt`). The path is relative to tf's working directory when the
  item is under it, absolute otherwise (`-absolute-croatian` vs `-relative-croatian`, both machines,
  UTF-8 with `ž` intact). Without `/recursive`, a folder with a conflict inside says "none"
  (`resolve-preview-nonrecursive.stdout.txt`) -- a false negative.
- **A `$/` itemspec from outside the workspace (C10):** exit 100,
  `resolve-preview-serverpath-outside.stderr.txt`.
- **Get (C1, C3):** a conflicting edit (`resolve-get-conflict.*`, Windows) and a writable
  never-downloaded file (`fedora/resolve-get-blocked.*`) both exit 1; neither output says whether a
  conflict was left behind.
- **`info` (C5):** `resolve-info-three.txt` is three real DEVPC files -- `CORE.Api.xml` (a real Binary
  version conflict, local C15451, server C21004), `till_InvoiceSelect.sql` (a pending edit, no
  conflict) and `Startup.cs` (`Change : none`). `fedora/resolve-info-blocked.txt` is a blocked file:
  the local half is empty.
- **Resolutions (C12, C14, C16-C18):** `/auto:AutoMerge` on an overlapping edit changes nothing
  (`resolve-automerge-refused.*`); a bulk `/recursive /auto:AutoMerge` reports what it cannot merge
  and changes nothing there (`resolve-automerge-all-mixed.*`); `resolve-keepyours.stdout.txt`,
  `resolve-overwritelocal.stdout.txt`, and `resolve-nothing-to-resolve.stdout.txt` (resolving a
  non-conflict is exit 0).

The real DEVPC conflict (`resolve-preview-real-devpc.stderr.txt`) was left alone.

### 18. Shelvesets (phase 4, DEVPC, 2026-09-23)
`shelvesets-list.xml` and the two `status-shelveset*.xml` come from throwaway workspaces
`TFVC-PROBE-P4A/B` and shelvesets `TFVC-PROBE-P4-*`, all deleted afterwards (phase 4).

- `vc shelvesets /format:xml` rows carry `name owner ownerdisp owneruniq date`, a `<Comment>` whose own
  line breaks are CRLF, and `<Links>` for work items. "None found" is exit 100 with empty stdout and
  NO TF code; an unknown owner is exit 100 with `TF14045`.
- `vc status /shelveset:<name>;<owner>` is a `PendingSet type="Shelveset"` whose `PendingChange`s have no
  `local`, a `ver` that is the version shelved from (absent on an add), and `srcitem` on a rename.
- Redacted: the user's account is `user@example.com` as in `workspaces.xml`, a colleague is
  `colleague@example.com` / `Colleague`, owner GUIDs are zeros. The Croatian letters are real: taken from
  the raw `cmd` capture, because the PowerShell capture of the full list had mangled them.

## Measured on this machine (2026-09-16)

| Command | Time |
|---|---|
| `vc status $/Journals /recursive /format:xml` (45 files, empty) | 0.65 s |
| `vc status $/Vesta /recursive /format:xml` (7,167 files, empty) | 0.67 s |
| `vc status $/ /recursive /format:xml` (**38.4 MB, 79,929 changes**) | **12.0 s** |

Confirms R6 and the "always scope `status`" rule: scoping is ~18× faster here.
The 80k pending set is largely a checked-in `node_modules` tree under
`$/Bookkeeping/Bookkeeping2023/docs/help/retail/docusaurus/`.

## Still missing

- Nothing outstanding from the original list: `Rename` (finding 14), `Delete` (finding 16) and a
  cloaked workspace (finding 15) were all captured on 2026-09-23 from throwaway workspaces created
  and deleted for the purpose. `workspaces-cloaked-SYNTHETIC.xml` is kept alongside the real one
  because it places a cloak inside the `$/` mapping, the arrangement that made the original bug
  visible.
- A real non-ASCII path in a `status` result (the Windows workspace has none, the Fedora workspace
  has no pending changes at all).
