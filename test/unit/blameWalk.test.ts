import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseHistory, type Changeset } from '../../src/tf/parseHistory.js';
import { versionsOf, needsOwnCodePage, runBlame, FETCH_CONCURRENCY, type VersionRef } from '../../src/annotate/walk.js';
import { S } from '../../src/tf/strings.js';

/** A promise plus its own settlement functions, for tests that need manual control over arrival order. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** One full turn of the macrotask queue -- past `runBlame`'s own per-version `setImmediate` yield (D11). */
function flushMacrotask(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

const renamed = parseHistory(
  readFileSync(join(__dirname, '../fixtures/windows/history-file-renamed-itemmode.txt')).toString('utf8'),
).changesets;

describe('versionsOf', () => {
  it('fetches each version by the path its own record printed, so a rename is followed (F9)', () => {
    const versions = versionsOf(renamed);
    expect(versions.map((v) => v.id)).toEqual([18659, 18617, 18588, 18558, 18552, 18547, 18544]);
    expect(versions[5].serverPath).toBe('$/Shop/Shop2023/ShopModel/Till/tillPOSReply.vb');
    expect(versions[6].serverPath).toBe('$/Shop/Shop2023/ShopModel/Till/tillPOSReplies.vb');
  });

  it('skips a record where the file was deleted: that version has no content', () => {
    // SYNTHETIC: a delete and an undelete, which no capture contains.
    const synthetic: Changeset[] = [
      { id: 3, user: 'A', date: 'd', comment: '', items: [{ change: ['undelete'], serverPath: '$/A' }] },
      { id: 2, user: 'A', date: 'd', comment: '', items: [{ change: ['delete'], serverPath: '$/A', deletionId: 9 }] },
      { id: 1, user: 'A', date: 'd', comment: '', items: [{ change: ['add'], serverPath: '$/A' }] },
    ];
    expect(versionsOf(synthetic).map((v) => v.id)).toEqual([3, 1]);
  });
});

describe('needsOwnCodePage (D8)', () => {
  const v = (id: number, ...change: string[]): VersionRef => ({ id, serverPath: '$/A', change });

  it('asks only for the newest version when the encoding never changed', () => {
    expect(needsOwnCodePage([v(3, 'edit'), v(2, 'edit'), v(1, 'add')])).toEqual([true, false, false]);
  });

  it('asks again for every version older than the newest encoding change', () => {
    expect(needsOwnCodePage([v(5, 'edit'), v(4, 'edit', 'encoding'), v(3, 'edit'), v(2, 'add')])).toEqual([
      true, false, true, true,
    ]);
  });
});

describe('runBlame', () => {
  const v = (id: number): VersionRef => ({ id, serverPath: `$/A/${id}`, change: ['edit'] });
  const texts: Record<number, string> = { 3: ['a', 'b', 'x'].join('\n'), 2: ['a', 'b'].join('\n'), 1: 'a' };

  it('walks newest to oldest and finishes with every line owned', async () => {
    const result = await runBlame({ versions: [v(3), v(2), v(1)], textOf: async (x) => texts[x.id] });
    expect(result.owners).toEqual([
      { kind: 'changeset', id: 1 },
      { kind: 'changeset', id: 2 },
      { kind: 'changeset', id: 3 },
    ]);
    expect(result.baseLines).toEqual(['a', 'b', 'x']);
    expect(result.stoppedBy).toBeUndefined();
  });

  it('reports progress after every version, and once more when finished', async () => {
    const seen: number[] = [];
    await runBlame({
      versions: [v(3), v(2), v(1)],
      textOf: async (x) => texts[x.id],
      onProgress: (p) => seen.push(p.done),
    });
    expect(seen).toEqual([1, 2, 3, 3]);
  });

  it('never has more than `concurrency` fetches in flight', async () => {
    let inFlight = 0;
    let peak = 0;
    await runBlame({
      versions: Array.from({ length: 10 }, (_, i) => v(10 - i)),
      concurrency: 4,
      textOf: async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 1));
        inFlight--;
        return 'a';
      },
    });
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);
  });

  it('stops on abort and marks unreached lines at-or-before the last version folded', async () => {
    const abort = new AbortController();
    const result = await runBlame({
      versions: [v(3), v(2), v(1)],
      textOf: async (x) => texts[x.id],
      signal: abort.signal,
      onProgress: (p) => {
        if (p.done === 2) abort.abort();
      },
    });
    expect(result.stoppedBy).toBe('cancelled');
    expect(result.owners).toEqual([
      { kind: 'atOrBefore', id: 2 },
      { kind: 'atOrBefore', id: 2 },
      { kind: 'changeset', id: 3 },
    ]);
  });

  it('stops on a failed fetch, keeps what it has and says why', async () => {
    const result = await runBlame({
      versions: [v(3), v(2), v(1)],
      textOf: async (x) => {
        if (x.id === 1) throw new Error('No file matches.');
        return texts[x.id];
      },
    });
    expect(result.stoppedBy).toBeInstanceOf(Error);
    expect((result.stoppedBy as Error).message).toBe('No file matches.');
    expect(result.owners[0]).toEqual({ kind: 'atOrBefore', id: 2 });
    expect(result.owners[2]).toEqual({ kind: 'changeset', id: 3 });
  });

  it('rejects when the newest version itself cannot be read', async () => {
    await expect(
      runBlame({
        versions: [v(3)],
        textOf: async () => {
          throw new Error('boom');
        },
      }),
    ).rejects.toThrow('boom');
  });

  it('returns an empty cancelled result when aborted before anything arrived', async () => {
    const abort = new AbortController();
    abort.abort();
    const result = await runBlame({ versions: [v(3)], textOf: async () => 'a', signal: abort.signal });
    expect(result).toMatchObject({ owners: [], baseLines: [], done: 0, stoppedBy: 'cancelled' });
  });

  it('folds strictly in version order, however the fetches actually resolve', async () => {
    const defs: Record<1 | 2 | 3, ReturnType<typeof deferred<string>>> = {
      1: deferred<string>(),
      2: deferred<string>(),
      3: deferred<string>(),
    };
    const resultPromise = runBlame({
      versions: [v(3), v(2), v(1)],
      textOf: (x) => defs[x.id as 1 | 2 | 3].promise,
    });
    // Resolve OLDEST first. `runBlame` awaits fetches[0] (id 3, the newest)
    // before it ever looks at the others, so this only proves anything if
    // folding truly happens by position, not by arrival: an implementation
    // that instead folded in arrival order would treat 1 as the base and 3
    // as the oldest edit, giving line 'x' (only in id 3's text) to the wrong
    // changeset -- or never terminate the same way at all.
    defs[1].resolve(texts[1]);
    defs[2].resolve(texts[2]);
    defs[3].resolve(texts[3]);
    const result = await resultPromise;
    expect(result.owners).toEqual([
      { kind: 'changeset', id: 1 },
      { kind: 'changeset', id: 2 },
      { kind: 'changeset', id: 3 },
    ]);
  });

  it('starts exactly min(concurrency, total) fetches up front, newest first, and one more per folded version', async () => {
    const total = 10;
    const versions = Array.from({ length: total }, (_, i) => v(total - i)); // v(10)..v(1), newest first
    const defs = versions.map(() => deferred<string>());
    const calls: number[] = [];
    const resultPromise = runBlame({
      versions,
      textOf: (x) => {
        calls.push(x.id);
        return defs[versions.indexOf(x)].promise;
      },
    });
    // The initial concurrency-fill loop has no `await` before it, so by the
    // time control returns here it has already run in full.
    expect(calls).toEqual([10, 9, 8, 7]);

    defs[0].resolve('a');
    await flushMacrotask();
    expect(calls).toEqual([10, 9, 8, 7, 6]);

    defs[1].resolve('a');
    await flushMacrotask();
    expect(calls).toEqual([10, 9, 8, 7, 6, 5]);

    for (let i = 2; i < total; i++) defs[i].resolve('a');
    await resultPromise;
  });

  describe('D11: prompt, correct cancel', () => {
    it('resolves promptly on abort while a fetch is pending, even if that fetch never resolves', async () => {
      const abort = new AbortController();
      const stuck = new Promise<string>(() => {
        /* never settles */
      });
      const resultPromise = runBlame({
        versions: [v(3), v(2), v(1)],
        textOf: async (x) => (x.id === 3 ? stuck : texts[x.id]),
        signal: abort.signal,
      });
      setImmediate(() => abort.abort());
      const result = await resultPromise;
      expect(result.stoppedBy).toBe('cancelled');
      expect(result.done).toBe(0);
    });

    it('treats a rejection as cancelled, not a thrown error, when the abort already fired for the first version', async () => {
      const abort = new AbortController();
      const result = await runBlame({
        versions: [v(3), v(2), v(1)],
        textOf: async (x) => {
          if (x.id === 3) {
            abort.abort();
            throw new Error('The operation was aborted.');
          }
          return texts[x.id];
        },
        signal: abort.signal,
      });
      expect(result).toMatchObject({ stoppedBy: 'cancelled', done: 0, owners: [], baseLines: [] });
    });

    it('treats a rejection as cancelled, not a thrown error, once the abort has fired for a later version', async () => {
      const abort = new AbortController();
      const d2 = deferred<string>();
      const result = await runBlame({
        versions: [v(3), v(2), v(1)],
        textOf: async (x) => (x.id === 2 ? d2.promise : texts[x.id]),
        signal: abort.signal,
        onProgress: (p) => {
          if (p.done === 1) {
            abort.abort();
            d2.reject(new Error('The operation was aborted.'));
          }
        },
      });
      expect(result.stoppedBy).toBe('cancelled');
      expect(result.done).toBe(1);
      // Only the base version (id 3) had loaded at this point -- no fold
      // happened yet, so nothing is claimed as `changeset` and every line
      // reads at-or-before the newest version, per `BlameWalk.stop()`.
      expect(result.owners[2]).toEqual({ kind: 'atOrBefore', id: 3 });
    });

    it('starts no further fetch once the abort has been seen', async () => {
      const abort = new AbortController();
      const total = 6;
      const versions = Array.from({ length: total }, (_, i) => v(total - i));
      const calls: number[] = [];
      const result = await runBlame({
        versions,
        textOf: async (x) => {
          calls.push(x.id);
          return 'same-text-every-version';
        },
        signal: abort.signal,
        onProgress: (p) => {
          if (p.done === 1) abort.abort();
        },
      });
      expect(result.stoppedBy).toBe('cancelled');
      const callsAtStop = calls.length;
      await flushMacrotask();
      await flushMacrotask();
      expect(calls.length).toBe(callsAtStop);
      expect(calls.length).toBeLessThanOrEqual(FETCH_CONCURRENCY + 1);
    });

    it('a fetch that rejects after the walk already stopped causes no unhandled rejection', async () => {
      const unhandled: unknown[] = [];
      const onUnhandledRejection = (reason: unknown): void => {
        unhandled.push(reason);
      };
      process.on('unhandledRejection', onUnhandledRejection);
      try {
        const abort = new AbortController();
        const late = deferred<string>();
        const result = await runBlame({
          versions: [v(3), v(2), v(1)],
          textOf: async (x) => (x.id === 1 ? late.promise : texts[x.id]),
          signal: abort.signal,
          onProgress: (p) => {
            if (p.done === 2) abort.abort();
          },
        });
        expect(result.stoppedBy).toBe('cancelled');
        late.reject(new Error('too late to matter'));
        await flushMacrotask();
        await flushMacrotask();
        await flushMacrotask();
        expect(unhandled).toEqual([]);
      } finally {
        process.off('unhandledRejection', onUnhandledRejection);
      }
    });

    it('lets a Cancel scheduled right after starting land before a 50-version, all-cache-hit walk finishes', async () => {
      const abort = new AbortController();
      const total = 50;
      const versions = Array.from({ length: total }, (_, i) => v(total - i));
      const resultPromise = runBlame({
        versions,
        textOf: async () => 'same-text-every-version',
        signal: abort.signal,
      });
      setImmediate(() => abort.abort());
      const result = await resultPromise;
      expect(result.stoppedBy).toBe('cancelled');
      expect(result.done).toBeLessThan(50);
    });
  });

  describe('D11: bounded diffs', () => {
    it('ends the walk with annotateTooDifferent when a fold exceeds the configured limits', async () => {
      const result = await runBlame({
        versions: [v(3), v(2), v(1)],
        textOf: async (x) => {
          if (x.id === 3) return ['a', 'b', 'c', 'd'].join('\n');
          if (x.id === 2) return ['w', 'x', 'y', 'z'].join('\n'); // wholly different: forces a give-up
          return 'a';
        },
        limits: { maxEditLength: 2, timeout: 300 },
      });
      expect(result.stoppedBy).toBeInstanceOf(Error);
      expect((result.stoppedBy as Error).message).toBe(S.annotateTooDifferent(3));
      expect(result.done).toBe(1);
    });

    it('treats CRLF and LF versions of the same content as identical, same owners either way', async () => {
      const crlf = await runBlame({
        versions: [v(2), v(1)],
        textOf: async (x) => (x.id === 2 ? 'a\r\nb\r\nc' : 'a\nb\nc'),
      });
      const identical = await runBlame({
        versions: [v(2), v(1)],
        textOf: async () => 'a\nb\nc',
      });
      expect(crlf.owners).toEqual(identical.owners);
    });
  });
});
