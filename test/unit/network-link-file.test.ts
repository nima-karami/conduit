import { describe, expect, it } from 'vitest';
import {
  type LinkRecord,
  type LinksFile,
  parseLinksFile,
  serializeLinksFile,
} from '../../src/network/link-file';

const DAY = 24 * 60 * 60_000;
const NOW = Date.parse('2026-11-14T00:00:00.000Z');
const ago = (days: number) => new Date(NOW - days * DAY).toISOString();

const link: LinkRecord = {
  linkId: 'l-1',
  machineId: 'm-4bb06f8e',
  serverKey: 'server-spki',
  ownerKey: 'owner-spki',
  name: 'Laptop',
  trust: 'own',
  addresses: ['192.168.1.20:7443'],
  capabilities: { messaging: true, monitor: true, drive: false },
  fingerprint: 'ABCD-1234',
  createdAt: ago(1),
};

const tombstone = (revokedDaysAgo: number) => ({
  linkId: 'l-old',
  machineId: 'm-00000001',
  serverKey: 'old-spki',
  revokedAt: ago(revokedDaysAgo),
});

const sample: LinksFile = { version: 1, links: [link], tombstones: [tombstone(1)] };

describe('links file', () => {
  it('round-trips links and tombstones', () => {
    expect(parseLinksFile(serializeLinksFile(sample), NOW)).toEqual({ kind: 'ok', file: sample });
  });

  it('round-trips an empty file', () => {
    const empty: LinksFile = { version: 1, links: [], tombstones: [] };
    expect(parseLinksFile(serializeLinksFile(empty), NOW)).toEqual({ kind: 'ok', file: empty });
  });

  it('serializes as one JSON line', () => {
    expect(serializeLinksFile(sample)).toBe(`${JSON.stringify(sample)}\n`);
  });

  it('a newer version is newer', () => {
    expect(parseLinksFile(JSON.stringify({ ...sample, version: 2 }), NOW)).toEqual({
      kind: 'newer',
    });
  });

  it.each([
    ['string version', { ...sample, version: '1' }],
    ['zero version', { ...sample, version: 0 }],
    ['missing version', { links: [], tombstones: [] }],
    ['link missing fingerprint', { ...sample, links: [{ ...link, fingerprint: undefined }] }],
    ['link with bad machineId', { ...sample, links: [{ ...link, machineId: 'm-XYZ' }] }],
    [
      'link capabilities missing drive',
      { ...sample, links: [{ ...link, capabilities: { messaging: true, monitor: true } }] },
    ],
    ['link trust not own', { ...sample, links: [{ ...link, trust: 'peer' }] }],
    ['tombstones not an array', { ...sample, tombstones: null }],
    ['tombstone missing revokedAt', { ...sample, tombstones: [{ ...tombstone(1), revokedAt: undefined }] }],
  ])('%s is corrupt', (_name, value) => {
    expect(parseLinksFile(JSON.stringify(value), NOW)).toEqual({ kind: 'corrupt' });
  });

  it('non-JSON is corrupt', () => {
    expect(parseLinksFile('[', NOW)).toEqual({ kind: 'corrupt' });
  });

  it('drops a tombstone revoked 31 days ago and keeps one revoked 29 days ago', () => {
    const f: LinksFile = {
      version: 1,
      links: [],
      tombstones: [tombstone(31), { ...tombstone(29), linkId: 'l-recent' }],
    };
    const parsed = parseLinksFile(JSON.stringify(f), NOW);
    expect(parsed.kind).toBe('ok');
    if (parsed.kind !== 'ok') return;
    expect(parsed.file.tombstones.map((t) => t.linkId)).toEqual(['l-recent']);
  });
});
