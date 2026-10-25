import { describe, expect, it } from 'vitest';
import {
  isCountedInput,
  nextDraftState,
  settleDraft,
  stripTerminalReplies,
} from '../../src/conduit-mcp/draft-input';

const REPLIES: Array<[string, string]> = [
  ['DA1', '\x1b[?1;2c'],
  ['DA2', '\x1b[>0;276;0c'],
  ['CPR', '\x1b[12;40R'],
  ['focus in', '\x1b[I'],
  ['focus out', '\x1b[O'],
  ['SGR mouse', '\x1b[<0;10;5M'],
  ['SGR mouse release', '\x1b[<0;10;5m'],
  ['X10 mouse', '\x1b[M !!'],
  ['OSC reply', '\x1b]11;rgb:0000/0000/0000\x07'],
  ['OSC reply (ST)', '\x1b]10;rgb:ffff/ffff/ffff\x1b\\'],
  ['DCS reply', '\x1bP>|xterm\x1b\\'],
  ['DECRPM', '\x1b[?2004;1$y'],
];

describe('stripTerminalReplies', () => {
  it.each(REPLIES)('%s is stripped to empty', (_name, reply) => {
    expect(stripTerminalReplies(reply)).toBe('');
  });

  it('keeps cursor keys and text around replies', () => {
    expect(stripTerminalReplies('\x1b[A')).toBe('\x1b[A');
    expect(stripTerminalReplies('\x1bOA')).toBe('\x1bOA');
    expect(stripTerminalReplies('a\x1b[Ib\x1b[?1;2cc')).toBe('abc');
  });
});

describe('nextDraftState', () => {
  const rows: Array<[string, boolean, string, boolean]> = [
    ['typing starts a draft', false, 'fix the', true],
    ['Enter ends it', true, 'fix\r', false],
    ['Ctrl+C ends it', true, '\x03', false],
    ['text after Enter is a new draft', false, 'a\rb', true],
    ['Up-arrow recall counts', false, '\x1b[A', true],
    ['a focus report alone keeps a draft', true, '\x1b[I', true],
    ['a focus report alone keeps no draft', false, '\x1b[O', false],
    ['a reply after Enter keeps it cleared', false, '\r\x1b[12;40R', false],
  ];
  it.each(rows)('%s', (_label, prior, data, want) => {
    expect(nextDraftState(prior, data)).toBe(want);
  });
});

describe('isCountedInput', () => {
  it('a focus report is not counted; a key is', () => {
    expect(isCountedInput('\x1b[I')).toBe(false);
    expect(isCountedInput('\x1b[?1;2c\x1b[12;40R')).toBe(false);
    expect(isCountedInput('x')).toBe(true);
  });
});

describe('settleDraft', () => {
  const base = { hasDraft: true, now: 10_000, quietMs: 3_000 };
  it('empty-input after the quiet period clears the draft', () => {
    expect(settleDraft({ ...base, screen: 'empty-input', lastInputAt: 7_000 })).toBe(false);
  });
  it('empty-input inside the quiet period keeps it', () => {
    expect(settleDraft({ ...base, screen: 'empty-input', lastInputAt: 7_001 })).toBe(true);
  });
  it('an unknown screen keeps it however long ago', () => {
    expect(settleDraft({ ...base, screen: 'unknown', lastInputAt: 0 })).toBe(true);
  });
  it('no input ever and empty-input → no draft', () => {
    expect(settleDraft({ ...base, screen: 'empty-input', lastInputAt: undefined })).toBe(false);
  });
  it('no draft stays no draft', () => {
    expect(settleDraft({ ...base, hasDraft: false, screen: 'unknown', lastInputAt: 9_999 })).toBe(
      false,
    );
  });
});
