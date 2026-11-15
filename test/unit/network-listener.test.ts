import { generateKeyPairSync } from 'node:crypto';
import type net from 'node:net';
import type tls from 'node:tls';
import { afterEach, describe, expect, it } from 'vitest';
import {
  dial,
  dialPairing,
  formatHostPort,
  type Listener,
  listenLinks,
  listenPairing,
  parseHostPort,
} from '../../server/network/listener';
import { deriveMachineId } from '../../src/network/identity-file';
import { rawEd25519, selfSignedCert } from '../../src/network/self-signed-cert';

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
type Server = ReturnType<typeof server>;
const quiet = { debug: () => undefined, warn: () => undefined };
const open: Listener[] = [];
afterEach(async () => {
  for (const l of open.splice(0)) await l.close();
});

async function links(
  a: Server,
  trusted: () => string[],
  knows: (k: Buffer) => boolean,
  seen: Buffer[],
) {
  const l = await listenLinks({
    hosts: ['127.0.0.1'],
    port: 0,
    cert: a.cert,
    key: a.key,
    trustedCerts: trusted,
    knows,
    onLink: (sock: tls.TLSSocket, k: Buffer) => {
      seen.push(k);
      sock.resume();
      sock.end('ok');
    },
    log: quiet,
  });
  open.push(l);
  return { l, address: l.addresses()[0] ?? '' };
}

const readAll = (sock: net.Socket) =>
  new Promise<string>((resolve) => {
    let out = '';
    sock.on('data', (d: Buffer) => {
      out += d.toString();
    });
    sock.on('error', () => undefined);
    sock.on('close', () => resolve(out));
    sock.resume();
  });

const dialFrom = (me: Server, to: Server, address: string) =>
  dial({
    address,
    cert: me.cert,
    key: me.key,
    peerCert: to.cert,
    peerMachineId: to.machineId,
    expectKeyRaw: to.raw,
    timeoutMs: 5000,
  });

describe('link listener and dial', () => {
  it('a pinned peer connects with full verification and each side sees the other key', async () => {
    const a = server();
    const b = server();
    const seen: Buffer[] = [];
    const { address } = await links(
      a,
      () => [b.cert],
      (k) => k.equals(b.raw),
      seen,
    );
    const { sock, peerKeyRaw } = await dialFrom(b, a, address);
    expect(sock.authorized).toBe(true);
    expect(peerKeyRaw.equals(a.raw)).toBe(true);
    expect(await readAll(sock)).toBe('ok');
    expect(seen.map((k) => k.equals(b.raw))).toEqual([true]);
  });

  it('a client whose certificate is not a trusted CA fails the handshake', async () => {
    const a = server();
    const b = server();
    const stranger = server();
    const seen: Buffer[] = [];
    const { address } = await links(
      a,
      () => [b.cert],
      () => true,
      seen,
    );
    const r = await dialFrom(stranger, a, address).then(
      async ({ sock }) => readAll(sock),
      () => 'refused',
    );
    expect(['refused', '']).toContain(r);
    expect(seen).toEqual([]);
  });

  it('a verified peer the pin no longer knows is destroyed before anything is read', async () => {
    const a = server();
    const b = server();
    const seen: Buffer[] = [];
    const { address } = await links(
      a,
      () => [b.cert],
      () => false,
      seen,
    );
    const r = await dialFrom(b, a, address).then(
      async ({ sock }) => readAll(sock),
      () => 'refused',
    );
    expect(['refused', '']).toContain(r);
    expect(seen).toEqual([]);
  });

  it('a dial whose server presents another certificate fails verification', async () => {
    const a = server();
    const b = server();
    const impostor = server();
    const { address } = await links(
      impostor,
      () => [b.cert],
      () => true,
      [],
    );
    await expect(dialFrom(b, a, address)).rejects.toThrow();
  });

  it('refreshTrust admits a newly linked peer without restarting the listener', async () => {
    const a = server();
    const b = server();
    const trusted: string[] = [];
    const seen: Buffer[] = [];
    const { l, address } = await links(
      a,
      () => trusted,
      () => true,
      seen,
    );
    const before = await dialFrom(b, a, address).then(
      async ({ sock }) => readAll(sock),
      () => 'refused',
    );
    expect(['refused', '']).toContain(before);
    trusted.push(b.cert);
    l.refreshTrust();
    const { sock } = await dialFrom(b, a, address);
    expect(await readAll(sock)).toBe('ok');
  });
});

describe('pairing listener', () => {
  it('a plain connection reaches onPairing, paused, with its bytes intact', async () => {
    const got = new Promise<string>((resolve) => {
      void listenPairing({
        hosts: ['127.0.0.1'],
        port: 0,
        onPairing: (sock) => {
          let data = '';
          sock.on('data', (d: Buffer) => {
            data += d.toString();
            if (data === 'hello') {
              resolve(data);
              sock.end();
            }
          });
          sock.resume();
        },
        log: quiet,
      }).then((l) => {
        open.push(l);
        void dialPairing(l.addresses()[0] ?? '', 5000).then((s) => {
          s.end('hello');
        });
      });
    });
    expect(await got).toBe('hello');
  });

  it('dialPairing to a closed port rejects', async () => {
    const l = await listenPairing({
      hosts: ['127.0.0.1'],
      port: 0,
      onPairing: () => undefined,
      log: quiet,
    });
    const address = l.addresses()[0] ?? '';
    await l.close();
    await expect(dialPairing(address, 2000)).rejects.toThrow();
  });
});

describe('addresses', () => {
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
