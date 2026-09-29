import { S } from '../tf/strings.js';

/**
 * Get Latest and Get Specific Version from the Source Control Explorer: the
 * only place this part builds a `vc get` argv, and the only place
 * `/overwrite` and `/all` may appear.
 * Server paths throughout, like Phase 1's Get Latest and History's Get This
 * Version.
 */
export type VersionKind = 'changeset' | 'date' | 'label' | 'latest' | 'workspace';
export const VERSION_KINDS: readonly VersionKind[] = ['changeset', 'date', 'label', 'latest', 'workspace'];

/** What the dialog posts. `value` is ignored for `latest` and `workspace`. */
export interface VersionRequest {
  kind: VersionKind;
  value: string;
  /** "Overwrite writable files that are not checked out" -> `/overwrite`. */
  overwriteWritable: boolean;
  /** "Overwrite all files even if the local version matches" -> `/all`. */
  getAll: boolean;
}

type Result<T> = ({ ok: true } & T) | { ok: false; message: string };

const INT32_MAX = 2147483647;
/**
 * tf's own label rules plus `! % ^`, which TfClient refuses in any argument
 * (part 1 M5), and control characters, so a pasted newline gets gsvBadLabel
 * rather than TfClient's generic refusal.
 */
const LABEL_BAD = /["/\\:<>|*?;@!%^\x00-\x1f]/;
const LABEL_MAX = 64;

export function versionSpec(kind: VersionKind, raw: string): Result<{ spec: string }> {
  const v = raw.trim();
  switch (kind) {
    case 'changeset': {
      if (!/^\d{1,10}$/.test(v)) return { ok: false, message: S.gsvBadChangeset };
      const n = Number(v);
      if (n < 1 || n > INT32_MAX) return { ok: false, message: S.gsvBadChangeset };
      return { ok: true, spec: `C${n}` };
    }
    case 'date': {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
      if (!m) return { ok: false, message: S.gsvBadDate };
      const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
      const date = new Date(Date.UTC(y, mo - 1, d));
      if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) {
        return { ok: false, message: S.gsvBadDate };
      }
      // Q9: this ISO spelling is accepted on DEVPC (Croatian) and under Wine
      // (English) alike, so it is sent whatever the machine's locale.
      return { ok: true, spec: `D${v}T00:00` };
    }
    case 'label':
      if (v === '' || v.startsWith('-') || v.length > LABEL_MAX || LABEL_BAD.test(v)) {
        return { ok: false, message: S.gsvBadLabel };
      }
      return { ok: true, spec: `L${v}` };
    case 'latest':
      return { ok: true, spec: 'T' };
    case 'workspace':
      return { ok: true, spec: 'W' };
  }
}

/** `vc get <server paths> /version:<spec> [/recursive] [/overwrite] [/all]`. Never `/force`. */
export function getVersionArgs(serverPaths: readonly string[], r: VersionRequest, recursive: boolean): Result<{ args: string[] }> {
  if (serverPaths.length === 0) return { ok: false, message: S.sceNeedsSelection };
  if (!serverPaths.every(isServerPathArg)) return { ok: false, message: S.sceUnknownPath };
  const spec = versionSpec(r.kind, r.value);
  if (!spec.ok) return spec;
  return {
    ok: true,
    args: [
      'vc',
      'get',
      ...serverPaths,
      `/version:${spec.spec}`,
      ...(recursive ? ['/recursive'] : []),
      ...(r.overwriteWritable ? ['/overwrite'] : []),
      ...(r.getAll ? ['/all'] : []),
    ],
  };
}

/**
 * Get Latest: Phase 1's own form -- the paths, and `/recursive` always.
 * Callers have already checked the selection, so a bad path here is a bug;
 * it throws rather than build `vc get /recursive`, which would get the whole
 * workspace.
 */
export function getLatestArgs(serverPaths: readonly string[]): string[] {
  if (serverPaths.length === 0 || !serverPaths.every(isServerPathArg)) {
    throw new Error(`getLatestArgs: not server paths: ${JSON.stringify(serverPaths)}`);
  }
  return ['vc', 'get', ...serverPaths, '/recursive'];
}

/** A `$/...` path: never empty, never a local path, never read as a switch. */
function isServerPathArg(p: string): boolean {
  return p.startsWith('$/');
}

/** X3: either overwrite box asks a second, modal question before anything runs. */
export function needsOverwriteConfirm(r: VersionRequest): boolean {
  return r.overwriteWritable || r.getAll;
}

/** Holds what the page posts to exactly this shape; undefined for anything else. */
export function parseVersionRequest(raw: unknown): VersionRequest | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  if (!VERSION_KINDS.includes(r.kind as VersionKind)) return undefined;
  if (typeof r.value !== 'string' || r.value.length > 200) return undefined;
  if (typeof r.overwriteWritable !== 'boolean' || typeof r.getAll !== 'boolean') return undefined;
  return { kind: r.kind as VersionKind, value: r.value, overwriteWritable: r.overwriteWritable, getAll: r.getAll };
}
