import * as vscode from 'vscode';
import { basename } from 'node:path';
import type { HistoryService } from '../history/HistoryService.js';
import type { VersionStore } from '../history/VersionStore.js';
import type { PathMapper } from '../tf/PathMapper.js';
import { isBinary, type PendingChange } from '../tf/types.js';
import type { Changeset } from '../tf/parseHistory.js';
import { ENC_BINARY } from '../ui/decode.js';
import { scrubSecrets } from '../tf/TfClient.js';
import { S } from '../tf/strings.js';
import { splitLines, type Owner } from './blame.js';
import { lineMap } from './remap.js';
import { needsOwnCodePage, runBlame, versionsOf, type VersionRef } from './walk.js';
import { COMPARE_VERSIONS, SHOW_CHANGESET, commandLink, hoverParts, marginLabels } from './margin.js';

/** The context key the editor menu reads to offer Annotate or Hide Annotations. */
export const ANNOTATED_KEY = 'teamExplorer.annotated';
/** Debounce, in ms, before annotate remaps after a text edit. */
export const REMAP_DEBOUNCE_MS = 300;
/**
 * D17c: progress renders are coalesced to at most one per this interval --
 * the first draws at once, later ones within the window are folded into one
 * trailing draw. A heavily-edited buffer used to re-diff on every one of a
 * walk's progress ticks (~300ms each, ~82s over a 300-version walk); this
 * bounds how often that diff (and the decoration conversion VS Code does per
 * render) can happen while a walk is filling in.
 */
export const RENDER_INTERVAL_MS = 100;

export interface AnnotatorDeps {
  history: Pick<HistoryService, 'all'>;
  versions: Pick<VersionStore, 'textAt' | 'codePageAt'>;
  mapper: () => PathMapper | undefined;
  changeFor: (serverPath: string) => PendingChange | undefined;
  log: (line: string) => void;
}

interface Session {
  readonly key: string;
  readonly serverPath: string;
  readonly name: string;
  readonly abort: AbortController;
  baseLines: string[];
  owners: Owner[];
  versions: VersionRef[];
  readonly changesets: Map<number, Changeset>;
  readonly hovers: Map<number, vscode.MarkdownString>;
  /** Debounces a remap after a text edit. */
  editTimer?: ReturnType<typeof setTimeout>;
  /**
   * D21: set when a content change arrived with the document reported NOT
   * dirty and no undo/redo reason -- the shape D19e used to hide on at once.
   * That shape is ambiguous on its own (see `onDidChangeTextDocument` below),
   * so the actual judgment is deferred to the debounced render in `schedule`,
   * where the document's settled state can be read.
   */
  suspectReload?: boolean;
  /** D17c: coalesces the walk's progress renders. */
  renderTimer?: ReturnType<typeof setTimeout>;
  /** D19c: the END of the last draw, so the next wait is measured from when the work actually finished. */
  lastRenderAt?: number;
  /** D19c: how long that last draw itself took; the next wait is at least twice this. */
  lastDrawMs?: number;
  /**
   * D19b: the owners actually last drawn for this document, indexed by
   * buffer line -- what the hover provider answers from, so it never needs to
   * recompute or re-diff just to answer a hover.
   */
  lastDrawnOwners?: Owner[];
  /**
   * D17b: `lineMap(baseLines, buffer)` depends only on the base version and
   * the buffer, not on how much of `owners` the walk has filled in yet, so a
   * progress render that only has new owners to show can reuse it. Recomputed
   * only when the document's `version` or `baseLines` itself (a new array,
   * fed once per walk) has changed.
   */
  mapCache?: { version: number | undefined; baseLines: readonly string[]; map: number[] };
}

/** A refusal found mid-walk: an information message, not an error. */
class Refused extends Error {}

/**
 * D15: a Cancel that lands before any version was folded ends the session
 * quietly -- no message, margin hidden, context key false. Distinguished from
 * `Refused` (which always shows a message) and from any other Error (which
 * shows one via showErrorMessage): this one shows nothing.
 */
class Cancelled extends Error {}

