import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HistoryService, HistoryError, HISTORY_PAGE } from '../../src/history/HistoryService.js';
import { S } from '../../src/tf/strings.js';

const fixture = (name: string): Buffer => readFileSync(join(__dirname, '../fixtures/windows', name));

interface Reply {
  stdout?: string | Buffer;
  stderr?: string;
  exitCode?: number;
  timedOut?: boolean;
  /** The signal that killed tf, when the reply simulates one (D12). */
  terminatedBy?: NodeJS.Signals;
  rejects?: Error;
}

function fakeClient(replies: Reply[]) {
  const runs: string[][] = [];
  const client = {
    timeoutMs: 1234,
    run: async (args: string[]) => {
      runs.push(args);
      const r = replies.shift() ?? {};
      if (r.rejects) throw r.rejects;
      return {
        stdout: Buffer.isBuffer(r.stdout) ? r.stdout : Buffer.from(r.stdout ?? '', 'utf8'),
        stderr: Buffer.from(r.stderr ?? '', 'utf8'),
        exitCode: r.exitCode ?? 0,
        timedOut: r.timedOut ?? false,
        terminatedBy: r.terminatedBy,
      };
    },
  };
  return { client, runs };
}

// SYNTHETIC: n records, newest first, starting at `top`.
function records(top: number, n: number): string {
  const sep = '-'.repeat(79);
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    out.push(sep, `Changeset: ${top - i}`, 'User: A', 'Date: d', '', 'Comment:', '', 'Items:', '  edit $/A/b.vb', '');
  }
  return out.join('\r\n');
}

describe('HistoryService argv', () => {
  it('asks for a file with /itemmode, which follows renames (F9), and pins the item so a range past a rename still finds it (D12)', () => {
    expect(HistoryService.pageArgs({ mode: 'file', itemspec: '$/A/b.vb' })).toEqual([
      'vc', 'history', '$/A/b.vb;T', '/format:detailed', `/stopafter:${HISTORY_PAGE}`, '/itemmode',
    ]);
  });

  it('asks for a folder with /recursive and NEVER /itemmode, which tf ignores there (F10), pinned like a file (D12)', () => {
    expect(HistoryService.pageArgs({ mode: 'folder', itemspec: '$/A' })).toEqual([
      'vc', 'history', '$/A;T', '/recursive', '/format:detailed', `/stopafter:${HISTORY_PAGE}`,
    ]);
  });

  it('pins a local itemspec with ;W, not ;T (D12)', () => {
    expect(HistoryService.pageArgs({ mode: 'file', itemspec: 'C:\\work\\A\\b.vb' })).toContain('C:\\work\\A\\b.vb;W');
  });

  it('pages with a changeset range and stops at the workspace version with /version:W', () => {
    expect(HistoryService.pageArgs({ mode: 'folder', itemspec: '$/A' }, { before: 21018 })).toContain('/version:C1~C21017');
    expect(HistoryService.pageArgs({ mode: 'file', itemspec: 'C:\\work\\A\\b.vb' }, { workspace: true })).toContain('/version:W');
    // A page range is always older than the workspace version, so it wins.
    const both = HistoryService.pageArgs({ mode: 'file', itemspec: '$/A/b.vb' }, { before: 10, workspace: true });
    expect(both.filter((a) => a.startsWith('/version:'))).toEqual(['/version:C1~C9']);
  });

  it('reads one changeset through history, never through tf changeset (F6)', () => {
    expect(HistoryService.changesetArgs(20213)).toEqual([
      'vc', 'history', '$/', '/version:C20213~C20213', '/recursive', '/format:detailed', '/stopafter:1',
    ]);
  });
});

