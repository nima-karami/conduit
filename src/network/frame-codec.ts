import { LINK_FRAME_MAX_BYTES, type LinkFrame } from '../contracts/link-protocol';
import type { BridgePreamble } from '../contracts/ssh-link';
import type { PairingMsg } from './pairing-protocol';

// Length-prefixed JSON frames. The cap is checked on the prefix alone, so a peer cannot make us
// buffer up to a size it only claims. see plan Technical decisions 7
const PREFIX_BYTES = 4;

type FrameError = 'too_large' | 'bad_json';

export function encodeFrame(frame: LinkFrame | PairingMsg | BridgePreamble): Buffer {
  const json = Buffer.from(JSON.stringify(frame), 'utf8');
  if (json.length > LINK_FRAME_MAX_BYTES) {
    throw new Error(`frame is ${json.length} bytes, over the ${LINK_FRAME_MAX_BYTES} byte cap`);
  }
  const out = Buffer.alloc(PREFIX_BYTES + json.length);
  out.writeUInt32BE(json.length, 0);
  json.copy(out, PREFIX_BYTES);
  return out;
}

export type FirstFrame =
  | { kind: 'incomplete' }
  | { kind: 'frame'; frame: unknown; rest: Buffer }
  | { kind: 'error'; error: FrameError };

/**
 * The first frame of `buffered`, for a stream that must prove itself with one small frame before
 * anything else is parsed. FrameDecoder would decode every complete frame in the chunk and drop
 * the bytes behind them; `rest` returns those bytes to the caller, which owns the stream from here.
 */
export function readFirstFrame(buffered: Buffer, maxBytes: number): FirstFrame {
  if (buffered.length < PREFIX_BYTES) return { kind: 'incomplete' };
  const length = buffered.readUInt32BE(0);
  if (length > maxBytes) return { kind: 'error', error: 'too_large' };
  const end = PREFIX_BYTES + length;
  if (buffered.length < end) return { kind: 'incomplete' };
  let frame: unknown;
  try {
    frame = JSON.parse(buffered.subarray(PREFIX_BYTES, end).toString('utf8'));
  } catch {
    return { kind: 'error', error: 'bad_json' };
  }
  return { kind: 'frame', frame, rest: buffered.subarray(end) };
}

export class FrameDecoder {
  private readonly maxBytes: number;
  // Chunks are kept as a list and joined only for the frame being completed. Concatenating
  // on every push would copy the whole backlog again each time, which is quadratic on a
  // slow link that delivers many small chunks.
  private chunks: Buffer[] = [];
  private buffered = 0;
  private expected: number | null = null;
  private failed: FrameError | null = null;

  constructor(maxBytes: number) {
    this.maxBytes = maxBytes;
  }

  push(chunk: Buffer): { frames: unknown[]; error: FrameError | null } {
    const frames: unknown[] = [];
    if (this.failed) return { frames, error: this.failed };
    this.chunks.push(chunk);
    this.buffered += chunk.length;
    for (;;) {
      if (this.expected === null) {
        if (this.buffered < PREFIX_BYTES) break;
        const length = this.take(PREFIX_BYTES).readUInt32BE(0);
        if (length > this.maxBytes) return this.fail('too_large', frames);
        this.expected = length;
      }
      if (this.buffered < this.expected) break;
      const body = this.take(this.expected);
      this.expected = null;
      let frame: unknown;
      try {
        frame = JSON.parse(body.toString('utf8'));
      } catch {
        return this.fail('bad_json', frames);
      }
      frames.push(frame);
    }
    return { frames, error: null };
  }

  private fail(error: FrameError, frames: unknown[]): { frames: unknown[]; error: FrameError } {
    this.failed = error;
    this.chunks = [];
    this.buffered = 0;
    return { frames, error };
  }

  /** Removes and returns exactly `n` bytes from the front. The caller checks `buffered` first. */
  private take(n: number): Buffer {
    const parts: Buffer[] = [];
    let need = n;
    while (need > 0) {
      const head = this.chunks[0];
      if (head === undefined) break;
      if (head.length <= need) {
        parts.push(head);
        need -= head.length;
        this.chunks.shift();
      } else {
        parts.push(head.subarray(0, need));
        this.chunks[0] = head.subarray(need);
        need = 0;
      }
    }
    this.buffered -= n;
    return parts.length === 1 && parts[0] !== undefined ? parts[0] : Buffer.concat(parts, n);
  }
}
