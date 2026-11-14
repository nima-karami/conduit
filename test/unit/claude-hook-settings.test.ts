import { describe, expect, it } from 'vitest';
import { claudeHookSettings, statusLineWrapFor } from '../../src/claude-hook-settings';

const EXEC = '/opt/Conduit/conduit';
const HOOK = '/opt/Conduit/resources/conduit-mcp/conduit-hook.cjs';
const RUN = `ELECTRON_RUN_AS_NODE=1 '${EXEC}' '${HOOK}'`;
const NONE = { execPath: EXEC, hookClient: HOOK, statusLine: { user: null } };
const hook = (event: string) => ({ type: 'command', command: `${RUN} hook ${event}`, timeout: 5 });

describe('claudeHookSettings', () => {
  it('registers each event with the matcher Claude names for it', () => {
    expect(claudeHookSettings(NONE).hooks).toEqual({
      StopFailure: [{ matcher: 'rate_limit', hooks: [hook('StopFailure')] }],
      UserPromptSubmit: [{ hooks: [hook('UserPromptSubmit')] }],
      Stop: [{ hooks: [hook('Stop')] }],
      Notification: [
        {
          matcher: 'quota_auto_resume_fired|quota_auto_resume_stale|quota_auto_resume_disabled',
          hooks: [hook('Notification')],
        },
      ],
    });
  });

  it('points the status line at the wrapper even with no user status line', () => {
    const s = claudeHookSettings(NONE);
    expect(s.statusLine).toEqual({ type: 'command', command: `${RUN} statusline` });
  });

  it('copies only the padding, refresh and vim settings of the user status line', () => {
    const s = claudeHookSettings({
      ...NONE,
      statusLine: {
        user: {
          type: 'command',
          command: 'echo user',
          padding: 2,
          refreshInterval: 5,
          hideVimModeIndicator: true,
        },
      },
    });
    expect(s.statusLine).toEqual({
      type: 'command',
      command: `${RUN} statusline`,
      padding: 2,
      refreshInterval: 5,
      hideVimModeIndicator: true,
    });
  });

  it('leaves out copied keys the user did not set', () => {
    const s = claudeHookSettings({
      ...NONE,
      statusLine: { user: { type: 'command', command: 'echo user', padding: 2 } },
    });
    expect(Object.keys(s.statusLine as object)).toEqual(['type', 'command', 'padding']);
  });

  it('single-quotes paths with spaces and embedded quotes for POSIX sh', () => {
    const s = claudeHookSettings({
      execPath: "/opt/o'neil app/conduit",
      hookClient: '/opt/a b/conduit-hook.cjs',
      statusLine: { user: null },
    });
    expect(s.statusLine).toEqual({
      type: 'command',
      command:
        "ELECTRON_RUN_AS_NODE=1 '/opt/o'\\''neil app/conduit' '/opt/a b/conduit-hook.cjs' statusline",
    });
  });

  it('passes the resolved Git Bash to the wrapper on its command line', () => {
    const s = claudeHookSettings({
      ...NONE,
      statusLine: { user: null, gitBash: 'C:\\Program Files\\Git\\bin\\bash.exe' },
    });
    expect(s.statusLine).toEqual({
      type: 'command',
      command: `ELECTRON_RUN_AS_NODE=1 CONDUIT_GIT_BASH='C:\\Program Files\\Git\\bin\\bash.exe' '${EXEC}' '${HOOK}' statusline`,
    });
  });

  it('with statusLine null injects the hooks but leaves the status line alone (blockers D6)', () => {
    const s = claudeHookSettings({ ...NONE, statusLine: null });
    expect('statusLine' in s).toBe(false);
    expect(Object.keys(s.hooks as object)).toHaveLength(4);
  });

  it('is plain JSON with no undefined values', () => {
    const s = claudeHookSettings(NONE);
    expect(JSON.parse(JSON.stringify(s))).toStrictEqual(s);
  });
});

describe('statusLineWrapFor', () => {
  const user = { type: 'command' as const, command: 'echo me', padding: 1 };

  it('wraps on POSIX without looking for Git Bash', () => {
    let asked = false;
    const r = statusLineWrapFor({
      platform: 'linux',
      env: {},
      gitBash: () => {
        asked = true;
        return undefined;
      },
      user,
    });
    expect(r).toEqual({ wrap: { user } });
    expect(asked).toBe(false);
  });

  it('on Windows uses CLAUDE_CODE_GIT_BASH_PATH first, then the install candidates', () => {
    expect(
      statusLineWrapFor({
        platform: 'win32',
        env: { CLAUDE_CODE_GIT_BASH_PATH: 'D:\\Git\\bin\\bash.exe' },
        gitBash: () => 'C:\\Program Files\\Git\\bin\\bash.exe',
        user,
      }),
    ).toEqual({ wrap: { user, gitBash: 'D:\\Git\\bin\\bash.exe' } });
    expect(
      statusLineWrapFor({
        platform: 'win32',
        env: {},
        gitBash: () => 'C:\\Program Files\\Git\\bin\\bash.exe',
        user,
      }),
    ).toEqual({ wrap: { user, gitBash: 'C:\\Program Files\\Git\\bin\\bash.exe' } });
  });

  it('on Windows with no Git Bash does not wrap, and says why (blockers D6)', () => {
    const r = statusLineWrapFor({ platform: 'win32', env: {}, gitBash: () => undefined, user });
    expect(r.wrap).toBeNull();
    expect(r.skipped).toMatch(/Git Bash/);
  });
});
