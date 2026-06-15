import type { AgentDefinition, Session, SessionIconKind } from './types';

// Re-export so existing importers (webview/sidebar, icons) keep their import path.
export type { SessionIconKind } from './types';

/** Strip directory and a trailing executable extension, lowercased. */
function basenameLower(s: string): string {
  const base = s.split(/[\\/]/).filter(Boolean).pop() ?? s;
  return base.replace(/\.(exe|cmd|bat|com)$/i, '').toLowerCase();
}

// Known AI / coding-agent command keywords → the Claude (AI/sparkle) glyph. These
// match anywhere in the agent's command, id, or args so wrappers like `npx claude`
// or `cmd /c claude` still resolve. Matched as whole tokens, case-insensitively.
const AI_AGENTS = ['claude', 'aider', 'cursor', 'copilot', 'gemini', 'codex', 'goose'];
const POWERSHELL = new Set(['powershell', 'pwsh']);
const SHELLS = new Set([
  'bash',
  'zsh',
  'sh',
  'fish',
  'cmd',
  'wsl',
  'nu',
  'csh',
  'tcsh',
  'dash',
  'ksh',
]);

/**
 * Detect an icon kind from free-form text (an agent command line, or a terminal
 * title). Tokenises on common separators and matches whole tokens, so `npx claude`,
 * `claude-code`, or a title like "claude — fixing x" resolve to the Claude glyph
 * without a flag like `--cursor-shape` mis-mapping. Returns null when nothing matches
 * (so callers can fall back). Pure.
 */
export function iconKindFromText(...parts: string[]): SessionIconKind | null {
  const tokens = parts
    .filter((t): t is string => typeof t === 'string' && t.length > 0)
    .flatMap((t) => basenameLower(t).split(/[\s\-_:=.]+/))
    .filter(Boolean);
  if (tokens.some((t) => AI_AGENTS.includes(t))) return 'claude';
  if (tokens.some((t) => POWERSHELL.has(t))) return 'powershell';
  return null;
}

/**
 * Map an agent definition to a session-tab icon kind. Total: always returns a
 * value, never throws. Resolution is case-insensitive, basename-aware (full paths
 * and `.exe`/`.cmd` suffixes are stripped), and considers the command, id, and args.
 *
 * Priority: AI agent → PowerShell → known shell → generic terminal fallback.
 */
export function iconForAgent(def: AgentDefinition | undefined): SessionIconKind {
  if (!def) return 'terminal';

  // Flags (args starting with `-`) are never program names, so skip them.
  const argTokens = (def.args ?? []).filter((a) => typeof a === 'string' && !a.startsWith('-'));
  const fromText = iconKindFromText(def.command ?? '', def.id ?? '', ...argTokens);
  if (fromText) return fromText;

  const cmd = basenameLower(def.command ?? '');
  if (SHELLS.has(cmd)) return 'terminal';

  return 'terminal';
}

/**
 * Resolve the icon kind for a session given the available agents. A sticky `appIcon`
 * (detected from the terminal title — e.g. running `claude` inside a plain shell)
 * wins; otherwise fall back to the agent-metadata icon (generic terminal when the
 * session's agent id is not present in `agents`).
 */
export function iconForSession(
  session: Pick<Session, 'agentId' | 'appIcon'>,
  agents: AgentDefinition[],
): SessionIconKind {
  if (session.appIcon) return session.appIcon;
  return iconForAgent(agents.find((a) => a.id === session.agentId));
}
