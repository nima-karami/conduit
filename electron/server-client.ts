import { connect as openSocket } from 'node:net';
import type { Duplex } from 'node:stream';
import {
  APP_HELLO_TIMEOUT_MS,
  SERVER_ERROR_RPC_CODE,
  SERVER_EVENT_METHOD,
  SERVER_LINE_MAX_BYTES,
  SERVER_PROTOCOL_GENERATION,
  type ServerErrorKind,
  type ServerEventEnvelope,
  type ServerMethod,
  type ServerMethods,
  type ServerNotification,
  type ServerNotifications,
  type ServerSnapshot,
} from '../src/contracts/server-protocol';
import { LineReader } from '../src/line-reader';

export type AppLog = (
  level: 'info' | 'warn' | 'error',
  msg: string,
  data?: Record<string, unknown>,
) => void;

export class ServerCallError extends Error {
  constructor(
    readonly kind: ServerErrorKind | 'disconnected' | 'timeout' | 'protocol',
    msg: string,
  ) {
    super(msg);
    this.name = 'ServerCallError';
  }
}

export interface ServerClientOptions {
  endpoint: string;
  appVersion: string;
  connect?: () => Duplex;
  log: AppLog;
}

type Hello = ServerMethods['hello']['result'];
interface Pending {
  resolve(value: unknown): void;
  reject(error: ServerCallError): void;
}
interface Subscriber {
  snapshot(s: ServerSnapshot): void;
  event(e: ServerEventEnvelope): void;
}

