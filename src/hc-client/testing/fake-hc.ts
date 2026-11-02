import { createServer, connect as openSocket, type Server, type Socket } from 'node:net';
import {
  type CloseReason,
  CONTROL_CHANNEL,
  type Frame,
  FrameKind,
  INITIAL_STREAM_CREDIT,
} from '../../contracts/frames';
import {
  HC_PINNED_VERSION,
  HC_USED_METHODS,
  type HcMethods,
  type HcNotification,
  type HcTerminal,
} from '../../contracts/hc';
import { encodeFrame, FrameDecoder } from '../framing';

type RpcCall = { id: number; method: string; params: Record<string, unknown> };
type CallHandler = (params: Record<string, unknown>) => unknown | Promise<unknown>;

export class FakeRpcError extends Error {
  constructor(
    readonly kind: string,
    message = kind,
  ) {
    super(message);
    this.name = 'FakeRpcError';
  }
}

type Connection = {
  socket: Socket;
  decoder: FrameDecoder;
  lineBuffer: Buffer;
  framed: boolean;
  channelCredits: Map<number, number>;
  queues: Map<number, Buffer[]>;
  pendingClose: Map<number, Buffer>;
  channels: Set<number>;
};

const jsonBytes = (value: unknown): Buffer => Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
// Measured on hc 0.1.16: control replies are one JSON message per DATA frame, with no newline.
const frameJson = (value: unknown): Buffer => Buffer.from(JSON.stringify(value), 'utf8');

// Unit CI has no hc executable, so the fake owns only ephemeral loopback sockets.
export class FakeHc {
  readonly calls: RpcCall[] = [];
  readonly frames: Frame[] = [];
  readonly channels: number[] = [];
  readonly terminals: HcTerminal[] = [
    {
      address: 't1',
      name: 'fake-terminal',
      labels: {},
      argv: [],
      cwd: process.cwd(),
      state: 'live',
      created_ms: 0,
      screen: 'exact',
      cols: 80,
      rows: 24,
      pid: 1,
    },
  ];
  readonly hello: HcMethods['hello']['result'] = {
    version: HC_PINNED_VERSION,
    generation: 1,
    core: { id: 'fake-hc', name: 'Fake hc' },
    framed: true,
    methods: Object.keys(HC_USED_METHODS),
    features: [],
  };
  seq = 0;
  paint: Uint8Array = Buffer.alloc(0);
  afterReply?: (method: string, result: unknown) => void;

  private server?: Server;
  private readonly connections = new Set<Connection>();
  private readonly handlers = new Map<string, CallHandler>();
  private nextChannel = 1;
  private nextAddress = 2;
  private port: number | undefined;

  async listen(): Promise<number> {
    if (this.server) throw new Error('FakeHc is already listening');
    const server = createServer((socket) => this.accept(socket));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      server.once('error', onError);
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', onError);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('FakeHc did not bind an IP port');
    this.port = address.port;
    return address.port;
  }

  /** After close() it still dials the last port, so a client sees a refused connection, like a downed core. */
  connect = (): Socket => {
    if (this.port === undefined) throw new Error('FakeHc has never listened');
    return openSocket({ host: '127.0.0.1', port: this.port });
  };

  onCall(method: string, handler: CallHandler): void {
    this.handlers.set(method, handler);
  }

  disconnect(): void {
    for (const connection of this.connections) connection.socket.destroy();
  }

  async close(): Promise<void> {
    this.disconnect();
    const server = this.server;
    this.server = undefined;
    if (server?.listening)
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
  }

  send(channel: number, bytes: Uint8Array): void {
    for (const connection of this.connections) {
      if (!connection.framed || !connection.channels.has(channel)) continue;
      const data = Buffer.from(bytes);
      let offset = 0;
      while (offset < data.length) {
        const available = connection.channelCredits.get(channel) ?? 0;
        if (available <= 0) {
          const queue = connection.queues.get(channel) ?? [];
          queue.push(data.subarray(offset));
          connection.queues.set(channel, queue);
          break;
        }
        const count = Math.min(available, data.length - offset);
        this.writeFrame(connection, {
          channel,
          kind: FrameKind.Data,
          payload: data.subarray(offset, offset + count),
        });
        connection.channelCredits.set(channel, available - count);
        offset += count;
      }
    }
  }

  end(channel: number, end?: CloseReason): void {
    const payload = end ? frameJson(end) : Buffer.alloc(0);
    for (const connection of this.connections) {
      if (!connection.channels.has(channel)) continue;
      const queue = connection.queues.get(channel);
      if (queue?.length) {
        connection.pendingClose.set(channel, payload);
      } else {
        this.writeFrame(connection, { channel, kind: FrameKind.Close, payload });
        connection.channels.delete(channel);
      }
    }
  }

