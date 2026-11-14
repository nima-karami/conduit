import { generateKeyPairSync } from 'node:crypto';
import type tls from 'node:tls';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type ConnectionOptions,
  type LinkConnection,
  openConnection,
} from '../../server/network/link-connection';
import { dial, type Listener, listen } from '../../server/network/listener';
import type { HelloFrame, LinkFrame } from '../../src/contracts/link-protocol';
import { rawEd25519, selfSignedCert } from '../../src/network/self-signed-cert';

const quiet = { debug: () => undefined, warn: () => undefined };
const open: Listener[] = [];
const conns: LinkConnection[] = [];
afterEach(async () => {
  for (const c of conns.splice(0)) c.close('test-end');
  for (const l of open.splice(0)) await l.close();
});

function server(name: string) {
  const k = generateKeyPairSync('ed25519');
  return {
    raw: rawEd25519(k.publicKey),
    cert: selfSignedCert(k, name),
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
  const A = server('m-aaaaaaaa');
  const B = server('m-bbbbbbbb');
  let accepted: (s: tls.TLSSocket) => void = () => undefined;
  const gotA = new Promise<tls.TLSSocket>((r) => {
    accepted = r;
  });
  const l = await listen({
    hosts: ['127.0.0.1'],
    port: 0,
    cert: A.cert,
    key: A.key,
    classify: (k) => (k.equals(B.raw) ? 'link' : 'reject'),
    onLink: (sock) => accepted(sock),
    onPairing: (sock) => sock.destroy(),
    log: quiet,
  });
  open.push(l);
  const address = l.addresses()[0] ?? '';
  const { sock: b } = await dial({
    address,
    cert: B.cert,
    key: B.key,
    expectKeyRaw: A.raw,
    timeoutMs: 5000,
  });
  return { a: await gotA, b };
}

function base(h: HelloFrame, frames: LinkFrame[], closes: string[]): ConnectionOptions {
  return {
    hello: h,
    onFrame: (f) => frames.push(f),
    onClose: (why) => closes.push(why),
    now: () => Date.now(),
    log: quiet,
  };
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
      openConnection(a, base(hello('m-aaaaaaaa'), fa, [])),
      openConnection(b, base(hello('m-bbbbbbbb'), fb, [])),
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

  it('a different protocol major is incompatible on both sides', async () => {
    const { a, b } = await socketPair();
    const [ca, cb] = await Promise.all([
      openConnection(a, base(hello('m-aaaaaaaa', 1), [], [])),
      openConnection(b, base(hello('m-bbbbbbbb', 2), [], [])),
    ]);
    expect('error' in ca && ca.error).toBe('incompatible');
    expect('error' in cb && cb.error).toBe('incompatible');
  });

  it('a first frame that is not a hello is bad-hello', async () => {
    const { a, b } = await socketPair();
    const pending = openConnection(a, base(hello('m-aaaaaaaa'), [], []));
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
      openConnection(a, {
        ...base(hello('m-aaaaaaaa'), [], closes),
        now: () => now,
        every: (fn) => {
          tickA.push(fn);
          return () => undefined;
        },
      }),
      openConnection(b, base(hello('m-bbbbbbbb'), [], [])),
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

  it('a socket closed by the peer reports closed once', async () => {
    const { a, b } = await socketPair();
    const closes: string[] = [];
    const [ca, cb] = await Promise.all([
      openConnection(a, base(hello('m-aaaaaaaa'), [], closes)),
      openConnection(b, base(hello('m-bbbbbbbb'), [], [])),
    ]);
    if ('error' in ca || 'error' in cb) throw new Error('connection failed');
    cb.close('shutdown');
    await until(() => closes.length > 0);
    expect(closes).toEqual(['closed']);
  });
});
