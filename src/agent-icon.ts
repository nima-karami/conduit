import { effectiveDef } from './session-command';
import type { ResolvedSessionIcon } from './session-icon';
import type { AgentDefinition, Session, SessionIconKind } from './types';

/**
 * The one agent-glyph detector (docs/specs/2026-11-02-sidebar-agent-tree.md §6); session-icon's
 * iconKindFromText delegates here. Glyph identity only, never MCP CliKind.
 */

function basenameLower(s: string): string {
  const base = s.split(/[\\/]/).filter(Boolean).pop() ?? s;
  return base.replace(/\.(exe|cmd|bat|com)$/i, '').toLowerCase();
}

const AGENT_KINDS: Readonly<Record<string, SessionIconKind>> = {
  claude: 'claude',
  codex: 'codex',
  opencode: 'opencode',
  cursor: 'cursor',
  gemini: 'gemini',
  // Agents without a mark of their own share the neutral robot (CON-147), not Claude's.
  aider: 'agent',
  copilot: 'agent',
  goose: 'agent',
};
const POWERSHELL = new Set(['powershell', 'pwsh']);

/**
 * Whole-token match, case-insensitive and basename-aware, so `npx codex`, `cursor-agent` or a
 * title like "claude — fixing x" resolve; an agent outranks the shell it runs in. Null when
 * nothing matches, so callers fall back.
 */
export function agentIconKindFromText(...parts: string[]): SessionIconKind | null {
  const tokens = parts
    .filter((t): t is string => typeof t === 'string' && t.length > 0)
    .flatMap((t) => basenameLower(t).split(/[\s\-_:=.]+/))
    .filter(Boolean);
  for (const t of tokens) {
    const kind = AGENT_KINDS[t];
    if (kind) return kind;
  }
  if (tokens.some((t) => POWERSHELL.has(t))) return 'powershell';
  return null;
}

function kindOfDef(def: AgentDefinition | undefined): SessionIconKind | null {
  if (!def) return null;
  // Flags (args starting with `-`) are never program names.
  const args = def.args.filter((a) => typeof a === 'string' && !a.startsWith('-'));
  return agentIconKindFromText(def.command, def.id, ...args);
}

/**
 * Precedence (§6): user iconOverride > MCP CLI binding / handle prefix > detected title app >
 * effective command (custom command sessions included) > terminal.
 */
export function resolveAgentIcon(input: {
  session: Session;
  agents: readonly AgentDefinition[];
  boundCli?: string;
  handle?: string;
}): ResolvedSessionIcon {
  const { session, agents } = input;
  if (session.iconOverride) return { type: 'lucide', name: session.iconOverride };
  const kind =
    (input.boundCli ? agentIconKindFromText(input.boundCli) : null) ??
    (input.handle ? agentIconKindFromText(input.handle) : null) ??
    session.appIcon ??
    kindOfDef(effectiveDef(session, { get: (id) => agents.find((a) => a.id === id) })) ??
    'terminal';
  return { type: 'kind', kind };
}
