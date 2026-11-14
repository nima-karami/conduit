import { describe, expect, it } from 'vitest';
import {
  deliverableText,
  MAX_MESSAGE_CHARS,
  MESSAGE_TOO_LONG,
  normalizeMessage,
} from '../../src/message-text';

describe('normalizeMessage', () => {
  it('keeps line breaks and folds CRLF and CR to LF', () => {
    expect(normalizeMessage('a\r\nb\rc\nd')).toEqual({ ok: true, message: 'a\nb\nc\nd' });
  });

  it('strips escape, other C0, DEL and C1, and turns a tab into a space', () => {
    expect(normalizeMessage('\u001b[31mred\u0000\u007f\u0090 x\ty')).toEqual({
      ok: true,
      message: '[31mred x y',
    });
  });

  it('trims surrounding whitespace but keeps inner blank lines', () => {
    expect(normalizeMessage('\n  one\n\ntwo  \n')).toEqual({ ok: true, message: 'one\n\ntwo' });
  });

  it('rejects an empty message', () => {
    expect(normalizeMessage(' \r\n\t ')).toEqual({ ok: false, error: 'Message is empty' });
  });

  it('accepts exactly the cap and rejects one over it, never truncating', () => {
    expect(normalizeMessage('x'.repeat(MAX_MESSAGE_CHARS))).toEqual({
      ok: true,
      message: 'x'.repeat(MAX_MESSAGE_CHARS),
    });
    expect(normalizeMessage('x'.repeat(MAX_MESSAGE_CHARS + 1))).toEqual({
      ok: false,
      error: MESSAGE_TOO_LONG,
    });
  });

  it('keeps a 2,614-char three-paragraph message whole (spec §2 measured row)', () => {
    const para = 'word '.repeat(174).trim();
    const raw = `${para}\n\n${para}\n\n${para}`;
    const out = normalizeMessage(raw);
    expect(out).toEqual({ ok: true, message: raw });
  });
});

describe('deliverableText', () => {
  it('sends the message unchanged with bracketed paste', () => {
    expect(deliverableText('a\n\nb', true)).toEqual({ text: 'a\n\nb', joined: false });
  });

  it('joins lines with a space without bracketed paste', () => {
    expect(deliverableText('first line\n\n second', false)).toEqual({
      text: 'first line second',
      joined: true,
    });
  });

  it('reports no join for a one-line message', () => {
    expect(deliverableText('Continue', false)).toEqual({ text: 'Continue', joined: false });
  });
});
