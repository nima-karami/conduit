import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import type { EndpointConnection, McpEndpoint } from '../../src/conduit-mcp/host';
import { type Result, toolError } from '../../src/conduit-mcp/types';
import type { TokenRows, TokenStorePort } from '../../src/contracts/server-ports';
import {
  parseShimHello,
  RESUME_NOTIFICATION,
  SHIM_HELLO_MAX_BYTES,
  type ShimHello,
  type ShimResume,
  type ShimWelcome,
} from '../../src/contracts/shim-protocol';
import { LineReader } from '../../src/line-reader';

/** As v0.51's endpoint: bounds one relayed line so a stray client can't grow the server. */
const INBOUND_LINE_MAX_BYTES = 4 * 1024 * 1024;
/** How long close() waits for queued replies to flush before destroying the socket anyway. */
const CLOSE_FLUSH_MS = 2_000;
/**
 * The id of the cached initialize replayed for a resume. Its reply is swallowed: the client already
 * has its one initialize response (C6 RESUME_NOTIFICATION).
 */
const RESUME_INIT_ID = '\u0000conduit-resume';
const RESUME_LINE = JSON.stringify({ jsonrpc: '2.0', method: RESUME_NOTIFICATION });

export type EndpointLog = Record<
  'debug' | 'warn',
  (scope: string, message: string, data?: Record<string, unknown>) => void
>;

const isPipe = (p: string) => p.startsWith('\\\\.\\pipe\\') || p.startsWith('//./pipe/');
const sha256 = (t: string) => createHash('sha256').update(t).digest('hex');

/**
 * `unknown_token` ends a shim's retries for good, so it follows only a clean load (D21). A missing
 * file with a token presented can only mean the file was lost: every Conduit launch reserved its row
 * on disk before it ran.
 */
function welcomeFor(hello: { token: string | null }, rows: TokenRows): ShimWelcome {
  if (rows.state === 'unreadable') return { conduit: 2, ok: false, reason: 'draining' };
  if (hello.token === null) return { conduit: 2, ok: true };
  if (rows.state === 'missing') return { conduit: 2, ok: false, reason: 'draining' };
  const hash = sha256(hello.token);
  return rows.rows.some((r) => r.sha256 === hash && r.state !== 'superseded')
    ? { conduit: 2, ok: true }
    : { conduit: 2, ok: false, reason: 'unknown_token' };
}

