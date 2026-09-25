import { describe, expect, it } from 'vitest';
import { MAX_OUTGOING_PATHS } from '../../src/outgoing-paths';
import type { DragOutRefusal } from '../../src/protocol';
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

describe('clipboardFailureMessage', () => {
  it('failed → PowerShell did not respond', () => {
    expect(clipboardFailureMessage(1, 'failed', 'a')).toBe(
      "Couldn't put 1 item on the system clipboard. PowerShell didn't respond.",
    );
  });

  it('a refusal reuses the reason sentence, pluralised count', () => {
    expect(clipboardFailureMessage(3, 'missing', 'b.txt')).toBe(
      "Couldn't put 3 items on the system clipboard. Can't drag b.txt: it no longer exists.",
    );
  });
});
