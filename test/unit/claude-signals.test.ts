import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { claudeSignalsFromHook } from '../../src/claude-signals';

const FIXTURE_DIR = path.join(__dirname, '..', 'fixtures', 'claude-hooks');
const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8')) as Record<string, unknown>;

const SESSION = 'sess-1';
const NOW = 1_794_000_000_000;

describe('claudeSignalsFromHook', () => {
  it('StopFailure with error rate_limit → limited, carrying error_details', () => {
    expect(
      claudeSignalsFromHook(SESSION, 'StopFailure', fixture('stop-failure-rate-limit.json'), NOW),
    ).toEqual([
      {
        kind: 'limited',
        sessionId: SESSION,
        at: NOW,
        source: 'claude-hook',
        detail: "You've hit your session limit · resets 3pm (America/Toronto)",
      },
    ]);
  });

  it('StopFailure with another error is not a limit', () => {
    expect(claudeSignalsFromHook(SESSION, 'StopFailure', { error: 'overloaded' }, NOW)).toEqual([]);
  });

  it('UserPromptSubmit → resumed by a turn', () => {
    expect(
      claudeSignalsFromHook(SESSION, 'UserPromptSubmit', fixture('user-prompt-submit.json'), NOW),
    ).toEqual([
      { kind: 'resumed', sessionId: SESSION, at: NOW, by: 'turn', source: 'claude-hook' },
    ]);
  });

  it('Stop is not a resume', () => {
    expect(claudeSignalsFromHook(SESSION, 'Stop', fixture('stop.json'), NOW)).toEqual([]);
  });

  it('Notification quota_auto_resume_fired → resumed by Claude itself', () => {
    expect(
      claudeSignalsFromHook(SESSION, 'Notification', fixture('notification-quota-fired.json'), NOW),
    ).toEqual([
      { kind: 'resumed', sessionId: SESSION, at: NOW, by: 'cli-auto', source: 'claude-hook' },
    ]);
  });

  it('Notification stale or disabled → auto-resume unavailable', () => {
    const expected = [
      { kind: 'auto-resume-unavailable', sessionId: SESSION, at: NOW, source: 'claude-hook' },
    ];
    expect(
      claudeSignalsFromHook(SESSION, 'Notification', fixture('notification-quota-stale.json'), NOW),
    ).toEqual(expected);
    expect(
      claudeSignalsFromHook(
        SESSION,
        'Notification',
        {
          notification_type: 'quota_auto_resume_disabled',
        },
        NOW,
      ),
    ).toEqual(expected);
  });

  it('an unrelated Notification is not a signal', () => {
    expect(
      claudeSignalsFromHook(SESSION, 'Notification', { notification_type: 'idle_prompt' }, NOW),
    ).toEqual([]);
  });

  it('StatusLine rate_limits → reset-info per window, with used percent and reset in ms', () => {
    const { rate_limits } = fixture('statusline-rate-limits.json');
    expect(claudeSignalsFromHook(SESSION, 'StatusLine', { rate_limits }, NOW)).toEqual([
      {
        kind: 'reset-info',
        sessionId: SESSION,
        at: NOW,
        source: 'claude-statusline',
        windows: [
          { name: 'five_hour', usedPct: 100, resetAt: 1794535288000 },
          { name: 'seven_day', usedPct: 56, resetAt: 1794584488000 },
        ],
      },
    ]);
  });

  it('a window without a numeric resets_at is dropped; none left → no signal', () => {
    expect(
      claudeSignalsFromHook(
        SESSION,
        'StatusLine',
        { rate_limits: { five_hour: { used_percentage: 10 }, seven_day: { resets_at: 'soon' } } },
        NOW,
      ),
    ).toEqual([]);
  });

  it('a window with no used_percentage keeps its reset and has no usedPct key', () => {
    const [signal] = claudeSignalsFromHook(
      SESSION,
      'StatusLine',
      { rate_limits: { five_hour: { resets_at: 1794535288 } } },
      NOW,
    );
    expect(signal).toBeDefined();
    if (signal?.kind !== 'reset-info') throw new Error('expected reset-info');
    expect(signal.windows).toEqual([{ name: 'five_hour', resetAt: 1794535288000 }]);
    expect(Object.keys(signal.windows[0] ?? {})).not.toContain('usedPct');
  });

  it('a StatusLine without rate_limits (start-up render) is no signal', () => {
    expect(claudeSignalsFromHook(SESSION, 'StatusLine', { rate_limits: undefined }, NOW)).toEqual(
      [],
    );
  });

  it('malformed payloads give no signal and never throw', () => {
    const payloads: unknown[] = [
      null,
      undefined,
      'text',
      42,
      [],
      { rate_limits: null },
      { error: 7 },
    ];
    for (const event of [
      'StopFailure',
      'UserPromptSubmit',
      'Stop',
      'Notification',
      'StatusLine',
    ] as const) {
      for (const payload of payloads) {
        expect(() => claudeSignalsFromHook(SESSION, event, payload, NOW)).not.toThrow();
      }
    }
    expect(claudeSignalsFromHook(SESSION, 'StatusLine', { rate_limits: null }, NOW)).toEqual([]);
    expect(claudeSignalsFromHook(SESSION, 'StopFailure', null, NOW)).toEqual([]);
  });
});
