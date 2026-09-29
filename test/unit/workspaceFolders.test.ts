import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TfvcService } from '../../src/TfvcService.js';
import { outputChannel, Uri } from '../vscode-mock.js';

// Two real workspaces on DEVPC: `DEVPC` ($/ and Insight.Database) and a
// throwaway one with a cloak. Windows paths, so Windows only.
const XML = readFileSync(join(__dirname, '../fixtures/windows/workspaces-cloaked.xml'));
const ON_WINDOWS = process.platform === 'win32';

function service(folder: string) {
  const client = {
    timeoutMs: 1000,
    run: async (args: string[]) => ({
      stdout: args.includes('workspaces') ? XML : Buffer.from('<Status />'),
      stderr: Buffer.alloc(0),
      exitCode: 0,
      timedOut: false,
    }),
  };
  return new TfvcService(client as never, { uri: Uri.file(folder) } as never, 'https://acme.visualstudio.com/', outputChannel as never);
}

describe.skipIf(!ON_WINDOWS)("TfvcService.workspaceFolders: the opened folder's OWN workspace (phase 5)", () => {
  it("is every mapping of the workspace the folder is in, and none of another workspace's", async () => {
    const s = service(String.raw`C:\work\Shop`);
    expect(await s.initialize()).toBeUndefined();
    expect(s.workspaceFolders.map((f) => f.serverItem)).toEqual(['$/', '$/Vesta/DatabaseFirst/Insight.Database']);
    s.dispose();
  });

  it('never includes a cloak, which has no local folder to ask about', async () => {
    const s = service(String.raw`C:\Users\user1\AppData\Local\Temp\tfvc-probe-fix\assets`);
    expect(await s.initialize()).toBeUndefined();
    expect(s.workspaceFolders.map((f) => f.serverItem)).toEqual(['$/Shop/Shop2023/Enterprise.Till.Server/Web']);
    s.dispose();
  });

  it('is empty for a folder no workspace maps', async () => {
    const s = service(String.raw`D:\somewhere\else`);
    expect(await s.initialize()).toBeDefined();
    expect(s.workspaceFolders).toEqual([]);
    s.dispose();
  });
});
