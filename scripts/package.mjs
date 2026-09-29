// Builds the .vsix. Its Details tab shows docs/features.md, with relative links
// and images rewritten to GitHub URLs pinned to this version's tag, so an
// installed .vsix always shows the screenshots of its own release.
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const repo = 'https://github.com/shaxxx/vscode-team-explorer';
// --no-install: without it, `npx vsce` silently falls back to downloading the
// deprecated unscoped `vsce` 2.x package when node_modules lacks the pinned
// @vscode/vsce (e.g. a checkout where `npm ci` was not rerun after it was
// added). That would package with a tool nobody tested this against.
const args = [
  '--no-install', 'vsce', 'package', '--no-dependencies',
  '--readme-path', 'docs/features.md',
  '--baseContentUrl', `${repo}/blob/v${version}/docs`,
  '--baseImagesUrl', `${repo}/raw/v${version}/docs`,
];
const r = spawnSync('npx', args, { stdio: 'inherit', shell: process.platform === 'win32' });
if (r.error) {
  console.error(r.error);
}
process.exit(r.status ?? 1);
