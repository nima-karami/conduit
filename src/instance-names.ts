import { homedir } from 'node:os';
import { join, posix, win32 } from 'node:path';
import { endpointPath } from './conduit-mcp/endpoint-path';
import type { InstanceNames } from './contracts/session-identity';
import { resolveHcEndpoint } from './hc-client/endpoint';
import { instanceDigest } from './instance-digest';
import { ensurePrivateSocketDirectory, type SocketDirectoryIo } from './private-socket-directory';

export { coreStartEnv } from './contracts/session-identity';

const MAX_SOCKET_PATH_BYTES = 100;
// hc 0.1.16: macos-latest run 41914386091 and hc's own "too long here" message.
const HC_SOCKET_LAYOUT = { darwin: 103, linux: 107, holder: '.holder.xxxxxxxx.sock' };
const fitsSocket = (path: string, limit: number) => Buffer.byteLength(path, 'utf8') <= limit;
const holderSocket = (socket: string) =>
  `${socket.replace(/\.sock$/, '')}${HC_SOCKET_LAYOUT.holder}`;

interface InstanceOptions {
  home?: string;
  uid?: number;
  runtimeDir?: string;
  log?: (message: string) => void;
}

export function instanceNames(
  userData: string,
  platform: NodeJS.Platform | 'posix',
  tmpdir: string,
  options: InstanceOptions = {},
): InstanceNames {
  const instance = instanceDigest(userData, platform === 'win32' ? 'win32' : 'posix');
  const path = platform === 'win32' ? win32 : posix;
  const profileServerEndpoint = path.join(userData, 'conduit-server.sock');

  const linkEndpoint = linkEndpointOf(userData, platform, tmpdir, options);
  const names: InstanceNames = {
    instance,
    serverEndpoint:
      platform === 'win32'
        ? `\\\\.\\pipe\\conduit-server-${instance}`
        : !fitsSocket(profileServerEndpoint, MAX_SOCKET_PATH_BYTES)
          ? posix.join(tmpdir, `conduit-server-${instance}.sock`)
          : profileServerEndpoint,
    linkEndpoint: linkEndpoint.endpoint,
    mcpEndpoint: endpointPath(userData, platform === 'win32' ? 'win32' : 'posix', tmpdir),
    supervisorName: `conduit-server-${instance}`,
    hcSession: `conduit-${instance}`,
    runtimeRoot: path.join(userData, 'runtime'),
    hcConfigHome: path.join(userData, 'hc', 'config'),
    hcStateHome: path.join(userData, 'hc', 'state'),
  };
  if (linkEndpoint.dir !== undefined) names.linkSocketDir = linkEndpoint.dir;
  if (platform === 'win32') return names;
  try {
    const socket = selectHcSocket(names, platform, tmpdir, options);
    if (socket) names.hcSocket = socket;
  } catch (error) {
    names.hcEndpointError = error instanceof Error ? error.message : String(error);
    (options.log ?? console.warn)(`hc endpoint unavailable: ${names.hcEndpointError}`);
  }
  return names;
}

/**
 * The stdio link endpoint: the bridge from sshd's stdio connects here. Pure, so the bridge (which
 * runs before any server state exists) derives the same name the server listens on. The tmpdir
 * fallback sits in a per-uid directory, because a shared tmpdir lets another local user pre-create
 * the socket name and receive the bridge's secret.
 */
function linkEndpointOf(
  userData: string,
  platform: NodeJS.Platform | 'posix',
  tmpdir: string,
  options: InstanceOptions,
): { endpoint: string; dir?: string } {
  const instance = instanceDigest(userData, platform === 'win32' ? 'win32' : 'posix');
  if (platform === 'win32') return { endpoint: `\\\\.\\pipe\\conduit-link-${instance}` };
  const profileLinkEndpoint = join(userData, 'conduit-link.sock');
  if (fitsSocket(profileLinkEndpoint, MAX_SOCKET_PATH_BYTES))
    return { endpoint: profileLinkEndpoint };
  const uid = options.uid ?? process.getuid?.();
  if (uid === undefined || !Number.isSafeInteger(uid) || uid < 0)
    throw new Error('Cannot choose a private link socket directory without a POSIX user id');
  const dir = posix.join(tmpdir, `conduit-link-${uid}`);
  return { endpoint: posix.join(dir, `conduit-link-${instance}.sock`), dir };
}

function selectHcSocket(
  names: InstanceNames,
  platform: Exclude<NodeJS.Platform, 'win32'> | 'posix',
  tmpdir: string,
  options: InstanceOptions,
): string | undefined {
  const limit =
    platform === 'linux' || platform === 'posix' ? HC_SOCKET_LAYOUT.linux : HC_SOCKET_LAYOUT.darwin;
  const uid = options.uid ?? process.getuid?.();
  const endpoint = resolveHcEndpoint({
    session: names.hcSession,
    platform: platform === 'posix' ? 'linux' : platform,
    uid,
    runtimeDir: options.runtimeDir,
    env: {
      XDG_CONFIG_HOME: names.hcConfigHome,
      XDG_STATE_HOME: names.hcStateHome,
      XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
    },
  });
  if (fitsSocket(holderSocket(endpoint), limit)) return undefined;

  const file = `${names.instance.slice(0, 8)}.sock`;
  const durable = posix.join(options.home ?? homedir(), '.local', 'state', 'conduit-hc', file);
  if (fitsSocket(holderSocket(durable), limit)) {
    return durable;
  }
  if (uid === undefined || !Number.isSafeInteger(uid) || uid < 0)
    throw new Error('Cannot choose a private hc socket directory without a POSIX user id');
  const temporary = posix.join(tmpdir, `conduit-hc-${uid}`, file);
  if (!fitsSocket(holderSocket(temporary), limit))
    throw new Error(
      `Cannot fit hc socket and holder within ${limit} bytes: ${durable}; ${temporary}`,
    );
  (options.log ?? console.warn)(
    `hc socket: durable holder exceeds ${limit} bytes; using temporary socket ${temporary}`,
  );
  return temporary;
}

export function ensureHcSocketDirectory(
  names: Pick<InstanceNames, 'hcSocket' | 'hcEndpointError'>,
  io?: SocketDirectoryIo,
  uid = process.getuid?.(),
): void {
  if (names.hcEndpointError) throw new Error(names.hcEndpointError);
  if (!names.hcSocket) return;
  ensurePrivateSocketDirectory(posix.dirname(names.hcSocket), 'hc socket directory', io, uid);
}

/**
 * Cwd for every hc call that may start or restart a core: the core inherits the starting CLI's cwd
 * and its holders inherit the core's, and only a cwd blocks the GC rename (M21, D23). Lives here, not in C4,
 * because C4 is imported by the webview bundle, which has no node:path.
 */
export function coreStartCwd(runtimeRoot: string, hcVersion: string): string {
  // D23/F11: a filename migration must never overwrite a live legacy hc runtime.
  return join(runtimeRoot, 'conduit-hc', hcVersion);
}
