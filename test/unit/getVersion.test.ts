import { describe, it, expect } from 'vitest';
import {
  getLatestArgs,
  getVersionArgs,
  needsOverwriteConfirm,
  parseVersionRequest,
  versionSpec,
  type VersionRequest,
} from '../../src/explorer/getVersion.js';
import { S } from '../../src/tf/strings.js';

const req = (over: Partial<VersionRequest> = {}): VersionRequest => ({
  kind: 'changeset',
  value: '16730',
  overwriteWritable: false,
  getAll: false,
  ...over,
});

describe('versionSpec', () => {
  it('builds each kind', () => {
    expect(versionSpec('changeset', ' 16730 ')).toEqual({ ok: true, spec: 'C16730' });
    expect(versionSpec('date', '2026-09-01')).toEqual({ ok: true, spec: 'D2026-09-01T00:00' });
    expect(versionSpec('label', 'Release 1.0')).toEqual({ ok: true, spec: 'LRelease 1.0' });
    expect(versionSpec('latest', 'ignored')).toEqual({ ok: true, spec: 'T' });
    expect(versionSpec('workspace', '')).toEqual({ ok: true, spec: 'W' });
  });

  it('refuses a changeset that is not a positive int32', () => {
    for (const bad of ['', 'abc', '0', '-5', '1.5', '2147483648', 'C16730']) {
      expect(versionSpec('changeset', bad)).toEqual({ ok: false, message: S.gsvBadChangeset });
    }
    expect(versionSpec('changeset', '2147483647')).toEqual({ ok: true, spec: 'C2147483647' });
  });

  it('refuses a date that is not a real YYYY-MM-DD', () => {
    for (const bad of ['', '1.9.2026', '2026-9-1', '2026-02-30', '2026-13-01', '2026-09-01T10:00']) {
      expect(versionSpec('date', bad)).toEqual({ ok: false, message: S.gsvBadDate });
    }
  });

  it("refuses a label tf would misread or TfClient would refuse", () => {
    for (const bad of ['', '-x', 'a/b', 'a"b', 'a;b', 'a@b', 'a%b', 'a!b', 'a^b', 'a\nb', 'a\tb', 'x'.repeat(65)]) {
      expect(versionSpec('label', bad)).toEqual({ ok: false, message: S.gsvBadLabel });
    }
  });
});

describe('getVersionArgs', () => {
  it('puts the paths, the version, then only the flags asked for', () => {
    expect(getVersionArgs(['$/A/a.txt'], req(), false)).toEqual({ ok: true, args: ['vc', 'get', '$/A/a.txt', '/version:C16730'] });
    expect(getVersionArgs(['$/A', '$/B/b.txt'], req({ overwriteWritable: true, getAll: true }), true)).toEqual({
      ok: true,
      args: ['vc', 'get', '$/A', '$/B/b.txt', '/version:C16730', '/recursive', '/overwrite', '/all'],
    });
  });

  it('refuses an empty selection and a bad value, building nothing', () => {
    expect(getVersionArgs([], req(), false)).toEqual({ ok: false, message: S.sceNeedsSelection });
    expect(getVersionArgs(['$/A'], req({ value: 'x' }), false)).toEqual({ ok: false, message: S.gsvBadChangeset });
  });

  it('never sends /force', () => {
    const built = getVersionArgs(['$/A'], req({ overwriteWritable: true, getAll: true }), true);
    expect(built.ok).toBe(true);
    expect(built.ok && built.args).not.toContain('/force');
  });

  it('refuses anything that is not a server path, so no argv can mean "the whole workspace" or a switch', () => {
    for (const bad of [['/all'], ['C:\\x'], [''], ['$/A', '-x']]) {
      expect(getVersionArgs(bad, req(), true)).toEqual({ ok: false, message: S.sceUnknownPath });
    }
  });
});

describe('getLatestArgs', () => {
  it('is Phase 1 Get Latest: the paths and /recursive', () => {
    expect(getLatestArgs(['$/A', '$/B/b.txt'])).toEqual(['vc', 'get', '$/A', '$/B/b.txt', '/recursive']);
  });

  it('throws rather than build `vc get /recursive`, which would get the whole workspace', () => {
    expect(() => getLatestArgs([])).toThrow();
    expect(() => getLatestArgs(['/force'])).toThrow();
    expect(() => getLatestArgs(['$/A', 'C:\\x'])).toThrow();
  });
});

describe('needsOverwriteConfirm (design X3)', () => {
  it('asks again when either box is ticked', () => {
    expect(needsOverwriteConfirm(req())).toBe(false);
    expect(needsOverwriteConfirm(req({ overwriteWritable: true }))).toBe(true);
    expect(needsOverwriteConfirm(req({ getAll: true }))).toBe(true);
  });
});

describe('parseVersionRequest', () => {
  it('accepts exactly the shape the page posts', () => {
    expect(parseVersionRequest(req())).toEqual(req());
  });

  it('refuses anything else', () => {
    for (const bad of [
      undefined,
      null,
      [],
      'x',
      { ...req(), kind: 'force' },
      { ...req(), value: 5 },
      { ...req(), value: 'x'.repeat(201) },
      { ...req(), overwriteWritable: 'yes' },
      { kind: 'changeset', value: '1' },
    ]) {
      expect(parseVersionRequest(bad)).toBeUndefined();
    }
  });
});
