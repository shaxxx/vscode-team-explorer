import * as vscode from 'vscode';
import { S } from '../tf/strings.js';
import { classifyError, scrubSecrets, type TfClient } from '../tf/TfClient.js';
import type { TfvcService } from '../TfvcService.js';
import { isReadOnly } from '../watch/ReadOnlyWatcher.js';
import { wouldCorruptOnSave, countReplacements } from './encodingGuard.js';

export type AutoCheckoutMode = 'onEdit' | 'onSave' | 'disabled';

/**
 * How long the save participant may block. Deliberately under VS Code's own
 * ~1500ms limit, so the extension reports the overrun itself rather than
 * being cut off silently. See checkoutWithinSaveBudget.
 */
export const SAVE_PARTICIPANT_BUDGET_MS = 1200;

/**
 * Checks a file out the moment you start typing in it, as Visual Studio does.
 *
 * ACCEPTED RISK: `onEdit` means a formatter or an extension performing a
 * workspace-wide edit will pend every file it touches. This is how the
 * workspace accumulated the 79,883 stray Adds that had to be cleaned up.
 * `tfvc.autoCheckout` is the escape hatch.
 */
export class AutoCheckout implements vscode.Disposable {
  /** One attempt per document per session — NOT one per keystroke. */
  private readonly attempted = new Set<string>();

  /**
   * Paths whose changes are OURS, with an expiry.
   *
   * Undo reverts the editor buffer, and a programmatic revert raises
   * onDidChangeTextDocument exactly like a keystroke — so auto-checkout
   * immediately checked the file out again and re-pended it, seconds after the
   * user confirmed they wanted it reverted. Observed on the real host as a
   * second `vc checkout` right after the undo.
   *
   * Time-boxed rather than a flag: the change event arrives asynchronously
   * after the revert resolves, so there is no single point at which it is safe
   * to clear.
   */
  private readonly suppressed = new Map<string, number>();

  /** Case-insensitive on Windows, where tf mixes `C:\work` and `c:\work`. */
  private static key(fsPath: string): string {
    return process.platform === 'win32' ? fsPath.toLowerCase() : fsPath;
  }

  /** Ignore changes to this path briefly: they are the extension's own. */
  suppress(fsPath: string, ms = 3000): void {
    this.suppressed.set(AutoCheckout.key(fsPath), Date.now() + ms);
  }

  private isSuppressed(fsPath: string): boolean {
    const until = this.suppressed.get(AutoCheckout.key(fsPath));
    if (until === undefined) return false;
    if (Date.now() > until) {
      this.suppressed.delete(AutoCheckout.key(fsPath));
      return false;
    }
    return true;
  }

