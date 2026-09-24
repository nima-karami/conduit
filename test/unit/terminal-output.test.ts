import { describe, expect, it } from 'vitest';
import {
  isInertOutput,
  PASTE_MODE_OFF,
  splitIncompleteEscape,
  trackBracketedPaste,
} from '../../src/terminal-output';

const E = '\x1b';

describe('isInertOutput', () => {
  it.each([
    // Real claude 2.1.282 bytes right after a banner click (mf-live-edits QA F1).
    ['a mode re-assert', `${E}[?2004h`],
    ['an erase-and-move repaint', `${E}[?25l${E}[15;1H${E}[K\r\n${E}[K${E}[10;3H${E}[?25h`],
    ['a window title', `${E}]0;✳ Claude Code\x07`],
    ['whitespace only', '  \r\n\t'],
    ['nothing', ''],
    ['a truncated sequence', `${E}[?200`],
  ])('%s is inert', (_label, chunk) => {
    expect(isInertOutput(chunk)).toBe(true);
  });

  it.each([
    ['plain text', 'hello'],
    ['styled text', `${E}[1mx${E}[22m`],
    ['a bare bell (attention evidence)', '\x07'],
    ['text drawn after a cursor move', `${E}[?25l${E}[13;44HYou've used 90% of your weekly limit`],
  ])('%s is not inert', (_label, chunk) => {
    expect(isInertOutput(chunk)).toBe(false);
  });
});

describe('trackBracketedPaste', () => {
  const run = (...chunks: string[]) =>
    chunks.reduce((s, c) => trackBracketedPaste(s, c), PASTE_MODE_OFF).on;

  it('starts off', () => {
    expect(PASTE_MODE_OFF.on).toBe(false);
  });

  it('?2004h turns it on and ?2004l off (claude startup and teardown bytes)', () => {
    expect(run(`${E}[?2004h${E}[?2031h${E}[?1004h`)).toBe(true);
    expect(run(`${E}[?2004h`, `${E}[>4m${E}[?1004l${E}[?2031l${E}[?2004l`)).toBe(false);
  });

  it('the last one in a chunk wins', () => {
    expect(run(`${E}[?2004h x ${E}[?2004l`)).toBe(false);
    expect(run(`${E}[?2004l x ${E}[?2004h`)).toBe(true);
  });

  it('reads a combined parameter list', () => {
    expect(run(`${E}[?1004;2004h`)).toBe(true);
  });

  it('survives a sequence split across chunks', () => {
    expect(run(`abc${E}[?20`, '04h')).toBe(true);
    expect(run(`abc${E}`, '[?2004h')).toBe(true);
  });

  it('ignores other modes and non-private sequences', () => {
    expect(run(`${E}[?20040h`)).toBe(false);
    expect(run(`${E}[2004h`)).toBe(false);
    expect(run(`${E}[?1004h`)).toBe(false);
  });
});

describe('splitIncompleteEscape', () => {
  it.each([
    [`abc${E}[38;2`, 'abc', `${E}[38;2`],
    [`abc${E}`, 'abc', E],
    [`x${E}]0;title`, 'x', `${E}]0;title`],
    [`abc${E}[1m`, `abc${E}[1m`, ''],
    [`x${E}]0;t\x07`, `x${E}]0;t\x07`, ''],
    [`x${E}]0;t${E}\\`, `x${E}]0;t${E}\\`, ''],
    ['plain', 'plain', ''],
  ])('%j', (s, done, tail) => {
    expect(splitIncompleteEscape(s)).toEqual([done, tail]);
  });
});
