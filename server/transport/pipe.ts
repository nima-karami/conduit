import { unlink } from 'node:fs/promises';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { StringDecoder } from 'node:string_decoder';
import type { ServerEventSink } from '../../src/contracts/server-ports';
import {
  APP_HELLO_TIMEOUT_MS,
  SERVER_ERROR_RPC_CODE,
  SERVER_EVENT_METHOD,
  type ServerErrorKind,
  type ServerEventNotification,
  type ServerRpcError,
  type VersionOrder,
} from '../../src/contracts/server-protocol';

export interface RpcRequest {
  id?: string | number | null;
  method: string;
  params: unknown;
}
export interface Peer {
  subscribed: boolean;
  order?: VersionOrder;
}
type AfterReply = () => Promise<void> | void;
export type RpcAnswer =
  | { result: unknown; afterReply?: AfterReply }
  | { error: unknown; afterReply?: AfterReply }
  | { reply: false };
export type RpcHandler = (request: RpcRequest, peer: Peer) => RpcAnswer | Promise<RpcAnswer>;

/** How long a closing peer gets to drain before its socket is destroyed. */
const CLOSE_GRACE_MS = 1_000;

export class RpcFault extends Error {
  constructor(
    readonly kind: ServerErrorKind,
    message: string,
  ) {
    super(message);
  }
}

export class RpcProtocolFault extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const codeOf = (error: unknown) => (record(error) ? error.code : undefined);
const expectedRefusal = (error: unknown) =>
  error instanceof RpcFault || (error instanceof RpcProtocolFault && error.code === -32601);

/**
 * Per-peer bound on unflushed event bytes. Past it a stalled app would grow the server's memory
 * without limit, so its stream is dropped with C2 `missed` until it calls events.subscribe again.
 */
export const EVENT_BUFFER_BOUND_BYTES = 8 * 1024 * 1024;

function rpcError(error: unknown): ServerRpcError | { code: number; message: string } {
  if (error instanceof RpcFault)
    return { code: SERVER_ERROR_RPC_CODE, message: error.message, data: { kind: error.kind } };
  return {
    code: error instanceof RpcProtocolFault ? error.code : -32603,
    message: error instanceof Error ? error.message : String(error),
  };
}

export class PipeTransport {
  seq = 0;
  readonly peers = new Map<Socket, Peer>();
  private server?: Server;
  onConnect: () => void = () => {};
  onDisconnect: () => void = () => {};
  constructor(
    readonly endpoint: string,
    readonly platform: 'win32' | 'posix',
    readonly onError: (error: unknown) => void = (error) => console.error(error),
    readonly eventBufferBound = EVENT_BUFFER_BOUND_BYTES,
  ) {}

  async listen(handler: RpcHandler): Promise<boolean> {
    const bind = () =>
      new Promise<void>((resolve, reject) => {
        const server = createServer((socket) => this.accept(socket, handler));
        this.server = server;
        const failed = (error: Error) => reject(error);
        server.once('error', failed);
        server.listen(this.endpoint, () => {
          server.off('error', failed);
          server.on('error', this.onError);
          resolve();
        });
      });
    try {
      await bind();
      return true;
    } catch (error) {
      if (codeOf(error) !== 'EADDRINUSE') throw error;
      if (this.platform === 'win32' || (await this.occupied())) return false;
      try {
        await unlink(this.endpoint);
      } catch (error) {
        if (codeOf(error) !== 'ENOENT') throw error;
      }
      try {
        await bind();
        return true;
      } catch (error) {
        if (codeOf(error) === 'EADDRINUSE') return false;
        throw error;
      }
    }
  }