  /**
   * The document version of each file's last edit that arrived while it was
   * still clean -- a reload from disk, or a first keystroke; see the
   * onDidChangeTextDocument handler for which.
   */
  private readonly cleanEdit = new Map<string, number>();

  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly client: TfClient,
    private readonly service: TfvcService,
    private readonly output: vscode.OutputChannel,
    private readonly mode: () => AutoCheckoutMode,
  ) {
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (this.mode() !== 'onEdit') return;
        const document = e.document;
        const key = AutoCheckout.key(document.uri.fsPath);
        // A get (Get Latest, Get This Version) that rewrites an OPEN, clean
        // file makes VS Code reload it, and the reload raises this event just
        // like a keystroke. Observed on FEDORA: the reload checked the file
        // out, and the next Get Latest hit a conflict. A reload leaves the
        // document clean; typing makes it dirty.
        //
        // But not in the same event. VS Code reports the FIRST keystroke into
        // a clean file with `isDirty: false` -- its document tracker reads the
        // flag before the file model sets it -- and then sends the new dirty
        // state as a separate event with no content changes (read from the
        // 1.139 workbench and extension-host bundles). Ignoring both meant a
        // single Enter never checked out. So an edit seen while clean is
        // remembered, and a dirty-state event at that same version is the
        // keystroke it was. A reload is never followed by one.
        if (e.contentChanges.length > 0) {
          if (document.isDirty) {
            void this.tryCheckout(document);
          } else {
            this.cleanEdit.set(key, document.version);
          }
          return;
        }
        if (document.isDirty && this.cleanEdit.get(key) === document.version) {
          this.cleanEdit.delete(key);
          void this.tryCheckout(document);
        }
      }),
    );

    this.disposables.push(
      vscode.workspace.onWillSaveTextDocument((e) => {
        if (this.mode() !== 'onSave') return;
        e.waitUntil(this.checkoutWithinSaveBudget(e.document));
      }),
    );

    this.disposables.push(
      vscode.workspace.onDidSaveTextDocument((doc) => this.reset(doc.uri.fsPath)),
    );
  }

  /**
   * Runs the checkout, but stops BLOCKING the save after a fixed budget.
   *
   * VS Code gives an `onWillSaveTextDocument` participant a limited time —
   * ~1.5 s — and then saves anyway. It also counts overruns and eventually
   * stops calling a participant that keeps missing, for the rest of the
   * session, with nothing shown to the user. A checkout under Wine regularly
   * takes longer than that.
   *
   * Both outcomes land in the same place: the save runs while the file is
   * still read-only, it fails, and VS Code answers with an **Overwrite**
   * action that clears the read-only bit and writes regardless. That is
   * `chmod u+w` instead of a checkout — the edit becomes invisible to TFVC —
   * offered by the editor itself, one click away, at the exact moment the user
   * is frustrated. See the hard rule in CLAUDE.md.
   *
   * So: bound the wait below VS Code's budget and say what happened, naming
   * Overwrite as the thing not to press. The checkout is NOT cancelled — it
   * usually lands a second later, which is why "save again" is the advice.
   */
  private async checkoutWithinSaveBudget(document: vscode.TextDocument): Promise<void> {
    const work = this.tryCheckout(document);
    // tryCheckout handles its own failures, but an unhandled rejection here
    // would be one VS Code counts against the participant. Belt and braces.
    work.catch(() => {});

    let timer: ReturnType<typeof setTimeout> | undefined;
    const overran = await Promise.race([
      work.then(() => false),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(true), SAVE_PARTICIPANT_BUDGET_MS);
      }),
    ]);
    // Without this the timer holds the event loop open for the full budget
    // after every fast save.
    if (timer) clearTimeout(timer);
    if (!overran) return;

    this.output.appendLine(
      `auto-checkout of ${document.uri.fsPath} did not finish within ` +
        `${SAVE_PARTICIPANT_BUDGET_MS}ms — VS Code will save anyway, and the save may fail`,
    );
    void vscode.window.showWarningMessage(
      S.saveParticipantOverran(document.fileName, SAVE_PARTICIPANT_BUDGET_MS),
    );
  }

  private async tryCheckout(document: vscode.TextDocument): Promise<void> {
    if (document.uri.scheme !== 'file') return;

    const fsPath = document.uri.fsPath;
    if (this.isSuppressed(fsPath)) {
      this.output.appendLine(`auto-checkout skipped for ${fsPath}: change was ours`);
      return;
    }
    if (this.attempted.has(AutoCheckout.key(fsPath))) return;
    if (!isReadOnly(fsPath)) return;

    const item = this.service.pathMapper?.toServerPath(fsPath);
    if (!item) return;

    // Do NOT clear the read-only bit on a document VS Code has already
    // mis-decoded. 66,678 of 79,929 items here are windows-1250, VS Code reads
    // them as UTF-8, and every undecodable byte is already U+FFFD in the
    // buffer. The read-only bit is the only thing preventing a save from
    // writing that loss back to disk; checking out removes it. See
    // encodingGuard.ts.
    if (wouldCorruptOnSave(document.getText())) {
      this.attempted.add(AutoCheckout.key(fsPath));
      const count = countReplacements(document.getText());
      this.output.appendLine(
        `refused auto-checkout of ${fsPath}: ${count} undecodable character(s) — see files.encoding`,
      );
      void vscode.window.showWarningMessage(
        S.encodingHazard(document.fileName, count),
        { modal: true },
      );
      return;
    }

    this.attempted.add(AutoCheckout.key(fsPath));

    // client.run resolves on a failed command but REJECTS when spawn throws
    // synchronously. In onEdit mode the call site is `void this.tryCheckout(...)`
    // with no .catch, so that became an unhandled rejection in the extension
    // host: nothing shown, `attempted` already set so nothing retries, and every
    // later save of the file failing with VS Code's generic read-only error. In
    // onSave mode it is a throwing save participant, which VS Code counts
    // against the listener until it stops calling it for the session.
    let result;
    try {
      result = await this.client.run(['vc', 'checkout', item]);
    } catch (e) {
      const detail = scrubSecrets(e instanceof Error ? e.message : String(e));
      this.output.appendLine(`auto-checkout of ${fsPath} could not start: ${detail}`);
      void vscode.window.showWarningMessage(
        `${S.autoCheckoutFailed(document.fileName)}\n\n${detail}`,
      );
      return;
    }

    if (result.timedOut) {
      this.output.appendLine(`auto-checkout of ${fsPath} timed out`);
      void vscode.window.showWarningMessage(S.commandTimedOut(this.client.timeoutMs));
      return;
    }

    const stdout = result.stdout.toString('utf8');
    const error = classifyError(result.exitCode, stdout, result.stderr.toString('utf8'));

    if (error) {
      this.output.appendLine(scrubSecrets(error.originalMessage));
      // One notification, then silence for this document until save or an
      // explicit checkout. Never one per keystroke.
      void vscode.window.showWarningMessage(
        `${S.autoCheckoutFailed(document.fileName)}\n\n${error.originalMessage}`,
      );
      return;
    }

    this.service.requestRefresh();
  }

  /**
   * Clears the guard for one document. Called from onDidSaveTextDocument and
   * from the explicit checkout/undo commands. Both matter: after a FAILED
   * auto-checkout the file stays read-only, so the save fails, so the save
   * event never fires - the explicit command is then the only way out.
   */
  reset(fsPath: string): void {
    this.attempted.delete(AutoCheckout.key(fsPath));
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}
