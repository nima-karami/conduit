import { useCallback, useSyncExternalStore } from 'react';
import { type RefEndpoint, rangeKey } from '../src/git-range';
import type { FileDiffDTO, HostToWebview } from '../src/protocol';
import { post, subscribe } from './bridge';

/**
 * Shared loader for a two-ref comparison's per-file diffs (spec 2026-06-29-review-changes-polish
 * item 4), keyed by `${sessionId}\0${rangeKey(base,head)}`. Mirrors {@link useCommitFiles} (one
 * settling message, cache by key, global subscription) and adds an error channel: a comparison
 * can fail on a bad/deleted ref, which the host reports as `{ error }` (distinct from a valid
 * empty comparison). `requestId` (monotonic, latest-wins) lets a Retry re-issue without a stale
 * earlier reply clobbering it.
 */

export type RangeFilesStatus = 'loading' | 'ready' | 'error';
export interface RangeFiles {
  status: RangeFilesStatus;
  files: FileDiffDTO[];
  error?: string;
}

const LOADING: RangeFiles = { status: 'loading', files: [] };

const cache = new Map<string, RangeFiles>();
const listeners = new Map<string, Set<() => void>>();
const latestReq = new Map<string, number>();
let reqCounter = 0;
let wired = false;

const keyFor = (sessionId: string, rk: string) => `${sessionId}\0${rk}`;

function emit(key: string) {
  for (const l of listeners.get(key) ?? []) l();
}

function ensureWired() {
  if (wired) return;
  wired = true;
  subscribe((msg: HostToWebview) => {
    if (msg.type !== 'git:rangeDiffResult') return;
    const key = keyFor(msg.sessionId, msg.key);
    // Latest-wins: drop a reply older than the newest request issued for this key.
    if ((latestReq.get(key) ?? 0) > msg.requestId) return;
    cache.set(
      key,
      msg.error
        ? { status: 'error', files: [], error: msg.error }
        : { status: 'ready', files: msg.files },
    );
    emit(key);
  });
}

function send(sessionId: string, base: RefEndpoint, head: RefEndpoint, key: string) {
  ensureWired();
  reqCounter += 1;
  latestReq.set(key, reqCounter);
  cache.set(key, LOADING);
  post({ type: 'git:rangeDiff', sessionId, base, head, requestId: reqCounter });
}

/** Re-issue a comparison (clears any error/ready entry); used by the Review error state's Retry. */
export function retryRangeDiff(sessionId: string, base: RefEndpoint, head: RefEndpoint) {
  const key = keyFor(sessionId, rangeKey(base, head));
  send(sessionId, base, head, key);
  emit(key);
}

export function useRangeFiles(
  sessionId: string | undefined,
  base: RefEndpoint | undefined,
  head: RefEndpoint | undefined,
): RangeFiles {
  const active = sessionId && base && head;
  const key = active ? keyFor(sessionId, rangeKey(base, head)) : '';
  const subscribeFn = useCallback(
    (cb: () => void) => {
      if (!active) return () => {};
      if (!cache.has(key)) send(sessionId, base, head, key);
      let set = listeners.get(key);
      if (!set) {
        set = new Set();
        listeners.set(key, set);
      }
      set.add(cb);
      return () => {
        set.delete(cb);
      };
    },
    [active, key, sessionId, base, head],
  );
  const getSnapshot = () => (key ? (cache.get(key) ?? LOADING) : LOADING);
  return useSyncExternalStore(subscribeFn, getSnapshot, getSnapshot);
}
