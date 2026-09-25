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

/** 'unsupported' has no sentence: that result is silent (AC9). */
export function clipboardFailureMessage(
  count: number,
  reason: Exclude<OsClipboardFailure, 'unsupported'>,
  name: string,
): string {
  const why = reason === 'failed' ? "PowerShell didn't respond." : dragRefusalMessage(reason, name);
  return `Couldn't put ${countNoun(count, 'item', 'items')} on the system clipboard. ${why}`;
}
