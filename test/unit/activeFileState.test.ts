import { describe, it, expect, beforeEach } from 'vitest';
import { ActiveFileState, ACTIVE_FILE_STATE_KEY } from '../../src/ui/ActiveFileState.js';
import { recorder, executed, hooks, Uri, EventEmitter } from '../vscode-mock.js';
import type { FileState } from '../../src/state/FileState.js';

/** Every value published for the key, in order. */
const published = () =>
  executed
    .filter((e) => e.id === 'setContext' && e.args[0] === ACTIVE_FILE_STATE_KEY)
    .map((e) => e.args[1]);

const source = (states: Record<string, FileState | undefined>) => ({
  stateOf: (p: string) => states[p],
});

const editorOn = (fsPath: string) => {
  recorder.activeTextEditor = { document: { uri: Uri.file(fsPath) } };
};

beforeEach(() => recorder.reset());

describe('ActiveFileState: the key the editor menu gates on', () => {
  it("publishes the active file's state as soon as it is built", () => {
    editorOn('C:/work/Vesta/Form1.vb');
    new ActiveFileState(source({ 'C:/work/Vesta/Form1.vb': 'versioned' }), []);
    expect(published()).toEqual(['versioned']);
  });

  it('publishes an empty string when no editor is active, so every gated entry hides', () => {
    new ActiveFileState(source({}), []);
    expect(published()).toEqual(['']);
  });

  it('publishes an empty string for an editor that is not a file', () => {
    recorder.activeTextEditor = { document: { uri: Uri.parse('untitled:Untitled-1') } };
    new ActiveFileState(source({ 'untitled:Untitled-1': 'versioned' }), []);
    expect(published()).toEqual(['']);
  });

  it('publishes an empty string for a file with no state (vanished)', () => {
    editorOn('C:/gone.vb');
    new ActiveFileState(source({}), []);
    expect(published()).toEqual(['']);
  });

  it('follows the active editor', () => {
    editorOn('C:/a.vb');
    new ActiveFileState(source({ 'C:/a.vb': 'versioned', 'C:/b.vb': 'checkedOut' }), []);
    editorOn('C:/b.vb');
    hooks.didChangeActiveTextEditor.emit(undefined);
    expect(published()).toEqual(['versioned', 'checkedOut']);
  });

  it('re-reads when a trigger fires, e.g. the status refresh after a checkout', () => {
    const states: Record<string, FileState> = { 'C:/a.vb': 'versioned' };
    const refreshed = new EventEmitter<void>();
    editorOn('C:/a.vb');
    new ActiveFileState(source(states), [refreshed.event as never]);
    states['C:/a.vb'] = 'checkedOut';
    refreshed.fire();
    expect(published()).toEqual(['versioned', 'checkedOut']);
  });

  it('does not re-send a value that did not change', () => {
    const refreshed = new EventEmitter<void>();
    editorOn('C:/a.vb');
    new ActiveFileState(source({ 'C:/a.vb': 'versioned' }), [refreshed.event as never]);
    refreshed.fire();
    hooks.didChangeActiveTextEditor.emit(undefined);
    expect(published()).toEqual(['versioned']);
  });

  it('stops listening once disposed', () => {
    const states: Record<string, FileState> = { 'C:/a.vb': 'versioned' };
    const refreshed = new EventEmitter<void>();
    editorOn('C:/a.vb');
    const active = new ActiveFileState(source(states), [refreshed.event as never]);
    active.dispose();
    states['C:/a.vb'] = 'checkedOut';
    refreshed.fire();
    hooks.didChangeActiveTextEditor.emit(undefined);
    expect(published()).toEqual(['versioned']);
  });
});
