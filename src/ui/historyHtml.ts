import { randomBytes } from 'node:crypto';

/** 128 random bits per render: the CSP admits only the script carrying it. */
export function makeNonce(): string {
  return randomBytes(16).toString('base64');
}

const ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ENTITIES[c]);
}

/**
 * The History tab's page. An empty shell: the script builds
 * every element from the state the extension posts, inserting server text
 * with textContent only, so nothing tf printed is ever parsed as HTML.
 */
export function historyHtml(options: {
  cspSource: string;
  nonce: string;
  scriptUri: string;
  styleUri: string;
  title: string;
}): string {
  const csp = [
    "default-src 'none'",
    `style-src ${options.cspSource}`,
    `font-src ${options.cspSource}`,
    `script-src 'nonce-${options.nonce}'`,
  ].join('; ');
  return [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="UTF-8">',
    `<meta http-equiv="Content-Security-Policy" content="${escapeHtml(csp)}">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
    `<link rel="stylesheet" href="${escapeHtml(options.styleUri)}">`,
    `<title>${escapeHtml(options.title)}</title>`,
    '</head>',
    '<body>',
    '<main id="app"></main>',
    `<script nonce="${escapeHtml(options.nonce)}" src="${escapeHtml(options.scriptUri)}"></script>`,
    '</body>',
    '</html>',
  ].join('\n');
}
