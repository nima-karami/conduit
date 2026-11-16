import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  adoptOwnerKey,
  type Identity,
  type IdentityIo,
  type LoadedIdentity,
  loadIdentity,
  proofPayload,
  readOnlyMachineId,
  setOwnerKey,
  signProof,
  verifyProof,
} from '../../server/network/identity';
import { deriveMachineId, serializeIdentityFile } from '../../src/network/identity-file';

const DIR = '/mem/network';
const FILE = `${DIR}/identity.json`;
const CORRUPT = `${DIR}/identity.corrupt.json`;

function memoryIo(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial));
  const writes: string[] = [];
  const io: IdentityIo = {
    read: (p) => files.get(p) ?? null,
    write: (p, text) => {
      writes.push(p);
      files.set(p, text);
    },
    rename: (from, to) => {
      const text = files.get(from);
      if (text === undefined) throw new Error(`no file at ${from}`);
      files.delete(from);
      files.set(to, text);
    },
  };
  return { io, files, writes };
}

function identityOf(r: LoadedIdentity): Identity {
  if (r.kind === 'newer') throw new Error('unexpected newer');
  return r.identity;
}

const der = (k: Identity['serverPublicKey']) => k.export({ format: 'der', type: 'spki' });

describe('loadIdentity', () => {
  it('creates an identity once and a reload returns the same id and keys', () => {
    const { io, writes } = memoryIo();
    const created = loadIdentity(DIR, io);
    expect(created.kind).toBe('created');
    const first = identityOf(created);
    expect(writes).toEqual([FILE]);
    const reloaded = loadIdentity(DIR, io);
    expect(reloaded.kind).toBe('loaded');
    const second = identityOf(reloaded);
    expect(writes).toEqual([FILE]);
    expect(second.machineId).toBe(first.machineId);
    expect(der(second.serverPublicKey).equals(der(first.serverPublicKey))).toBe(true);
    expect(
      second.serverPrivateKey
        .export({ format: 'der', type: 'pkcs8' })
        .equals(first.serverPrivateKey.export({ format: 'der', type: 'pkcs8' })),
    ).toBe(true);
    expect(second.ownerKey).toBeNull();
  });

  it('machine id is derived from the 32 raw bytes of the server public key', () => {
    const { io } = memoryIo();
    const id = identityOf(loadIdentity(DIR, io));
    expect(id.serverKeyRaw).toHaveLength(32);
    expect(id.machineId).toBe(deriveMachineId(id.serverKeyRaw));
    expect(id.machineId).toMatch(/^m-[0-9a-f]{8}$/);
  });

  it('corrupt text is moved to identity.corrupt.json and a new identity is created', () => {
    const { io, files } = memoryIo({ [FILE]: '{not json' });
    const id = identityOf(loadIdentity(DIR, io));
    expect(files.get(CORRUPT)).toBe('{not json');
    expect(files.get(FILE)).toContain('"serverKey"');
    expect(id.machineId).toMatch(/^m-[0-9a-f]{8}$/);
    expect(identityOf(loadIdentity(DIR, io)).machineId).toBe(id.machineId);
  });

  it('keys that do not import as Ed25519 are treated as corrupt', () => {
    const { io, files } = memoryIo({
      [FILE]: JSON.stringify({
        version: 1,
        serverKey: { publicKey: 'AAAA', privateKey: 'AAAA' },
        ownerKey: null,
      }),
    });
    expect(loadIdentity(DIR, io).kind).toBe('recovered');
    expect(files.has(CORRUPT)).toBe(true);
  });

  it('a newer version is an error and is never written', () => {
    const newer = JSON.stringify({ version: 2, serverKey: { publicKey: 'x', privateKey: 'y' } });
    const { io, files, writes } = memoryIo({ [FILE]: newer });
    expect(loadIdentity(DIR, io)).toEqual({ kind: 'newer' });
    expect(writes).toEqual([]);
    expect(files.get(FILE)).toBe(newer);
    expect(files.has(CORRUPT)).toBe(false);
  });
});

describe('setOwnerKey', () => {
  it('persists the owner key and a reload has it', () => {
    const { io } = memoryIo();
    const id = identityOf(loadIdentity(DIR, io));
    const owner = generateKeyPairSync('ed25519');
    const updated = setOwnerKey(DIR, id, owner, io);
    expect(updated.machineId).toBe(id.machineId);
    expect(updated.ownerKey).not.toBeNull();
    const reloaded = identityOf(loadIdentity(DIR, io));
    expect(reloaded.machineId).toBe(id.machineId);
    expect(reloaded.ownerKey).not.toBeNull();
    expect(
      reloaded.ownerKey?.publicKey
        .export({ format: 'der', type: 'spki' })
        .equals(owner.publicKey.export({ format: 'der', type: 'spki' })),
    ).toBe(true);
  });
});

describe('readOnlyMachineId', () => {
  it('derives the id of a newer file without writing it', () => {
    const mem = memoryIo();
    const id = identityOf(loadIdentity(DIR, mem.io));
    const newer = JSON.stringify({ ...JSON.parse(mem.files.get(FILE) ?? ''), version: 2 });
    mem.files.set(FILE, newer);
    const writesBefore = mem.writes.length;
    expect(readOnlyMachineId(DIR, mem.io)).toBe(id.machineId);
    expect(mem.writes.length).toBe(writesBefore);
    expect(mem.files.get(FILE)).toBe(newer);
  });

  it('is null when there is no usable public key', () => {
    const { io } = memoryIo({
      [FILE]: serializeIdentityFile({
        version: 1,
        serverKey: { publicKey: 'AA', privateKey: 'AA' },
        ownerKey: null,
      }),
    });
    expect(readOnlyMachineId(DIR, io)).toBeNull();
    expect(readOnlyMachineId(DIR, memoryIo().io)).toBeNull();
  });
});

