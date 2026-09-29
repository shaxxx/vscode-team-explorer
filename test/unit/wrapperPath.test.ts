import { describe, it, expect } from 'vitest';
import { defaultWrapperPath } from '../../src/tf/wrapperPath.js';

describe('defaultWrapperPath', () => {
  it('is ~/bin/tfp.cmd on Windows', () => {
    expect(defaultWrapperPath('win32', 'C:\\Users\\user1')).toBe('C:\\Users\\user1\\bin\\tfp.cmd');
  });

  it('is ~/bin/tfp on Linux', () => {
    expect(defaultWrapperPath('linux', '/home/user1')).toBe('/home/user1/bin/tfp');
  });

  it('never points into a Claude skill folder, which only one machine has', () => {
    expect(defaultWrapperPath('win32', 'C:\\Users\\user1')).not.toMatch(/\.claude/);
  });
});
