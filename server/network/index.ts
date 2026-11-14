import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { OWN_DEFAULT_CAPABILITIES } from '../../src/contracts/link-protocol';
import type { NetworkState } from '../../src/contracts/network-state';
import type { ServerSettings } from '../../src/contracts/server-protocol';
import { bindableAddresses } from '../../src/network/bind-addresses';
import type { PairingOutcome } from '../../src/network/pairing-protocol';
import { selfSignedCert } from '../../src/network/self-signed-cert';
import { openAuditLog } from './audit-log';
import { handleNetworkCall } from './c2';
import { type Identity, setOwnerKey } from './identity';
import { createLinkManager, type LinkManager } from './link-manager';
import { openLinkStore } from './link-store';
import { type Listener, listen, type NetLog } from './listener';
import { createPairingService, type PairingService } from './pairing-service';

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
}

export interface NetworkService {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** A C2 call for pairing.* / link.*, or null when the method isn't the network's. */
  handle(method: string, params: unknown): Promise<unknown> | null;
  /** Server settings changed: re-bind the listener if its host or port changed. */
  settingsChanged(): Promise<void>;
  state(): NetworkState;
  onRevoked(listener: (machineId: string) => void): () => void;
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
  const changed = (): void => {
    if (emitTimer) return;
    emitTimer = after(() => {
      emitTimer = null;
      deps.emit(state());
    }, EMIT_COALESCE_MS);
  };

  let listener: Listener | null = null;
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
    onFrame: () => undefined,
    changed,
  });

  const ensureListening = (): Promise<string[]> => {
    if (listener) return Promise.resolve(listener.addresses());
    listening ??= (async () => {
      const s = deps.settings();
      const hosts = bindableAddresses((deps.interfaces ?? os.networkInterfaces)(), s.networkBindHost);
      if (hosts.length === 0) throw new Error(`no address to listen on for "${s.networkBindHost}"`);
      listener = await listen({
        hosts,
        port: s.networkPort,
        ...tlsPair,
        classify: (k) =>
          manager.knows(k) ? 'link' : pairing.windowOpen() ? 'pairing' : 'reject',
        onLink: (sock, k) => manager.accept(sock, k),
        onPairing: (sock, k) => pairing.onPairingSocket(sock, k),
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

  const onLinked = (
    outcome: Extract<PairingOutcome, { kind: 'linked' }>,
    dialedAddress: string | null,
  ): void => {
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
    });
    void ensureListening().catch((err: Error) =>
      deps.log.warn('link listener did not start after pairing', { message: err.message }),
    );
  };

  const pairing: PairingService = createPairingService({
    identity: () => identity,
    selfName,
    tls: () => tlsPair,
    ensureListening,
    onLinked,
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
    links: manager.views().map((v) => ({ ...v, trust: 'own' as const, snapshot: null })),
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
      manager.start();
      if (store.links().length > 0) {
        await ensureListening().catch((err: Error) =>
          deps.log.warn('link listener did not start', { message: err.message }),
        );
      }
    },
    async stop() {
      emitTimer?.();
      await manager.stop();
      await closeListener();
    },
    handle: (method, params) =>
      handleNetworkCall(method, params, { pairing, manager, state }),
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
  };
}
