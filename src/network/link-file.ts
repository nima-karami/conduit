import { TOMBSTONE_TTL_MS } from '../contracts/link-protocol';
import type { MachineMeta } from '../contracts/machines';
import type { Capabilities } from '../contracts/remote-principal';
import { judgePersistedVersion } from '../contracts/session-identity';
import type { SshEndpoint } from '../contracts/ssh-link';

export interface LinkRecord {
  linkId: string;
  machineId: string;
  serverKey: string;
  /** Null only for an ssh peer whose server has no owner key; a tls link always has one. */
  ownerKey: string | null;
  name: string;
  trust: 'own';
  addresses: string[];
  capabilities: Capabilities;
  fingerprint: string;
  createdAt: string;
  /** The peer's certificate (PEM): the only CA its TLS connection is verified against. */
  cert: string;
  /** The owner private key still has to cross this link once it is up (plan decision 10). */
  ownerTransfer: 'send' | 'receive' | null;
  /** Records from before ssh links existed have no field; they parse as 'tls'. */
  transport: 'tls' | 'ssh';
  /** How this side dials an ssh peer; null where the peer only dials us. */
  ssh: SshEndpoint | null;
  /** A machine we pinned by ssh; present on the controller's ssh records only (plan decision 1). */
  machine: MachineMeta | null;
}

export interface Tombstone {
  linkId: string;
  machineId: string;
  serverKey: string;
  revokedAt: string;
  /** Kept so the revoked peer's next handshake still verifies, and it hears it was revoked. */
  cert: string;
}

export interface LinksFile {
  version: 3;
  links: LinkRecord[];
  tombstones: Tombstone[];
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
const isMachineId = (v: unknown): v is string => isStr(v) && /^m-[0-9a-f]{8}$/.test(v);
const isIsoTime = (v: unknown): v is string => isStr(v) && !Number.isNaN(Date.parse(v));
const isNonEmptyStr = (v: unknown): v is string => isStr(v) && v.length > 0;

const isSshEndpoint = (v: unknown): v is SshEndpoint =>
  isObj(v) &&
  isNonEmptyStr(v.target) &&
  isNonEmptyStr(v.node) &&
  isNonEmptyStr(v.mainJs) &&
  isNonEmptyStr(v.userData);

const stringsOf = (v: unknown): string[] | null => {
  if (!Array.isArray(v) || !v.every(isStr)) return null;
  return v;
};

/** Machine metadata as bootstrap writes it; any other shape is not a record we wrote. */
const parseMachine = (v: unknown): MachineMeta | undefined => {
  if (!isObj(v)) return undefined;
  const agents = stringsOf(v.agents);
  if (
    (v.os !== 'linux' && v.os !== 'windows') ||
    v.arch !== 'x64' ||
    !isStr(v.version) ||
    (v.mode !== 'full' && v.mode !== 'light') ||
    agents === null ||
    !isBool(v.enabled) ||
    (v.survivesLogout !== null && !isBool(v.survivesLogout))
  )
    return undefined;
  return {
    os: v.os,
    arch: v.arch,
    version: v.version,
    mode: v.mode,
    agents,
    enabled: v.enabled,
    survivesLogout: v.survivesLogout,
  };
};

const isCapabilities = (v: unknown): v is Capabilities =>
  isObj(v) && isBool(v.messaging) && isBool(v.monitor) && isBool(v.drive);

const stringList = (v: unknown): string[] | null => {
  if (!Array.isArray(v)) return null;
  const out: string[] = [];
  for (const item of v) {
    if (!isStr(item)) return null;
    out.push(item);
  }
  return out;
};

/**
 * One stored link, read field by field: each value is checked where it is taken, so the record is
 * built from proven types and needs no cast. A missing transport is a tls link (version 1 files).
 */
const parseLink = (v: Obj): LinkRecord | null => {
  const transport =
    v.transport === 'ssh'
      ? 'ssh'
      : v.transport === undefined || v.transport === 'tls'
        ? 'tls'
        : null;
  if (transport === null) return null;
  const ssh =
    v.ssh === undefined || v.ssh === null ? null : isSshEndpoint(v.ssh) ? v.ssh : undefined;
  // Only an ssh record may carry an endpoint; a tls record with one is not a record we wrote.
  if (ssh === undefined || (transport === 'tls' && ssh !== null)) return null;
  // Version 2 files have no machine block: their records load with none, as the next bootstrap adds it.
  const machine = v.machine === undefined || v.machine === null ? null : parseMachine(v.machine);
  if (machine === undefined || (transport === 'tls' && machine !== null)) return null;
  // An ssh peer's server may have no owner key; a tls link always has one.
  const ownerKey = isStr(v.ownerKey)
    ? v.ownerKey
    : transport === 'ssh' && v.ownerKey === null
      ? null
      : undefined;
  const addresses = stringList(v.addresses);
  const ownerTransfer =
    v.ownerTransfer === 'send' || v.ownerTransfer === 'receive' || v.ownerTransfer === null
      ? v.ownerTransfer
      : undefined;
  if (
    ownerKey === undefined ||
    addresses === null ||
    ownerTransfer === undefined ||
    !isStr(v.linkId) ||
    !isMachineId(v.machineId) ||
    !isStr(v.serverKey) ||
    !isStr(v.name) ||
    v.trust !== 'own' ||
    !isCapabilities(v.capabilities) ||
    !isStr(v.fingerprint) ||
    !isStr(v.createdAt) ||
    !isStr(v.cert)
  )
    return null;
  return {
    linkId: v.linkId,
    machineId: v.machineId,
    serverKey: v.serverKey,
    ownerKey,
    name: v.name,
    trust: 'own',
    addresses,
    capabilities: v.capabilities,
    fingerprint: v.fingerprint,
    createdAt: v.createdAt,
    cert: v.cert,
    ownerTransfer,
    transport,
    ssh,
    machine,
  };
};

const isTombstone = (v: unknown): v is Tombstone =>
  isObj(v) &&
  isStr(v.linkId) &&
  isMachineId(v.machineId) &&
  isStr(v.serverKey) &&
  isIsoTime(v.revokedAt) &&
  isStr(v.cert);

export function parseLinksFile(
  text: string,
  now: number,
): { kind: 'ok'; file: LinksFile } | { kind: 'newer' } | { kind: 'corrupt' } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { kind: 'corrupt' };
  }
  if (!isObj(raw)) return { kind: 'corrupt' };
  const verdict = judgePersistedVersion('network/links.json', raw.version);
  if (verdict === 'newer') return { kind: 'newer' };
  if (verdict === 'invalid') return { kind: 'corrupt' };
  if (!Array.isArray(raw.links)) return { kind: 'corrupt' };
  if (!Array.isArray(raw.tombstones) || !raw.tombstones.every(isTombstone)) {
    return { kind: 'corrupt' };
  }
  // see docs/plans/2026-11-14-conduit-network-machinery.plan.md, Slice 1 T1.2
  const cutoff = now - TOMBSTONE_TTL_MS;
  const tombstones = raw.tombstones.filter((t) => Date.parse(t.revokedAt) >= cutoff);
  const links: LinkRecord[] = [];
  for (const item of raw.links) {
    const link = isObj(item) ? parseLink(item) : null;
    if (link === null) return { kind: 'corrupt' };
    links.push(link);
  }
  return { kind: 'ok', file: { version: 3, links, tombstones } };
}

export function serializeLinksFile(f: LinksFile): string {
  return `${JSON.stringify(f)}\n`;
}