function refusalFor(change: PendingChange | undefined, name: string): string | undefined {
  if (!change) return undefined;
  if (change.changes.has('Add')) return S.annotatePendingAdd(name);
  if (change.changes.has('Delete')) return S.annotatePendingDelete(name);
  if (change.changes.has('Rename') || change.changes.has('SourceRename')) return S.annotatePendingRename(name);
  if (isBinary(change)) return S.annotateBinary(name);
  return undefined;
}

/**
 * Who changed each line, drawn as a margin on the user's own editor.
 *
 * Off means zero work (D5): no decoration type, no listener and no tf until a
 * document is annotated, and all of it dropped again when the last one is
 * hidden. The work itself is in the pure modules beside this one; this class
 * only keeps sessions, listens, and draws.
 */
export class Annotator implements vscode.Disposable {
  private readonly sessions = new Map<string, Session>();
  private decoration: vscode.TextEditorDecorationType | undefined;
  private hoverProvider: vscode.Disposable | undefined;
  private listeners: vscode.Disposable[] = [];
  private lastContext: boolean | undefined;

  constructor(private readonly deps: AnnotatorDeps) {}

  async annotate(document: vscode.TextDocument): Promise<void> {
    const key = document.uri.toString();
    if (this.sessions.has(key)) return;
    const name = basename(document.uri.fsPath);

    const mapper = this.deps.mapper();
    const serverPath = document.uri.scheme === 'file' ? mapper?.toServerPath(document.uri.fsPath) : undefined;
    if (!mapper || !serverPath) {
      void vscode.window.showWarningMessage(S.noWorkspaceMapping);
      return;
    }
    const refusal = refusalFor(this.deps.changeFor(serverPath), name);
    if (refusal) {
      void vscode.window.showInformationMessage(refusal);
      return;
    }

    const session: Session = {
      key,
      serverPath,
      name,
      abort: new AbortController(),
      baseLines: [],
      owners: [],
      versions: [],
      changesets: new Map(),
      hovers: new Map(),
    };
    this.sessions.set(key, session);
    this.attach();
    this.updateContext();
    this.render(session); // the "…" margin at once, so it is clear something started

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: S.annotating(name), cancellable: true },
      async (progress, token) => {
        token.onCancellationRequested(() => session.abort.abort());
        try {
          await this.walk(session, mapper.toWinePath(document.uri.fsPath), (done, total) =>
            progress.report({ message: `${done}/${total}` }),
          );
        } catch (e) {
          if (this.sessions.get(key) !== session) return;
          // D15/D17e: quiet on a Cancel that landed before anything was known,
          // and quiet on ANY error once the session is aborted -- the user
          // already asked to stop, so a real failure that only surfaces after
          // (e.g. a history fetch that was raced against the abort and lost,
          // then rejected for a genuine reason) is noise, not news.
          if (e instanceof Cancelled || session.abort.signal.aborted) {
            this.hide(document.uri);
            return;
          }
          if (e instanceof Refused) void vscode.window.showInformationMessage(e.message);
          else {
            const reason = scrubSecrets(e instanceof Error ? e.message : String(e));
            this.deps.log(`annotate: ${session.name} failed: ${reason}`);
            void vscode.window.showErrorMessage(reason);
          }
          this.hide(document.uri);
        }
      },
    );
  }

  hide(uri: vscode.Uri): void {
    this.hideByKey(uri.toString());
  }

  /** D19d: lets `hideClosedTabs` hide a session by its own key, with no Uri to reconstruct from a string. */
  private hideByKey(key: string): void {
    const session = this.sessions.get(key);
    if (!session) return;
    session.abort.abort();
    this.clearTimers(session);
    this.sessions.delete(key);
    const decoration = this.decoration;
    if (decoration) for (const editor of this.editorsOf(key)) editor.setDecorations(decoration, []);
    if (this.sessions.size === 0) this.detach();
    this.updateContext();
  }

  dispose(): void {
    for (const session of this.sessions.values()) {
      session.abort.abort();
      this.clearTimers(session);
    }
    this.sessions.clear();
    this.detach();
  }

  /** D5/D17c: nothing -- neither the edit debounce nor the render coalescer -- is left running once a session ends. */
  private clearTimers(session: Session): void {
    if (session.editTimer) clearTimeout(session.editTimer);
    if (session.renderTimer) clearTimeout(session.renderTimer);
  }

  private async walk(
    session: Session,
    tfLocalPath: string,
    report: (done: number, total: number) => void,
  ): Promise<void> {
    // F5: up to the WORKSPACE version -- the one the user's file is based on.
    // D17d: raced against the abort so a slow (or held, in a test) history
    // fetch can never delay Hide/Cancel -- the notification closes at once
    // and the page in flight, whenever it lands, is simply ignored (its own
    // promise is left to settle on its own; `history.all` itself is not, and
    // must not be, cancelled -- only NEW tf is refused after this point).
    const historyAll = this.deps.history.all(
      { mode: 'file', itemspec: tfLocalPath },
      { workspace: true, signal: session.abort.signal },
    );
    historyAll.catch(() => {}); // never surfaces as an unhandled rejection when the abort wins the race below
    const changesets = await Promise.race([historyAll, this.whenAborted(session).then(() => [] as Changeset[])]);
    // D15: history.all() returns what it has on abort, so a Cancel during the
    // history fetch can land here with an empty (or partial) list -- that is
    // NOT "no history", it is a cancel, and must stay quiet rather than say so.
    if (session.abort.signal.aborted) throw new Cancelled();
    for (const cs of changesets) session.changesets.set(cs.id, cs);
    session.versions = versionsOf(changesets);
    if (session.versions.length === 0) throw new Refused(S.annotateNoHistory(session.name));

    const base = session.versions[0];
    const own = needsOwnCodePage(session.versions);
    // D17d: after Hide/Cancel/close/dispose, no code path here may start a
    // NEW tf. A fetch already running (TfClient.run takes no signal and is
    // not changed) finishes on its own and its result is still cached -- a
    // known limit -- but nothing further may be kicked off from here on.
    const guardAbort = (): void => {
      if (session.abort.signal.aborted) throw new Error(`annotate: ${session.name} aborted`);
    };
    let baseCodePage: Promise<number | undefined> | undefined;
    const codePageOfBase = () => {
      guardAbort();
      return (baseCodePage ??= this.deps.versions.codePageAt(base.serverPath, base.id));
    };
    const textOf = async (version: VersionRef): Promise<string> => {
      guardAbort();
      const i = session.versions.indexOf(version);
      const codePage =
        i > 0 && own[i]
          ? () => {
              guardAbort();
              return this.deps.versions.codePageAt(version.serverPath, version.id);
            }
          : codePageOfBase;
      const got = await this.deps.versions.textAt(version.serverPath, version.id, codePage);
      // Known from the cache or the one `info` call: refusing a binary costs no extra tf.
      if (i === 0 && got.codePage === ENC_BINARY) throw new Refused(S.annotateBinary(session.name));
      return got.text;
    };

    const result = await runBlame({
      versions: session.versions,
      textOf,
      signal: session.abort.signal,
      onProgress: (p) => {
        session.baseLines = p.baseLines;
        session.owners = p.owners;
        report(p.done, p.total);
        // D17c: coalesced, not drawn on every progress tick.
        this.scheduleRender(session);
      },
    });
    if (this.sessions.get(session.key) !== session) return;
    // D15: a Cancel before even the newest version was folded leaves nothing
    // to show -- quiet, like the history-fetch case above, not a warning.
    if (result.stoppedBy === 'cancelled' && result.owners.length === 0) throw new Cancelled();
    if (result.owners.length > 0) {
      session.baseLines = result.baseLines;
      session.owners = result.owners;
    }
    // D17c: the walk's final state is drawn exactly once, synchronously --
    // `render` cancels any still-pending coalesced timer itself, so this
    // never races a trailing draw that was already queued.
    this.render(session);
    // Cancel is the user's choice and needs no message; a failed fetch does.
    if (result.stoppedBy instanceof Error) {
      const reason = scrubSecrets(result.stoppedBy.message);
      // D17f: a stop (fetch failure or D11 give-up) is worth one log line,
      // scrubbed the same way the message shown to the user is.
      this.deps.log(`annotate: ${session.name} stopped at C${session.versions[result.done]?.id}: ${reason}`);
      void vscode.window.showWarningMessage(S.annotateStopped(session.name, reason));
    }
  }

  /** Resolves once `session` is aborted, already or later (D17d). */
  private whenAborted(session: Session): Promise<void> {
    return new Promise((resolve) => {
      if (session.abort.signal.aborted) {
        resolve();
        return;
      }
      session.abort.signal.addEventListener('abort', () => resolve(), { once: true });
    });
  }

  private attach(): void {
    if (this.decoration) return;
    this.decoration = vscode.window.createTextEditorDecorationType({
      before: {
        color: new vscode.ThemeColor('editorLineNumber.foreground'),
        backgroundColor: new vscode.ThemeColor('editorWidget.background'),
        margin: '0 1.5em 0 0',
        fontStyle: 'normal',
        fontWeight: 'normal',
      },
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    });
    // D19b: hovers come from this provider, not from the decorations
    // themselves -- registered and disposed with the rest of D5's "off means
    // zero work" set.
    this.hoverProvider = vscode.languages.registerHoverProvider(
      { scheme: 'file' },
      { provideHover: (document, position) => this.provideHover(document, position) },
    );
    this.listeners = [
      vscode.workspace.onDidChangeTextDocument((e) => {
        // D17c: a save or a dirty-flag flip reports no content changes at
        // all; there is nothing to remap and nothing worth a render.
        if (e.contentChanges.length === 0) return;
        const key = e.document.uri.toString();
        const session = this.sessions.get(key);
        if (!session) return;
        // D19e/D21: content changed, the document is NOT dirty, and this was
        // not an undo/redo. That USED to mean only one thing -- the file
        // changing under VS Code's feet (a Get, an Undo run from Team
        // Explorer/tf itself, or another program) -- and was hidden at once.
        // But VS Code sends this exact shape for the FIRST edit of a clean
        // document too (traced in 1.138: the main thread reads `isDirty`
        // before the text-file model marks itself dirty; a separate event
        // with no content changes flips it moments later), and EncodingFixer
        // re-decoding a just-opened document looks the same. So this only
        // marks the session suspect; `schedule`'s debounced render below is
        // what actually judges it, once the document's settled state --
        // dirty, or matching the base again -- is known.
        if (!e.document.isDirty && e.reason === undefined) session.suspectReload = true;
        this.schedule(key);
      }),
      vscode.window.onDidChangeVisibleTextEditors(() => {
        for (const session of this.sessions.values()) this.render(session);
      }),
      vscode.window.onDidChangeActiveTextEditor(() => this.updateContext()),
      vscode.workspace.onDidCloseTextDocument((d) => this.hide(d.uri)),
      // D19d: the Explorer route can open and annotate a document the user
      // never gave focus to, and VS Code keeps such a model alive for up to
      // 3 minutes after its last tab closes -- without this, the walk (and,
      // now, the hover provider's per-document answers) would keep going for
      // a document nothing shows any more.
      vscode.window.tabGroups.onDidChangeTabs(() => this.hideClosedTabs()),
    ];
  }

  private detach(): void {
    for (const listener of this.listeners) listener.dispose();
    this.listeners = [];
    this.hoverProvider?.dispose();
    this.hoverProvider = undefined;
    // Disposing the type also clears it from every editor it was set on.
    this.decoration?.dispose();
    this.decoration = undefined;
  }

  /** D19d: hides every session whose document no longer has a tab open anywhere. */
  private hideClosedTabs(): void {
    const open = new Set<string>();
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const input = tab.input;
        if (input instanceof vscode.TabInputText) open.add(input.uri.toString());
        else if (input instanceof vscode.TabInputTextDiff) {
          open.add(input.modified.toString());
          open.add(input.original.toString());
        }
      }
    }
    for (const key of [...this.sessions.keys()]) {
      if (!open.has(key)) this.hideByKey(key);
    }
  }

  private schedule(key: string): void {
    const session = this.sessions.get(key);
    if (!session) return;
    if (session.editTimer) clearTimeout(session.editTimer);
    session.editTimer = setTimeout(() => {
      session.editTimer = undefined;
      // D21: a change arrived earlier that LOOKED like a reload (not dirty,
      // no reason) -- judge it now, from the document's settled state,
      // instead of the shape of that one event.
      if (session.suspectReload) {
        session.suspectReload = false;
        const document = vscode.workspace.textDocuments.find((d) => d.uri.toString() === session.key);
        if (document && !document.isDirty) {
          const lines = splitLines(document.getText());
          const matchesBase =
            lines.length === session.baseLines.length && lines.every((line, i) => line === session.baseLines[i]);
          // Still not dirty, and the text no longer matches the base: a real
          // reload (a Get, an Undo run outside this document, another
          // program). Still not dirty but UNCHANGED from the base: an
          // EncodingFixer re-decode or a TFVC Undo back to the workspace
          // version -- render as usual, nothing to warn about.
          if (!matchesBase) {
            this.hide(document.uri);
            void vscode.window.showInformationMessage(S.annotateReloaded(session.name));
            return;
          }
        }
        // Dirty by now (the first-edit sequence) or a matching re-decode:
        // fall through to the ordinary render below.
      }
      this.render(session);
    }, REMAP_DEBOUNCE_MS);
  }

  /**
   * D17c/D19c: throttles the walk's progress renders, trailing edge included
   * -- the first call in a burst draws at once, later ones land within one
   * already-queued trailing timer that reads whatever the session holds when
   * it fires. The wait is measured from the END of the last draw (D19c), and
   * is at least twice as long as that draw itself took: a slow draw (many
   * blocks, a big file) must not be re-triggered before it could plausibly
   * have finished twice over. Measuring from the START, as before, let a slow
   * draw's own duration alone satisfy the flat `RENDER_INTERVAL_MS` gap by the
   * time it returned, so the very next progress tick drew again at once --
   * back to back, no throttling at all, for exactly the files where it
   * mattered most.
   */
  private scheduleRender(session: Session): void {
    if (session.renderTimer) return; // a trailing render is already queued
    const wait = Math.max(RENDER_INTERVAL_MS, 2 * (session.lastDrawMs ?? 0));
    const elapsed = Date.now() - (session.lastRenderAt ?? -Infinity);
    if (elapsed >= wait) {
      this.render(session);
      return;
    }
    session.renderTimer = setTimeout(() => {
      session.renderTimer = undefined;
      this.render(session);
    }, wait - elapsed);
  }

  private editorsOf(key: string): readonly vscode.TextEditor[] {
    return vscode.window.visibleTextEditors.filter((e) => e.document.uri.toString() === key);
  }

  private render(session: Session): void {
    const decoration = this.decoration;
    if (this.sessions.get(session.key) !== session || !decoration) return;
    // Any actual draw supersedes a still-pending coalesced one (D17c): this
    // is what lets the walk's own final render, called directly rather than
    // through `scheduleRender`, guarantee the final state is drawn exactly
    // once even when a trailing progress render was already queued.
    if (session.renderTimer) {
      clearTimeout(session.renderTimer);
      session.renderTimer = undefined;
    }
    const editors = this.editorsOf(session.key);
    if (editors.length === 0) return;
    const start = Date.now();
    // D17c: the buffer, the remap and the decoration options are identical
    // for every editor of this document -- built ONCE, not once per editor.
    const document = editors[0].document;
    const buffer = splitLines(document.getText());
    const owners: Owner[] =
      session.baseLines.length === 0
        ? buffer.map((): Owner => ({ kind: 'pending' }))
        : this.remapped(session, document, buffer);
    // D19b: kept on the session so the hover provider can answer from
    // whatever was actually drawn, without recomputing or re-diffing anything.
    session.lastDrawnOwners = owners;
    const labels = marginLabels(owners, (id) => session.changesets.get(id)?.user);
    // D19b: decorations carry NO hoverMessage any more -- the hover provider
    // answers instead. VS Code converts and serialises a hoverMessage per
    // decoration it is given, and a hover on every line of a 20,000-line file
    // (every line, once every block's line got one -- D19b answers for any
    // line of a block, not just its first) cost ~0.55s and ~30MB per render.
    const options = labels.map((label, line) => ({
      range: new vscode.Range(line, 0, line, 0),
      renderOptions: { before: { contentText: label } },
    }));
    for (const editor of editors) editor.setDecorations(decoration, options);
    // D19c: measured from the END of this draw, and how long the draw itself
    // took is kept so the NEXT wait can scale with it.
    session.lastRenderAt = Date.now();
    session.lastDrawMs = session.lastRenderAt - start;
  }

  /**
   * D17b: `lineMap` depends only on `session.baseLines` (fixed for the whole
   * walk) and the buffer -- not on how many owners the walk has filled in --
   * so it is cached per document version and re-diffed only when the
   * document changed (a new `version`) or a new walk started (a new
   * `baseLines` array). A progress render that only has new owners to show
   * reuses the cached map outright.
   */
  private remapped(session: Session, document: vscode.TextDocument, buffer: string[]): Owner[] {
    const cache = session.mapCache;
    const map =
      cache && cache.version === document.version && cache.baseLines === session.baseLines
        ? cache.map
        : lineMap(session.baseLines, buffer);
    session.mapCache = { version: document.version, baseLines: session.baseLines, map };
    return map.map((i): Owner => (i === -1 ? { kind: 'local' } : (session.owners[i] ?? { kind: 'pending' })));
  }

  /**
   * D19b: the hover provider registered while any session exists. Answers
   * from the owners actually last drawn for this document -- never
   * recomputing or re-diffing just to answer a hover -- at character 0 of
   * ANY line of a block (not only the line that carries the label), which is
   * what supersedes D17a: every line of a block gets its hover now, because
   * the cost D17a was avoiding (VS Code serialising a hoverMessage per
   * decoration) no longer applies once hovers come from here instead.
   */
  private provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
    const session = this.sessions.get(document.uri.toString());
    if (!session) return undefined;
    // The margin label sits before column 0; past it is the user's own code,
    // whose own hover (if any) must be left alone.
    if (position.character !== 0) return undefined;
    const owner = session.lastDrawnOwners?.[position.line];
    if (!owner || owner.kind !== 'changeset') return undefined;
    const md = this.hoverFor(session, owner);
    return md ? new vscode.Hover(md) : undefined;
  }

  private hoverFor(session: Session, owner: Owner): vscode.MarkdownString | undefined {
    if (owner.kind !== 'changeset') return undefined;
    const cached = session.hovers.get(owner.id);
    if (cached) return cached;
    const cs = session.changesets.get(owner.id);
    if (!cs) return undefined;
    const i = session.versions.findIndex((v) => v.id === owner.id);
    const parts = hoverParts(
      cs,
      session.serverPath,
      i >= 0 ? session.versions[i] : undefined,
      i >= 0 ? session.versions[i + 1] : undefined,
    );
    const md = new vscode.MarkdownString();
    // Server text goes in as TEXT: a comment containing Markdown or a command
    // link must never become one.
    md.appendText(parts.heading);
    md.appendMarkdown('\n\n');
    if (parts.body) {
      md.appendText(parts.body);
      md.appendMarkdown('\n\n');
    }
    md.appendMarkdown(parts.links.map((l) => `[${l.label}](${commandLink(l)})`).join(' · '));
    md.isTrusted = { enabledCommands: [SHOW_CHANGESET, COMPARE_VERSIONS] };
    session.hovers.set(owner.id, md);
    return md;
  }

  private updateContext(): void {
    const active = vscode.window.activeTextEditor?.document.uri.toString();
    const value = active !== undefined && this.sessions.has(active);
    if (value === this.lastContext) return;
    this.lastContext = value;
    void vscode.commands.executeCommand('setContext', ANNOTATED_KEY, value);
  }
}
