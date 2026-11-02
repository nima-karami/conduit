import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { HC_PINNED_VERSION } from '../src/contracts/hc';
import { coreStartCwd } from '../src/instance-names';

export interface RuntimeLayout {
  nodeExe: string;
  superviseJs: string;
  hcExe: string;
  hcVersion: string;
  coreCwd: string;
}

/**
 * Packaged: what server/runtime-dir/prepare.ts copies out of the install dir (D2). Unpackaged: the
 * repo's own build plus the node and hc on PATH, overridable for dev and e2e.
 */
export function runtimeLayout(i: {
  packaged: boolean;
  userData: string;
  appVersion: string;
  appPath: string;
  env: NodeJS.ProcessEnv;
}): RuntimeLayout {
  const runtimeRoot = join(i.userData, 'runtime');
  const hcVersion = HC_PINNED_VERSION;
  const coreCwd = coreStartCwd(runtimeRoot, hcVersion);
  mkdirSync(coreCwd, { recursive: true });
  if (i.packaged) {
    const appDir = join(runtimeRoot, i.appVersion);
    return {
      nodeExe: join(appDir, 'node.exe'),
      superviseJs: join(appDir, 'server', 'supervise.js'),
      hcExe: join(coreCwd, 'hc.exe'),
      hcVersion,
      coreCwd,
    };
  }
  return {
    nodeExe: i.env.CONDUIT_NODE_BINARY ?? 'node',
    superviseJs: join(i.appPath, 'out', 'server', 'supervise.js'),
    hcExe: i.env.CONDUIT_HC_BINARY ?? 'hc',
    hcVersion,
    coreCwd,
  };
}
