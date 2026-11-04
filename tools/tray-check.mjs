import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkRust } from './check-rust.mjs';

const MANIFEST = join('native/tray/Cargo.toml');
const MSVC = 'x86_64-pc-windows-msvc';

/**
 * @param {string[]} cargoArgs
 * @param {typeof spawnSync} spawn
 */
function runCargo(cargoArgs, spawn = spawnSync) {
  const args = [...cargoArgs, '--manifest-path', MANIFEST];
  if (cargoArgs[0] !== 'fmt') args.push('--locked');
  return spawn('cargo', args, { stdio: 'inherit' });
}

/**
 * @param {typeof spawnSync} spawn
 * @returns {number} exit code
 */
export function runTrayCheck(spawn = spawnSync) {
  const pre = checkRust(spawn);
  if (!pre.ok) {
    console.error(pre.message);
    return 1;
  }
  const steps = [
    ['fmt', ['fmt', '--check']],
    ['clippy (host)', ['clippy', '--all-targets', '--', '-D', 'warnings']],
    ['clippy (msvc)', ['clippy', '--all-targets', '--target', MSVC, '--', '-D', 'warnings']],
    ['test', ['test']],
  ];
  for (const [, args] of steps) {
    const r = runCargo(args, spawn);
    if (r.status !== 0) return r.status ?? 1;
  }
  return 0;
}

function main() {
  process.exit(runTrayCheck());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