describe('HistoryService.page', () => {
  it('parses a real page and says a short page is the last one', async () => {
    const { client } = fakeClient([{ stdout: fixture('history-folder-page1.txt') }]);
    const page = await new HistoryService(client).page({ mode: 'folder', itemspec: '$/Shop/Shop2023/Distribution' });
    expect(page.changesets.map((c) => c.id)).toEqual([21082, 21043, 21032, 21019, 21018]);
    expect(page.more).toBe(false);
  });

  it('says there may be more when a full page comes back', async () => {
    const { client } = fakeClient([{ stdout: records(1000, HISTORY_PAGE) }]);
    const page = await new HistoryService(client).page({ mode: 'file', itemspec: '$/A/b.vb' });
    expect(page.changesets).toHaveLength(HISTORY_PAGE);
    expect(page.more).toBe(true);
  });

  it('does not run tf for a page older than changeset 1', async () => {
    const { client, runs } = fakeClient([]);
    expect(await new HistoryService(client).page({ mode: 'file', itemspec: '$/A/b.vb' }, { before: 1 })).toEqual({
      changesets: [],
      more: false,
    });
    expect(runs).toEqual([]);
  });

  it("treats tf's empty-range sentence as an empty page, not an error (F13)", async () => {
    const { client } = fakeClient([{ stdout: fixture('history-no-entries.txt') }]);
    const page = await new HistoryService(client).page({ mode: 'file', itemspec: '$/A/b.vb' }, { before: 100 });
    expect(page).toEqual({ changesets: [], more: false });
  });

  it('orders changesets newest first whatever order tf printed', async () => {
    const ascending = records(3, 1) + '\r\n' + records(5, 1) + '\r\n' + records(4, 1);
    const { client } = fakeClient([{ stdout: ascending }]);
    const page = await new HistoryService(client).page({ mode: 'file', itemspec: '$/A/b.vb' });
    expect(page.changesets.map((c) => c.id)).toEqual([5, 4, 3]);
  });

  it('counts a record it could not read toward a full page, so Load more still appears (D10)', async () => {
    // SYNTHETIC: 49 readable records and one with no Changeset line, which the parser skips.
    const unreadable = ['-'.repeat(79), 'User: A', 'Date: d', ''].join('\r\n');
    const { client } = fakeClient([{ stdout: records(1000, HISTORY_PAGE - 1) + '\r\n' + unreadable }]);
    const page = await new HistoryService(client).page({ mode: 'file', itemspec: '$/A/b.vb' });
    expect(page.changesets).toHaveLength(HISTORY_PAGE - 1);
    expect(page.more).toBe(true);
  });

  it('reports the pre-rename record for a renamed file under its OLD path, once the item is pinned (D12, finding 24)', async () => {
    // REAL capture: `history $/...tillPOSReply.vb;T /itemmode /version:C1~C18546` --
    // the range ends before the rename, and only the pin makes /itemmode follow it back.
    const { client } = fakeClient([{ stdout: fixture('history-itemmode-range-pinned.txt') }]);
    const page = await new HistoryService(client).page(
      { mode: 'file', itemspec: '$/Shop/Shop2023/ShopModel/Till/tillPOSReply.vb' },
      { before: 18547 },
    );
    expect(page.changesets.map((c) => c.id)).toEqual([18544]);
    expect(page.changesets[0].items[0].serverPath).toBe(
      '$/Shop/Shop2023/ShopModel/Till/tillPOSReplies.vb',
    );
  });

  it('rejects a page whose reply is not strictly older than "before" (D12)', async () => {
    // SYNTHETIC: asked for changesets older than 950, but tf's reply includes 950 itself.
    const { client } = fakeClient([{ stdout: records(950, 1) }]);
    await expect(
      new HistoryService(client).page({ mode: 'file', itemspec: '$/A/b.vb' }, { before: 950 }),
    ).rejects.toThrow(S.historyUnreadable);
  });

  it('rejects a page whose reply ignored "before" entirely (D12)', async () => {
    // SYNTHETIC: asked for changesets older than 950; tf's reply is unrelated to the range.
    const { client } = fakeClient([{ stdout: records(1000, 1) }]);
    await expect(
      new HistoryService(client).page({ mode: 'file', itemspec: '$/A/b.vb' }, { before: 950 }),
    ).rejects.toThrow(S.historyUnreadable);
  });

  it('rejects a page that repeats the same changeset id (D12)', async () => {
    // SYNTHETIC: tf printed changeset 1000 twice within one page.
    const { client } = fakeClient([{ stdout: records(1000, 1) + '\r\n' + records(1000, 1) }]);
    await expect(
      new HistoryService(client).page({ mode: 'file', itemspec: '$/A/b.vb' }),
    ).rejects.toThrow(S.historyUnreadable);
  });

  it("logs tf's first lines on a range-guard rejection, exactly like any other unreadable page (D18h)", async () => {
    const stdout = records(950, 1); // asked for older than 950, but tf's reply includes 950 itself
    const { client } = fakeClient([{ stdout }]);
    const log: string[] = [];
    await expect(
      new HistoryService(client, (l) => log.push(l)).page({ mode: 'file', itemspec: '$/A/b.vb' }, { before: 950 }),
    ).rejects.toThrow(S.historyUnreadable);
    const logText = log.join('\n');
    expect(logText).toContain('changeset 950 is not older than the requested 950');
    // The same "it began: ..." phrasing the unreadable-output path already logs.
    expect(logText).toContain("history: could not read tf's output; it began:");
    expect(logText).toContain('Changeset: 950');
  });
});

