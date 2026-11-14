import type tls from 'node:tls';
import {
  type Capabilities,
  type Capability,
  type HelloFrame,
  LINK_FEATURES,
  LINK_PING_MS,
  LINK_PROTOCOL,
  type LinkFrame,
  type LinkState,
} from '../../src/contracts/link-protocol';
import type { NetworkLinkView } from '../../src/contracts/network-state';
import type { LinkRecord } from '../../src/network/link-file';
import {
  backoffMs,
  initialLinkState,
  keepConnection,
  type LinkStateMachine,
  linkEvent,
} from '../../src/network/link-state';
import type { AuditSink } from './audit-log';
import type { Identity } from './identity';
import { type ConnectionError, type LinkConnection, openConnection } from './link-connection';
import type { LinkStore } from './link-store';
import { dial, type NetLog } from './listener';

// Owns every linked peer's connection and state (plan decisions 6 and 11). The socket a link gets
// is already pinned to the stored server key by the listener or by dial; the hello check below adds
// the owner key and machine id, so a peer whose identity changed never gets a frame through.

export type LinkView = Omit<NetworkLinkView, 'trust' | 'snapshot'>;

export interface LinkManagerDeps {
  identity(): Identity;
  selfName(): string;
  tls(): { cert: string; key: string };
  store: LinkStore;
  audit: AuditSink;
  log: NetLog;
  now(): number;
  rand(): number;
  /** Runs fn after ms; returns its cancel. */
  after(fn: () => void, ms: number): () => void;
  /** Every frame that isn't link control: messages, snapshots, views, drive. */
  onFrame(machineId: string, frame: LinkFrame): void;
  /** Fired on any change a view would show. */
  changed(): void;
  dialTimeoutMs?: number;
  pingMs?: number;
}

export interface LinkManager {
  start(): void;
  stop(): Promise<void>;
  /** The listener's question for a pinned key: a live link or a recent tombstone, else unknown. */
  knows(peerKeyRaw: Buffer): boolean;
  accept(sock: tls.TLSSocket, peerKeyRaw: Buffer): void;
  add(record: LinkRecord): void;
  revoke(machineId: string): boolean;
  setCapability(machineId: string, capability: Capability, on: boolean): boolean;
  setAddresses(machineId: string, addresses: string[]): boolean;
  /** Null when the link isn't up; otherwise whether the socket still has room. */
  send(machineId: string, frame: LinkFrame): boolean | null;
  views(): LinkView[];
  view(machineId: string): LinkView | null;
  onRevoked(listener: (machineId: string) => void): () => void;
}

interface Peer {
  record: LinkRecord;
  sm: LinkStateMachine;
  conn: LinkConnection | null;
  dialer: string | null;
  attempt: number;
  cancelRetry: (() => void) | null;
  dialing: boolean;
  peerHello: HelloFrame | null;
  revokedBy: 'me' | 'peer' | null;
  lastActivity: number | null;
}

const TERMINAL: readonly LinkState[] = ['revoked', 'incompatible', 'identity-changed'];
const b64 = (b: Buffer): string => b.toString('base64');

