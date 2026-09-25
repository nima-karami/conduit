import { countNoun } from '../src/menu-selection';
import type { OsClipboardFailure } from '../src/protocol';

function clipboardReason(reason: Exclude<OsClipboardFailure, 'unsupported'>, name: string): string {
  switch (reason) {
    case 'outside-folders':
      return `${name} is outside this session's folders.`;
    case 'folder-missing':
      return `The folder holding ${name} can't be found.`;
    case 'missing':
      return `${name} no longer exists.`;
    case 'symlink-escape':
      return `${name} links outside this session's folders.`;
    case 'too-many':
      return "That's more than 500 items.";
    case 'bad-request':
    case 'unknown-session':
      return "Conduit couldn't send the request.";
    case 'failed':
      return "The system clipboard didn't accept them.";
  }
}

/** Spec §10 (amended): Copy-specific, platform-neutral. 'unsupported' has no sentence: that
 *  result is silent (AC9). */
export function clipboardFailureMessage(
  count: number,
  reason: Exclude<OsClipboardFailure, 'unsupported'>,
  name: string,
): string {
  return `Couldn't put ${countNoun(count, 'item', 'items')} on the system clipboard. ${clipboardReason(reason, name)}`;
}
