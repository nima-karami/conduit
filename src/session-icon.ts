import type { AgentDefinition, Session, SessionIconKind } from './types';

/**
 * The five states of the status system (handoff §"Status system"). One mutually
 * exclusive value per session, derived from its lifecycle plus the host's runtime flags:
 *
 *   'stale'     — not running (exited / stale) → dimmed card, dashed dot
 *   'busy'      — producing output right now → accent dot + the indeterminate meter
 *   'attention' — a task finished while unfocused → amber, floats to the top, Go to / Snooze
 *   'review'    — an agent ran here AND left the active repo dirty → diffstat + Review changes
 *   'idle'      — running and quiet → hollow dot, no meter, no colour
 *
 * Precedence: not running > busy > attention > review > idle. Busy beats attention
 * (working outranks finished); attention beats review (a waiting prompt outranks a
 * finished one).
 *
 * This is the ONLY derivation: the rail, the card badge and the topbar's aggregate chip
 * (src/attention.ts) all read it, so a change here moves all three together.
 *
 * Pure: no side effects; depends only on its argument. Unit-tested.
 */
export type SessionIconVisualState = 'stale' | 'busy' | 'attention' | 'review' | 'idle';

/** The fields the status system reads. Everything after `status` is host-derived + optional. */
export type SessionStateFields = Pick<
  Session,
  'status' | 'busy' | 'needsAttention' | 'completedRun' | 'git'
>;

/**
 * Derive the visual state for a session from its lifecycle and activity flags. Total:
 * always returns a value, never throws.
 *
 * D15: 'review' means *an agent ran and left changes* — at least one completed busy→idle
 * transition AND a dirty active repo. Deriving it from dirtiness alone would park nearly
 * every session in Review permanently, which makes the state meaningless.
 */
export function sessionIconState(session: SessionStateFields): SessionIconVisualState {
  if (session.status !== 'running') return 'stale';
  if (session.busy) return 'busy';
  if (session.needsAttention) return 'attention';
  if (session.completedRun && session.git?.dirty) return 'review';
  return 'idle';
}

/**
 * The word shown beside every state's glyph — the design's whole accessibility story: no
 * state is ever colour alone, so the rail survives colour-blindness with no separate a11y
 * path. One string set for all three themes; Neon uppercases it through --label-case
 * rather than saying something else (conductor decision D14).
 */
export const SESSION_STATE_WORD: Record<SessionIconVisualState, string> = {
  busy: 'Busy',
  attention: 'Needs you',
  review: 'Review',
  idle: 'Idle',
  stale: 'Stale',
};

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

/**
 * The fully-resolved icon descriptor for a session. Discriminated by `type` so render
 * sites can branch cleanly:
 *   - 'lucide'  → render the named Lucide icon component (user iconOverride, D3)
 *   - 'kind'    → render the built-in SessionGlyph (appIcon or agent-derived)
 *
 * Precedence: iconOverride (Lucide) > appIcon (kind) > agent kind
 */
export type ResolvedSessionIcon =
  | { type: 'lucide'; name: string }
  | { type: 'kind'; kind: SessionIconKind };

/**
 * Resolve the display icon for a session with full precedence (D3):
 *   1. `iconOverride` — user-set Lucide name (kebab-case, e.g. "rocket")
 *   2. `appIcon`      — sticky kind detected from the terminal title
 *   3. agent kind     — derived from the session's agent definition
 *
 * Pure: no side effects; unit-tested in test/unit/session-icon.test.ts.
 */
export function resolveSessionIcon(
  session: Pick<Session, 'agentId' | 'appIcon' | 'iconOverride'>,
  agents: AgentDefinition[],
): ResolvedSessionIcon {
  if (session.iconOverride) return { type: 'lucide', name: session.iconOverride };
  return { type: 'kind', kind: iconForSession(session, agents) };
}
