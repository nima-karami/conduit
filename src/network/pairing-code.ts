import { PAIRING_WORDS } from './pairing-words';

// Three words, not a numeric code: the joiner types it from a screen to another machine, and
// words survive being read aloud or retyped. See the pairing plan, T2.2.

const MIN_SIZE = 2;
const MAX_SIZE = 65536;
const WORDS_PER_CODE = 3;

/**
 * Power of two keeps every draw unbiased without rejection sampling: each chunk of log2(n) bits
 * maps onto the list exactly once.
 */
function bitsPerWord(size: number): number {
  const isPowerOfTwo = size >= MIN_SIZE && size <= MAX_SIZE && (size & (size - 1)) === 0;
  if (!isPowerOfTwo) throw new Error('word list size must be a power of two');
  return Math.log2(size);
}

/**
 * Bits are read MSB-first from the byte stream and the trailing padding bits are discarded, so a
 * fixed `rand` maps to the same triple on every platform.
 */
export function newCode(
  rand: (n: number) => Uint8Array,
  words: readonly string[] = PAIRING_WORDS,
): [string, string, string] {
  const perWord = bitsPerWord(words.length);
  const byteCount = Math.ceil((WORDS_PER_CODE * perWord) / 8);
  const bytes = rand(byteCount);
  if (bytes.length !== byteCount) {
    throw new Error(`rand returned ${bytes.length} bytes, expected ${byteCount}`);
  }

  let bit = 0;
  const pick = (): string => {
    let index = 0;
    for (let k = 0; k < perWord; k++) {
      const byte = bytes[bit >> 3];
      if (byte === undefined) throw new Error('ran out of random bits');
      index = (index << 1) | ((byte >> (7 - (bit & 7))) & 1);
      bit++;
    }
    const word = words[index];
    if (word === undefined) throw new Error('word index out of range');
    return word;
  };
  return [pick(), pick(), pick()];
}

/**
 * Accepts what people actually type: any case, any run of spaces, tabs, newlines or hyphens
 * between words. Returns the canonical form, or null if it cannot be a code from this list.
 */
export function normalizeCode(
  input: string,
  words: readonly string[] = PAIRING_WORDS,
): string | null {
  const parts = input
    .trim()
    .toLowerCase()
    .split(/[\s-]+/)
    .filter((p) => p !== '');
  if (parts.length !== WORDS_PER_CODE) return null;
  for (const part of parts) {
    if (!words.includes(part)) return null;
  }
  return parts.join(' ');
}
