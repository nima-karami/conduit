import type { RepoInfo } from './repo-scan';

export type CwdStrategy = 'workspaceFolder' | 'gitWorktree' | 'prompt';

/** An in-progress git operation detected by a gitdir marker file (cheap fs.access). */
export type GitOperation = 'rebase' | 'merge' | 'cherry-pick' | 'revert' | 'bisect';

/**
 * Git context for a terminal session's active cwd, derived host-side (src/git-info.ts)
 * and pushed to the renderer on the existing `state` broadcast. Runtime-only: NEVER
 * persisted to sessions.json (mirrors how `cwd` is runtime-derived). The host
 * constructor enforces the type-level invariants the renderer relies on:
 *   kind==='branch'   ⇒ branch defined
 *   kind==='detached' ⇒ sha defined
 *   isWorktree===true ⇒ worktreeName defined
 *   kind==='bare'     ⇒ branch/sha/dirty/operation all undefined
 */
export interface GitInfo {
  kind: 'branch' | 'detached' | 'bare' | 'none';
  branch?: string; // present when kind === 'branch' (incl. unborn)
  unborn?: boolean; // kind === 'branch' but HEAD has no commit yet (fresh init)
  sha?: string; // short SHA (7), present when kind === 'detached'
  isWorktree?: boolean; // true when cwd is a *linked* worktree (not the main tree)
  worktreeName?: string; // display label for the worktree dir, when isWorktree
  dirty?: boolean; // working tree has any change (porcelain non-empty)
  operation?: GitOperation; // in-progress op, if any
}

export interface AgentDefinition {
  id: string;
  label: string;
  command: string;
  args: string[];
  icon: string; // VS Code ThemeIcon id
  color: string; // VS Code ThemeColor id
  cwdStrategy: CwdStrategy;
}

export type SessionStatus = 'running' | 'exited' | 'stale';

/**
 * The glyph shown on a session, derived from what the session runs. Metadata-based
 * (agent spec or the terminal-reported title) — never live process-tree inspection
 * (fragile on Windows; see docs/specs/archive/2026-06-11-runtime-icon.md).
 */
export type SessionIconKind = 'claude' | 'powershell' | 'terminal';

export interface Session {
  id: string;
  name: string;
  agentId: string;
  projectPath: string; // absolute folder used as group key + cwd
  worktree?: string; // optional worktree label
  status: SessionStatus;
  createdAt: number; // epoch ms, set on creation
  lastActiveAt: number; // epoch ms, set on creation, bumped on activity (term start/input)
  busy?: boolean; // produced output within the busy window (runtime-only, host-derived)
  needsAttention?: boolean; // finished a task while unfocused (runtime-only, host-derived)
  // Sticky icon kind detected from the terminal title (e.g. running `claude` inside a
  // plain shell sets a Claude title → Claude glyph). Once set it persists across a
  // later /rename. Absent → fall back to the agent-metadata icon (iconForAgent).
  appIcon?: SessionIconKind;
  // Feature-board linkage (N2): the id of the board card this session was started for,
  // if any. Persisted in sessions.json so the card↔session link survives a restart.
  // Machine-local on purpose — it lives on the session, never in the committed board.
  cardId?: string;
  // User-set icon override: a Lucide icon name in kebab-case (e.g. "rocket"). When
  // present it takes top priority over appIcon and the agent-derived icon (D3).
  // Persisted in sessions.json via the existing spread in persistence.ts (restoreSessions
  // spreads ...s so all fields round-trip). Cleared by setting to undefined.
  iconOverride?: string;
  /** live working dir (cd-tracked); falls back to projectPath */
  cwd?: string;
  /**
   * Git context for activeCwd (branch/worktree/dirty/op). Runtime-derived by the host
   * (src/git-info.ts), rides the `state` broadcast like `cwd`. NEVER persisted to
   * sessions.json — serializeSessions strips it.
   */
  git?: GitInfo;
  /**
   * Detected sub-repos under projectPath (multi-repo awareness; see
   * docs/specs/archive/2026-06-25-multi-repo-awareness.md). Runtime-only, host-derived
   * (src/repo-scan.ts); rides the `state` broadcast like `git`. NEVER persisted.
   */
  repos?: RepoInfo[];
  /** Effective active repo root (src/active-repo.ts). Runtime-only. */
  activeRepoRoot?: string;
  /** True when activeRepoRoot is held by a manual pick. Runtime-only. */
  repoPinned?: boolean;
  /** Manual pin target; cleared by unpin. Internal/runtime-only (renderer reads repoPinned). */
  pinnedRepoRoot?: string;
  /** Last auto-follow target (cd / file focus / explorer click). Internal/runtime-only. */
  autoRepoRoot?: string;
}

export interface SpawnSpec {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
}
