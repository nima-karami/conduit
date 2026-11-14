import { describe, expect, it } from 'vitest';
import {
  assignmentFor,
  decide,
  matchesScope,
  reasonText,
  visibleTools,
} from '../../src/conduit-mcp/policy-engine';
import { profileById } from '../../src/conduit-mcp/policy-profiles';
import type {
  Assignment,
  Capability,
  Exception,
  Grant,
  OneUseOverride,
  PolicyInput,
  PolicyState,
  PolicyTarget,
  Principal,
  ProfileId,
  Reason,
} from '../../src/conduit-mcp/policy-types';
import { TOOL_NAMES, type ToolName } from '../../src/conduit-mcp/tool-policy';

const NOW = Date.parse('2026-11-14T12:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();
const ALL_CAPS: readonly Capability[] = ['messaging', 'monitor', 'drive', 'orchestrate'];

const session = (over: Partial<Extract<Principal, { kind: 'session' }>> = {}): Principal => ({
  kind: 'session',
  sessionId: 's1',
  handle: 'claude-1',
  launchedCli: null,
  homeFolder: '/work/app',
  projectId: 'p1',
  ...over,
});
const remote = (capabilities: readonly Capability[] = ALL_CAPS): Principal => ({
  kind: 'remote',
  handle: 'x@m2',
  machineId: 'm2',
  remoteSessionId: 'r1',
  trust: 'own',
  capabilities,
});
const target = (over: Partial<PolicyTarget> = {}): PolicyTarget => ({
  sessionId: null,
  path: null,
  projectId: null,
  ...over,
});
const assignment = (
  profileId: ProfileId,
  exceptions: Exception[] = [],
  onScreenOnly = false,
): Assignment => ({
  profileId,
  exceptions,
  onScreenOnly,
});
const state = (
  assignments: Record<string, Assignment>,
  over: Partial<PolicyState> = {},
): PolicyState => ({
  profiles: [],
  assignments: new Map(Object.entries(assignments)),
  grants: [],
  overrides: [],
  ...over,
});
const grant = (over: Partial<Grant> = {}): Grant => ({
  id: 'g1',
  who: { kind: 'session', sessionId: 's1' },
  tool: 'open_session',
  on: { kind: 'anywhere' },
  for: '1h',
  anchorSessionId: null,
  createdAt: iso(NOW),
  expiresAt: iso(NOW + 3_600_000),
  lastUsedAt: null,
  state: 'active',
  endedAt: null,
  requestId: null,
  ...over,
});
const input = (over: Partial<PolicyInput> = {}): PolicyInput => ({
  principal: session(),
  tool: 'send_message',
  targets: [],
  masterOn: true,
  toYou: false,
  now: NOW,
  ...over,
});
const names = {
  profileName: (id: ProfileId) => profileById(state({}), id)?.name ?? id,
  cliName: (k: string) => k,
};
const worker = { default: assignment('worker') };
const except = (tool: ToolName, scope: Exception['scope'], rule: Exception['rule']): Exception => ({
  tool,
  scope,
  rule,
});

describe('decide', () => {
  it('worker equals today: session open_session asks', () => {
    const d = decide(state(worker), input({ tool: 'open_session' }));
    expect(d.decision).toBe('ask');
    expect(d.reason).toEqual({ by: 'profile', point: { kind: 'default' }, profileId: 'worker' });
  });

  it('lead allows open_terminal off screen (POL-D3/D4)', () => {
    const d = decide(state({ default: assignment('lead') }), input({ tool: 'open_terminal' }));
    expect(d.decision).toBe('allow');
    expect(d.rule.when).toBe('always');
  });

  it('master off denies everything with floor master-off', () => {
    for (const tool of TOOL_NAMES.filter((t) => t !== 'list_agents')) {
      const d = decide(state(worker), input({ tool, masterOn: false }));
      expect(d.decision, tool).toBe('deny');
      expect(d.reason).toEqual({ by: 'floor', floor: 'master-off' });
    }
  });

  it('master off keeps list_agents', () => {
    const d = decide(state(worker), input({ tool: 'list_agents', masterOn: false }));
    expect(d.decision).toBe('allow');
  });

  it('local to-you send_message passes an observer deny (floor c)', () => {
    const s = state({
      default: assignment('observer', [
        except('send_message', { kind: 'anywhere' }, { decision: 'deny' }),
      ]),
    });
    expect(decide(s, input({ tool: 'send_message', toYou: true }))).toMatchObject({
      decision: 'allow',
      reason: { by: 'floor', floor: 'local-to-you' },
    });
    expect(decide(s, input({ tool: 'send_message', toYou: false })).decision).toBe('deny');
  });

  it('explicit deny beats a matching grant', () => {
    const s = state(worker, {
      grants: [grant()],
      assignments: new Map([
        [
          'default',
          assignment('worker', [
            except('open_session', { kind: 'anywhere' }, { decision: 'deny' }),
          ]),
        ],
      ]),
    });
    const d = decide(s, input({ tool: 'open_session' }));
    expect(d.decision).toBe('deny');
    expect(d.reason).toEqual({ by: 'deny', point: { kind: 'default' } });
    expect(d.grantId).toBeNull();
  });

  it('one-use override passes a deny once for its exact target', () => {
    const override: OneUseOverride = {
      id: 'o1',
      sessionId: 's1',
      tool: 'open_session',
      target: target({ sessionId: 's2' }),
      createdAt: iso(NOW),
    };
    const s = state(
      {
        default: assignment('worker', [
          except('open_session', { kind: 'anywhere' }, { decision: 'deny' }),
        ]),
      },
      { overrides: [override] },
    );
    const passed = decide(
      s,
      input({ tool: 'open_session', targets: [target({ sessionId: 's2' })] }),
    );
    expect(passed.decision).toBe('allow');
    expect(passed.reason).toEqual({ by: 'override', overrideId: 'o1' });
    expect(passed.overrideId).toBe('o1');
    expect(
      decide(s, input({ tool: 'open_session', targets: [target({ sessionId: 's3' })] })).decision,
    ).toBe('deny');
    expect(
      decide(
        s,
        input({
          tool: 'open_session',
          principal: session({ sessionId: 's9' }),
          targets: [target({ sessionId: 's2' })],
        }),
      ).decision,
    ).toBe('deny');
  });

  it('override never passes a floor', () => {
    const override: OneUseOverride = {
      id: 'o1',
      sessionId: 's1',
      tool: 'open_session',
      target: target({ sessionId: 's2' }),
      createdAt: iso(NOW),
    };
    const s = state(
      {
        default: assignment('worker', [
          except('open_session', { kind: 'anywhere' }, { decision: 'deny' }),
        ]),
      },
      { overrides: [override] },
    );
    const d = decide(
      s,
      input({ tool: 'open_session', masterOn: false, targets: [target({ sessionId: 's2' })] }),
    );
    expect(d.decision).toBe('deny');
    expect(d.reason).toEqual({ by: 'floor', floor: 'master-off' });
  });

  it('grant beats assignment ask', () => {
    const d = decide(state(worker, { grants: [grant()] }), input({ tool: 'open_session' }));
    expect(d.decision).toBe('allow');
    expect(d.reason).toEqual({ by: 'grant', grantId: 'g1' });
    expect(d.grantId).toBe('g1');
  });

  it('grant beats a profile deny, because only an exception is explicit', () => {
    const d = decide(
      state({ default: assignment('observer') }, { grants: [grant()] }),
      input({ tool: 'open_session' }),
    );
    expect(d.decision).toBe('allow');
    expect(d.reason).toEqual({ by: 'grant', grantId: 'g1' });
  });

  it('a cli grant applies only to a session launched by that cli', () => {
    const g = grant({ id: 'g2', who: { kind: 'cli', cli: 'claude' } });
    const launched = decide(
      state(worker, { grants: [g] }),
      input({ tool: 'open_session', principal: session({ launchedCli: 'claude' }) }),
    );
    expect(launched.reason).toEqual({ by: 'grant', grantId: 'g2' });
    expect(decide(state(worker, { grants: [g] }), input({ tool: 'open_session' })).decision).toBe(
      'ask',
    );
  });

  it('suspended or expired grant is ignored', () => {
    const suspended = decide(
      state(worker, { grants: [grant({ state: 'suspended' })] }),
      input({ tool: 'open_session' }),
    );
    expect(suspended.decision).toBe('ask');
    expect(suspended.grantId).toBeNull();
    const expired = decide(
      state(worker, { grants: [grant({ expiresAt: iso(NOW - 1) })] }),
      input({ tool: 'open_session' }),
    );
    expect(expired.decision).toBe('ask');
    expect(expired.grantId).toBeNull();
  });

  it('session assignment beats kind beats default', () => {
    const p = session({ launchedCli: 'claude' });
    const all = {
      default: assignment('observer'),
      'cli:claude': assignment('lead'),
      'session:s1': assignment('worker'),
    };
    const own = decide(state(all), input({ tool: 'open_session', principal: p }));
    expect(own.decision).toBe('ask');
    expect(own.reason).toEqual({
      by: 'profile',
      point: { kind: 'session', sessionId: 's1' },
      profileId: 'worker',
    });
    const kind = decide(
      state({ default: all.default, 'cli:claude': all['cli:claude'] }),
      input({ tool: 'open_session', principal: p }),
    );
    expect(kind.decision).toBe('allow');
    expect(kind.reason).toEqual({
      by: 'profile',
      point: { kind: 'cli', cli: 'claude' },
      profileId: 'lead',
    });
    expect(
      decide(state({ default: all.default }), input({ tool: 'open_session', principal: p }))
        .decision,
    ).toBe('deny');
  });

  it('kind assignment ignored when launchedCli is null', () => {
    const s = state({ default: assignment('observer'), 'cli:claude': assignment('lead') });
    expect(assignmentFor(s, session({ launchedCli: null })).point).toEqual({ kind: 'default' });
    expect(decide(s, input({ tool: 'open_session' })).decision).toBe('deny');
  });

  it('narrower scope wins; exact tie goes stricter', () => {
    const folders = state({
      default: assignment('worker', [
        except('open_session', { kind: 'anywhere' }, { decision: 'deny' }),
        except('open_session', { kind: 'folder', path: '/work' }, { decision: 'allow' }),
      ]),
    });
    expect(
      decide(folders, input({ tool: 'open_session', targets: [target({ path: '/work/x' })] }))
        .decision,
    ).toBe('allow');
    expect(
      decide(folders, input({ tool: 'open_session', targets: [target({ path: '/elsewhere' })] }))
        .decision,
    ).toBe('deny');

    const nested = state({
      default: assignment('worker', [
        except('open_session', { kind: 'folder', path: '/work' }, { decision: 'allow' }),
        except('open_session', { kind: 'folder', path: '/work/app' }, { decision: 'deny' }),
      ]),
    });
    expect(
      decide(nested, input({ tool: 'open_session', targets: [target({ path: '/work/app/src' })] }))
        .decision,
    ).toBe('deny');

    const tie = state({
      default: assignment('worker', [
        except('open_session', { kind: 'folder', path: '/work' }, { decision: 'allow' }),
        except('open_session', { kind: 'folder', path: '/work' }, { decision: 'ask' }),
      ]),
    });
    expect(
      decide(tie, input({ tool: 'open_session', targets: [target({ path: '/work/x' })] })).decision,
    ).toBe('ask');
  });

  it('multi-target takes strictest', () => {
    const s = state({
      default: assignment('worker', [
        except('open_session', { kind: 'folder', path: '/work/app' }, { decision: 'allow' }),
      ]),
    });
    const d = decide(
      s,
      input({
        tool: 'open_session',
        targets: [target({ path: '/work/app/a' }), target({ path: '/elsewhere' })],
      }),
    );
    expect(d.decision).toBe('ask');
    expect(d.reason).toEqual({ by: 'profile', point: { kind: 'default' }, profileId: 'worker' });
  });

  it('remote own peer with no assignment asks on orchestrate and never applies when', () => {
    const r = remote();
    const s = state({});
    for (const tool of [
      'open_session',
      'open_terminal',
      'send_input',
      'close_session',
      'attach_folder',
    ] as const) {
      const d = decide(s, input({ principal: r, tool }));
      expect(d.decision, tool).toBe('ask');
      expect(d.rule.when, tool).toBe('always');
      expect(d.reason).toEqual({
        by: 'exception',
        point: { kind: 'peer', machineId: 'm2' },
        profileId: 'worker',
      });
    }
    expect(decide(s, input({ principal: r, tool: 'close_session' })).rule.reach).toBe('opened');
  });

  it('remote principal without the capability is denied with floor remote-capability', () => {
    const r = remote(['messaging']);
    expect(decide(state(worker), input({ principal: r, tool: 'open_session' }))).toMatchObject({
      decision: 'deny',
      reason: { by: 'floor', floor: 'remote-capability' },
    });
    expect(decide(state(worker), input({ principal: r, tool: 'send_message' })).decision).toBe(
      'allow',
    );
  });

  it('onScreenOnly forces viewing', () => {
    const s = state({ default: assignment('lead', [], true) });
    const d = decide(s, input({ tool: 'read_screen' }));
    expect(d.rule.when).toBe('viewing');
    expect(decide(s, input({ tool: 'send_message' })).rule.when).toBeNull();
  });

  it('no-target action matches home folder scope', () => {
    const inFolder = decide(
      state(worker, { grants: [grant({ on: { kind: 'folder', path: '/work/app' } })] }),
      input({ tool: 'open_session' }),
    );
    expect(inFolder.decision).toBe('allow');
    expect(inFolder.reason).toEqual({ by: 'grant', grantId: 'g1' });
    const elsewhere = decide(
      state(worker, { grants: [grant({ on: { kind: 'folder', path: '/other' } })] }),
      input({ tool: 'open_session' }),
    );
    expect(elsewhere.decision).toBe('ask');
    expect(matchesScope({ kind: 'folder', path: '/work/app' }, target(), session())).toBe(true);
    expect(matchesScope({ kind: 'folder', path: '/work/app' }, target(), remote())).toBe(false);
  });

  it('folder scope respects the separator boundary', () => {
    const p = session();
    expect(matchesScope({ kind: 'folder', path: '/a/b' }, target({ path: '/a/bc' }), p)).toBe(
      false,
    );
    expect(matchesScope({ kind: 'folder', path: '/a/b' }, target({ path: '/a/b/c' }), p)).toBe(
      true,
    );
    expect(matchesScope({ kind: 'folder', path: '/a/b' }, target({ path: '/a/b' }), p)).toBe(true);
    expect(
      matchesScope(
        { kind: 'folder', path: 'C:/work/app' },
        target({ path: 'C:\\work\\app\\src' }),
        p,
      ),
    ).toBe(true);
    expect(matchesScope({ kind: 'path', path: '/a/b' }, target({ path: '/a/b/c' }), p)).toBe(false);
    expect(matchesScope({ kind: 'session', sessionId: 's2' }, target({ sessionId: 's2' }), p)).toBe(
      true,
    );
    expect(matchesScope({ kind: 'space', projectId: 'p1' }, target({ projectId: 'p1' }), p)).toBe(
      true,
    );
    expect(matchesScope({ kind: 'space', projectId: 'p1' }, target({ projectId: 'p2' }), p)).toBe(
      false,
    );
  });

  it('every decision has exactly one reason', () => {
    const scenarios: PolicyInput[] = [];
    const reasonKeys = new Set(['floor', 'deny', 'override', 'grant', 'exception', 'profile']);
    const s = state(
      {
        default: assignment('worker', [
          except('read_screen', { kind: 'anywhere' }, { decision: 'deny' }),
        ]),
      },
      { grants: [grant()] },
    );
    for (const tool of TOOL_NAMES) {
      scenarios.push(
        input({ tool }),
        input({ tool, masterOn: false }),
        input({ tool, principal: remote(['messaging']) }),
      );
    }
    for (const sc of scenarios) {
      const d = decide(s, sc);
      expect(reasonKeys.has(d.reason.by), sc.tool).toBe(true);
      expect(d.grantId === null || d.reason.by === 'grant', sc.tool).toBe(true);
      expect(d.overrideId === null || d.reason.by === 'override', sc.tool).toBe(true);
    }
  });
});

describe('visibleTools', () => {
  it('hides unconditional denies only', () => {
    const visible = visibleTools(state(worker), session(), true);
    expect(visible).toContain('open_session');
    expect(visible).not.toContain('open_terminal');
    const scoped = visibleTools(
      state({
        default: assignment('worker', [
          except('read_screen', { kind: 'folder', path: '/x' }, { decision: 'deny' }),
        ]),
      }),
      session(),
      true,
    );
    expect(scoped).toContain('read_screen');
    const anywhere = visibleTools(
      state({
        default: assignment('worker', [
          except('read_screen', { kind: 'anywhere' }, { decision: 'deny' }),
        ]),
      }),
      session(),
      true,
    );
    expect(anywhere).not.toContain('read_screen');
    expect(visibleTools(state(worker), session(), false)).toEqual(['list_agents']);
  });
});

describe('reasonText', () => {
  it('reads "allowed by Lead (session)" and "Ask: Worker (default for codex)"', () => {
    const lead: Reason = {
      by: 'profile',
      point: { kind: 'session', sessionId: 's1' },
      profileId: 'lead',
    };
    expect(reasonText(lead, 'allow', names)).toBe('allowed by Lead (session)');
    const codex: Reason = {
      by: 'profile',
      point: { kind: 'cli', cli: 'codex' },
      profileId: 'worker',
    };
    expect(reasonText(codex, 'ask', { ...names, cliName: () => 'codex' })).toBe(
      'Ask: Worker (default for codex)',
    );
  });

  it('marks exception reasons and fixed floor, grant and override texts', () => {
    const exc: Reason = {
      by: 'exception',
      point: { kind: 'session', sessionId: 's1' },
      profileId: 'worker',
    };
    expect(reasonText(exc, 'ask', names)).toBe('Ask: Worker +exception (session)');
    expect(reasonText({ by: 'floor', floor: 'master-off' }, 'deny', names)).toBe(
      'Conduit tools are off',
    );
    expect(reasonText({ by: 'floor', floor: 'remote-capability' }, 'deny', names)).toBe(
      'not allowed on this link',
    );
    expect(reasonText({ by: 'floor', floor: 'local-to-you' }, 'allow', names)).toBe(
      'always allowed to you',
    );
    expect(reasonText({ by: 'grant', grantId: 'g1' }, 'allow', names)).toBe('allowed by grant');
    expect(reasonText({ by: 'override', overrideId: 'o1' }, 'allow', names)).toBe('allowed once');
    expect(
      reasonText({ by: 'deny', point: { kind: 'peer', machineId: 'm2' } }, 'deny', names),
    ).toBe('denied by exception (machine)');
  });
});
