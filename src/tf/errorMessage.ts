import { S } from './strings.js';
import type { TfError } from './TfClient.js';

/**
 * The single wording for a classified tf failure.
 *
 * This lived as a private helper in the command layer, so the ACTIVATION path
 * did not use it - it showed tf's raw text alone. A rejected token therefore
 * appeared as:
 *
 *     TF30063: You are not authorized to access acme.visualstudio.com\acme.
 *
 * which reads as a server-side permissions problem. The user's next move is to
 * go looking at Azure DevOps group membership, not at their token, and the
 * same failure said something completely different depending on whether it
 * came from activation or from a command.
 *
 * Classification only ADDS to tf's own message; it never replaces it. An
 * unrecognised failure shows the raw text verbatim, because a wrong guess
 * dressed up as an explanation is worse than no explanation.
 *
 * `env` is a parameter, defaulting to `process.env`, so tests can pass a
 * Flatpak environment without touching the real process; callers use the default.
 */
export function messageFor(error: TfError | undefined, env: NodeJS.ProcessEnv = process.env): string {
  if (!error) return '';
  switch (error.kind) {
    case 'patMissing':  return `${S.patMissing}\n\n${error.originalMessage}`;
    case 'patRejected': return `${S.patExpired}\n\n${error.originalMessage}`;
    case 'tfNotFound':  return `${S.tfNotFound}\n\n${error.originalMessage}`;
    case 'wineMissing': return `${S.wineMissing}\n\n${error.originalMessage}`;
    case 'wrapperMissing': return `${S.wrapperMissing}\n\n${error.originalMessage}`;
    case 'commandNotFound':
      return `${env.FLATPAK_ID ? S.flatpakNoHost : S.commandNotFound}\n\n${error.originalMessage}`;
    default:            return error.originalMessage;
  }
}
