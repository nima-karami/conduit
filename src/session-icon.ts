import type { AgentDefinition, Session } from './types';

/**
 * The kind of glyph shown on a session tab, derived from what the session
 * launches. Deterministic and metadata-based (the session's agent/launch spec) —
 * we deliberately do NOT inspect the live PTY child-process tree (fragile on
 * Windows). See docs/specs/runtime-icon.md.
 */
export type SessionIconKind = 'claude' | 'powershell' | 'terminal';

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
 * Map an agent definition to a session-tab icon kind. Total: always returns a
 * value, never throws. Resolution is case-insensitive, basename-aware (full paths
 * and `.exe`/`.cmd` suffixes are stripped), and considers the command, id, and args.
 *
 * Priority: AI agent → PowerShell → known shell → generic terminal fallback.
 */
export function iconForAgent(def: AgentDefinition | undefined): SessionIconKind {
  if (!def) return 'terminal';

  // Scan the command, id, and (non-flag) args for AI-agent keywords. We match as a
  // *token*, not a raw substring, so wrappers and compound ids resolve — `npx claude`,
  // `cmd /c claude`, an id like `claude-code` — without a flag such as
  // `--cursor-shape` mistakenly mapping to the Cursor glyph. Flags (args starting with
  // `-`) are never program names, so they're skipped. Each source is reduced to its
  // basename and split on common separators into tokens; a keyword matches a whole token.
  const argTokens = (def.args ?? []).filter((a) => typeof a === 'string' && !a.startsWith('-'));
  const tokens = [def.command, def.id, ...argTokens]
    .filter((t): t is string => typeof t === 'string' && t.length > 0)
    .flatMap((t) => basenameLower(t).split(/[\s\-_:=.]+/))
    .filter(Boolean);

  if (tokens.some((t) => AI_AGENTS.includes(t))) return 'claude';

  const cmd = basenameLower(def.command ?? '');
  if (POWERSHELL.has(cmd)) return 'powershell';
  if (SHELLS.has(cmd)) return 'terminal';

  return 'terminal';
}

/**
 * Resolve the icon kind for a session given the available agents. Falls back to the
 * generic terminal glyph when the session's agent id is not present in `agents`.
 */
export function iconForSession(
  session: Pick<Session, 'agentId'>,
  agents: AgentDefinition[],
): SessionIconKind {
  return iconForAgent(agents.find((a) => a.id === session.agentId));
}
