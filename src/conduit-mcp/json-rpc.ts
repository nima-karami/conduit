import { TOOL_NAMES } from './tool-switches';

/** Newest first: an unknown client version is answered with [0] (MCP version negotiation). */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = [
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
];
export type JsonRpcId = string | number;
export type ToolContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };
export interface ToolCallResult {
  content: ToolContent[];
  isError?: boolean;
  structuredContent?: unknown;
}
export interface ToolSchema {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}
export interface ToolCallContext {
  requestId: JsonRpcId | null;
}
export interface McpServerCoreDeps {
  serverInfo: { name: 'conduit'; version: string };
  instructions: string;
  /** [] for a connection without a valid token. */
  tools(): readonly ToolSchema[];
  /** null: the client cancelled this request; no reply is sent (MCP cancellation). */
  call(name: string, args: unknown, ctx: ToolCallContext): Promise<ToolCallResult | null>;
  /** notifications/cancelled with a string or number requestId; anything else is ignored. */
  cancelled(requestId: JsonRpcId): void;
}
export interface McpServerCore {
  /** undefined = no reply (a notification). */
  handleLine(line: string): Promise<string | undefined>;
}

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;

// Unknown means outside the server's catalog, not outside tools(): a tokenless connection lists
// no tools yet must still get not_in_session from call() (spec §3.1).
const KNOWN_TOOLS: ReadonlySet<string> = new Set(TOOL_NAMES);

// Sent by the host when a connection's effective tool set changes (spec 2026-10-27-conduit-mcp-control-tools §3.4).
export const TOOLS_LIST_CHANGED = JSON.stringify({
  jsonrpc: '2.0',
  method: 'notifications/tools/list_changed',
});

export function negotiateProtocolVersion(requested: unknown): string {
  return typeof requested === 'string' && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
    ? requested
    : SUPPORTED_PROTOCOL_VERSIONS[0];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function replyId(msg: Record<string, unknown>): JsonRpcId | null {
  const id = msg.id;
  return typeof id === 'string' || typeof id === 'number' ? id : null;
}

const ok = (id: JsonRpcId | null, result: unknown) =>
  JSON.stringify({ jsonrpc: '2.0', id, result });
const fail = (id: JsonRpcId | null, code: number, message: string) =>
  JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });

function unknownTool(name: unknown): ToolCallResult {
  const error = {
    code: 'invalid_argument',
    message: `unknown tool: ${String(name)}`,
    retryable: false,
  };
  return { content: [{ type: 'text', text: JSON.stringify({ error }) }], isError: true };
}

export function createMcpServerCore(deps: McpServerCoreDeps): McpServerCore {
  async function dispatch(msg: Record<string, unknown>): Promise<string | undefined> {
    const id = replyId(msg);
    const method = msg.method;
    if (typeof method !== 'string') return fail(id, INVALID_REQUEST, 'missing method');
    if (!('id' in msg)) {
      if (method === 'notifications/cancelled' && isRecord(msg.params)) {
        const target = msg.params.requestId;
        if (typeof target === 'string' || typeof target === 'number') deps.cancelled(target);
      }
      return undefined;
    }
    const params = isRecord(msg.params) ? msg.params : {};
    switch (method) {
      case 'initialize':
        return ok(id, {
          protocolVersion: negotiateProtocolVersion(params.protocolVersion),
          capabilities: { tools: { listChanged: true } },
          serverInfo: deps.serverInfo,
          instructions: deps.instructions,
        });
      case 'ping':
        return ok(id, {});
      case 'tools/list':
        return ok(id, { tools: deps.tools() });
      case 'tools/call': {
        const name = params.name;
        if (typeof name !== 'string' || !KNOWN_TOOLS.has(name)) return ok(id, unknownTool(name));
        const result = await deps.call(name, params.arguments ?? {}, { requestId: id });
        return result === null ? undefined : ok(id, result);
      }
      default:
        return fail(id, METHOD_NOT_FOUND, `method not found: ${method}`);
    }
  }

  return {
    async handleLine(line) {
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch {
        return fail(null, PARSE_ERROR, 'parse error');
      }
      if (Array.isArray(msg))
        return fail(null, INVALID_REQUEST, 'batch requests are not supported');
      if (!isRecord(msg)) return fail(null, INVALID_REQUEST, 'not a request object');
      return dispatch(msg);
    },
  };
}
