import { FRAME_HEADER_BYTES, FRAME_MAX_PAYLOAD, type Frame, FrameKind } from '../contracts/frames';

function checkKind(kind: number): asserts kind is FrameKind {
  if (!Number.isInteger(kind) || kind < FrameKind.Data || kind > FrameKind.Facts)
    throw new Error(`Unknown frame kind: ${kind}`);
}

export function encodeFrame(frame: Frame): Buffer {
  checkKind(frame.kind);
  if (!Number.isInteger(frame.channel) || frame.channel < 0 || frame.channel > 0xffffffff)
    throw new RangeError(`Frame channel is not a u32: ${frame.channel}`);
  if (frame.payload.byteLength > FRAME_MAX_PAYLOAD) throw new Error('Frame payload exceeds limit');
  const bytes = Buffer.allocUnsafe(FRAME_HEADER_BYTES + frame.payload.byteLength);
  bytes.writeUInt32LE(frame.channel, 0);
  bytes[4] = frame.kind;
  bytes.writeUInt32LE(frame.payload.byteLength, 5);
  bytes.set(frame.payload, FRAME_HEADER_BYTES);
  return bytes;
}

export class FrameDecoder {
  private header = Buffer.alloc(FRAME_HEADER_BYTES);
  private headerBytes = 0;
  private frame: { channel: number; kind: FrameKind; payload: Buffer } | undefined;
  private payloadBytes = 0;

  push(bytes: Uint8Array): Frame[] {
    const frames: Frame[] = [];
    let offset = 0;
    while (offset < bytes.byteLength) {
      if (!this.frame) {
        const n = Math.min(FRAME_HEADER_BYTES - this.headerBytes, bytes.byteLength - offset);
        this.header.set(bytes.subarray(offset, offset + n), this.headerBytes);
        this.headerBytes += n;
        offset += n;
        if (this.headerBytes !== FRAME_HEADER_BYTES) break;
        const kind = this.header[4];
        checkKind(kind);
        const length = this.header.readUInt32LE(5);
        if (length > FRAME_MAX_PAYLOAD) throw new Error('Frame payload exceeds limit');
        this.frame = {
          channel: this.header.readUInt32LE(0),
          kind,
          payload: Buffer.allocUnsafe(length),
        };
        this.headerBytes = 0;
      }
      const frame = this.frame;
      const n = Math.min(frame.payload.byteLength - this.payloadBytes, bytes.byteLength - offset);
      frame.payload.set(bytes.subarray(offset, offset + n), this.payloadBytes);
      this.payloadBytes += n;
      offset += n;
      if (this.payloadBytes === frame.payload.byteLength) {
        frames.push(frame);
        this.payloadBytes = 0;
        this.frame = undefined;
      }
    }
    return frames;
  }
}
