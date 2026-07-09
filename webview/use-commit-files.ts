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
 * entry settles in one message.
 */

export type CommitFilesStatus = 'loading' | 'ready';
export interface CommitFiles {
  status: CommitFilesStatus;
  files: FileDiffDTO[];
  truncated?: DiffTruncation;
}

const LOADING: CommitFiles = { status: 'loading', files: [] };

const cache = new Map<string, CommitFiles>();
const listeners = new Map<string, Set<() => void>>();
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
    cache.set(key, { status: 'ready', files: msg.files, truncated: msg.truncated });
    emit(key);
  });
}

function request(sessionId: string, sha: string, root?: string) {
  const key = keyFor(sessionId, sha, root);
  if (cache.has(key)) return;
  ensureWired();
  cache.set(key, LOADING);
  post({ type: 'git:commitDiff', sessionId, sha, ...(root ? { root } : {}) });
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
      request(sessionId, sha, root);
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
