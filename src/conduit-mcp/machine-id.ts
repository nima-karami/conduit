import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { atomicWriteFileSync } from '../atomic-write';

const MACHINE_ID_RE = /^m-[0-9a-f]{8}$/;

const isMissing = (e: unknown): boolean =>
  typeof e === 'object' && e !== null && (e as NodeJS.ErrnoException).code === 'ENOENT';

function readExistingId(file: string): string | null {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (isMissing(e)) return null;
    throw e;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null || !('id' in raw)) return null;
  const id = raw.id;
  return typeof id === 'string' && MACHINE_ID_RE.test(id) ? id : null;
}

// Provisional machine id until CON-16 derives it from the server key (docs/specs/2026-11-14-conduit-network.md §4.1); keep every reader behind this accessor.
export function loadMachineId(dir: string): string {
  const file = path.join(dir, 'machine-id.json');
  const existing = readExistingId(file);
  if (existing !== null) return existing;
  const id = `m-${randomBytes(4).toString('hex')}`;
  fs.mkdirSync(dir, { recursive: true });
  atomicWriteFileSync(file, JSON.stringify({ version: 1, id }));
  return id;
}
