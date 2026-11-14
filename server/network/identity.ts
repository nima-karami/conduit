import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
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
