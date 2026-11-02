import { FRAME_MAX_PAYLOAD } from '../contracts/frames';
import type { HcEvent, HcNotification, HcTerminal } from '../contracts/hc';
import type { AttachedStream } from './stream';

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

/**
 * hc 0.1.16 sends control replies one per DATA frame without a newline (measured in the spike), so
 * an unterminated event message is accepted once it parses. The buffer always starts at a message,
 * and no proper prefix of a JSON object parses, so undefined here only means "more bytes to come".
 */
function parseWhole(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export class EventSubscription {
  private seq = 0;
  private line: Buffer = Buffer.alloc(0);
  private stream: AttachedStream | undefined;
  private closed = false;
  private refreshing = false;

  constructor(
    private readonly notify: (n: HcNotification) => void,
    private readonly refresh: (sub: EventSubscription) => void,
    private readonly remove: () => void,
    private readonly fail: (error: unknown) => void,
  ) {}

  bind(seq: number, stream: AttachedStream, terminals?: HcTerminal[]): void {
    if (this.closed) {
      stream.close();
      return;
    }
    this.stream?.close();
    this.stream = stream;
    this.seq = seq;
    this.line = Buffer.alloc(0);
    this.refreshing = false;
    if (terminals) this.notify({ method: 'missed', params: { seq, terminals } });
    // C3: the subscribe promise hands the snapshot to its caller before the first event.
    setImmediate(() => {
      if (this.closed || this.stream !== stream) return;
      stream.onData((bytes) => {
        try {
          this.receive(bytes);
          stream.credit(bytes.byteLength);
        } catch (error) {
          this.fail(error);
        }
      });
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stream?.close();
    this.remove();
  }

  disconnected(): void {
    this.closed = true;
    this.line = Buffer.alloc(0);
    this.remove();
  }

  private receive(bytes: Uint8Array): void {
    if (this.closed || this.refreshing) return;
    this.line = Buffer.concat([this.line, bytes]);
    let offset = 0;
    while (!this.closed && !this.refreshing) {
      const newline = this.line.indexOf(10, offset);
      if (newline < 0) break;
      if (newline - offset > FRAME_MAX_PAYLOAD) throw new Error('Event payload exceeds limit');
      const text = this.line.subarray(offset, newline).toString('utf8');
      offset = newline + 1;
      if (text.trim()) this.notification(JSON.parse(text));
    }
    this.line = this.refreshing || this.closed ? Buffer.alloc(0) : this.line.subarray(offset);
    const rest = this.line.toString('utf8');
    if (rest.trim()) {
      const message = parseWhole(rest);
      if (message !== undefined) {
        this.line = Buffer.alloc(0);
        this.notification(message);
      }
    }
    if (this.line.byteLength > FRAME_MAX_PAYLOAD) throw new Error('Event payload exceeds limit');
  }

  private notification(value: unknown): void {
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
      this.notify({
        method: 'missed',
        params: { seq, terminals: params.terminals as HcTerminal[] },
      });
    } else if (method === 'heartbeat') {
      this.notify({ method: 'heartbeat', params: { seq } });
    } else if (method === 'event') {
      if (seq <= this.seq) return;
      if (seq !== this.seq + 1) {
        this.refreshing = true;
        this.stream?.close();
        this.refresh(this);
        return;
      }
      this.seq = seq;
      const type = 'type' in params ? params.type : undefined;
      const event: HcEvent =
        typeof type === 'string' && eventTypes.has(type)
          ? (params as HcEvent)
          : { seq, type: 'unknown', raw: params };
      this.notify({ method: 'event', params: event });
    }
  }
}
