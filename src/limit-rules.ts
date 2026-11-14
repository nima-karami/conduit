import type { StuckKind } from './cli-stuck-screens';
import { CLI_KINDS, type CliKind } from './conduit-mcp/tool-policy';
import {
  LIMIT_RULE_MAX_PATTERN,
  type LimitRule,
  type ResetFormat,
  RULE_SCAN_ROWS,
  type RuleMatch,
} from './contracts/auto-resume';
import { judgePersistedVersion } from './contracts/session-identity';
import { parseResetText } from './reset-time';

export interface CompiledRules {
  rules: readonly LimitRule[];
  invalid: { id: string; error: string }[];
}

interface RuleHit {
  rule: LimitRule;
  resetText: string | null;
  reason: string;
}

const STUCK_KINDS = [
  'usage-limit',
  'rate-limit-prompt',
  'provider-error',
  'update-prompt',
] as const satisfies readonly StuckKind[];
const RESET_FORMATS = [
  'clock',
  'clock-or-date',
  'countdown',
] as const satisfies readonly ResetFormat[];
const RESET_PLACEHOLDER = '{reset}';

export const DEFAULT_LIMIT_RULES: readonly LimitRule[] = [
  {
    id: 'default:codex:switch-prompt',
    cli: 'codex',
    enabled: true,
    match: '^[ \\t]*Approaching rate limits[ \\t]*$[\\s\\S]*enter select · esc back',
    kind: 'rate-limit-prompt',
    reason: 'Codex asks whether to switch models',
  },
  {
    id: 'default:codex:update-prompt',
    cli: 'codex',
    enabled: true,
    match: '^[ \\t]*Update available\\b[\\s\\S]*enter continue · esc skip',
    kind: 'update-prompt',
    reason: 'Codex is asking whether to update',
  },
  {
    id: 'default:codex:usage-limit-reset',
    cli: 'codex',
    enabled: true,
    match:
      "^[ \\t]*■ You[’']ve hit your usage limit[\\s\\S]*?try again at (?<reset>(?:[A-Za-z]{3,9}\\.? \\d{1,2}(?:st|nd|rd|th)?,? (?:\\d{4} )?)?[0-9:]+\\s*[AP]M(?:\\s*\\([A-Za-z_]+(?:\\/[A-Za-z0-9_+-]+)+\\))?)",
    reset: { group: 'reset', format: 'clock-or-date' },
    kind: 'usage-limit',
    reason: 'Codex usage limit reached — try again at {reset}',
  },
  {
    id: 'default:codex:usage-limit',
    cli: 'codex',
    enabled: true,
    match: "^[ \\t]*■ You[’']ve hit your usage limit",
    kind: 'usage-limit',
    reason: 'Codex usage limit reached',
  },
  {
    id: 'default:cursor:provider-error',
    cli: 'cursor',
    enabled: true,
    match: '^[ \\t]*Error: Unable to reach the model provider[ \\t]*$',
    kind: 'provider-error',
    reason: "Cursor can't reach the model provider",
  },
  {
    id: 'default:cursor:usage-limit',
    cli: 'cursor',
    enabled: true,
    match: '^[ \\t]*(?:model\\. )?Your usage limits will reset when your monthly cycle ends',
    kind: 'usage-limit',
    reason: 'Cursor usage limit reached',
  },
  {
    id: 'default:claude:usage-limit-reset',
    cli: 'claude',
    enabled: true,
    match:
      '(?=[^\\n]*\\blimits?\\b)(?=[^\\n]*(?:\\b(?:hit|reached|exceeded|usage)\\b|\\bsession limit\\b))[^\\n]*?\\bresets?\\s+(?:at\\s+)?(?<reset>[^\\n]*\\S)',
    reset: { group: 'reset', format: 'clock-or-date' },
    reason: 'Claude usage limit reached — resets {reset}',
  },
  {
    id: 'default:claude:usage-limit',
    cli: 'claude',
    enabled: true,
    match:
      "^[ \\t]*(?:Claude usage limit reached|You[’']ve hit your (?:usage|session|weekly) limit)",
    kind: 'usage-limit',
    reason: 'Claude usage limit reached',
  },
];

const PATTERN_FLAGS = 'gmi';
const patterns = new WeakMap<CompiledRules, ReadonlyMap<LimitRule, RegExp>>();

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function namedGroups(match: string): string[] {
  const groups = new RegExp(`(?:${match})|`, PATTERN_FLAGS).exec('')?.groups ?? {};
  return Object.keys(groups);
}

