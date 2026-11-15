import { createHash } from 'node:crypto';

// see docs/plans/2026-11-14-conduit-network-machinery.plan.md decision 3 (numeric comparison with a
// commitment). Every input is fixed-length (32-byte keys, nonces and identity digests), so plain
// concatenation is unambiguous and needs no length prefixes.

const PAIRING_KEY_BYTES = 32;
export const PAIRING_NONCE_BYTES = 32;

const COMMIT_LABEL = Buffer.from('conduit-pair-commit-v2', 'ascii');
const FINGERPRINT_LABEL = Buffer.from('conduit-pair-v3', 'ascii');
const IDENTITY_LABEL = Buffer.from('conduit-pair-id-v1', 'ascii');
const DIGEST_BYTES = 32;
const LINK_LABEL = Buffer.from('conduit-link-id-v1', 'ascii');
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

function fixed(b: Buffer, n: number, what: string): Buffer {
  if (b.length !== n) throw new Error(`${what} must be ${n} bytes`);
  return b;
}

const sha256 = (...parts: Buffer[]): Buffer => {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest();
};

/**
 * The joiner's commitment, sent before it sees anything of the opener's: it fixes the joiner's
 * key, nonce and whole identity, so none of them can be ground against the opener's nonce
 * (CON-27 re-review R1).
 */
export function commitment(pkJoiner: Buffer, nonce: Buffer, idJoiner: Buffer): Buffer {
  return sha256(
    COMMIT_LABEL,
    fixed(pkJoiner, PAIRING_KEY_BYTES, 'key'),
    fixed(nonce, PAIRING_NONCE_BYTES, 'nonce'),
    fixed(idJoiner, DIGEST_BYTES, 'identity digest'),
  );
}

/** What a pair.id announces, as the fingerprint binds it. */
export interface PairingIdentity {
  machineId: string;
  ownerKey: string | null;
  ownerOffer: string | null;
  selfName: string;
  addresses: string[];
  protocol: { major: number; minor: number };
  cert: string;
}

/**
 * A fixed-length digest of one pair.id. The fields go in as a JSON array in a fixed order, so the
 * encoding is canonical whatever key order the message arrived with (CON-27 review minor 1).
 */
export function identityDigest(id: PairingIdentity): Buffer {
  const canonical = JSON.stringify([
    id.machineId,
    id.ownerKey,
    id.ownerOffer,
    id.selfName,
    id.addresses,
    id.protocol.major,
    id.protocol.minor,
    id.cert,
  ]);
  return sha256(IDENTITY_LABEL, Buffer.from(canonical, 'utf8'));
}

/**
 * 32 bits shown as `XXXX-XXXX`; the commitment holds an attacker to one guess per window. Both
 * identities are in it, so a relay that changes a name, an address or an owner key shows each
 * person a different value.
 */
export function fingerprint(
  pkOpener: Buffer,
  pkJoiner: Buffer,
  nOpener: Buffer,
  nJoiner: Buffer,
  idOpener: Buffer,
  idJoiner: Buffer,
): string {
  const hex = sha256(
    FINGERPRINT_LABEL,
    fixed(pkOpener, PAIRING_KEY_BYTES, 'key'),
    fixed(pkJoiner, PAIRING_KEY_BYTES, 'key'),
    fixed(nOpener, PAIRING_NONCE_BYTES, 'nonce'),
    fixed(nJoiner, PAIRING_NONCE_BYTES, 'nonce'),
    fixed(idOpener, DIGEST_BYTES, 'identity digest'),
    fixed(idJoiner, DIGEST_BYTES, 'identity digest'),
  )
    .subarray(0, 4)
    .toString('hex')
    .toUpperCase();
  return `${hex.slice(0, 4)}-${hex.slice(4)}`;
}

function base32(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out;
}

/** The same on both servers whichever opened the window: the keys are sorted first. */
export function linkIdFor(a: Buffer, b: Buffer): string {
  const [lo, hi] = Buffer.compare(a, b) <= 0 ? [a, b] : [b, a];
  return `l_${base32(sha256(LINK_LABEL, fixed(lo, PAIRING_KEY_BYTES, 'key'), fixed(hi, PAIRING_KEY_BYTES, 'key'))).slice(0, 16)}`;
}
