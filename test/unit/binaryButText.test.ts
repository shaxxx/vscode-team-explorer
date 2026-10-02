import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { compareVerdict, localLooksLikeText } from '../../src/ui/compareTarget.js';
import { looksLikeText } from '../../src/ui/decode.js';
import { QuickDiff } from '../../src/ui/QuickDiff.js';
import { PathMapper, type Platform } from '../../src/tf/PathMapper.js';
import { Uri } from '../vscode-mock.js';
import type { PendingChange } from '../../src/tf/types.js';

/**
 * Shop.Api.xml: TFVC records it as binary (enc=-1, "File type: Binary") while
 * its bytes are plain XML, so Compare refused it as "a binary file". `enc` is
 * a label set when the item was added; the bytes decide.
 */

const NATIVE: Platform = process.platform === 'win32' ? 'win32' : 'linux';
const XML = Buffer.from('<?xml version="1.0"?>\r\n<doc><member name="Račun"/></doc>\r\n', 'utf8');
const DLL = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]);

const binaryChange = (localPath: string): PendingChange =>
  ({
    serverItem: '$/T/' + localPath.slice(localPath.lastIndexOf(NATIVE === 'win32' ? '\\' : '/') + 1),
    localPath,
    itemType: 'File',
    changes: new Set(['Edit']),
    changeFlags: 2,
    encoding: -1,
    version: 42,
    itemId: 73543,
    date: '2026-10-02T08:44:35.143+02:00',
  }) satisfies PendingChange;

describe('looksLikeText', () => {
  it('takes bytes with no NUL as text, as git does', () => {
    expect(looksLikeText(XML)).toBe(true);
    expect(looksLikeText(Buffer.alloc(0))).toBe(true);
  });

  it('takes a NUL anywhere as binary', () => {
    expect(looksLikeText(DLL)).toBe(false);
  });
});

describe('a file TFVC calls binary', () => {
  let dir: string;
  let xml: string;
  let dll: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'binary-but-text-'));
    xml = join(dir, 'Shop.Api.xml');
    dll = join(dir, 'Shop.Api.dll');
    writeFileSync(xml, XML);
    writeFileSync(dll, DLL);
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('reads the local bytes, and calls a missing file binary', () => {
    expect(localLooksLikeText(xml)).toBe(true);
    expect(localLooksLikeText(dll)).toBe(false);
    expect(localLooksLikeText(join(dir, 'gone.xml'))).toBe(false);
  });

  it('is compared when its local bytes are text', () => {
    expect(compareVerdict(true, binaryChange(xml), () => true)).toBe('ok');
    expect(compareVerdict(true, binaryChange(dll), () => false)).toBe('binary');
  });

  it('reads nothing for a file TFVC does not call binary', () => {
    let read = false;
    const edit = { ...binaryChange(xml), encoding: 1250 } as PendingChange;
    expect(compareVerdict(true, edit, () => (read = true))).toBe('ok');
    expect(read).toBe(false);
  });

  it('gets gutter bars when its local bytes are text, and none when they are not', () => {
    // A mapping's local path is tf's own, which under Wine is `Z:\tmp\...`:
    // given the native `/tmp/...`, nothing matched on Linux (CI, 1.0.3).
    const mapping = { serverItem: '$/T', localPath: new PathMapper([], NATIVE).toWinePath(dir) };
    const quickDiff = (change: PendingChange) =>
      new QuickDiff({
        pathMapper: new PathMapper([mapping], NATIVE),
        changeFor: () => change,
      } as never);
    expect(quickDiff(binaryChange(xml)).provideOriginalResource(Uri.file(xml) as never)).toBeDefined();
    expect(quickDiff(binaryChange(dll)).provideOriginalResource(Uri.file(dll) as never)).toBeUndefined();
  });
});
