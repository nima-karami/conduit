import { TOMBSTONE_TTL_MS } from '../contracts/link-protocol';
import type { Capabilities } from '../contracts/remote-principal';
import { judgePersistedVersion } from '../contracts/session-identity';

export interface LinkRecord {
  linkId: string;
  machineId: string;
  serverKey: string;
  ownerKey: string;
  name: string;
  trust: 'own';
  addresses: string[];
  capabilities: Capabilities;
  fingerprint: string;
  createdAt: string;
}

export interface Tombstone {
  linkId: string;
  machineId: string;
  serverKey: string;
  revokedAt: string;
}

export interface LinksFile {
  version: 1;
  links: LinkRecord[];
  tombstones: Tombstone[];
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
const isMachineId = (v: unknown): v is string => isStr(v) && /^m-[0-9a-f]{8}$/.test(v);
const isIsoTime = (v: unknown): v is string => isStr(v) && !Number.isNaN(Date.parse(v));

const isCapabilities = (v: unknown): v is Capabilities =>
  isObj(v) && isBool(v.messaging) && isBool(v.monitor) && isBool(v.drive);

const isLink = (v: unknown): v is LinkRecord =>
  isObj(v) &&
  isStr(v.linkId) &&
  isMachineId(v.machineId) &&
  isStr(v.serverKey) &&
  isStr(v.ownerKey) &&
  isStr(v.name) &&
  v.trust === 'own' &&
  Array.isArray(v.addresses) &&
  v.addresses.every(isStr) &&
  isCapabilities(v.capabilities) &&
  isStr(v.fingerprint) &&
  isStr(v.createdAt);

const isTombstone = (v: unknown): v is Tombstone =>
  isObj(v) &&
  isStr(v.linkId) &&
  isMachineId(v.machineId) &&
  isStr(v.serverKey) &&
  isIsoTime(v.revokedAt);

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
  if (!Array.isArray(raw.links) || !raw.links.every(isLink)) return { kind: 'corrupt' };
  if (!Array.isArray(raw.tombstones) || !raw.tombstones.every(isTombstone)) {
    return { kind: 'corrupt' };
  }
  // see docs/plans/2026-11-14-conduit-network-machinery.plan.md, Slice 1 T1.2
  const cutoff = now - TOMBSTONE_TTL_MS;
  const tombstones = raw.tombstones.filter((t) => Date.parse(t.revokedAt) >= cutoff);
  return { kind: 'ok', file: { version: 1, links: raw.links, tombstones } };
}

export function serializeLinksFile(f: LinksFile): string {
  return `${JSON.stringify(f)}\n`;
}
