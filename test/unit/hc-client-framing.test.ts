import { describe, expect, it } from 'vitest';
import { FRAME_MAX_PAYLOAD, FrameKind } from '../../src/contracts/frames';
import { encodeFrame, FrameDecoder } from '../../src/hc-client/framing';

describe('hc framing', () => {
  it('encodes the documented little-endian header and round trips every kind', () => {
    const frame = { channel: 0x12345678, kind: FrameKind.Data, payload: Buffer.from('ab') };
    expect([...encodeFrame(frame)]).toEqual([120, 86, 52, 18, 0, 2, 0, 0, 0, 97, 98]);
    for (const kind of Object.values(FrameKind)) {
      const frames = new FrameDecoder().push(encodeFrame({ ...frame, kind }));
      expect(frames).toEqual([{ ...frame, kind }]);
    }
  });

  it('reassembles partial headers and bodies and multiple coalesced frames', () => {
    const decoder = new FrameDecoder();
    const bytes = Buffer.from([1, 0, 0, 0, 0, 3, 0, 0, 0, 65, 66, 67, 2, 0, 0, 0, 2, 0, 0, 0, 0]);
    expect(decoder.push(bytes.subarray(0, 4))).toEqual([]);
    expect(decoder.push(bytes.subarray(4, 10))).toEqual([]);
    expect(decoder.push(bytes.subarray(10))).toEqual([
      { channel: 1, kind: FrameKind.Data, payload: Buffer.from('ABC') },
      { channel: 2, kind: FrameKind.Close, payload: Buffer.alloc(0) },
    ]);
  });

  it('rejects an oversized length from the header before buffering its body', () => {
    const header = Buffer.alloc(9);
    header.writeUInt32LE(FRAME_MAX_PAYLOAD + 1, 5);
    expect(() => new FrameDecoder().push(header)).toThrow(/payload/i);
    expect(() =>
      encodeFrame({
        channel: 1,
        kind: FrameKind.Data,
        payload: Buffer.alloc(FRAME_MAX_PAYLOAD + 1),
      }),
    ).toThrow(/payload/i);
  });

  it('rejects an unknown frame kind', () => {
    expect(() => new FrameDecoder().push(Buffer.from([1, 0, 0, 0, 99, 0, 0, 0, 0]))).toThrow(
      /kind/i,
    );
  });

  it('refuses a channel that is not a u32', () => {
    for (const channel of [-1, 1.5, 2 ** 32])
      expect(() =>
        encodeFrame({ channel, kind: FrameKind.Data, payload: Buffer.alloc(0) }),
      ).toThrow(/u32/);
  });
});
