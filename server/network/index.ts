import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type { McpNetworkPort, NetworkPort } from '../../src/conduit-mcp/remote-routing';
import {
  type Capabilities,
  type LinkState,
  OWN_DEFAULT_CAPABILITIES,
} from '../../src/contracts/link-protocol';
import type { NetworkState } from '../../src/contracts/network-state';
import type { ServerEventSink } from '../../src/contracts/server-ports';
import type { ServerSettings } from '../../src/contracts/server-protocol';
import type { TerminalRuntime } from '../../src/contracts/terminal-runtime';
import { bindableAddresses } from '../../src/network/bind-addresses';
import type { PairingOutcome } from '../../src/network/pairing-protocol';
import { createRemoteDirectory } from '../../src/network/remote-directory';
import { selfSignedCert } from '../../src/network/self-signed-cert';
import { currentWindowsPty } from '../../src/windows-pty-info';
import { openAuditLog } from './audit-log';
import { handleNetworkCall } from './c2';
import { createDrive, type Drive, type DriveDeps } from './drive';
import { adoptOwnerKey, type Identity, setOwnerKey } from './identity';
import { createLinkManager, type LinkManager } from './link-manager';
import { openLinkStore } from './link-store';
import { type LinkListener, listenLinks, listenPairing, type NetLog } from './listener';
import { createMessaging } from './messaging';
import { createMonitorPublisher, type MonitorSource } from './monitor-publisher';
import { createPairingPort } from './pairing-port';
import { createPairingService, type PairingService } from './pairing-service';
import { createSnapshotCoalescer } from './snapshot-coalescer';
import { createViewRelay } from './view-relay';

// The one composer for linked machines (plan "Technical decisions" 1): services.ts only builds,
// starts, stops and routes C2 calls here.

type NetworkSettings = Pick<ServerSettings, 'networkBindHost' | 'networkPort' | 'networkSelfName'>;

export interface NetworkDeps {
  /** <userData>/network */
  dir: string;
  identity: Identity;
  settings(): NetworkSettings;
  emit(state: NetworkState): void;
  log: NetLog & { error(msg: string, data?: Record<string, unknown>): void };
  now?: () => number;
  interfaces?: () => NodeJS.Dict<os.NetworkInterfaceInfo[]>;
  hostname?: () => string;
  /** This server's sessions, asks and agents as linked peers may see them (monitor push). */
  monitor: MonitorSource;
  observe: TerminalRuntime['observe'];
  /** The server's side of drive: the human input path, sessions and folders. */
  drive: Pick<
    DriveDeps,
    | 'applyHumanInput'
    | 'resize'
    | 'liveSession'
    | 'agentExists'
    | 'isDirectory'
    | 'openSession'
    | 'closeSession'
  >;
  emitTo(peer: object, ...event: Parameters<ServerEventSink>): void;
}

export interface NetworkService {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** A C2 call for pairing.* / link.*, or null when the method isn't the network's. */
  handle(method: string, params: unknown, peer?: object): Promise<unknown> | null;
  disconnected(peer: object): void;
  /** Server settings changed: re-bind the listener if its host or port changed. */
  settingsChanged(): Promise<void>;
  state(): NetworkState;
  onRevoked(listener: (machineId: string) => void): () => void;
  /** What the MCP host reads: remote sessions, address resolution, the outbox. */
  port(): NetworkPort;
  /** The MCP host's side, set once it exists (the host is built after the network). */
  setMcp(port: McpNetworkPort): void;
  /** Something local a peer may see changed: sessions, asks, unread, presence. */
  localChanged(): void;
}

const EMIT_COALESCE_MS = 50;

