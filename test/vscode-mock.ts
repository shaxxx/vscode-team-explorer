/**
 * A stand-in for the `vscode` module, aliased in vitest.config.ts.
 *
 * The command layer holds the decisions that matter most — whether Undo asks
 * before destroying edits, whether Add sends a path tf can actually resolve,
 * whether a spawn failure reaches the user — and none of it was reachable from
 * a test, because importing `vscode` outside the extension host throws. The
 * existing tests for this layer therefore assert on SOURCE TEXT, which passes
 * just as happily when the code is rearranged into something broken.
 *
 * This mock records what the extension showed and lets a test drive a command
 * the way VS Code would.
 */

export interface RecordedMessage {
  kind: 'warning' | 'error' | 'info';
  message: string;
  modal: boolean;
  items: string[];
}

class Recorder {
  readonly messages: RecordedMessage[] = [];
  readonly commands = new Map<string, (...args: unknown[]) => unknown>();
  /** Answers handed back from the next modal dialogs, in order. */
  readonly answers: (string | undefined)[] = [];
  activeTextEditor: { document: { uri: Uri } } | undefined = undefined;

  reset(): void {
    this.messages.length = 0;
    this.commands.clear();
    this.answers.length = 0;
    this.activeTextEditor = undefined;
    hooks.reset();
    executed.length = 0;
    shown.length = 0;
    workspace.textDocuments = [];
    for (const k of Object.keys(configValues)) delete configValues[k];
    quickPicks.length = 0;
    quickPickAnswers.length = 0;
    inputBoxes.length = 0;
    clipboard.text = '';
    openedExternally.length = 0;
  }

  /** Runs a registered command exactly as VS Code would dispatch it. */
  async invoke(id: string, ...args: unknown[]): Promise<unknown> {
    const handler = this.commands.get(id);
    if (!handler) throw new Error(`command not registered: ${id}`);
    return await handler(...args);
  }

  get shown(): string[] {
    return this.messages.map((m) => m.message);
  }
}

export const recorder = new Recorder();

/** Documents passed to showTextDocument. */
export const shown: unknown[] = [];

/** Every showInputBox call: its options, so a test can drive `validateInput` directly. */
export const inputBoxes: { options: Record<string, unknown> }[] = [];

function show(kind: RecordedMessage['kind']) {
  return (message: string, ...rest: unknown[]): Promise<string | undefined> => {
    const options = (typeof rest[0] === 'object' && rest[0] !== null ? rest[0] : {}) as {
      modal?: boolean;
      detail?: string;
    };
    const items = rest.filter((r): r is string => typeof r === 'string');
    recorder.messages.push({
      kind,
      // The detail carries the count and the warning; a test that could not
      // see it would pass on a dialog that said nothing.
      message: options.detail ? `${message}\n${options.detail}` : message,
      modal: options.modal === true,
      items,
    });
    return Promise.resolve(recorder.answers.shift());
  };
}

export class Uri {
  private constructor(
    readonly fsPath: string,
    readonly scheme = 'file',
    readonly query = '',
    /** Real VS Code keeps a separate `path`; versioned URIs (phase 2) are read by it. */
    readonly path: string = fsPath,
  ) {}
  static file(fsPath: string): Uri {
    return new Uri(fsPath);
  }
  static parse(value: string): Uri {
    return new Uri(value, value.split(':')[0]);
  }
  static from(components: { scheme: string; path?: string; query?: string }): Uri {
    return new Uri(components.path ?? '', components.scheme, components.query ?? '', components.path ?? '');
  }
  static joinPath(base: Uri, ...segments: string[]): Uri {
    return Uri.file([base.fsPath, ...segments].join('/'));
  }
  /**
   * ServerContentProvider.uriFor uses this to switch to the `teamExplorer:`
   * scheme (TFVC_SCHEME),
   * and to tag the Compare variant with a query so it gets its own text model.
   */
  with(change: { scheme?: string; query?: string }): Uri {
    return new Uri(this.fsPath, change.scheme ?? this.scheme, change.query ?? this.query, this.path);
  }
  toString(): string {
    // `parse` stores the ORIGINAL string as `fsPath` (there is no real
    // authority/path split in this mock), so re-prefixing `scheme://` here
    // would double it for anything built via `Uri.parse` (e.g.
    // `https://example.com` becoming `https://https://example.com`). Only
    // `file()`/`from()`/`with()` need the prefix synthesised; a value already
    // starting with `${scheme}:` (as `parse`'s always does) is returned as is.
    if (this.fsPath.startsWith(`${this.scheme}:`)) {
      return `${this.fsPath}${this.query ? `?${this.query}` : ''}`;
    }
    return `${this.scheme}://${this.fsPath}${this.query ? `?${this.query}` : ''}`;
  }
}

