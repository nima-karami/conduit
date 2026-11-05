// Side-effect-free so the runner's sweep worker can pin the same hc as the scenarios without
// importing harness.mjs (which mutates env and registers exit hooks).
import { existsSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * `name` as the first PATH entry holding it, the way the app's spawn of a bare name finds it.
 * @param {string} name
 * @param {{ env?: Record<string, string | undefined>, platform?: string,
 *   exists?: (p: string) => boolean }} [o]
 */
export function onPath(
  name,
  { env = process.env, platform = process.platform, exists = existsSync } = {},
) {
  const exe = platform === 'win32' ? `${name}.exe` : name;
  return (env.PATH ?? '')
    .split(delimiter)
    .filter(Boolean)
    .map((dir) => join(dir, exe))
    .find((candidate) => exists(candidate));
}

/**
 * The hc every side of a scenario uses: the app's core and this harness's teardown/ownHc must be
 * the same binary, and a global hc on PATH can be a different version than the pinned one
 * (src/contracts/hc.ts). Same precedence as the app: override, bundled vendor copy.
 * @param {{ env?: Record<string, string | undefined>, platform?: string,
 *   exists?: (p: string) => boolean, repo?: string }} [o]
 */
export function resolveHcBinary({
  env = process.env,
  platform = process.platform,
  exists = existsSync,
  repo = REPO_ROOT,
} = {}) {
  if (env.CONDUIT_HC_BINARY) return env.CONDUIT_HC_BINARY;
  const vendored = join(
    repo,
    'build',
    'vendor',
    'hc',
    platform === 'win32' ? 'conduit-hc.exe' : 'conduit-hc',
  );
  return exists(vendored) ? vendored : undefined;
}
