import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/** The per-start C2 secret, in the user's userData: user-only on posix and Windows alike. */
export const SERVER_SECRET_FILE = 'server-secret';

/** Null only when no server has started in this userData; any other read error is real and throws. */
export function readServerSecret(userData: string): string | null {
  try {
    return readFileSync(path.join(userData, SERVER_SECRET_FILE), 'utf8').trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** Constant-time. A length mismatch is a mismatch: timingSafeEqual throws on unequal lengths. */
export function secretMatches(expected: string, given: unknown): boolean {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}
