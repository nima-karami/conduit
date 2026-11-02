import { FRAME_MAX_PAYLOAD } from '../contracts/frames';
import type { HcEvent, HcNotification, HcStreamEnd, HcTerminal } from '../contracts/hc';
import type { AttachedStream, HcLog } from './stream';

const eventTypes = new Set<string>([
  'created',
  'restarted',
  'lost',
  'finished',
  'removed',
  'status',
  'title',
  'size',
  'keep',
  'turn',
  'foreground',
  'labels',
]);

const OPEN_BRACE = 0x7b;
const CLOSE_BRACE = 0x7d;
const OPEN_BRACKET = 0x5b;
const CLOSE_BRACKET = 0x5d;
const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const isJsonSpace = (b: number) => b === 0x20 || b === 0x0a || b === 0x0d || b === 0x09;

/**
 * One event channel. Messages are split by scanning JSON structure rather than by newline: hc 0.1.16
 * frames one message per DATA frame without a newline (measured in the spike), yet credit can split a
 * message across frames, so each byte is scanned once and each message parsed once.
 *
 * Sequence numbers are not checked for contiguity: the schema only promises "events after this
 * sequence follow", and under a filter they may be global. hc's own `missed` reports a lag.
 */
export class EventSubscription {
  private seq: number;
  private ended = false;
  private pending: Uint8Array[] = [];
  private pendingBytes = 0;
  private depth = 0;
  private inString = false;
  private escaped = false;

  constructor(
    seq: number,
    private readonly stream: AttachedStream,
    private readonly notify: (n: HcNotification) => void,
    private readonly log: HcLog,
  ) {
    this.seq = seq;
    // C3: the subscribe promise hands the snapshot to its caller before the first event or end.
    setImmediate(() => {
      if (this.ended) return;
      stream.onData((bytes) => this.data(bytes));
      stream.onClose((end) => this.channelEnded(end));
    });
  }

  close(): void {
    if (this.ended) return;
    this.ended = true;
    this.stream.close();
  }

  private data(bytes: Uint8Array): void {
    if (this.ended) return;
    try {
      this.scan(bytes);
    } catch (error) {
      this.log(`hc event channel ${this.stream.channel}: unreadable notification`, error);
      this.stream.close();
      this.end('malformed');
      return;
    }
    if (!this.ended) this.stream.credit(bytes.byteLength);
  }

  /** C3's "subscribe again" signal; a lost connection is reported by onConnection instead. */
  private channelEnded(end: HcStreamEnd): void {
    if (this.ended) return;
    if (end.reason === 'disconnected') this.ended = true;
    else this.end('closed');
  }

  private end(reason: 'closed' | 'malformed'): void {
    this.ended = true;
    this.deliver({ method: 'ended', params: { reason } });
  }

  private scan(bytes: Uint8Array): void {
    let start = 0;
    for (let i = 0; i < bytes.byteLength; i++) {
      const b = bytes[i];
      if (this.depth === 0) {
        if (isJsonSpace(b)) continue;
        if (b !== OPEN_BRACE) throw new Error('Event channel carried a non-object message');
        start = i;
        this.depth = 1;
      } else if (this.inString) {
        if (this.escaped) this.escaped = false;
        else if (b === BACKSLASH) this.escaped = true;
        else if (b === QUOTE) this.inString = false;
      } else if (b === QUOTE) this.inString = true;
      else if (b === OPEN_BRACE || b === OPEN_BRACKET) this.depth++;
      else if ((b === CLOSE_BRACE || b === CLOSE_BRACKET) && --this.depth === 0) {
        this.pending.push(bytes.subarray(start, i + 1));
        const text = Buffer.concat(this.pending).toString('utf8');
        this.pending = [];
        this.pendingBytes = 0;
        this.message(JSON.parse(text));
        if (this.ended) return;
      }
    }
    if (this.depth > 0) {
      const rest = bytes.subarray(start);
      this.pending.push(rest);
      this.pendingBytes += rest.byteLength;
      if (this.pendingBytes > FRAME_MAX_PAYLOAD) throw new Error('Event payload exceeds limit');
    }
  }

  private message(value: unknown): void {
    if (!value || typeof value !== 'object' || !('method' in value) || !('params' in value))
      throw new Error('Invalid event notification');
    const { method, params } = value;
    if (method !== 'event' && method !== 'missed' && method !== 'heartbeat') return;
    if (
      !params ||
      typeof params !== 'object' ||
      !('seq' in params) ||
      typeof params.seq !== 'number'
    )
      throw new Error('Invalid event sequence');
    const seq = params.seq;
    if (method === 'missed') {
      if (!('terminals' in params) || !Array.isArray(params.terminals))
        throw new Error('Invalid missed snapshot');
      this.seq = seq;
      this.deliver({
        method: 'missed',
        params: { seq, terminals: params.terminals as HcTerminal[] },
      });
    } else if (method === 'heartbeat') {
      this.deliver({ method: 'heartbeat', params: { seq } });
    } else {
      // Schema: events at or below the snapshot's seq are already in it.
      if (seq <= this.seq) return;
      this.seq = seq;
      const type = 'type' in params ? params.type : undefined;
      const event: HcEvent =
        typeof type === 'string' && eventTypes.has(type)
          ? (params as HcEvent)
          : { seq, type: 'unknown', raw: params };
      this.deliver({ method: 'event', params: event });
    }
  }

  private deliver(notification: HcNotification): void {
    try {
      this.notify(notification);
    } catch (error) {
      this.log(`hc event channel ${this.stream.channel}: notification handler threw`, error);
    }
  }
}
