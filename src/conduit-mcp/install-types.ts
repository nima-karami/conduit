// Wire types and catalog for installing Conduit into agent CLIs (spec 2026-10-27-conduit-mcp-install).
export const AGENT_CLIS = ['claude', 'codex', 'cursor', 'opencode'] as const;
export type AgentCli = (typeof AGENT_CLIS)[number];
/** Binary leaves per CLI; the first is the command the restart hint names. */
export const CLI_BINARIES: Readonly<Record<AgentCli, readonly string[]>> = {
  claude: ['claude'],
  codex: ['codex'],
  cursor: ['agent', 'cursor-agent'],
  opencode: ['opencode'],
};

/** A user-scope file's backup sits next to it with this suffix; the Replace dialog names it. */
export const BACKUP_SUFFIX = '.conduit-backup';

export type UserInstallState =
  | 'not-found'
  | 'not-installed'
  | 'installed'
  | 'other-conduit'
  | 'conflict'
  | 'error';
/** 'checking' and 'pending' are renderer row states and never cross IPC. */
export type ProjectScope = 'project' | 'local';
export type ProjectEntryState = 'ours' | 'other-conduit' | 'conflict' | 'error';
export interface UserInstall {
  state: UserInstallState;
  path: string;
  errorCode?: string;
  shadowedBy?: ProjectScope;
}
export interface ProjectEntry {
  scope: ProjectScope;
  state: ProjectEntryState;
  path: string;
  errorCode?: string;
}
export interface ProjectInstall {
  entries: ProjectEntry[];
  installable: boolean;
  installPath: string | null;
}
export interface CliInstallStatus {
  cli: AgentCli;
  found: boolean;
  user: UserInstall;
  project: ProjectInstall | null;
}
/** clis in AGENT_CLIS order, always four. */
export interface McpInstallStatus {
  clis: CliInstallStatus[];
}

export type McpInstallAction = 'install' | 'uninstall' | 'replace' | 'remove';
export interface McpInstallRequest {
  cli: AgentCli;
  scope: 'user' | 'project';
  action: McpInstallAction;
  projectPath?: string;
  /** Required iff action === 'remove'. */
  entryScope?: ProjectScope;
}
export type McpInstallResult =
  | { ok: true; status: CliInstallStatus }
  | { ok: false; status: CliInstallStatus; errorCode: string };

export type ConfigErrorCode = 'EJSON' | 'EJSONC' | 'ETOML' | 'EUNEDITABLE' | 'EGUARD';
export class ConfigFormatError extends Error {
  constructor(
    readonly code: ConfigErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ConfigFormatError';
  }
}

// Entry shapes: spec 2026-10-27-conduit-mcp-install §3.4. Placeholders are literal strings.
export interface ClaudeEntry {
  type: 'stdio';
  command: string;
  args: string[];
  env: { ELECTRON_RUN_AS_NODE: '1'; CONDUIT_SESSION_TOKEN: string; CONDUIT_MCP_ENDPOINT: string };
}
export interface CodexEntry {
  command: string;
  args: string[];
  env: { ELECTRON_RUN_AS_NODE: '1' };
  env_vars: string[];
  default_tools_approval_mode: 'auto';
}
export interface OpenCodeEntry {
  type: 'local';
  command: string[];
  environment: {
    ELECTRON_RUN_AS_NODE: '1';
    CONDUIT_SESSION_TOKEN: string;
    CONDUIT_MCP_ENDPOINT: string;
  };
  enabled: true;
}

export type InstallDismissals = Partial<Record<AgentCli, true>>;

const isScope = (v: unknown): v is McpInstallRequest['scope'] => v === 'user' || v === 'project';
const isAction = (v: unknown): v is McpInstallAction =>
  v === 'install' || v === 'uninstall' || v === 'replace' || v === 'remove';
const isProjectScope = (v: unknown): v is ProjectScope => v === 'project' || v === 'local';

export function isAgentCli(v: unknown): v is AgentCli {
  return typeof v === 'string' && (AGENT_CLIS as readonly string[]).includes(v);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Keeps known CLIs whose value is exactly true; unknown keys and non-objects → {}. Never throws. */
export function coerceInstallDismissals(v: unknown): InstallDismissals {
  const out: InstallDismissals = {};
  if (!isRecord(v)) return out;
  for (const cli of AGENT_CLIS) if (v[cli] === true) out[cli] = true;
  return out;
}

/** null when cli/scope/action are not members, projectPath not a string when present, or remove lacks a valid entryScope. */
export function coerceInstallRequest(v: unknown): McpInstallRequest | null {
  if (!isRecord(v)) return null;
  const { cli, scope, action, projectPath, entryScope } = v;
  if (!isAgentCli(cli)) return null;
  if (!isScope(scope) || !isAction(action)) return null;
  if (projectPath !== undefined && typeof projectPath !== 'string') return null;
  const req: McpInstallRequest = { cli, scope, action };
  if (projectPath !== undefined) req.projectPath = projectPath;
  if (action === 'remove') {
    if (!isProjectScope(entryScope)) return null;
    req.entryScope = entryScope;
  }
  return req;
}

/** Some found CLI's user state is 'not-installed' (spec §2.6). */
export function needsSetup(s: McpInstallStatus): boolean {
  return s.clis.some((c) => c.found && c.user.state === 'not-installed');
}