describe('adoptOwnerKey', () => {
  const encodeOwner = () => {
    const k = generateKeyPairSync('ed25519');
    return {
      publicKey: k.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
      privateKey: k.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
    };
  };
  const ownerOf = (id: Identity) =>
    id.ownerKey?.publicKey.export({ type: 'spki', format: 'der' }).toString('base64') ?? null;

  it('a late owner key does not replace one this server already holds', () => {
    const { io } = memoryIo();
    const loaded = loadIdentity(DIR, io);
    if (loaded.kind === 'newer') throw new Error('unexpected');
    const first = encodeOwner();
    const adopted = adoptOwnerKey(DIR, loaded.identity, first, io);
    if (adopted === null) throw new Error('the first owner key is accepted');
    expect(adoptOwnerKey(DIR, adopted, encodeOwner(), io)).toBeNull();
    const reloaded = loadIdentity(DIR, io);
    if (reloaded.kind === 'newer') throw new Error('unexpected');
    expect(ownerOf(reloaded.identity)).toBe(first.publicKey);
  });

  it('the owner key this server already holds is accepted again', () => {
    const { io } = memoryIo();
    const loaded = loadIdentity(DIR, io);
    if (loaded.kind === 'newer') throw new Error('unexpected');
    const first = encodeOwner();
    const adopted = adoptOwnerKey(DIR, loaded.identity, first, io);
    if (adopted === null) throw new Error('the first owner key is accepted');
    expect(adoptOwnerKey(DIR, adopted, first, io)).not.toBeNull();
  });

  it('an owner key whose public half does not match its private half is refused', () => {
    const { io } = memoryIo();
    const loaded = loadIdentity(DIR, io);
    if (loaded.kind === 'newer') throw new Error('unexpected');
    const a = encodeOwner();
    const b = encodeOwner();
    expect(
      adoptOwnerKey(DIR, loaded.identity, { publicKey: a.publicKey, privateKey: b.privateKey }, io),
    ).toBeNull();
  });
});

describe('hello proof of possession', () => {
  const NONCE = Buffer.alloc(32, 1).toString('base64');
  const OTHER_NONCE = Buffer.alloc(32, 2).toString('base64');

  function freshIdentity(): Identity {
    const { io } = memoryIo();
    const r = loadIdentity(DIR, io);
    if (r.kind !== 'created') throw new Error(`unexpected ${r.kind}`);
    return r.identity;
  }

  it('a proof over the verifier nonce and the two machine ids verifies', () => {
    const signer = freshIdentity();
    const verifier = freshIdentity();
    const sig = signProof(signer, NONCE, verifier.machineId);
    expect(
      verifyProof(
        signer.serverKeyRaw.toString('base64'),
        sig,
        NONCE,
        signer.machineId,
        verifier.machineId,
      ),
    ).toBe(true);
  });

  it('the signed text is the documented payload, byte for byte', () => {
    expect(proofPayload('N', 'm-signer', 'm-verifier').toString('utf8')).toBe(
      'conduit-link-proof-v1\nN\nm-signer\nm-verifier',
    );
  });

  it('a proof for a different nonce does not verify (replay)', () => {
    const signer = freshIdentity();
    const verifier = freshIdentity();
    const sig = signProof(signer, OTHER_NONCE, verifier.machineId);
    expect(
      verifyProof(
        signer.serverKeyRaw.toString('base64'),
        sig,
        NONCE,
        signer.machineId,
        verifier.machineId,
      ),
    ).toBe(false);
  });

  it('a proof that binds other machine ids does not verify', () => {
    const signer = freshIdentity();
    const verifier = freshIdentity();
    const bystander = freshIdentity();
    const key = signer.serverKeyRaw.toString('base64');
    const sigForBystander = signProof(signer, NONCE, bystander.machineId);
    expect(verifyProof(key, sigForBystander, NONCE, signer.machineId, verifier.machineId)).toBe(
      false,
    );
    const sigAsOther = signProof(signer, NONCE, verifier.machineId);
    expect(verifyProof(key, sigAsOther, NONCE, bystander.machineId, verifier.machineId)).toBe(
      false,
    );
  });

  it('a proof checked against another key does not verify', () => {
    const signer = freshIdentity();
    const verifier = freshIdentity();
    const other = freshIdentity();
    const sig = signProof(signer, NONCE, verifier.machineId);
    expect(
      verifyProof(
        other.serverKeyRaw.toString('base64'),
        sig,
        NONCE,
        signer.machineId,
        verifier.machineId,
      ),
    ).toBe(false);
  });

  it('a flipped signature byte, a short signature and a malformed key do not verify', () => {
    const signer = freshIdentity();
    const verifier = freshIdentity();
    const key = signer.serverKeyRaw.toString('base64');
    const sig = Buffer.from(signProof(signer, NONCE, verifier.machineId), 'base64');
    sig[0] = (sig[0] ?? 0) ^ 1;
    expect(
      verifyProof(key, sig.toString('base64'), NONCE, signer.machineId, verifier.machineId),
    ).toBe(false);
    expect(
      verifyProof(
        key,
        sig.subarray(0, 63).toString('base64'),
        NONCE,
        signer.machineId,
        verifier.machineId,
      ),
    ).toBe(false);
    expect(
      verifyProof('not-a-key', sig.toString('base64'), NONCE, signer.machineId, verifier.machineId),
    ).toBe(false);
  });
});
