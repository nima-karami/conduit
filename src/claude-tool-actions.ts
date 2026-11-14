// see spec 2026-11-14-policy-and-permissions §4.6
export type ClaudeAction =
  | { kind: 'command'; command: string; cwd: string | null }
  | { kind: 'file-change'; paths: string[] }
  | { kind: 'mcp'; server: string; tool: string };

const asRecord = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

const FILE_PATH_FIELD: Readonly<Record<string, string>> = {
  Edit: 'file_path',
  Write: 'file_path',
  MultiEdit: 'file_path',
  NotebookEdit: 'notebook_path',
};

// The Conduit server's own calls already get an activity row; recording them again would double-count.
const CONDUIT_SERVER = 'conduit';

export function claudeActionsFromPostToolUse(payload: Record<string, unknown>): ClaudeAction[] {
  const tool = payload.tool_name;
  if (typeof tool !== 'string') return [];
  const input = asRecord(payload.tool_input);
  if (!input) return [];
  if (tool === 'Bash') {
    if (typeof input.command !== 'string') return [];
    return [
      {
        kind: 'command',
        command: input.command,
        cwd: typeof payload.cwd === 'string' ? payload.cwd : null,
      },
    ];
  }
  const field = FILE_PATH_FIELD[tool];
  if (field !== undefined) {
    const path = input[field];
    return typeof path === 'string' ? [{ kind: 'file-change', paths: [path] }] : [];
  }
  if (tool.startsWith('mcp__')) {
    const rest = tool.slice('mcp__'.length);
    const split = rest.indexOf('__');
    if (split <= 0 || split + 2 >= rest.length) return [];
    const server = rest.slice(0, split);
    if (server === CONDUIT_SERVER) return [];
    return [{ kind: 'mcp', server, tool: rest.slice(split + 2) }];
  }
  return [];
}
