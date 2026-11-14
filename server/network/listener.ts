import { isIPv6 } from 'node:net';
import tls from 'node:tls';
import { rawEd25519 } from '../../src/network/self-signed-cert';

// The link endpoint (docs/plans/2026-11-14-conduit-network-machinery.plan.md decisions 4–5).
// Authentication is ours, not the CA's: TLS 1.3 proves the peer holds the private key of the
// certificate it presents, and the pin check below decides whether that key may talk at all.
// Nothing reads from a socket until that check has passed.

export interface NetLog {
  debug(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
}

export type PeerClass = 'link' | 'pairing' | 'reject';

export interface Listener {
  addresses(): string[];
  close(): Promise<void>;
}

export interface ListenOptions {
  hosts: string[];
  port: number;
  cert: string;
  key: string;
  classify(peerKeyRaw: Buffer): PeerClass;
  onLink(sock: tls.TLSSocket, peerKeyRaw: Buffer): void;
  onPairing(sock: tls.TLSSocket, peerKeyRaw: Buffer): void;
  log: NetLog;
  handshakeTimeoutMs?: number;
}

const HANDSHAKE_TIMEOUT_MS = 10_000;

/** Shared by both ends: TLS 1.3 only, mutual certificates, no CA (the pin replaces it). */
function tlsOptions(cert: string, key: string) {
  return {
    cert,
    key,
    minVersion: 'TLSv1.3',
    maxVersion: 'TLSv1.3',
    rejectUnauthorized: false,
  } as const;
}

/** The peer's raw Ed25519 key from its certificate, or null for none or another key type. */
function peerKeyOf(sock: tls.TLSSocket): Buffer | null {
  const cert = sock.getPeerX509Certificate();
  if (!cert) return null;
  try {
    return rawEd25519(cert.publicKey);
  } catch {
    // A non-Ed25519 certificate can't be a Conduit server; the caller destroys the socket.
    return null;
  }
}

export const formatHostPort = (host: string, port: number): string =>
  isIPv6(host) ? `[${host}]:${port}` : `${host}:${port}`;

export async function listen(opts: ListenOptions): Promise<Listener> {
  const servers: tls.Server[] = [];
  const bound: string[] = [];
  let port = opts.port;
  const accept = (sock: tls.TLSSocket): void => {
    sock.pause();
    const peer = peerKeyOf(sock);
    const kind: PeerClass = peer === null ? 'reject' : opts.classify(peer);
    if (peer === null || kind === 'reject') {
      opts.log.debug('link listener: refused peer', { remote: sock.remoteAddress ?? null });
      sock.destroy();
      return;
    }
    if (kind === 'link') opts.onLink(sock, peer);
    else opts.onPairing(sock, peer);
  };
  try {
    for (const host of opts.hosts) {
      const server = tls.createServer(
        {
          ...tlsOptions(opts.cert, opts.key),
          requestCert: true,
          handshakeTimeout: opts.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS,
        },
        accept,
      );
      server.on('tlsClientError', (err) =>
        opts.log.debug('link listener: handshake failed', { message: err.message }),
      );
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolve();
        });
      });
      server.on('error', (err) => opts.log.warn('link listener error', { message: err.message }));
      servers.push(server);
      const addr = server.address();
      if (addr === null || typeof addr === 'string') throw new Error('listener has no TCP address');
      // An ephemeral port (0) is picked once and reused, so every host answers on one port.
      port = addr.port;
      bound.push(formatHostPort(host, addr.port));
    }
  } catch (err) {
    await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
    throw err;
  }
  return {
    addresses: () => [...bound],
    close: () =>
      Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r())))).then(
        () => undefined,
      ),
  };
}

export interface DialOptions {
  address: string;
  cert: string;
  key: string;
  /** The pinned peer key; null only for a pairing join, which learns the key from the handshake. */
  expectKeyRaw: Buffer | null;
  timeoutMs: number;
}

export function parseHostPort(address: string): { host: string; port: number } | null {
  const m =
    /^\[([0-9a-fA-F:.]+)\]:(\d{1,5})$/.exec(address) ?? /^([^:[\]]+):(\d{1,5})$/.exec(address);
  if (!m?.[1] || !m[2]) return null;
  const port = Number(m[2]);
  return port >= 1 && port <= 65535 ? { host: m[1], port } : null;
}

export function dial(opts: DialOptions): Promise<{ sock: tls.TLSSocket; peerKeyRaw: Buffer }> {
  const target = parseHostPort(opts.address);
  if (target === null) return Promise.reject(new Error('bad_address'));
  return new Promise((resolve, reject) => {
    const sock = tls.connect({
      ...tlsOptions(opts.cert, opts.key),
      host: target.host,
      port: target.port,
      // Identity is the pinned key, not a host name; there is no name to check.
      checkServerIdentity: () => undefined,
    });
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error('timeout'));
    }, opts.timeoutMs);
    sock.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    sock.once('secureConnect', () => {
      clearTimeout(timer);
      sock.pause();
      const peer = peerKeyOf(sock);
      if (peer === null || (opts.expectKeyRaw !== null && !peer.equals(opts.expectKeyRaw))) {
        sock.destroy();
        reject(new Error('pin_mismatch'));
        return;
      }
      sock.removeAllListeners('error');
      resolve({ sock, peerKeyRaw: peer });
    });
  });
}
