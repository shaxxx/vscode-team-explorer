import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ShelveService } from '../../src/shelve/ShelveService.js';
import type { TfResult } from '../../src/tf/TfClient.js';
import { S } from '../../src/tf/strings.js';

const URL = 'https://acme.visualstudio.com/';
const fixture = (name: string) => readFileSync(join(__dirname, '../fixtures/windows', name));

function setup(...answers: Partial<TfResult>[]) {
  const calls: string[][] = [];
  const client = {
    timeoutMs: 60_000,
    run: vi.fn(async (args: string[]) => {
      calls.push(args);
      return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0, timedOut: false, ...(answers.shift() ?? {}) } as TfResult;
    }),
  };
  return { calls, client, service: new ShelveService(client, URL) };
}

const NONE_FOUND = { exitCode: 100, stderr: Buffer.from('No shelvesets found matching x;Filip\r\n') };

describe('ShelveService: reading (spec S2, S2b, S3)', () => {
  it('lists the caller own with no /owner, and anyone else with it', async () => {
    const { calls, service } = setup({ stdout: fixture('shelvesets-list.xml') }, {}, {});
    const mine = await service.list('');
    await service.list(' Nika Blaškova ');
    await service.list('*');
    expect(mine.ok && mine.value).toHaveLength(6);
    expect(calls).toEqual([
      ['vc', 'shelvesets', '/format:xml', `/collection:${URL}`],
      ['vc', 'shelvesets', '/owner:Nika Blaškova', '/format:xml', `/collection:${URL}`],
      ['vc', 'shelvesets', '/owner:*', '/format:xml', `/collection:${URL}`],
    ]);
  });

  it('reads "none found" (exit 100, no TF code) as an empty list, and an unknown owner as a failure', async () => {
    const { service } = setup(NONE_FOUND, { exitCode: 100, stderr: Buffer.from('TF14045: The identity x is not a recognized identity.') });
    expect(await service.list('')).toEqual({ ok: true, value: [] });
    const unknown = await service.list('x');
    expect(unknown.ok).toBe(false);
    expect(!unknown.ok && unknown.message).toContain('TF14045');
  });

  it('reports a timeout rather than an empty list', async () => {
    const { service } = setup({ exitCode: -1, timedOut: true });
    expect(await service.list('')).toEqual({ ok: false, message: S.commandTimedOut(60_000) });
  });

  it('refuses an owner that cannot be passed to tf safely, without calling tf', async () => {
    const { calls, service } = setup();
    expect(await service.list('a"b')).toEqual({ ok: false, message: S.shelvesetsBadOwner });
    expect(calls).toEqual([]);
  });

  it('says whether the caller already owns a name, ignoring case', async () => {
    const { calls, service } = setup({ stdout: fixture('shelvesets-list.xml') }, NONE_FOUND);
    expect(await service.exists('ef6 migration 9')).toEqual({ ok: true, value: true });
    expect(await service.exists('nope')).toEqual({ ok: true, value: false });
    expect(calls[0]).toEqual(['vc', 'shelvesets', 'ef6 migration 9', '/format:xml', `/collection:${URL}`]);
  });

  it('reads a shelveset by name;owner, and refuses an answer that is a workspace status', async () => {
    const { calls, service } = setup({ stdout: fixture('status-shelveset.xml') }, { stdout: fixture('status-mixed.xml') });
    const r = await service.contents('EF6 Migration 9', 'user@example.com');
    expect(r.ok && r.value).toHaveLength(3);
    expect(calls[0]).toEqual(['vc', 'status', '/shelveset:EF6 Migration 9;user@example.com', '/format:xml', '/recursive']);
    expect((await service.contents('x', 'y')).ok).toBe(false);
  });

  it('views one shelved file, and refuses anything but a server path without running tf', async () => {
    const { calls, service } = setup({ stdout: Buffer.from([0x9e, 0x0a]) });
    const r = await service.view('P', 'user@example.com', '$/K/a.txt');
    expect(r.ok && [...r.value]).toEqual([0x9e, 0x0a]);
    expect(calls).toEqual([['vc', 'view', '/shelveset:P;user@example.com', '$/K/a.txt', '/console']]);
    expect((await service.view('P', 'o', 'C:\\work\\a.txt')).ok).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('reports a failed view as a failure, never as empty content', async () => {
    const { service } = setup({ exitCode: 100, stderr: Buffer.from('TF10151: The item could not be found in the shelveset.') });
    const r = await service.view('P', 'user@example.com', '$/K/a.txt');
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toContain('TF10151');
  });

  it("reads back which of these items are pending in this workspace", async () => {
    const xml = '<Status><PendingSet computer="C" name="W" ownerdisp="I" ownership="1"><PendingChanges><PendingChange chg="Edit" item="$/K/a.cs" local="C:\\work\\K\\a.cs" itemid="1" enc="1250" type="File" /></PendingChanges></PendingSet></Status>';
    const { calls, service } = setup({ stdout: Buffer.from(xml) });
    expect(await service.pendingIn(['$/K/a.cs', '$/K/b.cs'])).toEqual({ ok: true, value: ['$/K/a.cs'] });
    expect(calls[0]).toEqual(['vc', 'status', '$/K/a.cs', '$/K/b.cs', '/format:xml']);
  });

  it('reports a failed pendingIn read as a failure, never as an empty result or all-pending', async () => {
    const { service } = setup(
      { exitCode: 1, stderr: Buffer.from('TF10176: Unable to determine the workspace.') },
      { exitCode: -1, timedOut: true },
      { exitCode: -1, terminatedBy: 'SIGTERM' },
    );
    const failed = await service.pendingIn(['$/K/a.cs']);
    expect(failed.ok).toBe(false);
    expect(!failed.ok && failed.message).toContain('TF10176');
    expect(await service.pendingIn(['$/K/a.cs'])).toEqual({ ok: false, message: S.commandTimedOut(60_000) });
    expect(await service.pendingIn(['$/K/a.cs'])).toEqual({ ok: false, message: S.outcomeUnknown('SIGTERM') });
  });

  it('refuses an unsafe name in exists() without calling tf', async () => {
    const { calls, service } = setup();
    expect(await service.exists('-x')).toEqual({ ok: false, message: S.shelveBadNameDash });
    expect(calls).toEqual([]);
  });
});

describe('ShelveService: changing things', () => {
  it('shelves exactly the named paths, with the comment file, and keeps the changes by default', async () => {
    const { calls, service } = setup({}, {});
    await service.shelve({ name: 'fiskal', paths: ['C:\\work\\K\\a.cs', 'C:\\work\\K\\b.cs'], commentPath: 'C:\\t\\c.txt', replace: false, move: false });
    await service.shelve({ name: 'fiskal', paths: ['C:\\work\\K\\a.cs'], replace: true, move: true });
    expect(calls).toEqual([
      ['vc', 'shelve', 'fiskal', 'C:\\work\\K\\a.cs', 'C:\\work\\K\\b.cs', '/comment:@C:\\t\\c.txt'],
      ['vc', 'shelve', '/replace', '/move', 'fiskal', 'C:\\work\\K\\a.cs'],
    ]);
  });

  it('never runs a shelve with no paths, a bad path or a bad name: a bare shelve takes EVERY pending change', async () => {
    const { calls, service } = setup();
    expect(await service.shelve({ name: 'x', paths: [], replace: false, move: false })).toEqual({ exitCode: -1, message: S.shelveNoItems });
    expect((await service.shelve({ name: 'x', paths: ['/recursive'], replace: false, move: false })).exitCode).toBe(-1);
    expect((await service.shelve({ name: 'x', paths: ['C:\\work\\*.cs'], replace: false, move: false })).exitCode).toBe(-1);
    expect(await service.shelve({ name: '-x', paths: ['C:\\a.cs'], replace: false, move: false })).toEqual({ exitCode: -1, message: S.shelveBadNameDash });
    expect(calls).toEqual([]);
  });

  it('unshelves the whole shelveset, or exactly the named items, and never with /move', async () => {
    const { calls, service } = setup({}, {});
    await service.unshelve({ name: 'EF6 Migration 9', ownerUnique: 'user@example.com' });
    await service.unshelve({ name: 'EF6 Migration 9', ownerUnique: 'user@example.com', items: ['$/K/a.cs'] });
    expect(calls).toEqual([
      ['vc', 'unshelve', 'EF6 Migration 9;user@example.com'],
      ['vc', 'unshelve', 'EF6 Migration 9;user@example.com', '$/K/a.cs'],
    ]);
  });

  it('refuses an empty item list, and a shelveset that cannot be named safely, without running tf', async () => {
    const { calls, service } = setup();
    expect((await service.unshelve({ name: 'P', ownerUnique: 'o', items: [] })).exitCode).toBe(-1);
    expect((await service.unshelve({ name: '100% done', ownerUnique: 'o' })).exitCode).toBe(-1);
    expect((await service.unshelve({ name: 'P', ownerUnique: 'o', items: ['/move'] })).exitCode).toBe(-1);
    expect(calls).toEqual([]);
  });

  it('refuses a wildcard in a deleteOwn name or an unshelve item, without running tf', async () => {
    const { calls, service } = setup();
    expect((await service.deleteOwn('*')).exitCode).toBe(-1);
    expect((await service.deleteOwn('a?b')).exitCode).toBe(-1);
    expect((await service.unshelve({ name: 'P', ownerUnique: 'o', items: ['$/K/*'] })).exitCode).toBe(-1);
    expect(calls).toEqual([]);
  });

  it('deletes by the bare name, so tf can only resolve it to the caller own', async () => {
    const { calls, service } = setup({});
    expect(await service.deleteOwn('EF6 Migration 9')).toEqual({ exitCode: 0 });
    expect(calls).toEqual([['vc', 'shelve', '/delete', 'EF6 Migration 9']]);
    expect((await service.deleteOwn('a;b')).exitCode).toBe(-1);
    expect((await service.deleteOwn('')).exitCode).toBe(-1);
    expect(calls).toHaveLength(1);
  });

  it("scrubs a PAT-like token out of tf's text, for a read and for a mutation (coordinator review I3)", async () => {
    const T = 'zz7fakefaketokenfake4example5678';
    const leaked = `TF14098: failed running TF.exe status /login:.,${T} /noprompt`;
    const { service } = setup(
      { exitCode: 100, stderr: Buffer.from(leaked) },
      { exitCode: 100, stderr: Buffer.from(leaked) },
    );
    const read = await service.list('x');
    expect(read.ok).toBe(false);
    expect(!read.ok && read.message).not.toContain(T);

    const mutation = await service.deleteOwn('EF6 Migration 9');
    expect(mutation.exitCode).not.toBe(0);
    expect(mutation.message).not.toContain(T);
  });

  it("reports tf's own text with its exit code, a timeout, and a killed tf", async () => {
    const { service } = setup(
      { exitCode: 1, stderr: Buffer.from('x could not be retrieved because a writable file by the same name exists locally.') },
      { exitCode: -1, timedOut: true },
      { exitCode: -1, terminatedBy: 'SIGTERM' },
    );
    const failed = await service.unshelve({ name: 'P', ownerUnique: 'o' });
    expect(failed.exitCode).toBe(1);
    expect(failed.message).toContain('writable file');
    expect(await service.unshelve({ name: 'P', ownerUnique: 'o' })).toEqual({ exitCode: -1, message: S.commandTimedOut(60_000) });
    expect(await service.unshelve({ name: 'P', ownerUnique: 'o' })).toEqual({ exitCode: -1, message: S.outcomeUnknown('SIGTERM') });
  });
});
