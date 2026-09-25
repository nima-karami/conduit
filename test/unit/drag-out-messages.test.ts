import { describe, expect, it } from 'vitest';
import { MAX_OUTGOING_PATHS } from '../../src/outgoing-paths';
import type { DragOutRefusal, OsClipboardFailure } from '../../src/protocol';
import { clipboardFailureMessage, dragRefusalMessage } from '../../webview/drag-out-messages';

describe('dragRefusalMessage (spec §10)', () => {
  const cases: [DragOutRefusal, string][] = [
    ['outside-folders', "Can't drag a.txt: it's outside this session's folders."],
    ['folder-missing', "Can't drag a.txt: its folder can't be found."],
    ['missing', "Can't drag a.txt: it no longer exists."],
    ['symlink-escape', "Can't drag a.txt: it links outside this session's folders."],
    ['too-many', 'Too many items to drag (max 500).'],
    ['bad-request', "Couldn't start the drag."],
    ['unknown-session', "Couldn't start the drag."],
  ];
  it.each(cases)('%s', (reason, sentence) => {
    expect(dragRefusalMessage(reason, 'a.txt')).toBe(sentence);
  });

  it('the stated maximum is the host limit', () => {
    expect(dragRefusalMessage('too-many', 'x')).toContain(`(max ${MAX_OUTGOING_PATHS})`);
  });
});

describe('clipboardFailureMessage (spec §10, amended)', () => {
  const cases: [Exclude<OsClipboardFailure, 'unsupported'>, string][] = [
    ['outside-folders', "b.txt is outside this session's folders."],
    ['folder-missing', "The folder holding b.txt can't be found."],
    ['missing', 'b.txt no longer exists.'],
    ['symlink-escape', "b.txt links outside this session's folders."],
    ['too-many', "That's more than 500 items."],
    ['bad-request', "Conduit couldn't send the request."],
    ['unknown-session', "Conduit couldn't send the request."],
    ['failed', "The system clipboard didn't accept them."],
  ];
  it.each(cases)('%s', (reason, sentence) => {
    expect(clipboardFailureMessage(3, reason, 'b.txt')).toBe(
      `Couldn't put 3 items on the system clipboard. ${sentence}`,
    );
  });

  it('never says drag or PowerShell', () => {
    for (const [reason] of cases) {
      expect(clipboardFailureMessage(1, reason, 'a')).not.toMatch(/drag|PowerShell/i);
    }
  });

  it('singular count', () => {
    expect(clipboardFailureMessage(1, 'failed', 'a')).toMatch(/^Couldn't put 1 item on/);
  });

  it('the stated maximum is the host limit', () => {
    expect(clipboardFailureMessage(2, 'too-many', 'x')).toContain(`${MAX_OUTGOING_PATHS} items`);
  });
});
