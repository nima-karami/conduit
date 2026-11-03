import { diffTabKey } from './diff-tab-scope';
import type { OpenDoc } from './docs';

/**
 * Review cards stream their diffs into app.tsx's `diffs` map as they mount. This many entries
 * beyond the open diff tabs stay so scrolling back doesn't refetch; the rest is whole-file text
 * (up to 2 MB a side) or image data URLs that nothing else would ever free.
 */
const REVIEW_DIFF_CACHE_MAX = 64;

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

const NO_PINS: ReadonlySet<string> = new Set();

/** Keeps every open diff tab's entry (its effect refetches a missing one, forever), every key in
 *  `pinned` (see {@link pinDiffs}), plus the newest {@link REVIEW_DIFF_CACHE_MAX} others,
 *  oldest-inserted first out. Returns `diffs` itself when nothing goes. */
export function pruneDiffs<T>(
  diffs: Map<string, T>,
  docs: readonly OpenDoc[],
  pinned: ReadonlySet<string> = NO_PINS,
  max = REVIEW_DIFF_CACHE_MAX,
): Map<string, T> {
  const tabs = new Set<string>();
  for (const d of docs) if (d.kind === 'diff') tabs.add(diffTabKey(d));
  const loose = [...diffs.keys()].filter((k) => !tabs.has(k) && !pinned.has(k));
  const drop = loose.slice(0, Math.max(0, loose.length - max));
  if (drop.length === 0) return diffs;
  const next = new Map(diffs);
  for (const k of drop) next.delete(k);
  return next;
}

/**
 * Cache keys each mounted Review holds, by view. The whole changeset stays while its Review is
 * open: "Search all files" requests every key missing from the cache until none is, so any cap
 * below the changeset size evicts and re-requests forever. The cap applies only to diffs no open
 * view needs.
 */
const pinsByView = new Map<string, readonly string[]>();
let pinSnapshot: ReadonlySet<string> = NO_PINS;
const pinListeners = new Set<() => void>();

function publishPins(): void {
  pinSnapshot = new Set([...pinsByView.values()].flat());
  for (const cb of pinListeners) cb();
}

const sameKeys = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((k, i) => k === b[i]);

/** Replaces `view`'s pinned keys (empty releases them). Publishes only on a real change: callers
 *  re-derive `keys` per render, and every publish re-renders the subscribing app. */
export function pinDiffs(view: string, keys: readonly string[]): void {
  const prev = pinsByView.get(view);
  if (keys.length === 0) {
    if (!prev) return;
    pinsByView.delete(view);
  } else {
    if (prev && sameKeys(prev, keys)) return;
    pinsByView.set(view, keys);
  }
  publishPins();
}

export function getPinnedDiffs(): ReadonlySet<string> {
  return pinSnapshot;
}

export function subscribePinnedDiffs(cb: () => void): () => void {
  pinListeners.add(cb);
  return () => {
    pinListeners.delete(cb);
  };
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
