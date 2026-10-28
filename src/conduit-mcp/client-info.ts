import type { McpAdapterId } from './adapters';
import type { AgentCli } from './install-types';

export type ClientKind = 'claude' | 'codex' | 'cursor' | 'opencode' | 'fake' | 'agent';

/** Measured in S0: docs/runs/2026-10-27-mcp-install/s0.md. Exact match, like every other name. */
export const CURSOR_CLIENT_NAMES: readonly string[] = ['Cursor'];

const KNOWN: Readonly<Record<string, ClientKind>> = {
  'claude-code': 'claude',
  'codex-mcp-client': 'codex',
  opencode: 'opencode',
};

// Anything unrecognised collapses to one 'agent' prefix: clientInfo is self-asserted, so it must not
// mint unbounded handle prefixes or look-alike handles (spec §3.3).
export function clientKindOf(name: unknown, opts: { e2e: boolean }): ClientKind {
  if (typeof name !== 'string') return 'agent';
  if (Object.hasOwn(KNOWN, name)) return KNOWN[name] ?? 'agent';
  if (CURSOR_CLIENT_NAMES.includes(name)) return 'cursor';
  if (opts.e2e && name === 'conduit-e2e-fake') return 'fake';
  return 'agent';
}

export function noticeAdapterIdOf(kind: ClientKind): McpAdapterId | null {
  switch (kind) {
    case 'claude':
    case 'codex':
    case 'cursor':
    case 'fake':
      return kind;
    case 'opencode':
    case 'agent':
      return null;
  }
}

/** The agent CLI whose typed command line a client of this kind answers; fake/agent answer none. */
function cliOfClientKind(kind: ClientKind): AgentCli | null {
  switch (kind) {
    case 'claude':
    case 'codex':
    case 'cursor':
    case 'opencode':
      return kind;
    case 'fake':
    case 'agent':
      return null;
  }
}

/**
 * Whether a client initializing now binds the notices of a session without a definition adapter
 * whose last typed command line ran `lineCli` (spec 2026-10-27-conduit-mcp-install §2.4, conductor
 * amendment A1). Any other client (an IDE started from the shell by `code .`) would let a shell
 * prompt pass for the CLI's input row.
 */
export function bindsTypedLine(kind: ClientKind, lineCli: AgentCli | null | undefined): boolean {
  return lineCli !== undefined && lineCli !== null && cliOfClientKind(kind) === lineCli;
}

export function pickNoticeAdapterId(
  def: McpAdapterId | undefined,
  boundKinds: readonly ClientKind[],
): McpAdapterId | null {
  if (def !== undefined) return def;
  // The host passes the bound connection's kind (spec §2.4 A1), so at most one; an unmapped one is
  // skipped and leaves the session pull-only.
  for (let i = boundKinds.length - 1; i >= 0; i--) {
    const kind = boundKinds[i];
    const id = kind === undefined ? null : noticeAdapterIdOf(kind);
    if (id !== null) return id;
  }
  return null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** undefined: not a JSON-RPC initialize request. string: params.clientInfo.name. null: initialize without a string name. */
export function initializeClientName(line: string): string | null | undefined {
  let msg: unknown;
  try {
    msg = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isRecord(msg) || msg.method !== 'initialize' || msg.id === undefined) return undefined;
  const info = isRecord(msg.params) ? msg.params.clientInfo : undefined;
  return isRecord(info) && typeof info.name === 'string' ? info.name : null;
}
