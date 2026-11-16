import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
  sign,
  verify as verifySignature,
} from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { atomicWriteFileSync } from '../../src/atomic-write';
import {
  deriveMachineId,
  type IdentityFile,
  parseIdentityFile,
  serializeIdentityFile,
} from '../../src/network/identity-file';

export interface Identity {
  machineId: string;
  serverPublicKey: KeyObject;
  serverPrivateKey: KeyObject;
  ownerKey: { publicKey: KeyObject; privateKey: KeyObject } | null;
  serverKeyRaw: Buffer;
}

export interface IdentityIo {
  read(path: string): string | null;
  write(path: string, text: string): void;
  rename(from: string, to: string): void;
}

type KeyPair = { publicKey: KeyObject; privateKey: KeyObject };

const FILE = 'identity.json';
const CORRUPT_FILE = 'identity.corrupt.json';

const isMissing = (e: unknown): boolean =>
  typeof e === 'object' && e !== null && (e as NodeJS.ErrnoException).code === 'ENOENT';

const defaultIo: IdentityIo = {
  read(p) {
    try {
      return fs.readFileSync(p, 'utf8');
    } catch (e) {
      if (isMissing(e)) return null;
      throw e;
    }
  },
  write(p, text) {
    // POSIX modes keep the private keys owner-only; Windows ignores them and relies on the
    // per-user userData ACL, as tokens.json does.
    fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
    atomicWriteFileSync(p, text, fs, { mode: 0o600 });
  },
  rename(from, to) {
    fs.renameSync(from, to);
  },
};

const encodePair = (pair: KeyPair): IdentityFile['serverKey'] => ({
  publicKey: pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
  privateKey: pair.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
});

function importPublic(b64: string): KeyObject | null {
  try {
    const key = createPublicKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'spki' });
    return key.asymmetricKeyType === 'ed25519' ? key : null;
  } catch {
    return null;
  }
}

function importPrivate(b64: string): KeyObject | null {
  try {
    const key = createPrivateKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'pkcs8' });
    return key.asymmetricKeyType === 'ed25519' ? key : null;
  } catch {
    return null;
  }
}

/** SPKI header of a raw Ed25519 public key (RFC 8410); the 32 key bytes follow it. */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/**
 * The bytes an ssh peer signs to show it holds its server key. The peer's nonce and both machine
 * ids are in them, so a proof cannot be replayed on another connection or for another pair of
 * machines (plan F1).
 */
export function proofPayload(
  peerNonce: string,
  ownMachineId: string,
  peerMachineId: string,
): Buffer {
  return Buffer.from(
    `conduit-link-proof-v1\n${peerNonce}\n${ownMachineId}\n${peerMachineId}`,
    'utf8',
  );
}

/** Our proof for a peer whose hello carried `peerNonce` and named `peerMachineId`. */
export function signProof(identity: Identity, peerNonce: string, peerMachineId: string): string {
  const payload = proofPayload(peerNonce, identity.machineId, peerMachineId);
  return sign(null, payload, identity.serverPrivateKey).toString('base64');
}

/**
 * Whether `sig` is the peer's proof over our `ownNonce`, for the key its hello named. The raw key
 * is wrapped as SPKI so the same importPublic check as stored keys applies.
 */
export function verifyProof(
  peerServerKeyB64: string,
  sig: string,
  ownNonce: string,
  peerMachineId: string,
  ownMachineId: string,
): boolean {
  const raw = Buffer.from(peerServerKeyB64, 'base64');
  const signature = Buffer.from(sig, 'base64');
  if (raw.length !== 32 || signature.length !== 64) return false;
  const key = importPublic(Buffer.concat([ED25519_SPKI_PREFIX, raw]).toString('base64'));
  if (key === null) return false;
  const payload = proofPayload(ownNonce, peerMachineId, ownMachineId);
  return verifySignature(null, payload, key, signature);
}

function decodePair(stored: { publicKey: string; privateKey: string }): KeyPair | null {
  const publicKey = importPublic(stored.publicKey);
  const privateKey = importPrivate(stored.privateKey);
  return publicKey && privateKey ? { publicKey, privateKey } : null;
}

function rawPublicKey(publicKey: KeyObject): Buffer {
  const { x } = publicKey.export({ format: 'jwk' });
  if (x === undefined) throw new Error('an Ed25519 public key exports without x');
  return Buffer.from(x, 'base64url');
}

