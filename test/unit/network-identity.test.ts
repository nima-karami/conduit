import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  type Identity,
  type IdentityIo,
  loadIdentity,
  readOnlyMachineId,
  setOwnerKey,
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

function identityOf(r: Identity | { error: 'newer' }): Identity {
  if ('error' in r) throw new Error(`unexpected ${r.error}`);
  return r;
}

const der = (k: Identity['serverPublicKey']) => k.export({ format: 'der', type: 'spki' });

describe('loadIdentity', () => {
  it('creates an identity once and a reload returns the same id and keys', () => {
    const { io, writes } = memoryIo();
    const first = identityOf(loadIdentity(DIR, io));
    expect(writes).toEqual([FILE]);
    const second = identityOf(loadIdentity(DIR, io));
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
    identityOf(loadIdentity(DIR, io));
    expect(files.has(CORRUPT)).toBe(true);
  });

  it('a newer version is an error and is never written', () => {
    const newer = JSON.stringify({ version: 2, serverKey: { publicKey: 'x', privateKey: 'y' } });
    const { io, files, writes } = memoryIo({ [FILE]: newer });
    expect(loadIdentity(DIR, io)).toEqual({ error: 'newer' });
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
