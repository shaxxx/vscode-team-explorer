import { describe, it, expect } from 'vitest';
import { ServerContentProvider, TFVC_SCHEME } from '../../src/ui/ServerContentProvider.js';
import { PathMapper } from '../../src/tf/PathMapper.js';
import { S } from '../../src/tf/strings.js';

function recordingClient() {
  const runs: string[][] = [];
  const client = {
    timeoutMs: 1000,
    run: async (args: string[]) => {
      runs.push(args);
      return { stdout: Buffer.from('latest'), stderr: Buffer.alloc(0), exitCode: 0, timedOut: false };
    },
  };
  return { client, runs };
}

describe('versioned URIs', () => {
  it('round-trips a server path and a changeset', () => {
    const uri = ServerContentProvider.versionUri('$/Shop/Shop2023/Distribution/Forms/frmInvoice.vb', 21082);
    expect(uri.scheme).toBe(TFVC_SCHEME);
    expect(ServerContentProvider.parseVersionUri(uri)).toEqual({
      serverPath: '$/Shop/Shop2023/Distribution/Forms/frmInvoice.vb',
      changeset: 21082,
    });
  });

  it('ends its path in the file name, so VS Code picks the language mode', () => {
    expect(ServerContentProvider.versionUri('$/Shop/a/frmInvoice.vb', 5).path.endsWith('/frmInvoice.vb')).toBe(true);
  });

  it('never mistakes the local-path forms for a versioned one', () => {
    expect(ServerContentProvider.parseVersionUri(ServerContentProvider.uriFor('C:\\work\\A.vb'))).toBeUndefined();
    expect(
      ServerContentProvider.parseVersionUri(ServerContentProvider.uriFor('C:\\work\\A.vb', 'compare')),
    ).toBeUndefined();
  });

  it('rejects a v= query on something that is not a server path, or not a changeset', () => {
    expect(ServerContentProvider.parseVersionUri({ path: '/etc/passwd', query: 'v=C1' })).toBeUndefined();
    expect(ServerContentProvider.parseVersionUri({ path: '/$/A', query: 'v=C1x' })).toBeUndefined();
    expect(ServerContentProvider.parseVersionUri({ path: '/$/A', query: 'v=C0' })).toBeUndefined();
  });

  // D14: TFVC changeset ids are int32. A 24-digit query used to reach
  // Number() -> 1e+23 -> tf as a literal "/version:C1e+23"; a 10-digit query
  // above int32 max used to pass straight through as a number.
  it('rejects a changeset above int32 max, and one absurdly large', () => {
    expect(ServerContentProvider.parseVersionUri({ path: '/$/A', query: 'v=C2147483648' })).toBeUndefined();
    expect(
      ServerContentProvider.parseVersionUri({ path: '/$/A', query: 'v=C99999999999999999999999' }),
    ).toBeUndefined();
  });

  it('still accepts the largest legitimate changeset, int32 max', () => {
    expect(
      ServerContentProvider.parseVersionUri({ path: '/$/Shop/My Project/čćž #1 (x) & y.vb', query: 'v=C2147483647' }),
    ).toEqual({ serverPath: '$/Shop/My Project/čćž #1 (x) & y.vb', changeset: 2147483647 });
  });

  // D14: none of these characters can appear in a real TFVC item name. A
  // wildcard, in particular, used to reach tf as a "vc view" with a glob.
  it.each([
    ['a wildcard', '/$/Shop/*'],
    ['a question mark', '/$/A?.vb'],
    ['a semicolon', '/$/A;C5.vb'],
    ['a backslash', '/$/A\\b.vb'],
    ['a colon', '/$/A:b.vb'],
    ['a control character', '/$/A\u0007b.vb'],
  ])('rejects a path with %s', (_label, path) => {
    expect(ServerContentProvider.parseVersionUri({ path, query: 'v=C1' })).toBeUndefined();
  });

  // Pins a gap the reviewers found: versionUri must round-trip through
  // parseVersionUri for the punctuation TFVC item names legitimately contain,
  // not just plain ASCII.
  it('round-trips a path with a space, #, %, & and a Croatian letter', () => {
    const serverPath = '$/Shop/My Project/čćž #1 (100%) & y.vb';
    const uri = ServerContentProvider.versionUri(serverPath, 42);
    expect(ServerContentProvider.parseVersionUri(uri)).toEqual({ serverPath, changeset: 42 });
  });
});

describe('ServerContentProvider with a versioned URI', () => {
  it('asks the version source and runs no tf of its own', async () => {
    const { client, runs } = recordingClient();
    const asked: [string, number][] = [];
    const provider = new ServerContentProvider(client as never, () => undefined, () => undefined, async (p, c) => {
      asked.push([p, c]);
      return 'old text';
    });
    const text = await provider.provideTextDocumentContent(ServerContentProvider.versionUri('$/A/b.vb', 7) as never);
    expect(text).toBe('old text');
    expect(asked).toEqual([['$/A/b.vb', 7]]);
    expect(runs).toEqual([]);
  });

  it('throws rather than show an empty document when no version source is wired', async () => {
    const { client } = recordingClient();
    const provider = new ServerContentProvider(client as never, () => undefined, () => undefined);
    await expect(
      provider.provideTextDocumentContent(ServerContentProvider.versionUri('$/A/b.vb', 7) as never),
    ).rejects.toThrow(S.versionUnavailable);
  });

  it('still serves the latest version for a local-path URI', async () => {
    const { client, runs } = recordingClient();
    const mapper = new PathMapper([{ serverItem: '$/Vesta', localPath: 'C:\\work\\Vesta' }], 'win32');
    const provider = new ServerContentProvider(client as never, () => mapper, () => 65001, async () => 'WRONG');
    const text = await provider.provideTextDocumentContent(ServerContentProvider.uriFor('C:\\work\\Vesta\\A.vb') as never);
    expect(text).toBe('latest');
    expect(runs).toEqual([['vc', 'view', '$/Vesta/A.vb', '/console', '/version:T']]);
  });

  // Pins a gap the reviewers found: a versionText that refuses (e.g. D14's
  // binary refusal) must make the whole request reject, never resolve with
  // '' -- an empty document reads as "this version was empty" (see the
  // comment above the local-path THROW in provideTextDocumentContent).
  it('rejects, rather than resolving empty, when the version source refuses', async () => {
    const { client } = recordingClient();
    const provider = new ServerContentProvider(client as never, () => undefined, () => undefined, async () => {
      throw new Error(S.compareBinary('x.dll'));
    });
    await expect(
      provider.provideTextDocumentContent(ServerContentProvider.versionUri('$/A/x.dll', 7) as never),
    ).rejects.toThrow(S.compareBinary('x.dll'));
  });
});
