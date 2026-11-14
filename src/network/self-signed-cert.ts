import { type KeyObject, sign } from 'node:crypto';

// see docs/plans/2026-11-14-conduit-network-machinery.plan.md decision 4: the certificate is only a
// container for the server key. Peers authorize by pinning that key, never by the chain, so this
// encodes the smallest X.509 v3 OpenSSL accepts for TLS 1.3 and nothing more.

const ED25519_ALG = Buffer.from([0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70]); // SEQ { OID 1.3.101.112 }
const CN_OID = Buffer.from([0x06, 0x03, 0x55, 0x04, 0x03]);

function derLength(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  if (n < 0x100) return Buffer.from([0x81, n]);
  if (n < 0x10000) return Buffer.from([0x82, n >> 8, n & 0xff]);
  throw new Error('DER element too long');
}

const tlv = (tag: number, body: Buffer): Buffer =>
  Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);
const sequence = (...items: Buffer[]): Buffer => tlv(0x30, Buffer.concat(items));

function name(commonName: string): Buffer {
  const attribute = sequence(CN_OID, tlv(0x0c, Buffer.from(commonName, 'utf8')));
  return sequence(tlv(0x31, attribute));
}

// GeneralizedTime for both ends: UTCTime can't express 9999, and the link never expires by date.
const VALIDITY = sequence(
  tlv(0x18, Buffer.from('20000101000000Z', 'ascii')),
  tlv(0x18, Buffer.from('99991231235959Z', 'ascii')),
);

const SAN_OID = Buffer.from([0x06, 0x03, 0x55, 0x1d, 0x11]);

/** [3] extensions with one SAN dNSName, so Node's default host check passes for servername=CN. */
function subjectAltName(dnsName: string): Buffer {
  const names = sequence(tlv(0x82, Buffer.from(dnsName, 'ascii')));
  return tlv(0xa3, sequence(sequence(SAN_OID, tlv(0x04, names))));
}

export function rawEd25519(publicKey: KeyObject): Buffer {
  if (publicKey.asymmetricKeyType !== 'ed25519') throw new Error('expected an Ed25519 key');
  const { x } = publicKey.export({ format: 'jwk' });
  if (typeof x !== 'string') throw new Error('Ed25519 key without x');
  return Buffer.from(x, 'base64url');
}

export function selfSignedCert(
  keys: { publicKey: KeyObject; privateKey: KeyObject },
  commonName: string,
): string {
  rawEd25519(keys.publicKey);
  const subject = name(commonName);
  const tbs = sequence(
    tlv(0xa0, tlv(0x02, Buffer.from([0x02]))), // [0] version v3
    tlv(0x02, Buffer.from([0x01])),
    ED25519_ALG,
    subject,
    VALIDITY,
    subject,
    keys.publicKey.export({ type: 'spki', format: 'der' }),
    subjectAltName(commonName),
  );
  const signature = sign(null, tbs, keys.privateKey);
  const der = sequence(
    tbs,
    ED25519_ALG,
    tlv(0x03, Buffer.concat([Buffer.from([0x00]), signature])),
  );
  const lines = der.toString('base64').match(/.{1,64}/g) ?? [];
  return `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----\n`;
}
