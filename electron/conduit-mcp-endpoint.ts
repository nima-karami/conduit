import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { type Result, toolError } from '../src/conduit-mcp/types';
import type { Logger } from './logger';

export const HELLO_MAX_BYTES = 4096;
export const INBOUND_LINE_MAX_BYTES = 4 * 1024 * 1024;
/** How long close() waits for queued replies to flush before destroying the socket anyway. */
export const CLOSE_FLUSH_MS = 2_000;

export interface EndpointConnection {
  readonly id: number;
  /** From the hello line; null when absent or blank. */
  readonly token: string | null;
  /** Appends '\n'. */
  send(line: string): void;
  onLine(cb: (line: string) => void): void;
  onClose(cb: () => void): void;
  close(): void;
}

export interface McpEndpoint {
  listen(): Promise<Result<void>>;
  close(): Promise<void>;
}

const isPipe = (p: string) => p.startsWith('\\\\.\\pipe\\') || p.startsWith('//./pipe/');

/** The shim's first line: `{"conduit":1,"token":"<hex>"|null}`. undefined = not a hello. */
function parseHello(line: string): { token: string | null } | undefined {
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  if (o.conduit !== 1) return undefined;
  if (o.token === null || o.token === undefined) return { token: null };
  if (typeof o.token !== 'string') return undefined;
  return { token: o.token.trim() === '' ? null : o.token };
}

/**
 * The local endpoint every shim dials (spec §3.1). Newline-delimited: the first line is the hello,
 * every later line is one JSON-RPC message for the host. Bounded both before and after the hello,
 * so a stray client can't make the host buffer without limit.
 */
export function createMcpEndpoint(opts: {
  path: string;
  onConnection(conn: EndpointConnection): void;
  log: Pick<Logger, 'debug' | 'warn'>;
  closeFlushMs?: number;
}): McpEndpoint {
  const closeFlushMs = opts.closeFlushMs ?? CLOSE_FLUSH_MS;
  const sockets = new Set<net.Socket>();
  let nextId = 1;

  const accept = (socket: net.Socket) => {
    sockets.add(socket);
    const id = nextId++;
    let pending: Buffer = Buffer.alloc(0);
    let conn: (EndpointConnection & { deliver(line: string): void; closed(): void }) | undefined;

    const drop = (why: string) => {
      opts.log.debug('conduit-mcp', 'endpoint connection dropped', { id, why });
      socket.destroy();
    };

    const makeConn = (token: string | null) => {
      const lineCbs: Array<(l: string) => void> = [];
      const closeCbs: Array<() => void> = [];
      return {
        id,
        token,
        send(line: string) {
          if (socket.writable) socket.write(`${line}\n`);
        },
        onLine(cb: (l: string) => void) {
          lineCbs.push(cb);
        },
        onClose(cb: () => void) {
          closeCbs.push(cb);
        },
        close() {
          // destroy() alone drops queued writes: replies sent just before close would be lost.
          // Bounded, so a peer that stops reading can't hold a closed connection open.
          if (!socket.writable) {
            socket.destroy();
            return;
          }
          const bound = setTimeout(() => socket.destroy(), closeFlushMs);
          socket.once('close', () => clearTimeout(bound));
          socket.end(() => socket.destroy());
        },
        deliver(line: string) {
          for (const cb of lineCbs) cb(line);
        },
        closed() {
          for (const cb of closeCbs) cb();
        },
      };
    };

    socket.on('data', (chunk: Buffer) => {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      let nl = pending.indexOf(0x0a);
      // Not writable once closed: nothing read after close() reaches the host.
      while (nl >= 0 && socket.writable) {
        const line = pending.subarray(0, nl).toString('utf8').replace(/\r$/, '');
        pending = pending.subarray(nl + 1);
        if (conn) {
          conn.deliver(line);
        } else {
          if (nl > HELLO_MAX_BYTES) return drop('hello too large');
          const hello = parseHello(line);
          if (!hello) return drop('malformed hello');
          conn = makeConn(hello.token);
          opts.onConnection(conn);
        }
        nl = pending.indexOf(0x0a);
      }
      const limit = conn ? INBOUND_LINE_MAX_BYTES : HELLO_MAX_BYTES;
      if (pending.length > limit) drop(conn ? 'line too large' : 'hello too large');
    });
    socket.on('error', (err) =>
      opts.log.debug('conduit-mcp', 'endpoint socket error', { id, err: String(err) }),
    );
    socket.on('close', () => {
      sockets.delete(socket);
      conn?.closed();
    });
  };

  const server = net.createServer(accept);

  return {
    async listen() {
      if (!isPipe(opts.path)) {
        try {
          await fs.promises.mkdir(path.dirname(opts.path), { recursive: true });
          // A socket file left by a crashed instance would make listen fail with EADDRINUSE.
          await fs.promises.rm(opts.path, { force: true });
        } catch (err) {
          opts.log.warn('conduit-mcp', 'endpoint path prep failed', { err: String(err) });
          return { ok: false, error: toolError('host_unavailable', 'endpoint path unusable') };
        }
      }
      return new Promise<Result<void>>((resolve) => {
        const onError = (err: NodeJS.ErrnoException) => {
          opts.log.warn('conduit-mcp', 'endpoint listen failed', {
            code: err.code,
            err: String(err),
          });
          resolve({
            ok: false,
            error: toolError(
              'host_unavailable',
              `endpoint listen failed: ${err.code ?? err.message}`,
            ),
          });
        };
        server.once('error', onError);
        server.listen(opts.path, () => {
          server.off('error', onError);
          server.on('error', (err) =>
            opts.log.warn('conduit-mcp', 'endpoint server error', { err: String(err) }),
          );
          resolve({ ok: true, value: undefined });
        });
      });
    },
    close() {
      for (const s of sockets) s.destroy();
      if (!server.listening) return Promise.resolve();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
