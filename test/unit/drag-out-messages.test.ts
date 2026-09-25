import { describe, expect, it } from 'vitest';
import { MAX_OUTGOING_PATHS } from '../../src/outgoing-paths';
import type { OsClipboardFailure } from '../../src/protocol';
import { clipboardFailureMessage } from '../../webview/drag-out-messages';

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
