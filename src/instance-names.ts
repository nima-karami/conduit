import { join, posix, win32 } from 'node:path';
import { endpointPath } from './conduit-mcp/endpoint-path';
import type { InstanceNames } from './contracts/session-identity';
import { instanceDigest } from './instance-digest';

const MAX_SOCKET_PATH_BYTES = 100;

export function instanceNames(
  userData: string,
  platform: 'win32' | 'posix',
  tmpdir: string,
): InstanceNames {
  const instance = instanceDigest(userData, platform);
  const path = platform === 'win32' ? win32 : posix;
  const profileServerEndpoint = path.join(userData, 'conduit-server.sock');

  return {
    instance,
    serverEndpoint:
      platform === 'win32'
        ? `\\\\.\\pipe\\conduit-server-${instance}`
        : Buffer.byteLength(profileServerEndpoint, 'utf8') > MAX_SOCKET_PATH_BYTES
          ? posix.join(tmpdir, `conduit-server-${instance}.sock`)
          : profileServerEndpoint,
    mcpEndpoint: endpointPath(userData, platform, tmpdir),
    supervisorName: `conduit-server-${instance}`,
    hcSession: `conduit-${instance}`,
    runtimeRoot: path.join(userData, 'runtime'),
    hcConfigHome: path.join(userData, 'hc', 'config'),
    hcStateHome: path.join(userData, 'hc', 'state'),
  };
}

/**
 * Cwd for every hc call that may start or restart a core: the core inherits the starting CLI's cwd
 * and its holders inherit the core's, and only a cwd blocks the GC rename (M21, D23). Lives here, not in C4,
 * because C4 is imported by the webview bundle, which has no node:path.
 */
export function coreStartCwd(runtimeRoot: string, hcVersion: string): string {
  return join(runtimeRoot, 'hc', hcVersion);
}
