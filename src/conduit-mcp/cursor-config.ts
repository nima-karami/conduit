export interface CursorEntry {
  command: string;
  args: string[];
  env: {
    ELECTRON_RUN_AS_NODE: string;
    CONDUIT_SESSION_TOKEN: string;
    CONDUIT_MCP_ENDPOINT: string;
  };
}

export interface CursorConfig {
  root: Record<string, unknown>;
  servers: Record<string, unknown>;
}

export type CursorConnectState = 'disconnected' | 'connected' | 'stale' | 'error';
export interface CursorConnectResult {
  state: CursorConnectState;
  path: string;
  errorCode?: string;
  actionFailed?: boolean;
}

class CursorConfigShapeError extends Error {}

// Cursor's own ${env:VAR} syntax, resolved from the agent's env (spec 2026-10-26-conduit-mcp-cursor §2).
// biome-ignore lint/suspicious/noTemplateCurlyInString: a literal Cursor placeholder, not a template
const TOKEN_PLACEHOLDER = '${env:CONDUIT_SESSION_TOKEN}';
// biome-ignore lint/suspicious/noTemplateCurlyInString: a literal Cursor placeholder, not a template
const ENDPOINT_PLACEHOLDER = '${env:CONDUIT_MCP_ENDPOINT}';

export function cursorEntry(execPath: string, shimPath: string): CursorEntry {
  return {
    command: execPath,
    args: [shimPath],
    env: {
      ELECTRON_RUN_AS_NODE: '1',
      CONDUIT_SESSION_TOKEN: TOKEN_PLACEHOLDER,
      CONDUIT_MCP_ENDPOINT: ENDPOINT_PLACEHOLDER,
    },
  };
}

export function parseCursorConfig(raw: string): CursorConfig {
  const parsed: unknown = JSON.parse(raw.replace(/^\uFEFF/, ''));
  if (!isRecord(parsed)) throw new CursorConfigShapeError('Invalid Cursor MCP config shape');
  const servers = parsed.mcpServers === undefined ? {} : parsed.mcpServers;
  if (!isRecord(servers)) throw new CursorConfigShapeError('Invalid Cursor MCP config shape');
  return { root: parsed, servers };
}

export function isCursorConfigParseError(error: unknown): boolean {
  return error instanceof SyntaxError || error instanceof CursorConfigShapeError;
}

export function cursorConfigState(config: CursorConfig, expected: CursorEntry): CursorConnectState {
  const entry = config.servers.conduit;
  if (entry === undefined) return 'disconnected';
  return deepEqual(entry, expected) ? 'connected' : 'stale';
}

export function wiresLaunch(entry: unknown): boolean {
  if (!isRecord(entry) || !isRecord(entry.env)) return false;
  return (
    entry.env.CONDUIT_SESSION_TOKEN === TOKEN_PLACEHOLDER &&
    entry.env.CONDUIT_MCP_ENDPOINT === ENDPOINT_PLACEHOLDER
  );
}

export function mergeCursorEntry(config: CursorConfig, entry: CursorEntry): CursorConfig {
  const servers = { ...config.servers, conduit: entry };
  return { root: { ...config.root, mcpServers: servers }, servers };
}

export function removeCursorEntry(config: CursorConfig): CursorConfig {
  const servers = { ...config.servers };
  delete servers.conduit;
  return { root: { ...config.root, mcpServers: servers }, servers };
}

export function serializeCursorConfig(root: Record<string, unknown>): string {
  return `${JSON.stringify(root, null, 2)}\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, i) => deepEqual(item, right[i]))
    );
  }
  if (isRecord(left) || isRecord(right)) {
    if (!isRecord(left) || !isRecord(right)) return false;
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every((key) => key in right && deepEqual(left[key], right[key]))
    );
  }
  return false;
}
