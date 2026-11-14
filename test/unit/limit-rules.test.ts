import { describe, expect, it } from 'vitest';
import type { LimitRule } from '../../src/contracts/auto-resume';
import {
  compileLimitRules,
  DEFAULT_LIMIT_RULES,
  matchLimitRules,
  parseLimitRulesFile,
} from '../../src/limit-rules';

const NOV13_1500_TORONTO = Date.UTC(2026, 10, 13, 20, 0, 0);
const DEFAULTS = compileLimitRules(DEFAULT_LIMIT_RULES);
const HOUR = 3_600_000;

const padding = (n: number): string[] => Array.from({ length: n }, (_, i) => `  filler line ${i}`);

const rule = (over: Partial<LimitRule> & Pick<LimitRule, 'id' | 'match'>): LimitRule => ({
  cli: 'claude',
  enabled: true,
  ...over,
});

describe('default rules', () => {
  it('resolves resetAt from a Codex ■ limit line with "try again at"', () => {
    const rows = [
      '■ You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), or try again at 3:45 PM.',
    ];
    const match = matchLimitRules(DEFAULTS, 'codex', rows, NOV13_1500_TORONTO);
    expect(match?.resetText).toBe('3:45 PM');
    expect(match?.resetAt).not.toBeNull();
    expect(match?.resetAt).toBeGreaterThan(NOV13_1500_TORONTO);
    expect(match?.resetAt).toBeLessThanOrEqual(NOV13_1500_TORONTO + 25 * HOUR);
    expect(match?.reason).toBe('Codex usage limit reached — try again at 3:45 PM');
  });

  it('finds a Claude notice that has three or more rows under it', () => {
    const rows = [
      'working…',
      "You've hit your session limit · resets 11:10pm (America/Toronto)",
      'line a',
      'line b',
      'line c',
    ];
    expect(matchLimitRules(DEFAULTS, 'claude', rows, NOV13_1500_TORONTO)?.resetAt).toBe(
      Date.UTC(2026, 10, 14, 4, 10),
    );
  });

  it('keeps a Claude notice with an unreadable time as a match with no resetAt', () => {
    const match = matchLimitRules(
      DEFAULTS,
      'claude',
      ['Session limit reached — resets later'],
      NOV13_1500_TORONTO,
    );
    expect(match).not.toBeNull();
    expect(match?.resetAt).toBeNull();
  });

  it('does not read a countdown as a wall clock', () => {
    const match = matchLimitRules(
      DEFAULTS,
      'claude',
      ['Session limit reached — resets in 04:59'],
      NOV13_1500_TORONTO,
    );
    expect(match?.resetAt).toBeNull();
  });

  it('ignores a log stamp in front of the reset time', () => {
    const match = matchLimitRules(
      DEFAULTS,
      'claude',
      ['[14:32:07] Claude usage limit reached — resets 23:10 (America/Toronto)'],
      NOV13_1500_TORONTO,
    );
    expect(match?.resetAt).toBe(Date.UTC(2026, 10, 14, 4, 10));
  });

  it('reads only the last 25 non-empty rows', () => {
    const notice = "You've hit your session limit · resets 11:10pm (America/Toronto)";
    expect(
      matchLimitRules(DEFAULTS, 'claude', [notice, ...padding(25)], NOV13_1500_TORONTO),
    ).toBeNull();
    expect(
      matchLimitRules(DEFAULTS, 'claude', [notice, ...padding(24)], NOV13_1500_TORONTO),
    ).not.toBeNull();
  });

  it('keeps a blocking prompt ahead of the usage line it sits under', () => {
    const rows = [
      '■ You’ve hit your usage limit. try again at 3:26 AM',
      '  Approaching rate limits',
      '  Switch to gpt-6-luna for lower credit usage?',
      '  enter select · esc back',
    ];
    expect(matchLimitRules(DEFAULTS, 'codex', rows, NOV13_1500_TORONTO)?.rule.id).toBe(
      'default:codex:switch-prompt',
    );
  });
});

describe('compileLimitRules and parseLimitRulesFile', () => {
  it('excludes an invalid regex and loads the others', () => {
    const compiled = compileLimitRules([
      rule({ id: 'bad', match: '(unclosed' }),
      rule({ id: 'ok', match: 'resets' }),
    ]);
    expect(compiled.rules.map((r) => r.id)).toEqual(['ok']);
    expect(compiled.invalid.map((i) => i.id)).toEqual(['bad']);
  });

  it('rejects a pattern over 500 characters', () => {
    const compiled = compileLimitRules([rule({ id: 'long', match: 'a'.repeat(501) })]);
    expect(compiled.rules).toEqual([]);
    expect(compiled.invalid[0]?.error).toMatch(/500/);
  });

  it('rejects a reset group that the pattern does not name', () => {
    const compiled = compileLimitRules([
      rule({
        id: 'missing-group',
        match: 'resets (?<reset>.+)',
        reset: { group: 'when', format: 'clock-or-date' },
      }),
    ]);
    expect(compiled.rules).toEqual([]);
    expect(compiled.invalid[0]?.id).toBe('missing-group');
  });

  it('rejects a reason that uses {reset} when the rule has no reset group', () => {
    const compiled = compileLimitRules([
      rule({ id: 'orphan', match: 'limit', reason: 'until {reset}' }),
    ]);
    expect(compiled.invalid[0]?.id).toBe('orphan');
  });

  it('ignores a disabled rule while matching', () => {
    const compiled = compileLimitRules([
      rule({ id: 'off', match: 'usage limit', enabled: false, reason: 'off' }),
    ]);
    expect(
      matchLimitRules(compiled, 'claude', ['usage limit reached'], NOV13_1500_TORONTO),
    ).toBeNull();
  });

  it('applies a cli-agnostic rule to every CLI', () => {
    const compiled = compileLimitRules([
      rule({ id: 'any', cli: '*', match: 'quota exhausted', reason: 'quota' }),
    ]);
    expect(
      matchLimitRules(compiled, 'agent', ['quota exhausted'], NOV13_1500_TORONTO)?.reason,
    ).toBe('quota');
  });

  it('reports a malformed rule in the file and keeps the rest', () => {
    const blob = JSON.stringify({
      version: 1,
      rules: [
        { id: 'good', cli: 'claude', enabled: true, match: 'limit' },
        { id: 'bad-kind', cli: 'claude', enabled: true, match: 'limit', kind: 'nope' },
      ],
    });
    const parsed = parseLimitRulesFile(blob);
    expect(parsed.rules.map((r) => r.id)).toEqual(['good']);
    expect(parsed.invalid.map((i) => i.id)).toEqual(['bad-kind']);
  });

  it('throws on corrupt JSON and on a foreign version so the caller can fall back', () => {
    expect(() => parseLimitRulesFile('{not json')).toThrow();
    expect(() => parseLimitRulesFile(JSON.stringify({ version: 2, rules: [] }))).toThrow();
  });
});
