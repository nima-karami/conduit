import { describe, expect, it } from 'vitest';
import { AUTO_SAVE_COPY } from '../../webview/auto-save-copy';
import { readOnlyNotice } from '../../webview/read-only-doc';

const doc = { truncated: false, binary: false };

describe('readOnlyNotice', () => {
  it('is null for a whole, valid text file', () => {
    expect(readOnlyNotice(doc)).toBeNull();
  });

  it('names the window of a truncated file: head, or a log tail', () => {
    expect(readOnlyNotice({ ...doc, truncated: true })).toBe(
      'Large file — showing the first 2 MB, read-only.',
    );
    expect(readOnlyNotice({ ...doc, truncated: true, window: 'tail' })).toBe(
      'Large log — showing the last 2 MB, read-only.',
    );
  });

  it('names why a whole file is still read-only', () => {
    expect(readOnlyNotice({ ...doc, readOnlyReason: 'invalid-utf8' })).toBe(
      "Not valid UTF-8 — read-only so saving can't change its bytes.",
    );
    expect(readOnlyNotice({ ...doc, readOnlyReason: 'mixed-eol' })).toBe(
      'Mixed line endings — read-only so this golden file stays byte-exact.',
    );
  });

  it('has nothing to say for a binary doc, which never reaches the editor', () => {
    expect(readOnlyNotice({ truncated: false, binary: true, readOnlyReason: 'invalid-utf8' })).toBe(
      null,
    );
  });

  it('words the tail toast with the line it could not map', () => {
    expect(AUTO_SAVE_COPY.tailLine(5)).toBe(
      'This log is shown from its last 2 MB — line 5 may be outside it.',
    );
  });
});
