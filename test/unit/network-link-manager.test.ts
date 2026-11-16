import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Duplex, PassThrough } from 'node:stream';
import type tls from 'node:tls';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuditEvent } from '../../server/network/audit-log';
import { type Identity, loadIdentity } from '../../server/network/identity';
import { openConnection } from '../../server/network/link-connection';
import { createLinkManager, type LinkManager } from '../../server/network/link-manager';
import { type LinkStore, openLinkStore } from '../../server/network/link-store';
import { dial, type LinkListener, listenLinks } from '../../server/network/listener';
import { createMachines } from '../../server/network/machines';
import { createMessaging, type Messaging } from '../../server/network/messaging';
import { snapshotFor } from '../../server/network/monitor-publisher';
import type { McpNetworkPort, RemoteEntry } from '../../src/conduit-mcp/remote-routing';
import type { MessageRecord } from '../../src/conduit-mcp/types';
import type { MonitorSession } from '../../src/contracts/link-protocol';
import {
  type HelloFrame,
  LINK_FEATURES,
  LINK_FRAME_MAX_BYTES,
  LINK_PROTOCOL,
  type LinkFrame,
  OWN_DEFAULT_CAPABILITIES,
  type WireMessage,
} from '../../src/contracts/link-protocol';
import type { SshDial, SshEndpoint } from '../../src/contracts/ssh-link';
import { encodeFrame, FrameDecoder } from '../../src/network/frame-codec';
import type { LinkRecord } from '../../src/network/link-file';
import { linkIdFor } from '../../src/network/pairing-transcript';
import { createRemoteDirectory } from '../../src/network/remote-directory';
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
  store: LinkStore;
  /** Warnings the manager logged, by message. */
  warns: string[];
  /** Where frames that aren't link control go; messaging wires itself in here. */
  setFrameSink(fn: (machineId: string, frame: LinkFrame) => void): void;
  /** add() the way the composer does it: store the record, then trust its certificate. */
  link(r: LinkRecord): void;
  ownerKeys: Array<{ publicKey: string; privateKey: string }>;
  listener: LinkListener;
  address: string;
  audit: AuditEvent[];
  changes: number;
  reconnects: string[];
}

const refuseSsh: SshDial = () => {
  throw new Error('this node has no ssh dial');
};