export const ViewColumn = { Active: -1, Beside: -2, One: 1 } as const;

export interface MockWebviewPanel {
  viewType: string;
  title: string;
  options: Record<string, unknown>;
  webview: {
    html: string;
    cspSource: string;
    posted: unknown[];
    options: Record<string, unknown>;
    asWebviewUri(uri: Uri): Uri;
    postMessage(message: unknown): Promise<boolean>;
    onDidReceiveMessage(handler: (message: unknown) => unknown): { dispose(): void };
  };
  revealed: number;
  disposed: boolean;
  /** Delivers a message as if the page's script had posted it, and waits for the handler. */
  receive(message: unknown): Promise<void>;
  reveal(): void;
  onDidDispose(handler: () => void): { dispose(): void };
  dispose(): void;
}

/** Every webview panel created this session, newest last. */
export const createdPanels: MockWebviewPanel[] = [];

function createWebviewPanel(
  viewType: string,
  title: string,
  _column: unknown,
  options: Record<string, unknown> = {},
): MockWebviewPanel {
  const receivers: ((message: unknown) => unknown)[] = [];
  const disposers: (() => void)[] = [];
  const posted: unknown[] = [];
  const panel: MockWebviewPanel = {
    viewType,
    title,
    options,
    revealed: 0,
    disposed: false,
    webview: {
      html: '',
      cspSource: 'mock-csp-source',
      posted,
      options: {},
      asWebviewUri: (uri) => uri,
      postMessage: (message) => {
        // Real VS Code throws on a disposed webview's postMessage. Without
        // this, a dropped `if (this.disposed) return` guard anywhere in the
        // glue (e.g. an in-flight fetch's `finally`, or a details-fetch
        // debounce timer) would go unnoticed by a test.
        if (panel.disposed) throw new Error('postMessage called on a disposed webview');
        posted.push(message);
        return Promise.resolve(true);
      },
      onDidReceiveMessage: (handler) => {
        receivers.push(handler);
        return {
          dispose: () => {
            const i = receivers.indexOf(handler);
            if (i >= 0) receivers.splice(i, 1);
          },
        };
      },
    },
    async receive(message) {
      await Promise.all(receivers.map((h) => h(message)));
    },
    reveal() {
      panel.revealed++;
    },
    onDidDispose(handler) {
      disposers.push(handler);
      return { dispose() {} };
    },
    dispose() {
      if (panel.disposed) return;
      panel.disposed = true;
      for (const h of disposers) h();
    },
  };
  createdPanels.push(panel);
  return panel;
}

export class Range {
  constructor(
    readonly startLine: number,
    readonly startCharacter: number,
    readonly endLine: number,
    readonly endCharacter: number,
  ) {}
}

export const DecorationRangeBehavior = { OpenOpen: 0, ClosedClosed: 1, OpenClosed: 2, ClosedOpen: 3 } as const;
export const ProgressLocation = { SourceControl: 1, Window: 10, Notification: 15 } as const;