export function createLinkManager(deps: LinkManagerDeps): LinkManager {
  const peers = new Map<string, Peer>();
  const revokedListeners = new Set<(machineId: string) => void>();
  let stopped = true;
  let cancelTicker: (() => void) | null = null;

  const iso = (t: number) => new Date(t).toISOString();
  const event = (p: Peer, e: Parameters<typeof linkEvent>[1]): void => {
    const before = p.sm.state;
    p.sm = linkEvent(p.sm, e);
    if (p.sm.state !== before) {
      if (p.sm.state === 'down' || before === 'down' || TERMINAL.includes(p.sm.state)) {
        deps.audit.record({
          kind: 'link.state',
          peer: p.record.machineId,
          detail: { from: before, to: p.sm.state },
        });
      }
      deps.changed();
    }
  };

  const ownHello = (capabilities: Capabilities): HelloFrame => {
    const id = deps.identity();
    return {
      t: 'hello',
      protocol: { major: LINK_PROTOCOL.major, minor: LINK_PROTOCOL.minor },
      machineId: id.machineId,
      serverKey: b64(id.serverKeyRaw),
      ownerKey:
        id.ownerKey?.publicKey.export({ type: 'spki', format: 'der' }).toString('base64') ?? null,
      selfName: deps.selfName(),
      features: [...LINK_FEATURES],
      capabilities: { ...capabilities },
    };
  };

  const peerOf = (machineId: string) => peers.get(machineId) ?? null;
  const ensurePeer = (record: LinkRecord): Peer => {
    const existing = peers.get(record.machineId);
    if (existing) {
      existing.record = record;
      return existing;
    }
    const p: Peer = {
      record,
      sm: initialLinkState(deps.now()),
      conn: null,
      dialer: null,
      attempt: 0,
      cancelRetry: null,
      dialing: false,
      peerHello: null,
      revokedBy: null,
      lastActivity: null,
    };
    peers.set(record.machineId, p);
    return p;
  };

  const terminal = (p: Peer) => TERMINAL.includes(p.sm.state);

  const scheduleDial = (p: Peer, immediately: boolean): void => {
    if (stopped || terminal(p) || p.conn || p.dialing) return;
    p.cancelRetry?.();
    const delay = immediately ? 0 : backoffMs(p.attempt, deps.rand);
    p.cancelRetry = deps.after(() => {
      p.cancelRetry = null;
      void dialPeer(p);
    }, delay);
  };

  const dialPeer = async (p: Peer): Promise<void> => {
    if (stopped || terminal(p) || p.conn || p.dialing) return;
    p.dialing = true;
    event(p, { kind: 'dial', at: deps.now() });
    const expect = Buffer.from(p.record.serverKey, 'base64');
    let sock: tls.TLSSocket | null = null;
    for (const address of p.record.addresses) {
      try {
        sock = (
          await dial({
            address,
            ...deps.tls(),
            expectKeyRaw: expect,
            timeoutMs: deps.dialTimeoutMs ?? 5_000,
          })
        ).sock;
        break;
      } catch (err) {
        deps.log.debug('link: dial failed', {
          peer: p.record.machineId,
          address,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
    p.dialing = false;
    if (sock === null) {
      if (!terminal(p) && !p.conn) event(p, { kind: 'closed', at: deps.now() });
      p.attempt += 1;
      scheduleDial(p, false);
      return;
    }
    await adopt(p, sock, deps.identity().machineId);
  };

  /** Hello exchange, identity check and duplicate resolution for a fresh pinned socket. */
  const adopt = async (p: Peer, sock: tls.TLSSocket, dialer: string): Promise<void> => {
    if (stopped || terminal(p)) {
      sock.destroy();
      return;
    }
    let conn: LinkConnection | null = null;
    const opened = await openConnection(sock, {
      hello: ownHello(p.record.capabilities),
      onFrame: (f) => onFrame(p, conn, f),
      onClose: () => onClose(p, conn),
      now: deps.now,
      log: deps.log,
      pingMs: deps.pingMs,
    });
    if ('error' in opened) {
      failed(p, opened.error);
      return;
    }
    conn = opened;
    const hello = opened.peerHello;
    if (
      hello.machineId !== p.record.machineId ||
      hello.serverKey !== p.record.serverKey ||
      hello.ownerKey !== p.record.ownerKey
    ) {
      opened.close('identity-changed');
      event(p, { kind: 'identity-changed', at: deps.now() });
      return;
    }
    if (p.conn) {
      const keep = keepConnection({ dialerMachineId: p.dialer ?? '' }, { dialerMachineId: dialer });
      if (keep === 'a') {
        opened.send({ t: 'bye', reason: 'duplicate' });
        opened.close('duplicate');
        return;
      }
      const old = p.conn;
      p.conn = null;
      old.send({ t: 'bye', reason: 'duplicate' });
      old.close('duplicate');
    }
    p.cancelRetry?.();
    p.cancelRetry = null;
    p.conn = opened;
    p.dialer = dialer;
    p.attempt = 0;
    p.peerHello = hello;
    p.lastActivity = deps.now();
    if (hello.selfName.trim() !== '' && hello.selfName !== p.record.name) {
      p.record = deps.store.update(p.record.machineId, { name: hello.selfName }) ?? p.record;
    }
    event(p, { kind: 'up', at: deps.now() });
    deps.changed();
  };

  const failed = (p: Peer, error: ConnectionError): void => {
    if (error === 'incompatible') {
      event(p, { kind: 'incompatible', at: deps.now() });
      return;
    }
    if (!p.conn) {
      event(p, { kind: 'closed', at: deps.now() });
      p.attempt += 1;
      scheduleDial(p, false);
    }
  };

  const onFrame = (p: Peer, conn: LinkConnection | null, f: LinkFrame): void => {
    // Frames from a connection that lost a duplicate race, or arrive after revoke, are dropped.
    if (conn === null || p.conn !== conn || terminal(p)) return;
    p.lastActivity = deps.now();
    if (p.sm.state === 'degraded') event(p, { kind: 'frame', at: deps.now() });
    switch (f.t) {
      case 'caps':
        if (p.peerHello) p.peerHello = { ...p.peerHello, capabilities: f.capabilities };
        deps.changed();
        return;
      case 'revoked':
        revokedByPeer(p);
        return;
      case 'bye':
        if (f.reason === 'revoked') revokedByPeer(p);
        else conn.close(f.reason);
        return;
      case 'hello':
        return;
      default:
        deps.onFrame(p.record.machineId, f);
    }
  };

  const onClose = (p: Peer, conn: LinkConnection | null): void => {
    if (conn === null || p.conn !== conn) return;
    p.conn = null;
    p.dialer = null;
    if (terminal(p)) return;
    event(p, { kind: 'closed', at: deps.now() });
    scheduleDial(p, false);
  };

  const revokedByPeer = (p: Peer): void => {
    p.revokedBy = 'peer';
    finishRevoke(p);
  };

  const finishRevoke = (p: Peer): void => {
    p.cancelRetry?.();
    p.cancelRetry = null;
    const conn = p.conn;
    p.conn = null;
    conn?.close('revoked');
    deps.store.revoke(p.record.machineId, deps.now());
    event(p, { kind: 'revoked', at: deps.now() });
    deps.audit.record({
      kind: 'link.revoked',
      peer: p.record.machineId,
      detail: { by: p.revokedBy ?? 'me' },
    });
    for (const l of revokedListeners) l(p.record.machineId);
  };

  const tick = (): void => {
    for (const p of peers.values()) {
      if (p.conn && !terminal(p)) {
        event(p, { kind: 'silence', at: deps.now(), silentMs: p.conn.silentMs() });
      }
    }
  };

  const viewOf = (p: Peer): LinkView => {
    const peerFeatures = p.peerHello?.features ?? null;
    return {
      machineId: p.record.machineId,
      name: p.record.name,
      state: p.sm.state,
      since: iso(p.sm.since),
      revokedBy: p.revokedBy,
      addresses: [...p.record.addresses],
      capabilities: { ...p.record.capabilities },
      peerCapabilities: p.peerHello ? { ...p.peerHello.capabilities } : null,
      unsupported:
        peerFeatures === null ? [] : LINK_FEATURES.filter((f) => !peerFeatures.includes(f)),
      fingerprint: p.record.fingerprint,
      lastActivity: p.lastActivity === null ? null : iso(p.lastActivity),
    };
  };

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      for (const record of deps.store.links()) scheduleDial(ensurePeer(record), true);
      const every = deps.pingMs ?? LINK_PING_MS;
      const loop = (): void => {
        tick();
        cancelTicker = deps.after(loop, every);
      };
      cancelTicker = deps.after(loop, every);
    },
    async stop() {
      stopped = true;
      cancelTicker?.();
      cancelTicker = null;
      for (const p of peers.values()) {
        p.cancelRetry?.();
        p.cancelRetry = null;
        const conn = p.conn;
        p.conn = null;
        if (conn) {
          conn.send({ t: 'bye', reason: 'shutdown' });
          conn.close('shutdown');
        }
      }
    },
    knows(peerKeyRaw) {
      return deps.store.byServerKey(b64(peerKeyRaw)) !== null;
    },
    accept(sock, peerKeyRaw) {
      const found = deps.store.byServerKey(b64(peerKeyRaw));
      if (found === null) {
        sock.destroy();
        return;
      }
      if ('tombstone' in found) {
        // A revoked peer only ever learns that it was revoked; no other frame is read or sent.
        const machineId = found.tombstone.machineId;
        void openConnection(sock, {
          hello: ownHello({ messaging: false, monitor: false, drive: false }),
          onFrame: () => undefined,
          onClose: () => undefined,
          now: deps.now,
          log: deps.log,
        }).then((c) => {
          if ('error' in c) return;
          c.send({ t: 'revoked' });
          c.close('revoked');
          deps.log.debug('link: told a revoked peer', { peer: machineId });
        });
        return;
      }
      void adopt(ensurePeer(found), sock, found.machineId);
    },
    add(record) {
      deps.store.put(record);
      const p = ensurePeer(record);
      p.revokedBy = null;
      if (terminal(p)) p.sm = initialLinkState(deps.now());
      deps.changed();
      scheduleDial(p, true);
    },
    revoke(machineId) {
      const p = peerOf(machineId);
      if (!p || p.sm.state === 'revoked') return false;
      p.revokedBy = 'me';
      p.conn?.send({ t: 'revoked' });
      finishRevoke(p);
      return true;
    },
    setCapability(machineId, capability, on) {
      const p = peerOf(machineId);
      if (!p || terminal(p)) return false;
      const capabilities = { ...p.record.capabilities, [capability]: on };
      p.record = deps.store.update(machineId, { capabilities }) ?? p.record;
      p.conn?.send({ t: 'caps', capabilities });
      deps.audit.record({ kind: 'link.capability', peer: machineId, detail: { capability, on } });
      deps.changed();
      return true;
    },
    setAddresses(machineId, addresses) {
      const p = peerOf(machineId);
      if (!p || terminal(p)) return false;
      p.record = deps.store.update(machineId, { addresses }) ?? p.record;
      deps.changed();
      if (!p.conn) {
        p.attempt = 0;
        scheduleDial(p, true);
      }
      return true;
    },
    send(machineId, frame) {
      const p = peerOf(machineId);
      if (!p?.conn || terminal(p)) return null;
      return p.conn.send(frame);
    },
    views: () => [...peers.values()].map(viewOf),
    view: (machineId) => {
      const p = peerOf(machineId);
      return p ? viewOf(p) : null;
    },
    onRevoked(listener) {
      revokedListeners.add(listener);
      return () => revokedListeners.delete(listener);
    },
  };
}
