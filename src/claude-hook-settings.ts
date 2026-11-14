import type { StatusLineSetting } from './claude-user-status-line';

// see docs/plans/2026-11-13-scheduler-auto-resume.plan.md "Settled decisions"
export function claudeHookSettings(i: {
  execPath: string;
  hookClient: string;
  userStatusLine: StatusLineSetting | null;
}): Record<string, unknown> {
  const base = `ELECTRON_RUN_AS_NODE=1 ${sq(i.execPath)} ${sq(i.hookClient)}`;
  const hook = (event: string) => ({
    type: 'command',
    command: `${base} hook ${event}`,
    timeout: 5,
  });
  return {
    hooks: {
      StopFailure: [{ matcher: 'rate_limit', hooks: [hook('StopFailure')] }],
      UserPromptSubmit: [{ hooks: [hook('UserPromptSubmit')] }],
      Stop: [{ hooks: [hook('Stop')] }],
      Notification: [
        {
          matcher: 'quota_auto_resume_fired|quota_auto_resume_stale|quota_auto_resume_disabled',
          hooks: [hook('Notification')],
        },
      ],
    },
    statusLine: {
      type: 'command',
      command: `${base} statusline`,
      ...copiedDisplaySettings(i.userStatusLine),
    },
  };
}

function copiedDisplaySettings(
  u: StatusLineSetting | null,
): Partial<Pick<StatusLineSetting, 'padding' | 'refreshInterval' | 'hideVimModeIndicator'>> {
  const out: Partial<
    Pick<StatusLineSetting, 'padding' | 'refreshInterval' | 'hideVimModeIndicator'>
  > = {};
  if (u?.padding !== undefined) out.padding = u.padding;
  if (u?.refreshInterval !== undefined) out.refreshInterval = u.refreshInterval;
  if (u?.hideVimModeIndicator !== undefined) out.hideVimModeIndicator = u.hideVimModeIndicator;
  return out;
}

const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
