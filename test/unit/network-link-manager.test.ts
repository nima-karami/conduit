import { afterEach, describe, expect, it } from 'vitest';
import type { AuditEvent } from '../../server/network/audit-log';
import { type Identity, loadIdentity } from '../../server/network/identity';
import { createLinkManager, type LinkManager } from '../../server/network/link-manager';
import { openLinkStore } from '../../server/network/link-store';
import { dial, type LinkListener, listenLinks } from '../../server/network/listener';
import {
  LINK_FEATURES,
  LINK_FRAME_MAX_BYTES,
  LINK_PROTOCOL,
  OWN_DEFAULT_CAPABILITIES,
} from '../../src/contracts/link-protocol';
import { encodeFrame, FrameDecoder } from '../../src/network/frame-codec';
import type { LinkRecord } from '../../src/network/link-file';
import { linkIdFor } from '../../src/network/pairing-transcript';
import { selfSignedCert } from '../../src/network/self-signed-cert';

const quiet = { debug: () => undefined, warn: () => undefined, error: () => undefined };
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c();
});

function memIo() {
  const files = new Map<string, string>();
  return {
    read: (p: string) => files.get(p) ?? null,
    write: (p: string, t: string) => {
      files.set(p, t);
    },
    rename: (a: string, b: string) => {
      const t = files.get(a);
      if (t !== undefined) files.set(b, t);
      files.delete(a);
    },
  };
}

function identity(owner?: Identity['ownerKey']): Identity {
  const r = loadIdentity('/net', memIo());
  if (r.kind === 'newer') throw new Error('unexpected');
  return { ...r.identity, ownerKey: owner ?? null };
}

const ownerPub = (id: Identity) =>
  id.ownerKey?.publicKey.export({ type: 'spki', format: 'der' }).toString('base64') ?? '';

interface Node {
  id: Identity;
  cert: string;
  manager: LinkManager;
  /** add() the way the composer does it: store the record, then trust its certificate. */
  link(r: LinkRecord): void;
  ownerKeys: Array<{ publicKey: string; privateKey: string }>;
  listener: LinkListener;
  address: string;
  audit: AuditEvent[];
  changes: number;
}

async function node(id: Identity, name: string, port = 0): Promise<Node> {
  const store = openLinkStore('/net/links.json', { now: Date.now, log: quiet, io: memIo() });
  const cert = selfSignedCert(
    { publicKey: id.serverPublicKey, privateKey: id.serverPrivateKey },
    id.machineId,
  );
  const key = id.serverPrivateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const audit: AuditEvent[] = [];
  const ownerKeys: Array<{ publicKey: string; privateKey: string }> = [];
  const n = { audit, changes: 0, ownerKeys };
  const manager = createLinkManager({
    identity: () => id,
    selfName: () => name,
    tls: () => ({ cert, key }),
    store,
    audit: { record: (e) => audit.push(e) },
    log: quiet,
    now: Date.now,
    rand: () => 0.5,
    after: (fn, ms) => {
      const h = setTimeout(fn, ms);
      return () => clearTimeout(h);
    },
    onFrame: () => undefined,
    changed: () => {
      n.changes += 1;
    },
    dialTimeoutMs: 2_000,
    onOwnerKey: (pair) => {
      n.ownerKeys.push(pair);
      return true;
    },
  });
  const listener = await listenLinks({
    hosts: ['127.0.0.1'],
    port,
    cert,
    key,
    trustedCerts: () => store.trustedCerts(),
    knows: (k) => manager.knows(k),
    onLink: (s, k) => manager.accept(s, k),
    log: quiet,
  });
  cleanup.push(async () => {
    await manager.stop();
    await listener.close();
  });
  const link = (r: LinkRecord) => {
    manager.add(r);
    listener.refreshTrust();
  };
  return Object.assign(n, {
    id,
    cert,
    manager,
    link,
    listener,
    address: listener.addresses()[0] ?? '',
  });
}

