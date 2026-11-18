import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { atomicWriteFileSync } from '../../src/atomic-write';
import { OWN_DEFAULT_CAPABILITIES, TOMBSTONE_TTL_MS } from '../../src/contracts/link-protocol';
import type { MachineMeta } from '../../src/contracts/machines';
import type { SshEndpoint } from '../../src/contracts/ssh-link';
import {
  type LinkRecord,
  type LinksFile,
  parseLinksFile,
  serializeLinksFile,
  type Tombstone,
} from '../../src/network/link-file';

export interface LinkStoreIo {
  read(path: string): string | null;
  write(path: string, text: string): void;
  rename(from: string, to: string): void;
}

export interface LinkStore {
  links(): LinkRecord[];
  peerKnown(machineId: string): boolean | null;
  get(machineId: string): LinkRecord | null;
  revision(machineId: string): number | null;
  /** A live link first, else an unexpired tombstone, else null. */
  byServerKey(serverKey: string): LinkRecord | { tombstone: Tombstone } | null;
  /** Inserts or replaces by machineId, and clears any tombstone for that machineId. */
  put(r: LinkRecord): void;
  /**
   * Pins an ssh peer. Its identity comes from the hello that crossed the ssh stream, so it has no
   * certificate, no fingerprint and no addresses; the link is always 'own' with default capabilities.
   */
  addSsh(r: {
    machineId: string;
    serverKey: string;
    ownerKey: string | null;
    name: string;
    ssh: SshEndpoint | null;
  }): LinkRecord;
  /**
   * A live link or tombstone already holds this machine id under a different server key. Machine
   * ids are 32 bits, so a second key could be ground to collide; it must not take over the record.
   */
  conflicts(machineId: string, serverKey: string): boolean;
  /**
   * Stores a pinned machine's metadata. Refused (null) for an unknown machine or a tls record, which
   * never carries it. Whole-value: a caller changing one field passes the rest back unchanged.
   */
  setMachine(machineId: string, meta: MachineMeta): LinkRecord | null;
  /** `ssh` may only be set on an ssh record; on a tls record the update is refused (null). */
  update(
    machineId: string,
    patch: Partial<
      Pick<LinkRecord, 'addresses' | 'capabilities' | 'name' | 'ownerTransfer' | 'ssh'>
    >,
  ): LinkRecord | null;
  /** Removes the live record and keeps a tombstone for TOMBSTONE_TTL_MS. */
  revoke(machineId: string, at: number): Tombstone | null;
  /**
   * Deletes the live record and keeps no tombstone, so the peer is not refused by a later add (a
   * forget, not a revoke). False for an unknown machine.
   */
  remove(machineId: string): boolean;
  /** Certificates of every link and unexpired tombstone: the link listener's trusted CAs. */
  trustedCerts(): string[];
  readonly writable: boolean;
}

const CORRUPT_FILE = 'links.corrupt.json';
const LINKS_VERSION = 3;

const isMissing = (e: unknown): boolean =>
  typeof e === 'object' && e !== null && (e as NodeJS.ErrnoException).code === 'ENOENT';

const defaultIo: LinkStoreIo = {
  read(p) {
    try {
      return fs.readFileSync(p, 'utf8');
    } catch (e) {
      if (isMissing(e)) return null;
      throw e;
    }
  },
  write(p, text) {
    // Same owner-only pattern as identity.json: the file holds server keys' pairing state.
    fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
    atomicWriteFileSync(p, text, fs, { mode: 0o600 });
  },
  rename(from, to) {
    fs.renameSync(from, to);
  },
};

const copyLink = (r: LinkRecord): LinkRecord => ({
  ...r,
  addresses: [...r.addresses],
  capabilities: { ...r.capabilities },
  ssh: r.ssh === null ? null : { ...r.ssh },
  machine: r.machine === null ? null : { ...r.machine, agents: [...r.machine.agents] },
});

const copyTombstone = (t: Tombstone): Tombstone => ({ ...t });

