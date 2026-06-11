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
}

export interface SpawnSpec {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
}
