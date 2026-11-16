import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Duplex, PassThrough } from 'node:stream';
import type tls from 'node:tls';
import { afterEach, describe, expect, it } from 'vitest';
import { type Identity, signProof, verifyProof } from '../../server/network/identity';
import {
  type ConnectionOptions,
  type HelloProof,
  type LinkConnection,
  openConnection,
} from '../../server/network/link-connection';
import { dial, type Listener, listenLinks } from '../../server/network/listener';
import { type HelloFrame, LINK_PROTOCOL, type LinkFrame } from '../../src/contracts/link-protocol';
import { encodeFrame } from '../../src/network/frame-codec';
import { deriveMachineId } from '../../src/network/identity-file';
import { rawEd25519, selfSignedCert } from '../../src/network/self-signed-cert';

const quiet = { debug: () => undefined, warn: () => undefined };
const open: Listener[] = [];
const conns: LinkConnection[] = [];
afterEach(async () => {
  for (const c of conns.splice(0)) c.close('test-end');
  for (const l of open.splice(0)) await l.close();
});

function server() {
  const k = generateKeyPairSync('ed25519');
  const raw = rawEd25519(k.publicKey);
  const machineId = deriveMachineId(raw);
  return {
    raw,
    machineId,
    cert: selfSignedCert(k, machineId),
    key: k.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

function hello(machineId: string, major = 1): HelloFrame {
  return {
    t: 'hello',
    protocol: { major, minor: 0 },
    machineId,
    serverKey: 'AAAA',
    ownerKey: null,
    selfName: machineId,
    features: ['messaging', 'monitor'],
    capabilities: { messaging: true, monitor: true, drive: false },
  };
}

/** A pinned TLS pair: resolves with the accepted socket on A and the dialed socket on B. */
async function socketPair(): Promise<{ a: tls.TLSSocket; b: tls.TLSSocket }> {
  const A = server();
  const B = server();
  let accepted: (s: tls.TLSSocket) => void = () => undefined;
  const gotA = new Promise<tls.TLSSocket>((r) => {
    accepted = r;
  });
  const l = await listenLinks({
    hosts: ['127.0.0.1'],
    port: 0,
    cert: A.cert,
    key: A.key,
    trustedCerts: () => [B.cert],
    knows: (k) => k.equals(B.raw),
    onLink: (sock) => accepted(sock),
    log: quiet,
  });
  open.push(l);
  const { sock: b } = await dial({
    address: l.addresses()[0] ?? '',
    cert: B.cert,
    key: B.key,
    peerCert: A.cert,
    peerMachineId: A.machineId,
    expectKeyRaw: A.raw,
    timeoutMs: 5000,
  });
  return { a: await gotA, b };
}

type Opts = ConnectionOptions & { frames: LinkFrame[]; closes: string[] };

function base(h: HelloFrame, frames: LinkFrame[], closes: string[]): Opts {
  return { hello: h, now: () => Date.now(), log: quiet, frames, closes };
}

/** Opens and starts delivery at once, as the link manager does once it adopts a connection. */
async function openStarted(sock: tls.TLSSocket, o: Opts) {
  const { frames, closes, ...opts } = o;
  const c = await openConnection(sock, opts);
  if (!('error' in c)) c.start({ onFrame: (f) => frames.push(f), onClose: (w) => closes.push(w) });
  return c;
}

async function until(check: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('link connection', () => {
  it('exchanges hellos, then delivers frames both ways', async () => {
    const { a, b } = await socketPair();
    const fa: LinkFrame[] = [];
    const fb: LinkFrame[] = [];
    const [ca, cb] = await Promise.all([
      openStarted(a, base(hello('m-aaaaaaaa'), fa, [])),
      openStarted(b, base(hello('m-bbbbbbbb'), fb, [])),
    ]);
    if ('error' in ca || 'error' in cb) throw new Error('connection failed');
    conns.push(ca, cb);
    expect(ca.peerHello.machineId).toBe('m-bbbbbbbb');
    expect(cb.peerHello.machineId).toBe('m-aaaaaaaa');
    expect(ca.send({ t: 'view.close', viewId: 'v1' })).toBe(true);
    cb.send({ t: 'revoked' });
    await until(() => fa.length === 1 && fb.length === 1);
    expect(fb).toEqual([{ t: 'view.close', viewId: 'v1' }]);
    expect(fa).toEqual([{ t: 'revoked' }]);
  });

  it('frames that arrive before start are queued and delivered on start, in order', async () => {
    const { a, b } = await socketPair();
    const fa: LinkFrame[] = [];
    const [ca, cb] = await Promise.all([
      openConnection(a, { hello: hello('m-aaaaaaaa'), now: () => Date.now(), log: quiet }),
      openStarted(b, base(hello('m-bbbbbbbb'), [], [])),
    ]);
    if ('error' in ca || 'error' in cb) throw new Error('connection failed');
    conns.push(ca, cb);
    cb.send({ t: 'revoked' });
    cb.send({ t: 'view.close', viewId: 'v2' });
    // Give the frames time to land while nobody is listening yet.
    await new Promise((r) => setTimeout(r, 100));
    ca.start({ onFrame: (f) => fa.push(f), onClose: () => undefined });
    expect(fa).toEqual([{ t: 'revoked' }, { t: 'view.close', viewId: 'v2' }]);
  });

  it('a different protocol major is incompatible on both sides', async () => {
    const { a, b } = await socketPair();
    const [ca, cb] = await Promise.all([
      openStarted(a, base(hello('m-aaaaaaaa', 1), [], [])),
      openStarted(b, base(hello('m-bbbbbbbb', 2), [], [])),
    ]);
    expect('error' in ca && ca.error).toBe('incompatible');
    expect('error' in cb && cb.error).toBe('incompatible');
  });

  it('a first frame that is not a hello is bad-hello', async () => {
    const { a, b } = await socketPair();
    const pending = openStarted(a, base(hello('m-aaaaaaaa'), [], []));
    const { encodeFrame } = await import('../../src/network/frame-codec');
    b.write(encodeFrame({ t: 'ping' }));
    b.resume();
    const r = await pending;
    expect('error' in r && r.error).toBe('bad-hello');
  });

  it('pings answer each other, and silence past the down limit closes the link', async () => {
    const { a, b } = await socketPair();
    let now = 0;
    const tickA: Array<() => void> = [];
    const closes: string[] = [];
    const [ca, cb] = await Promise.all([
      openStarted(a, {
        ...base(hello('m-aaaaaaaa'), [], closes),
        now: () => now,
        every: (fn) => {
          tickA.push(fn);
          return () => undefined;
        },
      }),
      openStarted(b, base(hello('m-bbbbbbbb'), [], [])),
    ]);
    if ('error' in ca || 'error' in cb) throw new Error('connection failed');
    conns.push(cb);
    now = 5_000;
    for (const t of tickA) t();
    // B answers the ping with a pong, which refreshes A's last-frame time.
    await until(() => ca.silentMs() < 5_000);
    now += 25_000;
    for (const t of tickA) t();
    expect(closes).toEqual(['silence']);
  });

  // An ssh link's stream is a plain Duplex, not a TLS socket: the same hello must run over it.
  it('openConnection runs a full hello over a PassThrough duplex pair', async () => {
    const ab = new PassThrough();
    const ba = new PassThrough();
    const sideA = bridge(ba, ab);
    const sideB = bridge(ab, ba);
    const fa: LinkFrame[] = [];
    const fb: LinkFrame[] = [];
    const [ca, cb] = await Promise.all([
      openConnection(sideA, { hello: hello('m-aaaaaaaa'), now: () => Date.now(), log: quiet }),
      openConnection(sideB, { hello: hello('m-bbbbbbbb'), now: () => Date.now(), log: quiet }),
    ]);
    if ('error' in ca || 'error' in cb) throw new Error('connection failed');
    conns.push(ca, cb);
    expect(ca.peerHello.machineId).toBe('m-bbbbbbbb');
    expect(cb.peerHello.machineId).toBe('m-aaaaaaaa');
    ca.start({ onFrame: (f) => fa.push(f), onClose: () => undefined });
    cb.start({ onFrame: (f) => fb.push(f), onClose: () => undefined });
    expect(ca.send({ t: 'view.close', viewId: 'v3' })).toBe(true);
    cb.send({ t: 'revoked' });
    await until(() => fa.length === 1 && fb.length === 1);
    expect(fb).toEqual([{ t: 'view.close', viewId: 'v3' }]);
    expect(fa).toEqual([{ t: 'revoked' }]);
  });

  it('a socket closed by the peer reports closed once', async () => {
    const { a, b } = await socketPair();
    const closes: string[] = [];
    const [ca, cb] = await Promise.all([
      openStarted(a, base(hello('m-aaaaaaaa'), [], closes)),
      openStarted(b, base(hello('m-bbbbbbbb'), [], [])),
    ]);
    if ('error' in ca || 'error' in cb) throw new Error('connection failed');
    cb.close('shutdown');
    await until(() => closes.length > 0);
    expect(closes).toEqual(['closed']);
  });
});

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

/** The socket surface the connection uses; writableLength is the test's to set. */
class FakeSocket extends EventEmitter {
  writableLength = 0;
  written = 0;
  destroyed = false;
  write(chunk: Buffer): boolean {
    this.written += chunk.length;
    return true;
  }
  end(): void {}
  destroy(): void {
    this.destroyed = true;
  }
  resume(): void {}
}

describe('send buffer limits', () => {
  async function fakeLink() {
    const sock = new FakeSocket();
    const pending = openConnection(sock as unknown as tls.TLSSocket, {
      hello: hello('m-aaaaaaaa'),
      now: () => 0,
      log: quiet,
      every: () => () => undefined,
    });
    sock.emit('data', encodeFrame(hello('m-bbbbbbbb')));
    const c = await pending;
    if ('error' in c) throw new Error('connection failed');
    const frames: LinkFrame[] = [];
    const closes: string[] = [];
    c.start({ onFrame: (f) => frames.push(f), onClose: (w) => closes.push(w) });
    return { sock, c, closes };
  }

  // CON-27 R2b: a peer that never reads must not grow our buffer without bound.
  it('closes the connection and drops the frame once the buffer would pass the hard cap', async () => {
    const { sock, c, closes } = await fakeLink();
    const before = sock.written;
    sock.writableLength = 16 * 1024 * 1024 - 10;
    expect(c.send({ t: 'view.close', viewId: 'v1' })).toBe(false);
    expect(sock.written).toBe(before);
    expect(sock.destroyed).toBe(true);
    expect(closes).toEqual(['overflow']);
  });

  it('past the soft cap but under the hard one, send returns false and the link stays up', async () => {
    const { sock, c, closes } = await fakeLink();
    sock.writableLength = 5 * 1024 * 1024;
    expect(c.send({ t: 'view.close', viewId: 'v1' })).toBe(false);
    expect(sock.destroyed).toBe(false);
    expect(closes).toEqual([]);
  });
});

/** A node with a real Ed25519 server key; its machine id is the hash of that key. */
function keyed(): Identity {
  const k = generateKeyPairSync('ed25519');
  const raw = rawEd25519(k.publicKey);
  return {
    machineId: deriveMachineId(raw),
    serverPublicKey: k.publicKey,
    serverPrivateKey: k.privateKey,
    ownerKey: null,
    serverKeyRaw: raw,
  };
}

const freshNonce = (): string => randomBytes(32).toString('base64');

/** A hello as an ssh node sends it: the minor that carries a nonce, and the key it names. */
function sshHello(id: Identity, nonce: string = freshNonce()): HelloFrame {
  return {
    ...hello(id.machineId),
    protocol: { major: 1, minor: LINK_PROTOCOL.minor },
    serverKey: id.serverKeyRaw.toString('base64'),
    nonce,
  };
}

/** The proof a real node runs: its signature over the peer's nonce, checked against its own. */
function proofOf(id: Identity, ownNonce: string): HelloProof {
  return {
    sign: (peerNonce, peerMachineId) => signProof(id, peerNonce, peerMachineId),
    verify: (peer, sig) => verifyProof(peer.serverKey, sig, ownNonce, peer.machineId, id.machineId),
  };
}

/**
 * Our side is a real connection; the far side is a hand-written peer that sends exactly the frames
 * a test names, so each malformed handshake can be built on purpose.
 */
function handPeer() {
  const toOurs = new PassThrough();
  const fromOurs = new PassThrough();
  const far = {
    send: (frame: LinkFrame) => {
      toOurs.write(encodeFrame(frame));
    },
  };
  return { stream: bridge(toOurs, fromOurs), far };
}

/** Two stream ends, each reading what the other writes: the ssh stream between two nodes. */
function sshDuplexPair() {
  const ab = new PassThrough();
  const ba = new PassThrough();
  return { sideA: bridge(ba, ab), sideB: bridge(ab, ba) };
}

const refusedWith = (r: LinkConnection | { error: string }): string =>
  'error' in r ? r.error : 'up';

describe('ssh proof of possession (plan F1)', () => {
  it('two real ssh nodes prove their keys to each other and come up', async () => {
    const A = keyed();
    const B = keyed();
    const na = freshNonce();
    const nb = freshNonce();
    const { sideA, sideB } = sshDuplexPair();
    const [ca, cb] = await Promise.all([
      openConnection(sideA, {
        hello: sshHello(A, na),
        now: () => Date.now(),
        log: quiet,
        proof: proofOf(A, na),
      }),
      openConnection(sideB, {
        hello: sshHello(B, nb),
        now: () => Date.now(),
        log: quiet,
        proof: proofOf(B, nb),
      }),
    ]);
    if ('error' in ca || 'error' in cb) throw new Error('connection failed');
    conns.push(ca, cb);
    expect(ca.peerHello.machineId).toBe(B.machineId);
    expect(cb.peerHello.machineId).toBe(A.machineId);
  });

  it('a proof signed by another key is bad-proof, and the peer is named in the refusal', async () => {
    const A = keyed();
    const B = keyed();
    const impostor = keyed();
    const na = freshNonce();
    const { stream, far } = handPeer();
    const pending = openConnection(stream, {
      hello: sshHello(A, na),
      now: () => Date.now(),
      log: quiet,
      proof: proofOf(A, na),
    });
    far.send(sshHello(B));
    far.send({ t: 'hello.proof', sig: signProof(impostor, na, A.machineId) });
    const r = await pending;
    expect('error' in r && r.error).toBe('bad-proof');
    expect('error' in r ? r.peerHello?.machineId : null).toBe(B.machineId);
  });

  it('a proof over an older nonce is a replay, and is bad-proof', async () => {
    const A = keyed();
    const B = keyed();
    const na = freshNonce();
    const { stream, far } = handPeer();
    const pending = openConnection(stream, {
      hello: sshHello(A, na),
      now: () => Date.now(),
      log: quiet,
      proof: proofOf(A, na),
    });
    far.send(sshHello(B));
    far.send({ t: 'hello.proof', sig: signProof(B, freshNonce(), A.machineId) });
    expect(refusedWith(await pending)).toBe('bad-proof');
  });

  it('a proof that binds other machine ids is bad-proof', async () => {
    const A = keyed();
    const B = keyed();
    const na = freshNonce();
    const { stream, far } = handPeer();
    const pending = openConnection(stream, {
      hello: sshHello(A, na),
      now: () => Date.now(),
      log: quiet,
      proof: proofOf(A, na),
    });
    far.send(sshHello(B));
    far.send({ t: 'hello.proof', sig: signProof(B, na, 'm-00000000') });
    expect(refusedWith(await pending)).toBe('bad-proof');
  });

  it('a peer that never sends its proof is bad-proof when the hello timeout passes', async () => {
    const A = keyed();
    const B = keyed();
    const na = freshNonce();
    const { stream, far } = handPeer();
    const pending = openConnection(stream, {
      hello: sshHello(A, na),
      now: () => Date.now(),
      log: quiet,
      proof: proofOf(A, na),
      helloTimeoutMs: 50,
    });
    far.send(sshHello(B));
    expect(refusedWith(await pending)).toBe('bad-proof');
  });

  it('a hello with no nonce is bad-proof, not accepted on its key alone', async () => {
    const A = keyed();
    const B = keyed();
    const na = freshNonce();
    const { stream, far } = handPeer();
    const pending = openConnection(stream, {
      hello: sshHello(A, na),
      now: () => Date.now(),
      log: quiet,
      proof: proofOf(A, na),
    });
    const { nonce: _nonce, ...withoutNonce } = sshHello(B);
    far.send(withoutNonce);
    expect(refusedWith(await pending)).toBe('bad-proof');
  });

  it('a peer below the proof minor is incompatible, whatever it sends', async () => {
    const A = keyed();
    const B = keyed();
    const na = freshNonce();
    const { stream, far } = handPeer();
    const pending = openConnection(stream, {
      hello: sshHello(A, na),
      now: () => Date.now(),
      log: quiet,
      proof: proofOf(A, na),
    });
    const { nonce: _nonce, ...withoutNonce } = sshHello(B);
    far.send({ ...withoutNonce, protocol: { major: 1, minor: LINK_PROTOCOL.minor - 1 } });
    const r = await pending;
    expect('error' in r && r.error).toBe('incompatible');
    expect('error' in r ? r.peerHello?.machineId : null).toBe(B.machineId);
  });

  it('a frame that arrives before the proof is a protocol error', async () => {
    const A = keyed();
    const B = keyed();
    const na = freshNonce();
    const { stream, far } = handPeer();
    const pending = openConnection(stream, {
      hello: sshHello(A, na),
      now: () => Date.now(),
      log: quiet,
      proof: proofOf(A, na),
    });
    far.send(sshHello(B));
    far.send({ t: 'ping' });
    expect(refusedWith(await pending)).toBe('bad-proof');
  });

  it('a proof sent on a link that never asked for one closes it as bad-proof', async () => {
    const A = keyed();
    const B = keyed();
    const closes: string[] = [];
    const { stream, far } = handPeer();
    const pending = openConnection(stream, {
      hello: hello(A.machineId),
      now: () => Date.now(),
      log: quiet,
    });
    far.send(hello(B.machineId));
    far.send({ t: 'hello.proof', sig: signProof(B, freshNonce(), A.machineId) });
    const c = await pending;
    if ('error' in c) throw new Error('connection failed');
    conns.push(c);
    c.start({ onFrame: () => undefined, onClose: (why) => closes.push(why) });
    await until(() => closes.length > 0);
    expect(closes).toEqual(['bad-proof']);
  });

  it('a link with no proof option still comes up when both hellos carry nonces', async () => {
    const A = keyed();
    const B = keyed();
    const { sideA, sideB } = sshDuplexPair();
    const [ca, cb] = await Promise.all([
      openConnection(sideA, { hello: sshHello(A), now: () => Date.now(), log: quiet }),
      openConnection(sideB, { hello: sshHello(B), now: () => Date.now(), log: quiet }),
    ]);
    if ('error' in ca || 'error' in cb) throw new Error('connection failed');
    conns.push(ca, cb);
    expect(ca.peerHello.machineId).toBe(B.machineId);
  });
});