describe('HistoryService.all', () => {
  it('keeps paging until a short page (exactly 2 runs), each page older than the last, pinned and newest-first throughout (D12)', async () => {
    const { client, runs } = fakeClient([
      { stdout: records(1000, HISTORY_PAGE) },
      { stdout: records(950, 3) },
    ]);
    const all = await new HistoryService(client).all({ mode: 'file', itemspec: 'C:\\work\\A\\b.vb' }, { workspace: true });
    expect(all).toHaveLength(HISTORY_PAGE + 3);
    // Newest-first across the page boundary, not just within one page.
    expect(all.map((c) => c.id)).toEqual([
      ...Array.from({ length: HISTORY_PAGE }, (_, i) => 1000 - i),
      950,
      949,
      948,
    ]);
    // A short page (3 < HISTORY_PAGE) must end the walk -- exactly 2 runs, never a 3rd.
    expect(runs).toHaveLength(2);
    // A local itemspec is pinned with ;W on EVERY page, page 1 included (D12).
    expect(runs[0][2]).toBe('C:\\work\\A\\b.vb;W');
    expect(runs[0]).toContain('/version:W');
    expect(runs[1][2]).toBe('C:\\work\\A\\b.vb;W');
    expect(runs[1]).toContain('/version:C1~C950');
  });

  it('rejects a page that ignored the /version: range instead of letting the walk loop forever (D12, finding 24)', async () => {
    // SYNTHETIC: page 1 is full (so a 2nd page is requested with before: 951), but
    // tf's 2nd reply repeats page 1 verbatim, as an unpinned itemspec resolving at
    // the top of the range would (finding 24). A 3rd reply is queued too, so a
    // regression that loops would be caught by run count rather than hanging.
    const { client, runs } = fakeClient([
      { stdout: records(1000, HISTORY_PAGE) },
      { stdout: records(1000, HISTORY_PAGE) },
      { stdout: records(1000, HISTORY_PAGE) },
    ]);
    await expect(
      new HistoryService(client).all({ mode: 'file', itemspec: '$/A/b.vb' }, { workspace: true }),
    ).rejects.toThrow(S.historyUnreadable);
    expect(runs).toHaveLength(2);
  });

  it('stops paging once aborted', async () => {
    const { client, runs } = fakeClient([{ stdout: records(1000, HISTORY_PAGE) }, { stdout: records(950, 3) }]);
    const abort = new AbortController();
    abort.abort();
    await new HistoryService(client).all({ mode: 'file', itemspec: '$/A/b.vb' }, { signal: abort.signal });
    expect(runs).toHaveLength(1);
  });

  it('refuses a history with a record it could not read: Annotate would blame its lines on an older changeset (D10)', async () => {
    // SYNTHETIC: the second page holds one record with no Changeset line.
    const unreadable = ['-'.repeat(79), 'User: A', 'Date: d', ''].join('\r\n');
    const { client } = fakeClient([
      { stdout: records(1000, HISTORY_PAGE) },
      { stdout: records(950, 2) + '\r\n' + unreadable },
    ]);
    await expect(new HistoryService(client).all({ mode: 'file', itemspec: '$/A/b.vb' })).rejects.toThrow(S.historyUnreadable);
  });
});

describe('HistoryService.changeset', () => {
  it('returns the requested changeset and caches it: a changeset never changes', async () => {
    const { client, runs } = fakeClient([{ stdout: fixture('history-changeset-rename-delete.txt') }]);
    const service = new HistoryService(client);
    const first = await service.changeset(20213);
    const second = await service.changeset(20213);
    expect(first.items).toHaveLength(2);
    expect(second).toBe(first);
    expect(runs).toHaveLength(1);
  });

  it('refuses when tf printed a different changeset than the one asked for', async () => {
    const { client } = fakeClient([{ stdout: fixture('history-changeset-rename-delete.txt') }]);
    await expect(new HistoryService(client).changeset(99)).rejects.toThrow(S.changesetNotFound(99));
  });

  it('shares one in-flight call per id: two concurrent requests run tf once (D16d)', async () => {
    let resolveRun!: (v: { stdout: Buffer; stderr: Buffer; exitCode: number; timedOut: boolean }) => void;
    const runs: string[][] = [];
    const client = {
      timeoutMs: 1234,
      run: async (args: string[]) => {
        runs.push(args);
        return new Promise((r) => {
          resolveRun = r;
        });
      },
    };
    const service = new HistoryService(client as never);
    const first = service.changeset(20213);
    const second = service.changeset(20213); // arrives before tf has answered
    resolveRun({
      stdout: fixture('history-changeset-rename-delete.txt'),
      stderr: Buffer.alloc(0),
      exitCode: 0,
      timedOut: false,
    });
    const [a, b] = await Promise.all([first, second]);
    expect(a).toBe(b);
    expect(runs).toHaveLength(1);
  });

  it('never caches a rejection: a failed call is dropped so the next one retries (D16d)', async () => {
    const { client, runs } = fakeClient([
      { exitCode: 100, stderr: 'TF10167: The path $/Nope does not exist.' },
      { stdout: fixture('history-changeset-rename-delete.txt') },
    ]);
    const service = new HistoryService(client);
    await expect(service.changeset(20213)).rejects.toThrow(HistoryError);
    const second = await service.changeset(20213);
    expect(second.items).toHaveLength(2);
    expect(runs).toHaveLength(2); // the failed attempt was not cached; the retry ran tf again
  });
});