const parseObject = (line: string): Record<string, unknown> | null => {
  try {
    const v: unknown = JSON.parse(line);
    return typeof v === 'object' && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};
const isInitializedNotification = (line: string): boolean => {
  const msg = parseObject(line);
  return msg !== null && !('id' in msg) && msg.method === 'notifications/initialized';
};
const isResumeReply = (line: string): boolean =>
  line.includes('conduit-resume') && parseObject(line)?.id === RESUME_INIT_ID;

/**
 * The local endpoint every shim dials (C6, server side). The first line is the hello; a gen-2 hello
 * is answered with a welcome line, a gen-1 one with none. Each later line is one JSON-RPC message for
 * the host. A resume replays the client's cached initialize into the host, so the host initializes
 * and binds the connection as it would a fresh one, and no second initialize response reaches the
 * client.
 */
export function createShimEndpoint(opts: {
  path: string;
  onConnection(conn: EndpointConnection): void;
  log: EndpointLog;
  tokens: Pick<TokenStorePort, 'rows'>;
  closeFlushMs?: number;
}): McpEndpoint {
  const closeFlushMs = opts.closeFlushMs ?? CLOSE_FLUSH_MS;
  const sockets = new Set<net.Socket>();
  let nextId = 1;

  const accept = (socket: net.Socket) => {
    sockets.add(socket);
    const id = nextId++;
    let deliver: ((line: string) => void) | undefined;
    const closeCbs: Array<() => void> = [];
    // A repeat close() while flushing would find the socket unwritable and destroy it early.
    let closing = false;

    const write = (line: string) => {
      if (socket.writable) socket.write(`${line}\n`);
    };
    const drop = (why: string) => {
      opts.log.debug('conduit-mcp', 'endpoint connection dropped', { id, why });
      socket.destroy();
    };
    const close = () => {
      // destroy() alone drops queued writes: replies sent just before close would be lost.
      if (closing) return;
      closing = true;
      if (!socket.writable) {
        socket.destroy();
        return;
      }
      const bound = setTimeout(() => socket.destroy(), closeFlushMs);
      socket.once('close', () => clearTimeout(bound));
      socket.end(() => socket.destroy());
    };

    const open = (hello: ShimHello) => {
      const lineCbs: Array<(l: string) => void> = [];
      const toHost = (l: string) => {
        for (const cb of lineCbs) cb(l);
      };
      const resume: ShimResume | null = hello.conduit === 2 ? hello.resume : null;
      let swallowing = false;
      let awaitingInitialized = resume !== null && !resume.initialized;
      const replay = () => {
        if (!resume) return;
        swallowing = true;
        toHost(
          JSON.stringify({
            jsonrpc: '2.0',
            id: RESUME_INIT_ID,
            method: 'initialize',
            params: resume.initialize,
          }),
        );
      };
      opts.onConnection({
        id,
        token: hello.token,
        send(line) {
          if (swallowing && isResumeReply(line)) {
            swallowing = false;
            if (parseObject(line)?.error !== undefined)
              opts.log.warn('conduit-mcp', 'replayed initialize refused', { id, reply: line });
            // After the host has initialized the connection: the refetch must see its tools.
            write(RESUME_LINE);
            return;
          }
          write(line);
        },
        onLine: (cb) => lineCbs.push(cb),
        onClose: (cb) => closeCbs.push(cb),
        close,
      });
      deliver = (l) => {
        if (awaitingInitialized && isInitializedNotification(l)) {
          awaitingInitialized = false;
          replay();
        }
        toHost(l);
      };
      if (resume?.initialized) replay();
    };

    const onHello = (line: string) => {
      const parsed = parseShimHello(line);
      if (!parsed) return drop('malformed hello');
      if (!parsed.ok) {
        write(JSON.stringify({ conduit: 2, ok: false, reason: parsed.reason }));
        return close();
      }
      const { hello } = parsed;
      if (hello.conduit === 2) {
        const welcome = welcomeFor(hello, opts.tokens.rows());
        write(JSON.stringify(welcome));
        if (!welcome.ok) return close();
      }
      open(hello);
    };

    const reader = new LineReader(
      () => (deliver ? INBOUND_LINE_MAX_BYTES : SHIM_HELLO_MAX_BYTES),
      (raw) => {
        const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
        if (deliver) deliver(line);
        else onHello(line);
      },
      () => drop(deliver ? 'line too large' : 'hello too large'),
    );
    socket.on('data', (chunk: Buffer) =>
      // Nothing read after close() reaches the host.
      reader.write(chunk, () => socket.writable && !closing),
    );
    socket.on('error', (err) =>
      opts.log.debug('conduit-mcp', 'endpoint socket error', { id, err: String(err) }),
    );
    socket.on('close', () => {
      sockets.delete(socket);
      for (const cb of closeCbs) cb();
    });
  };

  const server = net.createServer(accept);

  return {
    async listen(): Promise<Result<void>> {
      if (!isPipe(opts.path)) {
        try {
          await fs.promises.mkdir(path.dirname(opts.path), { recursive: true });
          // A socket file left by a crashed server would make listen fail with EADDRINUSE.
          await fs.promises.rm(opts.path, { force: true });
        } catch (err) {
          opts.log.warn('conduit-mcp', 'endpoint path prep failed', { err: String(err) });
          return { ok: false, error: toolError('host_unavailable', 'endpoint path unusable') };
        }
      }
      return new Promise<Result<void>>((resolve) => {
        const onError = (err: NodeJS.ErrnoException) => {
          opts.log.warn('conduit-mcp', 'endpoint listen failed', { code: err.code });
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
