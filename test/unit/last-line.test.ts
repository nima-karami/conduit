import { describe, expect, it } from 'vitest';
import { LAST_LINE_MAX, lastNonEmptyLine, stripAnsi } from '../../src/last-line';

const ESC = '\u001b';

describe('stripAnsi', () => {
  it('drops SGR colour runs and keeps the text', () => {
    expect(stripAnsi(`${ESC}[31mfailed${ESC}[0m`)).toBe('failed');
  });

  it('drops cursor / erase CSI sequences a TUI repaints with', () => {
    expect(stripAnsi(`${ESC}[2J${ESC}[H${ESC}[1;32Hready`)).toBe('ready');
  });

  it('drops an OSC title terminated by BEL or by ST', () => {
    expect(stripAnsi(`${ESC}]0;conduit — claude\u0007done`)).toBe('done');
    expect(stripAnsi(`${ESC}]7;file:///c/src${ESC}\\done`)).toBe('done');
  });

  it('drops charset-designation and other short escapes', () => {
    expect(stripAnsi(`${ESC}(Bplain`)).toBe('plain');
    expect(stripAnsi(`${ESC}=plain`)).toBe('plain');
  });

  it('swallows a sequence truncated by the head of the tail window', () => {
    // The buffer is a trailing window, so a half-sequence at either end is normal.
    expect(stripAnsi(`${ESC}[38;5;`)).toBe('');
  });

  it('leaves text with no escapes untouched', () => {
    expect(stripAnsi('PS C:\\src\\conduit>')).toBe('PS C:\\src\\conduit>');
  });
});

describe('lastNonEmptyLine', () => {
  it('returns the last line with content, skipping trailing blanks', () => {
    expect(lastNonEmptyLine('one\r\ntwo\r\n\r\n   \r\n')).toBe('two');
  });

  it('is empty when there is nothing to say', () => {
    expect(lastNonEmptyLine('')).toBe('');
    expect(lastNonEmptyLine('\r\n \r\n')).toBe('');
    expect(lastNonEmptyLine(`${ESC}[2J${ESC}[H`)).toBe('');
  });

  it('treats a bare CR as a new line — a redrawn status line is not the old frame', () => {
    expect(lastNonEmptyLine('downloading 40%\rdownloading 90%')).toBe('downloading 90%');
  });

  it('strips ANSI before choosing the line, so a coloured prompt still counts', () => {
    expect(lastNonEmptyLine(`out\r\n${ESC}[32m›${ESC}[0m Apply edit to router.ts? (y/n)`)).toBe(
      '› Apply edit to router.ts? (y/n)',
    );
  });

  it('drops leftover control characters and turns tabs into spaces', () => {
    expect(lastNonEmptyLine('a\tb\u0007c')).toBe('a bc');
  });

  it('caps at LAST_LINE_MAX with an ellipsis rather than wrapping the card twice', () => {
    const out = lastNonEmptyLine('x'.repeat(500));
    expect(out).toHaveLength(LAST_LINE_MAX);
    expect(out.endsWith('…')).toBe(true);
  });

  it('leaves a line exactly at the cap alone', () => {
    const exact = 'y'.repeat(LAST_LINE_MAX);
    expect(lastNonEmptyLine(exact)).toBe(exact);
  });
});
