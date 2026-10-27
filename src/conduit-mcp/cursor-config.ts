export interface CursorEntry {
  command: string;
  args: string[];
  env: {
    ELECTRON_RUN_AS_NODE: string;
    CONDUIT_SESSION_TOKEN: string;
    CONDUIT_MCP_ENDPOINT: string;
  };
}

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

export function wiresLaunch(entry: unknown): boolean {
  if (!isRecord(entry) || !isRecord(entry.env)) return false;
  return (
    entry.env.CONDUIT_SESSION_TOKEN === TOKEN_PLACEHOLDER &&
    entry.env.CONDUIT_MCP_ENDPOINT === ENDPOINT_PLACEHOLDER
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
