import { describe, it, expect } from 'vitest';
import { isResolveOutOfShape, TfClient } from '../../src/tf/TfClient.js';

const ITEM = String.raw`C:\work\Shop\Startup.cs`;
const OTHER = String.raw`C:\work\Shop\Program.cs`;

describe('the resolve guard', () => {
  it('lets through exactly the shapes phase 5 builds', () => {
    const allowed = [
      ['vc', 'resolve', ITEM, '/recursive', '/preview'],
      ['vc', 'resolve', ITEM, OTHER, '/recursive', '/preview'],
      ['vc', 'resolve', ITEM, '/auto:AutoMerge'],
      ['vc', 'resolve', ITEM, '/auto:TakeTheirs'],
      ['vc', 'resolve', ITEM, '/auto:KeepYours'],
      ['vc', 'resolve', ITEM, '/auto:OverwriteLocal'],
      ['vc', 'resolve', ITEM, OTHER, '/recursive', '/auto:AutoMerge'],
      // tf takes the verb without `vc`, and options in any case.
      ['resolve', ITEM, '/PREVIEW', '/Recursive'],
    ];
    for (const args of allowed) expect(isResolveOutOfShape(args), args.join(' ')).toBe(false);
  });

  it('refuses every other shape', () => {
    const refused = [
      ['vc', 'resolve'], // bare: prompts, and acts on the working directory
      ['vc', 'resolve', ITEM], // no /auto: -- prompts
      ['vc', 'resolve', '/recursive', '/preview'], // no itemspec
      ['vc', 'resolve', ITEM, '/preview'], // C9: a false "none"
      ['vc', 'resolve', ITEM, '/recursive', '/preview', '/auto:TakeTheirs'],
      ['vc', 'resolve', ITEM, '/auto:AutoMergeForced'],
      ['vc', 'resolve', ITEM, '/auto:DeleteConflict'],
      ['vc', 'resolve', ITEM, '/auto:KeepYoursRenameTheirs'],
      ['vc', 'resolve', ITEM, '/auto:TakeTheirs', '/auto:KeepYours'],
      ['vc', 'resolve', ITEM, '/recursive', '/auto:TakeTheirs'],
      ['vc', 'resolve', ITEM, OTHER, '/auto:KeepYours'], // one destructive resolution, two items
      ['vc', 'resolve', ITEM, '/auto:TakeTheirs', String.raw`/newname:C:\work\x.cs`],
      ['vc', 'resolve', ITEM, '/auto:TakeTheirs', '/overridetype:utf-8'],
      ['vc', 'resolve', ITEM, '/auto:TakeTheirs', '/converttotype:binary'],
      ['vc', 'resolve', ITEM, '/auto:TakeTheirs', '/properties:x=1'],
      ['vc', 'resolve', ITEM, '-auto:TakeTheirs'],
      ['vc', 'resolve', ITEM, '/recursive', '-preview'],
      ['vc', 'resolve', String.raw`C:\work\*`, '/auto:TakeTheirs'],
      // Each destructive resolution, recursive or on two items (C13, C14, C16).
      ['vc', 'resolve', ITEM, '/recursive', '/auto:KeepYours'],
      ['vc', 'resolve', ITEM, '/recursive', '/auto:OverwriteLocal'],
      ['vc', 'resolve', ITEM, OTHER, '/auto:TakeTheirs'],
      ['vc', 'resolve', ITEM, OTHER, '/auto:OverwriteLocal'],
      // Without `vc`, and in mixed case: the guard must not depend on either.
      ['resolve', ITEM, '/recursive', '/auto:KeepYours'],
      ['vc', 'resolve', ITEM, '/Recursive', '/AUTO:KeepYours'],
      // Anything tf might drop or read as an option is not an item.
      ['vc', 'resolve', '', '/auto:KeepYours'],
      ['vc', 'resolve', ' ', '/auto:TakeTheirs'],
      ['vc', 'resolve', ITEM, '/recursive', '/auto:AutoMerge', ' /auto:KeepYours'],
      ['vc', 'resolve', '$/Shop/Startup.cs', '/auto:TakeTheirs'],
      ['vc', 'resolve', String.raw`Shop\Startup.cs`, '/auto:KeepYours'],
      ['vc', 'resolve', String.raw`@C:\list.txt`, '/auto:KeepYours'],
      ['vc', 'resolve', '/home/shax/work/a.cs', '/auto:KeepYours'],
    ];
    for (const args of refused) expect(isResolveOutOfShape(args), args.join(' ')).toBe(true);
  });

  it('leaves every other verb alone', () => {
    expect(isResolveOutOfShape(['vc', 'status', '/recursive'])).toBe(false);
    expect(isResolveOutOfShape(['vc', 'get', ITEM, '/recursive'])).toBe(false);
    expect(isResolveOutOfShape(['vc', 'info', ITEM])).toBe(false);
  });

  it('refuses before anything runs: exit -1, a reason on stderr, and a log line', async () => {
    const lines: string[] = [];
    const client = new TfClient({
      wrapperPath: String.raw`C:\definitely\not\there\tfp.cmd`,
      timeoutMs: 1000,
      log: (line) => lines.push(line),
    });
    const r = await client.run(['vc', 'resolve', ITEM, '/auto:AutoMergeForced']);
    expect(r.exitCode).toBe(-1);
    expect(r.timedOut).toBe(false);
    expect(r.stderr.toString('utf8')).toMatch(/Refusing to run "resolve"/);
    expect(lines.at(-1)).toMatch(/REFUSED: resolve/);
  });
});
