import * as vscode from 'vscode';
import { TfClient, classifyError, scrubSecrets } from '../tf/TfClient.js';
import type { PathMapper } from '../tf/PathMapper.js';
import { S } from '../tf/strings.js';

export { decodeWithCodePage } from './decode.js';
import { decodeWithCodePage, parseInfoEncoding } from './decode.js';

export const TFVC_SCHEME = 'teamExplorer';

/**
 * Serves the server's copy of a file under the `teamExplorer:` scheme
 * (TFVC_SCHEME above). It was `tfvc:` before the namespace rename and two
 * comments still said so, which is how a decoration test ended up driving a
 * scheme this extension can never emit.
 *
 * `view /console` is byte-transparent — verified md5-identical across the
 * local file, native Windows, and Wine — so we read a Buffer and decode using
 * the code page the caller supplies, never a guessed one.
 */
/**
 * How long a fetched server copy stays usable.
 *
 * `view /version:T` only changes when somebody CHECKS IN, which our own status
 * refreshes cannot see. A check-in from this extension invalidates the entry
 * outright; the TTL is what bounds the window for a check-in made elsewhere.
 */
export const CONTENT_CACHE_TTL_MS = 60_000;

/**
 * Marks a versioned URI: `teamExplorer:/$/<path>?v=C<n>`.
 *
 * The digit count is capped at 10 (D14): TFVC changeset ids are int32, so
 * 2147483647 (10 digits) is the largest legitimate one. Without the cap, a
 * 24-digit query string parsed as a Number rounds to `1e+23`, which then
 * reaches tf verbatim as `/version:C1e+23`. The explicit MAX_CHANGESET check
 * below still rejects the 10-digit values above 2147483647 that the regex
 * alone lets through.
 */
const VERSION_QUERY = /^v=C([1-9]\d{0,9})$/;

/** TFVC changeset ids are int32 (D14). */
const MAX_CHANGESET = 2147483647;

/**
 * Characters no TFVC item name can hold (D14). Without this, a crafted
 * `teamExplorer:/$/Shop/*?v=C1` reached tf as a wildcard `vc view` instead of
 * naming one file.
 */
