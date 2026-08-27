import type { HeadBlobReason } from '../src/protocol';

export interface HeadBlob {
  headSha: string | null;
  text: string | null;
  reason?: HeadBlobReason;
}

/** Bounded so a long session over many files can't hold every blob it ever read. */
export const HEAD_BLOB_CACHE_MAX = 40;

/** NUL: the one byte a filesystem path can never contain, so the composite key is unambiguous. */
const SEP = '\u0000';
const keyed = new Map<string, HeadBlob>();
/** Which sha a path was last seen at — the reason a re-mount needs no round trip. */
const latest = new Map<string, string | null>();

const cacheKey = (path: string, headSha: string | null): string => `${path}${SEP}${headSha ?? ''}`;

export function putHeadBlob(path: string, blob: HeadBlob): void {
  const key = cacheKey(path, blob.headSha);
  // Re-insert so this entry becomes the newest in the Map's iteration order.
  keyed.delete(key);
  keyed.set(key, blob);
  latest.set(path, blob.headSha);
  while (keyed.size > HEAD_BLOB_CACHE_MAX) {
    const oldest = keyed.keys().next().value;
    if (oldest === undefined) break;
    keyed.delete(oldest);
  }
}

export function getHeadBlob(path: string, headSha: string | null): HeadBlob | undefined {
  return keyed.get(cacheKey(path, headSha));
}

export function getLatestHeadBlob(path: string): HeadBlob | undefined {
  if (!latest.has(path)) return undefined;
  return keyed.get(cacheKey(path, latest.get(path) ?? null));
}

/** HEAD or the working tree moved: the path's last-known sha is no longer trustworthy. */
export function invalidateHeadBlob(path: string): void {
  latest.delete(path);
}

/** Test-only: reset both maps between cases. */
export function clearHeadBlobCache(): void {
  keyed.clear();
  latest.clear();
}
