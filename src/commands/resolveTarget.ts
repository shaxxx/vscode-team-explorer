/**
 * Normalises the arguments VS Code hands a command handler.
 *
 * The same command can be invoked several ways, each passing something
 * different — and the multi-select shapes are the dangerous ones:
 *
 *   scm/resourceState/context  (state)          or (state, state[])
 *   explorer/context           (uri)            or (uri, uri[])
 *   editor/context             (uri)
 *   command palette            nothing
 *
 * An earlier version handled only the two single shapes and returned undefined
 * for an array. The caller then fell back to the active editor — so
 * multi-selecting files and running Undo discarded edits on a file the user had
 * not selected, silently. Hence `unwrapTargets`, which returns every target,
 * and callers that act on all of them.
 *
 * Deliberately `vscode`-free so it can be unit-tested: it works structurally,
 * on the shape of the value, not on any VS Code type.
 */
export interface UriLike {
  fsPath: string;
}

interface ResourceStateLike {
  resourceUri: UriLike;
}

function isUriLike(value: unknown): value is UriLike {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as UriLike).fsPath === 'string'
  );
}

function isResourceState(value: unknown): value is ResourceStateLike {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  if (!('resourceUri' in value)) return false;
  return isUriLike((value as ResourceStateLike).resourceUri);
}

/** One value → its Uri, or undefined if it carries none. */
export function unwrapTarget(arg: unknown): UriLike | undefined {
  try {
    if (isResourceState(arg)) return arg.resourceUri;
    if (isUriLike(arg)) return arg;
  } catch {
    // A hostile or exotic object whose getters throw must not take the command
    // down: commands are globally invocable, so any extension can pass anything.
  }
  return undefined;
}

/**
 * Every target across all arguments, de-duplicated, order preserved.
 *
 * Flattens one level, because the multi-select shape is (first, all[]) — which
 * would otherwise yield the first item twice.
 */
export function unwrapTargets(args: readonly unknown[]): UriLike[] {
  const out: UriLike[] = [];
  const seen = new Set<string>();

  const take = (value: unknown): void => {
    const uri = unwrapTarget(value);
    if (!uri) return;
    if (seen.has(uri.fsPath)) return;
    seen.add(uri.fsPath);
    out.push(uri);
  };

  for (const arg of args) {
    if (Array.isArray(arg)) {
      for (const item of arg) take(item);
    } else {
      take(arg);
    }
  }

  return out;
}
