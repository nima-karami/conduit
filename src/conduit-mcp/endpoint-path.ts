import { instanceDigest } from '../instance-digest';

/** sun_path is 104–108 bytes depending on the OS; stay under the smallest with margin. */
const MAX_SOCKET_PATH_BYTES = 100;

/**
 * One endpoint per userData, so a dev build and the installed app never cross-talk (spec §3.1).
 * Windows paths are case-insensitive, so the same profile must hash the same however it's cased.
 */
export function endpointPath(
  userData: string,
  platform: 'win32' | 'posix',
  tmpdir: string,
): string {
  const h = instanceDigest(userData, platform);
  if (platform === 'win32') return `\\\\.\\pipe\\conduit-mcp-${h}`;
  const inProfile = `${userData}/conduit-mcp/mcp.sock`;
  return Buffer.byteLength(inProfile) > MAX_SOCKET_PATH_BYTES
    ? `${tmpdir}/conduit-mcp-${h}.sock`
    : inProfile;
}