export class MarkdownString {
  value = '';
  isTrusted: boolean | { enabledCommands: readonly string[] } | undefined;
  /** Every append, in order, so a test can prove server text went in as TEXT. */
  readonly parts: { kind: 'text' | 'markdown'; value: string }[] = [];
  appendText(value: string): this {
    this.parts.push({ kind: 'text', value });
    this.value += value;
    return this;
  }
  appendMarkdown(value: string): this {
    this.parts.push({ kind: 'markdown', value });
    this.value += value;
    return this;
  }
}

export interface MockDecorationType {
  options: unknown;
  disposed: boolean;
  dispose(): void;
}
export const createdDecorationTypes: MockDecorationType[] = [];

export interface MockProgressRun {
  options: { title?: string; cancellable?: boolean };
  reports: unknown[];
  /** Presses the notification's Cancel button. */
  cancel(): void;
}
export const progressRuns: MockProgressRun[] = [];

/** Every showQuickPick call: its items (awaited) and options. */
export const quickPicks: { items: unknown[]; options: unknown }[] = [];
/**
 * What the next showQuickPick calls return, in order. A function receives the
 * items and returns the pick; anything else is returned as it is.
 */
export const quickPickAnswers: unknown[] = [];
/** Serializers registered with registerWebviewPanelSerializer, by view type. */
export const panelSerializers = new Map<string, unknown>();
/** Tree data providers registered with registerTreeDataProvider, by view id. */
export const treeProviders = new Map<string, unknown>();
/** What env.clipboard.writeText last wrote. */
export const clipboard = { text: '' };
/** URIs passed to env.openExternal, as strings. */
export const openedExternally: string[] = [];
export const env = {
  clipboard: {
    writeText: (text: string) => {
      clipboard.text = text;
      return Promise.resolve();
    },
  },
  openExternal: (uri: unknown) => {
    openedExternally.push(String(uri));
    return Promise.resolve(true);
  },
};

function withProgress<T>(
  options: { title?: string; cancellable?: boolean },
  task: (
    progress: { report(value: unknown): void },
    token: { isCancellationRequested: boolean; onCancellationRequested(h: () => void): { dispose(): void } },
  ) => Promise<T>,
): Promise<T> {
  const handlers: (() => void)[] = [];
  const token = {
    isCancellationRequested: false,
    onCancellationRequested(h: () => void) {
      handlers.push(h);
      return { dispose() {} };
    },
  };
  const run: MockProgressRun = {
    options,
    reports: [],
    cancel() {
      token.isCancellationRequested = true;
      for (const h of [...handlers]) h();
    },
  };
  progressRuns.push(run);
  return task({ report: (value) => void run.reports.push(value) }, token);
}

/** Every hover provider registered this session, so a test can drive one directly. */
export interface MockHoverProvider {
  provideHover(document: unknown, position: unknown, token?: unknown): unknown;
}
export const hoverProviders: MockHoverProvider[] = [];

export const languages = {
  registerHoverProvider(_selector: unknown, provider: MockHoverProvider) {
    hoverProviders.push(provider);
    return {
      dispose: () => {
        const i = hoverProviders.indexOf(provider);
        if (i !== -1) hoverProviders.splice(i, 1);
      },
    };
  },
};

export class Hover {
  constructor(
    readonly contents: unknown,
    readonly range?: unknown,
  ) {}
}

/** Phase 2 D19d: the tab kinds Annotate checks a document's URI against. */
export class TabInputText {
  constructor(readonly uri: Uri) {}
}
export class TabInputTextDiff {
  constructor(
    readonly original: Uri,
    readonly modified: Uri,
  ) {}
}

export interface MockTab {
  input: unknown;
}
export interface MockTabGroup {
  tabs: readonly MockTab[];
}

