import type { StatusLineSetting } from './claude-user-status-line';

// see docs/plans/2026-11-13-scheduler-auto-resume.plan.md "Settled decisions"
export interface StatusLineWrap {
  /** The user's effective status line at launch; its display keys are copied. */
  user: StatusLineSetting | null;
  /** Windows only: the Git Bash the wrapper runs the user's command with (never `bash` on PATH). */
  gitBash?: string;
}

/** `statusLine: null` = leave the status line alone (see blockers D6: no Git Bash on Windows). */
export function claudeHookSettings(i: {
  execPath: string;
  hookClient: string;
  statusLine: StatusLineWrap | null;
}): Record<string, unknown> {
  const base = `ELECTRON_RUN_AS_NODE=1 ${sq(i.execPath)} ${sq(i.hookClient)}`;
  const hook = (event: string) => ({
    type: 'command',
    command: `${base} hook ${event}`,
    timeout: 5,
  });
  const hooks = {
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
  };
  if (i.statusLine === null) return hooks;
  const bash =
    i.statusLine.gitBash === undefined ? '' : ` CONDUIT_GIT_BASH=${sq(i.statusLine.gitBash)}`;
  return {
    ...hooks,
    statusLine: {
      type: 'command',
      command: `ELECTRON_RUN_AS_NODE=1${bash} ${sq(i.execPath)} ${sq(i.hookClient)} statusline`,
      ...copiedDisplaySettings(i.statusLine.user),
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

/**
 * Whether this launch wraps the status line. Windows needs a resolved Git Bash for the user's
 * command; without one the wrapper is not injected at all (blockers D6), never `bash` on PATH.
 */
export function statusLineWrapFor(i: {
  platform: string;
  env: Readonly<Record<string, string | undefined>>;
  gitBash: () => string | undefined;
  user: StatusLineSetting | null;
}): { wrap: StatusLineWrap | null; skipped?: string } {
  if (i.platform !== 'win32') return { wrap: { user: i.user } };
  const bash = i.env.CLAUDE_CODE_GIT_BASH_PATH || i.gitBash();
  if (!bash)
    return { wrap: null, skipped: 'no Git Bash found; status line left as the user set it' };
  return { wrap: { user: i.user, gitBash: bash } };
}
