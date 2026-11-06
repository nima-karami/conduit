import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/** @typedef {{ ok: true } | { ok: false, message: string }} CheckRustResult */

/** @type {'Rust toolchain not found: install rustup (https://rustup.rs) to run the tray-helper checks'} */
export const TRAY_RUST_INSTALL_MESSAGE =
  'Rust toolchain not found: install rustup (https://rustup.rs) to run the tray-helper checks';

/**
 * Preflight for tray cargo scripts. Never skips — callers exit non-zero on failure (spec §4).
 *
 * @param {typeof spawnSync} [spawn]
 * @returns {CheckRustResult}
 */
export function checkRust(spawn = spawnSync) {
  const r = spawn('cargo', ['--version'], { encoding: 'utf8' });
  if (r.error?.code === 'ENOENT' || r.status !== 0) {
    return { ok: false, message: TRAY_RUST_INSTALL_MESSAGE };
  }
  return { ok: true };
}

/**
 * @param {typeof spawnSync} [spawn]
 * @returns {number}
 */
export function runCheckRustCli(spawn = spawnSync) {
  const result = checkRust(spawn);
  if (!result.ok) {
    console.error(result.message);
    return 1;
  }
  return 0;
}

function main() {
  process.exit(runCheckRustCli());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