  private occupied(): Promise<boolean> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(this.endpoint);
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', (error) => {
        socket.destroy();
        if (codeOf(error) === 'ECONNREFUSED' || codeOf(error) === 'ENOENT') resolve(false);
        else reject(error);
      });
    });
  }

  private accept(socket: Socket, handler: RpcHandler): void {
    const peer: Peer = { subscribed: false };
    this.peers.set(socket, peer);
    this.onConnect();
    // C2 names no server-side hello bound; the app's own is reused so a silent peer can't hold a slot.
    const helloTimer = setTimeout(() => socket.destroy(), APP_HELLO_TIMEOUT_MS);
    const decoder = new StringDecoder('utf8');
    let buffer = '';
    socket.on('data', (chunk: Buffer) => {
      buffer += decoder.write(chunk);
      for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        void this.receive(socket, peer, line, handler, () => clearTimeout(helloTimer));
      }
    });
    socket.on('error', (error) => {
      if (codeOf(error) !== 'EPIPE' && codeOf(error) !== 'ECONNRESET') this.onError(error);
      socket.destroy();
    });
    socket.once('close', () => {
      clearTimeout(helloTimer);
      this.peers.delete(socket);
      this.onDisconnect();
    });
  }

  private send(socket: Socket, value: unknown): Promise<boolean> {
    if (socket.destroyed || !socket.writable) return Promise.resolve(false);
    return new Promise((resolve) => {
      socket.write(`${JSON.stringify(value)}\n`, (error) => resolve(!error));
    });
  }

  private async receive(
    socket: Socket,
    peer: Peer,
    line: string,
    handler: RpcHandler,
    helloDone: () => void,
  ) {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      await this.send(socket, {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error' },
      });
      return;
    }
    if (
      !record(value) ||
      value.jsonrpc !== '2.0' ||
      typeof value.method !== 'string' ||
      ('id' in value &&
        value.id !== null &&
        typeof value.id !== 'string' &&
        typeof value.id !== 'number')
    ) {
      await this.send(socket, {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32600, message: 'Invalid Request' },
      });
      return;
    }
    const request: RpcRequest = { method: value.method, params: value.params ?? {} };
    if ('id' in value) request.id = value.id as string | number | null;
    let answer: RpcAnswer;
    try {
      const pending = handler(request, peer);
      answer = pending instanceof Promise ? await pending : pending;
    } catch (error) {
      answer = { error };
    }
    if ('reply' in answer) return;
    if ('result' in answer && request.method === 'hello') helloDone();
    if (!('id' in request)) {
      // A notification has nobody to answer, so only an expected refusal may go unreported.
      if ('error' in answer && !expectedRefusal(answer.error)) this.onError(answer.error);
    } else if ('error' in answer) {
      await this.send(socket, { jsonrpc: '2.0', id: request.id, error: rpcError(answer.error) });
    } else {
      await this.send(socket, { jsonrpc: '2.0', id: request.id, result: answer.result });
    }
    try {
      await answer.afterReply?.();
    } catch (error) {
      this.onError(error);
    }
  }

  async close(): Promise<void> {
    for (const socket of this.peers.keys()) {
      socket.end(() => socket.destroy());
      // A peer that stopped reading never finishes its end; server.close would wait on it forever.
      setTimeout(() => socket.destroy(), CLOSE_GRACE_MS).unref();
    }
    const server = this.server;
    if (!server?.listening) return;
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }

  emit: ServerEventSink = (type, data) => {
    const seq = ++this.seq;
    const notification: ServerEventNotification = {
      jsonrpc: '2.0',
      method: SERVER_EVENT_METHOD,
      params: { seq, type, data },
    };
    const missed: ServerEventNotification = {
      jsonrpc: '2.0',
      method: SERVER_EVENT_METHOD,
      params: { seq, type: 'missed', data: { seq } },
    };
    for (const [socket, peer] of this.peers) {
      if (!peer.subscribed) continue;
      if (socket.writableLength <= this.eventBufferBound) {
        void this.send(socket, notification);
        continue;
      }
      peer.subscribed = false;
      void this.send(socket, missed);
    }
  };
}
