import { describe, expect, it } from 'vitest';
import {
  deriveMachineId,
  type IdentityFile,
  parseIdentityFile,
  serializeIdentityFile,
} from '../../src/network/identity-file';

const pair = (tag: string) => ({ publicKey: `${tag}-spki`, privateKey: `${tag}-pkcs8` });

const sample: IdentityFile = {
  version: 1,
  serverKey: pair('server'),
  ownerKey: pair('owner'),
};

describe('deriveMachineId', () => {
  it('is m- plus the first 8 hex chars of sha256 over the raw key, and is stable', () => {
    const id = deriveMachineId(Buffer.alloc(32, 7));
    expect(id).toBe('m-4bb06f8e');
    expect(id).toMatch(/^m-[0-9a-f]{8}$/);
    expect(deriveMachineId(Buffer.alloc(32, 7))).toBe(id);
  });
});

describe('identity file', () => {
  it('round-trips with an owner key', () => {
    const parsed = parseIdentityFile(serializeIdentityFile(sample));
    expect(parsed).toEqual({ kind: 'ok', file: sample });
  });

  it('round-trips with a null owner key', () => {
    const f: IdentityFile = { version: 1, serverKey: pair('server'), ownerKey: null };
    expect(parseIdentityFile(serializeIdentityFile(f))).toEqual({ kind: 'ok', file: f });
  });

  it('serializes as one JSON line', () => {
    expect(serializeIdentityFile(sample)).toBe(`${JSON.stringify(sample)}\n`);
  });

  it('a newer version is newer, not corrupt', () => {
    expect(parseIdentityFile(JSON.stringify({ ...sample, version: 2 }))).toEqual({ kind: 'newer' });
  });

  it.each([
    ['string version', { ...sample, version: '1' }],
    ['zero version', { ...sample, version: 0 }],
    ['missing version', { serverKey: sample.serverKey, ownerKey: null }],
    ['missing serverKey', { version: 1, ownerKey: null }],
    ['serverKey missing privateKey', { version: 1, serverKey: { publicKey: 'x' }, ownerKey: null }],
    ['ownerKey wrong type', { ...sample, ownerKey: 'nope' }],
    ['array root', [sample]],
  ])('%s is corrupt', (_name, value) => {
    expect(parseIdentityFile(JSON.stringify(value))).toEqual({ kind: 'corrupt' });
  });

  it('non-JSON is corrupt', () => {
    expect(parseIdentityFile('{not json')).toEqual({ kind: 'corrupt' });
  });
});
