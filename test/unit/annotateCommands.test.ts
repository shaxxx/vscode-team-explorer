import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerAnnotate } from '../../src/commands/annotate.js';
import { recorder, workspace, shown, Uri } from '../vscode-mock.js';
import { S } from '../../src/tf/strings.js';

let dir: string;

function harness() {
  const annotated: unknown[] = [];
  const hidden: unknown[] = [];
  const annotator = {
    annotate: async (doc: unknown) => void annotated.push(doc),
    hide: (uri: unknown) => void hidden.push(uri),
    dispose() {},
  };
  const context = { subscriptions: [] as { dispose(): void }[] };
  registerAnnotate(context as never, annotator as never);
  return { annotated, hidden, context };
}

beforeEach(() => {
  recorder.reset();
  dir = mkdtempSync(join(tmpdir(), 'tfvc-annotate-'));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('the Annotate commands', () => {
  it('opens the file, shows it, and annotates it', async () => {
    const h = harness();
    const file = join(dir, 'a.vb');
    writeFileSync(file, 'x');
    const doc = { uri: Uri.file(file), getText: () => 'x' };
    workspace.textDocuments = [doc];
    await recorder.invoke('teamExplorer.annotate', Uri.file(file));
    expect(shown).toEqual([doc]);
    expect(h.annotated).toEqual([doc]);
  });

  it('refuses a folder', async () => {
    const h = harness();
    await recorder.invoke('teamExplorer.annotate', Uri.file(dir));
    expect(recorder.shown).toContain(S.annotateFolder);
    expect(h.annotated).toEqual([]);
  });

  it('says why when VS Code cannot open the file as text (a binary picked in the Explorer)', async () => {
    const h = harness();
    const file = join(dir, 'till.ico');
    writeFileSync(file, 'x');
    const open = workspace.openTextDocument;
    workspace.openTextDocument = async (uri: { toString(): string }) => {
      throw new Error(`cannot open ${uri.toString()}. Detail: File seems to be binary and cannot be opened as text`);
    };
    try {
      await recorder.invoke('teamExplorer.annotate', Uri.file(file));
    } finally {
      workspace.openTextDocument = open;
    }
    expect(recorder.shown).toContain(
      S.annotateCannotOpen('till.ico', 'File seems to be binary and cannot be opened as text'),
    );
    expect(shown).toEqual([]);
    expect(h.annotated).toEqual([]);
  });

  it('shows the whole error when VS Code gives no detail', async () => {
    harness();
    const file = join(dir, 'big.vb');
    writeFileSync(file, 'x');
    const open = workspace.openTextDocument;
    workspace.openTextDocument = async () => {
      throw new Error('too large');
    };
    try {
      await recorder.invoke('teamExplorer.annotate', Uri.file(file));
    } finally {
      workspace.openTextDocument = open;
    }
    expect(recorder.shown).toContain(S.annotateCannotOpen('big.vb', 'too large'));
  });

  it('says so when there is no target at all', async () => {
    harness();
    await recorder.invoke('teamExplorer.annotate');
    expect(recorder.shown).toContain(S.noTarget);
  });

  it('hides the target, or the active editor when invoked from the palette', async () => {
    const h = harness();
    const uri = Uri.file(join(dir, 'b.vb'));
    await recorder.invoke('teamExplorer.hideAnnotations', uri);
    recorder.activeTextEditor = { document: { uri } };
    await recorder.invoke('teamExplorer.hideAnnotations');
    expect(h.hidden).toEqual([uri, uri]);
  });

  it('disposes the annotator with the extension', () => {
    const h = harness();
    expect(h.context.subscriptions).toHaveLength(3);
  });
});
