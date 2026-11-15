import { LINK_FRAME_MAX_BYTES, type LinkFrame } from '../contracts/link-protocol';
import type { PairingMsg } from './pairing-protocol';

// Length-prefixed JSON frames. The cap is checked on the prefix alone, so a peer cannot make us
// buffer up to a size it only claims. see plan Technical decisions 7
const PREFIX_BYTES = 4;

type FrameError = 'too_large' | 'bad_json';

export function encodeFrame(frame: LinkFrame | PairingMsg): Buffer {
  const json = Buffer.from(JSON.stringify(frame), 'utf8');
  if (json.length > LINK_FRAME_MAX_BYTES) {
    throw new Error(`frame is ${json.length} bytes, over the ${LINK_FRAME_MAX_BYTES} byte cap`);
  }
  const out = Buffer.alloc(PREFIX_BYTES + json.length);
  out.writeUInt32BE(json.length, 0);
  json.copy(out, PREFIX_BYTES);
  return out;
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