function record(of: Node, name: string, overrides: Partial<LinkRecord> = {}): LinkRecord {
  return {
    linkId: linkIdFor(of.id.serverKeyRaw, Buffer.alloc(32, 1)),
    machineId: of.id.machineId,
    serverKey: of.id.serverKeyRaw.toString('base64'),
    ownerKey: ownerPub(of.id),
    name,
    trust: 'own',
    addresses: [of.address],
    capabilities: { ...OWN_DEFAULT_CAPABILITIES },
    fingerprint: 'ABCD-1234',
    createdAt: new Date().toISOString(),
    cert: of.cert,
    ownerTransfer: null,
    ...overrides,
  };
}

// Generous: the full unit run loads the machine, and these wait on real sockets.
async function until(check: () => boolean, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function linkedPair() {
  // Any Ed25519 pair serves as the shared owner key in these tests.
  const owner = identity();
  const ownerKey = { publicKey: owner.serverPublicKey, privateKey: owner.serverPrivateKey };
  const a = await node(identity(ownerKey), 'linux-box');
  const b = await node(identity(ownerKey), 'win-box');
  a.link(record(b, 'win-box'));
  b.link(record(a, 'linux-box'));
  a.manager.start();
  b.manager.start();
  const state = (n: Node, of: Node) => n.manager.view(of.id.machineId)?.state;
  await until(() => state(a, b) === 'up' && state(b, a) === 'up');
  return { a, b, state };
}

describe('link manager', { timeout: 60_000 }, () => {
  it('two linked servers come up, each seeing the other name and capabilities', async () => {
    const { a, b } = await linkedPair();
    const view = a.manager.view(b.id.machineId);
    expect(view?.name).toBe('win-box');
    expect(view?.peerCapabilities).toEqual(OWN_DEFAULT_CAPABILITIES);
    expect(view?.unsupported).toEqual([]);
  });

  it('a capability change reaches the peer', async () => {
    const { a, b } = await linkedPair();
    expect(b.manager.setCapability(a.id.machineId, 'drive', true)).toBe(true);
    await until(() => a.manager.view(b.id.machineId)?.peerCapabilities?.drive === true);
    expect(b.audit.some((e) => e.kind === 'link.capability')).toBe(true);
  });

  it('a peer enabling drive on its side never enables drive on mine', async () => {
    const { a, b } = await linkedPair();
    expect(a.manager.setCapability(b.id.machineId, 'drive', true)).toBe(true);
    await until(() => b.manager.view(a.id.machineId)?.peerCapabilities?.drive === true);
    expect(b.manager.view(a.id.machineId)?.capabilities.drive).toBe(false);
  });

  it('a capability change made after its hello went out still reaches the peer', async () => {
    const owner = identity();
    const ownerKey = { publicKey: owner.serverPublicKey, privateKey: owner.serverPrivateKey };
    const a = await node(identity(ownerKey), 'linux-box');
    const b = await node(identity(ownerKey), 'win-box');
    // B never dials; A's side is driven by hand so the change lands mid-handshake.
    b.link(record(a, 'linux-box', { addresses: [] }));
    b.manager.start();
    const { sock } = await dial({
      address: b.address,
      cert: a.cert,
      key: a.id.serverPrivateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      peerCert: b.cert,
      peerMachineId: b.id.machineId,
      expectKeyRaw: b.id.serverKeyRaw,
      timeoutMs: 5000,
    });
    cleanup.push(async () => {
      sock.destroy();
    });
    const frames: Array<{ t: string; capabilities?: { drive: boolean } }> = [];
    const decoder = new FrameDecoder(LINK_FRAME_MAX_BYTES);
    sock.on('data', (d: Buffer) => {
      frames.push(...(decoder.push(d).frames as typeof frames));
    });
    sock.resume();
    await until(() => frames.some((f) => f.t === 'hello'));
    expect(frames.find((f) => f.t === 'hello')?.capabilities?.drive).toBe(false);
    expect(b.manager.setCapability(a.id.machineId, 'drive', true)).toBe(true);
    sock.write(
      encodeFrame({
        t: 'hello',
        protocol: { major: LINK_PROTOCOL.major, minor: LINK_PROTOCOL.minor },
        machineId: a.id.machineId,
        serverKey: a.id.serverKeyRaw.toString('base64'),
        ownerKey: ownerPub(a.id),
        selfName: 'linux-box',
        features: [...LINK_FEATURES],
        capabilities: { ...OWN_DEFAULT_CAPABILITIES },
      }),
    );
    await until(() => frames.some((f) => f.t === 'caps' && f.capabilities?.drive === true), 4000);
  });

  it('a stopped peer goes down, and a new address brings it back up', async () => {
    const { a, b, state } = await linkedPair();
    await b.manager.stop();
    await b.listener.close();
    await until(() => state(a, b) === 'down' || state(a, b) === 'connecting');
    const b2 = await node(b.id, 'win-box');
    b2.link(record(a, 'linux-box'));
    b2.manager.start();
    a.manager.setAddresses(b.id.machineId, [b2.address]);
    await until(() => state(a, b) === 'up');
  });

  it('revoke stops the link on both sides and a later dial only learns it was revoked', async () => {
    const { a, b, state } = await linkedPair();
    expect(a.manager.revoke(b.id.machineId)).toBe(true);
    expect(state(a, b)).toBe('revoked');
    await until(() => state(b, a) === 'revoked');
    expect(b.manager.view(a.id.machineId)?.revokedBy).toBe('peer');
    expect(a.manager.view(b.id.machineId)?.revokedBy).toBe('me');
    expect(a.audit.some((e) => e.kind === 'link.revoked')).toBe(true);
    // A's tombstone still lets B's key finish TLS, but only to hear it was revoked.
    expect(a.manager.knows(b.id.serverKeyRaw)).toBe(true);
    const b2 = await node(b.id, 'win-box');
    b2.link(record(a, 'linux-box'));
    b2.manager.start();
    await until(() => b2.manager.view(a.id.machineId)?.state === 'revoked');
    expect(b2.manager.view(a.id.machineId)?.revokedBy).toBe('peer');
  });

  it('the owner private key crosses the first link once, and both sides clear the transfer', async () => {
    const owner = identity();
    const ownerKey = { publicKey: owner.serverPublicKey, privateKey: owner.serverPrivateKey };
    const a = await node(identity(ownerKey), 'linux-box');
    const b = await node(identity(), 'win-box');
    const ownerPublic = ownerPub(a.id);
    a.link(record(b, 'win-box', { ownerKey: ownerPublic, ownerTransfer: 'send' }));
    b.link(record(a, 'linux-box', { ownerKey: ownerPublic, ownerTransfer: 'receive' }));
    a.manager.start();
    b.manager.start();
    await until(() => b.ownerKeys.length === 1);
    expect(b.ownerKeys[0]?.publicKey).toBe(ownerPublic);
    expect(a.manager.view(b.id.machineId)?.state).toBe('up');
  });

  it('a hello name longer than pairing allows is not stored, and the link still comes up', async () => {
    const owner = identity();
    const ownerKey = { publicKey: owner.serverPublicKey, privateKey: owner.serverPrivateKey };
    const a = await node(identity(ownerKey), 'linux-box');
    const b = await node(identity(ownerKey), 'x'.repeat(65));
    a.link(record(b, 'win-box'));
    b.link(record(a, 'linux-box'));
    a.manager.start();
    b.manager.start();
    await until(() => a.manager.view(b.id.machineId)?.state === 'up');
    expect(a.manager.view(b.id.machineId)?.name).toBe('win-box');
  });

  it('a peer whose owner key changed is identity-changed and never up', async () => {
    const owner = identity();
    const ownerKey = { publicKey: owner.serverPublicKey, privateKey: owner.serverPrivateKey };
    const a = await node(identity(ownerKey), 'linux-box');
    const b = await node(identity(ownerKey), 'win-box');
    a.link(record(b, 'win-box', { ownerKey: 'stale-owner-key' }));
    b.link(record(a, 'linux-box'));
    a.manager.start();
    b.manager.start();
    await until(() => a.manager.view(b.id.machineId)?.state === 'identity-changed');
    expect(a.manager.send(b.id.machineId, { t: 'revoked' })).toBeNull();
  });
});
