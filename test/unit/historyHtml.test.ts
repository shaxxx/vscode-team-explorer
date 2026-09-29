import { describe, it, expect } from 'vitest';
import { historyHtml, makeNonce, escapeHtml } from '../../src/ui/historyHtml.js';

const html = (title = 'History - a.vb') =>
  historyHtml({
    cspSource: 'vscode-webview://abc',
    nonce: 'N0NCE',
    scriptUri: 'vscode-webview://abc/media/history.js',
    styleUri: 'vscode-webview://abc/media/history.css',
    title,
  });

describe('the History tab HTML shell', () => {
  it('locks the page down with a CSP: nothing by default, our script by nonce, our style by source', () => {
    const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(html())![1];
    expect(csp).toContain('default-src &#39;none&#39;');
    expect(csp).toContain('script-src &#39;nonce-N0NCE&#39;');
    expect(csp).toContain('style-src vscode-webview://abc');
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('unsafe-eval');
  });

  it('pins the exact CSP string, so an added source is caught even if still restrictive', () => {
    const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(html())![1];
    expect(csp).toBe(
      "default-src &#39;none&#39;; style-src vscode-webview://abc; font-src vscode-webview://abc; script-src &#39;nonce-N0NCE&#39;",
    );
  });

  it('loads exactly one script, the nonced one, and no inline code', () => {
    const scripts = html().match(/<script[^>]*>/g) ?? [];
    expect(scripts).toEqual(['<script nonce="N0NCE" src="vscode-webview://abc/media/history.js">']);
    expect(html()).not.toMatch(/<script[^>]*>[^<]+<\/script>/);
    expect(html()).not.toMatch(/\son[a-z]+=/i);
  });

  it('escapes the title, which carries a file name', () => {
    expect(html('History - <img src=x onerror=alert(1)>.vb')).toContain(
      '<title>History - &lt;img src=x onerror=alert(1)&gt;.vb</title>',
    );
  });

  it('makes a fresh, unguessable nonce each time', () => {
    expect(makeNonce()).not.toBe(makeNonce());
    expect(makeNonce()).toMatch(/^[A-Za-z0-9+/]{22}==$/);
  });

  it('escapes all five HTML-special characters', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
  });
});
