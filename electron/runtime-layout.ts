import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { HC_PINNED_VERSION } from '../src/contracts/hc';
import { coreStartCwd } from '../src/instance-names';
import { runtimeBinaryName } from '../src/runtime-binary';

export interface RuntimeLayout {
  nodeExe: string;
  superviseJs: string;
  hcExe: string;
  hcVersion: string;
  coreCwd: string;
}

/**
 * The first `name` on the app's PATH, as an absolute path. A bare node would be resolved by hc,
 * whose spelling (`node.EXE`) the server then writes into every CLI's MCP entry; a bare hc is
 * resolved inside an hc terminal, whose PATH hc rebuilds rather than taking the app's.
 */
function onPath(
  env: NodeJS.ProcessEnv,
  name: 'node' | 'hc',
  platform: NodeJS.Platform,
  exists: (file: string) => boolean,
): string | undefined {
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH');
  const exe = runtimeBinaryName(name, platform);
  return (key ? (env[key] ?? '') : '')
    .split(platform === 'win32' ? ';' : ':')
    .filter(Boolean)
    .map((dir) => join(dir, exe))
    .find(exists);
}

/**
 * Packaged uses the copied runtime so installers can replace the install dir (D2). Unpackaged
 * prefers vendored hc on supported platforms so a newer global install doesn't cause `core replaced`.
 */
export function runtimeLayout(i: {
  packaged: boolean;
  userData: string;
  appVersion: string;
  appPath: string;
  env: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  exists?: (file: string) => boolean;
}): RuntimeLayout {
  const runtimeRoot = join(i.userData, 'runtime');
  const platform = i.platform ?? process.platform;
  const exists = i.exists ?? existsSync;
  const nodeBinary = runtimeBinaryName('node', platform);
  const hcBinary = runtimeBinaryName('hc', platform);
  const hcVersion = HC_PINNED_VERSION;
  const coreCwd = coreStartCwd(runtimeRoot, hcVersion);
  mkdirSync(coreCwd, { recursive: true });
  if (i.packaged) {
    const appDir = join(runtimeRoot, i.appVersion);
    return {
      nodeExe: join(appDir, nodeBinary),
      superviseJs: join(appDir, 'server', 'supervise.js'),
      hcExe: join(coreCwd, hcBinary),
      hcVersion,
      coreCwd,
    };
  }
  const vendorHc = join(i.appPath, 'build', 'vendor', 'hc', hcBinary);
  return {
    nodeExe: i.env.CONDUIT_NODE_BINARY ?? onPath(i.env, 'node', platform, exists) ?? 'node',
    superviseJs: join(i.appPath, 'out', 'server', 'supervise.js'),
    hcExe:
      i.env.CONDUIT_HC_BINARY ??
      ((platform === 'win32' || platform === 'darwin') && exists(vendorHc)
        ? vendorHc
        : undefined) ??
      onPath(i.env, 'hc', platform, exists) ??
      'hc',
    hcVersion,
    coreCwd,
  };
}