function toIdentity(server: KeyPair, owner: KeyPair | null): Identity {
  const serverKeyRaw = rawPublicKey(server.publicKey);
  return {
    machineId: deriveMachineId(serverKeyRaw),
    serverPublicKey: server.publicKey,
    serverPrivateKey: server.privateKey,
    ownerKey: owner,
    serverKeyRaw,
  };
}

function save(dir: string, io: IdentityIo, server: KeyPair, owner: KeyPair | null): void {
  const file: IdentityFile = {
    version: 1,
    serverKey: encodePair(server),
    ownerKey: owner === null ? null : encodePair(owner),
  };
  io.write(path.join(dir, FILE), serializeIdentityFile(file));
}

function create(dir: string, io: IdentityIo): Identity {
  const server = generateKeyPairSync('ed25519');
  save(dir, io, server, null);
  return toIdentity(server, null);
}

/**
 * Loads `<dir>/identity.json` (`dir` is userData/network), creating it on first start. A file that
 * cannot be read is moved aside to identity.corrupt.json and replaced, since a server with no
 * identity cannot pair. A newer build's file is never written: the caller runs without it.
 */
// see docs/plans/2026-11-14-conduit-network-machinery.plan.md, Technical decision 2
export type LoadedIdentity =
  | { kind: 'loaded' | 'created'; identity: Identity }
  /** The old file was moved to identity.corrupt.json: a new machine id, so every link is lost. */
  | { kind: 'recovered'; identity: Identity }
  | { kind: 'newer' };

export function loadIdentity(dir: string, io: IdentityIo = defaultIo): LoadedIdentity {
  const file = path.join(dir, FILE);
  const text = io.read(file);
  if (text === null) return { kind: 'created', identity: create(dir, io) };
  const parsed = parseIdentityFile(text);
  if (parsed.kind === 'newer') return { kind: 'newer' };
  if (parsed.kind === 'ok') {
    const server = decodePair(parsed.file.serverKey);
    const owner = parsed.file.ownerKey === null ? null : decodePair(parsed.file.ownerKey);
    if (server && (parsed.file.ownerKey === null || owner !== null)) {
      return { kind: 'loaded', identity: toIdentity(server, owner) };
    }
  }
  io.rename(file, path.join(dir, CORRUPT_FILE));
  return { kind: 'recovered', identity: create(dir, io) };
}

export function setOwnerKey(
  dir: string,
  id: Identity,
  owner: KeyPair,
  io: IdentityIo = defaultIo,
): Identity {
  const server = { publicKey: id.serverPublicKey, privateKey: id.serverPrivateKey };
  save(dir, io, server, owner);
  return toIdentity(server, owner);
}

/**
 * The machine id of a file this build cannot read (a newer version), without writing it. Null when
 * even its server public key is unusable, in which case there is no identity to run under.
 */
export function readOnlyMachineId(dir: string, io: IdentityIo = defaultIo): string | null {
  const text = io.read(path.join(dir, FILE));
  if (text === null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null || !('serverKey' in raw)) return null;
  const serverKey = raw.serverKey;
  if (typeof serverKey !== 'object' || serverKey === null || !('publicKey' in serverKey)) {
    return null;
  }
  if (typeof serverKey.publicKey !== 'string') return null;
  const publicKey = importPublic(serverKey.publicKey);
  return publicKey === null ? null : deriveMachineId(rawPublicKey(publicKey));
}

/**
 * The identity after an owner key arrives over a link, or null when it is refused. A server that
 * already holds an owner key accepts only that same key again: a late transfer never replaces it.
 */
export function adoptOwnerKey(
  dir: string,
  id: Identity,
  offered: { publicKey: string; privateKey: string },
  io: IdentityIo = defaultIo,
): Identity | null {
  const pair = decodePair(offered);
  if (pair === null) return null;
  const derived = createPublicKey(pair.privateKey).export({ format: 'der', type: 'spki' });
  const offeredPub = pair.publicKey.export({ format: 'der', type: 'spki' });
  if (!derived.equals(offeredPub)) return null;
  if (id.ownerKey !== null) {
    return id.ownerKey.publicKey.export({ format: 'der', type: 'spki' }).equals(offeredPub)
      ? id
      : null;
  }
  return setOwnerKey(dir, id, pair, io);
}