  notify(channel: number, notification: HcNotification | unknown): void {
    this.send(channel, jsonBytes(notification));
  }

  raw(bytes: Uint8Array): void {
    for (const connection of this.connections) connection.socket.write(Buffer.from(bytes));
  }

  sendFrame(frame: Frame): void {
    for (const connection of this.connections)
      if (connection.framed) this.writeFrame(connection, frame);
  }

  private accept(socket: Socket): void {
    const connection: Connection = {
      socket,
      decoder: new FrameDecoder(),
      lineBuffer: Buffer.alloc(0),
      framed: false,
      channelCredits: new Map(),
      queues: new Map(),
      pendingClose: new Map(),
      channels: new Set(),
    };
    this.connections.add(connection);
    socket.on('data', (chunk: Buffer) => this.receive(connection, chunk));
    socket.on('error', () => {
      socket.destroy();
      this.connections.delete(connection);
    });
    socket.on('close', () => this.connections.delete(connection));
  }

  private receive(connection: Connection, bytes: Buffer): void {
    if (!connection.framed) {
      connection.lineBuffer = Buffer.concat([connection.lineBuffer, bytes]);
      const newline = connection.lineBuffer.indexOf(10);
      if (newline < 0) return;
      const line = connection.lineBuffer.subarray(0, newline).toString('utf8');
      const remainder = connection.lineBuffer.subarray(newline + 1);
      connection.lineBuffer = Buffer.alloc(0);
      let request: { id?: number; method?: string; params?: Record<string, unknown> };
      try {
        request = JSON.parse(line) as typeof request;
      } catch {
        connection.socket.destroy();
        return;
      }
      if (request.method !== 'hello') {
        connection.socket.destroy();
        return;
      }
      this.calls.push({ id: request.id ?? 0, method: 'hello', params: request.params ?? {} });
      connection.framed = true;
      connection.socket.write(jsonBytes({ jsonrpc: '2.0', id: request.id, result: this.hello }));
      if (remainder.length) this.receiveFrames(connection, remainder);
      return;
    }
    this.receiveFrames(connection, bytes);
  }

  private receiveFrames(connection: Connection, bytes: Uint8Array): void {
    for (const frame of connection.decoder.push(bytes)) {
      this.frames.push(frame);
      if (frame.channel === CONTROL_CHANNEL && frame.kind === FrameKind.Data) {
        const line = Buffer.from(frame.payload).toString('utf8').trim();
        if (line)
          void this.handleCall(connection, JSON.parse(line) as RpcCall & { jsonrpc?: string });
      } else if (frame.kind === FrameKind.Credit) {
        const amount =
          frame.payload.byteLength >= 4 ? Buffer.from(frame.payload).readUInt32LE(0) : 0;
        connection.channelCredits.set(
          frame.channel,
          (connection.channelCredits.get(frame.channel) ?? 0) + amount,
        );
        this.flush(connection, frame.channel);
      } else if (frame.kind === FrameKind.Close) {
        connection.channels.delete(frame.channel);
        connection.queues.delete(frame.channel);
        connection.pendingClose.delete(frame.channel);
        this.writeFrame(connection, {
          channel: frame.channel,
          kind: FrameKind.Close,
          payload: Buffer.alloc(0),
        });
      }
    }
  }

  private async handleCall(connection: Connection, request: RpcCall): Promise<void> {
    this.calls.push({ id: request.id, method: request.method, params: request.params ?? {} });
    try {
      const result = await (
        this.handlers.get(request.method) ??
        ((params) => this.defaultCall(connection, request.method, params))
      )(request.params ?? {});
      const response = { jsonrpc: '2.0', id: request.id, result };
      this.writeFrame(connection, {
        channel: CONTROL_CHANNEL,
        kind: FrameKind.Data,
        payload: frameJson(response),
      });
      this.afterReply?.(request.method, result);
      if (request.method === 'terminal.attach' && result && typeof result === 'object') {
        const channel = (result as { channel?: unknown }).channel;
        if (typeof channel === 'number' && this.paint.byteLength) this.send(channel, this.paint);
      }
    } catch (error) {
      const rpc =
        error instanceof FakeRpcError
          ? { code: -32000, message: error.message, data: { kind: error.kind } }
          : { code: -32603, message: error instanceof Error ? error.message : String(error) };
      this.writeFrame(connection, {
        channel: CONTROL_CHANNEL,
        kind: FrameKind.Data,
        payload: frameJson({ jsonrpc: '2.0', id: request.id, error: rpc }),
      });
    }
  }

