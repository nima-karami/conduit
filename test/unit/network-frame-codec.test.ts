import { describe, expect, it } from 'vitest';
import { LINK_FRAME_MAX_BYTES, type LinkFrame } from '../../src/contracts/link-protocol';
import { encodeFrame, FrameDecoder } from '../../src/network/frame-codec';
import type { PairingMsg } from '../../src/network/pairing-protocol';

const ping: LinkFrame = { t: 'ping' };
const accept: PairingMsg = { t: 'pair.accept' };

function prefix(length: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(length, 0);
  return b;
}

describe('encodeFrame', () => {
  it('prefixes the UTF-8 JSON with its big-endian byte length', () => {
    const out = encodeFrame(ping);
    const json = Buffer.from(JSON.stringify(ping), 'utf8');
    expect(out.readUInt32BE(0)).toBe(json.length);
    expect(out.subarray(4)).toEqual(json);
  });

  it('throws when the encoded JSON exceeds LINK_FRAME_MAX_BYTES', () => {
    const huge: PairingMsg = { t: 'pair.nonce', nonce: 'x'.repeat(LINK_FRAME_MAX_BYTES) };
    expect(() => encodeFrame(huge)).toThrow();
  });
});

describe('FrameDecoder', () => {
  it('round-trips one frame', () => {
    const d = new FrameDecoder(LINK_FRAME_MAX_BYTES);
    expect(d.push(encodeFrame(ping))).toEqual({ frames: [ping], error: null });
  });

  it('returns every frame in one chunk, in arrival order', () => {
    const d = new FrameDecoder(LINK_FRAME_MAX_BYTES);
    const chunk = Buffer.concat([encodeFrame(ping), encodeFrame(accept)]);
    expect(d.push(chunk)).toEqual({ frames: [ping, accept], error: null });
  });

  it('reassembles one frame split across three chunks, including inside the prefix', () => {
    const d = new FrameDecoder(LINK_FRAME_MAX_BYTES);
    const wire = encodeFrame(ping);
    expect(d.push(wire.subarray(0, 2))).toEqual({ frames: [], error: null });
    expect(d.push(wire.subarray(2, 9))).toEqual({ frames: [], error: null });
    expect(d.push(wire.subarray(9))).toEqual({ frames: [ping], error: null });
  });

  it('rejects a length prefix over the cap before any body is pushed', () => {
    const d = new FrameDecoder(LINK_FRAME_MAX_BYTES);
    expect(d.push(prefix(LINK_FRAME_MAX_BYTES + 1))).toEqual({ frames: [], error: 'too_large' });
  });

  it('accepts a body of exactly the cap', () => {
    const overhead = Buffer.byteLength(JSON.stringify({ t: 'pair.nonce', nonce: '' }), 'utf8');
    const json = Buffer.from(
      JSON.stringify({ t: 'pair.nonce', nonce: 'x'.repeat(LINK_FRAME_MAX_BYTES - overhead) }),
      'utf8',
    );
    expect(json.length).toBe(LINK_FRAME_MAX_BYTES);
    const d = new FrameDecoder(LINK_FRAME_MAX_BYTES);
    const out = d.push(Buffer.concat([prefix(json.length), json]));
    expect(out.error).toBeNull();
    expect(out.frames).toHaveLength(1);
  });

  it('reports bad_json for a complete body that is not JSON', () => {
    const d = new FrameDecoder(LINK_FRAME_MAX_BYTES);
    const body = Buffer.from('not json!', 'utf8');
    expect(d.push(Buffer.concat([prefix(body.length), body]))).toEqual({
      frames: [],
      error: 'bad_json',
    });
  });

  it('stays dead after an error: later pushes return the same error and no frames', () => {
    const d = new FrameDecoder(LINK_FRAME_MAX_BYTES);
    expect(d.push(prefix(LINK_FRAME_MAX_BYTES + 1))).toEqual({ frames: [], error: 'too_large' });
    expect(d.push(encodeFrame(ping))).toEqual({ frames: [], error: 'too_large' });
    expect(d.push(encodeFrame(accept))).toEqual({ frames: [], error: 'too_large' });
  });

  it('stays dead after bad_json too', () => {
    const d = new FrameDecoder(LINK_FRAME_MAX_BYTES);
    const body = Buffer.from('{', 'utf8');
    d.push(Buffer.concat([prefix(body.length), body]));
    expect(d.push(encodeFrame(ping))).toEqual({ frames: [], error: 'bad_json' });
  });
});
