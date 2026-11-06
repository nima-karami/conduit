import type { AttentionEntry } from './attention';
import type { Session } from './types';

/** The center footer's facts (docs/specs/archive/2026-11-02-sidebar-agent-tree.md §7). Pure. */
export interface StatusBarModel {
  branch: string | null;
  worktree: string | null;
  liveCount: number;
  attentionCount: number;
  firstAttention: AttentionEntry | null;
  showCommandHint: boolean;
}

/** `entries` is the needYouEntries projection only, never the legacy attentionEntries. */
export function buildStatusBarModel(input: {
  sessions: readonly Session[];
  activeId: string | undefined;
  entries: readonly AttentionEntry[];
}): StatusBarModel {
  const { sessions, entries } = input;
  const active = sessions.find((s) => s.id === input.activeId);
  const root = active?.activeRepoRoot;
  const git = root === undefined ? undefined : active?.repoGit?.[root];
  const linked = git?.isWorktree && git.worktreeName ? git.worktreeName : null;
  return {
    branch: git?.kind === 'branch' && git.branch ? git.branch : null,
    worktree: active ? (active.worktree ?? linked) : null,
    liveCount: sessions.filter((s) => s.status === 'running').length,
    attentionCount: entries.length,
    firstAttention: entries[0] ?? null,
    showCommandHint: active !== undefined,
  };
}
