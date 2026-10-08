import { describe, expect, it } from 'vitest';
import { AUTO_SAVE_COPY } from '../../webview/auto-save-copy';
import { readOnlyState } from '../../webview/read-only-doc';

const doc = { truncated: false, binary: false };

describe('readOnlyState', () => {
  it('is null for a whole, valid text file', () => {
    expect(readOnlyState(doc)).toBeNull();
  });

  it('names the window of a truncated file: head, or a log tail', () => {
    expect(readOnlyState({ ...doc, truncated: true })).toEqual({
      banner: 'Large file — showing the first 2 MB, read-only.',
      refusal: AUTO_SAVE_COPY.partialFile,
      partial: true,
    });
    expect(readOnlyState({ ...doc, truncated: true, window: 'tail' })).toEqual({
      banner: 'Large log — showing the last 2 MB, read-only.',
      refusal: AUTO_SAVE_COPY.tailFile,
      partial: true,
    });
  });

  it('names why a whole file is still read-only', () => {
    expect(readOnlyState({ ...doc, readOnlyReason: 'invalid-utf8' })).toEqual({
      banner: "Not valid UTF-8 — read-only so saving can't change its bytes.",
      refusal: AUTO_SAVE_COPY.invalidUtf8Refusal,
      partial: false,
    });
    expect(readOnlyState({ ...doc, readOnlyReason: 'mixed-eol' })).toEqual({
      banner:
        'Line endings the editor would rewrite — read-only so this golden file stays byte-exact.',
      refusal: AUTO_SAVE_COPY.mixedEolRefusal,
      partial: false,
    });
  });

  it('gives every reason its own refusal, none of them the 2 MB cut but the windows', () => {
    const refusals = [
      readOnlyState({ ...doc, readOnlyReason: 'invalid-utf8' })?.refusal,
      readOnlyState({ ...doc, readOnlyReason: 'mixed-eol' })?.refusal,
    ];
    for (const r of refusals) expect(r).not.toMatch(/2 MB/);
  });

  it('has nothing to say for a binary doc, which never reaches the editor', () => {
    expect(
      readOnlyState({ truncated: false, binary: true, readOnlyReason: 'invalid-utf8' }),
    ).toBeNull();
  });

  it('words the tail toast with the line it could not map', () => {
    expect(AUTO_SAVE_COPY.tailLine(5)).toBe(
      'This log is shown from its last 2 MB — line 5 may be outside it.',
    );
  });
});
