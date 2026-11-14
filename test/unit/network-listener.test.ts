import { generateKeyPairSync } from 'node:crypto';
import type tls from 'node:tls';
import { afterEach, describe, expect, it } from 'vitest';
import {
  dial,
  formatHostPort,
  type Listener,
  listen,
  type PeerClass,
  parseHostPort,
} from '../../server/network/listener';
import { rawEd25519, selfSignedCert } from '../../src/network/self-signed-cert';

function server(name: string) {
  const k = generateKeyPairSync('ed25519');
  return {
    raw: rawEd25519(k.publicKey),
    cert: selfSignedCert(k, name),
    key: k.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}
const quiet = { debug: () => undefined, warn: () => undefined };
const open: Listener[] = [];
afterEach(async () => {
  for (const l of open.splice(0)) await l.close();
});

async function start(
  a: ReturnType<typeof server>,
  classify: (k: Buffer) => PeerClass,
  seen: { link: Buffer[]; pairing: Buffer[] },
) {
  const keep = (sock: tls.TLSSocket) => {
    sock.resume();
    sock.end('ok');
  };
  const l = await listen({
    hosts: ['127.0.0.1'],
    port: 0,
    cert: a.cert,
    key: a.key,
    classify,
    onLink: (sock, k) => {
      seen.link.push(k);
      keep(sock);
    },
    onPairing: (sock, k) => {
      seen.pairing.push(k);
      keep(sock);
    },
    log: quiet,
  });
  open.push(l);
  const address = l.addresses()[0];
  if (!address) throw new Error('no address');
  return address;
}

const readAll = (sock: tls.TLSSocket) =>
  new Promise<string>((resolve) => {
    let out = '';
    sock.on('data', (d: Buffer) => {
      out += d.toString();
    });
    sock.on('close', () => resolve(out));
    sock.resume();
  });

describe('link listener and dial', () => {
  it('a pinned peer reaches onLink and each side sees the other key', async () => {
    const a = server('m-aaaaaaaa');
    const b = server('m-bbbbbbbb');
    const seen = { link: [] as Buffer[], pairing: [] as Buffer[] };
    const address = await start(a, (k) => (k.equals(b.raw) ? 'link' : 'reject'), seen);
    const { sock, peerKeyRaw } = await dial({
      address,
      cert: b.cert,
      key: b.key,
      expectKeyRaw: a.raw,
      timeoutMs: 5000,
    });
    expect(peerKeyRaw.equals(a.raw)).toBe(true);
    expect(await readAll(sock)).toBe('ok');
    expect(seen.link.map((k) => k.equals(b.raw))).toEqual([true]);
  });

  it('an unpinned client is destroyed before anything is read', async () => {
    const a = server('m-aaaaaaaa');
    const b = server('m-bbbbbbbb');
    const stranger = server('m-cccccccc');
    const seen = { link: [] as Buffer[], pairing: [] as Buffer[] };
    const address = await start(a, (k) => (k.equals(b.raw) ? 'link' : 'reject'), seen);
    const { sock } = await dial({
      address,
      cert: stranger.cert,
      key: stranger.key,
      expectKeyRaw: a.raw,
      timeoutMs: 5000,
    });
    expect(await readAll(sock)).toBe('');
    expect(seen.link).toEqual([]);
    expect(seen.pairing).toEqual([]);
  });

  it('a dial whose server presents another key fails with pin_mismatch', async () => {
    const a = server('m-aaaaaaaa');
    const b = server('m-bbbbbbbb');
    const seen = { link: [] as Buffer[], pairing: [] as Buffer[] };
    const address = await start(a, () => 'link', seen);
    await expect(
      dial({
        address,
        cert: b.cert,
        key: b.key,
        expectKeyRaw: server('m-dddddddd').raw,
        timeoutMs: 5000,
      }),
    ).rejects.toThrow('pin_mismatch');
  });

  it('an unknown key classified as pairing reaches onPairing', async () => {
    const a = server('m-aaaaaaaa');
    const joiner = server('m-eeeeeeee');
    const seen = { link: [] as Buffer[], pairing: [] as Buffer[] };
    const address = await start(a, () => 'pairing', seen);
    const { sock, peerKeyRaw } = await dial({
      address,
      cert: joiner.cert,
      key: joiner.key,
      expectKeyRaw: null,
      timeoutMs: 5000,
    });
    expect(peerKeyRaw.equals(a.raw)).toBe(true);
    expect(await readAll(sock)).toBe('ok');
    expect(seen.pairing.map((k) => k.equals(joiner.raw))).toEqual([true]);
  });

  it('a client with no certificate is refused', async () => {
    const a = server('m-aaaaaaaa');
    const seen = { link: [] as Buffer[], pairing: [] as Buffer[] };
    const address = await start(a, () => 'link', seen);
    const target = parseHostPort(address);
    if (!target) throw new Error('bad address');
    const { connect } = await import('node:tls');
    const out = await new Promise<string>((resolve) => {
      const s = connect({
        host: target.host,
        port: target.port,
        minVersion: 'TLSv1.3',
        rejectUnauthorized: false,
        checkServerIdentity: () => undefined,
      });
      let got = '';
      s.on('data', (d: Buffer) => {
        got += d.toString();
      });
      s.on('error', () => undefined);
      s.on('close', () => resolve(got));
    });
    expect(out).toBe('');
    expect(seen.link).toEqual([]);
  });

  it('parses and formats host:port for IPv4 and IPv6', () => {
    expect(parseHostPort('127.0.0.1:47391')).toEqual({ host: '127.0.0.1', port: 47391 });
    expect(parseHostPort('[fd7a::1]:80')).toEqual({ host: 'fd7a::1', port: 80 });
    expect(parseHostPort('win-box:47391')).toEqual({ host: 'win-box', port: 47391 });
    expect(parseHostPort('127.0.0.1')).toBeNull();
    expect(parseHostPort('127.0.0.1:0')).toBeNull();
    expect(parseHostPort('127.0.0.1:70000')).toBeNull();
    expect(formatHostPort('fd7a::1', 80)).toBe('[fd7a::1]:80');
    expect(formatHostPort('127.0.0.1', 80)).toBe('127.0.0.1:80');
  });
});
