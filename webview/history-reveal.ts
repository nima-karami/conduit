import { folderKey } from '../src/folder-key';
import type { CommitNode } from '../src/protocol';

// One slot, newest wins: an MCP open_git_history hands its looked-up commit to the history view
// that owns (session, repo), which may mount after the open (spec 2026-10-30-conduit-mcp-app-control
// §2.1 open_git_history).
let pending: { sessionId: string; repoKey: string; commit: CommitNode } | null = null;
const listeners = new Set<() => void>();

export function requestHistoryReveal(
  sessionId: string,
  repoRoot: string,
  commit: CommitNode,
): void {
  pending = { sessionId, repoKey: folderKey(repoRoot), commit };
  for (const cb of [...listeners]) cb();
}

/** The pending commit when sessionId matches and folderKey(repoRoot) matches; clears the slot. */
export function takeHistoryReveal(
  sessionId: string | undefined,
  repoRoot: string | undefined,
): CommitNode | null {
  if (pending === null || sessionId === undefined || repoRoot === undefined) return null;
  if (pending.sessionId !== sessionId || pending.repoKey !== folderKey(repoRoot)) return null;
  const { commit } = pending;
  pending = null;
  return commit;
}

export function subscribeHistoryReveal(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}