const FORBIDDEN_PATH_CHARS = /[*?"|<>:;\\\u0000-\u001f\u007f]/;

/** The query of the empty side of a compare: an add has nothing before it, a delete nothing after. */
const EMPTY_QUERY = 'empty';

/**
 * Characters a shelveset name, owner or date must not carry into tf: `;`
 * would split the `name;owner` itemspec, and a quote or a control character
 * cannot cross cmd.exe intact.
 */
const FORBIDDEN_SHELVED_CHARS = /[;"\u0000-\u001f\u007f]/;

/** Shelved text is kept per URI; each one is small, and a review opens a few dozen at most. */
const SHELVED_CACHE_MAX = 50;

/** A file as it is in a shelveset. */
export interface ShelvedRef {
  serverPath: string;
  shelveset: string;
  /** `owneruniq`, as a `name;owner` itemspec takes it. */
  owner: string;
  /**
   * The shelveset's date. `/replace` changes a shelveset's content under the
   * same name (S5), so unlike a changeset its name alone does not identify
   * the content, and the date is part of every cache key.
   */
  date: string;
  /** `enc` from the shelveset's own details; absent means UTF-8. */
  codePage?: number;
}

export class ServerContentProvider implements vscode.TextDocumentContentProvider {
  /** Code pages resolved via `tf vc info`, so a diff costs one extra call once. */
  private readonly encodingCache = new Map<string, number | undefined>();

  /**
   * Server copies already fetched.
   *
   * VS Code re-requests this document every time the editor tab is
   * re-activated, and each request was a fresh `tf vc view`. On Windows that
   * is ~900 ms and passes unnoticed. On FEDORA it is 5.4 s, measured, so
   * simply clicking back onto a checked-out file's tab froze its gutter for
   * five seconds - twice in the log that showed this up.
   */
  private readonly contentCache = new Map<string, { content: string; at: number }>();

  /** Shelved copies, keyed by the whole URI -- which carries the shelveset's date (see ShelvedRef). */
  private readonly shelvedCache = new Map<string, string>();

  /**
   * Drops cached copies. Called after a check-in, which is the one thing this
   * extension does that changes what `/version:T` resolves to.
   *
   * Note the limit: this only affects FUTURE reads. A diff already open holds
   * VS Code's own copy of the document, and refreshing that needs an
   * onDidChange event this provider does not yet raise - the pre-existing
   * staleness gap recorded in the acceptance checklist.
   */
  invalidate(serverItem?: string): void {
    if (serverItem === undefined) this.contentCache.clear();
    else this.contentCache.delete(serverItem);
  }

  constructor(
    private readonly client: TfClient,
    private readonly mapper: () => PathMapper | undefined,
    private readonly encodingFor: (serverItem: string) => number | undefined,
    /**
     * Content of a server path at one changeset, for the History tab and
     * Annotate. Optional so the existing call sites and tests keep compiling;
     * extension.ts always wires it.
     */
    private readonly versionText?: (serverPath: string, changeset: number) => Promise<string>,
    /**
     * A shelved file's text, for the Shelvesets tab's Compare and View (phase
     * 4). Optional like `versionText`; extension.ts wires it to ShelveService.
     */
    private readonly shelvedText?: (ref: ShelvedRef) => Promise<string>,
  ) {}

  /**
   * The `tfvc:` URI for a local path.
   *
   * `variant` exists because the gutter bars and the Compare command are two
   * DIFFERENT consumers of the same server copy, and VS Code keeps one text
   * model per URI. Handing both the same URI meant that opening Compare on a
   * file that was already open - so QuickDiff had already caused a model to be
   * created for the bars - failed outright:
   *
   *   ModelService: Cannot add model because it already exists!
   *
   * and the editor showed "The editor could not be opened due to an unexpected
   * error", with nothing in our own log, because the provider was never even
   * called. Observed on DEVPC against a pending, open .sql file; a file that
   * was not open compared fine, which is what made it look file-specific.
   *
   * The query is invisible to `fsPath`, so the provider still resolves the same
   * server item, and the content cache still serves both from one `tf vc view`.
   */
  static uriFor(localPath: string, variant?: 'compare'): vscode.Uri {
    const base = vscode.Uri.file(localPath).with({ scheme: TFVC_SCHEME });
    return variant ? base.with({ query: variant }) : base;
  }

  /**
   * A file as of one changeset. The path ends in the real file name, so VS
   * Code picks the right language mode, and it is the SERVER path: a version
   * from before a rename lives under a name the workspace may not map.
   */
  static versionUri(serverPath: string, changeset: number): vscode.Uri {
    return vscode.Uri.from({ scheme: TFVC_SCHEME, path: `/${serverPath}`, query: `v=C${changeset}` });
  }

  static parseVersionUri(uri: { path: string; query: string }): { serverPath: string; changeset: number } | undefined {
    const match = VERSION_QUERY.exec(uri.query);
    if (!match || !uri.path.startsWith('/$/')) return undefined;
    const changeset = Number(match[1]);
    if (changeset > MAX_CHANGESET) return undefined;
    const serverPath = uri.path.slice(1);
    if (FORBIDDEN_PATH_CHARS.test(serverPath)) return undefined;
    return { serverPath, changeset };
  }

  static shelvedUri(ref: ShelvedRef): vscode.Uri {
    const query = new URLSearchParams({ s: ref.shelveset, o: ref.owner, d: ref.date });
    if (ref.codePage !== undefined) query.set('c', String(ref.codePage));
    return vscode.Uri.from({ scheme: TFVC_SCHEME, path: `/${ref.serverPath}`, query: query.toString() });
  }

  static parseShelvedUri(uri: { path: string; query: string }): ShelvedRef | undefined {
    if (!uri.path.startsWith('/$/') || uri.query === EMPTY_QUERY) return undefined;
    const query = new URLSearchParams(uri.query);
    const shelveset = query.get('s');
    const owner = query.get('o');
    const date = query.get('d');
    if (!shelveset || !owner || !date) return undefined;
    if ([shelveset, owner, date].some((v) => FORBIDDEN_SHELVED_CHARS.test(v))) return undefined;
    const serverPath = uri.path.slice(1);
    if (FORBIDDEN_PATH_CHARS.test(serverPath)) return undefined;
    const c = query.get('c');
    if (c !== null && !/^-?\d{1,5}$/.test(c)) return undefined;
    return { serverPath, shelveset, owner, date, ...(c !== null ? { codePage: Number(c) } : {}) };
  }

  static emptyUri(serverPath: string): vscode.Uri {
    return vscode.Uri.from({ scheme: TFVC_SCHEME, path: `/${serverPath}`, query: EMPTY_QUERY });
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const version = ServerContentProvider.parseVersionUri(uri);
    if (version) {
      // Same rule as below: throw, never return '' -- an empty document reads
      // as "this version was empty".
      if (!this.versionText) throw new Error(S.versionUnavailable);
      return this.versionText(version.serverPath, version.changeset);
    }

    if (uri.query === EMPTY_QUERY && uri.path.startsWith('/$/')) return '';

    const shelved = ServerContentProvider.parseShelvedUri(uri);
    if (shelved) {
      // Throw, never return '': see below.
      if (!this.shelvedText) throw new Error(S.versionUnavailable);
      const key = `${uri.path}?${uri.query}`;
      const hit = this.shelvedCache.get(key);
      if (hit !== undefined) return hit;
      const content = await this.shelvedText(shelved);
      this.shelvedCache.set(key, content);
      if (this.shelvedCache.size > SHELVED_CACHE_MAX) {
        const oldest = this.shelvedCache.keys().next().value;
        if (oldest !== undefined) this.shelvedCache.delete(oldest);
      }
      return content;
    }

    const serverItem = this.mapper()?.toServerPath(uri.fsPath);
    // THROW, never return ''. VS Code renders a rejection as a visible editor
    // error; an empty string renders as an empty server file, so every line of
    // the local file shows as newly added and the user concludes the file does
    // not exist on the server. An expired PAT, a timeout, and a refused
    // itemspec all landed here.
    if (!serverItem) throw new Error(S.noWorkspaceMapping);

    const hit = this.contentCache.get(serverItem);
    if (hit && Date.now() - hit.at < CONTENT_CACHE_TTL_MS) return hit.content;

    const result = await this.client.run(['vc', 'view', serverItem, '/console', '/version:T']);

    if (result.timedOut) throw new Error(S.commandTimedOut(this.client.timeoutMs));

    const error = classifyError(
      result.exitCode,
      result.stdout.toString('utf8'),
      result.stderr.toString('utf8'),
    );
    if (error) throw new Error(scrubSecrets(error.originalMessage));

    // Cached only on SUCCESS. Every failure above throws, so a transient PAT
    // rejection or a timeout must not be remembered as the server's content
    // for the next minute.
    const content = decodeWithCodePage(result.stdout, await this.codePageFor(serverItem));
    this.contentCache.set(serverItem, { content, at: Date.now() });
    return content;
  }

  /**
   * The pending-changes cache knows `enc` only for items that are PENDING.
   * Compare with Latest Version deliberately works on files with no pending
   * change — which is the majority case, and exactly the one where this
   * returned undefined and the content was decoded as UTF-8. Against the
   * 66,678 windows-1250 items here that renders every Croatian letter as
   * U+FFFD, on the server side of a diff, with nothing to signal it.
   *
   * `tf vc info` reports the code page for any item, pending or not.
   */
  private async codePageFor(serverItem: string): Promise<number | undefined> {
    const known = this.encodingFor(serverItem);
    if (known !== undefined) return known;

    const cached = this.encodingCache.get(serverItem);
    if (cached !== undefined || this.encodingCache.has(serverItem)) return cached;

    let resolved: number | undefined;
    try {
      const info = await this.client.run(['vc', 'info', serverItem]);
      if (info.exitCode === 0) {
        resolved = parseInfoEncoding(info.stdout.toString('utf8'));
      }
    } catch {
      resolved = undefined;
    }

    this.encodingCache.set(serverItem, resolved);
    return resolved;
  }
}
