import { describe, expect, it } from 'vitest';
import { countBareBells, stripAnsi } from '../../src/last-line';

// Contract 2 of docs/specs/2026-08-21-attention-signal-quality.md: a BEL only means
// "the app wants you" when it is NOT terminating an escape string. `includes('\x07')`
// is the named failure mode — every OSC title update ends in one.
const bells = (chunk: string) => countBareBells(chunk).bells;

describe('countBareBells', () => {
  it('counts a lone BEL', () => {
    expect(bells('\x07')).toBe(1);
  });

  it('returns 0 for an empty chunk', () => {
    expect(bells('')).toBe(0);
  });

  it('returns 0 for plain text', () => {
    expect(bells('building project...\r\n')).toBe(0);
  });

  it('does NOT count the BEL terminating an OSC title', () => {
    expect(bells('\x1b]0;title\x07')).toBe(0);
  });

  it('counts a BEL that follows a terminated OSC', () => {
    expect(bells('\x1b]0;t\x07\x07')).toBe(1);
  });

  it('handles ST-terminated OSC plus surrounding bells', () => {
    expect(bells('a\x07b\x1b]2;x\x1b\\\x07')).toBe(2);
  });

  it('counts a BEL after a CSI sequence', () => {
    expect(bells('\x1b[1;2H\x07')).toBe(1);
  });

  it('ignores BELs inside a DCS payload (ST-terminated, BEL is data)', () => {
    // Sixel/DECRQSS payloads are arbitrary bytes; a 0x07 in one is not a bell.
    expect(bells('\x1bPq\x07\x07data\x1b\\')).toBe(0);
    expect(bells('\x1bPq\x07data\x1b\\\x07')).toBe(1);
  });

  it('ignores BELs inside APC / PM / SOS strings', () => {
    expect(bells('\x1b_payload\x07\x1b\\')).toBe(0);
    expect(bells('\x1b^payload\x07\x1b\\')).toBe(0);
    expect(bells('\x1bXpayload\x07\x1b\\')).toBe(0);
  });

  it('agrees with stripAnsi that an OSC BEL is a terminator, not content', () => {
    expect(stripAnsi('\x1b]0;title\x07ok')).toBe('ok');
    expect(bells('\x1b]0;title\x07ok')).toBe(0);
  });

  it('counts every bell in a realistic mixed chunk', () => {
    const chunk = `\x1b]0;C:\\repo\x07\x1b[32mdone\x1b[0m\x07\r\nprompt> \x07`;
    expect(bells(chunk)).toBe(2);
  });
});

// PTY chunks are whatever `proc.onData` hands over: an escape sequence can straddle two
// of them. Scanning each chunk from scratch invents a bell out of the tail of a split
// title, and swallows a real one that lands after a title the previous chunk left open —
// both of which reach the user as an unexplained "needs you" ping or a missing one.
describe('countBareBells — state carried across chunks', () => {
  it('reports where the scan ended so the caller can resume', () => {
    expect(countBareBells('plain')).toEqual({ bells: 0, state: 'text' });
    expect(countBareBells('\x1b]0;tit').state).toBe('osc');
    expect(countBareBells('\x1b]0;done\x07').state).toBe('text');
  });

  it('does not invent a bell from a title split across two chunks', () => {
    const first = countBareBells('\x1b]0;tit');
    expect(first.bells).toBe(0);
    const second = countBareBells('le\x07', first.state);
    expect(second).toEqual({ bells: 0, state: 'text' });
  });

  it('does not swallow a real bell that follows a carried-over OSC terminator', () => {
    const first = countBareBells('\x1b]0;tit');
    expect(countBareBells('le\x07\x07', first.state).bells).toBe(1);
  });

  it('counts a bell in a later chunk once the title closed in an earlier one', () => {
    const first = countBareBells('\x1b]0;title\x07');
    expect(countBareBells('\x07', first.state).bells).toBe(1);
  });

  it('carries a DCS payload across chunks without ringing', () => {
    const first = countBareBells('\x1bPq0;1;0');
    expect(first.state).toBe('str');
    expect(countBareBells('\x07more\x1b\\', first.state)).toEqual({ bells: 0, state: 'text' });
  });

  it('carries a split ST terminator (ESC ends one chunk, backslash starts the next)', () => {
    const first = countBareBells('\x1b]2;x\x1b');
    expect(countBareBells('\\\x07', first.state).bells).toBe(1);
  });

  it('carries a bare ESC that ends a chunk into the next one', () => {
    const first = countBareBells('text\x1b');
    expect(first.state).toBe('esc');
    expect(countBareBells(']0;t\x07', first.state).bells).toBe(0);
  });

  it('treats an OSC left open at the end of a chunk as still open', () => {
    expect(countBareBells('\x1b]0;no-terminator-at-all')).toEqual({ bells: 0, state: 'osc' });
  });

  it('a BEL after a terminated OSC in the SAME chunk is a real bell', () => {
    // Guards the reading error this test used to encode: this OSC *is* terminated.
    expect(countBareBells('\x1b]0;title\x07x\x07')).toEqual({ bells: 1, state: 'text' });
  });
});