export function createNetwork(deps: NetworkDeps): NetworkService {
  const now = deps.now ?? Date.now;
  let identity = deps.identity;
  const cert = () =>
    selfSignedCert(
      { publicKey: identity.serverPublicKey, privateKey: identity.serverPrivateKey },
      identity.machineId,
    );
  const tlsPair = {
    cert: cert(),
    key: identity.serverPrivateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
  const selfName = () => deps.settings().networkSelfName || (deps.hostname ?? os.hostname)();
  const after = (fn: () => void, ms: number) => {
    const h = setTimeout(fn, ms);
    h.unref();
    return () => clearTimeout(h);
  };
  const store = openLinkStore(path.join(deps.dir, 'links.json'), { now, log: deps.log });
  const audit = openAuditLog(path.join(deps.dir, 'audit.jsonl'), {
    now,
    onError: (err) => deps.log.error('network audit write failed', { message: err.message }),
  });

  let emitTimer: (() => void) | null = null;
  let mcp: McpNetworkPort | null = null;
  const portListeners = new Set<() => void>();
  const directory = createRemoteDirectory();
  /** The last state each link was seen in, to act once on up and down. */
  const seen = new Map<string, LinkState>();
  /** My capabilities per link as last seen, to push a fresh snapshot when they change. */
  const capsSeen = new Map<string, string>();
  const live = (st: LinkState | undefined) => st === 'up' || st === 'degraded';
  const capsKey = (c: Capabilities): string => `${c.messaging}/${c.monitor}/${c.drive}`;

  // Runs on every link change, synchronously, so remote rows and the outbox follow at once;
  // only the C2 broadcast below is coalesced.
  const onLinksChanged = (): void => {
    const views = manager.views();
    directory.setLinks(
      views.map((v) => ({
        machineId: v.machineId,
        name: v.name,
        state: v.state,
        peerCapabilities: v.peerCapabilities,
      })),
      selfName(),
    );
    for (const v of views) {
      const before = seen.get(v.machineId);
      seen.set(v.machineId, v.state);
      const capsBefore = capsSeen.get(v.machineId);
      const capsNow = capsKey(v.capabilities);
      capsSeen.set(v.machineId, capsNow);
      if (live(v.state) && !live(before)) {
        messaging.linkUp(v.machineId);
        publisher.pushTo(v.machineId);
      } else if (!live(v.state) && live(before)) messaging.linkDown(v.machineId);
      // What the peer sees depends on these, so a change is pushed at once, not only on up.
      else if (live(v.state) && capsBefore !== undefined && capsBefore !== capsNow)
        publisher.pushTo(v.machineId);
      relay.linkChanged(v.machineId);
      drive.linkChanged(v.machineId);
    }
    for (const l of portListeners) l();
  };

  const changed = (): void => {
    onLinksChanged();
    if (emitTimer) return;
    emitTimer = after(() => {
      emitTimer = null;
      deps.emit(state());
    }, EMIT_COALESCE_MS);
  };

  // A peer's snapshots are applied at most once per window, so a burst costs one recompute.
  const snapshots = createSnapshotCoalescer({
    now,
    after,
    apply: (machineId, snapshot) => {
      directory.apply(machineId, snapshot);
      for (const l of portListeners) l();
      changed();
    },
  });

  let listener: LinkListener | null = null;
  let bound: { host: string; port: number } | null = null;
  let listening: Promise<string[]> | null = null;

  const manager: LinkManager = createLinkManager({
    identity: () => identity,
    selfName,
    tls: () => tlsPair,
    store,
    audit,
    log: deps.log,
    now,
    rand: Math.random,
    after,
    onFrame: (machineId, f) => {
      if (f.t === 'snapshot') snapshots.offer(machineId, f.snapshot);
      else if (f.t === 'msg' || f.t === 'ack' || f.t === 'receipt') messaging.onFrame(machineId, f);
      else if (
        f.t === 'drive.input' ||
        f.t === 'drive.resize' ||
        f.t === 'drive.open' ||
        f.t === 'drive.close' ||
        f.t === 'drive.result'
      )
        void drive
          .onFrame(machineId, f)
          .catch((err: unknown) => deps.log.error('drive frame failed', { message: String(err) }));
      else if (
        f.t === 'view.open' ||
        f.t === 'view.opened' ||
        f.t === 'view.data' ||
        f.t === 'view.size' ||
        f.t === 'view.end' ||
        f.t === 'view.close'
      )
        void relay
          .onFrame(machineId, f)
          .catch((err: unknown) => deps.log.error('view frame failed', { message: String(err) }));
    },
    changed,
    onOwnerKey: (pair) => onOwnerKey(pair),
  });

  const linkInfo = () =>
    manager.views().map((v) => ({
      machineId: v.machineId,
      state: v.state,
      capabilities: v.capabilities,
      peerCapabilities: v.peerCapabilities,
    }));
  const relay = createViewRelay({
    links: linkInfo,
    sessions: deps.monitor.sessions,
    observe: deps.observe,
    windowsPty: () => currentWindowsPty() ?? null,
    send: (machineId, frame) => manager.send(machineId, frame),
    emitTo: deps.emitTo,
    now,
    newId: () => `v_${randomBytes(16).toString('hex')}`,
    log: (message) => deps.log.warn(message),
  });
  const drive: Drive = createDrive({
    ...deps.drive,
    links: linkInfo,
    send: (machineId, frame) => manager.send(machineId, frame),
    audit,
    now,
    newId: () => `d_${randomBytes(12).toString('hex')}`,
    after,
    log: (message) => deps.log.warn(message),
  });
  const messaging = createMessaging({
    file: path.join(deps.dir, 'outbox.json'),
    machineId: () => identity.machineId,
    links: linkInfo,
    send: (machineId, frame) => manager.send(machineId, frame),
    mcp: () => mcp,
    audit,
    log: deps.log,
    now,
    after,
  });
  const publisher = createMonitorPublisher({
    source: deps.monitor,
    links: linkInfo,
    send: (machineId, frame) => manager.send(machineId, frame),
    after,
  });
  manager.onRevoked((machineId) => messaging.revoked(machineId));

  const networkPort: NetworkPort = {
    remoteEntries: () => directory.entries(),
    resolve: (target) => directory.resolve(target),
    enqueue: (msg, recipients) => messaging.enqueue(msg, recipients),
    waitReading: (address, caller) => directory.waitReading(address, caller),
    peerCapabilitiesOf: (machineId) => {
      const v = manager.view(machineId);
      return v &&
        v.state !== 'revoked' &&
        v.state !== 'incompatible' &&
        v.state !== 'identity-changed'
        ? v.peerCapabilities
          ? { ...v.peerCapabilities }
          : null
        : null;
    },
    onChange(listener) {
      portListeners.add(listener);
      return () => portListeners.delete(listener);
    },
  };

  const hosts = (): string[] => {
    const s = deps.settings();
    const found = bindableAddresses((deps.interfaces ?? os.networkInterfaces)(), s.networkBindHost);
    if (found.length === 0) throw new Error(`no address to listen on for "${s.networkBindHost}"`);
    return found;
  };

  const ensureListening = (): Promise<string[]> => {
    if (listener) return Promise.resolve(listener.addresses());
    listening ??= (async () => {
      const s = deps.settings();
      listener = await listenLinks({
        hosts: hosts(),
        port: s.networkPort,
        ...tlsPair,
        trustedCerts: () => store.trustedCerts(),
        knows: (k) => manager.knows(k),
        onLink: (sock, k) => manager.accept(sock, k),
        log: deps.log,
      });
      bound = { host: s.networkBindHost, port: s.networkPort };
      changed();
      return listener.addresses();
    })().finally(() => {
      listening = null;
    });
    return listening;
  };

  // The pairing port sits next to the link port; an ephemeral link port (tests) gets one too.
  const pairingPort = createPairingPort(() => {
    const s = deps.settings();
    return listenPairing({
      hosts: hosts(),
      port: s.networkPort === 0 ? 0 : s.networkPort + 1,
      onPairing: (sock) => pairing.onPairingSocket(sock),
      log: deps.log,
    });
  });
  const openPairingPort = (): Promise<string[]> => pairingPort.open();
  const closePairingPort = (): void => pairingPort.close();

  const onOwnerKey = (pair: { publicKey: string; privateKey: string }): boolean => {
    try {
      const next = adoptOwnerKey(deps.dir, identity, pair);
      if (next === null) {
        deps.log.warn('owner key refused');
        return false;
      }
      identity = next;
      return true;
    } catch (err) {
      deps.log.warn('owner key refused', {
        message: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  };

  const onLinked = (
    outcome: Extract<PairingOutcome, { kind: 'linked' }>,
    dialedAddress: string | null,
  ): boolean => {
    if (outcome.ownerKeyToStore) {
      identity = setOwnerKey(deps.dir, identity, {
        publicKey: createPublicKey({
          key: Buffer.from(outcome.ownerKeyToStore.publicKey, 'base64'),
          format: 'der',
          type: 'spki',
        }),
        privateKey: createPrivateKey({
          key: Buffer.from(outcome.ownerKeyToStore.privateKey, 'base64'),
          format: 'der',
          type: 'pkcs8',
        }),
      });
    }
    const addresses = [
      ...new Set([...(dialedAddress ? [dialedAddress] : []), ...outcome.peer.addresses]),
    ];
    manager.add({
      linkId: outcome.linkId,
      machineId: outcome.peer.machineId,
      serverKey: outcome.peer.serverKey,
      ownerKey: outcome.peer.ownerKey,
      name: outcome.peer.selfName,
      trust: 'own',
      addresses,
      capabilities: { ...OWN_DEFAULT_CAPABILITIES },
      fingerprint: outcome.fingerprint,
      createdAt: new Date(now()).toISOString(),
      cert: outcome.peer.cert,
      ownerTransfer: outcome.ownerTransfer,
    });
    listener?.refreshTrust();
    void ensureListening().catch((err: Error) =>
      deps.log.warn('link listener did not start after pairing', { message: err.message }),
    );
    return true;
  };

  const pairing: PairingService = createPairingService({
    identity: () => identity,
    selfName,
    cert: () => tlsPair.cert,
    linkAddresses: ensureListening,
    openPairingPort,
    closePairingPort,
    onLinked,
    ownerPending: () => false,
    generateOwnerKey: () => {
      const k = generateKeyPairSync('ed25519');
      return {
        publicKey: k.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
        privateKey: k.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
      };
    },
    audit,
    changed,
    now,
    rand: (n) => randomBytes(n),
    after,
    newId: () => `p_${randomBytes(8).toString('hex')}`,
  });

  const state = (): NetworkState => ({
    machineId: identity.machineId,
    selfName: selfName(),
    listening: listener?.addresses() ?? [],
    links: manager
      .views()
      .map((v) => ({ ...v, trust: 'own' as const, snapshot: directory.snapshotOf(v.machineId) })),
    pairing: pairing.view(),
  });

  const closeListener = async (): Promise<void> => {
    const l = listener;
    listener = null;
    bound = null;
    await l?.close();
  };

  return {
    async start() {
      messaging.start();
      manager.start();
      if (store.links().length > 0) {
        await ensureListening().catch((err: Error) =>
          deps.log.warn('link listener did not start', { message: err.message }),
        );
      }
    },
    async stop() {
      emitTimer?.();
      snapshots.stop();
      closePairingPort();
      relay.stop();
      drive.stop();
      publisher.stop();
      messaging.stop();
      await manager.stop();
      await closeListener();
    },
    handle: (method, params, peer) =>
      handleNetworkCall(method, params, { pairing, manager, state, relay, drive, peer }),
    disconnected: (peer) => relay.disconnected(peer),
    async settingsChanged() {
      const s = deps.settings();
      if (bound && (bound.host !== s.networkBindHost || bound.port !== s.networkPort)) {
        await closeListener();
        await ensureListening().catch((err: Error) =>
          deps.log.warn('link listener did not restart', { message: err.message }),
        );
      }
      changed();
    },
    state,
    onRevoked: (l) => manager.onRevoked(l),
    port: () => networkPort,
    setMcp(port) {
      mcp = port;
    },
    localChanged: () => publisher.changed(),
  };
}
