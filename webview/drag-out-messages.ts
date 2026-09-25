import { countNoun } from '../src/menu-selection';
import type { DragOutRefusal, OsClipboardFailure } from '../src/protocol';

// Exact sentences: os-drag-out spec §10. The raw enum is never shown.
export function dragRefusalMessage(reason: DragOutRefusal, name: string): string {
  switch (reason) {
    case 'outside-folders':
      return `Can't drag ${name}: it's outside this session's folders.`;
    case 'folder-missing':
      return `Can't drag ${name}: its folder can't be found.`;
    case 'missing':
      return `Can't drag ${name}: it no longer exists.`;
    case 'symlink-escape':
      return `Can't drag ${name}: it links outside this session's folders.`;
    case 'too-many':
      return 'Too many items to drag (max 500).';
    case 'bad-request':
    case 'unknown-session':
      return "Couldn't start the drag.";
  }
}

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
