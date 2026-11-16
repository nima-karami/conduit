import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The leaf of src/server-secret.ts's SERVER_SECRET_FILE: .mjs e2e files cannot import the .ts module.
const SERVER_SECRET_FILE = 'server-secret';

/**
 * The secret a C2 client presents in `hello.auth`. Throws if no server has started in this
 * userData, because a hello without it is refused and the scenario would fail far from here.
 */
export function c2Auth(userData) {
  const secret = c2AuthIfRunning(userData);
  if (secret === undefined)
    throw new Error(`no C2 secret under ${userData}: no server has started`);
  return secret;
}

/** The same secret, or undefined when none exists: a teardown must still resolve with no server. */
export function c2AuthIfRunning(userData) {
  try {
    return readFileSync(join(userData, SERVER_SECRET_FILE), 'utf8').trim() || undefined;
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}
