import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isPreviewFailure, parsePreview } from '../../src/tf/parseResolve.js';

const fx = (dir: 'windows' | 'fedora', name: string) =>
  readFileSync(join(__dirname, '../fixtures', dir, name), 'utf8');

const BLOCKED = 'A non version controlled file or writable file by the same name already exists locally.';
const EDITED = 'You have a conflicting pending change.';

describe('parsePreview (C6-C9)', () => {
  it('reads "none" from exit 0 and an empty stderr, whatever stdout says', () => {
    expect(parsePreview(0, fx('windows', 'resolve-preview-none.stdout.txt'), '')).toEqual([]);
    expect(parsePreview(0, fx('fedora', 'resolve-preview-none.stdout.txt'), '')).toEqual([]);
    // tf localises; its sentence is never read, so another language changes nothing.
    expect(parsePreview(0, 'Nema sukoba za razrješavanje.', '')).toEqual([]);
  });

  it('cannot tell a false "none" from a real one -- which is why the listing always carries /recursive (C9)', () => {
    expect(parsePreview(0, fx('windows', 'resolve-preview-nonrecursive.stdout.txt'), '')).toEqual([]);
  });

  it('lists relative paths with tf reasons verbatim', () => {
    expect(parsePreview(1, '', fx('windows', 'resolve-preview-relative.stderr.txt'))).toEqual([
      { path: 'Program.cs', reason: BLOCKED },
      { path: 'Startup.cs', reason: EDITED },
    ]);
  });

  it('keeps the drive colon in an absolute path, with a Croatian letter and a space', () => {
    const [c] = parsePreview(1, '', fx('windows', 'resolve-preview-absolute-croatian.stderr.txt'));
    expect(c.path.endsWith(String.raw`\p5-Urudžbeni zapisnik\Urudzbeni.sln`)).toBe(true);
    expect(c.path.startsWith('C:\\')).toBe(true);
    expect(c.reason).toBe(BLOCKED);
    expect(parsePreview(1, '', fx('windows', 'resolve-preview-relative-croatian.stderr.txt'))).toEqual([
      { path: String.raw`p5-Urudžbeni zapisnik\Urudzbeni.sln`, reason: BLOCKED },
    ]);
  });

  it("reads FEDORA's Z: paths the same way", () => {
    expect(parsePreview(1, '', fx('fedora', 'resolve-preview-absolute-croatian.stderr.txt'))).toEqual([
      { path: String.raw`Z:\home\shax\p5-Urudžbeni zapisnik\Urudzbeni.sln`, reason: BLOCKED },
    ]);
    expect(parsePreview(1, '', fx('fedora', 'resolve-preview-relative-croatian.stderr.txt'))).toEqual([
      { path: 'Urudzbeni.sln', reason: BLOCKED },
    ]);
  });

  it("reads the real DEVPC workspace's conflict (C19)", () => {
    expect(parsePreview(1, '', fx('windows', 'resolve-preview-real-devpc.stderr.txt'))).toEqual([
      { path: String.raw`C:\work\OPS\OPS2023\CORE.Api\CORE.Api.xml`, reason: EDITED },
    ]);
  });

  it('keeps a conflict tf names by its server path, alongside the rest (no local item)', () => {
    expect(parsePreview(1, '', `${String.raw`C:\work\Shop\a.cs`}: ${EDITED}\r\n$/Shop/b.cs: gone\r\n`)).toEqual([
      { path: String.raw`C:\work\Shop\a.cs`, reason: EDITED },
      { path: '$/Shop/b.cs', reason: 'gone' },
    ]);
    expect(() => parsePreview(1, '', '$/Shop/a:b.cs: reason')).toThrow(/not a conflict line/);
  });

  it('throws on anything it does not understand, so the caller keeps what it had', () => {
    expect(() => parsePreview(1, 'something on stdout', 'a.cs: reason')).toThrow(/stdout/);
    expect(() => parsePreview(1, '', '')).toThrow(/nothing listed/);
    expect(() => parsePreview(1, '', 'no separator here')).toThrow(/not a conflict line/);
    expect(() => parsePreview(1, '', String.raw`C:\a:b.cs: reason`)).toThrow(/not a conflict line/);
    expect(() => parsePreview(1, '', 'a.cs: ')).toThrow(/not a conflict line/);
    expect(() => parsePreview(0, '', 'a.cs: reason')).toThrow(/exit 0/);
    expect(() => parsePreview(100, '', '')).toThrow(/exit code 100/);
    // One bad line spoils the lot: a half-understood list is never shown.
    expect(() => parsePreview(1, '', 'a.cs: reason\r\nstray')).toThrow(/stray/);
  });

  it('drops a byte-order mark and blank lines', () => {
    const bom = String.fromCharCode(0xfeff);
    expect(parsePreview(1, '', `${bom}a.cs: reason\r\n\r\n`)).toEqual([{ path: 'a.cs', reason: 'reason' }]);
  });
});

describe('isPreviewFailure', () => {
  it('is a listing on exit 0 and 1, a failure on anything else (C10: exit 100)', () => {
    expect(isPreviewFailure(0, fx('windows', 'resolve-preview-none.stdout.txt'), '')).toBe(false);
    expect(isPreviewFailure(1, '', fx('windows', 'resolve-preview-relative.stderr.txt'))).toBe(false);
    expect(isPreviewFailure(100, '', fx('windows', 'resolve-preview-serverpath-outside.stderr.txt'))).toBe(true);
    expect(isPreviewFailure(-1, '', '[tfvc] Refusing to run "resolve" in a shape this extension never builds')).toBe(true);
  });

  it('is a failure when a TF code or the wrapper speaks, even on exit 1', () => {
    expect(isPreviewFailure(1, '', 'TF30063: You are not authorized to access https://acme.visualstudio.com/.')).toBe(true);
    expect(isPreviewFailure(1, '[tfp] PAT file not found', '')).toBe(true);
  });
});
