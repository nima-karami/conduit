// Limit signals (adapter → Limit monitor) and the editable text rules.
// see docs/specs/2026-11-13-scheduler-auto-resume.md §3 "Signals" and "Text-rule fallback"
import type { StuckKind } from '../cli-stuck-screens';
import type { CliKind } from '../conduit-mcp/tool-policy';

/** `attention` and `human-input` are the R3 / R4 sources (plan "Decisions Needed"). */
export type SignalSource =
  | 'claude-hook'
  | 'claude-statusline'
  | 'codex-rollout'
  | 'attention'
  | 'human-input'
  | `rule:${string}`;

export type LimitSignal =
  | {
      kind: 'limited';
      sessionId: string;
      at: number;
      resetAt?: number;
      window?: string;
      source: SignalSource;
      detail?: string;
    }
  | {
      kind: 'reset-info';
      sessionId: string;
      at: number;
      windows: { name: string; usedPct?: number; resetAt: number }[];
      source: SignalSource;
    }
  | {
      kind: 'resumed';
      sessionId: string;
      at: number;
      by: 'cli-auto' | 'turn' | 'human-input';
      source: SignalSource;
    }
  | { kind: 'auto-resume-unavailable'; sessionId: string; at: number; source: SignalSource };

export type ResetFormat = 'clock' | 'clock-or-date' | 'countdown';

export interface LimitRule {
  id: string;
  cli: CliKind | '*';
  enabled: boolean;
  /** JS regex source, flags 'mi'. */
  match: string;
  /** `group` names a named capture group in `match`. */
  reset?: { group: string; format: ResetFormat };
  message?: string;
  /** R6: the CON-151 "needs you" kind this rule reports. */
  kind?: StuckKind;
  /** R6: a template; `{reset}` is replaced by the reset group's text. */
  reason?: string;
}

export interface RuleMatch {
  rule: LimitRule;
  resetAt: number | null;
  resetText: string | null;
  reason: string;
}

export const LIMIT_RULE_MAX_PATTERN = 500;
export const RULE_SCAN_ROWS = 25;
