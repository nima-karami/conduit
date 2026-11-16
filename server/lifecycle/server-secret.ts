import { randomBytes, randomUUID } from 'node:crypto';
import { renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { SERVER_SECRET_FILE } from '../../src/server-secret';

/**
 * A new value every start, so a secret copied from an earlier run stops working. Written to a
 * fresh temp file and renamed, so a reader never sees a half-written value.
 */
export function writeServerSecret(userData: string): string {
  const secret = randomBytes(32).toString('base64url');
  const target = path.join(userData, SERVER_SECRET_FILE);
  const temp = `${target}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, secret, { mode: 0o600 });
    renameSync(temp, target);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
  return secret;
}
