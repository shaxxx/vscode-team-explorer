import { describe, it, expect, beforeEach } from 'vitest';
import { ServerContentProvider } from '../../src/ui/ServerContentProvider.js';
import { PathMapper } from '../../src/tf/PathMapper.js';
import { recorder, Uri } from '../vscode-mock.js';

const CROATIAN_1250 = Buffer.from([0x9e, 0x9a, 0xe8, 0xe6, 0xf0]);

const INFO_1250 = [
  'Local information:',
  '  Local path : C:\\work\\Vesta\\Racun.vb',
  '  Change     : none',
  'Server information:',
  '  File type    : windows-1250',
  '  Size         : 22882',
].join('\r\n');

function build(opts: {
  viewExit?: number;
  viewStdout?: Buffer;
  viewStderr?: string;
  timedOut?: boolean;
  pendingEncoding?: number;
  infoStdout?: string;
}) {
  const runs: string[][] = [];
  const client = {
    timeoutMs: 1000,
    run: async (args: string[]) => {
      runs.push(args);
      if (args.includes('info')) {
        return {
          stdout: Buffer.from(opts.infoStdout ?? INFO_1250, 'utf8'),
          stderr: Buffer.alloc(0),
          exitCode: 0,
          timedOut: false,
        };
      }
      return {
        stdout: opts.viewStdout ?? CROATIAN_1250,
        stderr: Buffer.from(opts.viewStderr ?? '', 'utf8'),
        exitCode: opts.viewExit ?? 0,
        timedOut: opts.timedOut ?? false,
      };
    },
  };
  const mapper = new PathMapper(
    [{ serverItem: '$/Vesta', localPath: 'C:\\work\\Vesta' }],
    'win32',
  );
  const provider = new ServerContentProvider(
    client as never,
    () => mapper,
    () => opts.pendingEncoding,
  );
  return { provider, runs };
}

const target = Uri.file('C:\\work\\Vesta\\Racun.vb');

beforeEach(() => recorder.reset());

describe('ServerContentProvider', () => {
  it('THROWS on a failed tf view instead of rendering an empty server file', async () => {
    // Returning '' made VS Code open a diff whose left pane was empty, so every
    // line of a 2,000-line file showed as newly added and the user concluded
    // the file did not exist on the server. An expired PAT landed here.
    const { provider } = build({ viewExit: 100, viewStderr: 'TF30063: You are not authorized.' });

    await expect(provider.provideTextDocumentContent(target as never)).rejects.toThrow(/TF30063/);
  });

  it('THROWS on a timeout rather than returning a truncated file', async () => {
    const { provider } = build({ timedOut: true, viewExit: -1 });

    await expect(provider.provideTextDocumentContent(target as never)).rejects.toThrow(/timed out/i);
  });

  it('THROWS for a path outside the workspace', async () => {
    const { provider } = build({});

    await expect(
      provider.provideTextDocumentContent(Uri.file('D:\\elsewhere\\x.vb') as never),
    ).rejects.toThrow();
  });

  it('never lets a token reach the thrown message', async () => {
    const { provider } = build({
      viewExit: 100,
      viewStderr: 'TF30063: failed /login:.,SECRETPATVALUE',
    });

    await expect(provider.provideTextDocumentContent(target as never)).rejects.toThrow(
      /login:\*\*\*/,
    );
  });

  it('uses the pending change encoding when there is one, with no extra call', async () => {
    const { provider, runs } = build({ pendingEncoding: 1250 });

    expect(await provider.provideTextDocumentContent(target as never)).toBe('žščćđ');
    expect(runs.some((r) => r.includes('info')), 'no info call was needed').toBe(false);
  });

  it('resolves the encoding via tf vc info when the file is NOT pending', async () => {
    // The majority case for Compare with Latest Version. changeFor() only
    // indexes pending items, so this returned undefined and the content was
    // decoded as UTF-8 — every Croatian letter becoming U+FFFD on the server
    // side of the diff, against 66,678 windows-1250 items in this collection.
    const { provider, runs } = build({ pendingEncoding: undefined });

    const text = await provider.provideTextDocumentContent(target as never);

    expect(text).toBe('žščćđ');
    expect(runs.some((r) => r.includes('info'))).toBe(true);
  });

  it('asks tf vc info only once per item', async () => {
    const { provider, runs } = build({ pendingEncoding: undefined });

    await provider.provideTextDocumentContent(target as never);
    await provider.provideTextDocumentContent(target as never);

    expect(runs.filter((r) => r.includes('info'))).toHaveLength(1);
  });
});
