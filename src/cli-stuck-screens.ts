import type { CliKind } from './conduit-mcp/tool-policy';
import {
  type CompiledRules,
  compileLimitRules,
  DEFAULT_LIMIT_RULES,
  findRuleMatch,
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
  const hit = findRuleMatch(rules, cli, rows, (rule) => rule.kind !== undefined);
  if (!hit?.rule.kind) return null;
  return { kind: hit.rule.kind, reason: hit.reason };
}
