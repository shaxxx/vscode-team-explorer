/** What `parseReconcile` returns -- see its doc comment for the contract. */
export interface ParsedReconcile {
  items: string[];
  headers: string[];
  problems: string[];
  /**
   * `Pending edit: <name>` lines, folder-prefixed and `/`-separated the same
   * way as `items`. This is tf saying the file IS versioned and differs from
   * the server with NO pending change registered -- i.e. it was made writable
   * and edited without a checkout -- not a new file. Deliberately kept OUT of
   * `items`: putting it there is the defect this field exists to fix (see
   * `reconcile-pending-edit.txt`). The caller does not read this array today
   * -- simply leaving the name out of `items` while still recognising the
   * line (no `problems` entry) is enough, because `ScanResult` already reads
   * "covered, not listed" as `inSourceControl`, which is what feeds the
   * `writableNotCheckedOut` badge. It exists so a test (and a future caller)
   * can see the line was understood, not merely that it was not a problem.
   */
  editedItems: string[];
}

/** Whether any `/`- or `\`-separated component of `p` is exactly `..`. */
function hasDotDotComponent(p: string): boolean {
  return p.split(/[\\/]/).includes('..');
}

/**
 * Parses the output of `tf vc reconcile /promote /adds /preview`.
 *
 * `reconcile` has NO xml format -- this text is all there is. It emits blocks:
 * a folder header alone on a line ending in `:`, then one `Pending add: <name>`
 * per item, then a blank line.
 *
 * Paths are relative to the PROCESS WORKING DIRECTORY, not to the itemspec.
 * Measured on DEVPC 2026-09-18: the same scan of C:\work\OPS emits
 * `OPS\OPS2013\Inventory:` when run from C:\work -- see line 1 of
 * `test/fixtures/windows/reconcile-adds.txt`. It was also reported to emit
 * bare `OPS2013\Inventory:` when run from C:\work\OPS, but that half was
 * not captured to a fixture; the C:\work-relative half alone is enough to
 * show the paths are cwd-relative, since a `OPS\` prefix only makes sense
 * relative to C:\work. The caller resolves what comes back.
 *
 * WHEN THE CWD IS THE ROOT, the root's own items have NO HEADER AT ALL and
 * appear before the first one:
 *
 *     Pending add: Personnel.Data
 *     Pending add: Customers
 *
 *     Customers:
 *     Pending add: Customers2020
 *
 * So an item with no current folder belongs to the cwd itself. Dropping those
 * as malformed -- the obvious defensive reading -- would silently discard every
 * new file in the workspace root, which is where new files land. Captured in
 * `test/fixtures/windows/reconcile-cwd-is-root.txt` so it cannot regress.
 *
 * ITEMS ARE NOT ALWAYS FILES, AND THE LIST IS NOT A CONSISTENTLY-EXPANDED
 * TREE. An item can itself be a directory, listed two ways depending on
 * whether tf chose to open it as its own block:
 *   - Opened: `reconcile-cwd-is-root.txt` lists `Customers` as a root item,
 *     then opens `Customers:` as a header, yielding both `Customers` and
 *     `Customers/Customers2020`, `Customers/Customers2020/Customers.Data`,
 *     `Customers/Customers2020/Customers.Model` in the same flat array.
 *   - Not opened: `reconcile-adds.txt` lists `Connected Services` (a Visual
 *     Studio folder, along with `Dialogs`, `DX`, `Forms` in the same block)
 *     as a bare `Pending add:` under `OPS\OPS2013\Inventory:`, and there is
 *     no `...\Connected Services:` header anywhere in the file -- its
 *     contents are simply never enumerated.
 * A caller that builds an exact-path set from `items` and does membership
 * lookups on it will therefore mislabel every file inside an unopened
 * directory like `Connected Services` as "in source control".
 *
 * Returns `{ items, headers, problems }`. `items` and `headers` are
 * `/`-separated and relative, in the order tf emitted them; tf emits `\` even
 * under Wine, so the caller can resolve either on either platform. `headers`
 * is the distinct set of folder headers seen, for the caller to check each
 * one names a real directory under the root (see `UnversionedScan`) -- a
 * header this function cannot itself tell from a diagnostic line that merely
 * ends in `:` (see the header branch below).
 *
 * `problems` is empty when every non-blank line was a `Pending add:`, a
 * `Pending edit:`, a header, or the exact empty-result sentinel; otherwise it
 * holds one message per line or name this function could not vouch for -- an
 * unrecognised line, an absolute or `..`-bearing header, or an item name
 * containing `:` or `..`. A non-empty `problems` means the output does not
 * match tf's known shape and the caller should not trust `items` at all (see
 * `UnversionedScan`, which keeps the previous scan result rather than acting
 * on it).
 *
 * `Pending edit: <name>` is a DIFFERENT verb from `Pending add:`, seen when a
 * file already in source control was made writable and changed on disk with
 * no pending change registered for it -- exactly the hazard the
 * `writableNotCheckedOut` badge exists for, not a new file (real capture:
 * `reconcile-pending-edit.txt`, one line, `src\DemoShop\Models\Product.cs`
 * made writable and edited without a checkout). Recognised as a non-problem
 * line but its name goes to `editedItems`, never `items` -- putting it in
 * `items` would read a VERSIONED file as unversioned, the opposite of what tf
 * said. Only `Pending edit:` is handled: no real capture has ever shown
 * `Pending delete:`, `Pending rename:`, or any other `Pending <verb>:` out of
 * `reconcile` (`status`'s `Delete`/`Rename` shapes, findings 14 and 16 in
 * `test/fixtures/README.md`, are a different command with a different, XML
 * output). Generalising to `Pending \S+:` on no evidence would risk silently
 * misreading a shape nobody has seen; any other `Pending <verb>:` line still
 * falls through to "unrecognised line" below, which is the safe default this
 * function already had.
 *
 * NEVER hand this the output of a run whose exit code was non-zero: that is a
 * failure and the text is an error message, not a listing. The scan checks
 * the exit code first; `problems` is a backstop for whatever slips past that
 * check, not a replacement for it.
 */
