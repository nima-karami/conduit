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
  cert: 'PEM-B',
  ownerTransfer: null,
  transport: 'tls',
  ssh: null,
  machine: null,
};

const tombstone = (revokedDaysAgo: number) => ({
  linkId: 'l-old',
  machineId: 'm-00000001',
  serverKey: 'old-spki',
  revokedAt: ago(revokedDaysAgo),
  cert: 'PEM-OLD',
});

const meta = {
  os: 'linux' as const,
  arch: 'x64' as const,
  version: '0.9.0',
  mode: 'full' as const,
  agents: ['claude', 'codex'],
  enabled: true,
  survivesLogout: false,
};
const sshLink: LinkRecord = {
  ...link,
  machineId: 'm-0badcafe',
  cert: '',
  fingerprint: '',
  addresses: [],
  transport: 'ssh',
  ssh: { target: 'vm', node: '/usr/bin/node', mainJs: '/m.js', userData: '/u' },
  machine: meta,
};

const sample: LinksFile = { version: 3, links: [link], tombstones: [tombstone(1)] };

describe('links file', () => {
  it('round-trips links and tombstones', () => {
    expect(parseLinksFile(serializeLinksFile(sample), NOW)).toEqual({ kind: 'ok', file: sample });
  });

  it('round-trips an empty file', () => {
    const empty: LinksFile = { version: 3, links: [], tombstones: [] };
    expect(parseLinksFile(serializeLinksFile(empty), NOW)).toEqual({ kind: 'ok', file: empty });
  });

  // Files written before ssh links existed have no transport; they are TLS links.
  it('links.json without transport parses as tls', () => {
    const { transport: _transport, ssh: _ssh, ...legacy } = link;
    const parsed = parseLinksFile(JSON.stringify({ ...sample, links: [legacy] }), NOW);
    expect(parsed.kind).toBe('ok');
    if (parsed.kind !== 'ok') return;
    expect(parsed.file.links[0]?.transport).toBe('tls');
    expect(parsed.file.links[0]?.ssh).toBeNull();
  });

  it('ssh record round-trips with ssh null', () => {
    const sshLink: LinkRecord = {
      ...link,
      machineId: 'm-0badcafe',
      cert: '',
      fingerprint: '',
      addresses: [],
      transport: 'ssh',
      ssh: null,
    };
    const f: LinksFile = { version: 3, links: [sshLink], tombstones: [] };
    expect(parseLinksFile(serializeLinksFile(f), NOW)).toEqual({ kind: 'ok', file: f });
  });

  // A server without an owner key has nothing to put here, and only ssh links may say so.
  it('an ssh record with no owner key round-trips', () => {
    const f: LinksFile = {
      version: 3,
      links: [{ ...link, ownerKey: null, transport: 'ssh', ssh: null, cert: '', machine: null }],
      tombstones: [],
    };
    expect(parseLinksFile(serializeLinksFile(f), NOW)).toEqual({ kind: 'ok', file: f });
  });

  it('a tls record with a null ownerKey is corrupt', () => {
    const bad = { ...link, ownerKey: null, transport: 'tls', ssh: null };
    expect(parseLinksFile(JSON.stringify({ ...sample, links: [bad] }), NOW)).toEqual({
      kind: 'corrupt',
    });
  });

  // Version 2 is what this build writes; a version 1 file (no ssh records) still loads as tls.
  it('a version 1 file loads, and its records are tls', () => {
    const { transport: _t, ssh: _s, machine: _m, ...legacy } = link;
    const parsed = parseLinksFile(JSON.stringify({ ...sample, version: 1, links: [legacy] }), NOW);
    expect(parsed).toEqual({ kind: 'ok', file: { ...sample, version: 3 } });
  });

  // Version 2 predates machine metadata; its ssh records load with none, shown as unknown os.
  it('a version 2 file loads, and its ssh records have no machine metadata', () => {
    const { machine: _m, ...v2Ssh } = sshLink;
    const parsed = parseLinksFile(
      JSON.stringify({ version: 2, links: [v2Ssh], tombstones: [] }),
      NOW,
    );
    expect(parsed).toEqual({
      kind: 'ok',
      file: { version: 3, links: [{ ...sshLink, machine: null }], tombstones: [] },
    });
  });

  it('a version 3 ssh record round-trips its machine metadata', () => {
    const f: LinksFile = { version: 3, links: [sshLink], tombstones: [] };
    expect(parseLinksFile(serializeLinksFile(f), NOW)).toEqual({ kind: 'ok', file: f });
  });

  it('machine metadata with survivesLogout null (never bootstrapped by us) round-trips', () => {
    const unknown = { ...sshLink, machine: { ...meta, survivesLogout: null } };
    const f: LinksFile = { version: 3, links: [unknown], tombstones: [] };
    expect(parseLinksFile(serializeLinksFile(f), NOW)).toEqual({ kind: 'ok', file: f });
  });

  it('machine metadata whose survivesLogout is neither a boolean nor null is corrupt', () => {
    const bad = { ...sshLink, machine: { ...meta, survivesLogout: 'yes' } };
    expect(
      parseLinksFile(JSON.stringify({ version: 3, links: [bad], tombstones: [] }), NOW),
    ).toEqual({ kind: 'corrupt' });
  });

  it('a tls record carrying machine metadata is corrupt', () => {
    const bad = { ...link, machine: meta };
    expect(parseLinksFile(JSON.stringify({ ...sample, links: [bad] }), NOW)).toEqual({
      kind: 'corrupt',
    });
  });

  it('machine metadata with an unknown os is corrupt', () => {
    const bad = { ...sshLink, machine: { ...meta, os: 'darwin' } };
    expect(
      parseLinksFile(JSON.stringify({ version: 3, links: [bad], tombstones: [] }), NOW),
    ).toEqual({
      kind: 'corrupt',
    });
  });

  it('machine metadata whose agents are not all strings is corrupt', () => {
    const bad = { ...sshLink, machine: { ...meta, agents: ['claude', 3] } };
    expect(
      parseLinksFile(JSON.stringify({ version: 3, links: [bad], tombstones: [] }), NOW),
    ).toEqual({
      kind: 'corrupt',
    });
  });

  it('a tls record carrying an ssh endpoint is corrupt', () => {
    const bad = {
      ...link,
      transport: 'tls',
      ssh: { target: 'vm', node: '/usr/bin/node', mainJs: '/m.js', userData: '/u' },
    };
    expect(parseLinksFile(JSON.stringify({ ...sample, links: [bad] }), NOW)).toEqual({
      kind: 'corrupt',
    });
  });

  it('an ssh endpoint with an empty field is corrupt', () => {
    const bad = {
      ...link,
      transport: 'ssh',
      ssh: { target: 'vm', node: '/usr/bin/node', mainJs: '', userData: '/home/u/.conduit' },
    };
    expect(parseLinksFile(JSON.stringify({ ...sample, links: [bad] }), NOW)).toEqual({
      kind: 'corrupt',
    });
  });

  it('serializes as one JSON line', () => {
    expect(serializeLinksFile(sample)).toBe(`${JSON.stringify(sample)}\n`);
  });

  it('a newer version is newer', () => {
    expect(parseLinksFile(JSON.stringify({ ...sample, version: 4 }), NOW)).toEqual({
      kind: 'newer',
    });
  });

  it.each([
    ['string version', { ...sample, version: '1' }],
    ['zero version', { ...sample, version: 0 }],
    ['missing version', { links: [], tombstones: [] }],
    ['link missing fingerprint', { ...sample, links: [{ ...link, fingerprint: undefined }] }],
    ['link missing cert', { ...sample, links: [{ ...link, cert: undefined }] }],
    ['link with a bad ownerTransfer', { ...sample, links: [{ ...link, ownerTransfer: 'maybe' }] }],
    ['link with bad machineId', { ...sample, links: [{ ...link, machineId: 'm-XYZ' }] }],
    [
      'link capabilities missing drive',
      { ...sample, links: [{ ...link, capabilities: { messaging: true, monitor: true } }] },
    ],
    ['link trust not own', { ...sample, links: [{ ...link, trust: 'peer' }] }],
    ['tombstones not an array', { ...sample, tombstones: null }],
    [
      'tombstone missing revokedAt',
      { ...sample, tombstones: [{ ...tombstone(1), revokedAt: undefined }] },
    ],
  ])('%s is corrupt', (_name, value) => {
    expect(parseLinksFile(JSON.stringify(value), NOW)).toEqual({ kind: 'corrupt' });
  });

  it('non-JSON is corrupt', () => {
    expect(parseLinksFile('[', NOW)).toEqual({ kind: 'corrupt' });
  });

  it('drops a tombstone revoked 31 days ago and keeps one revoked 29 days ago', () => {
    const f: LinksFile = {
      version: 3,
      links: [],
      tombstones: [tombstone(31), { ...tombstone(29), linkId: 'l-recent' }],
    };
    const parsed = parseLinksFile(JSON.stringify(f), NOW);
    expect(parsed.kind).toBe('ok');
    if (parsed.kind !== 'ok') return;
    expect(parsed.file.tombstones.map((t) => t.linkId)).toEqual(['l-recent']);
  });
});