function problemWith(rule: LimitRule): { error: string } | { pattern: RegExp } {
  if (rule.match.length > LIMIT_RULE_MAX_PATTERN) {
    return {
      error: `pattern is ${rule.match.length} characters; the limit is ${LIMIT_RULE_MAX_PATTERN}`,
    };
  }
  let pattern: RegExp;
  try {
    pattern = new RegExp(rule.match, PATTERN_FLAGS);
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
  if (rule.reset && !namedGroups(rule.match).includes(rule.reset.group)) {
    return { error: `pattern has no named group "${rule.reset.group}"` };
  }
  if (rule.reason?.includes(RESET_PLACEHOLDER) && !rule.reset) {
    return { error: `reason uses ${RESET_PLACEHOLDER} but the rule has no reset group` };
  }
  return { pattern };
}

export function compileLimitRules(rules: readonly LimitRule[]): CompiledRules {
  const valid: LimitRule[] = [];
  const invalid: { id: string; error: string }[] = [];
  const compiled = new Map<LimitRule, RegExp>();
  for (const rule of rules) {
    const outcome = problemWith(rule);
    if ('error' in outcome) invalid.push({ id: rule.id, error: outcome.error });
    else {
      valid.push(rule);
      compiled.set(rule, outcome.pattern);
    }
  }
  const compiledRules: CompiledRules = { rules: valid, invalid };
  patterns.set(compiledRules, compiled);
  return compiledRules;
}

const isCli = (v: unknown): v is CliKind | '*' =>
  v === '*' || (CLI_KINDS as readonly unknown[]).includes(v);
const isStuckKind = (v: unknown): v is StuckKind => (STUCK_KINDS as readonly unknown[]).includes(v);
const isResetFormat = (v: unknown): v is ResetFormat =>
  (RESET_FORMATS as readonly unknown[]).includes(v);

function readRule(
  raw: unknown,
  index: number,
): { rule: LimitRule } | { id: string; error: string } {
  if (!isRecord(raw)) return { id: `#${index}`, error: 'rule is not an object' };
  const id = raw.id;
  if (typeof id !== 'string' || id === '') {
    return { id: `#${index}`, error: 'id must be a non-empty string' };
  }
  const fail = (error: string) => ({ id, error });
  if (!isCli(raw.cli)) return fail('cli must be a CLI name or "*"');
  if (typeof raw.enabled !== 'boolean') return fail('enabled must be true or false');
  if (typeof raw.match !== 'string') return fail('match must be a string');
  if (raw.message !== undefined && typeof raw.message !== 'string') {
    return fail('message must be a string');
  }
  if (raw.reason !== undefined && typeof raw.reason !== 'string') {
    return fail('reason must be a string');
  }
  if (raw.kind !== undefined && !isStuckKind(raw.kind))
    return fail('kind is not a known screen kind');
  let reset: LimitRule['reset'];
  if (raw.reset !== undefined) {
    if (!isRecord(raw.reset) || typeof raw.reset.group !== 'string') {
      return fail('reset must name a group');
    }
    if (!isResetFormat(raw.reset.format)) {
      return fail('reset format must be clock, clock-or-date or countdown');
    }
    reset = { group: raw.reset.group, format: raw.reset.format };
  }
  const rule: LimitRule = {
    id,
    cli: raw.cli,
    enabled: raw.enabled,
    match: raw.match,
    ...(reset ? { reset } : {}),
    ...(typeof raw.message === 'string' ? { message: raw.message } : {}),
    ...(isStuckKind(raw.kind) ? { kind: raw.kind } : {}),
    ...(typeof raw.reason === 'string' ? { reason: raw.reason } : {}),
  };
  return { rule };
}

/** Throws on corrupt JSON, a missing rules array or no usable version: the caller falls back. */
export function parseLimitRulesFile(blob: string): {
  version: 'read' | 'newer';
  rules: LimitRule[];
  invalid: { id: string; error: string }[];
} {
  const doc: unknown = JSON.parse(blob);
  if (!isRecord(doc) || !Array.isArray(doc.rules)) {
    throw new Error('limit-rules.json must hold a rules array');
  }
  const version = judgePersistedVersion('limit-rules.json', doc.version);
  if (version === 'invalid') throw new Error('limit-rules.json has no usable version');
  const rules: LimitRule[] = [];
  const invalid: { id: string; error: string }[] = [];
  doc.rules.forEach((raw: unknown, index: number) => {
    const outcome = readRule(raw, index);
    if ('rule' in outcome) rules.push(outcome.rule);
    else invalid.push(outcome);
  });
  return { version, rules, invalid };
}

function scanText(rows: readonly string[]): string {
  return rows
    .filter((row) => row.trim() !== '')
    .slice(-RULE_SCAN_ROWS)
    .join('\n');
}

function findRuleMatch(
  compiled: CompiledRules,
  cli: CliKind,
  rows: readonly string[],
  accept: (rule: LimitRule) => boolean = () => true,
): RuleHit | null {
  const compiledPatterns = patterns.get(compiled);
  if (!compiledPatterns) throw new Error('rules must come from compileLimitRules');
  const text = scanText(rows);
  for (const rule of compiled.rules) {
    if (!rule.enabled || (rule.cli !== '*' && rule.cli !== cli) || !accept(rule)) continue;
    const pattern = compiledPatterns.get(rule);
    if (!pattern) continue;
    let last: RegExpMatchArray | null = null;
    for (const m of text.matchAll(pattern)) last = m;
    if (!last) continue;
    const resetText = rule.reset ? last.groups?.[rule.reset.group] || null : null;
    const template = rule.reason ?? rule.id;
    const reason = template
      .split(RESET_PLACEHOLDER)
      .join(resetText ?? '')
      .trim();
    return { rule, resetText, reason };
  }
  return null;
}

export function matchStuckRule(
  compiled: CompiledRules,
  cli: CliKind,
  rows: readonly string[],
): { kind: StuckKind; reason: string } | null {
  const hit = findRuleMatch(compiled, cli, rows, (rule) => rule.kind !== undefined);
  if (!hit?.rule.kind) return null;
  return { kind: hit.rule.kind, reason: hit.reason };
}

export function matchLimitRules(
  compiled: CompiledRules,
  cli: CliKind,
  rows: readonly string[],
  now: number,
): RuleMatch | null {
  const hit = findRuleMatch(compiled, cli, rows);
  if (!hit) return null;
  const resetAt =
    hit.rule.reset && hit.resetText
      ? parseResetText(hit.resetText, hit.rule.reset.format, now)
      : null;
  return { rule: hit.rule, resetAt, resetText: hit.resetText, reason: hit.reason };
}
