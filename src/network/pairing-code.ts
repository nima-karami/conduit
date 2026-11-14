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
  words: readonly string[],
): [string, string, string] {
  const perWord = bitsPerWord(words.length);
  const byteCount = Math.ceil((WORDS_PER_CODE * perWord) / 8);
  const bytes = rand(byteCount);
  if (bytes.length !== byteCount) {
    throw new Error(`rand returned ${bytes.length} bytes, expected ${byteCount}`);
  }

  const picked: string[] = [];
  let bit = 0;
  for (let w = 0; w < WORDS_PER_CODE; w++) {
    let index = 0;
    for (let k = 0; k < perWord; k++) {
      const byte = bytes[bit >> 3] as number;
      index = (index << 1) | ((byte >> (7 - (bit & 7))) & 1);
      bit++;
    }
    picked.push(words[index] as string);
  }
  return [picked[0] as string, picked[1] as string, picked[2] as string];
}

/**
 * Accepts what people actually type: any case, any run of spaces, tabs, newlines or hyphens
 * between words. Returns the canonical form, or null if it cannot be a code from this list.
 */
export function normalizeCode(input: string, words: readonly string[]): string | null {
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
