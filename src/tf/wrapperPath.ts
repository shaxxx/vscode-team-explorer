import { posix, win32 } from 'node:path';

/**
 * Where the tfp wrapper is looked for when `teamExplorer.wrapperPath` is empty.
 *
 * `~/bin` on both platforms, so the install guides can say one thing. The
 * Windows default used to point into one user's Claude skill folder, which
 * nobody else has.
 *
 * Joined with the TARGET platform's rules, not the host's, so the answer does
 * not depend on which machine runs the tests.
 */
export function defaultWrapperPath(platform: NodeJS.Platform, home: string): string {
  return platform === 'win32' ? win32.join(home, 'bin', 'tfp.cmd') : posix.join(home, 'bin', 'tfp');
}