export const window = {
  showWarningMessage: show('warning'),
  showErrorMessage: show('error'),
  showInformationMessage: show('info'),
  showInputBox: (options?: Record<string, unknown>) => {
    inputBoxes.push({ options: options ?? {} });
    return Promise.resolve(recorder.answers.shift());
  },
  showTextDocument: (doc: unknown) => {
    shown.push(doc);
    return Promise.resolve({ document: doc });
  },
  visibleTextEditors: [] as unknown[],
  createOutputChannel: (_name: string) => outputChannel,
  // Wrapped rather than referenced directly: `window` is declared above
  // `hooks`, so reading it eagerly here is a temporal-dead-zone throw at import
  // and every test in the file fails with an unrelated message.
  onDidChangeWindowState: (h: (e: { focused: boolean }) => void) =>
    hooks.didChangeWindowState.register(h),
  onDidChangeActiveTextEditor: (h: (e: unknown) => void) =>
    hooks.didChangeActiveTextEditor.register(h),
  state: { focused: true },
  get activeTextEditor() {
    return recorder.activeTextEditor;
  },
  registerFileDecorationProvider(provider: unknown) {
    decorationProviders.push(provider);
    return {
      dispose: () => {
        const i = decorationProviders.indexOf(provider);
        if (i !== -1) decorationProviders.splice(i, 1);
      },
    };
  },
  createWebviewPanel,
  showQuickPick: async (items: unknown, options?: unknown) => {
    const list = (await items) as unknown[];
    quickPicks.push({ items: list, options });
    const answer = quickPickAnswers.shift();
    return typeof answer === 'function' ? (answer as (l: unknown[]) => unknown)(list) : answer;
  },
  registerWebviewPanelSerializer(viewType: string, serializer: unknown) {
    panelSerializers.set(viewType, serializer);
    return { dispose: () => void panelSerializers.delete(viewType) };
  },
  registerTreeDataProvider(id: string, provider: unknown) {
    treeProviders.set(id, provider);
    return { dispose: () => void treeProviders.delete(id) };
  },
  createTextEditorDecorationType(options: unknown): MockDecorationType {
    const type: MockDecorationType = {
      options,
      disposed: false,
      dispose() {
        type.disposed = true;
      },
    };
    createdDecorationTypes.push(type);
    return type;
  },
  withProgress,
  onDidChangeVisibleTextEditors: (h: (e: unknown) => void) => hooks.didChangeVisibleTextEditors.register(h),
  /** Phase 2 D19d: minimal enough for Annotate to find which documents still have a tab open. */
  tabGroups: {
    all: [] as readonly MockTabGroup[],
    onDidChangeTabs: (h: (e: unknown) => void) => hooks.didChangeTabs.register(h),
  },
};

export const outputChannel = {
  lines: [] as string[],
  appendLine(line: string) {
    this.lines.push(line);
  },
  append(_v: string) {},
  show() {},
  dispose() {},
  clear() {
    this.lines.length = 0;
  },
  name: 'tfvc',
  replace(_v: string) {},
  hide() {},
};

/** Commands the extension asked VS Code to run, for assertions. */
export const executed: { id: string; args: unknown[] }[] = [];

export const commands = {
  registerCommand(id: string, handler: (...args: unknown[]) => unknown) {
    recorder.commands.set(id, handler);
    return { dispose: () => recorder.commands.delete(id) };
  },
  executeCommand: (id: string, ...args: unknown[]) => {
    executed.push({ id, args });
    return Promise.resolve(undefined);
  },
};

/**
 * Hooks the tests fire to drive the classes that clear the read-only bit.
 * Without these, `new AutoCheckout(...)` and `new ReadOnlyWatcher(...)` throw
 * under test, which is why that whole composition was uncovered.
 */
class Hook<T> {
  private handlers: ((e: T) => void)[] = [];
  readonly register = (h: (e: T) => void) => {
    this.handlers.push(h);
    return { dispose: () => void (this.handlers = this.handlers.filter((x) => x !== h)) };
  };
  emit(e: T): void {
    for (const h of [...this.handlers]) h(e);
  }
  get count(): number {
    return this.handlers.length;
  }
  clear(): void {
    this.handlers = [];
  }
}

