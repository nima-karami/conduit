// The Workspace Trust store: which folders the user trusts to run their own tools (language
// servers). Pure — the host persists it in userData, never in a repo.
// See docs/specs/2026-09-23-workspace-trust.md §2.
import { posix, win32 } from 'node:path';
import { canonicalPath, hasDotSegment } from './canonical-path';
import { type HostPlatform, isAbsoluteFor } from './lsp-binary';
import { isWithin } from './lsp-root';

export interface TrustStore {
  /** Trusted folders in the canonical spelling. A folder covers everything under it. */
  readonly trusted: readonly string[];
}

/** The canonical spelling of an admissible folder, or null (relative, or has `.`/`..`). */
function folderKey(path: string, platform: HostPlatform): string | null {
  if (!isAbsoluteFor(path, platform) || hasDotSegment(path)) return null;
  const spelled = platform === 'win32' ? canonicalPath(path) : path;
  const trimmed = spelled.replace(/[\\/]+$/, '');
  if (trimmed === '') return spelled;
  // A bare drive (`G:`) would read as drive-relative; keep its root separator.
  return /^[a-zA-Z]:$/.test(trimmed) ? `${trimmed}\\` : trimmed;
}

const sameFolder = (a: string, b: string, platform: HostPlatform) =>
  isWithin(a, b, platform) && isWithin(b, a, platform);

export function isTrusted(store: TrustStore, path: string, platform: HostPlatform): boolean {
  const key = folderKey(path, platform);
  return key !== null && store.trusted.some((t) => isWithin(key, t, platform));
}

export function addTrusted(store: TrustStore, path: string, platform: HostPlatform): TrustStore {
  const key = folderKey(path, platform);
  if (key === null || store.trusted.some((t) => sameFolder(t, key, platform))) return store;
  return { trusted: [...store.trusted, key] };
}

export function removeTrusted(store: TrustStore, path: string, platform: HostPlatform): TrustStore {
  const key = folderKey(path, platform);
  if (key === null) return store;
  return { trusted: store.trusted.filter((t) => !sameFolder(t, key, platform)) };
}

/** The folder "Trust Parent Folder" would record — or null when that parent is a filesystem
 *  root (drive, `/`, UNC share) or the home directory: trusting either would trust nearly
 *  everything the user has, which no one means by "the parent of this project". */
export function parentFolder(
  folder: string,
  platform: HostPlatform,
  homeDir: string,
): string | null {
  const key = folderKey(folder, platform);
  if (key === null) return null;
  const path = platform === 'win32' ? win32 : posix;
  const up = path.dirname(key);
  if (up === key) return null;
  const upKey = folderKey(up, platform);
  if (upKey === null) return null;
  const isRoot = sameFolder(upKey, path.parse(upKey).root, platform);
  const home = folderKey(homeDir, platform);
  if (isRoot || (home !== null && sameFolder(upKey, home, platform))) return null;
  return upKey;
}

export function parseTrustStore(raw: string, platform: HostPlatform): TrustStore {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { trusted: [] };
  }
  const list = (data as { trusted?: unknown } | null)?.trusted;
  if (!Array.isArray(list)) return { trusted: [] };
  let store: TrustStore = { trusted: [] };
  for (const p of list) if (typeof p === 'string') store = addTrusted(store, p, platform);
  return store;
}

export function serializeTrustStore(store: TrustStore): string {
  return `${JSON.stringify({ trusted: store.trusted }, null, 2)}\n`;
}
