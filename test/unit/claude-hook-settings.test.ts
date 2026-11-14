import { describe, expect, it } from 'vitest';
import { claudeHookSettings } from '../../src/claude-hook-settings';

const EXEC = '/opt/Conduit/conduit';
const HOOK = '/opt/Conduit/resources/conduit-mcp/conduit-hook.cjs';
const RUN = `ELECTRON_RUN_AS_NODE=1 '${EXEC}' '${HOOK}'`;
const NONE = { execPath: EXEC, hookClient: HOOK, userStatusLine: null };
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
      userStatusLine: {
        type: 'command',
        command: 'echo user',
        padding: 2,
        refreshInterval: 5,
        hideVimModeIndicator: true,
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
      userStatusLine: { type: 'command', command: 'echo user', padding: 2 },
    });
    expect(Object.keys(s.statusLine as object)).toEqual(['type', 'command', 'padding']);
  });

  it('single-quotes paths with spaces and embedded quotes for POSIX sh', () => {
    const s = claudeHookSettings({
      execPath: "/opt/o'neil app/conduit",
      hookClient: '/opt/a b/conduit-hook.cjs',
      userStatusLine: null,
    });
    expect(s.statusLine).toEqual({
      type: 'command',
      command:
        "ELECTRON_RUN_AS_NODE=1 '/opt/o'\\''neil app/conduit' '/opt/a b/conduit-hook.cjs' statusline",
    });
  });

  it('is plain JSON with no undefined values', () => {
    const s = claudeHookSettings(NONE);
    expect(JSON.parse(JSON.stringify(s))).toStrictEqual(s);
  });
});
