import { FRAME_HEADER_BYTES, FRAME_MAX_PAYLOAD, type Frame, FrameKind } from '../contracts/frames';

function checkKind(kind: number): asserts kind is FrameKind {
  if (!Number.isInteger(kind) || kind < FrameKind.Data || kind > FrameKind.Facts) {
    throw new Error(`Unknown frame kind: ${kind}`);
  }
}

export function encodeFrame(frame: Frame): Buffer {
  checkKind(frame.kind);
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
  private payload: Buffer | undefined;
  private payloadBytes = 0;

  push(bytes: Uint8Array): Frame[] {
    const frames: Frame[] = [];
    let offset = 0;
    while (offset < bytes.byteLength) {
      if (this.headerBytes < FRAME_HEADER_BYTES) {
        const n = Math.min(FRAME_HEADER_BYTES - this.headerBytes, bytes.byteLength - offset);
        this.header.set(bytes.subarray(offset, offset + n), this.headerBytes);
        this.headerBytes += n;
        offset += n;
        if (this.headerBytes !== FRAME_HEADER_BYTES) break;
        checkKind(this.header[4]);
        const length = this.header.readUInt32LE(5);
        if (length > FRAME_MAX_PAYLOAD) throw new Error('Frame payload exceeds limit');
        this.payload = Buffer.allocUnsafe(length);
      }
      const payload = this.payload;
      if (!payload) throw new Error('Missing frame payload');
      const n = Math.min(payload.byteLength - this.payloadBytes, bytes.byteLength - offset);
      payload.set(bytes.subarray(offset, offset + n), this.payloadBytes);
      this.payloadBytes += n;
      offset += n;
      if (this.payloadBytes === payload.byteLength) {
        const kind = this.header[4];
        checkKind(kind);
        frames.push({ channel: this.header.readUInt32LE(0), kind, payload });
        this.headerBytes = 0;
        this.payloadBytes = 0;
        this.payload = undefined;
      }
    }
    return frames;
  }
}
