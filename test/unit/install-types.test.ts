import { describe, expect, it } from 'vitest';
import {
  AGENT_CLIS,
  type CliInstallStatus,
  ConfigFormatError,
  coerceInstallDismissals,
  coerceInstallRequest,
  needsSetup,
} from '../../src/conduit-mcp/install-types';

function cli(c: CliInstallStatus['cli'], found: boolean, state: CliInstallStatus['user']['state']) {
  return { cli: c, found, user: { state, path: `/h/${c}` }, project: null } as CliInstallStatus;
}

describe('install-types', () => {
  it('AGENT_CLIS order is claude, codex, cursor, opencode', () => {
    expect(AGENT_CLIS).toEqual(['claude', 'codex', 'cursor', 'opencode']);
  });

  it('coerceInstallDismissals keeps known true, drops false/unknown/non-object', () => {
    expect(coerceInstallDismissals({ codex: true, claude: false, gemini: true })).toEqual({
      codex: true,
    });
    expect(coerceInstallDismissals({ cursor: 'true', opencode: 1 })).toEqual({});
    for (const v of [null, [], 'x', undefined, 3]) expect(coerceInstallDismissals(v)).toEqual({});
  });

  it('coerceInstallRequest accepts each valid shape and rejects: unknown cli, bad scope, bad action, numeric projectPath, remove without entryScope, remove with entryScope "x"', () => {
    expect(coerceInstallRequest({ cli: 'claude', scope: 'user', action: 'install' })).toEqual({
      cli: 'claude',
      scope: 'user',
      action: 'install',
    });
    expect(
      coerceInstallRequest({
        cli: 'codex',
        scope: 'project',
        action: 'replace',
        projectPath: '/p',
      }),
    ).toEqual({ cli: 'codex', scope: 'project', action: 'replace', projectPath: '/p' });
    expect(
      coerceInstallRequest({
        cli: 'claude',
        scope: 'project',
        action: 'remove',
        projectPath: '/p',
        entryScope: 'local',
      }),
    ).toEqual({
      cli: 'claude',
      scope: 'project',
      action: 'remove',
      projectPath: '/p',
      entryScope: 'local',
    });
    expect(coerceInstallRequest({ cli: 'opencode', scope: 'user', action: 'uninstall' })).toEqual({
      cli: 'opencode',
      scope: 'user',
      action: 'uninstall',
    });

    expect(coerceInstallRequest({ cli: 'gemini', scope: 'user', action: 'install' })).toBeNull();
    expect(coerceInstallRequest({ cli: 'claude', scope: 'global', action: 'install' })).toBeNull();
    expect(coerceInstallRequest({ cli: 'claude', scope: 'user', action: 'nuke' })).toBeNull();
    expect(
      coerceInstallRequest({ cli: 'claude', scope: 'project', action: 'install', projectPath: 3 }),
    ).toBeNull();
    expect(
      coerceInstallRequest({
        cli: 'claude',
        scope: 'project',
        action: 'remove',
        projectPath: '/p',
      }),
    ).toBeNull();
    expect(
      coerceInstallRequest({
        cli: 'claude',
        scope: 'project',
        action: 'remove',
        projectPath: '/p',
        entryScope: 'x',
      }),
    ).toBeNull();
    for (const v of [null, 'x', [], undefined]) expect(coerceInstallRequest(v)).toBeNull();
  });

  it('needsSetup: true iff some found CLI is not-installed', () => {
    const base = [
      cli('claude', true, 'installed'),
      cli('codex', false, 'not-installed'),
      cli('cursor', false, 'not-found'),
      cli('opencode', true, 'conflict'),
    ];
    expect(needsSetup({ clis: base })).toBe(false);
    expect(
      needsSetup({ clis: [...base.slice(0, 3), cli('opencode', true, 'not-installed')] }),
    ).toBe(true);
  });

  it('ConfigFormatError carries its code', () => {
    const e = new ConfigFormatError('EGUARD', 'm');
    expect(e.code).toBe('EGUARD');
    expect(e.message).toBe('m');
    expect(e).toBeInstanceOf(Error);
  });
});