export function openLinkStore(
  file: string,
  opts: {
    now: () => number;
    log: { error(msg: string, data?: Record<string, unknown>): void };
    io?: LinkStoreIo;
  },
): LinkStore {
  const io = opts.io ?? defaultIo;
  const cutoff = () => opts.now() - TOMBSTONE_TTL_MS;
  const isLive = (t: Tombstone) => Date.parse(t.revokedAt) >= cutoff();

  let state: LinksFile = { version: LINKS_VERSION, links: [], tombstones: [] };
  let writable = true;
  let baselineKnown = true;
  let nextRevision = 0;
  const revisions = new Map<string, number>();
  const changed = (id: string) => revisions.set(id, ++nextRevision);

  const text = io.read(file);
  if (text !== null) {
    const parsed = parseLinksFile(text, opts.now());
    if (parsed.kind === 'ok') {
      state = parsed.file;
    } else if (parsed.kind === 'newer') {
      // A newer build owns this file: its contents must survive, so nothing is written from here.
      writable = false;
      baselineKnown = false;
      opts.log.error('links.json is from a newer version; running read-only', { file });
    } else {
      // A corrupt file is kept as the first backup. A second corrupt file is left where it is,
      // so the first backup is never overwritten.
      baselineKnown = false;
      const backup = path.join(path.dirname(file), CORRUPT_FILE);
      if (io.read(backup) === null) io.rename(file, backup);
      opts.log.error('links.json is corrupt; started with no links', { file, backup });
    }
  }

  const persist = () => {
    if (!writable) return;
    const dropped: LinksFile = {
      version: LINKS_VERSION,
      links: state.links,
      tombstones: state.tombstones.filter(isLive),
    };
    state = dropped;
    io.write(file, serializeLinksFile(dropped));
    baselineKnown = true;
  };

  const putLink = (r: LinkRecord): void => {
    changed(r.machineId);
    state = {
      ...state,
      links: [...state.links.filter((l) => l.machineId !== r.machineId), copyLink(r)],
      tombstones: state.tombstones.filter((t) => t.machineId !== r.machineId),
    };
    persist();
  };

  return {
    revision: (machineId) =>
      state.links.some((link) => link.machineId === machineId)
        ? (revisions.get(machineId) ?? 0)
        : null,
    get writable() {
      return writable;
    },
    links: () => state.links.map(copyLink),
    peerKnown(machineId) {
      if (state.links.some((link) => link.machineId === machineId)) return true;
      if (state.tombstones.some((tombstone) => tombstone.machineId === machineId)) return false;
      return baselineKnown ? false : null;
    },
    get: (machineId) => {
      const found = state.links.find((l) => l.machineId === machineId);
      return found ? copyLink(found) : null;
    },
    byServerKey(serverKey) {
      const live = state.links.find((l) => l.serverKey === serverKey);
      if (live) return copyLink(live);
      const tomb = state.tombstones.find((t) => t.serverKey === serverKey && isLive(t));
      return tomb ? { tombstone: copyTombstone(tomb) } : null;
    },
    conflicts(machineId, serverKey) {
      return (
        state.links.some((l) => l.machineId === machineId && l.serverKey !== serverKey) ||
        state.tombstones.some(
          (t) => t.machineId === machineId && t.serverKey !== serverKey && isLive(t),
        )
      );
    },
    put: putLink,
    addSsh(r) {
      const record: LinkRecord = {
        linkId: `l_${randomBytes(8).toString('hex')}`,
        machineId: r.machineId,
        serverKey: r.serverKey,
        ownerKey: r.ownerKey,
        name: r.name,
        trust: 'own',
        addresses: [],
        capabilities: { ...OWN_DEFAULT_CAPABILITIES },
        fingerprint: '',
        createdAt: new Date(opts.now()).toISOString(),
        cert: '',
        ownerTransfer: null,
        transport: 'ssh',
        ssh: r.ssh,
        machine: null,
      };
      putLink(record);
      return copyLink(record);
    },
    setMachine(machineId, meta) {
      const found = state.links.find((l) => l.machineId === machineId);
      if (found?.transport !== 'ssh') return null;
      changed(machineId);
      const next = copyLink({ ...found, machine: meta });
      state = {
        ...state,
        links: state.links.map((l) => (l.machineId === machineId ? next : l)),
      };
      persist();
      return copyLink(next);
    },
    update(machineId, patch) {
      const found = state.links.find((l) => l.machineId === machineId);
      if (!found) return null;
      if (patch.ssh !== undefined && found.transport !== 'ssh') return null;
      changed(machineId);
      const next = copyLink({ ...found, ...patch });
      state = {
        ...state,
        links: state.links.map((l) => (l.machineId === machineId ? next : l)),
      };
      persist();
      return copyLink(next);
    },
    // An ssh peer has no certificate to trust; an empty PEM would be a CA the listener can't use.
    trustedCerts: () => [
      ...state.links.filter((l) => l.transport === 'tls').map((l) => l.cert),
      ...state.tombstones
        .filter(isLive)
        .map((t) => t.cert)
        .filter((c) => c !== ''),
    ],
    remove(machineId) {
      if (!state.links.some((l) => l.machineId === machineId)) return false;
      changed(machineId);
      state = { ...state, links: state.links.filter((l) => l.machineId !== machineId) };
      persist();
      return true;
    },
    revoke(machineId, at) {
      const found = state.links.find((l) => l.machineId === machineId);
      if (!found) return null;
      changed(machineId);
      const tombstone: Tombstone = {
        linkId: found.linkId,
        machineId,
        serverKey: found.serverKey,
        revokedAt: new Date(at).toISOString(),
        cert: found.cert,
      };
      state = {
        ...state,
        links: state.links.filter((l) => l.machineId !== machineId),
        tombstones: [...state.tombstones.filter((t) => t.machineId !== machineId), tombstone],
      };
      persist();
      return copyTombstone(tombstone);
    },
  };
}
