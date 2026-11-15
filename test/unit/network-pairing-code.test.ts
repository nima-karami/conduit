import { describe, expect, it, vi } from 'vitest';
import { newCode, normalizeCode } from '../../src/network/pairing-code';
import { PAIRING_WORDS } from '../../src/network/pairing-words';

const FIXTURE = ['apple', 'zoo', 'ability', 'river'];
const BIG = Array.from({ length: 2048 }, (_, i) => `w${i}`);

const fixed =
  (...bytes: number[]) =>
  (n: number) => {
    expect(n).toBe(bytes.length);
    return Uint8Array.from(bytes);
  };

describe('normalizeCode', () => {
  it('trims, lowercases and joins with single spaces', () => {
    expect(normalizeCode('  Apple-ZOO  ability ', FIXTURE)).toBe('apple zoo ability');
  });

  it('treats any whitespace run as a separator', () => {
    expect(normalizeCode('apple\tzoo\nriver', FIXTURE)).toBe('apple zoo river');
  });

  it('rejects two words', () => {
    expect(normalizeCode('apple zoo', FIXTURE)).toBeNull();
  });

  it('rejects four words', () => {
    expect(normalizeCode('apple zoo ability river', FIXTURE)).toBeNull();
  });

  it('rejects an unknown word', () => {
    expect(normalizeCode('apple zoo nope', FIXTURE)).toBeNull();
  });

  it('rejects empty input', () => {
    expect(normalizeCode('', FIXTURE)).toBeNull();
    expect(normalizeCode('   ---  ', FIXTURE)).toBeNull();
  });
});

describe('newCode', () => {
  it('draws 2-bit chunks from a 4-word list (one byte, MSB first)', () => {
    // 0x1B = 00 01 10 11: indices 0, 1, 2 (the fourth chunk is padding and is discarded)
    expect(newCode(fixed(0x1b), FIXTURE)).toEqual(['apple', 'zoo', 'ability']);
  });

  it('draws 11-bit chunks from a 2048-word list (five bytes, MSB first)', () => {
    // 0x80 0x00 ... : first 11 bits are 1000 0000 000 = 1024, then two zero chunks
    expect(newCode(fixed(0x80, 0x00, 0x00, 0x00, 0x00), BIG)).toEqual(['w1024', 'w0', 'w0']);
  });

  it('maps all-ones bits to the last word', () => {
    expect(newCode(fixed(0xff, 0xff, 0xff, 0xff, 0xff), BIG)).toEqual(['w2047', 'w2047', 'w2047']);
    expect(newCode(fixed(0xff), FIXTURE)).toEqual(['river', 'river', 'river']);
  });

  it('returns only words from the list', () => {
    const rand = (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 37 + 11) & 0xff);
    for (const w of newCode(rand, BIG)) expect(BIG).toContain(w);
  });

  it('throws for a list whose size is not a power of two', () => {
    expect(() => newCode(fixed(0x00), ['a', 'b', 'c'])).toThrow(
      'word list size must be a power of two',
    );
  });

  it('requests exactly ceil(3*log2(n)/8) bytes', () => {
    const big = vi.fn(fixed(0, 0, 0, 0, 0));
    newCode(big, BIG);
    expect(big).toHaveBeenCalledTimes(1);
    expect(big).toHaveBeenCalledWith(5);

    const small = vi.fn(fixed(0));
    newCode(small, FIXTURE);
    expect(small).toHaveBeenCalledTimes(1);
    expect(small).toHaveBeenCalledWith(1);
  });
});

describe('the shipped word list', () => {
  it('is 2048 distinct lowercase words, so codes carry 33 bits', () => {
    expect(PAIRING_WORDS).toHaveLength(2048);
    expect(new Set(PAIRING_WORDS).size).toBe(2048);
    expect(PAIRING_WORDS.every((w) => /^[a-z]+$/.test(w))).toBe(true);
  });
  it('is the default list for both functions', () => {
    const code = newCode(() => new Uint8Array(5));
    expect(code).toEqual(['abandon', 'abandon', 'abandon']);
    expect(normalizeCode('Abandon ZOO ability')).toBe('abandon zoo ability');
  });
});