export function parseReconcile(text: string): ParsedReconcile {
  const items: string[] = [];
  const headers: string[] = [];
  const headersSeen = new Set<string>();
  const problems: string[] = [];
  const editedItems: string[] = [];
  /** undefined until the first header; items before it belong to the cwd. */
  let folder: string | undefined;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (line === '') continue;

    const add = /^Pending add: (.+)$/.exec(line);
    if (add) {
      const name = add[1];
      if (name.includes(':')) {
        problems.push(`item name contains ':': ${name}`);
      } else if (hasDotDotComponent(name)) {
        problems.push(`item name contains '..': ${name}`);
      }
      items.push(folder === undefined ? name : `${folder}/${name}`);
      continue;
    }

    // `Pending edit:` -- tf saying the file IS versioned and differs locally
    // with no pending change, not a new file. See the doc comment above for
    // why this is a distinct verb, why it is not a problem, and why its name
    // goes to `editedItems` rather than `items`.
    const edit = /^Pending edit: (.+)$/.exec(line);
    if (edit) {
      const name = edit[1];
      if (name.includes(':')) {
        problems.push(`item name contains ':': ${name}`);
      } else if (hasDotDotComponent(name)) {
        problems.push(`item name contains '..': ${name}`);
      }
      editedItems.push(folder === undefined ? name : `${folder}/${name}`);
      continue;
    }

    // A header: no leading whitespace, ends with a colon. A Windows file name
    // cannot end with `:`, so this cannot collide with an item. This function
    // cannot tell a real folder header from any OTHER line that happens to
    // end in `:` -- a diagnostic, a future tf message -- so that line is read
    // as a header too; the caller is responsible for checking each header
    // names a real directory (see UnversionedScan). What this function CAN
    // tell is whether a header is safe to resolve against a root at all:
    // absolute (a drive letter, or a leading slash or backslash) or carrying
    // a `..` component is a problem, reported rather than trusted.
    if (/^\S.*:$/.test(line)) {
      folder = line.slice(0, -1).replace(/\\/g, '/');
      if (!headersSeen.has(folder)) {
        headersSeen.add(folder);
        headers.push(folder);
      }
      if (/^[A-Za-z]:/.test(folder) || folder.startsWith('/')) {
        problems.push(`header is absolute: ${folder}`);
      } else if (hasDotDotComponent(folder)) {
        problems.push(`header contains '..': ${folder}`);
      }
      continue;
    }

    // The one recognised non-listing line: an empty result is a normal
    // answer, not a problem.
    if (line === 'No matching changes found to pend.') continue;

    // Anything else -- a localized tf's own wording, a warning, or a failed
    // run's error text if the exit-code guard is ever bypassed -- is
    // unrecognised and reported as a problem: treating it as blank would read
    // a scan that failed, or one tf could not print, as "found nothing".
    problems.push(`unrecognised line: ${line}`);
  }

  return { items, headers, problems, editedItems };
}
