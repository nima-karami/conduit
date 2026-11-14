import { generateKeyPairSync, X509Certificate } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import tls from 'node:tls';
import { describe, expect, it } from 'vitest';
import { rawEd25519, selfSignedCert } from '../../src/network/self-signed-cert';

const keys = () => generateKeyPairSync('ed25519');

describe('selfSignedCert', () => {
  it('parses, verifies against its own key and names the subject', () => {
    const k = keys();
    const x = new X509Certificate(selfSignedCert(k, 'm-0123abcd'));
    expect(x.verify(k.publicKey)).toBe(true);
    expect(x.subject).toBe('CN=m-0123abcd');
    expect(x.issuer).toBe('CN=m-0123abcd');
    expect(rawEd25519(x.publicKey).equals(rawEd25519(k.publicKey))).toBe(true);
  });

  it('does not verify against another key', () => {
    const x = new X509Certificate(selfSignedCert(keys(), 'm-00000000'));
    expect(x.verify(keys().publicKey)).toBe(false);
  });

  it('rawEd25519 is the 32-byte key and refuses non-Ed25519 keys', () => {
    expect(rawEd25519(keys().publicKey)).toHaveLength(32);
    const { publicKey } = generateKeyPairSync('x25519');
    expect(() => rawEd25519(publicKey)).toThrow();
  });

  it('carries a TLS 1.3 mutual-auth handshake where each side sees the other key', async () => {
    const a = keys();
    const b = keys();
    const pem = (k: ReturnType<typeof keys>) =>
      k.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const base = {
      minVersion: 'TLSv1.3',
      maxVersion: 'TLSv1.3',
      rejectUnauthorized: false,
    } as const;
    const seen = await new Promise<{ server: Buffer; client: Buffer }>((resolve, reject) => {
      let serverSaw: Buffer | null = null;
      const srv = tls.createServer(
        { ...base, key: pem(a), cert: selfSignedCert(a, 'm-aaaaaaaa'), requestCert: true },
        (s) => {
          serverSaw = rawEd25519(s.getPeerX509Certificate()?.publicKey ?? a.publicKey);
          s.end();
        },
      );
      srv.listen(0, '127.0.0.1', () => {
        const c = tls.connect({
          ...base,
          port: (srv.address() as AddressInfo).port,
          host: '127.0.0.1',
          key: pem(b),
          cert: selfSignedCert(b, 'm-bbbbbbbb'),
          checkServerIdentity: () => undefined,
        });
        c.on('secureConnect', () => {
          const peer = c.getPeerX509Certificate();
          c.on('close', () => {
            srv.close();
            if (!peer || !serverSaw) reject(new Error('no peer certificate'));
            else resolve({ server: serverSaw, client: rawEd25519(peer.publicKey) });
          });
          c.resume();
        });
        c.on('error', reject);
      });
    });
    expect(seen.server.equals(rawEd25519(b.publicKey))).toBe(true);
    expect(seen.client.equals(rawEd25519(a.publicKey))).toBe(true);
  });
});
