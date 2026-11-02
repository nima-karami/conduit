import { randomUUID } from 'node:crypto';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface C2Request {
  id?: number;
  method: string;
  params: unknown;
}
/** A handler's return is the result; throw `{ code, message, data }` for an error reply. */
type Handler = (params: unknown, socket: Socket) => unknown | Promise<unknown>;

/** A newline-JSON-RPC peer on a real socket: a POSIX socket in tmpdir, a named pipe on Windows. */
export class FakeC2Server {
  readonly endpoint =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\fake-c2-${randomUUID()}`
      : join(tmpdir(), `fake-c2-${randomUUID().slice(0, 8)}.sock`);
  readonly received: C2Request[] = [];
  readonly sockets = new Set<Socket>();
  /** Answer nothing at all (the hello-timeout case). */
  silent = false;
  private readonly handlers = new Map<string, Handler>();
  private server?: Server;

  constructor(hello: Record<string, unknown> = {}) {
    this.on('hello', () => ({
      serverVersion: '1.0.0',
      generation: 1,
      instance: 'abc',
      pid: 1,
      ...hello,
    }));
    this.on('events.subscribe', () => ({ seq: 0, sessions: [] }));
  }

  on(method: string, handler: Handler): void {
    this.handlers.set(method, handler);
  }

  listen(): Promise<void> {
    const server = createServer((socket) => this.accept(socket));
    this.server = server;
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.endpoint, () => resolve());
    });
  }

  /** Every connected socket gets this line (an event or any raw message). */
  push(message: unknown): void {
    for (const s of this.sockets) s.write(`${JSON.stringify(message)}\n`);
  }

  event(seq: number, type: string, data: unknown): void {
    this.push({ jsonrpc: '2.0', method: 'event', params: { seq, type, data } });
  }

  dropClients(): void {
    for (const s of this.sockets) s.destroy();
  }

  async close(): Promise<void> {
    this.dropClients();
    const server = this.server;
    this.server = undefined;
    if (server?.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  calls(method: string): C2Request[] {
    return this.received.filter((r) => r.method === method);
  }

  private accept(socket: Socket): void {
    this.sockets.add(socket);
    socket.on('close', () => this.sockets.delete(socket));
    socket.on('error', () => socket.destroy());
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
        const request = JSON.parse(buffer.slice(0, end)) as C2Request;
        buffer = buffer.slice(end + 1);
        this.received.push(request);
        if (this.silent || request.id === undefined) continue;
        void this.answer(socket, request);
      }
    });
  }

  private async answer(socket: Socket, request: C2Request): Promise<void> {
    const handler = this.handlers.get(request.method) ?? (() => ({}));
    let reply: Record<string, unknown>;
    try {
      reply = { result: await handler(request.params, socket) };
    } catch (error) {
      reply = { error };
    }
    if (!socket.destroyed)
      socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, ...reply })}\n`);
  }
}
