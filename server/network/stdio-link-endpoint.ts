import { chmodSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { BRIDGE_PREAMBLE_MAX_BYTES, type BridgePreamble } from '../../src/contracts/ssh-link';
import { readFirstFrame } from '../../src/network/frame-codec';
import { secretMatches } from '../../src/server-secret';
import type { AuditSink } from './audit-log';
import type { NetLog } from './listener';

// The ssh bridge is the only client here. It proves SSH access with the per-start secret, so a
// socket that cannot produce one is not a link, and nothing past the preamble is parsed for it.
// see docs/plans/2026-11-16-remote-ssh-stdio-link.plan.md decision 1 and Task 3.1

const PREAMBLE_TIMEOUT_MS = 5_000;

export type BridgeRefusal = 'bad_secret' | 'bad_preamble' | 'timeout';

export interface StdioLinkEndpointOptions {
  endpoint: string;
  platform: NodeJS.Platform;
  /** Read at each preamble, so a restarted secret file is the one that counts. */
  secret: () => string;
  /** Takes over a stream that presented the secret. It comes paused: the consumer resumes it. */
  accept: (stream: Duplex) => void;
  audit: AuditSink;
  log: NetLog;
}

export interface StdioLinkEndpoint {
  close(): Promise<void>;
}

export async function listenStdioLink(o: StdioLinkEndpointOptions): Promise<StdioLinkEndpoint> {
  const sockets = new Set<Socket>();
  const onConnection = (sock: Socket) => {
    sockets.add(sock);
    sock.once('close', () => sockets.delete(sock));
    admit(o, sock);
  };
  let server: Server;
  try {
    server = await listenOnce(o, onConnection);
  } catch (error) {
    // A socket file outlives a crashed owner. Only one nobody answers is ours to replace.
    if (codeOf(error) !== 'EADDRINUSE' || o.platform === 'win32' || (await answers(o.endpoint))) {
      throw error;
    }
    await unlink(o.endpoint).catch((unlinkError: unknown) => {
      if (codeOf(unlinkError) !== 'ENOENT') throw unlinkError;
    });
    server = await listenOnce(o, onConnection);
  }
  return {
    close: () =>
      new Promise<void>((resolve) => {
        server.close((err) => {
          if (err) o.log.debug('stdio link endpoint close', { message: err.message });
          resolve();
        });
        for (const sock of sockets) sock.destroy();
      }),
  };
}

function listenOnce(o: StdioLinkEndpointOptions, onConnection: (sock: Socket) => void) {
  return new Promise<Server>((resolve, reject) => {
    const server = createServer(onConnection);
    const failed = (error: Error) => reject(error);
    server.once('error', failed);
    server.listen(o.endpoint, () => {
      server.off('error', failed);
      try {
        // Windows pipes have no posix mode; their user-only default is the gate there.
        if (o.platform !== 'win32') chmodSync(o.endpoint, 0o600);
      } catch (error) {
        server.close();
        reject(error);
        return;
      }
      server.on('error', (err) =>
        o.log.warn('stdio link endpoint error', { message: err.message }),
      );
      resolve(server);
    });
  });
}

function admit(o: StdioLinkEndpointOptions, sock: Socket): void {
  let buffered = Buffer.alloc(0);
  const timer = setTimeout(() => refuse(o, sock, 'timeout'), PREAMBLE_TIMEOUT_MS);
  sock.on('error', (err) => o.log.debug('stdio link peer error', { message: err.message }));
  sock.once('close', () => clearTimeout(timer));
  const onData = (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk]);
    const first = readFirstFrame(buffered, BRIDGE_PREAMBLE_MAX_BYTES);
    if (first.kind === 'incomplete') return;
    clearTimeout(timer);
    sock.off('data', onData);
    sock.pause();
    if (first.kind === 'error' || !isPreamble(first.frame)) {
      refuse(o, sock, 'bad_preamble');
    } else if (!secretMatches(o.secret(), first.frame.secret)) {
      refuse(o, sock, 'bad_secret');
    } else {
      if (first.rest.length > 0) sock.unshift(first.rest);
      o.accept(sock);
    }
  };
  sock.on('data', onData);
}

function refuse(o: StdioLinkEndpointOptions, sock: Socket, reason: BridgeRefusal): void {
  o.audit.record({ kind: 'bridge.refused', peer: null, detail: { reason } });
  sock.destroy();
}

function isPreamble(frame: unknown): frame is BridgePreamble {
  return (
    typeof frame === 'object' &&
    frame !== null &&
    'v' in frame &&
    frame.v === 1 &&
    't' in frame &&
    frame.t === 'bridge' &&
    'secret' in frame &&
    typeof frame.secret === 'string'
  );
}

/** True when a live server answers at the endpoint; false when nothing is listening there. */
function answers(endpoint: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const probe = createConnection(endpoint);
    probe.once('connect', () => {
      probe.destroy();
      resolve(true);
    });
    probe.once('error', (error) => {
      probe.destroy();
      const code = codeOf(error);
      if (code === 'ECONNREFUSED' || code === 'ENOENT') resolve(false);
      else reject(error);
    });
  });
}

function codeOf(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}
