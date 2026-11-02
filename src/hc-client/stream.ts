import {
  type CloseReason,
  type DisplayFacts,
  type Frame,
  FrameKind,
  INITIAL_STREAM_CREDIT,
} from '../contracts/frames';
import type { HcStream, HcStreamEnd } from '../contracts/hc';

export class AttachedStream implements HcStream {
  private dataHandler: ((bytes: Uint8Array) => void) | undefined;
  private closeHandler: ((end: HcStreamEnd) => void) | undefined;
  private readonly queue: Uint8Array[] = [];
  private end: HcStreamEnd | undefined;
  private closeDelivered = false;
  private detaching = false;
  private flushing = false;
  private allowance = INITIAL_STREAM_CREDIT;
  private handedOff = 0;

  constructor(
    readonly channel: number,
    private readonly observe: boolean,
    private readonly send: (frame: Frame) => void,
  ) {}

  onData(handler: (bytes: Uint8Array) => void): void {
    this.dataHandler = handler;
    this.flush();
  }

  onClose(handler: (end: HcStreamEnd) => void): void {
    this.closeHandler = handler;
    this.flush();
  }

  receive(frame: Frame): void {
    if (this.end) return;
    if (frame.kind === FrameKind.Data) {
      if (frame.payload.byteLength > this.allowance)
        throw new Error('Stream exceeds granted credit');
      this.allowance -= frame.payload.byteLength;
      this.queue.push(frame.payload);
    } else if (frame.kind === FrameKind.Close) {
      const end: CloseReason = frame.payload.byteLength
        ? JSON.parse(Buffer.from(frame.payload).toString('utf8'))
        : { reason: 'detached' };
      if (!end || typeof end.reason !== 'string') throw new Error('Invalid stream CLOSE reason');
      this.end = end;
    }
    this.flush();
  }

  disconnected(): void {
    this.end ??= { reason: 'disconnected' };
    this.flush();
  }

  write(bytes: Uint8Array): void {
    this.active();
    this.send({ channel: this.channel, kind: FrameKind.Data, payload: bytes });
  }

  resize(cols: number, rows: number): void {
    this.active();
    if (![cols, rows].every((n) => Number.isInteger(n) && n > 0 && n <= 65535))
      throw new RangeError('Invalid terminal size');
    const payload = Buffer.alloc(4);
    payload.writeUInt16LE(cols, 0);
    payload.writeUInt16LE(rows, 2);
    this.send({ channel: this.channel, kind: FrameKind.Resize, payload });
  }

  facts(facts: DisplayFacts): void {
    this.active();
    this.send({
      channel: this.channel,
      kind: FrameKind.Facts,
      payload: Buffer.from(JSON.stringify(facts)),
    });
  }

  credit(n: number): void {
    if (!Number.isInteger(n) || n < 0 || n > this.handedOff)
      throw new RangeError('Invalid stream credit');
    if (n === 0) return;
    this.handedOff -= n;
    if (this.end || this.detaching) return;
    this.allowance += n;
    const payload = Buffer.alloc(4);
    payload.writeUInt32LE(n);
    this.send({ channel: this.channel, kind: FrameKind.Credit, payload });
  }

  close(): void {
    if (this.detaching || this.end) return;
    this.detaching = true;
    this.send({ channel: this.channel, kind: FrameKind.Close, payload: Buffer.alloc(0) });
  }

  private active(): void {
    if (this.end || this.detaching) throw new Error('hc stream is closed');
    if (this.observe) throw new Error('An observer stream cannot control the terminal');
  }

  private flush(): void {
    if (this.flushing) return;
    this.flushing = true;
    try {
      while (this.queue.length && this.dataHandler) {
        const bytes = this.queue.shift();
        if (!bytes) break;
        this.handedOff += bytes.byteLength;
        this.dataHandler(bytes);
      }
      if (!this.queue.length && this.end && this.closeHandler && !this.closeDelivered) {
        this.closeDelivered = true;
        this.closeHandler(this.end);
      }
    } finally {
      this.flushing = false;
    }
  }
}
