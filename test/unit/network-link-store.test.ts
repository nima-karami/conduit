import { describe, expect, it, vi } from 'vitest';
import { type LinkStoreIo, openLinkStore } from '../../server/network/link-store';
import { TOMBSTONE_TTL_MS } from '../../src/contracts/link-protocol';
import type { LinkRecord } from '../../src/network/link-file';

const DIR = '/mem/network';
const FILE = `${DIR}/links.json`;
const CORRUPT = `${DIR}/links.corrupt.json`;
const T0 = Date.parse('2026-11-14T12:00:00.000Z');

function memoryIo(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial));
  const writes: string[] = [];
  const io: LinkStoreIo = {
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

function rec(machineId: string, over: Partial<LinkRecord> = {}): LinkRecord {
  return {
    linkId: `link-${machineId}`,
    machineId,
    serverKey: `key-${machineId}`,
    ownerKey: 'owner-key',
    name: 'laptop',
    trust: 'own',
    addresses: ['127.0.0.1:47391'],
    capabilities: { messaging: true, monitor: false, drive: false },
    fingerprint: 'fp-1',
    createdAt: '2026-11-14T10:00:00.000Z',
    cert: `PEM-${machineId}`,
    ownerTransfer: null,
    transport: 'tls',
    ssh: null,
    ...over,
  };
}

function logSpy() {
  return { error: vi.fn<(msg: string, data?: Record<string, unknown>) => void>() };
}

describe('link store', () => {
  // The endpoint is set once an ssh peer's record needs one; a tls record never gets one.
  it('update sets ssh on an ssh record and is refused on a tls record', () => {
    const { io } = memoryIo();
    const store = openLinkStore(FILE, { now: () => T0, log: logSpy(), io });
    store.put(rec('m-aaaaaaaa'));
    store.addSsh({
      machineId: 'm-bbbbbbbb',
      serverKey: 'key-bbbbbbbb',
      ownerKey: null,
      name: 'r',
      ssh: null,
    });
    const ssh = { target: 'vm', node: '/usr/bin/node', mainJs: '/m.js', userData: '/u' };
    expect(store.update('m-bbbbbbbb', { ssh })?.ssh).toEqual(ssh);
    expect(store.get('m-bbbbbbbb')?.ssh).toEqual(ssh);
    expect(store.update('m-aaaaaaaa', { ssh })).toBeNull();
    expect(store.get('m-aaaaaaaa')?.ssh).toBeNull();
  });

  // An ssh peer has no certificate; it must never widen the listener's trusted CAs.
  it('trustedCerts skips ssh records', () => {
    const { io } = memoryIo();
    const store = openLinkStore(FILE, { now: () => T0, log: logSpy(), io });
    store.put(rec('m-aaaaaaaa'));
    store.addSsh({
      machineId: 'm-bbbbbbbb',
      serverKey: 'key-bbbbbbbb',
      ownerKey: 'owner-key',
      name: 'remote',
      ssh: null,
    });
    expect(store.get('m-bbbbbbbb')?.transport).toBe('ssh');
    expect(store.trustedCerts()).toEqual(['PEM-m-aaaaaaaa']);
  });

  it('a missing file opens as an empty writable store without writing', () => {
    const { io, writes } = memoryIo();
    const store = openLinkStore(FILE, { now: () => T0, log: logSpy(), io });
    expect(store.writable).toBe(true);
    expect(store.links()).toEqual([]);
    expect(writes).toEqual([]);
  });

  it('put, then reopen on the same io, returns the same links', () => {
    const { io } = memoryIo();
    const log = logSpy();
    const a = rec('m-0000000a');
    const b = rec('m-0000000b', { name: 'desk' });
    const first = openLinkStore(FILE, { now: () => T0, log, io });
    first.put(a);
    first.put(b);
    const reopened = openLinkStore(FILE, { now: () => T0, log, io });
    expect(reopened.links()).toEqual([a, b]);
    expect(reopened.get(b.machineId)).toEqual(b);
  });

  it('update patches only the given fields', () => {
    const { io } = memoryIo();
    const log = logSpy();
    const a = rec('m-0000000a');
    const store = openLinkStore(FILE, { now: () => T0, log, io });
    store.put(a);
    const updated = store.update(a.machineId, { name: 'renamed' });
    expect(updated).toEqual({ ...a, name: 'renamed' });
    const reopened = openLinkStore(FILE, { now: () => T0, log, io });
    expect(reopened.get(a.machineId)).toEqual({ ...a, name: 'renamed' });
  });

  it('update of an unknown machine returns null', () => {
    const { io } = memoryIo();
    const store = openLinkStore(FILE, { now: () => T0, log: logSpy(), io });
    expect(store.update('m-0000000c', { name: 'x' })).toBeNull();
  });

  it('revoke removes the live record and keeps a tombstone under the same server key', () => {
    const { io } = memoryIo();
    const a = rec('m-0000000a');
    const store = openLinkStore(FILE, { now: () => T0, log: logSpy(), io });
    store.put(a);
    const tombstone = store.revoke(a.machineId, T0);
    expect(tombstone).toEqual({
      linkId: a.linkId,
      machineId: a.machineId,
      serverKey: a.serverKey,
      revokedAt: new Date(T0).toISOString(),
      cert: a.cert,
    });
    expect(store.trustedCerts()).toContain(a.cert);
    expect(store.get(a.machineId)).toBeNull();
    expect(store.byServerKey(a.serverKey)).toEqual({ tombstone });
  });

  it('revoke of an unknown machine returns null', () => {
    const { io } = memoryIo();
    const store = openLinkStore(FILE, { now: () => T0, log: logSpy(), io });
    expect(store.revoke('m-0000000c', T0)).toBeNull();
  });

  it('a tombstone older than 30 days is ignored, and dropped on the next write', () => {
    const { io, files } = memoryIo();
    const log = logSpy();
    let clock = T0;
    const a = rec('m-0000000a');
    const store = openLinkStore(FILE, { now: () => clock, log, io });
    store.put(a);
    store.revoke(a.machineId, T0);
    clock = T0 + TOMBSTONE_TTL_MS + 1;
    expect(store.byServerKey(a.serverKey)).toBeNull();
    store.put(rec('m-0000000b'));
    const persisted = JSON.parse(files.get(FILE) ?? '{}') as { tombstones: unknown[] };
    expect(persisted.tombstones).toEqual([]);
  });

  it('conflicts names a machine id already held under another server key, live or revoked', () => {
    const { io } = memoryIo();
    const store = openLinkStore(FILE, { now: () => T0, log: logSpy(), io });
    store.put(rec('m-11111111'));
    store.put(rec('m-22222222'));
    store.revoke('m-22222222', T0);
    expect(store.conflicts('m-33333333', 'key-x')).toBe(false);
    expect(store.conflicts('m-11111111', 'key-m-11111111')).toBe(false);
    expect(store.conflicts('m-11111111', 'key-other')).toBe(true);
    expect(store.conflicts('m-22222222', 'key-other')).toBe(true);
    expect(store.conflicts('m-22222222', 'key-m-22222222')).toBe(false);
  });

  it('put for a revoked machine clears its tombstone', () => {
    const { io, files } = memoryIo();
    const log = logSpy();
    const a = rec('m-0000000a');
    const store = openLinkStore(FILE, { now: () => T0, log, io });
    store.put(a);
    store.revoke(a.machineId, T0);
    store.put(a);
    expect(store.byServerKey(a.serverKey)).toEqual(a);
    const persisted = JSON.parse(files.get(FILE) ?? '{}') as { tombstones: unknown[] };
    expect(persisted.tombstones).toEqual([]);
  });

  it('a newer file is read-only: put works in memory and nothing is written', () => {
    const newer = JSON.stringify({ version: 2, links: [], tombstones: [] });
    const { io, files, writes } = memoryIo({ [FILE]: newer });
    const log = logSpy();
    const store = openLinkStore(FILE, { now: () => T0, log, io });
    expect(store.writable).toBe(false);
    expect(log.error).toHaveBeenCalledTimes(1);
    const a = rec('m-0000000a');
    store.put(a);
    expect(store.get(a.machineId)).toEqual(a);
    store.update(a.machineId, { name: 'x' });
    store.revoke(a.machineId, T0);
    expect(writes).toEqual([]);
    expect(files.get(FILE)).toBe(newer);
    expect(files.has(CORRUPT)).toBe(false);
  });

  it('a corrupt file is moved to links.corrupt.json, logged, and the store starts empty', () => {
    const { io, files } = memoryIo({ [FILE]: '{not json' });
    const log = logSpy();
    const store = openLinkStore(FILE, { now: () => T0, log, io });
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(files.get(CORRUPT)).toBe('{not json');
    expect(files.has(FILE)).toBe(false);
    expect(store.writable).toBe(true);
    expect(store.links()).toEqual([]);
  });

  it('a second corrupt file never overwrites the first backup', () => {
    const { io, files } = memoryIo({ [FILE]: 'second bad', [CORRUPT]: 'first bad' });
    const log = logSpy();
    const store = openLinkStore(FILE, { now: () => T0, log, io });
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(files.get(CORRUPT)).toBe('first bad');
    expect(store.writable).toBe(true);
    expect(store.links()).toEqual([]);
    store.put(rec('m-0000000a'));
    expect(files.get(CORRUPT)).toBe('first bad');
    expect(files.get(FILE)).toContain('m-0000000a');
  });

  it('links() and get() return copies that callers cannot use to mutate the store', () => {
    const { io } = memoryIo();
    const store = openLinkStore(FILE, { now: () => T0, log: logSpy(), io });
    store.put(rec('m-0000000a'));
    const copy = store.get('m-0000000a');
    if (copy === null) throw new Error('expected a link');
    copy.addresses.push('10.0.0.1');
    copy.capabilities.drive = true;
    store.links()[0].name = 'hacked';
    const fresh = store.get('m-0000000a');
    expect(fresh?.addresses).toEqual(['127.0.0.1:47391']);
    expect(fresh?.capabilities.drive).toBe(false);
    expect(fresh?.name).toBe('laptop');
  });
});
