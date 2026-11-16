import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/** The per-start C2 secret, in the user's userData: user-only on posix and Windows alike. */
export const SERVER_SECRET_FILE = 'server-secret';

/** The endpoint the ssh bridge connects to, recorded by the server that listens on it. */
export const LINK_ENDPOINT_FILE = 'link-endpoint';

/** Null only when no server has started in this userData; any other read error is real and throws. */
export function readServerSecret(userData: string): string | null {
  return readRecord(userData, SERVER_SECRET_FILE);
}

/** Null when no server has recorded its link endpoint here, which is also what a stopped server leaves. */
export function readLinkEndpoint(userData: string): string | null {
  return readRecord(userData, LINK_ENDPOINT_FILE);
}

function readRecord(userData: string, file: string): string | null {
  try {
    return readFileSync(path.join(userData, file), 'utf8').trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** The refusal every gated method gives an un-authed peer; the client matches it to redial. */
export const AUTH_REQUIRED_MESSAGE = 'auth required';

/** Constant-time. A length mismatch is a mismatch: timingSafeEqual throws on unequal lengths. */
export function secretMatches(expected: string, given: unknown): boolean {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}