const SERVER_ERROR_KINDS: readonly ServerErrorKind[] = [
  'not_found',
  'conflict',
  'refused',
  'unavailable',
  'invalid',
  'server_stopping',
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function callError(error: unknown): ServerCallError {
  if (!isRecord(error)) return new ServerCallError('protocol', 'malformed error reply');
  const message = typeof error.message === 'string' ? error.message : 'server error';
  const kind = isRecord(error.data) ? error.data.kind : undefined;
  if (error.code === SERVER_ERROR_RPC_CODE) {
    const known = SERVER_ERROR_KINDS.find((k) => k === kind);
    if (known) return new ServerCallError(known, message);
  }
  return new ServerCallError('protocol', message);
}

const isHello = (value: unknown): value is Hello =>
  isRecord(value) &&
  typeof value.serverVersion === 'string' &&
  typeof value.generation === 'number' &&
  typeof value.instance === 'string' &&
  typeof value.pid === 'number';

const isEnvelope = (value: unknown): value is ServerEventEnvelope =>
  isRecord(value) && typeof value.seq === 'number' && typeof value.type === 'string';

/** One C2 connection; reconnecting is the lifecycle's job, which opens a new client. */
export class ServerClient {
  private socket: Duplex | undefined;
  private state: 'idle' | 'opening' | 'open' | 'closed' = 'idle';
  private nextId = 0;
  private readonly pending = new Map<number, Pending>();
  private readonly closeListeners = new Set<(why: 'eof' | 'error') => void>();
  private subscriber: Subscriber | undefined;
  /** null while (re)subscribing: no snapshot yet to order events against. */
  private snapshotSeq: number | null = null;
  private dispatch = Promise.resolve();

  constructor(private readonly o: ServerClientOptions) {}

  open(): Promise<Hello> {
    if (this.state !== 'idle')
      return Promise.reject(new ServerCallError('protocol', `open() while ${this.state}`));
    this.state = 'opening';
    return new Promise<Hello>((resolve, reject) => {
      let socket: Duplex;
      try {
        socket = this.o.connect ? this.o.connect() : openSocket(this.o.endpoint);
      } catch (error) {
        this.state = 'closed';
        reject(new ServerCallError('disconnected', String(error)));
        return;
      }
      this.socket = socket;
      const timer = setTimeout(() => {
        this.teardown();
        reject(new ServerCallError('timeout', `no hello within ${APP_HELLO_TIMEOUT_MS} ms`));
      }, APP_HELLO_TIMEOUT_MS);
      let failed: 'eof' | 'error' = 'eof';
      const reader = new LineReader(
        () => SERVER_LINE_MAX_BYTES,
        (line) => {
          // Reply continuations must install their snapshot before the next notification runs.
          if (line.trim())
            this.dispatch = this.dispatch.then(() => {
              if (this.state !== 'closed') this.receive(line);
            });
        },
        () => {
          this.o.log('error', 'server-client: inbound line over the frame cap; closing', {});
          socket.destroy();
        },
      );
      socket.on('data', (chunk: Buffer) => reader.write(chunk, () => this.state !== 'closed'));
      socket.on('error', () => {
        failed = 'error';
      });
      socket.on('close', () => {
        clearTimeout(timer);
        const wasOpen = this.state === 'open';
        this.teardown();
        if (!wasOpen) {
          reject(new ServerCallError('disconnected', 'connection closed before hello'));
          return;
        }
        for (const cb of [...this.closeListeners]) cb(failed);
      });
      this.request('hello', {
        appVersion: this.o.appVersion,
        generation: SERVER_PROTOCOL_GENERATION,
      }).then(
        (hello) => {
          clearTimeout(timer);
          if (!isHello(hello)) {
            this.teardown();
            reject(new ServerCallError('protocol', 'malformed hello reply'));
            return;
          }
          this.state = 'open';
          resolve(hello);
        },
        (error: ServerCallError) => {
          clearTimeout(timer);
          this.teardown();
          reject(error);
        },
      );
    });
  }

  call<M extends ServerMethod>(
    m: M,
    p: ServerMethods[M]['params'],
  ): Promise<ServerMethods[M]['result']> {
    if (this.state !== 'open')
      return Promise.reject(new ServerCallError('disconnected', `${m}: not connected`));
    return this.request(m, p) as Promise<ServerMethods[M]['result']>;
  }

  /** D29: never buffered, so a keystroke typed while down can't answer a later prompt. */
  notify<N extends ServerNotification>(n: N, p: ServerNotifications[N]): boolean {
    if (this.state !== 'open' || !this.socket) return false;
    this.socket.write(`${JSON.stringify({ jsonrpc: '2.0', method: n, params: p })}\n`);
    return true;
  }

  async subscribe(h: Subscriber): Promise<void> {
    this.subscriber = h;
    await this.resubscribe();
  }

  onClose(cb: (why: 'eof' | 'error') => void): () => void {
    this.closeListeners.add(cb);
    return () => this.closeListeners.delete(cb);
  }

  close(): void {
    this.closeListeners.clear();
    this.teardown();
  }

  private async resubscribe(): Promise<void> {
    const h = this.subscriber;
    if (!h) return;
    this.snapshotSeq = null;
    const snapshot = await this.call('events.subscribe', {});
    if (this.subscriber !== h || this.state !== 'open') return;
    this.snapshotSeq = snapshot.seq;
    this.guard('snapshot', () => h.snapshot(snapshot));
  }

  private request(method: ServerMethod, params: unknown): Promise<unknown> {
    const socket = this.socket;
    if (!socket) return Promise.reject(new ServerCallError('disconnected', `${method}: no socket`));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      socket.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  private receive(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.o.log('error', 'server-client: unparsable line; closing', { line: line.slice(0, 200) });
      this.socket?.destroy();
      return;
    }
    if (!isRecord(message) || message.jsonrpc !== '2.0') return;
    if (message.method === SERVER_EVENT_METHOD) {
      this.event(message.params);
      return;
    }
    if (typeof message.id !== 'number') return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if ('error' in message) pending.reject(callError(message.error));
    else pending.resolve(message.result);
  }

  /** Seq gaps are normal (per-peer emits); only `missed` means something was lost. */
  private event(params: unknown): void {
    const h = this.subscriber;
    if (!h || this.snapshotSeq === null) return;
    if (!isEnvelope(params)) return;
    const e = params;
    if (e.type === 'missed') {
      this.resubscribe().catch((error: unknown) =>
        this.o.log('warn', 'server-client: re-subscribe after missed failed', {
          err: String(error),
        }),
      );
      return;
    }
    if (e.seq <= this.snapshotSeq) return;
    this.guard(e.type, () => h.event(e));
  }

  private guard(what: string, fn: () => void): void {
    try {
      fn();
    } catch (error) {
      this.o.log('error', `server-client: ${what} handler threw`, { err: String(error) });
    }
  }

  private teardown(): void {
    if (this.state === 'closed') return;
    this.state = 'closed';
    this.subscriber = undefined;
    this.snapshotSeq = null;
    const socket = this.socket;
    this.socket = undefined;
    socket?.destroy();
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const p of pending) p.reject(new ServerCallError('disconnected', 'connection closed'));
  }
}
