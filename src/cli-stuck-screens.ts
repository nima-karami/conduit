export type StuckKind = 'usage-limit' | 'rate-limit-prompt' | 'provider-error';

export interface StuckScreen {
  kind: StuckKind;
  reason: string;
}

type Cli = 'codex' | 'cursor' | 'claude' | 'opencode' | 'agent';

// Only the live bottom of the screen counts: a limit line scrolled up in history must not keep
// a session flagged after the user has resumed it.
const LIVE_ROWS = 25;

const CODEX_USAGE_LIMIT = /You[’']ve hit your usage limit/;
const CODEX_RETRY_AT = /try again at ([0-9:]+\s*[AP]M)/;
const CODEX_SWITCH_PROMPT = /Approaching rate limits/;
const CODEX_SWITCH_FOOTER = /enter select · esc back/;

const CURSOR_PROVIDER_ERROR = /Unable to reach the model provider/;
const CURSOR_USAGE_RESET = /usage limits will reset when your monthly cycle ends/;

const CLAUDE_USAGE_LIMIT = /(?:hit your|reached your) (?:usage|session|weekly) limit/i;
const CLAUDE_LIMIT_RESETS = /limit reached.*resets/i;

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
  if (CLAUDE_USAGE_LIMIT.test(text) || CLAUDE_LIMIT_RESETS.test(text)) {
    return { kind: 'usage-limit', reason: 'Claude usage limit reached' };
  }
  return null;
}

export function detectStuckScreen(cli: Cli, rows: readonly string[]): StuckScreen | null {
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
