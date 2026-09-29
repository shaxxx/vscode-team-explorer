import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The agent skill shipped in the repo (not in the .vsix). Installing it replaces the
 * one Collection URL placeholder in the installed copy; an update reads the URL back
 * from that same line, so the placeholder must stay exactly once, on its own line.
 */
const SKILL = join(__dirname, '../../skills/tfs-workflow/SKILL.md');
const text = (): string => readFileSync(SKILL, 'utf8');

describe('skills/tfs-workflow/SKILL.md', () => {
  it('starts with frontmatter that names and describes the skill', () => {
    const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text());
    expect(m).not.toBeNull();
    expect(m![1]).toMatch(/^name: tfs-workflow\r?$/m);
    expect(m![1]).toMatch(/^description: \S.{20,}\r?$/m);
  });

  it('holds the collection URL placeholder exactly once, on its own Collection URL line', () => {
    const t = text();
    expect(t.split('<COLLECTION_URL>')).toHaveLength(2);
    expect(t).toMatch(/^Collection URL: <COLLECTION_URL>\r?$/m);
  });

  it('never lets the agent check in', () => {
    expect(text()).toMatch(/never check in/i);
  });

  it('calls the wrapper at the extension\'s default path on both systems', () => {
    const t = text();
    expect(t).toContain('\\bin\\tfp.cmd');
    expect(t).toContain('~/bin/tfp');
  });
});
