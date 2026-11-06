import { describe, expect, it } from 'vitest';
import { detectStuckScreen } from '../../src/cli-stuck-screens';

const rows = (text: string): string[] => text.split('\n');

const CODEX_USAGE_LIMIT =
  rows(`■ You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at 3:26 AM.


  Approaching rate limits
  Switch to gpt-6-luna for lower credit usage?


› 1. Switch to gpt-6-luna                   Fast and affordable model for easier tasks.
  2. Keep current model
  3. Keep current model (never show again)  Hide future rate limit reminders about switching models

  enter select · esc back`);

const CODEX_USAGE_LIMIT_ONLY = rows(
  `■ You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at 3:26 AM.`,
);

const CURSOR_PROVIDER_ERROR = rows(`  G:\\awby\\projects\\conduit-wt\\flaky-gate · feat/flaky-gate
  Error: Unable to reach the model provider
  We're having trouble connecting to the model provider. This might be temporary - please try again in a moment.`);

const CURSOR_INCLUDED_USAGE =
  rows(`You've saved $34 on API model usage this month with Pro. Switch to a different model or set a Spend Limit to continue with this
  model. Your usage limits will reset when your monthly cycle ends on 11/28/2026.`);

const CODEX_WORKING = rows(`› run the tests
• Ran npm test
  └ > conduit@0.57.0 test
    > vitest run
    ✓ test/unit/a.test.ts (3 tests) 12ms
    Test Files  1 passed (1)

• All 3 tests pass. I'll wrap up the change now.

›`);

const padding = (n: number): string[] => Array.from({ length: n }, (_, i) => `  filler line ${i}`);

describe('detectStuckScreen', () => {
  it('flags the Codex usage limit and extracts the retry time', () => {
    expect(detectStuckScreen('codex', CODEX_USAGE_LIMIT_ONLY)).toEqual({
      kind: 'usage-limit',
      reason: 'Codex usage limit reached — try again at 3:26 AM',
    });
  });

  it('matches the straight apostrophe as well as the curly one', () => {
    expect(detectStuckScreen('codex', CODEX_USAGE_LIMIT_ONLY)).toEqual({
      kind: 'usage-limit',
      reason: 'Codex usage limit reached — try again at 3:26 AM',
    });
  });

  it('reports the Codex usage limit without a retry time when none is printed', () => {
    expect(
      detectStuckScreen('codex', rows('■ You’ve hit your usage limit. Upgrade to Pro.')),
    ).toEqual({ kind: 'usage-limit', reason: 'Codex usage limit reached' });
  });

  it('flags the Codex rate-limit model-switch prompt on its own', () => {
    const screen = rows(`  Approaching rate limits
  Switch to gpt-6-luna for lower credit usage?

› 1. Switch to gpt-6-luna
  2. Keep current model

  enter select · esc back`);
    expect(detectStuckScreen('codex', screen)).toEqual({
      kind: 'rate-limit-prompt',
      reason: 'Codex asks whether to switch models',
    });
  });

  it('prefers the Codex prompt when the usage-limit line and the prompt are both in view', () => {
    expect(detectStuckScreen('codex', CODEX_USAGE_LIMIT)).toEqual({
      kind: 'rate-limit-prompt',
      reason: 'Codex asks whether to switch models',
    });
  });

  it('flags the Cursor provider error', () => {
    expect(detectStuckScreen('cursor', CURSOR_PROVIDER_ERROR)).toEqual({
      kind: 'provider-error',
      reason: "Cursor can't reach the model provider",
    });
  });

  it('flags the Cursor included-usage exhaustion', () => {
    expect(detectStuckScreen('cursor', CURSOR_INCLUDED_USAGE)).toEqual({
      kind: 'usage-limit',
      reason: 'Cursor usage limit reached',
    });
  });

  it('flags a Claude usage limit (made-up row, no captured fixture)', () => {
    expect(detectStuckScreen('claude', rows("You've hit your session limit · resets 5pm"))).toEqual(
      { kind: 'usage-limit', reason: 'Claude usage limit reached' },
    );
    expect(detectStuckScreen('claude', rows('Claude usage limit reached · resets 3pm'))).toEqual({
      kind: 'usage-limit',
      reason: 'Claude usage limit reached',
    });
  });

  it('does not flag source code or log text that merely mentions a limit', () => {
    expect(detectStuckScreen('codex', rows('const re = /You’ve hit your usage limit/'))).toBeNull();
    expect(detectStuckScreen('codex', rows('Approaching rate limits in the docs'))).toBeNull();
    expect(
      detectStuckScreen('cursor', rows('Error: Unable to reach the model provider in logs')),
    ).toBeNull();
    expect(detectStuckScreen('claude', rows('INFO usage limit reached, resets at 5'))).toBeNull();
    expect(detectStuckScreen('claude', rows('Limit reached · resets 3pm'))).toBeNull();
  });

  it('returns null for a normal working screen', () => {
    expect(detectStuckScreen('codex', CODEX_WORKING)).toBeNull();
  });

  it('returns null for CLIs without detectors', () => {
    expect(detectStuckScreen('opencode', CURSOR_PROVIDER_ERROR)).toBeNull();
    expect(detectStuckScreen('agent', CODEX_USAGE_LIMIT)).toBeNull();
  });

  it('ignores a limit line that scrolled above the last 25 non-empty rows', () => {
    const scrolled = [...CODEX_USAGE_LIMIT_ONLY, ...padding(25), '› ', '• Ran npm test'];
    expect(detectStuckScreen('codex', scrolled)).toBeNull();
  });

  it('still flags a limit line within the last 25 non-empty rows', () => {
    const recent = [...padding(20), ...CODEX_USAGE_LIMIT_ONLY, ...padding(3)];
    expect(detectStuckScreen('codex', recent)).toEqual({
      kind: 'usage-limit',
      reason: 'Codex usage limit reached — try again at 3:26 AM',
    });
  });

  it('counts only non-empty rows toward the 25-row window', () => {
    const blankGapped = [
      ...CODEX_USAGE_LIMIT_ONLY,
      ...padding(24),
      ...Array.from({ length: 30 }, () => ''),
    ];
    expect(detectStuckScreen('codex', blankGapped)).toEqual({
      kind: 'usage-limit',
      reason: 'Codex usage limit reached — try again at 3:26 AM',
    });
  });
});
