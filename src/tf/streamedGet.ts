import type { RunOptions, TfResult } from './TfClient.js';
import { classifyGetLine, lineSplitter } from './parseGet.js';

type Client = { run(args: string[], opts?: RunOptions): Promise<TfResult> };

export interface StreamedGetResult {
  /** Getting + Replacing + Deleting lines (part 1 P8). */
  items: number;
  /** Deleting lines alone: a version from before the item existed removes it (part 2 Q10). */
  deleted: number;
  cancelled: boolean;
  /** Set when tf exited non-zero and was not cancelled: stderr plus the stdout lines that were not progress. */
  failure?: string;
}

/**
 * A `vc get` with no timeout, streamed progress and Cancel (part 1 W5), shared
 * by Manage Workspace's Get and the Source Control Explorer's two Gets. The
 * argv is the caller's; this only runs and reads it.
 *
 * Cancelled only counts when the run ALSO did not finish (`exitCode !== 0`):
 * a Get that finished right as Cancel was pressed is a plain success (part 1
 * M1).
 */
export async function streamedGet(
  client: Client,
  args: string[],
  onProgress: (items: number, line: string) => void,
  signal: AbortSignal,
): Promise<StreamedGetResult> {
  let items = 0;
  let deleted = 0;
  const detailLines: string[] = [];
  const split = lineSplitter((line) => {
    const kind = classifyGetLine(line);
    if (kind === 'getting' || kind === 'replacing' || kind === 'deleting') {
      items += 1;
      if (kind === 'deleting') deleted += 1;
      onProgress(items, line);
      return;
    }
    if (kind !== 'folder' && line.trim() !== '') detailLines.push(line);
  });
  const r = await client.run(args, { timeoutMs: 'none', onStdout: (chunk) => split.push(chunk), signal });
  split.end();
  if (r.cancelled && r.exitCode !== 0) return { items, deleted, cancelled: true };
  if (r.exitCode !== 0) {
    const stderrText = r.stderr.toString('utf8').trim();
    return { items, deleted, cancelled: false, failure: [stderrText, ...detailLines].filter((s) => s !== '').join('\n') };
  }
  return { items, deleted, cancelled: false };
}
