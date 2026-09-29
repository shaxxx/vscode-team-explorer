import { describe, it, expect, vi } from 'vitest';
import { ServerContentProvider, type ShelvedRef } from '../../src/ui/ServerContentProvider.js';
import { S } from '../../src/tf/strings.js';

const REF: ShelvedRef = {
  serverPath: '$/Shop/Web/hello.html',
  shelveset: 'Assignments & co + 100% = gotovo',
  owner: 'user@example.com',
  date: '2026-09-23T13:57:31.84+02:00',
  codePage: 1250,
};

const provider = (shelvedText?: (ref: ShelvedRef) => Promise<string>) =>
  new ServerContentProvider({} as never, () => undefined, () => undefined, undefined, shelvedText);

describe('shelved-content URIs (phase 4)', () => {
  it('round-trips a name with spaces, &, +, %, = and Croatian letters', () => {
    const uri = ServerContentProvider.shelvedUri(REF);
    expect(uri.scheme).toBe('teamExplorer');
    expect(uri.path).toBe('/$/Shop/Web/hello.html');
    expect(ServerContentProvider.parseShelvedUri(uri)).toEqual(REF);
  });

  it('leaves the code page out when there is none', () => {
    const noCodePage: ShelvedRef = { serverPath: REF.serverPath, shelveset: REF.shelveset, owner: REF.owner, date: REF.date };
    expect(ServerContentProvider.parseShelvedUri(ServerContentProvider.shelvedUri(noCodePage))).toEqual(noCodePage);
  });

  it('refuses a URI tf could be tricked by', () => {
    const q = (o: Record<string, string>) => new URLSearchParams(o).toString();
    const parse = (path: string, query: string) => ServerContentProvider.parseShelvedUri({ path, query });
    expect(parse('/$/a.txt', q({ s: 'x', o: 'y' }))).toBeUndefined(); // no date
    expect(parse('/$/a.txt', q({ s: 'x;z', o: 'y', d: 'd' }))).toBeUndefined(); // ; splits name;owner
    expect(parse('/$/a.txt', q({ s: 'x', o: 'y"', d: 'd' }))).toBeUndefined();
    expect(parse('/$/a.txt', q({ s: 'x\n', o: 'y', d: 'd' }))).toBeUndefined();
    expect(parse('/$/*.txt', q({ s: 'x', o: 'y', d: 'd' }))).toBeUndefined(); // a wildcard
    expect(parse('/c:/work/a.txt', q({ s: 'x', o: 'y', d: 'd' }))).toBeUndefined(); // not a server path
    expect(parse('/$/a.txt', q({ s: 'x', o: 'y', d: 'd', c: 'utf8' }))).toBeUndefined();
  });

  it('never mistakes a version or an empty URI for a shelved one', () => {
    expect(ServerContentProvider.parseShelvedUri(ServerContentProvider.versionUri('$/a.txt', 5))).toBeUndefined();
    expect(ServerContentProvider.parseShelvedUri(ServerContentProvider.emptyUri('$/a.txt'))).toBeUndefined();
  });
});

describe('providing shelved and empty content', () => {
  it('serves the empty side as an empty document without asking tf', async () => {
    const shelvedText = vi.fn(async () => 'x');
    expect(await provider(shelvedText).provideTextDocumentContent(ServerContentProvider.emptyUri('$/a.txt') as never)).toBe('');
    expect(shelvedText).not.toHaveBeenCalled();
  });

  it('fetches shelved text once per shelveset version, and again after a /replace changed its date', async () => {
    const shelvedText = vi.fn(async (ref: ShelvedRef) => `text of ${ref.date}`);
    const p = provider(shelvedText);
    const uri = ServerContentProvider.shelvedUri(REF);
    expect(await p.provideTextDocumentContent(uri as never)).toBe(`text of ${REF.date}`);
    expect(await p.provideTextDocumentContent(uri as never)).toBe(`text of ${REF.date}`);
    expect(shelvedText).toHaveBeenCalledTimes(1);
    const replaced = ServerContentProvider.shelvedUri({ ...REF, date: '2026-09-24T08:00:00+02:00' });
    expect(await p.provideTextDocumentContent(replaced as never)).toBe('text of 2026-09-24T08:00:00+02:00');
    expect(shelvedText).toHaveBeenCalledTimes(2);
  });

  it('does not remember a failure', async () => {
    const shelvedText = vi.fn().mockRejectedValueOnce(new Error('TF30063')).mockResolvedValueOnce('ok');
    const p = provider(shelvedText);
    const uri = ServerContentProvider.shelvedUri(REF);
    await expect(p.provideTextDocumentContent(uri as never)).rejects.toThrow('TF30063');
    expect(await p.provideTextDocumentContent(uri as never)).toBe('ok');
  });

  it('throws, never answers empty, when shelved text cannot be fetched yet', async () => {
    await expect(provider().provideTextDocumentContent(ServerContentProvider.shelvedUri(REF) as never)).rejects.toThrow(S.versionUnavailable);
  });

  it('keeps at most 50 shelved copies, dropping the oldest', async () => {
    const shelvedText = vi.fn(async (ref: ShelvedRef) => ref.date);
    const p = provider(shelvedText);
    const at = (i: number) => ServerContentProvider.shelvedUri({ ...REF, date: `d${i}` });
    for (let i = 0; i <= 50; i++) await p.provideTextDocumentContent(at(i) as never);
    expect(shelvedText).toHaveBeenCalledTimes(51);
    await p.provideTextDocumentContent(at(50) as never); // the newest is still cached
    expect(shelvedText).toHaveBeenCalledTimes(51);
    await p.provideTextDocumentContent(at(0) as never); // the oldest was dropped
    expect(shelvedText).toHaveBeenCalledTimes(52);
  });
});