export const hooks = {
  didChangeWindowState: new Hook<{ focused: boolean }>(),
  didChangeActiveTextEditor: new Hook<unknown>(),
  didChangeTextDocument: new Hook<unknown>(),
  willSaveTextDocument: new Hook<unknown>(),
  didSaveTextDocument: new Hook<unknown>(),
  didOpenTextDocument: new Hook<unknown>(),
  fsDidChange: new Hook<Uri>(),
  fsDidCreate: new Hook<Uri>(),
  fsDidDelete: new Hook<Uri>(),
  didChangeConfiguration: new Hook<{ affectsConfiguration(s: string): boolean }>(),
  didChangeVisibleTextEditors: new Hook<unknown>(),
  didCloseTextDocument: new Hook<unknown>(),
  didChangeTabs: new Hook<unknown>(),
  willRenameFiles: new Hook<{ files: readonly { oldUri: Uri; newUri: Uri }[] }>(),
  didRenameFiles: new Hook<{ files: readonly { oldUri: Uri; newUri: Uri }[] }>(),
  willDeleteFiles: new Hook<{ files: readonly Uri[] }>(),
  didDeleteFiles: new Hook<{ files: readonly Uri[] }>(),
  reset(): void {
    for (const h of Object.values(this)) if (h instanceof Hook) h.clear();
    createdWatchers.length = 0;
    // Neither of these is a Hook, so the loop above misses them. Nothing else
    // cleared `decorationProviders` between tests in the same file, which is
    // harmless only as long as every reader uses a relative count rather than
    // an absolute one.
    decorationProviders.length = 0;
    createdEmitters.length = 0;
    createdPanels.length = 0;
    createdDecorationTypes.length = 0;
    progressRuns.length = 0;
    hoverProviders.length = 0;
    window.tabGroups.all = [];
  },
};

/** Every FileSystemWatcher built, so a test can prove none leaked. */
export const createdWatchers: { disposed: boolean }[] = [];

export class RelativePattern {
  constructor(readonly base: unknown, readonly pattern: string) {}
}

export const workspace = {
  getConfiguration: (section?: string) => ({
    // Real VS Code substitutes the default ONLY when the stored value is
    // `undefined` -- `null`, `false` and `0` are all legitimate settings
    // values and must come back unchanged. `??` here used to coerce every one
    // of those into the default too, which let a test believe it was
    // exercising a `null` setting when this mock had already thrown it away
    // before the code under test ever saw it.
    get: <T>(key: string, d?: T): T | undefined => {
      const value = configValues[section ? `${section}.${key}` : key];
      return value === undefined ? d : (value as T);
    },
  }),
  onDidChangeConfiguration: hooks.didChangeConfiguration.register,
  onDidChangeTextDocument: hooks.didChangeTextDocument.register,
  onWillSaveTextDocument: hooks.willSaveTextDocument.register,
  onDidSaveTextDocument: hooks.didSaveTextDocument.register,
  onDidOpenTextDocument: hooks.didOpenTextDocument.register,
  textDocuments: [] as { uri: Uri }[],
  workspaceFolders: undefined as unknown,
  createFileSystemWatcher(_pattern: unknown) {
    const w = {
      disposed: false,
      onDidChange: hooks.fsDidChange.register,
      onDidCreate: hooks.fsDidCreate.register,
      onDidDelete: hooks.fsDidDelete.register,
      dispose() {
        this.disposed = true;
      },
    };
    createdWatchers.push(w);
    return w;
  },
  registerTextDocumentContentProvider: () => ({ dispose() {} }),
  onDidCloseTextDocument: hooks.didCloseTextDocument.register,
  onWillRenameFiles: hooks.willRenameFiles.register,
  onDidRenameFiles: hooks.didRenameFiles.register,
  onWillDeleteFiles: hooks.willDeleteFiles.register,
  onDidDeleteFiles: hooks.didDeleteFiles.register,
  openTextDocument: async (uri: Uri) =>
    workspace.textDocuments.find((d) => d.uri.fsPath === uri.fsPath) ?? { uri, getText: () => '' },
};

/** Values returned by workspace.getConfiguration().get(), set by tests. */
export const configValues: Record<string, unknown> = {};

