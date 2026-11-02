import { createHash } from 'node:crypto';

/**
 * Names one userData profile. Windows paths are case-insensitive, so the same profile must hash
 * the same however it's cased; existing MCP configs hold the resulting pipe name, so the
 * truncation can't change.
 */
export function instanceDigest(userData: string, platform: 'win32' | 'posix'): string {
  return createHash('sha256')
    .update(platform === 'win32' ? userData.toLowerCase() : userData)
    .digest('hex')
    .slice(0, 16);
}
