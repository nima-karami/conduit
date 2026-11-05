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
 * hc rebuilds PATH inside terminals; pin the app's node path for the CLI's MCP entries.
 */
function nodeOnPath(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  exists: (file: string) => boolean,
): string | undefined {
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH');
  const exe = runtimeBinaryName('node', platform);
  return (key ? (env[key] ?? '') : '')
    .split(platform === 'win32' ? ';' : ':')
    .filter(Boolean)
    .map((dir) => join(dir, exe))
    .find(exists);
}

/**
 * See D2/D24: a missing Conduit hc must never select the user's installed executable.
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
  if (!i.env.CONDUIT_HC_BINARY && !exists(vendorHc)) {
    throw new Error(
      `Missing vendored conduit-hc at ${vendorHc}; run node build/fetch-runtime.mjs or set CONDUIT_HC_BINARY.`,
    );
  }
  return {
    nodeExe: i.env.CONDUIT_NODE_BINARY ?? nodeOnPath(i.env, platform, exists) ?? 'node',
    superviseJs: join(i.appPath, 'out', 'server', 'supervise.js'),
    hcExe: i.env.CONDUIT_HC_BINARY || vendorHc,
    hcVersion,
    coreCwd,
  };
}
