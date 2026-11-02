import { connect as openSocket } from 'node:net';
import type { Duplex } from 'node:stream';
import { CONTROL_CHANNEL, FRAME_MAX_PAYLOAD, type Frame, FrameKind } from '../contracts/frames';
import {
  HC_PROTOCOL_GENERATION,
  type HcClient,
  type HcErrorKind,
  type HcMethod,
  type HcMethods,
  type HcNotification,
  type HcStream,
  type HcTerminal,
} from '../contracts/hc';
import { resolveHcEndpoint } from './endpoint';
import { encodeFrame, FrameDecoder } from './framing';
import { AttachedStream, type HcLog } from './stream';
import { EventSubscription } from './subscription';

export { resolveHcEndpoint } from './endpoint';
export type { HcLog } from './stream';

export interface HcClientOptions {
  endpoint?: string;
  session?: string;
  env?: NodeJS.ProcessEnv;
  connect?: () => Duplex;
  /** First retry delay; consecutive failures double it up to RECONNECT_MAX_DELAY_MS. */
  reconnectDelayMs?: number;
  /** Where consumer callback exceptions go; they never reach the transport. */
  log?: HcLog;
}

const RECONNECT_MAX_DELAY_MS = 30_000;

export const HC_ERROR_KINDS = [
  'not_found',
  'blocked',
  'unavailable',
  'conflict',
  'status_mismatch',
  'finished',
  'spawn_failed',
  'name_taken',
  'live',
  'needs_framed',
] as const satisfies readonly HcErrorKind[];
const isKnownKind = (kind: string | undefined): kind is HcErrorKind =>
  HC_ERROR_KINDS.some((known) => known === kind);

export class HcRpcError extends Error {
  readonly kind: HcErrorKind | undefined;
  readonly rawKind: string | undefined;
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'HcRpcError';
    this.rawKind = isRecord(data) && typeof data.kind === 'string' ? data.kind : undefined;
    this.kind = isKnownKind(this.rawKind) ? this.rawKind : undefined;
  }
}

export class HcDisconnectedError extends Error {
  readonly reason = 'disconnected';
  constructor(message = 'hc connection disconnected', options?: ErrorOptions) {
    super(message, options);
    this.name = 'HcDisconnectedError';
  }
}

export class HcProtocolError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'HcProtocolError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const asError = (error: unknown): Error =>
  error instanceof Error ? error : new HcProtocolError(String(error));

type Hello = HcMethods['hello']['result'];
type ConnectionListener = (state: 'connected' | 'lost' | 'reconnected', hello?: Hello) => void;
interface Pending {
  message: { jsonrpc: '2.0'; id: number; method: HcMethod; params: unknown };
  sent: boolean;
  resolve(value: unknown): void;
  reject(error: Error): void;
}

export class NodeHcClient implements HcClient {
  private socket: Duplex | undefined;
  private decoder = new FrameDecoder();
  private line: Buffer = Buffer.alloc(0);
  private hello: Hello | undefined;
  private helloId = 0;
  private nextId = 0;
  private everConnected = false;
  private closed = false;
  private failures = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Set<ConnectionListener>();
  private readonly streams = new Map<number, AttachedStream>();
  private readonly open: () => Duplex;
  private readonly log: HcLog;

  constructor(private readonly options: HcClientOptions = {}) {
    this.open =
      options.connect ?? (() => openSocket(options.endpoint ?? resolveHcEndpoint(options)));
    this.log = options.log ?? ((message, error) => console.error(message, error));
    queueMicrotask(() => this.connect());
  }

  call<M extends HcMethod>(
    method: M,
    params: HcMethods[M]['params'],
  ): Promise<HcMethods[M]['result']> {
    return this.request(method, params, (value) => value);
  }

  attach(
    params: HcMethods['terminal.attach']['params'],
  ): Promise<{ result: HcMethods['terminal.attach']['result']; stream: HcStream }> {
    return this.request('terminal.attach', params, (result) => {
      const stream = this.stream(result.channel, params.observe === true);
      return { result, stream };
    });
  }

  subscribe(
    params: HcMethods['events.subscribe']['params'],
    onNotification: (n: HcNotification) => void,
  ): Promise<{ snapshot: HcTerminal[]; close(): void }> {
    return this.request('events.subscribe', params, (result) => {
      if (typeof result.channel !== 'number')
        throw new HcProtocolError('Missing framed event channel');
      const sub = new EventSubscription(
        result.seq,
        this.stream(result.channel, true),
        onNotification,
        this.log,
      );
      return { snapshot: result.terminals, close: () => sub.close() };
    });
  }

  onConnection(listener: ConnectionListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    const socket = this.socket;
    if (socket) this.lost(socket, new HcDisconnectedError('hc client closed'));
    else this.rejectPending(new HcDisconnectedError('hc client closed'));
    this.listeners.clear();
  }

  private stream(channel: number, observe: boolean): AttachedStream {
    if (
      !Number.isInteger(channel) ||
      channel <= CONTROL_CHANNEL ||
      channel > 0xffffffff ||
      this.streams.has(channel)
    )
      throw new HcProtocolError('Invalid or duplicate stream channel');
    const socket = this.socket;
    const stream = new AttachedStream(
      channel,
      observe,
      (frame) => {
        if (this.socket !== socket) throw new HcDisconnectedError();
        this.send(frame);
      },
      this.log,
      () => {
        if (this.streams.get(channel) === stream) this.streams.delete(channel);
      },
    );
    this.streams.set(channel, stream);
    return stream;
  }

