import { statSync, constants } from 'node:fs';

export interface DiskFacts {
  itemType: 'File' | 'Folder';
  readOnly: boolean;
  /**
   * When the file came into existence, in milliseconds -- `birthtime` where
   * the filesystem records one (NTFS always does), otherwise `undefined`. NOT
   * `ctime`: `chmod`/`attrib -R` moves ctime, so a versioned file made
   * writable (exactly the moment the `!` hazard badge exists to show) would
   * look freshly "created" and read as `notScanned` instead, hiding the badge
   * it exists for. See `chooseCreatedAtMs`.
   */
  createdAtMs: number | undefined;
}

/**
 * `birthtimeMs` when the filesystem actually recorded one, otherwise
 * `undefined` -- never `ctimeMs`. Pulled out of `diskFacts` so the choice is
 * testable without a filesystem: Node documents `birthtimeMs` as 0 where the
 * platform does not support it, and `undefined` here is what makes
 * `ScanResult.verdictFor`'s creation-time gate a no-op for such a file
 * instead of silently trusting a `ctime` a `chmod` could have just moved.
 */
export function chooseCreatedAtMs(stat: { birthtimeMs: number; ctimeMs: number }): number | undefined {
  return stat.birthtimeMs > 0 ? stat.birthtimeMs : undefined;
}

/**
 * Both facts from ONE stat, for callers that need both.
 *
 * The decoration provider asks per visible row on every refresh, and VS Code
 * asks about folder rows as well as files -- `labels.ts` calls
 * `getDecoration` for every row whatever its kind (read 2026-09-17), which the
 * typings do not say -- so taking two stats would double the syscalls for no
 * reason. `undefined` means the stat failed -- usually the path is gone,
 * which is ordinary rather than exceptional here: VS Code can ask about a row
 * between a delete and the tree refreshing. A permissions error lands here
 * too, and draws nothing, which is the right answer for both.
 */
export function diskFacts(fsPath: string): DiskFacts | undefined {
  try {
    const st = statSync(fsPath);
    return {
      itemType: st.isDirectory() ? 'Folder' : 'File',
      readOnly: (st.mode & constants.S_IWUSR) === 0,
      createdAtMs: chooseCreatedAtMs(st),
    };
  } catch {
    return undefined;
  }
}

export function isReadOnly(fsPath: string): boolean {
  // `?? false` reproduces the old catch: a path that cannot be stat'd is not a
  // file to check out. `diskFacts` answers `undefined` instead because its
  // caller must tell "gone" from "present and writable".
  return diskFacts(fsPath)?.readOnly ?? false;
}
