import * as vscode from 'vscode';
import { readFile } from 'node:fs/promises';
import type { TfClient } from '../tf/TfClient.js';
import type { TfvcService } from '../TfvcService.js';
import { isValidUtf8, parseInfoEncoding, vscodeEncodingFor } from '../ui/decode.js';

/**
 * Whether these bytes, read with this encoding, certainly came out right.
 *
 * The cheap gate in front of asking tf. It has to answer "did VS Code read
 * this correctly", not "are these bytes valid UTF-8" — the first version only
 * asked the second, and they differ in two ways that both reach the user:
 *
 *   1. VS Code did not read them AS UTF-8. `files.encoding` is a global (or
 *      per-language) setting, and this collection is the reason it cannot be
 *      set correctly: a blanket `windows1250` for .vb fixes 468 files and
 *      breaks 570. Anyone who sets it — a reasonable thing to try — makes
 *      every UTF-8 file render as mojibake, and the old gate returned early on
 *      all of them because the BYTES were fine.
 *
 *   2. UTF-16 with no BOM. `53 00 45 00` is perfectly valid UTF-8, so the
 *      check passed while the editor showed NULs between the letters. decode.ts
 *      already calls this the dangerous case — no U+FFFD appears anywhere to
 *      hint at it — and SSMS writes .sql as UTF-16LE by default, in a
 *      collection full of .sql files. A BOM'd one fails the UTF-8 check on
 *      `FF FE` and was already handled; a bare one was not.
 *
 * A real UTF-8 text file never contains a NUL, so that is a free signal.
 *
 * `utf8bom` counts as UTF-8: the bytes carry a BOM and VS Code stripped it,
 * which is still a correct read.
 */
export function certainlyDecodedCorrectly(bytes: Buffer, encoding: string | undefined): boolean {
  if (encoding !== 'utf8' && encoding !== 'utf8bom') return false;
  if (bytes.includes(0)) return false;
  return isValidUtf8(bytes);
}

/**
 * Opens a file with the encoding TFVC says it has.
 *
 * WHY THIS IS AUTOMATIC AND NOT A PROMPT: the encoding is not a preference,
 * it is a fact about the file that the server already records. `enc` comes
 * from `tf vc status` (and `tf vc info` for items with no pending change), and
 * it is the same value Visual Studio and tf.exe themselves use. Asking the
 * user to confirm it would be asking them to confirm arithmetic.
 *
 * WHAT IT REPLACES: `files.encoding` is a single global (or per-language)
 * setting, and the correct answer here varies PER FILE. Measured over
 * C:\work, a blanket `"[vb]": { "files.encoding": "windows1250" }` would fix
 * 468 files and break 570 that are UTF-8 without a BOM. There is no static
 * setting that gets this right, on any machine.
 *
 * COST: nothing, for files that do not need it. The gate is local — the bytes
 * on disk plus the encoding VS Code actually used — and tf is consulted only
 * when those two cannot settle it between them. The answer is cached per item.
 */
export class EncodingFixer implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  /** Items whose code page we already asked tf for. */
  private readonly codePages = new Map<string, number | undefined>();
  /** Documents already reopened, so a reopen cannot trigger another. */
  private readonly handled = new Set<string>();

  constructor(
    private readonly client: TfClient,
    private readonly service: TfvcService,
    private readonly output: vscode.OutputChannel,
  ) {
    this.disposables.push(
      vscode.workspace.onDidOpenTextDocument((doc) => void this.fix(doc)),
    );
    for (const doc of vscode.workspace.textDocuments) void this.fix(doc);
  }

  private async fix(document: vscode.TextDocument): Promise<void> {
    if (document.uri.scheme !== 'file') return;
    // Never reopen a document with unsaved edits: reopening discards them.
    if (document.isDirty) return;

    const fsPath = document.uri.fsPath;
    if (this.handled.has(fsPath)) return;

    const serverItem = this.service.pathMapper?.toServerPath(fsPath);
    if (!serverItem) return;

    let bytes: Buffer;
    try {
      bytes = await readFile(fsPath);
    } catch {
      return;
    }

    if (certainlyDecodedCorrectly(bytes, document.encoding)) return;

    const codePage = await this.codePageFor(serverItem);
    const encoding = vscodeEncodingFor(codePage);
    if (!encoding) {
      this.output.appendLine(
        `${fsPath} is not UTF-8 and TFVC reports no usable code page` +
          `${codePage === undefined ? '' : ` (enc=${codePage})`}; left as opened.`,
      );
      return;
    }
    if (document.encoding === encoding) return;

    // Mark BEFORE reopening: the reopen fires onDidOpenTextDocument again.
    this.handled.add(fsPath);

    try {
      const reopened = await vscode.workspace.openTextDocument(document.uri, { encoding });
      const editor = vscode.window.visibleTextEditors.find(
        (e) => e.document.uri.toString() === document.uri.toString(),
      );
      await vscode.window.showTextDocument(reopened, {
        viewColumn: editor?.viewColumn,
        preserveFocus: true,
        preview: false,
      });
      this.output.appendLine(
        `Reopened ${fsPath} as ${encoding} (TFVC enc=${codePage}); ` +
          `VS Code had read it as ${document.encoding}.`,
      );
    } catch (e) {
      this.handled.delete(fsPath);
      this.output.appendLine(
        `Could not reopen ${fsPath} as ${encoding}: ${(e as Error).message}`,
      );
    }
  }

  /** `enc` from the pending-changes cache if it is there, else `tf vc info`. */
  private async codePageFor(serverItem: string): Promise<number | undefined> {
    const pending = this.service.changeFor(serverItem)?.encoding;
    if (pending !== undefined && pending >= 0) return pending;

    if (this.codePages.has(serverItem)) return this.codePages.get(serverItem);

    let resolved: number | undefined;
    try {
      const info = await this.client.run(['vc', 'info', serverItem]);
      if (info.exitCode === 0 && !info.timedOut) {
        resolved = parseInfoEncoding(info.stdout.toString('utf8'));
      }
    } catch {
      resolved = undefined;
    }

    this.codePages.set(serverItem, resolved);
    return resolved;
  }

  /** An explicit checkout or undo can change the encoding on disk. */
  forget(fsPath: string): void {
    this.handled.delete(fsPath);
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}
