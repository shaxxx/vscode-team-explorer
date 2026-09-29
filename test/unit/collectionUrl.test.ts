import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { activate } from '../../src/extension.js';
import { S, INSTALL_GUIDE_URL } from '../../src/tf/strings.js';
import { recorder, workspace, configValues, executed, openedExternally, Uri } from '../vscode-mock.js';

/** A minimal vscode.ExtensionContext: just enough for activate() to run. */
function fakeExtensionContext() {
  const state = new Map<string, unknown>();
  return {
    subscriptions: [] as { dispose(): void }[],
    workspaceState: {
      get: (k: string, d?: unknown) => (state.has(k) ? state.get(k) : d),
      update: async (k: string, v: unknown) => {
        if (v === undefined) state.delete(k);
        else state.set(k, v);
      },
    },
    secrets: { get: async () => undefined, store: async () => {}, delete: async () => {} },
  };
}

const flush = () => new Promise((r) => setImmediate(r));

describe('no collection URL configured', () => {
  let context: ReturnType<typeof fakeExtensionContext>;

  beforeEach(() => {
    recorder.reset();
    workspace.workspaceFolders = [{ uri: Uri.file(tmpdir()), name: 'folder', index: 0 }] as never;
    // If anything ran tf, this missing wrapper would produce an ERROR message.
    configValues['teamExplorer.wrapperPath'] = join(tmpdir(), 'tfvc-collection-url-no-such-wrapper');
    context = fakeExtensionContext();
  });

  afterEach(() => {
    for (const d of context.subscriptions) d.dispose();
    workspace.workspaceFolders = undefined;
  });

  it('shows one warning with Open Settings, and runs no tf', async () => {
    await activate(context as never);
    await flush();

    const warnings = recorder.messages.filter((m) => m.kind === 'warning');
    expect(warnings.map((m) => m.message)).toEqual([S.noCollectionUrl]);
    expect(warnings[0].items).toEqual([S.openSettings]);
    expect(recorder.messages.filter((m) => m.kind === 'error')).toEqual([]);
  });

  it('Open Settings opens the collection URL setting', async () => {
    recorder.answers.push(S.openSettings);
    await activate(context as never);
    await flush();

    expect(executed).toContainEqual({ id: 'workbench.action.openSettings', args: ['teamExplorer.collectionUrl'] });
  });

  it('treats a URL of only spaces as empty', async () => {
    configValues['teamExplorer.collectionUrl'] = '   ';
    await activate(context as never);
    await flush();

    expect(recorder.messages.map((m) => m.message)).toEqual([S.noCollectionUrl]);
  });

  it('Manage Workspace asks for the URL instead of running tf', async () => {
    await activate(context as never);
    await flush();
    await recorder.invoke('teamExplorer.manageWorkspace');

    expect(recorder.messages.map((m) => m.message)).toEqual([S.noCollectionUrl, S.noCollectionUrl]);
    expect(recorder.messages.filter((m) => m.kind === 'error')).toEqual([]);
  });

  it('shows the warning even in an empty window (no folder open) -- a first-time install must not say nothing', async () => {
    workspace.workspaceFolders = undefined;
    await activate(context as never);
    await flush();

    const warnings = recorder.messages.filter((m) => m.kind === 'warning');
    expect(warnings.map((m) => m.message)).toEqual([S.noCollectionUrl]);
    expect(warnings[0].items).toEqual([S.openSettings]);
    expect(recorder.commands.has('teamExplorer.manageWorkspace')).toBe(true);
  });

  it('treats a hand-edited non-string value (e.g. a number) as empty, without rejecting activate()', async () => {
    configValues['teamExplorer.collectionUrl'] = 42;
    await activate(context as never);
    await flush();

    expect(recorder.messages.map((m) => m.message)).toEqual([S.noCollectionUrl]);
  });
});

describe('a missing wrapper at activation', () => {
  let context: ReturnType<typeof fakeExtensionContext>;

  beforeEach(() => {
    recorder.reset();
    workspace.workspaceFolders = [{ uri: Uri.file(tmpdir()), name: 'folder', index: 0 }] as never;
    configValues['teamExplorer.collectionUrl'] = 'https://example.visualstudio.com/';
    configValues['teamExplorer.wrapperPath'] = join(tmpdir(), 'tfvc-activation-no-such-wrapper');
    context = fakeExtensionContext();
  });

  afterEach(() => {
    for (const d of context.subscriptions) d.dispose();
    workspace.workspaceFolders = undefined;
  });

  it('offers Open Settings and Install Guide', async () => {
    await activate(context as never);
    await flush();

    const error = recorder.messages.find((m) => m.kind === 'error');
    expect(error?.message).toContain(S.wrapperMissing);
    expect(error?.items).toEqual([S.openSettings, S.installGuide]);
  });

  it('Install Guide opens the guide on GitHub', async () => {
    recorder.answers.push(S.installGuide);
    await activate(context as never);
    await flush();
    await flush();

    expect(openedExternally).toEqual([INSTALL_GUIDE_URL]);
  });

  it('Open Settings opens the wrapper path setting', async () => {
    recorder.answers.push(S.openSettings);
    await activate(context as never);
    await flush();
    await flush();

    expect(executed).toContainEqual({ id: 'workbench.action.openSettings', args: ['teamExplorer.wrapperPath'] });
  });
});