/**
 * Drive the handlers an extension registered, as VS Code would.
 *
 * `affectsConfiguration` here matches the changed key or any ancestor section
 * of it, which is the part of the real behaviour these tests depend on. It is
 * an approximation and is not claimed to be exact.
 */
export function fireConfigChange(changedKey: string): void {
  hooks.didChangeConfiguration.emit({
    affectsConfiguration: (s) => changedKey === s || changedKey.startsWith(`${s}.`),
  });
}

/** What a test needs to see of an EventEmitter it did not build itself. */
export interface CreatedEmitter {
  disposed: boolean;
}

/**
 * Every EventEmitter constructed this session, so a test can prove one was
 * disposed -- the same role `createdWatchers` plays for FileSystemWatcher.
 */
export const createdEmitters: CreatedEmitter[] = [];

export class EventEmitter<T> {
  private handlers: ((e: T) => void)[] = [];
  disposed = false;
  event = (h: (e: T) => void) => {
    this.handlers.push(h);
    return { dispose: () => void (this.handlers = this.handlers.filter((x) => x !== h)) };
  };
  constructor() {
    createdEmitters.push(this);
  }
  fire(e: T) {
    for (const h of [...this.handlers]) h(e);
  }
  dispose() {
    this.disposed = true;
    this.handlers = [];
  }
}

export interface MockResourceGroup {
  id: string;
  label: string;
  hideWhenEmpty: boolean;
  resourceStates: unknown[];
  dispose(): void;
}

export interface MockSourceControl {
  count: number;
  inputBox: { value: string; placeholder: string };
  quickDiffProvider: unknown;
  /** VS Code binds Ctrl+Enter in the SCM input to this. It must stay unset. */
  acceptInputCommand: unknown;
  groups: Map<string, MockResourceGroup>;
  createResourceGroup(id: string, label: string): MockResourceGroup;
  dispose(): void;
}

export const scm = {
  /** The most recently created SourceControl, for assertions. */
  last: undefined as MockSourceControl | undefined,
  createSourceControl(_id: string, _label: string, _root?: Uri): MockSourceControl {
    const control: MockSourceControl = {
      count: 0,
      inputBox: { value: '', placeholder: '' },
      quickDiffProvider: undefined,
      acceptInputCommand: undefined,
      groups: new Map(),
      createResourceGroup(id: string, label: string): MockResourceGroup {
        const group: MockResourceGroup = {
          id,
          label,
          hideWhenEmpty: false,
          resourceStates: [],
          dispose() {},
        };
        control.groups.set(id, group);
        return group;
      },
      dispose() {},
    };
    scm.last = control;
    return control;
  },
};

export const ThemeIcon = class {
  constructor(public id: string) {}
};
export const Disposable = class {
  constructor(private fn: () => void) {}
  dispose() {
    this.fn();
  }
};

export class ThemeColor {
  constructor(readonly id: string) {}
}

/**
 * Mirrors the real class closely enough to catch the failure that matters.
 *
 * `FileDecoration.validate` in VS Code's extHostTypes.ts throws on a badge
 * longer than two grapheme clusters, and extHostDecorations.ts catches that and
 * discards the ENTIRE decoration -- badge, colour and tooltip -- leaving only a
 * line in the extension-host log. A double that accepted such a badge would let
 * a decoration ship that silently never renders.
 *
 * The real check uses grapheme-cluster length; this uses code-point length,
 * which agrees for every badge in this codebase and is stricter for combining
 * marks. It is an approximation and is not claimed to be exact.
 */
export class FileDecoration {
  propagate?: boolean;
  constructor(
    readonly badge?: string,
    readonly tooltip?: string,
    readonly color?: ThemeColor,
  ) {
    if (typeof badge === 'string' && [...badge].length > 2) {
      throw new Error(`The 'badge'-property must be undefined or a short character`);
    }
    if (!color && !badge && !tooltip) {
      throw new Error('The decoration is empty');
    }
  }
}

/** Every provider registered this session, so a test can drive one. */
export const decorationProviders: unknown[] = [];
