import net from 'node:net';
import tls from 'node:tls';
import { rawEd25519 } from '../../src/network/self-signed-cert';

// The link and pairing endpoints (docs/plans/2026-11-14-conduit-network-machinery.plan.md
// decisions 4–5, as built). Links are TLS 1.3 with mutual certificates where the only trusted CAs
// are the pinned certificates of linked peers, so OpenSSL itself refuses anyone else; the raw-key
// pin below is a second check. Pairing is plain TCP on its own port, open only during a window:
// its messages are public and the fingerprint comparison authenticates them.

export interface NetLog {
  debug(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
}

export interface Listener {
  addresses(): string[];
  close(): Promise<void>;
}

export interface LinkListener extends Listener {
  /** The set of linked or tombstoned peers changed: new handshakes trust exactly these. */
  refreshTrust(): void;
}

export interface LinkListenOptions {
  hosts: string[];
  port: number;
  cert: string;
  key: string;
  /** PEM certificates of every linked peer and every recent tombstone. */
  trustedCerts(): string[];
  /** The pin: the verified peer's raw key must still name a link or tombstone. */
  knows(peerKeyRaw: Buffer): boolean;
  onLink(sock: tls.TLSSocket, peerKeyRaw: Buffer): void;
  log: NetLog;
  handshakeTimeoutMs?: number;
}

const HANDSHAKE_TIMEOUT_MS = 10_000;
const TLS13 = { minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3' } as const;

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
  net.isIPv6(host) ? `[${host}]:${port}` : `${host}:${port}`;

/** Binds every host on one port; an ephemeral port (0) is picked once and reused. */
async function bindAll<S extends net.Server>(
  hosts: string[],
  port: number,
  make: () => S,
  log: NetLog,
): Promise<{ servers: S[]; addresses: string[] }> {
  const servers: S[] = [];
  const addresses: string[] = [];
  let p = port;
  try {
    for (const host of hosts) {
      const server = make();
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(p, host, () => {
          server.off('error', reject);
          resolve();
        });
      });
      server.on('error', (err) => log.warn('network listener error', { message: err.message }));
      servers.push(server);
      const addr = server.address();
      if (addr === null || typeof addr === 'string') throw new Error('listener has no TCP address');
      p = addr.port;
      addresses.push(formatHostPort(host, addr.port));
    }
  } catch (err) {
    await closeAll(servers);
    throw err;
  }
  return { servers, addresses };
}

const closeAll = (servers: net.Server[]): Promise<void> =>
  Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r())))).then(
    () => undefined,
  );

export async function listenLinks(opts: LinkListenOptions): Promise<LinkListener> {
  const context = () => ({ cert: opts.cert, key: opts.key, ca: opts.trustedCerts(), ...TLS13 });
  const accept = (sock: tls.TLSSocket): void => {
    sock.pause();
    const peer = peerKeyOf(sock);
    if (peer === null || !sock.authorized || !opts.knows(peer)) {
      opts.log.debug('link listener: refused peer', { remote: sock.remoteAddress ?? null });
      sock.destroy();
      return;
    }
    opts.onLink(sock, peer);
  };
  const { servers, addresses } = await bindAll(
    opts.hosts,
    opts.port,
    () => {
      const server = tls.createServer(
        {
          ...context(),
          requestCert: true,
          rejectUnauthorized: true,
          handshakeTimeout: opts.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS,
        },
        accept,
      );
      server.on('tlsClientError', (err) =>
        opts.log.debug('link listener: handshake refused', { message: err.message }),
      );
      return server;
    },
    opts.log,
  );
  return {
    addresses: () => [...addresses],
    refreshTrust: () => {
      for (const s of servers) s.setSecureContext(context());
    },
    close: () => closeAll(servers),
  };
}

export interface PairingListenOptions {
  hosts: string[];
  port: number;
  onPairing(sock: net.Socket): void;
  log: NetLog;
}

export async function listenPairing(opts: PairingListenOptions): Promise<Listener> {
  const { servers, addresses } = await bindAll(
    opts.hosts,
    opts.port,
    () => net.createServer({ pauseOnConnect: true }, (sock) => opts.onPairing(sock)),
    opts.log,
  );
  return { addresses: () => [...addresses], close: () => closeAll(servers) };
}

export function parseHostPort(address: string): { host: string; port: number } | null {
  const m =
    /^\[([0-9a-fA-F:.]+)\]:(\d{1,5})$/.exec(address) ?? /^([^:[\]]+):(\d{1,5})$/.exec(address);
  if (!m?.[1] || !m[2]) return null;
  const port = Number(m[2]);
  return port >= 1 && port <= 65535 ? { host: m[1], port } : null;
}

export interface DialOptions {
  address: string;
  cert: string;
  key: string;
  /** The peer's pinned certificate: the one CA this connection trusts. */
  peerCert: string;
  /** Its CN and SAN: the name the default host check verifies. */
  peerMachineId: string;
  expectKeyRaw: Buffer;
  timeoutMs: number;
}

export function dial(opts: DialOptions): Promise<{ sock: tls.TLSSocket; peerKeyRaw: Buffer }> {
  const target = parseHostPort(opts.address);
  if (target === null) return Promise.reject(new Error('bad_address'));
  return new Promise((resolve, reject) => {
    const sock = tls.connect({
      cert: opts.cert,
      key: opts.key,
      ca: [opts.peerCert],
      servername: opts.peerMachineId,
      host: target.host,
      port: target.port,
      ...TLS13,
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
      if (peer === null || !peer.equals(opts.expectKeyRaw)) {
        sock.destroy();
        reject(new Error('pin_mismatch'));
        return;
      }
      sock.removeAllListeners('error');
      resolve({ sock, peerKeyRaw: peer });
    });
  });
}

/** Plain TCP for a pairing join: the pairing protocol authenticates by fingerprint, not TLS. */
export function dialPairing(address: string, timeoutMs: number): Promise<net.Socket> {
  const target = parseHostPort(address);
  if (target === null) return Promise.reject(new Error('bad_address'));
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: target.host, port: target.port });
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error('timeout'));
    }, timeoutMs);
    sock.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    sock.once('connect', () => {
      clearTimeout(timer);
      sock.pause();
      sock.removeAllListeners('error');
      resolve(sock);
    });
  });
}
