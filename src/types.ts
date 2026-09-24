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

export interface Project {
  id: string;
  name: string;
  order: number;
}

export interface Session {
  id: string;
  name: string;
  agentId: string;
  home: string; // absolute folder used as group key + cwd
  roots: string[]; // attached folders only: never home's key, folderKey-unique, add order
  projectId?: string; // absent = standalone
  missingRoots?: string[]; // runtime-only, ⊆ roots in roots order, absent when empty
  homeMissing?: boolean; // runtime-only, absent when false
  worktree?: string; // optional worktree label
  status: SessionStatus;
  createdAt: number; // epoch ms, set on creation
  lastActiveAt: number; // epoch ms, set on creation, bumped on activity (term start/input)
  busy?: boolean; // produced output within the busy window (runtime-only, host-derived)
  needsAttention?: boolean; // finished a task while unfocused (runtime-only, host-derived)
  // Completed at least one busy->idle transition this run: something actually RAN here.
  // Half of the Review-state test (conductor decision D15); the other half is a dirty
  // active repo. Runtime-only, host-derived; never persisted.
  completedRun?: boolean;
  /**
   * The last non-empty line this session printed, ANSI-stripped and capped (D6). The one
   * live line under a card's name in every state. Runtime-only: derived from the PTY tail
   * on the existing coalesced state broadcast, never persisted.
   */
  lastLine?: string;
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
  // Persisted in sessions.json via the existing spread in persistence.ts (parseSessions
  // spreads ...s so all fields round-trip). Cleared by setting to undefined.
  iconOverride?: string;
  /** live working dir (cd-tracked); falls back to home */
  cwd?: string;
  /** Runtime-only (stripped by serializeSessions). Keyed by RepoInfo.root exactly as in `repos`.
   *  A failed interrogation is stored as { kind: 'none' }. Absent until the first refresh. */
  repoGit?: Record<string, GitInfo>;
  /**
   * Repos detected across home and present roots, tagged (mf-model spec; multi-repo awareness:
   * docs/specs/archive/2026-06-25-multi-repo-awareness.md). Runtime-only, host-derived
   * (src/repo-scan.ts); rides the `state` broadcast like `repoGit`. NEVER persisted.
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
  /** Runtime-only postState decoration (mf-live-edits spec §2.1); absent when nothing drifted. */
  agentScope?: AgentScopeView;
  /** Runtime-only postState decoration: bumped by `session:restart` on a live child so the
   *  terminal pane remounts (mf-live-edits spec §2.4 R2). */
  restartSeq?: number;
  /** Runtime-only postState decoration: the last `term:start` was refused, and why (mf-live-edits
   *  spec §2.6). Cleared by a successful spawn, dispose, or a launcher change. */
  startRefusal?: StartRefusal;
}

/** A missing home is `homeMissing`; this is the other reason a start is refused. */
export interface StartRefusal {
  reason: 'unresolvable';
  command: string;
}

/** `typeable` ⊆ `unseen`, in unseen order (mf-live-edits spec §2.1). */
export interface AgentScopeView {
  unseen: string[];
  stillSeen: string[];
  typeable: string[];
  /** Pasted into claude's input, not yet answered by claude; ∈ unseen (spec §2.3). */
  pasted?: string;
}

export interface SpawnSpec {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
}