  private defaultCall(
    connection: Connection,
    method: string,
    params: Record<string, unknown>,
  ): unknown {
    const terminalAddress = String(params.terminal ?? 't1');
    const terminal = this.terminals.find(
      (item) => item.address === terminalAddress || item.name === terminalAddress,
    );
    if (method === 'hello') return this.hello;
    if (method === 'terminal.run') {
      const name = typeof params.name === 'string' ? params.name : `t${this.nextAddress}`;
      if (this.terminals.some((item) => item.state === 'live' && item.name === name))
        throw new FakeRpcError('name_taken');
      const record: HcTerminal = {
        address: `t${this.nextAddress++}`,
        name,
        labels: (params.labels as Record<string, string>) ?? {},
        argv: (params.argv as string[]) ?? [],
        cwd: String(params.cwd ?? process.cwd()),
        state: 'live',
        created_ms: Date.now(),
        screen: 'exact',
        cols: 80,
        rows: 24,
        pid: this.nextAddress,
      };
      this.terminals.push(record);
      return record;
    }
    if (method === 'terminal.list') {
      const filtered = this.terminals.filter((item) => this.matchesLabels(item, params.labels));
      const selected = params.all ? filtered : filtered.filter((item) => item.state === 'live');
      return {
        terminals: selected,
        hidden_finished: params.all
          ? 0
          : filtered.filter((item) => item.state === 'finished').length,
      };
    }
    if (method === 'terminal.get') {
      if (!terminal) throw new FakeRpcError('not_found');
      return terminal;
    }
    if (method === 'terminal.read') {
      if (!terminal) throw new FakeRpcError('not_found');
      return { text: '', complete: true, how: 'screen' };
    }
    if (method === 'terminal.attach') {
      if (!terminal) throw new FakeRpcError('not_found');
      if (terminal.state === 'finished') throw new FakeRpcError('finished');
      const channel = this.allocateChannel(connection);
      return { channel, terminal };
    }
    if (method === 'terminal.kill') {
      if (!terminal) throw new FakeRpcError('not_found');
      terminal.state = 'finished';
      terminal.exit_code = 0;
      terminal.finished_ms = Date.now();
      terminal.reason = 'killed';
      return terminal;
    }
    if (method === 'terminal.rm') {
      if (!terminal) throw new FakeRpcError('not_found');
      this.terminals.splice(this.terminals.indexOf(terminal), 1);
      return { removed: terminal.address };
    }
    if (method === 'terminal.label') {
      if (!terminal) throw new FakeRpcError('not_found');
      Object.assign(terminal.labels, params.labels);
      return terminal;
    }
    if (method === 'events.subscribe') {
      const channel = this.allocateChannel(connection);
      const terminals = this.terminals.filter(
        (item) =>
          this.matchesLabels(item, params.labels) &&
          (params.terminal === undefined ||
            item.address === params.terminal ||
            item.name === params.terminal),
      );
      return { seq: this.seq, terminals, channel };
    }
    if (method === 'server.status')
      return {
        version: HC_PINNED_VERSION,
        pid: process.pid,
        live: this.terminals.filter((item) => item.state === 'live').length,
        finished: this.terminals.filter((item) => item.state === 'finished').length,
      };
    throw new FakeRpcError('not_found', `Unknown method: ${method}`);
  }

  private matchesLabels(terminal: HcTerminal, labels: unknown): boolean {
    if (!labels || typeof labels !== 'object') return true;
    return Object.entries(labels as Record<string, string>).every(
      ([key, value]) => terminal.labels[key] === value,
    );
  }

  private allocateChannel(connection: Connection): number {
    const channel = this.nextChannel++;
    this.channels.push(channel);
    connection.channels.add(channel);
    connection.channelCredits.set(channel, INITIAL_STREAM_CREDIT);
    return channel;
  }

  private flush(connection: Connection, channel: number): void {
    const queue = connection.queues.get(channel);
    if (!queue) return;
    while (queue.length) {
      const available = connection.channelCredits.get(channel) ?? 0;
      if (available <= 0) break;
      const head = queue[0];
      const count = Math.min(available, head.length);
      this.writeFrame(connection, {
        channel,
        kind: FrameKind.Data,
        payload: head.subarray(0, count),
      });
      connection.channelCredits.set(channel, available - count);
      if (count === head.length) queue.shift();
      else queue[0] = head.subarray(count);
    }
    if (!queue.length) {
      connection.queues.delete(channel);
      const closePayload = connection.pendingClose.get(channel);
      if (closePayload) {
        connection.pendingClose.delete(channel);
        this.writeFrame(connection, { channel, kind: FrameKind.Close, payload: closePayload });
        connection.channels.delete(channel);
      }
    }
  }

  private writeFrame(connection: Connection, frame: Frame): void {
    if (!connection.socket.destroyed) connection.socket.write(encodeFrame(frame));
  }
}
