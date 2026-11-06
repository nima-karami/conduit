import { describe, expect, it } from 'vitest';
import { readCappedBytes } from '../../src/read-capped';

describe('readCappedBytes', () => {
  it('loops until EOF across short reads', async () => {
    const src = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const chunks = [3, 2, 4, 0];
    let i = 0;
    const out = await readCappedBytes(async (buf, offset, length, position) => {
      const n = Math.min(chunks[i++] ?? 0, length, src.length - position);
      buf.set(src.subarray(position, position + n), offset);
      return { bytesRead: n };
    }, 20);
    expect([...out]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('stops at max even when more is available', async () => {
    const src = new Uint8Array(20).fill(1);
    const out = await readCappedBytes(async (buf, offset, length, position) => {
      const n = Math.min(3, length, src.length - position);
      buf.set(src.subarray(position, position + n), offset);
      return { bytesRead: n };
    }, 7);
    expect(out).toHaveLength(7);
  });
});
