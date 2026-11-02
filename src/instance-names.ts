import { createHash } from 'node:crypto';
import { posix, win32 } from 'node:path';
import { endpointPath } from './conduit-mcp/endpoint-path';
import type { InstanceNames } from './contracts/session-identity';

const MAX_SOCKET_PATH_BYTES = 100;

export function instanceNames(
  userData: string,
  platform: 'win32' | 'posix',
  tmpdir: string,
): InstanceNames {
  const identity = platform === 'win32' ? userData.toLowerCase() : userData;
  const instance = createHash('sha256').update(identity).digest('hex').slice(0, 16);
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
