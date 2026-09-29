import type { WorkingFolder } from './types.js';

export type Platform = 'win32' | 'linux';

/**
 * The comparison key for a LOCAL path.
 *
 * Windows and TFVC are both case-insensitive, and tf.exe is demonstrably
 * inconsistent about which case it emits -- one real capture mixed `C:\work`
 * 79,920 times with `c:\work` 9 times. Linux is case-sensitive, where two paths
 * differing only in case are two different files, so the platform decides.
 *
 * `platform` is REQUIRED and has no default, deliberately. A default of
 * `process.platform` cannot be mutation-tested on the platform it defaults to:
 * hardcoding it to 'win32' passed all 42 files and 377 tests on DEVPC, which is
 * precisely the bug the test guarding it claimed to catch.
 *
 * Three other places still decide this question for themselves --
 * `AutoCheckout.key` (a Map key), `dedupeUris` (a Set key) and `samePath` (a
 * comparator, so `localKey(a,p) === localKey(b,p)`). Each would need a platform
 * threaded in from somewhere, in a layer that is meant to be platform-blind, so
 * converging them is its own change. `isUnder` below already uses this.
 */
export function localKey(path: string, platform: Platform): string {
  return platform === 'win32' ? path.toLowerCase() : path;
}

/**
 * Translates between the editor's local paths and TFVC `$/` server paths.
 *
 * This is the ONLY module that knows Wine exists. On Linux, tf.exe runs under
 * Wine and sees the filesystem through a `Z:` drive, so `/home/shax/work`
 * appears to tf as `Z:\home\shax\work`.
 */
export class PathMapper {
  private readonly folders: WorkingFolder[];

  constructor(folders: WorkingFolder[], private readonly platform: Platform) {
    // Longest local path first, so the first match is the most specific one.
    this.folders = [...folders].sort((a, b) => b.localPath.length - a.localPath.length);
  }

  /** `/home/shax/work/x` -> `Z:\home\shax\work\x`. A no-op on Windows. */
  toWinePath(localPath: string): string {
    if (this.platform === 'win32') return localPath;
    return 'Z:' + localPath.replace(/\//g, '\\');
  }

  /** `Z:\home\shax\work\x` -> `/home/shax/work/x`. A no-op on Windows. */
  fromWinePath(winePath: string): string {
    if (this.platform === 'win32') return winePath;
    return winePath.replace(/^Z:/i, '').replace(/\\/g, '/');
  }

  /**
   * The deepest workspace mapping containing `localPath`, in LOCAL form
   * (`fromWinePath` applied -- e.g. `/home/shax/work` on Fedora, never the
   * raw `Z:\home\shax\work`). `undefined` when `localPath` is not under any
   * mapping.
   *
   * Used to bound `findTfIgnore`'s upward walk to the mapping's own root:
   * walking further up would eventually reach a directory this workspace
   * does not even map, on either machine.
   */
  localRootFor(localPath: string): string | undefined {
    const wine = this.toWinePath(localPath);
    // `this.folders` is already sorted longest-local-path-first (see the
    // constructor), so the first match here is the deepest one -- same
    // reasoning `toServerPath` below relies on.
    const folder = this.folders.find((f) => this.isUnder(wine, f.localPath));
    return folder ? this.fromWinePath(folder.localPath) : undefined;
  }

  toServerPath(localPath: string): string | undefined {
    const wine = this.toWinePath(localPath);
    const folder = this.folders.find((f) => this.isUnder(wine, f.localPath));
    if (!folder) return undefined;

    const rest = wine.slice(folder.localPath.length).replace(/^\\/, '');
    if (rest === '') return folder.serverItem;

    const base = folder.serverItem === '$/' ? '$/' : folder.serverItem + '/';
    return base + rest.replace(/\\/g, '/');
  }

  toLocalPath(serverPath: string): string | undefined {
    const folder = this.folders
      .slice()
      .sort((a, b) => b.serverItem.length - a.serverItem.length)
      .find((f) => this.isUnderServer(serverPath, f.serverItem));
    if (!folder) return undefined;

    const prefix = folder.serverItem === '$/' ? '$/' : folder.serverItem + '/';
    const rest = serverPath.slice(prefix.length);
    const wine = rest === ''
      ? folder.localPath
      : folder.localPath + '\\' + rest.replace(/\//g, '\\');

    return this.fromWinePath(wine);
  }

  /**
   * Path comparison is case-insensitive on Windows because tf.exe itself is
   * inconsistent: one status output mixed `C:\work` (79,920 times) with
   * `c:\work` (9 times). The POSIX portion on Linux stays case-sensitive.
   */
  private isUnder(candidate: string, root: string): boolean {
    const a = localKey(candidate, this.platform);
    const b = localKey(root, this.platform);
    // On Linux the `Z:` drive letter itself is still case-insensitive.
    const norm = (s: string) => (this.platform === 'linux' ? s.replace(/^z:/i, 'Z:') : s);
    const x = norm(a);
    const y = norm(b);
    return x === y || x.startsWith(y.endsWith('\\') ? y : y + '\\');
  }

  /**
   * Server paths are case-insensitive too, and on BOTH platforms — this is
   * TFVC's own rule, not the local filesystem's, so unlike `isUnder` it does
   * not vary by platform. `$/ledger/x.sql` and `$/Ledger/x.sql` are one item
   * on the server, and the same trap that silently dropped an exclusion would
   * otherwise leave this returning undefined for a file that is plainly
   * mapped.
   */
  private isUnderServer(candidate: string, root: string): boolean {
    const c = candidate.toLowerCase();
    const r = root.toLowerCase();
    if (r === '$/') return c.startsWith('$/');
    return c === r || c.startsWith(r + '/');
  }
}
