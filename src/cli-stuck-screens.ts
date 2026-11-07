import type { CliKind } from './conduit-mcp/tool-policy';

export type StuckKind = 'usage-limit' | 'rate-limit-prompt' | 'provider-error' | 'update-prompt';

export interface StuckScreen {
  kind: StuckKind;
  reason: string;
}

// Only the live bottom of the screen counts: a limit line scrolled up in history must not keep
// a session flagged after the user has resumed it.
const LIVE_ROWS = 25;

// Each pattern is anchored to the row its CLI prints it on. Ordinary output that merely mentions
// the same words (a source file, a log line, a fixture of this very detector) must not match.
const CODEX_USAGE_LIMIT = /^[ \t]*■ You[’']ve hit your usage limit/m;
const CODEX_RETRY_AT = /try again at ([0-9:]+\s*[AP]M)/;
const CODEX_SWITCH_PROMPT = /^[ \t]*Approaching rate limits[ \t]*$/m;
const CODEX_SWITCH_FOOTER = /enter select · esc back/;
const CODEX_UPDATE_PROMPT = /^[ \t]*Update available\b/m;
const CODEX_UPDATE_FOOTER = /enter continue · esc skip/;

const CURSOR_PROVIDER_ERROR = /^[ \t]*Error: Unable to reach the model provider[ \t]*$/m;
const CURSOR_USAGE_RESET =
  /^[ \t]*model\. Your usage limits will reset|Your usage limits will reset when your monthly cycle ends/m;

const CLAUDE_USAGE_LIMIT =
  /^[ \t]*(?:Claude usage limit reached|You[’']ve hit your (?:usage|session|weekly) limit)/m;

function liveText(rows: readonly string[]): string {
  return rows
    .filter((row) => row.trim() !== '')
    .slice(-LIVE_ROWS)
    .join('\n');
}

function detectCodex(text: string): StuckScreen | null {
  // The prompt is what blocks input, so it wins over the usage line it is shown under.
  if (CODEX_SWITCH_PROMPT.test(text) && CODEX_SWITCH_FOOTER.test(text)) {
    return { kind: 'rate-limit-prompt', reason: 'Codex asks whether to switch models' };
  }
  // Same rule as the switch prompt: a blocking prompt outranks the usage line above it.
  if (CODEX_UPDATE_PROMPT.test(text) && CODEX_UPDATE_FOOTER.test(text)) {
    return { kind: 'update-prompt', reason: 'Codex is asking whether to update' };
  }
  if (CODEX_USAGE_LIMIT.test(text)) {
    const retry = CODEX_RETRY_AT.exec(text);
    const reason = retry
      ? `Codex usage limit reached — try again at ${retry[1]}`
      : 'Codex usage limit reached';
    return { kind: 'usage-limit', reason };
  }
  return null;
}

function detectCursor(text: string): StuckScreen | null {
  if (CURSOR_PROVIDER_ERROR.test(text)) {
    return { kind: 'provider-error', reason: "Cursor can't reach the model provider" };
  }
  if (CURSOR_USAGE_RESET.test(text)) {
    return { kind: 'usage-limit', reason: 'Cursor usage limit reached' };
  }
  return null;
}

function detectClaude(text: string): StuckScreen | null {
  if (CLAUDE_USAGE_LIMIT.test(text)) {
    return { kind: 'usage-limit', reason: 'Claude usage limit reached' };
  }
  return null;
}

export function detectStuckScreen(cli: CliKind, rows: readonly string[]): StuckScreen | null {
  const text = liveText(rows);
  switch (cli) {
    case 'codex':
      return detectCodex(text);
    case 'cursor':
      return detectCursor(text);
    case 'claude':
      return detectClaude(text);
    default:
      return null;
  }
}
