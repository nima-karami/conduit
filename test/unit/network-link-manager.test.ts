import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Duplex, PassThrough } from 'node:stream';
import type tls from 'node:tls';
import { afterEach, describe, expect, it } from 'vitest';
import type { AuditEvent } from '../../server/network/audit-log';
import { type Identity, loadIdentity } from '../../server/network/identity';
import { openConnection } from '../../server/network/link-connection';
import { createLinkManager, type LinkManager } from '../../server/network/link-manager';
import { type LinkStore, openLinkStore } from '../../server/network/link-store';
import { dial, type LinkListener, listenLinks } from '../../server/network/listener';
import { createMessaging, type Messaging } from '../../server/network/messaging';
import type { McpNetworkPort, RemoteEntry } from '../../src/conduit-mcp/remote-routing';
import type { MessageRecord } from '../../src/conduit-mcp/types';
import {
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
async function sshPair() {
  // A hello without an owner key is refused on ssh; these peers carry one, as paired servers do.
  const owner = identity();
  const ownerKey = { publicKey: owner.serverPublicKey, privateKey: owner.serverPrivateKey };
  const b = await node(identity(ownerKey), 'win-box');
  const ssh = fakeSsh(() => b);
  const a = await node(identity(ownerKey), 'linux-box', 0, ssh.dial);
  a.manager.start();
  b.manager.start();
  return { a, b, ssh };
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
    hasMessage: () => false,
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
  it('acceptStream pins a new controller and a second stream with another serverKey is identity-changed', async () => {
    const { a, b } = await sshPair();
    expect(await a.manager.addSshPeer(ENDPOINT)).toEqual({ ok: true, machineId: b.id.machineId });
    await until(() => b.manager.view(a.id.machineId)?.state === 'up');
    expect(b.store.get(a.id.machineId)).toMatchObject({ transport: 'ssh', ssh: null });
    expect(a.store.get(b.id.machineId)).toMatchObject({ transport: 'ssh', ssh: ENDPOINT });

    // The same machine id under another server key: B refuses it and the pinned peer goes terminal.
    const impostor = identity();
    const [x, y] = streamPair();
    cleanup.push(async () => {
      x.destroy();
      y.destroy();
    });
    b.manager.acceptStream(y);
    await openConnection(x, {
      hello: { ...helloOf(a), serverKey: impostor.serverKeyRaw.toString('base64') },
      now: Date.now,
      log: quiet,
    });
    await until(() => b.manager.view(a.id.machineId)?.state === 'identity-changed');
    expect(b.store.get(a.id.machineId)?.serverKey).toBe(a.id.serverKeyRaw.toString('base64'));
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
