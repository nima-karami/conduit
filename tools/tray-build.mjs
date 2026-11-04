import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkRust } from './check-rust.mjs';
import { TRAY_CRATE_DIR } from './tray-check.mjs';

const TARGET = 'x86_64-pc-windows-msvc';
const MAX_BYTES = 2 * 1024 * 1024;
const VENDOR_EXE = join('build/vendor/tray/conduit-tray.exe');

/**
 * @param {{ platform?: string; spawn?: typeof spawnSync; copyFile?: typeof copyFileSync; mkdir?: typeof mkdirSync; stat?: typeof statSync }} [o]
 * @returns {number}
 */
export function runTrayBuild(o = {}) {
  const platform = o.platform ?? process.platform;
  const spawn = o.spawn ?? spawnSync;
  const copyFile = o.copyFile ?? copyFileSync;
  const mkdir = o.mkdir ?? mkdirSync;
  const stat = o.stat ?? statSync;

  if (platform !== 'win32') {
    console.error('tray:build requires Windows');
    return 1;
  }
  const pre = checkRust(spawn);
  if (!pre.ok) {
    console.error(pre.message);
    return 1;
  }
  const build = spawn('cargo', ['build', '--release', '--locked', '--target', TARGET], {
    stdio: 'inherit',
    cwd: TRAY_CRATE_DIR,
  });
  if (build.status !== 0) return build.status ?? 1;

  const built = join('native/tray/target', TARGET, 'release/conduit-tray.exe');
  const size = stat(built).size;
  if (size > MAX_BYTES) {
    console.error(`conduit-tray.exe ${size} bytes exceeds ${MAX_BYTES} byte budget`);
    return 1;
  }
  mkdir(dirname(VENDOR_EXE), { recursive: true });
  copyFile(built, VENDOR_EXE);
  return 0;
}

function main() {
  process.exit(runTrayBuild());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