  private request<M extends HcMethod, T>(
    method: M,
    params: HcMethods[M]['params'],
    accept: (value: HcMethods[M]['result']) => T,
  ): Promise<T> {
    if (this.closed) return Promise.reject(new HcDisconnectedError('hc client closed'));
    return new Promise<T>((resolve, reject) => {
      const id = ++this.nextId;
      const pending: Pending = {
        message: { jsonrpc: '2.0', id, method, params },
        sent: false,
        resolve: (value) => resolve(accept(value as HcMethods[M]['result'])),
        reject,
      };
      this.pending.set(id, pending);
      if (this.hello) this.sendRequest(pending);
    });
  }

  private connect(): void {
    if (this.closed) return;
    this.decoder = new FrameDecoder();
    this.line = Buffer.alloc(0);
    let socket: Duplex;
    try {
      socket = this.open();
    } catch (error) {
      this.rejectPending(new HcDisconnectedError('hc connection failed', { cause: error }));
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.on('data', (bytes: Buffer) => {
      if (this.socket !== socket) return;
      try {
        this.receive(bytes);
      } catch (error) {
        this.lost(socket, asError(error));
      }
    });
    socket.on('error', (error) =>
      this.lost(socket, new HcDisconnectedError(undefined, { cause: error })),
    );
    socket.on('close', () => this.lost(socket, new HcDisconnectedError()));
    this.helloId = ++this.nextId;
    socket.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: this.helloId, method: 'hello', params: { framed: true, generation: HC_PROTOCOL_GENERATION } })}\n`,
    );
  }

  private receive(bytes: Buffer): void {
    if (!this.hello) {
      this.line = Buffer.concat([this.line, bytes]);
      const newline = this.line.indexOf(10);
      if (newline < 0) {
        if (this.line.byteLength > FRAME_MAX_PAYLOAD)
          throw new HcProtocolError('Hello payload exceeds limit');
        return;
      }
      if (newline > FRAME_MAX_PAYLOAD) throw new HcProtocolError('Hello payload exceeds limit');
      const reply: unknown = JSON.parse(this.line.subarray(0, newline).toString('utf8'));
      if (!isRecord(reply) || reply.jsonrpc !== '2.0' || reply.id !== this.helloId)
        throw new HcProtocolError('Invalid hello response');
      if (isRecord(reply.error))
        throw new HcProtocolError('hc refused hello', { cause: this.rpcError(reply.error) });
      if (
        !isRecord(reply.result) ||
        reply.result.framed !== true ||
        reply.result.generation !== HC_PROTOCOL_GENERATION
      )
        throw new HcProtocolError(
          `hc core does not speak framed protocol generation ${HC_PROTOCOL_GENERATION}`,
        );
      const rest = this.line.subarray(newline + 1);
      this.line = Buffer.alloc(0);
      this.hello = reply.result as Hello;
      this.failures = 0;
      const state = this.everConnected ? 'reconnected' : 'connected';
      this.everConnected = true;
      this.emit(state, this.hello);
      for (const pending of this.pending.values()) if (!pending.sent) this.sendRequest(pending);
      bytes = rest;
    }
    for (const frame of this.decoder.push(bytes)) this.receiveFrame(frame);
  }

  private receiveFrame(frame: Frame): void {
    if (frame.channel !== CONTROL_CHANNEL) {
      this.streams.get(frame.channel)?.receive(frame);
      return;
    }
    if (frame.kind !== FrameKind.Data) return;
    const reply: unknown = JSON.parse(Buffer.from(frame.payload).toString('utf8'));
    if (!isRecord(reply) || reply.jsonrpc !== '2.0')
      throw new HcProtocolError('Invalid JSON-RPC response');
    if (typeof reply.id !== 'number') return;
    const pending = this.pending.get(reply.id);
    if (!pending) return;
    this.pending.delete(reply.id);
    if (isRecord(reply.error)) pending.reject(this.rpcError(reply.error));
    else if ('result' in reply) {
      try {
        pending.resolve(reply.result);
      } catch (error) {
        pending.reject(asError(error));
      }
    } else pending.reject(new HcProtocolError('Response has neither result nor error'));
  }

  private rpcError(error: Record<string, unknown>): HcRpcError {
    return new HcRpcError(
      typeof error.code === 'number' ? error.code : -32603,
      typeof error.message === 'string' ? error.message : 'hc RPC failed',
      error.data,
    );
  }

  private emit(state: 'connected' | 'lost' | 'reconnected', hello?: Hello): void {
    for (const listener of this.listeners) {
      try {
        listener(state, hello);
      } catch (error) {
        this.log(`hc client: ${state} listener threw`, error);
      }
    }
  }

  private sendRequest(pending: Pending): void {
    const payload = Buffer.from(JSON.stringify(pending.message));
    try {
      this.send({ channel: CONTROL_CHANNEL, kind: FrameKind.Data, payload });
      pending.sent = true;
    } catch (error) {
      this.pending.delete(pending.message.id);
      pending.reject(asError(error));
    }
  }

  private send(frame: Frame): void {
    if (!this.socket || !this.hello) throw new HcDisconnectedError();
    this.socket.write(encodeFrame(frame));
  }

  private rejectPending(error: Error): void {
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const call of pending) call.reject(error);
  }

  private lost(socket: Duplex, error: Error): void {
    if (this.socket !== socket) return;
    // A failed reconnect attempt never had a connection to lose; only a completed hello did.
    const wasConnected = this.hello !== undefined;
    this.socket = undefined;
    this.hello = undefined;
    socket.destroy();
    this.rejectPending(error);
    for (const stream of [...this.streams.values()]) stream.disconnected();
    this.streams.clear();
    if (wasConnected) this.emit('lost');
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    const base = this.options.reconnectDelayMs ?? 250;
    const delay = Math.min(base * 2 ** this.failures, RECONNECT_MAX_DELAY_MS);
    this.failures++;
    this.timer = setTimeout(() => this.connect(), delay);
    this.timer.unref();
  }
}
