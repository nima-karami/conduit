import { expect, it } from 'vitest';
import { ExpiringCache } from '../../src/expiring-cache';

it('expires on get, size and keys without extending TTL on reads', () => {
  let now = 0;
  const cache = new ExpiringCache<string, string>({ maxEntries: 4, ttlMs: 10, clock: () => now });
  expect(cache.set('a', 'A')).toBe(cache);
  now = 9;
  expect(cache.get('a')).toBe('A');
  now = 10;
  expect(cache.get('a')).toBeUndefined();
  cache.set('b', 'B');
  now = 20;
  expect([...cache.keys()]).toEqual([]);
  expect(cache.size).toBe(0);
});

it('marks reads most recently used and evicts by entry count', () => {
  const cache = new ExpiringCache<string, number>({ maxEntries: 2, ttlMs: 100 });
  cache.set('a', 1).set('b', 2);
  expect(cache.get('a')).toBe(1);
  cache.set('c', 3);
  expect(cache.get('b')).toBeUndefined();
  expect([...cache.keys()]).toEqual(['a', 'c']);
  expect(cache.delete('a')).toBe(true);
  expect(cache.delete('a')).toBe(false);
});

it('prunes all expired entries on set before evicting live entries', () => {
  let now = 0;
  const cache = new ExpiringCache<string, number>({ maxEntries: 2, ttlMs: 10, clock: () => now });
  cache.set('old', 1);
  now = 5;
  cache.set('live', 2);
  cache.get('old');
  now = 10;
  cache.set('new', 3);
  expect([...cache.keys()]).toEqual(['live', 'new']);
});

it('bounds bytes, accounts replacements and rejects oversized values', () => {
  const cache = new ExpiringCache<string, string>({
    maxEntries: 10,
    maxBytes: 5,
    sizeOf: (value) => Buffer.byteLength(value),
    ttlMs: 100,
  });
  cache.set('a', 'é').set('b', 'bb');
  cache.get('a');
  cache.set('c', 'cc');
  expect(cache.get('b')).toBeUndefined();
  cache.set('a', 'x');
  cache.set('d', 'dd');
  expect(cache.size).toBe(3);
  cache.set('huge', '123456');
  expect(cache.get('huge')).toBeUndefined();
  expect(cache.size).toBe(3);
  cache.set('a', '123456');
  expect(cache.get('a')).toBeUndefined();
  expect(cache.size).toBe(2);
});

it('supports zero capacity and zero TTL without retaining values', () => {
  const full = new ExpiringCache<string, string>({ maxEntries: 0, ttlMs: 100 });
  full.set('a', 'A');
  expect(full.size).toBe(0);
  const expired = new ExpiringCache<string, string>({ maxEntries: 1, ttlMs: 0 });
  expired.set('a', 'A');
  expect(expired.get('a')).toBeUndefined();
});
