import { join, resolve } from 'node:path';

/** rust-toolchain.toml is picked up from this cwd (not --manifest-path). */
const TRAY_CRATE_DIR = join('native', 'tray');

/**
 * @param {string} repoRoot
 * @param {string} gitCommonDir
 * @param {string} [override]
 */
export function resolveTrayTargetDir(repoRoot, gitCommonDir, override) {
  return override
    ? resolve(repoRoot, TRAY_CRATE_DIR, override)
    : resolve(repoRoot, gitCommonDir, 'tray-target');
}

/** @typedef {typeof import('node:child_process').spawnSync} SpawnSync */

/** @param {SpawnSync} spawn */
export function getTrayTargetDir(spawn) {
  const repoRoot = process.cwd();
  const override = process.env.CARGO_TARGET_DIR;
  if (override) return resolveTrayTargetDir(repoRoot, '', override);

  const git = spawn('git', ['rev-parse', '--git-common-dir'], {
    encoding: 'utf8',
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
  if (git.error) throw git.error;
  const commonDir = git.stdout?.replace(/\r?\n$/, '');
  if (git.status !== 0 || !commonDir) {
    throw new Error(`Could not resolve the Git common directory: ${git.stderr?.trim() ?? ''}`);
  }
  return resolveTrayTargetDir(repoRoot, commonDir);
}

/**
 * @param {string[]} cargoArgs
 * @param {string} targetDir
 * @param {SpawnSync} spawn
 */
export function runCargo(cargoArgs, targetDir, spawn) {
  const args = [...cargoArgs];
  // After `--`, Cargo would forward the lock flag to clippy-driver.
  if (args[0] !== 'fmt') {
    const sep = args.indexOf('--');
    args.splice(sep === -1 ? args.length : sep, 0, '--locked');
  }
  return spawn('cargo', args, {
    stdio: 'inherit',
    cwd: TRAY_CRATE_DIR,
    env: { ...process.env, CARGO_TARGET_DIR: targetDir },
  });
}
