import { versionOrder } from '../contracts/server-protocol';
import type { ProbeResult } from './remote-scripts';

export type InstallPlan =
  | { kind: 'attach'; version: string }
  | { kind: 'install'; version: string }
  | { kind: 'upgrade'; version: string; from: string }
  | { kind: 'unsupported'; os: string; arch: string }
  | { kind: 'incompatible'; remote: string };

/** RS-D9: win-x64 and linux-x64 remotes only. */
const SUPPORTED: readonly (readonly [string, string])[] = [
  ['linux', 'x64'],
  ['windows', 'x64'],
];

/**
 * What to do on the remote, from the probe. `recorded` is a hint from the remote's own server
 * (decision 8), so attach means "a same-major server runs there, or a newer one, which we never
 * replace". The copy is skipped by the caller when `p.installed` already holds the version.
 */
export function planInstall(
  local: { version: string; linkMajor: number },
  p: ProbeResult,
): InstallPlan {
  if (!SUPPORTED.some(([os, arch]) => p.os === os && p.arch === arch)) {
    return { kind: 'unsupported', os: p.os, arch: p.arch };
  }
  const recorded = p.recorded;
  if (recorded === null) return { kind: 'install', version: local.version };
  if (recorded.linkMajor !== local.linkMajor) {
    return { kind: 'incompatible', remote: recorded.version };
  }
  // Both sides carry the same link major, so versionOrder compares only the semver parts.
  const order = versionOrder(
    { generation: local.linkMajor, version: local.version },
    { generation: recorded.linkMajor, version: recorded.version },
  );
  if (order === 'appNewer') {
    return { kind: 'upgrade', version: local.version, from: recorded.version };
  }
  // 'same' and 'appOlder' both attach to the server that is running; appOlder never downgrades.
  return { kind: 'attach', version: recorded.version };
}
