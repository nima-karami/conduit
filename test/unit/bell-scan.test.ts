import { describe, expect, it } from 'vitest';
import { countBareBells, stripAnsi } from '../../src/last-line';

// Contract 2 of docs/specs/2026-08-21-attention-signal-quality.md: a BEL only means
// "the app wants you" when it is NOT terminating an escape string. `includes('\x07')`
// is the named failure mode — every OSC title update ends in one.
describe('countBareBells', () => {
  it('counts a lone BEL', () => {
    expect(countBareBells('\x07')).toBe(1);
  });

  it('returns 0 for an empty chunk', () => {
    expect(countBareBells('')).toBe(0);
  });

  it('returns 0 for plain text', () => {
    expect(countBareBells('building project...\r\n')).toBe(0);
  });

  it('does NOT count the BEL terminating an OSC title', () => {
    expect(countBareBells('\x1b]0;title\x07')).toBe(0);
  });

  it('counts a BEL that follows a terminated OSC', () => {
    expect(countBareBells('\x1b]0;t\x07\x07')).toBe(1);
  });

  it('handles ST-terminated OSC plus surrounding bells', () => {
    expect(countBareBells('a\x07b\x1b]2;x\x1b\\\x07')).toBe(2);
  });

  it('counts a BEL after a CSI sequence', () => {
    expect(countBareBells('\x1b[1;2H\x07')).toBe(1);
  });

  it('ignores BELs inside a DCS payload (ST-terminated, BEL is data)', () => {
    // Sixel/DECRQSS payloads are arbitrary bytes; a 0x07 in one is not a bell.
    expect(countBareBells('\x1bPq\x07\x07data\x1b\\')).toBe(0);
    expect(countBareBells('\x1bPq\x07data\x1b\\\x07')).toBe(1);
  });

  it('ignores BELs inside APC / PM / SOS strings', () => {
    expect(countBareBells('\x1b_payload\x07\x1b\\')).toBe(0);
    expect(countBareBells('\x1b^payload\x07\x1b\\')).toBe(0);
    expect(countBareBells('\x1bXpayload\x07\x1b\\')).toBe(0);
  });

  it('treats an unterminated OSC as swallowing the rest of the chunk', () => {
    // Mirrors stripAnsi: a truncated trailing sequence consumes what follows rather
    // than being re-interpreted as text (a split chunk must not fabricate a bell).
    expect(countBareBells('\x1b]0;no-terminator\x07x')).toBe(0);
    expect(countBareBells('\x1b]0;no-terminator-at-all')).toBe(0);
  });

  it('agrees with stripAnsi that an OSC BEL is a terminator, not content', () => {
    expect(stripAnsi('\x1b]0;title\x07ok')).toBe('ok');
    expect(countBareBells('\x1b]0;title\x07ok')).toBe(0);
  });

  it('counts every bell in a realistic mixed chunk', () => {
    const chunk = `\x1b]0;C:\\repo\x07\x1b[32mdone\x1b[0m\x07\r\nprompt> \x07`;
    expect(countBareBells(chunk)).toBe(2);
  });
});
