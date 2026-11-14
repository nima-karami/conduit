import type { CliKind } from './conduit-mcp/tool-policy';
import {
  type CompiledRules,
  compileLimitRules,
  DEFAULT_LIMIT_RULES,
  matchStuckRule,
} from './limit-rules';

export type StuckKind = 'usage-limit' | 'rate-limit-prompt' | 'provider-error' | 'update-prompt';

export interface StuckScreen {
  kind: StuckKind;
  reason: string;
}

const DEFAULT_RULES = compileLimitRules(DEFAULT_LIMIT_RULES);

// see spec 2026-11-13-scheduler-auto-resume R6
export function detectStuckScreen(
  cli: CliKind,
  rows: readonly string[],
  rules: CompiledRules = DEFAULT_RULES,
): StuckScreen | null {
  return matchStuckRule(rules, cli, rows);
}
