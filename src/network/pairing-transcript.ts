import { createHash } from 'node:crypto';

// see docs/plans/2026-11-14-conduit-network-machinery.plan.md decision 3 (numeric comparison with a
// commitment). Every input is fixed-length (32-byte keys and nonces), so plain concatenation is
// unambiguous and needs no length prefixes.

const PAIRING_KEY_BYTES = 32;
export const PAIRING_NONCE_BYTES = 32;

const COMMIT_LABEL = Buffer.from('conduit-pair-commit-v1', 'ascii');
const FINGERPRINT_LABEL = Buffer.from('conduit-pair-v1', 'ascii');
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

export function commitment(pkJoiner: Buffer, nonce: Buffer): Buffer {
  return sha256(
    COMMIT_LABEL,
    fixed(pkJoiner, PAIRING_KEY_BYTES, 'key'),
    fixed(nonce, PAIRING_NONCE_BYTES, 'nonce'),
  );
}

/** 32 bits shown as `XXXX-XXXX`; the commitment holds an attacker to one guess per window. */
export function fingerprint(
  pkOpener: Buffer,
  pkJoiner: Buffer,
  nOpener: Buffer,
  nJoiner: Buffer,
): string {
  const hex = sha256(
    FINGERPRINT_LABEL,
    fixed(pkOpener, PAIRING_KEY_BYTES, 'key'),
    fixed(pkJoiner, PAIRING_KEY_BYTES, 'key'),
    fixed(nOpener, PAIRING_NONCE_BYTES, 'nonce'),
    fixed(nJoiner, PAIRING_NONCE_BYTES, 'nonce'),
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
