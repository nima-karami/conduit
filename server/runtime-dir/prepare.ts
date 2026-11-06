import { execFile } from 'node:child_process';
import { promises } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { SHIM_LEAF } from '../../src/conduit-mcp/install-entries';
import { SHIM_RUNTIME_DIR } from '../../src/contracts/session-identity';
import { coreStartCwd } from '../../src/instance-names';
import { runtimeBinaryName } from '../../src/runtime-binary';

const runCommand = promisify(execFile);

/** The slice of node:fs/promises preparation uses; injected so a failed copy can be tested. */
export interface RuntimeFs {
  access(path: string): Promise<void>;
  mkdir(path: string, options: { recursive: true }): Promise<unknown>;
  rm(path: string, options: { recursive: true; force: true }): Promise<void>;
  cp(source: string, destination: string, options: { recursive: true }): Promise<void>;
  rename(from: string, to: string): Promise<void>;
}

/** Bumped only together with a CLI-entry migration to the new dir (D2b). */
export const CURRENT_SHIM_GENERATION = 1;

export interface PrepareRuntimeOptions {
  /** A packaged app's `process.resourcesPath`: see package.json extraResources. */
  resourcesDir: string;
  userData: string;
  appVersion: string;
  hcVersion: string;
  shimVersion: number;
  platform?: NodeJS.Platform;
  fs?: RuntimeFs;
  run?: (file: string, args: string[]) => Promise<unknown>;
  warn?: (message: string) => void;
}

export interface PreparedRuntime {
  nodeExe: string;
  superviseJs: string;
  mainJs: string;
  hcExe: string;
  shimDir: string;
  trayExe: string | null;
}

function shimDirName(generation: number): string {
  return generation === 1 ? SHIM_RUNTIME_DIR : `${SHIM_RUNTIME_DIR}-${generation}`;
}

/**
 * Copies the bundled runtime out of the install dir, which the installer replaces under live
 * processes (D2). Long-lived processes then run with their cwd in these dirs, so W7's GC rename
 * test alone decides when one may go (D23, M21).
 */
export async function prepareRuntime(options: PrepareRuntimeOptions): Promise<PreparedRuntime> {
  const fs = options.fs ?? promises;
  const platform = options.platform ?? process.platform;
  const nodeBinary = runtimeBinaryName('node', platform);
  const hcBinary = runtimeBinaryName('hc', platform);
  const bundled = join(options.resourcesDir, 'runtime');
  const nodeSource = join(bundled, nodeBinary);
  const root = join(options.userData, 'runtime');
  const appDir = join(root, options.appVersion);
  const hcDir = coreStartCwd(root, options.hcVersion);
  const shimDir = join(root, shimDirName(options.shimVersion));
  const traySource = join(bundled, 'tray');
  const hasTray = platform === 'win32' && (await exists(fs, join(traySource, 'conduit-tray.exe')));

  const beforeRename = async (staging: string) => {
    if (platform !== 'darwin') return;
    try {
      await (options.run ?? runCommand)('xattr', ['-dr', 'com.apple.quarantine', staging]);
    } catch (error) {
      (options.warn ?? console.warn)(
        `Could not remove quarantine from ${staging}: ${String(error)}`,
      );
    }
  };

  await ensureDir(fs, hcDir, [{ contentsOf: join(bundled, 'hc') }], beforeRename);
  await ensureDir(
    fs,
    appDir,
    [nodeSource, join(bundled, 'server'), ...(hasTray ? [traySource] : [])],
    beforeRename,
  );
  await ensureDir(
    fs,
    shimDir,
    [nodeSource, join(options.resourcesDir, 'conduit-mcp', SHIM_LEAF)],
    beforeRename,
  );

  return {
    nodeExe: join(appDir, nodeBinary),
    superviseJs: join(appDir, 'server', 'supervise.js'),
    mainJs: join(appDir, 'server', 'main.js'),
    hcExe: join(hcDir, hcBinary),
    shimDir,
    trayExe:
      hasTray && (await exists(fs, join(appDir, 'tray', 'conduit-tray.exe')))
        ? join(appDir, 'tray', 'conduit-tray.exe')
        : null,
  };
}

/** A path copied under its own leaf, or a dir whose contents become the target's. */
type Source = string | { contentsOf: string };

/**
 * A final dir only ever appears by renaming a fully copied `<dir>.tmp`, so one that exists is
 * complete and is reused untouched; that is also what keeps the shim dir write-once (D2b).
 */
async function ensureDir(
  fs: RuntimeFs,
  target: string,
  sources: Source[],
  beforeRename: (staging: string) => Promise<void>,
): Promise<void> {
  if (await exists(fs, target)) return;
  const staging = `${target}.tmp`;
  await fs.rm(staging, { recursive: true, force: true });
  await fs.mkdir(dirname(target), { recursive: true });
  try {
    for (const source of sources) {
      if (typeof source === 'string') {
        await fs.cp(source, join(staging, basename(source)), { recursive: true });
      } else {
        await fs.cp(source.contentsOf, staging, { recursive: true });
      }
    }
    await beforeRename(staging);
    await fs.rename(staging, target);
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true });
    throw error;
  }
}

async function exists(fs: RuntimeFs, path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
