import { diffTabKey } from './diff-tab-scope';
import type { OpenDoc } from './docs';

/**
 * Review cards stream their diffs into app.tsx's `diffs` map as they mount. This many entries
 * beyond the open diff tabs stay so scrolling back doesn't refetch; the rest is whole-file text
 * (up to 2 MB a side) or image data URLs that nothing else would ever free.
 */
export const REVIEW_DIFF_CACHE_MAX = 64;

/** `files` holds a file's text, or an image/PDF as a base64 data URL (up to ~67 MB): only a path
 *  an open file tab shows is worth keeping. Returns `files` itself when nothing goes. */
export function pruneFiles<T>(files: Map<string, T>, docs: readonly OpenDoc[]): Map<string, T> {
  const open = new Set<string>();
  for (const d of docs) if (d.kind === 'file') open.add(d.path);
  let next: Map<string, T> | null = null;
  for (const path of files.keys()) {
    if (open.has(path)) continue;
    next ??= new Map(files);
    next.delete(path);
  }
  return next ?? files;
}

/** Keeps every open diff tab's entry (its effect refetches a missing one, forever) plus the
 *  newest {@link REVIEW_DIFF_CACHE_MAX} others, oldest-inserted first out. Returns `diffs` itself
 *  when nothing goes. */
export function pruneDiffs<T>(
  diffs: Map<string, T>,
  docs: readonly OpenDoc[],
  max = REVIEW_DIFF_CACHE_MAX,
): Map<string, T> {
  const pinned = new Set<string>();
  for (const d of docs) if (d.kind === 'diff') pinned.add(diffTabKey(d));
  const loose = [...diffs.keys()].filter((k) => !pinned.has(k));
  const drop = loose.slice(0, Math.max(0, loose.length - max));
  if (drop.length === 0) return diffs;
  const next = new Map(diffs);
  for (const k of drop) next.delete(k);
  return next;
}

/** Insert-or-refresh: a re-set key moves to the newest end, which `Map#set` alone won't do. */
export function setNewest<T>(map: Map<string, T>, key: string, value: T): Map<string, T> {
  const next = new Map(map);
  next.delete(key);
  return next.set(key, value);
}

/**
 * Module-level LRU for caches read through `useSyncExternalStore`: drops the oldest entries over
 * `max`, but never one in `pinned` — a subscribed key that vanished would read as "loading" with
 * nothing left to refetch it.
 */
export function evictOldest<V>(
  cache: Map<string, V>,
  max: number,
  pinned: (key: string) => boolean,
) {
  for (const key of cache.keys()) {
    if (cache.size <= max) return;
    if (!pinned(key)) cache.delete(key);
  }
}

/** Binary payloads are re-sent whole (base64, up to ~67 MB) and carry no mtime, so only
 *  `fileChanged` refreshes them; text is cheap and stays refreshed on focus/visible. */
export function rereadsOnFocus(cached: { image?: unknown; pdf?: unknown } | undefined): boolean {
  return !cached?.image && !cached?.pdf;
}

/**
 * Review's request-once guard must forget a diff the cache evicted, or the card that shows it
 * again never asks. Mutates `requested`/`settled`; `settled` = keys seen present.
 */
export function forgetEvictedRequests(
  requested: Set<string>,
  settled: Set<string>,
  present: ReadonlyMap<string, unknown>,
): void {
  for (const key of settled) {
    if (present.has(key)) continue;
    settled.delete(key);
    requested.delete(key);
  }
  for (const key of present.keys()) settled.add(key);
}
