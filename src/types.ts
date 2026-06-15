export type CwdStrategy = 'workspaceFolder' | 'gitWorktree' | 'prompt';

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
  // True while the session label still tracks the terminal title (OSC 0/2). A manual
  // rename sets it false so an app's title can no longer overwrite the user's choice.
  // Absent (legacy persisted sessions) is treated as true — still auto-tracking.
  autoTitle?: boolean;
  // Sticky icon kind detected from the terminal title (e.g. running `claude` inside a
  // plain shell sets a Claude title → Claude glyph). Once set it persists across a
  // later /rename. Absent → fall back to the agent-metadata icon (iconForAgent).
  appIcon?: SessionIconKind;
  // Feature-board linkage (N2): the id of the board card this session was started for,
  // if any. Persisted in sessions.json so the card↔session link survives a restart.
  // Machine-local on purpose — it lives on the session, never in the committed board.
  cardId?: string;
}

export interface SpawnSpec {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
}