async function node(
  id: Identity,
  name: string,
  port = 0,
  sshDial: SshDial = refuseSsh,
): Promise<Node> {
  const store = openLinkStore('/net/links.json', { now: Date.now, log: quiet, io: memIo() });
  const cert = selfSignedCert(
    { publicKey: id.serverPublicKey, privateKey: id.serverPrivateKey },
    id.machineId,
  );
  const key = id.serverPrivateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const audit: AuditEvent[] = [];
  const ownerKeys: Array<{ publicKey: string; privateKey: string }> = [];
  const warns: string[] = [];
  let frameSink: (machineId: string, frame: LinkFrame) => void = () => undefined;
  const n = {
    audit,
    changes: 0,
    ownerKeys,
    reconnects: [] as string[],
    store,
    warns,
    setFrameSink: (fn: (machineId: string, frame: LinkFrame) => void) => {
      frameSink = fn;
    },
  };
  const manager = createLinkManager({
    identity: () => id,
    selfName: () => name,
    appVersion: '9.9.9',
    tls: () => ({ cert, key }),
    store,
    audit: { record: (e) => audit.push(e) },
    sshDial,
    log: {
      debug: () => undefined,
      warn: (msg) => {
        warns.push(msg);
      },
    },
    now: Date.now,
    rand: () => 0.5,
    after: (fn, ms) => {
      const h = setTimeout(fn, ms);
      return () => clearTimeout(h);
    },
    onFrame: (machineId, frame) => frameSink(machineId, frame),
    changed: () => {
      n.changes += 1;
    },
    dialTimeoutMs: 2_000,
    onOwnerKey: (pair) => {
      n.ownerKeys.push(pair);
      return true;
    },
    reconnected: (machineId) => {
      n.reconnects.push(machineId);
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
    transport: 'tls',
    ssh: null,
    machine: null,
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

  // CON-27 R3: a control character in a name would reach every surface that prints it.
  it('a hello name with a control character is not stored, and the link still comes up', async () => {
    const owner = identity();
    const ownerKey = { publicKey: owner.serverPublicKey, privateKey: owner.serverPrivateKey };
    const a = await node(identity(ownerKey), 'linux-box');
    const b = await node(identity(ownerKey), 'bad\nname');
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

const pemOf = (id: Identity): string =>
  id.serverPrivateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

function helloOf(of: Node) {
  return {
    t: 'hello' as const,
    protocol: { major: LINK_PROTOCOL.major, minor: LINK_PROTOCOL.minor },
    machineId: of.id.machineId,
    serverKey: of.id.serverKeyRaw.toString('base64'),
    ownerKey: ownerPub(of.id),
    selfName: 'peer',
    features: [...LINK_FEATURES],
    capabilities: { ...OWN_DEFAULT_CAPABILITIES },
  };
}

async function orderedPair(): Promise<[Identity, Identity]> {
  const owner = identity();
  const ownerKey = { publicKey: owner.serverPublicKey, privateKey: owner.serverPrivateKey };
  const x = identity(ownerKey);
  const y = identity(ownerKey);
  return x.machineId < y.machineId ? [x, y] : [y, x];
}

/**
 * `gated` dials `peer` at a stand-in listener that holds its hello. The peer connects in
 * first and `gated` adopts it; opening the gate then lets `gated`'s own dial finish, so that
 * adoption finds a live connection.
 */
async function gatedDuplicate(gatedId: Identity, peerId: Identity) {
  const gated = await node(gatedId, 'gated');
  const peer = await node(peerId, 'peer');
  const gateSocks: tls.TLSSocket[] = [];
  const gate = await listenLinks({
    hosts: ['127.0.0.1'],
    port: 0,
    cert: peer.cert,
    key: pemOf(peer.id),
    trustedCerts: () => [gated.cert],
    knows: () => true,
    onLink: (s) => {
      s.resume();
      gateSocks.push(s);
    },
    log: quiet,
  });
  cleanup.push(async () => {
    for (const s of gateSocks) s.destroy();
    await gate.close();
  });
  gated.link(record(peer, 'peer', { addresses: [gate.addresses()[0] ?? ''] }));
  gated.manager.start();
  await until(() => gateSocks.length === 1);
  const gateSock = gateSocks[0];
  if (!gateSock) throw new Error('gate socket missing');
  let gateClosed = false;
  gateSock.once('close', () => {
    gateClosed = true;
  });

  const { sock } = await dial({
    address: gated.address,
    cert: peer.cert,
    key: pemOf(peer.id),
    peerCert: gated.cert,
    peerMachineId: gated.id.machineId,
    expectKeyRaw: gated.id.serverKeyRaw,
    timeoutMs: 5000,
  });
  cleanup.push(async () => {
    sock.destroy();
  });
  let oldClosed = false;
  sock.resume();
  sock.once('close', () => {
    oldClosed = true;
  });
  sock.write(encodeFrame(helloOf(peer)));
  await until(() => gated.manager.view(peer.id.machineId)?.state === 'up');

  return {
    gated,
    peer,
    isGateClosed: () => gateClosed,
    isOldClosed: () => oldClosed,
    openGate: () => {
      gateSock.write(encodeFrame(helloOf(peer)));
    },
  };
}

describe('a connection swapped while up', { timeout: 60_000 }, () => {
  it('a first connection coming up does not re-send to the peer', async () => {
    const [lo, hi] = await orderedPair();
    const { gated } = await gatedDuplicate(lo, hi);
    expect(gated.reconnects).toEqual([]);
  });

  it('a duplicate the manager rejects does not re-send to the peer', async () => {
    const [lo, hi] = await orderedPair();
    const { gated, peer, openGate, isGateClosed } = await gatedDuplicate(hi, lo);
    openGate();
    await until(isGateClosed);
    expect(gated.reconnects).toEqual([]);
    expect(gated.manager.view(peer.id.machineId)?.state).toBe('up');
  });

  it('a duplicate that replaces a live connection re-sends to the peer once', async () => {
    const [lo, hi] = await orderedPair();
    const { gated, peer, openGate, isOldClosed } = await gatedDuplicate(lo, hi);
    openGate();
    await until(isOldClosed);
    expect(gated.reconnects).toEqual([peer.id.machineId]);
  });
});

const ENDPOINT: SshEndpoint = {
  target: 'remote-box',
  node: '/usr/bin/node',
  mainJs: '/opt/conduit/main.js',
  userData: '/home/user/.conduit',
};
const OWNER_REFUSED = 'link: owner frame refused on ssh link';

/** A Duplex that reads `readable` and writes `writable`: one end of a two-way in-memory pipe. */
function bridge(readable: PassThrough, writable: PassThrough): Duplex {
  const d = new Duplex({
    read() {
      readable.resume();
    },
    write(chunk: Buffer, _enc, cb) {
      writable.write(chunk, cb);
    },
    final(cb) {
      writable.end(cb);
    },
    destroy(err, cb) {
      readable.destroy();
      writable.destroy();
      cb(err);
    },
  });
  readable.on('data', (chunk: Buffer) => {
    if (!d.push(chunk)) readable.pause();
  });
  readable.on('end', () => d.push(null));
  return d;
}

/** Two in-memory byte pipes: `near` is the dialer's stdio, `far` is what the bridge reads. */
function streamPair(): [Duplex, Duplex] {
  const ab = new PassThrough();
  const ba = new PassThrough();
  return [bridge(ba, ab), bridge(ab, ba)];
}

interface FakeSsh {
  dial: SshDial;
  args: SshEndpoint[];
  streams: Array<[Duplex, Duplex]>;
  /** Kills the newest ssh session from both ends, as a dropped ssh child does. */
  dropLast(): void;
}

/** Each dial hands `far` to the target's acceptStream, the way the bridge's preamble would. */
function fakeSsh(into: () => Node): FakeSsh {
  const args: SshEndpoint[] = [];
  const streams: Array<[Duplex, Duplex]> = [];
  const dial: SshDial = (ssh) => {
    args.push(ssh);
    const pair = streamPair();
    streams.push(pair);
    into().manager.acceptStream(pair[1]);
    return { stream: pair[0], failure: async () => null };
  };
  return {
    dial,
    args,
    streams,
    dropLast: () => {
      const last = streams[streams.length - 1];
      if (!last) throw new Error('no ssh session to drop');
      last[0].destroy();
      last[1].destroy();
    },
  };
}

/** `a` dials `b` over a fake ssh; `b` only accepts, as an ssh target does. */
async function sshPair(bHasOwnerKey = true) {
  const owner = identity();
  const ownerKey = { publicKey: owner.serverPublicKey, privateKey: owner.serverPrivateKey };
  // Each side can dial the other, so either may be the controller in a test.
  const toB = fakeSsh(() => b);
  const toA = fakeSsh(() => a);
  const b = await node(bHasOwnerKey ? identity(ownerKey) : identity(), 'win-box', 0, toA.dial);
  const a = await node(identity(ownerKey), 'linux-box', 0, toB.dial);
  a.manager.start();
  b.manager.start();
  return { a, b, ssh: toB };
}

/** A stream whose far end speaks as `hello` would: what a remote says on its ssh stream. */
function forgingStream(hello: HelloFrame): Duplex {
  const [near, far] = streamPair();
  void openConnection(far, { hello, now: Date.now, log: quiet });
  return near;
}

const wire: WireMessage = {
  messageId: 'm_abcdefghijklmnop',
  threadId: 't_abcdefghijklmnop',
  from: 'agent-1',
  to: ['agent-2'],
  subject: 'hi',
  kind: 'inform',
  priority: 'normal',
  sentAt: '2026-01-01T00:00:00Z',
  body: 'hello',
  attachments: [],
};

function fakeMcp(inbox: string[]): McpNetworkPort {
  return {
    localDirectory: () => [],
    // The receiver drops a message it already holds, so a redelivery after a lost ack is harmless.
    hasMessage: (messageId: string) => inbox.includes(messageId),
    readBlob: async () => undefined,
    threadExportedTo: () => false,
    wireThreadFor: (threadId: string) => threadId,
    deliverInbound: async (msg: MessageRecord) => {
      inbox.push(msg.messageId);
      return msg.to.map((handle) => ({ handle, status: 'delivered' as const, reason: null }));
    },
    setRemoteStatus: async () => undefined,
    onLocalStatus: () => () => undefined,
    youUnread: () => 0,
    ownerPresence: () => 'here',
    requestsSummary: () => [],
    callAsRemote: () => Promise.reject(new Error('not used by this test')),
    remoteRequests: () => ({ apply: () => false, setLinkState: () => {} }),
  };
}

/** Messaging wired to a node the way the network service does: links from the manager, frames back in. */
function messagingOver(n: Node, mcp: McpNetworkPort): Messaging {
  const dir = mkdtempSync(join(tmpdir(), 'ssh-messaging-'));
  const svc = createMessaging({
    file: join(dir, 'outbox.json'),
    machineId: () => n.id.machineId,
    links: () =>
      n.manager.views().map((v) => ({
        machineId: v.machineId,
        state: v.state,
        capabilities: v.capabilities,
        peerCapabilities: v.peerCapabilities,
      })),
    send: (machineId, frame) => n.manager.send(machineId, frame),
    mcp: () => mcp,
    audit: { record: () => undefined },
    log: { warn: () => undefined, error: () => undefined },
    now: Date.now,
    after: (fn, ms) => {
      const h = setTimeout(fn, ms);
      return () => clearTimeout(h);
    },
  });
  n.setFrameSink((machineId, f) => {
    if (f.t === 'msg' || f.t === 'ack' || f.t === 'receipt') svc.onFrame(machineId, f);
  });
  svc.start();
  cleanup.push(async () => {
    svc.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  return svc;
}

describe('ssh links', { timeout: 60_000 }, () => {
  it('an ssh link to a server with no owner key works', async () => {
    const { a, b } = await sshPair(false);
    expect(await a.manager.addSshPeer(ENDPOINT)).toEqual({ ok: true, machineId: b.id.machineId });
    await until(() => b.manager.view(a.id.machineId)?.state === 'up');
    expect(a.manager.view(b.id.machineId)?.state).toBe('up');
    expect(a.store.get(b.id.machineId)?.ownerKey).toBeNull();
  });

  it('a dialed ssh record is named after its target, and a redial does not rename it', async () => {
    const { a, b, ssh } = await sshPair();
    expect(await a.manager.addSshPeer(ENDPOINT)).toEqual({ ok: true, machineId: b.id.machineId });
    expect(a.store.get(b.id.machineId)?.name).toBe(ENDPOINT.target);
    // A dropped ssh session redials, and B's hello on the new stream names B 'win-box'.
    ssh.dropLast();
    await until(() => a.manager.view(b.id.machineId)?.state !== 'up');
    await until(() => a.manager.view(b.id.machineId)?.state === 'up');
    expect(a.store.get(b.id.machineId)?.name).toBe(ENDPOINT.target);
  });

  it("a linked peer's session with a handle is counted by its machine and listed as its row", async () => {
    const { a, b } = await sshPair();
    expect((await a.manager.addSshPeer(ENDPOINT)).ok).toBe(true);
    await until(() => b.manager.view(a.id.machineId)?.state === 'up');
    await until(() => a.manager.view(b.id.machineId)?.state === 'up');
    // Both sides of an ssh link carry messaging and monitor. The dialer's record for B has no drive;
    // B's record for its controller does (plan CON-41 decision 3).
    expect(a.store.get(b.id.machineId)?.capabilities).toEqual(OWN_DEFAULT_CAPABILITIES);
    expect(b.store.get(a.id.machineId)?.capabilities).toEqual({
      ...OWN_DEFAULT_CAPABILITIES,
      drive: true,
    });
    const session: MonitorSession = {
      sessionId: 'sid-claude-1',
      handle: 'claude-1',
      label: 'claude-1',
      agent: 'claude',
      presence: 'idle',
      messaging: 'connected',
      messageable: true,
      notices: 'typed',
      home: '/home/x',
      roots: [],
      attention: { attentionReason: null, completions: 0 },
      completions: 0,
      limit: null,
      status: 'running',
    };
    // What B's monitor publisher sends: its snapshot, shaped by its own capabilities for A.
    const caps = b.manager.view(a.id.machineId)?.capabilities;
    if (caps === undefined) throw new Error('B has no view of A');
    const snapshot = snapshotFor(
      caps,
      {
        sessions: () => [session],
        requests: () => [],
        youUnread: () => 0,
        ownerPresence: () => 'here',
        agents: () => [],
      },
      1,
    );
    if (snapshot === null) throw new Error('B sends nothing to A');
    const directory = createRemoteDirectory();
    const linkInfo = () =>
      a.manager.views().map((v) => ({
        machineId: v.machineId,
        name: v.name,
        state: v.state,
        peerCapabilities: v.peerCapabilities,
      }));
    directory.setLinks(linkInfo(), 'linux-box');
    a.setFrameSink((machineId, f) => {
      if (f.t === 'snapshot') directory.apply(machineId, f.snapshot);
    });
    expect(b.manager.send(a.id.machineId, { t: 'snapshot', snapshot })).toBe(true);
    const machines = createMachines({
      manager: a.manager,
      store: a.store,
      bootstrap: () => Promise.reject(new Error('not used: the machine is pinned')),
      directory,
    });
    await until(() =>
      machines.list().some((m) => m.machine_id === b.id.machineId && m.sessions === 1),
    );
    expect(directory.entries()).toMatchObject([{ handle: 'claude-1', machineId: b.id.machineId }]);
  });

  it('acceptStream answers a tombstoned peer with revoked and does not re-link it', async () => {
    const { a, b } = await sshPair();
    const bKey = b.id.serverKeyRaw.toString('base64');
    a.store.addSsh({
      machineId: b.id.machineId,
      serverKey: bKey,
      ownerKey: null,
      name: 'win-box',
      ssh: null,
    });
    a.store.revoke(b.id.machineId, Date.now());
    const [x, y] = streamPair();
    cleanup.push(async () => {
      x.destroy();
      y.destroy();
    });
    a.manager.acceptStream(y);
    const frames: LinkFrame[] = [];
    const conn = await openConnection(x, { hello: helloOf(b), now: Date.now, log: quiet });
    if ('error' in conn) throw new Error('connection failed');
    conn.start({ onFrame: (f) => frames.push(f), onClose: () => undefined });
    await until(() => frames.some((f) => f.t === 'revoked'));
    expect(a.store.get(b.id.machineId)).toBeNull();
  });

  it('addSshPeer re-adds a revoked peer and clears its tombstone', async () => {
    const { a, b } = await sshPair();
    const bKey = b.id.serverKeyRaw.toString('base64');
    await a.manager.addSshPeer(ENDPOINT);
    await until(() => b.manager.view(a.id.machineId)?.state === 'up');
    // B is away while A revokes it, so B never learns of the revoke and keeps no tombstone.
    await b.manager.stop();
    expect(a.manager.revoke(b.id.machineId)).toBe(true);
    b.manager.start();
    expect((await a.manager.addSshPeer(ENDPOINT)).ok).toBe(true);
    expect(a.manager.view(b.id.machineId)?.state).toBe('up');
    expect(a.store.get(b.id.machineId)).toMatchObject({ transport: 'ssh', ssh: ENDPOINT });
    expect('tombstone' in (a.store.byServerKey(bKey) ?? {})).toBe(false);
  });

  it('addSshPeer refuses a controller record: a dial never fills its endpoint', async () => {
    // B dialed A first, so A's record for B came from acceptStream and has no endpoint.
    const { a, b } = await sshPair();
    await b.manager.addSshPeer({ ...ENDPOINT, target: 'linux-box' });
    await until(() => a.manager.view(b.id.machineId)?.state === 'up');
    expect(a.store.get(b.id.machineId)?.ssh).toBeNull();
    expect(await a.manager.addSshPeer(ENDPOINT)).toEqual({
      ok: false,
      error: { code: 'identity-conflict', machine: 'win-box' },
    });
    expect(a.store.get(b.id.machineId)?.ssh).toBeNull();
  });

  it('acceptStream pins a new controller, and a second key under its machine id is refused', async () => {
    const { a, b } = await sshPair();
    expect(await a.manager.addSshPeer(ENDPOINT)).toEqual({ ok: true, machineId: b.id.machineId });
    await until(() => b.manager.view(a.id.machineId)?.state === 'up');
    expect(b.store.get(a.id.machineId)).toMatchObject({ transport: 'ssh', ssh: null });
    expect(a.store.get(b.id.machineId)).toMatchObject({ transport: 'ssh', ssh: ENDPOINT });

    // Another key claiming A's machine id is not a sound hello (the id is the key's hash), so it is
    // refused before any identity rule runs, and the pinned record and link are untouched.
    const impostor = identity();
    await acceptForged(b, {
      ...helloOf(a),
      serverKey: impostor.serverKeyRaw.toString('base64'),
    });
    expect(b.warns).toContain(HELLO_REFUSED);
    expect(b.store.get(a.id.machineId)?.serverKey).toBe(a.id.serverKeyRaw.toString('base64'));
    expect(b.manager.view(a.id.machineId)?.state).toBe('up');
  });

  it('addSshPeer pins B, and a stream close redials with backoff using the injected sshDial', async () => {
    const { a, b, ssh } = await sshPair();
    expect((await a.manager.addSshPeer(ENDPOINT)).ok).toBe(true);
    await until(() => b.manager.view(a.id.machineId)?.state === 'up');
    ssh.dropLast();
    await until(
      () =>
        ssh.streams.length === 2 &&
        a.manager.view(b.id.machineId)?.state === 'up' &&
        b.manager.view(a.id.machineId)?.state === 'up',
    );
    expect(ssh.args).toEqual([ENDPOINT, ENDPOINT]);
  });

  it('an owner frame on an ssh link is dropped', async () => {
    const { a, b } = await sshPair();
    await a.manager.addSshPeer(ENDPOINT);
    await until(() => b.manager.view(a.id.machineId)?.state === 'up');
    expect(
      b.manager.send(a.id.machineId, { t: 'owner', publicKey: 'AAAA', privateKey: 'BBBB' }),
    ).toBe(true);
    await until(() => a.warns.includes(OWNER_REFUSED));
    expect(a.ownerKeys).toEqual([]);
    expect(a.manager.view(b.id.machineId)?.state).toBe('up');
  });

  it('messages queued while an ssh link is down are delivered once after redial', async () => {
    const { a, b, ssh } = await sshPair();
    const bInbox: string[] = [];
    const svcA = messagingOver(a, fakeMcp([]));
    const svcB = messagingOver(b, fakeMcp(bInbox));
    const recipient = {
      handle: 'agent-2',
      address: `agent-2@${b.id.machineId}`,
      machineId: b.id.machineId,
    } as RemoteEntry;
    await a.manager.addSshPeer(ENDPOINT);
    const bothUp = () =>
      a.manager.view(b.id.machineId)?.state === 'up' &&
      b.manager.view(a.id.machineId)?.state === 'up';
    await until(bothUp);
    svcA.linkUp(b.id.machineId);
    svcB.linkUp(a.id.machineId);

    ssh.dropLast();
    await until(() => !bothUp());
    svcA.linkDown(b.id.machineId);
    svcB.linkDown(a.id.machineId);
    svcA.enqueue({ ...wire, attachments: [] }, [recipient]);

    await until(() => ssh.streams.length === 2 && bothUp());
    svcA.linkUp(b.id.machineId);
    svcB.linkUp(a.id.machineId);
    await until(() => bInbox.length === 1);
    // Exactly once: a second copy would land after the first ack, so give one a window to appear.
    await new Promise((r) => setTimeout(r, 300));
    expect(bInbox).toHaveLength(1);
  });
});

const SELF_LINK = 'link: ssh self-link refused';
const HELLO_REFUSED = 'link: ssh hello refused';

/** Accepts a stream whose far end sends `hello`, and resolves once the acceptor closes it. */
async function acceptForged(target: Node, hello: HelloFrame): Promise<void> {
  const [x, y] = streamPair();
  cleanup.push(async () => {
    x.destroy();
    y.destroy();
  });
  target.manager.acceptStream(y);
  const conn = await openConnection(x, { hello, now: Date.now, log: quiet });
  if ('error' in conn) throw new Error('hello was not exchanged');
  await new Promise<void>((resolve) =>
    conn.start({ onFrame: () => undefined, onClose: () => resolve() }),
  );
}

describe('ssh hello identity and per-host pinning', { timeout: 60_000 }, () => {
  it('a hello whose machine id is not the hash of its key is refused on accept', async () => {
    const { a, b } = await sshPair();
    await acceptForged(b, { ...helloOf(a), machineId: 'm-00000000' });
    expect(b.store.links()).toEqual([]);
    expect(b.warns).toContain(HELLO_REFUSED);
  });

  it('a hello whose key is not a raw 32-byte key is refused on accept', async () => {
    const { a, b } = await sshPair();
    await acceptForged(b, { ...helloOf(a), serverKey: 'not-a-key' });
    expect(b.store.links()).toEqual([]);
    expect(b.warns).toContain(HELLO_REFUSED);
  });

  it('a hello naming this machine is refused as a self-link on accept', async () => {
    const { b } = await sshPair();
    await acceptForged(b, helloOf(b));
    expect(b.store.links()).toEqual([]);
    expect(b.warns).toContain(SELF_LINK);
  });

  it('a dialed hello whose machine id is forged is bad-hello, and nothing is stored', async () => {
    const owner = identity();
    const ownerKey = { publicKey: owner.serverPublicKey, privateKey: owner.serverPrivateKey };
    const c = await node(identity(ownerKey), 'c-box');
    const a = await node(identity(ownerKey), 'linux-box', 0, () => ({
      stream: forgingStream({ ...helloOf(c), machineId: 'm-00000000' }),
      failure: async () => null,
    }));
    a.manager.start();
    expect(await a.manager.addSshPeer(ENDPOINT)).toEqual({
      ok: false,
      error: { code: 'bad-hello' },
    });
    expect(a.store.links()).toEqual([]);
  });

  it('a dial that reaches this machine is refused as a self-link', async () => {
    const owner = identity();
    const ownerKey = { publicKey: owner.serverPublicKey, privateKey: owner.serverPrivateKey };
    const self: Node = await node(identity(ownerKey), 'self-box', 0, () => {
      const [near, far] = streamPair();
      self.manager.acceptStream(far);
      return { stream: near, failure: async () => null };
    });
    self.manager.start();
    expect(await self.manager.addSshPeer(ENDPOINT)).toEqual({
      ok: false,
      error: { code: 'bad-hello' },
    });
    expect(self.warns).toContain(SELF_LINK);
    expect(self.store.links()).toEqual([]);
  });

  it('a peer claiming a known machine id and key under another target is identity-conflict', async () => {
    const owner = identity();
    const ownerKey = { publicKey: owner.serverPublicKey, privateKey: owner.serverPrivateKey };
    const c = await node(identity(ownerKey), 'c-box');
    const toC = fakeSsh(() => c);
    const a = await node(identity(ownerKey), 'linux-box', 0, (ssh) =>
      ssh.target === 'c-target'
        ? toC.dial(ssh)
        : { stream: forgingStream(helloOf(c)), failure: async () => null },
    );
    c.manager.start();
    a.manager.start();
    expect((await a.manager.addSshPeer({ ...ENDPOINT, target: 'c-target' })).ok).toBe(true);
    await until(() => a.manager.view(c.id.machineId)?.state === 'up');
    const before = a.store.get(c.id.machineId);

    expect(await a.manager.addSshPeer({ ...ENDPOINT, target: 'b-target' })).toEqual({
      ok: false,
      error: { code: 'identity-conflict', machine: 'c-target' },
    });
    expect(a.store.get(c.id.machineId)).toEqual(before);
    // The link that was pinned for C still carries its frames to C.
    const got: LinkFrame[] = [];
    c.setFrameSink((_machineId, f) => got.push(f));
    expect(a.manager.send(c.id.machineId, { t: 'view.close', viewId: 'after' })).toBe(true);
    await until(() => got.some((f) => f.t === 'view.close' && f.viewId === 'after'));
  });

  // A reinstalled remote (or an impostor on the same target) has a new key, so a new machine id.
  // Spec 6: the known target is refused until the owner acts, and the old pin is left as it was.
  it('a known ssh target answering with a new identity is identity-changed, and nothing is stored', async () => {
    const owner = identity();
    const ownerKey = { publicKey: owner.serverPublicKey, privateKey: owner.serverPrivateKey };
    const b = await node(identity(ownerKey), 'win-box');
    const toB = fakeSsh(() => b);
    const reinstalled = await node(identity(), 'win-box');
    let reinstalledAnswers = false;
    const a = await node(identity(ownerKey), 'linux-box', 0, (ssh) =>
      reinstalledAnswers
        ? { stream: forgingStream(helloOf(reinstalled)), failure: async () => null }
        : toB.dial(ssh),
    );
    b.manager.start();
    a.manager.start();
    expect((await a.manager.addSshPeer(ENDPOINT)).ok).toBe(true);
    await until(() => a.manager.view(b.id.machineId)?.state === 'up');
    const before = a.store.get(b.id.machineId);

    reinstalledAnswers = true;
    expect(await a.manager.addSshPeer(ENDPOINT)).toEqual({
      ok: false,
      error: { code: 'identity-changed' },
    });
    expect(a.store.get(b.id.machineId)).toEqual(before);
    expect(a.store.links()).toHaveLength(1);
    expect(a.manager.view(b.id.machineId)?.state).toBe('identity-changed');
  });

  it('a dial to the same target updates the endpoint the record was pinned with', async () => {
    const { a, b } = await sshPair();
    expect((await a.manager.addSshPeer(ENDPOINT)).ok).toBe(true);
    await until(() => b.manager.view(a.id.machineId)?.state === 'up');
    const moved = { ...ENDPOINT, mainJs: '/opt/conduit-new/main.js' };
    expect((await a.manager.addSshPeer(moved)).ok).toBe(true);
    expect(a.store.get(b.id.machineId)?.ssh).toEqual(moved);
  });

  it('a dial to another target for a known machine is identity-conflict, and the endpoint stays', async () => {
    const { a, b } = await sshPair();
    expect((await a.manager.addSshPeer(ENDPOINT)).ok).toBe(true);
    await until(() => b.manager.view(a.id.machineId)?.state === 'up');
    expect(await a.manager.addSshPeer({ ...ENDPOINT, target: 'other-box' })).toEqual({
      ok: false,
      error: { code: 'identity-conflict', machine: 'remote-box' },
    });
    expect(a.store.get(b.id.machineId)?.ssh).toEqual(ENDPOINT);
  });

  it('a tls record of the same machine is identity-conflict even when its key is stale', async () => {
    const { a, b } = await sshPair();
    a.store.put(record(b, 'win-box', { serverKey: Buffer.alloc(32, 7).toString('base64') }));
    expect(await a.manager.addSshPeer(ENDPOINT)).toEqual({
      ok: false,
      error: { code: 'identity-conflict', machine: 'win-box' },
    });
  });

  it('an ssh record with no endpoint never dials', async () => {
    const owner = identity();
    const ownerKey = { publicKey: owner.serverPublicKey, privateKey: owner.serverPrivateKey };
    const a = await node(identity(ownerKey), 'linux-box', 0, refuseSsh);
    a.store.addSsh({
      machineId: 'm-0badcafe',
      serverKey: Buffer.alloc(32, 9).toString('base64'),
      ownerKey: null,
      name: 'controller',
      ssh: null,
    });
    a.manager.start();
    await new Promise((r) => setTimeout(r, 200));
    expect(a.audit.filter((e) => e.kind === 'link.state')).toEqual([]);
  });

  it('concurrent addSshPeer calls for one target share a single dial', async () => {
    const { a, b, ssh } = await sshPair();
    const [first, second] = await Promise.all([
      a.manager.addSshPeer(ENDPOINT),
      a.manager.addSshPeer(ENDPOINT),
    ]);
    expect(first).toEqual({ ok: true, machineId: b.id.machineId });
    expect(second).toEqual(first);
    expect(ssh.args).toHaveLength(1);
  });

  it('addSshPeer on a stopped manager dials, pins nothing, and says not_adopted', async () => {
    const owner = identity();
    const ownerKey = { publicKey: owner.serverPublicKey, privateKey: owner.serverPrivateKey };
    const b = await node(identity(ownerKey), 'win-box');
    b.manager.start();
    const toB = fakeSsh(() => b);
    const a = await node(identity(ownerKey), 'linux-box', 0, toB.dial);
    expect(await a.manager.addSshPeer(ENDPOINT)).toEqual({
      ok: false,
      error: { code: 'ssh_failed', detail: 'not_adopted' },
    });
    expect(a.store.links()).toEqual([]);
  });

  it('a message in flight when the ssh stream drops is delivered exactly once', async () => {
    const { a, b, ssh } = await sshPair();
    const bInbox: string[] = [];
    const svcA = messagingOver(a, fakeMcp([]));
    const svcB = messagingOver(b, fakeMcp(bInbox));
    const recipient = {
      handle: 'agent-2',
      address: `agent-2@${b.id.machineId}`,
      machineId: b.id.machineId,
    } as RemoteEntry;
    await a.manager.addSshPeer(ENDPOINT);
    const bothUp = () =>
      a.manager.view(b.id.machineId)?.state === 'up' &&
      b.manager.view(a.id.machineId)?.state === 'up';
    await until(bothUp);
    svcA.linkUp(b.id.machineId);
    svcB.linkUp(a.id.machineId);

    svcA.enqueue({ ...wire, attachments: [] }, [recipient]);
    // The frame may or may not have reached B before the stream dies; either way it must land once.
    ssh.dropLast();
    await until(() => !bothUp());
    svcA.linkDown(b.id.machineId);
    svcB.linkDown(a.id.machineId);
    await until(() => ssh.streams.length === 2 && bothUp());
    svcA.linkUp(b.id.machineId);
    svcB.linkUp(a.id.machineId);
    await until(() => bInbox.length >= 1);
    await new Promise((r) => setTimeout(r, 300));
    expect(bInbox).toHaveLength(1);
  });

  // Redials of a stored ssh record pin no key at dial time, so attach's comparison is the only guard.
  it('a redial of a stored ssh record that meets another key is identity-changed', async () => {
    const real = await node(identity(), 'real');
    const impostor = await node(identity(), 'impostor');
    const dial: SshDial = () => ({
      stream: forgingStream(helloOf(impostor)),
      failure: async () => null,
    });
    const a = await node(identity(), 'ctl', 0, dial);
    a.store.addSsh({
      machineId: real.id.machineId,
      serverKey: real.id.serverKeyRaw.toString('base64'),
      ownerKey: null,
      name: 'real',
      ssh: ENDPOINT,
    });
    a.manager.start();
    await until(() => a.manager.view(real.id.machineId)?.state === 'identity-changed');
  });
});

const META = {
  os: 'linux' as const,
  arch: 'x64' as const,
  version: '0.9.0',
  mode: 'full' as const,
  agents: [] as string[],
  enabled: true,
  survivesLogout: false,
};

/** A clock the manager reads through now and after: timers fire only when the test moves time. */
function fakeClock(start = Date.parse('2026-11-16T10:00:00.000Z')) {
  let t = start;
  const timers: Array<{ at: number; fn: () => void; live: boolean }> = [];
  const nextDue = (end: number) =>
    timers.filter((x) => x.live && x.at <= end).sort((a, b) => a.at - b.at)[0];
  return {
    now: () => t,
    after(fn: () => void, ms: number) {
      const timer = { at: t + ms, fn, live: true };
      timers.push(timer);
      return () => {
        timer.live = false;
      };
    },
    /** Moves time, firing each timer at its own instant on the way. */
    run(ms: number) {
      const end = t + ms;
      for (let next = nextDue(end); next; next = nextDue(end)) {
        next.live = false;
        t = next.at;
        next.fn();
      }
      t = end;
    },
    /** Moves time at once: everything due fires late, as after the machine slept. */
    jump(ms: number) {
      t += ms;
      for (let next = nextDue(t); next; next = nextDue(t)) {
        next.live = false;
        next.fn();
      }
    },
  };
}

const settle = async () => {
  for (let i = 0; i < 4; i += 1) await new Promise((r) => setTimeout(r, 0));
};

/** Every dial fails at once: a stream that is already closed, as a refused ssh child leaves it. */
function refusingDial() {
  const dials: string[] = [];
  const dial: SshDial = (ssh) => {
    dials.push(ssh.target);
    const stream = new PassThrough();
    stream.destroy();
    return { stream, failure: async () => null };
  };
  return { dial, dials };
}

function clockedManager(dial: SshDial, pingMs?: number) {
  const clock = fakeClock();
  const id = identity();
  const store = openLinkStore('/net/links.json', { now: clock.now, log: quiet, io: memIo() });
  const manager = createLinkManager({
    identity: () => id,
    selfName: () => 'controller',
    appVersion: '9.9.9',
    tls: () => ({ cert: '', key: '' }),
    store,
    audit: { record: () => undefined },
    sshDial: dial,
    log: quiet,
    now: clock.now,
    rand: () => 0.5,
    after: (fn, ms) => clock.after(fn, ms),
    onFrame: () => undefined,
    changed: () => undefined,
    onOwnerKey: () => false,
    reconnected: () => undefined,
    pingMs,
  });
  return { clock, store, manager };
}

/** An ssh machine we pinned, with its machine block as bootstrap writes it. */
function pinnedMachine(store: LinkStore, machineId: string, target: string, enabled = true) {
  const endpoint = { ...ENDPOINT, target };
  store.addSsh({
    machineId,
    serverKey: Buffer.alloc(32, machineId.length).toString('base64'),
    ownerKey: null,
    name: target,
    ssh: endpoint,
  });
  store.setMachine(machineId, { ...META, enabled });
}

/**
 * Drives a peer that keeps failing until its backoff has reached the 60 s cap, so the next retry
 * is far away: a wake must then be the thing that redials it.
 */
async function backedOffToCap(clock: ReturnType<typeof fakeClock>) {
  for (let i = 0; i < 150; i += 1) {
    clock.run(1_000);
    await settle();
  }
}

describe('machine lifecycle on the manager', { timeout: 60_000 }, () => {
  it('a disabled ssh peer is not dialed when the manager starts', async () => {
    const { dial, dials } = refusingDial();
    const { clock, store, manager } = clockedManager(dial);
    pinnedMachine(store, 'm-00000001', 'vm-off', false);
    manager.start();
    clock.run(0);
    await settle();
    expect(dials).toEqual([]);
    manager.stop();
  });

  it('enable clears the disabled flag and dials at once', async () => {
    const { dial, dials } = refusingDial();
    const { clock, store, manager } = clockedManager(dial);
    pinnedMachine(store, 'm-00000001', 'vm-off', false);
    manager.start();
    expect(manager.enable('m-00000001')).toBe(true);
    clock.run(0);
    expect(dials).toEqual(['vm-off']);
    expect(store.get('m-00000001')?.machine?.enabled).toBe(true);
    manager.stop();
  });

  it('enable and disconnect of an unknown peer, or one with no machine block, are refused', () => {
    const { dial } = refusingDial();
    const { store, manager } = clockedManager(dial);
    store.addSsh({
      machineId: 'm-00000002',
      serverKey: Buffer.alloc(32, 2).toString('base64'),
      ownerKey: null,
      name: 'legacy',
      ssh: ENDPOINT,
    });
    expect(manager.enable('m-00000009')).toBe(false);
    expect(manager.disconnect('m-00000009')).toBe(false);
    expect(manager.enable('m-00000002')).toBe(false);
    expect(manager.disconnect('m-00000002')).toBe(false);
  });

  it('waitUp reports no failure when the link does not come up in time', async () => {
    const { dial } = refusingDial();
    const { clock, store, manager } = clockedManager(dial);
    pinnedMachine(store, 'm-00000001', 'vm-off', false);
    manager.start();
    const waiting = manager.waitUp('m-00000001', 1_000, new AbortController().signal);
    clock.run(1_000);
    expect(await waiting).toEqual({ up: false, failure: null });
    manager.stop();
  });

  it('waitUp returns at once, with no failure, when its signal is already aborted', async () => {
    const { dial } = refusingDial();
    const { store, manager } = clockedManager(dial);
    pinnedMachine(store, 'm-00000001', 'vm-off', false);
    manager.start();
    const ac = new AbortController();
    ac.abort();
    expect(await manager.waitUp('m-00000001', 30_000, ac.signal)).toEqual({
      up: false,
      failure: null,
    });
    manager.stop();
  });

  it('disconnect clears enabled, closes the link, and nothing redials it', async () => {
    const { a, b, ssh } = await sshPair();
    expect((await a.manager.addSshPeer(ENDPOINT)).ok).toBe(true);
    await until(() => b.manager.view(a.id.machineId)?.state === 'up');
    a.store.setMachine(b.id.machineId, { ...META, enabled: true });
    expect(a.manager.disconnect(b.id.machineId)).toBe(true);
    expect(a.store.get(b.id.machineId)?.machine?.enabled).toBe(false);
    await until(() => a.manager.view(b.id.machineId)?.state === 'down');
    const dialsAfterDisconnect = ssh.args.length;
    await new Promise((r) => setTimeout(r, 300));
    expect(ssh.args.length).toBe(dialsAfterDisconnect);
    expect(a.manager.view(b.id.machineId)?.state).toBe('down');
  });

  it('enable on a disconnected peer brings the link back up over a redial', async () => {
    const { a, b } = await sshPair();
    expect((await a.manager.addSshPeer(ENDPOINT)).ok).toBe(true);
    await until(() => b.manager.view(a.id.machineId)?.state === 'up');
    a.store.setMachine(b.id.machineId, { ...META, enabled: true });
    a.manager.disconnect(b.id.machineId);
    await until(() => a.manager.view(b.id.machineId)?.state === 'down');
    expect(a.manager.enable(b.id.machineId)).toBe(true);
    await until(() => a.manager.view(b.id.machineId)?.state === 'up');
  });

  it('a tick more than 3 intervals after the last one redials each enabled, down ssh peer at once', async () => {
    const { dial, dials } = refusingDial();
    const { clock, store, manager } = clockedManager(dial);
    pinnedMachine(store, 'm-00000001', 'vm-on');
    pinnedMachine(store, 'm-00000002', 'vm-off', false);
    manager.start();
    clock.run(0);
    await settle();
    await backedOffToCap(clock);
    const before = dials.length;
    // The 60 s retry is still far off; only the wake can dial now.
    clock.jump(20_000);
    expect(dials.slice(before)).toEqual(['vm-on']);
    await settle();
    manager.stop();
  });

  it('a tick on time does not redial a peer that is waiting out its backoff', async () => {
    const { dial, dials } = refusingDial();
    const { clock, store, manager } = clockedManager(dial);
    pinnedMachine(store, 'm-00000001', 'vm-on');
    manager.start();
    clock.run(0);
    await settle();
    await backedOffToCap(clock);
    const before = dials.length;
    for (let i = 0; i < 5; i += 1) {
      clock.run(1_000);
      await settle();
    }
    expect(dials.length).toBe(before);
    manager.stop();
  });
});

describe('a dial failure is kept on the peer until a dial succeeds', { timeout: 60_000 }, () => {
  it('waitUp reports the failed dial, and that failure is cleared once a redial is up', async () => {
    const owner = identity();
    const ownerKey = { publicKey: owner.serverPublicKey, privateKey: owner.serverPrivateKey };
    const toB = fakeSsh(() => b);
    let dials = 0;
    // The first dial's ssh child dies before any hello with a host key change; later dials reach B.
    const flaky: SshDial = (ssh) => {
      dials += 1;
      if (dials === 1) {
        const stream = new PassThrough();
        stream.destroy();
        return {
          stream,
          failure: async () => ({ code: 'ssh_needs_person', reason: 'host_key_changed' }),
        };
      }
      return toB.dial(ssh);
    };
    const b = await node(identity(ownerKey), 'win-box', 0, () => {
      throw new Error('b never dials');
    });
    const a = await node(identity(ownerKey), 'linux-box', 0, flaky);
    a.store.addSsh({
      machineId: b.id.machineId,
      serverKey: b.id.serverKeyRaw.toString('base64'),
      ownerKey: ownerPub(b.id),
      name: 'win-box',
      ssh: ENDPOINT,
    });
    a.store.setMachine(b.id.machineId, { ...META, enabled: true });
    b.manager.start();
    a.manager.start();

    const signal = new AbortController().signal;
    expect(await a.manager.waitUp(b.id.machineId, 20_000, signal)).toEqual({
      up: false,
      failure: { code: 'ssh_needs_person', reason: 'host_key_changed' },
    });
    // The retry is the second dial, which reaches B and comes up.
    await until(() => a.manager.view(b.id.machineId)?.state === 'up');
    expect(dials).toBe(2);

    // Once up, the old failure must not come back: a link that drops with nothing dialing says so.
    a.manager.disconnect(b.id.machineId);
    expect(await a.manager.waitUp(b.id.machineId, 300, signal)).toEqual({
      up: false,
      failure: null,
    });
  });
});

describe('re-adding and disconnecting a machine', { timeout: 60_000 }, () => {
  // The reviewer's probe: an explicit add of a disabled machine must come up when the add returns, and
  // its machine block then reads enabled. No wait for B first: a re-add right after the disconnect is the
  // case that used to race B's stale stream (review CON-39 T1, B3).
  it('re-adding a disabled machine enables it before its link attaches, so it comes up', async () => {
    const { a, b } = await sshPair();
    expect((await a.manager.addSshPeer(ENDPOINT)).ok).toBe(true);
    await until(() => b.manager.view(a.id.machineId)?.state === 'up');
    a.store.setMachine(b.id.machineId, { ...META, enabled: true });
    a.manager.disconnect(b.id.machineId);
    await until(() => a.manager.view(b.id.machineId)?.state === 'down');
    expect((await a.manager.addSshPeer(ENDPOINT)).ok).toBe(true);
    expect(a.manager.view(b.id.machineId)?.state).toBe('up');
    a.store.setMachine(b.id.machineId, { ...META, enabled: true });
    // B's stale close must not arrive and take the link down after the add has reported it up.
    await new Promise((r) => setTimeout(r, 300));
    expect(a.manager.view(b.id.machineId)?.state).toBe('up');
    expect(a.store.get(b.id.machineId)?.machine?.enabled).toBe(true);
  });

  // The disconnect check in attach: a disconnect that lands while an established peer's hello is in
  // flight must close that stream, not bring the link up.
  it('a disconnect during a peer hello closes that stream rather than bringing the link up', async () => {
    const owner = identity();
    const ownerKey = { publicKey: owner.serverPublicKey, privateKey: owner.serverPrivateKey };
    const b = await node(identity(ownerKey), 'win-box');
    let far: Duplex | undefined;
    const a = await node(identity(ownerKey), 'linux-box', 0, () => {
      const [near, peer] = streamPair();
      far = peer;
      return { stream: near, failure: async () => null };
    });
    a.store.addSsh({
      machineId: b.id.machineId,
      serverKey: b.id.serverKeyRaw.toString('base64'),
      ownerKey: ownerPub(b.id),
      name: 'win-box',
      ssh: ENDPOINT,
    });
    a.store.setMachine(b.id.machineId, { ...META, enabled: true });
    a.manager.start();
    await until(() => far !== undefined);
    expect(a.manager.disconnect(b.id.machineId)).toBe(true);
    // B's hello arrives only now, after the disconnect.
    if (far === undefined) throw new Error('no ssh stream');
    void openConnection(far, { hello: helloOf(b), now: Date.now, log: quiet });
    await new Promise((r) => setTimeout(r, 300));
    expect(a.manager.view(b.id.machineId)?.state).not.toBe('up');
  });
});

describe('enable and waitUp, from the outside', () => {
  it('enable clears the last failed dial, so a wait it starts does not return that failure', async () => {
    const dial: SshDial = () => {
      const stream = new PassThrough();
      stream.destroy();
      return { stream, failure: async () => ({ code: 'ssh_auth_failed' }) };
    };
    const { clock, store, manager } = clockedManager(dial);
    pinnedMachine(store, 'm-00000001', 'vm-off', false);
    manager.start();
    expect(manager.enable('m-00000001')).toBe(true);
    clock.run(0);
    await settle();
    expect(await manager.waitUp('m-00000001', 1_000, new AbortController().signal)).toEqual({
      up: false,
      failure: { code: 'ssh_auth_failed' },
    });

    // A new attempt: its wait must not answer with the old failure before the new dial has run.
    expect(manager.enable('m-00000001')).toBe(true);
    let answered = false;
    const waiting = manager.waitUp('m-00000001', 1_000, new AbortController().signal);
    void waiting.then(() => {
      answered = true;
    });
    await settle();
    expect(answered).toBe(false);
    manager.stop();
  });

  it('waitUp leaves no timer behind once it is aborted or times out', async () => {
    vi.useFakeTimers();
    try {
      const store = openLinkStore('/net/links.json', { now: Date.now, log: quiet, io: memIo() });
      const manager = createLinkManager({
        identity,
        selfName: () => 'controller',
        appVersion: '9.9.9',
        tls: () => ({ cert: '', key: '' }),
        store,
        audit: { record: () => undefined },
        sshDial: refusingDial().dial,
        log: quiet,
        now: Date.now,
        rand: () => 0.5,
        after: (fn, ms) => {
          const handle = setTimeout(fn, ms);
          return () => clearTimeout(handle);
        },
        onFrame: () => undefined,
        changed: () => undefined,
        onOwnerKey: () => false,
        reconnected: () => undefined,
      });
      pinnedMachine(store, 'm-00000001', 'vm-off', false);
      const ac = new AbortController();
      const aborted = manager.waitUp('m-00000001', 30_000, ac.signal);
      expect(vi.getTimerCount()).toBe(1);
      ac.abort();
      expect(await aborted).toEqual({ up: false, failure: null });
      expect(vi.getTimerCount()).toBe(0);

      const timed = manager.waitUp('m-00000001', 30_000, new AbortController().signal);
      expect(vi.getTimerCount()).toBe(1);
      vi.advanceTimersByTime(30_000);
      expect(await timed).toEqual({ up: false, failure: null });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("an ssh peer's hello writes its machine block (protocol 1.1)", () => {
  it.runIf(process.platform === 'linux' && process.arch === 'x64')(
    'a dialed peer gets os, arch and version from its hello; the rest of the block is the default',
    async () => {
      const { a, b } = await sshPair();
      expect(await a.manager.addSshPeer(ENDPOINT)).toEqual({
        ok: true,
        machineId: b.id.machineId,
      });
      expect(a.store.get(b.id.machineId)?.machine).toEqual({
        os: 'linux',
        arch: 'x64',
        version: '9.9.9',
        mode: 'full',
        agents: [],
        enabled: true,
        survivesLogout: null,
      });
      // B pinned A from the accepted stream, where A's record has no endpoint: no block there.
      expect(b.store.get(a.id.machineId)?.machine).toBeNull();
    },
  );

  // B1: an existing block keeps what only the operator or bootstrap set; only the hello's three fields move.
  it.runIf(process.platform === 'linux' && process.arch === 'x64')(
    'a 1.1 hello refreshes only os, arch and version of an existing block',
    async () => {
      const { a, b } = await sshPair();
      a.store.addSsh({
        machineId: b.id.machineId,
        serverKey: b.id.serverKeyRaw.toString('base64'),
        ownerKey: null,
        name: 'win-box',
        ssh: ENDPOINT,
      });
      a.store.setMachine(b.id.machineId, {
        os: 'windows',
        arch: 'x64',
        version: '0.1.0',
        mode: 'light',
        agents: ['claude'],
        enabled: true,
        survivesLogout: true,
      });
      expect(await a.manager.addSshPeer(ENDPOINT)).toEqual({
        ok: true,
        machineId: b.id.machineId,
      });
      expect(a.store.get(b.id.machineId)?.machine).toEqual({
        os: 'linux',
        arch: 'x64',
        version: '9.9.9',
        mode: 'light',
        agents: ['claude'],
        enabled: true,
        survivesLogout: true,
      });
    },
  );

  // A hello that changes nothing must not rewrite links.json on every attach.
  it.runIf(process.platform === 'linux' && process.arch === 'x64')(
    'a hello that changes nothing writes nothing to the store',
    async () => {
      const { a } = await sshPair();
      expect((await a.manager.addSshPeer(ENDPOINT)).ok).toBe(true);
      let writes = 0;
      const setMachine = a.store.setMachine;
      a.store.setMachine = (...args) => {
        writes += 1;
        return setMachine(...args);
      };
      expect((await a.manager.addSshPeer(ENDPOINT)).ok).toBe(true);
      expect(writes).toBe(0);
    },
  );

  it("a peer on os 'other' with x64 leaves its block untouched, and says so", async () => {
    const owner = identity();
    const ownerKey = { publicKey: owner.serverPublicKey, privateKey: owner.serverPrivateKey };
    const c = await node(identity(ownerKey), 'c-box');
    const a = await node(identity(ownerKey), 'linux-box', 0, () => ({
      stream: forgingStream({
        ...helloOf(c),
        platform: { os: 'other', arch: 'x64' },
        version: '9.9.9',
      }),
      failure: async () => null,
    }));
    a.manager.start();
    expect(await a.manager.addSshPeer(ENDPOINT)).toEqual({ ok: true, machineId: c.id.machineId });
    expect(a.store.get(c.id.machineId)?.machine).toBeNull();
    expect(a.warns.some((w) => w.includes('platform'))).toBe(true);
  });

  it('a peer whose hello has no platform (an older one) links, and its block stays absent', async () => {
    const owner = identity();
    const ownerKey = { publicKey: owner.serverPublicKey, privateKey: owner.serverPrivateKey };
    const c = await node(identity(ownerKey), 'c-box');
    const a = await node(identity(ownerKey), 'linux-box', 0, () => ({
      stream: forgingStream(helloOf(c)),
      failure: async () => null,
    }));
    a.manager.start();
    expect(await a.manager.addSshPeer(ENDPOINT)).toEqual({ ok: true, machineId: c.id.machineId });
    expect(a.store.get(c.id.machineId)?.machine).toBeNull();
  });

  it('a peer on a platform we do not record leaves its block untouched, and says so', async () => {
    const owner = identity();
    const ownerKey = { publicKey: owner.serverPublicKey, privateKey: owner.serverPrivateKey };
    const c = await node(identity(ownerKey), 'c-box');
    const a = await node(identity(ownerKey), 'linux-box', 0, () => ({
      stream: forgingStream({
        ...helloOf(c),
        platform: { os: 'linux', arch: 'arm64' },
        version: '9.9.9',
      }),
      failure: async () => null,
    }));
    a.manager.start();
    expect(await a.manager.addSshPeer(ENDPOINT)).toEqual({ ok: true, machineId: c.id.machineId });
    expect(a.store.get(c.id.machineId)?.machine).toBeNull();
    expect(a.warns.some((w) => w.includes('platform'))).toBe(true);
  });
});

describe('forget and the drive grant', { timeout: 60_000 }, () => {
  it('an ssh controller is granted drive on accept, and the hello it gets says so', async () => {
    const { a, b } = await sshPair();
    expect((await a.manager.addSshPeer(ENDPOINT)).ok).toBe(true);
    await until(() => b.manager.view(a.id.machineId)?.state === 'up');
    // B's record for its controller is the one drive.ts reads; A's record for B stays read-only.
    expect(b.store.get(a.id.machineId)?.capabilities.drive).toBe(true);
    expect(a.manager.view(b.id.machineId)?.peerCapabilities?.drive).toBe(true);
    expect(a.store.get(b.id.machineId)?.capabilities.drive).toBe(false);
  });

  it('forget closes without a revoked frame and leaves no tombstone', async () => {
    const { a, b } = await sshPair();
    await a.manager.addSshPeer(ENDPOINT);
    await until(() => b.manager.view(a.id.machineId)?.state === 'up');
    const changes = a.changes;
    expect(a.manager.forget(b.id.machineId)).toBe(true);
    expect(a.changes).toBeGreaterThan(changes);
    expect(a.store.get(b.id.machineId)).toBeNull();
    expect(a.store.byServerKey(b.id.serverKeyRaw.toString('base64'))).toBeNull();
    expect(a.manager.view(b.id.machineId)).toBeNull();
    expect(a.audit.some((e) => e.kind === 'link.revoked')).toBe(false);
    // The far side sees a plain close, never a revoke: its record and its state are its own.
    await until(() => b.manager.view(a.id.machineId)?.state === 'down');
    expect(b.manager.view(a.id.machineId)?.revokedBy).toBeNull();
    expect(b.store.get(a.id.machineId)).not.toBeNull();
  });

  it('forget stops a pending redial: no dial happens after it', async () => {
    // Each dial's stream is closed before any hello, so the peer fails and schedules a retry about 1 s on.
    let dials = 0;
    const a = await node(identity(), 'linux-box', 0, () => {
      dials += 1;
      const [near, far] = streamPair();
      near.destroy();
      far.destroy();
      return { stream: near, failure: async () => null };
    });
    const x = await node(identity(), 'x-box');
    a.store.addSsh({
      machineId: x.id.machineId,
      serverKey: x.id.serverKeyRaw.toString('base64'),
      ownerKey: null,
      name: 'x-box',
      ssh: ENDPOINT,
    });
    a.store.setMachine(x.id.machineId, { ...META, enabled: true });
    a.manager.start();
    await until(() => dials >= 1);
    expect(a.manager.forget(x.id.machineId)).toBe(true);
    const atForget = dials;
    await new Promise((r) => setTimeout(r, 2_500));
    expect(dials).toBe(atForget);
  });

  it('a wait on a machine that is forgotten returns at once, with no failure', async () => {
    const a = await node(identity(), 'linux-box', 0, () => {
      const [near] = streamPair();
      return { stream: near, failure: async () => null };
    });
    const x = await node(identity(), 'x-box');
    a.store.addSsh({
      machineId: x.id.machineId,
      serverKey: x.id.serverKeyRaw.toString('base64'),
      ownerKey: null,
      name: 'x-box',
      ssh: ENDPOINT,
    });
    a.store.setMachine(x.id.machineId, { ...META, enabled: true });
    a.manager.start();
    const waiting = a.manager.waitUp(x.id.machineId, 60_000, new AbortController().signal);
    expect(a.manager.forget(x.id.machineId)).toBe(true);
    const outcome = await Promise.race([
      waiting,
      new Promise<string>((r) => setTimeout(() => r('still waiting'), 2_000)),
    ]);
    expect(outcome).toEqual({ up: false, failure: null });
  });

  it('an inbound ssh hello never grants drive to a record we dial', async () => {
    // A dialed record (ssh set) is ours to dial, so B may not drive A through it (spec S5).
    const x = await node(identity(), 'x-box');
    let dialed = 0;
    const a = await node(identity(), 'linux-box', 0, () => {
      dialed += 1;
      const [near] = streamPair();
      return { stream: near, failure: async () => null };
    });
    a.store.addSsh({
      machineId: x.id.machineId,
      serverKey: x.id.serverKeyRaw.toString('base64'),
      ownerKey: null,
      name: 'x-box',
      ssh: ENDPOINT,
    });
    a.store.setMachine(x.id.machineId, { ...META, enabled: true });
    a.manager.start();
    await until(() => dialed >= 1);
    const [near, far] = streamPair();
    a.manager.acceptStream(far);
    void openConnection(near, { hello: helloOf(x), now: Date.now, log: quiet });
    await new Promise((r) => setTimeout(r, 300));
    expect(a.store.get(x.id.machineId)?.capabilities.drive).toBe(false);
  });

  it('forget of an unknown machine is false and changes nothing', async () => {
    const { a } = await sshPair();
    const changes = a.changes;
    expect(a.manager.forget('m-99999999')).toBe(false);
    expect(a.changes).toBe(changes);
  });
});
