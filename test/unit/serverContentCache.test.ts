import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  ServerContentProvider,
  CONTENT_CACHE_TTL_MS,
} from '../../src/ui/ServerContentProvider.js';
import { PathMapper } from '../../src/tf/PathMapper.js';
import { Uri } from '../vscode-mock.js';

/**
 * Measured on FEDORA: VS Code re-requests a `tfvc:` document every time the
 * editor tab is re-activated, and each request was a fresh `tf vc view`. Under
 * Wine that is 5.4 s, so clicking back onto a checked-out file's tab froze its
 * gutter for five seconds. On Windows the same call is ~900 ms and nobody
 * noticed.
 */

const mapper = () =>
  new PathMapper([{ serverItem: '$/Vesta', localPath: 'C:\\work\\Vesta' }], 'win32');

function build(opts: { body?: string; exitCode?: number } = {}) {
  const runs: string[][] = [];
  const client = {
    timeoutMs: 1000,
    run: async (args: string[]) => {
      runs.push(args);
      return {
        stdout: Buffer.from(opts.body ?? 'server copy'),
        stderr: Buffer.alloc(0),
        exitCode: opts.exitCode ?? 0,
        timedOut: false,
      };
    },
  };
  const provider = new ServerContentProvider(
    client as never,
    mapper as never,
    () => 65001,
  );
  return { provider, runs };
}

const uri = ServerContentProvider.uriFor('C:\\work\\Vesta\\A.vb') as unknown as Uri;
const views = (runs: string[][]) => runs.filter((a) => a.includes('view')).length;

afterEach(() => vi.useRealTimers());

describe('ServerContentProvider content cache', () => {
  it('fetches once for repeated reads of the same item', async () => {
    const { provider, runs } = build();

    await provider.provideTextDocumentContent(uri as never);
    await provider.provideTextDocumentContent(uri as never);
    await provider.provideTextDocumentContent(uri as never);

    expect(views(runs), 'every tab switch spawned tf again').toBe(1);
  });

  it('returns the same content, not just fewer calls', async () => {
    // A cache that returns the wrong thing is worse than no cache.
    const { provider } = build({ body: 'Option Strict On' });

    const first = await provider.provideTextDocumentContent(uri as never);
    const second = await provider.provideTextDocumentContent(uri as never);

    expect(first).toBe('Option Strict On');
    expect(second).toBe(first);
  });

  it('re-fetches once the entry is older than the TTL', async () => {
    // Someone else checking in is invisible to us, so the entry must expire.
    vi.useFakeTimers();
    const { provider, runs } = build();

    await provider.provideTextDocumentContent(uri as never);
    vi.advanceTimersByTime(CONTENT_CACHE_TTL_MS + 1);
    await provider.provideTextDocumentContent(uri as never);

    expect(views(runs)).toBe(2);
  });

  it('does NOT cache a failure', async () => {
    // A transient PAT rejection or a timeout must not be remembered as the
    // server's content for the next minute.
    const { provider, runs } = build({ exitCode: 100, body: 'TF30063: not authorized' });

    await expect(provider.provideTextDocumentContent(uri as never)).rejects.toThrow();
    await expect(provider.provideTextDocumentContent(uri as never)).rejects.toThrow();

    expect(views(runs), 'a failure was cached as content').toBe(2);
  });

  it('invalidate() drops one item and leaves the others', async () => {
    const { provider, runs } = build();
    const other = ServerContentProvider.uriFor('C:\\work\\Vesta\\B.vb');

    await provider.provideTextDocumentContent(uri as never);
    await provider.provideTextDocumentContent(other as never);
    provider.invalidate('$/Vesta/A.vb');
    await provider.provideTextDocumentContent(uri as never);
    await provider.provideTextDocumentContent(other as never);

    expect(views(runs), 'B was dropped too, or A was not').toBe(3);
  });

  it('invalidate() with no argument drops everything', async () => {
    const { provider, runs } = build();

    await provider.provideTextDocumentContent(uri as never);
    provider.invalidate();
    await provider.provideTextDocumentContent(uri as never);

    expect(views(runs)).toBe(2);
  });
});
