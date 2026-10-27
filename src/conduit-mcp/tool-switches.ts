// Node-free: the renderer imports the catalog for Settings and the per-session dialog.
import { type ToolError, toolError } from './types';

export const MESSAGING_TOOL_NAMES = [
  'list_sessions',
  'send_message',
  'read_inbox',
  'read_attachment',
] as const;
export const CONTROL_TOOL_NAMES = ['open_session', 'open_terminal', 'open_file'] as const;
export const TOOL_NAMES = [...MESSAGING_TOOL_NAMES, ...CONTROL_TOOL_NAMES] as const;
export type ToolName = (typeof TOOL_NAMES)[number];
export type McpToolSwitches = Record<ToolName, boolean>;
export type McpToolOverrides = Partial<Record<ToolName, boolean>>;
export type ToolOverrideValue = boolean | 'inherit';

/** Messaging on, control off (spec §5). */
export const DEFAULT_MCP_TOOLS: Readonly<McpToolSwitches> = Object.freeze({
  list_sessions: true,
  send_message: true,
  read_inbox: true,
  read_attachment: true,
  open_session: false,
  open_terminal: false,
  open_file: false,
});

const NAMES: ReadonlySet<string> = new Set(TOOL_NAMES);
const MESSAGING: ReadonlySet<ToolName> = new Set(MESSAGING_TOOL_NAMES);

export function isToolName(v: unknown): v is ToolName {
  return typeof v === 'string' && NAMES.has(v);
}

export function isMessagingTool(t: ToolName): boolean {
  return MESSAGING.has(t);
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Per key: a missing or non-boolean value takes the default; unknown keys are dropped. Never throws. */
export function coerceMcpTools(v: unknown): McpToolSwitches {
  const out: McpToolSwitches = { ...DEFAULT_MCP_TOOLS };
  if (!isRecord(v)) return out;
  for (const t of TOOL_NAMES) {
    const x = v[t];
    if (typeof x === 'boolean') out[t] = x;
  }
  return out;
}

/** Keeps only known names with boolean values; undefined when nothing survives. */
export function coerceToolOverrides(v: unknown): McpToolOverrides | undefined {
  if (!isRecord(v)) return undefined;
  const out: McpToolOverrides = {};
  for (const t of TOOL_NAMES) {
    const x = v[t];
    if (typeof x === 'boolean') out[t] = x;
  }
  return Object.keys(out).length ? out : undefined;
}

export function effectiveTool(
  overrides: McpToolOverrides | undefined,
  global: McpToolSwitches,
  tool: ToolName,
): boolean {
  return overrides?.[tool] ?? global[tool];
}

/** In TOOL_NAMES order. */
export function effectiveTools(
  overrides: McpToolOverrides | undefined,
  global: McpToolSwitches,
): ToolName[] {
  return TOOL_NAMES.filter((t) => effectiveTool(overrides, global, t));
}

/** 'inherit' deletes the key; returns undefined when the result is empty. Does not mutate. */
export function withOverride(
  overrides: McpToolOverrides | undefined,
  tool: ToolName,
  value: ToolOverrideValue,
): McpToolOverrides | undefined {
  const next: McpToolOverrides = { ...overrides };
  if (value === 'inherit') delete next[tool];
  else next[tool] = value;
  return Object.keys(next).length ? next : undefined;
}

/** Spec §2 gate steps 1–3; null ⇒ proceed to the tool's own checks. */
export function gateToolCall(i: {
  sessionId: string | null;
  messagingOn: boolean;
  enabled: boolean;
  tool: ToolName;
}): ToolError | null {
  if (i.sessionId === null)
    return toolError('not_in_session', 'this MCP connection is not a Conduit session');
  if (!i.messagingOn) return toolError('messaging_off', 'Conduit messaging is turned off');
  // Deliberately silent on how to enable it (spec 2026-10-27-conduit-mcp-control-tools §3.2).
  if (!i.enabled) return toolError('tool_disabled', `${i.tool} is not enabled for this session`);
  return null;
}
