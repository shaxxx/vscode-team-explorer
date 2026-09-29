/**
 * `tf vc get <local> /recursive` output (design P8): a `<local folder>:`
 * header, then one `Getting <name>` / `Replacing <name>` / `Deleting <name>`
 * per item, a blank line between folders; `All files are up to date.` when
 * nothing changed. Counted for progress only -- the exit code decides success.
 */
export type GetLineKind = 'folder' | 'getting' | 'replacing' | 'deleting' | 'upToDate' | 'other';

export function classifyGetLine(line: string): GetLineKind {
  const l = line.trim();
  if (l === '') return 'other';
  if (l === 'All files are up to date.') return 'upToDate';
  if (l.startsWith('Getting ')) return 'getting';
  if (l.startsWith('Replacing ')) return 'replacing';
  if (l.startsWith('Deleting ')) return 'deleting';
  if (l.endsWith(':') && /^[A-Za-z]:\\/.test(l)) return 'folder';
  return 'other';
}

/** Turns stdout chunks into whole lines; a line may be split across chunks. */
export function lineSplitter(onLine: (line: string) => void): { push(chunk: Buffer): void; end(): void } {
  let pending = Buffer.alloc(0);
  const emit = (bytes: Buffer) => onLine(bytes.toString('utf8').replace(/\r$/, ''));
  return {
    push(chunk: Buffer) {
      pending = Buffer.concat([pending, chunk]);
      let nl = pending.indexOf(0x0a);
      while (nl >= 0) {
        // Moved past BEFORE the callback runs: a callback that throws must not
        // leave its line in `pending`, to be delivered again with every chunk.
        const line = pending.subarray(0, nl);
        pending = pending.subarray(nl + 1);
        emit(line);
        nl = pending.indexOf(0x0a);
      }
    },
    end() {
      if (pending.length > 0) emit(pending);
      pending = Buffer.alloc(0);
    },
  };
}
