import { useCallback, useSyncExternalStore } from 'react';
import type { DiffTruncation, FileDiffDTO, HostToWebview } from '../src/protocol';
import { post, subscribe } from './bridge';

/**
 * Shared loader for a commit's per-file diffs, keyed by `${sessionId}\0${sha}\0${root ?? ''}`.
 * The commit tab (file list) and the commit-diff tab (one file) both read the same cached entry,
 * so a sha is fetched at most once and several open history tabs never double-request. `root`
 * scopes a terminal-originated review to its cwd repo (see feat-link-cwd); it is part of the key
 * so the same (session, sha) reviewed against a different repo cannot cross-fill. The host replies
 * with a single sha-tagged `git:commitDiffResult` (no streamed-file attribution guessing), so an
 * entry settles in one message. Mirrors {@link useRangeFiles}'s error channel: a read failure
 * arrives as `{ error }` (distinct from a commit with no file changes) and `requestId`
 * (monotonic, latest-wins) lets Retry re-issue without a stale reply clobbering it — see
 * docs/specs/2026-08-20-commit-review-memory-bounds.md §4.
 */

export type CommitFilesStatus = 'loading' | 'ready' | 'error';
export interface CommitFiles {
  status: CommitFilesStatus;
  files: FileDiffDTO[];
  truncated?: DiffTruncation;
  error?: string;
}

const LOADING: CommitFiles = { status: 'loading', files: [] };

const cache = new Map<string, CommitFiles>();
const listeners = new Map<string, Set<() => void>>();
const latestReq = new Map<string, number>();
let reqCounter = 0;
let wired = false;

const keyFor = (sessionId: string, sha: string, root?: string) =>
  `${sessionId}\0${sha}\0${root ?? ''}`;

function emit(key: string) {
  for (const l of listeners.get(key) ?? []) l();
}

// One global subscription routes every commit-diff reply into the cache by its own
// (sessionId, sha, root) tag — so concurrent requests for different commits/repos can't cross-fill.
function ensureWired() {
  if (wired) return;
  wired = true;
  subscribe((msg: HostToWebview) => {
    if (msg.type !== 'git:commitDiffResult') return;
    const key = keyFor(msg.sessionId, msg.sha, msg.root);
    // Latest-wins: drop a reply older than the newest request issued for this key.
    if ((latestReq.get(key) ?? 0) > msg.requestId) return;
    cache.set(
      key,
      msg.error
        ? { status: 'error', files: [], error: msg.error }
        : { status: 'ready', files: msg.files, truncated: msg.truncated },
    );
    emit(key);
  });
}

function send(sessionId: string, sha: string, root: string | undefined, key: string) {
  ensureWired();
  reqCounter += 1;
  latestReq.set(key, reqCounter);
  cache.set(key, LOADING);
  post({
    type: 'git:commitDiff',
    sessionId,
    sha,
    requestId: reqCounter,
    ...(root ? { root } : {}),
  });
}

/** Re-issue a commit diff (clears any error/ready entry); used by the Review error state's Retry. */
export function retryCommitDiff(sessionId: string, sha: string, root?: string) {
  const key = keyFor(sessionId, sha, root);
  send(sessionId, sha, root, key);
  emit(key);
}

export function useCommitFiles(
  sessionId: string | undefined,
  sha: string,
  root?: string,
): CommitFiles {
  const key = sessionId && sha ? keyFor(sessionId, sha, root) : '';
  const subscribeFn = useCallback(
    (cb: () => void) => {
      if (!sessionId || !sha) return () => {};
      if (!cache.has(key)) send(sessionId, sha, root, key);
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
    [key, sessionId, sha, root],
  );
  const getSnapshot = () => (key ? (cache.get(key) ?? LOADING) : LOADING);
  return useSyncExternalStore(subscribeFn, getSnapshot, getSnapshot);
}
