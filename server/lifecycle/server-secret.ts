import { randomBytes, randomUUID } from 'node:crypto';
import { renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { LINK_ENDPOINT_FILE, SERVER_SECRET_FILE } from '../../src/server-secret';

/**
 * A new value every start, so a secret copied from an earlier run stops working. Written to a
 * fresh temp file and renamed, so a reader never sees a half-written value.
 */
export function writeServerSecret(userData: string): string {
  const secret = randomBytes(32).toString('base64url');
  writeRecord(userData, SERVER_SECRET_FILE, secret);
  return secret;
}

/** Recorded after the endpoint listens, so the bridge connects where this server really is. */
export function writeLinkEndpoint(userData: string, endpoint: string): void {
  writeRecord(userData, LINK_ENDPOINT_FILE, endpoint);
}

/** Removed on stop: a record left behind would send a bridge to a socket nobody answers. */
export function removeLinkEndpoint(userData: string): void {
  rmSync(path.join(userData, LINK_ENDPOINT_FILE), { force: true });
}

function writeRecord(userData: string, file: string, value: string): void {
  const target = path.join(userData, file);
  const temp = `${target}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, value, { mode: 0o600 });
    renameSync(temp, target);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}