describe('HistoryService failures', () => {
  it("surfaces tf's own message on a failed command", async () => {
    const { client } = fakeClient([{ exitCode: 100, stderr: 'TF10167: The path $/Nope does not exist.' }]);
    const failure = new HistoryService(client).page({ mode: 'file', itemspec: '$/Nope' });
    await expect(failure).rejects.toBeInstanceOf(HistoryError);
    await expect(failure).rejects.toThrow('TF10167');
  });

  it("words a classified failure with Phase 1's own wording, not tf's raw text alone (D18d)", async () => {
    // TF30063 is classified as a rejected PAT (src/tf/TfClient.ts); messageFor
    // prepends S.patExpired, which names the fix, ahead of tf's own text.
    const { client } = fakeClient([
      { exitCode: 100, stderr: 'TF30063: You are not authorized to access acme.visualstudio.com.' },
    ]);
    const failure = new HistoryService(client).page({ mode: 'file', itemspec: '$/A' });
    await expect(failure).rejects.toThrow(S.patExpired);
    await expect(failure).rejects.toThrow('TF30063');
  });

  it('says so on a timeout', async () => {
    const { client } = fakeClient([{ timedOut: true, exitCode: -1 }]);
    await expect(new HistoryService(client).page({ mode: 'file', itemspec: '$/A' })).rejects.toThrow(S.commandTimedOut(1234));
  });

  it('turns a spawn failure into a scrubbed HistoryError with kind "spawn" instead of an unhandled rejection', async () => {
    // The message includes a /login: option the way a real spawn error could
    // echo the failed command line; scrubSecrets must remove it (TfClient.ts).
    const { client } = fakeClient([{ rejects: new Error('spawn ENOENT /login:x,secret') }]);
    let caught: unknown;
    try {
      await new HistoryService(client).page({ mode: 'file', itemspec: '$/A' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(HistoryError);
    const err = caught as HistoryError;
    expect(err.kind).toBe('spawn');
    expect(err.message).toContain('spawn ENOENT');
    expect(err.message).not.toContain('secret');
  });

  it('reports a killed tf as historyStopped, never with its stdout as the message, and logs a byte count not the records (D12)', async () => {
    const log: string[] = [];
    // 50 records tf had already written to stdout before something killed it.
    const partial = records(1000, HISTORY_PAGE);
    const { client } = fakeClient([{ stdout: partial, exitCode: -1, terminatedBy: 'SIGTERM' }]);
    let caught: unknown;
    try {
      await new HistoryService(client, (l) => log.push(l)).page({ mode: 'file', itemspec: '$/A' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(HistoryError);
    const err = caught as HistoryError;
    expect(err.message).toBe(S.historyStopped('SIGTERM'));
    expect(err.kind).toBe('stopped');

    const logText = log.join('\n');
    expect(logText).toContain('SIGTERM');
    expect(logText).toContain(`${Buffer.byteLength(partial, 'utf8')} bytes`);
    expect(logText).not.toContain('Changeset:');
  });

  it('says it could not read output it does not understand, and logs how it began', async () => {
    const { client } = fakeClient([{ stdout: 'Something tf never printed before\r\nsecond line\r\n' }]);
    const log: string[] = [];
    await expect(new HistoryService(client, (l) => log.push(l)).page({ mode: 'file', itemspec: '$/A' })).rejects.toThrow(
      S.historyUnreadable,
    );
    expect(log.join('\n')).toContain('Something tf never printed before');
  });
});
