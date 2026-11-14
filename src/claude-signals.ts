import type { LimitSignal } from './contracts/auto-resume';
import type { HookEvent } from './contracts/hook-protocol';

// A hook payload is untrusted input: malformed means no signal, never a throw.
export function claudeSignalsFromHook(
  sessionId: string,
  event: HookEvent,
  payload: unknown,
  now: number,
): LimitSignal[] {
  const p = isRecord(payload) ? payload : {};
  switch (event) {
    case 'StopFailure':
      if (p.error !== 'rate_limit') return [];
      return [
        {
          kind: 'limited',
          sessionId,
          at: now,
          source: 'claude-hook',
          ...(typeof p.error_details === 'string' ? { detail: p.error_details } : {}),
        },
      ];
    case 'UserPromptSubmit':
      return [{ kind: 'resumed', sessionId, at: now, by: 'turn', source: 'claude-hook' }];
    case 'Stop':
      return [];
    case 'Notification':
      return notificationSignals(sessionId, p.notification_type, now);
    case 'StatusLine': {
      const windows = windowsOf(p.rate_limits);
      return windows.length === 0
        ? []
        : [{ kind: 'reset-info', sessionId, at: now, windows, source: 'claude-statusline' }];
    }
  }
}

function notificationSignals(sessionId: string, type: unknown, now: number): LimitSignal[] {
  switch (type) {
    case 'quota_auto_resume_fired':
      return [{ kind: 'resumed', sessionId, at: now, by: 'cli-auto', source: 'claude-hook' }];
    case 'quota_auto_resume_stale':
    case 'quota_auto_resume_disabled':
      return [{ kind: 'auto-resume-unavailable', sessionId, at: now, source: 'claude-hook' }];
    default:
      return [];
  }
}

function windowsOf(rateLimits: unknown): { name: string; usedPct?: number; resetAt: number }[] {
  if (!isRecord(rateLimits)) return [];
  const windows: { name: string; usedPct?: number; resetAt: number }[] = [];
  for (const [name, w] of Object.entries(rateLimits)) {
    if (!isRecord(w) || typeof w.resets_at !== 'number' || !Number.isFinite(w.resets_at)) continue;
    const win: { name: string; usedPct?: number; resetAt: number } = {
      name,
      resetAt: w.resets_at * 1000,
    };
    if (typeof w.used_percentage === 'number') win.usedPct = w.used_percentage;
    windows.push(win);
  }
  return windows;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
