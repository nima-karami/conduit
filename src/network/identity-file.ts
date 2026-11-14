import { createHash } from 'node:crypto';

export interface IdentityFile {
  version: 1;
  serverKey: { publicKey: string; privateKey: string };
  ownerKey: { publicKey: string; privateKey: string } | null;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';

const isKeyPair = (v: unknown): v is { publicKey: string; privateKey: string } =>
  isObj(v) && isStr(v.publicKey) && isStr(v.privateKey);

// Mirrors judgePersistedVersion (src/contracts/session-identity.ts). Not registered in
// SERVER_FILE_VERSION yet: a later serial task adds network/identity.json there.
function judgeVersion(found: unknown): 'read' | 'newer' | 'invalid' {
  if (typeof found !== 'number' || !Number.isInteger(found) || found < 1) return 'invalid';
  return found > 1 ? 'newer' : 'read';
}

export function parseIdentityFile(
  text: string,
): { kind: 'ok'; file: IdentityFile } | { kind: 'newer' } | { kind: 'corrupt' } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { kind: 'corrupt' };
  }
  if (!isObj(raw)) return { kind: 'corrupt' };
  const verdict = judgeVersion(raw.version);
  if (verdict === 'newer') return { kind: 'newer' };
  if (verdict === 'invalid') return { kind: 'corrupt' };
  if (!isKeyPair(raw.serverKey)) return { kind: 'corrupt' };
  if (raw.ownerKey !== null && !isKeyPair(raw.ownerKey)) return { kind: 'corrupt' };
  return {
    kind: 'ok',
    file: { version: 1, serverKey: raw.serverKey, ownerKey: raw.ownerKey },
  };
}

export function serializeIdentityFile(f: IdentityFile): string {
  return `${JSON.stringify(f)}\n`;
}

// see docs/plans/2026-11-14-conduit-network-machinery.plan.md, Technical decision 2
export function deriveMachineId(publicKeyRaw: Buffer): string {
  return `m-${createHash('sha256').update(publicKeyRaw).digest('hex').slice(0, 8)}`;
}
