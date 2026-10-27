import type { McpAdapterId } from './adapters';

export type ClientKind = 'claude' | 'codex' | 'cursor' | 'opencode' | 'fake' | 'agent';

/** Empty until S0 measures Cursor's clientInfo.name; unmapped Cursor reads as 'agent' (spec D9). */
export const CURSOR_CLIENT_NAMES: readonly string[] = [];

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

export function pickNoticeAdapterId(
  def: McpAdapterId | undefined,
  liveKinds: readonly ClientKind[],
): McpAdapterId | null {
  if (def !== undefined) return def;
  // Unmapped kinds are skipped, not decisive: an IDE agent or a nested `opencode run` started from
  // the shell must not silence the notices of the Claude already connected there.
  for (let i = liveKinds.length - 1; i >= 0; i--) {
    const kind = liveKinds[i];
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
