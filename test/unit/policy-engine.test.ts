import { describe, expect, it } from 'vitest';
import {
  assignmentFor,
  decide,
  reasonText,
  visibleTools,
} from '../../src/conduit-mcp/policy-engine';
import {
  BUILT_IN_PROFILES,
  matchesScope,
  profileById,
  WORKER_PROFILE,
} from '../../src/conduit-mcp/policy-profiles';
import type {
  Assignment,
  Exception,
  Grant,
  OneUseOverride,
  PolicyInput,
  PolicyState,
  PolicyTarget,
  Principal,
  Profile,
  ProfileId,
  Reason,
} from '../../src/conduit-mcp/policy-types';
import { TOOL_NAMES, type ToolName } from '../../src/conduit-mcp/tool-policy';
import { type Capabilities, principalAddress } from '../../src/contracts/remote-principal';

const NOW = Date.parse('2026-11-14T12:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();
const ALL_CAPS: Capabilities = { messaging: true, monitor: true, drive: true };

const session = (over: Partial<Extract<Principal, { kind: 'session' }>> = {}): Principal => ({
  kind: 'session',
  sessionId: 's1',
  handle: 'claude-1',
  launchedCli: null,
  homeFolder: '/work/app',
  projectId: 'p1',
  ...over,
});
const remote = (capabilities: Capabilities = ALL_CAPS, controller = false): Principal => ({
  kind: 'remote',
  handle: 'claude-3',
  machineId: 'm-0000000a',
  trust: 'own',
  controller,
  capabilities,
});
const target = (over: Partial<PolicyTarget> = {}): PolicyTarget => ({
  sessionId: null,
  path: null,
  folder: null,
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
  sessionDenials: [],
  failClosed: false,
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

  it('local to-you send_message passes an explicit deny (floor c)', () => {
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

  it('a held override passes an explicit deny for this one decision', () => {
    const held: OneUseOverride = {
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
      { overrides: [] },
    );
    const passed = decide(
      s,
      input({
        tool: 'open_session',
        targets: [target({ sessionId: 's2' })],
        heldOverrides: [held],
      }),
    );
    expect(passed.decision).toBe('allow');
    expect(passed.reason).toEqual({ by: 'override', overrideId: 'o1' });
    expect(passed.overrideIds).toEqual(['o1']);
    expect(
      decide(s, input({ tool: 'open_session', targets: [target({ sessionId: 's2' })] })).decision,
    ).toBe('deny');
  });

  it('a held override wins over a saved one for the same target', () => {
    const held: OneUseOverride = {
      id: 'o1',
      sessionId: 's1',
      tool: 'open_session',
      target: target({ sessionId: 's2' }),
      createdAt: iso(NOW),
    };
    const saved: OneUseOverride = { ...held, id: 'o2' };
    const s = state(
      {
        default: assignment('worker', [
          except('open_session', { kind: 'anywhere' }, { decision: 'deny' }),
        ]),
      },
      { overrides: [saved] },
    );
    const d = decide(
      s,
      input({
        tool: 'open_session',
        targets: [target({ sessionId: 's2' })],
        heldOverrides: [held],
      }),
    );
    expect(d.overrideIds).toEqual(['o1']);
    expect(d.reason).toEqual({ by: 'override', overrideId: 'o1' });
  });

  it('a held override for another session does not pass the deny', () => {
    const held: OneUseOverride = {
      id: 'o1',
      sessionId: 's9',
      tool: 'open_session',
      target: target({ sessionId: 's2' }),
      createdAt: iso(NOW),
    };
    const s = state({
      default: assignment('worker', [
        except('open_session', { kind: 'anywhere' }, { decision: 'deny' }),
      ]),
    });
    const d = decide(
      s,
      input({
        tool: 'open_session',
        targets: [target({ sessionId: 's2' })],
        heldOverrides: [held],
      }),
    );
    expect(d.decision).toBe('deny');
    expect(d.overrideIds).toEqual([]);
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
      decide(folders, input({ tool: 'open_session', targets: [target({ folder: '/work/x' })] }))
        .decision,
    ).toBe('allow');
    expect(
      decide(folders, input({ tool: 'open_session', targets: [target({ folder: '/elsewhere' })] }))
        .decision,
    ).toBe('deny');

    const nested = state({
      default: assignment('worker', [
        except('open_session', { kind: 'folder', path: '/work' }, { decision: 'allow' }),
        except('open_session', { kind: 'folder', path: '/work/app' }, { decision: 'deny' }),
      ]),
    });
    expect(
      decide(
        nested,
        input({ tool: 'open_session', targets: [target({ folder: '/work/app/src' })] }),
      ).decision,
    ).toBe('deny');

    const tie = state({
      default: assignment('worker', [
        except('open_session', { kind: 'folder', path: '/work' }, { decision: 'allow' }),
        except('open_session', { kind: 'folder', path: '/work' }, { decision: 'ask' }),
      ]),
    });
    expect(
      decide(tie, input({ tool: 'open_session', targets: [target({ folder: '/work/x' })] }))
        .decision,
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
        targets: [target({ folder: '/work/app/a' }), target({ folder: '/elsewhere' })],
      }),
    );
    expect(d.decision).toBe('ask');
    expect(d.reason).toEqual({ by: 'profile', point: { kind: 'default' }, profileId: 'worker' });
  });

  it('remote own peer with no assignment asks on attach_folder and never applies when', () => {
    const r = remote();
    const s = state({});
    const d = decide(s, input({ principal: r, tool: 'attach_folder' }));
    expect(d.decision).toBe('ask');
    expect(d.rule.when).toBe('always');
    expect(d.reason).toEqual({
      by: 'profile',
      point: { kind: 'peer', machineId: 'm-0000000a' },
      profileId: 'worker',
    });
    expect(decide(s, input({ principal: r, tool: 'focus_session' })).rule.reach).toBe('opened');
  });

  it('own peer default asks exactly on the NET orchestrate set', () => {
    const own = assignmentFor(state({}), remote()).assignment;
    expect(own.exceptions.map((e) => e.tool)).toEqual([
      'open_session',
      'open_terminal',
      'close_session',
      'send_input',
      'read_screen',
    ]);
    expect(own.exceptions.every((e) => e.rule.decision === 'ask')).toBe(true);
  });

  it('remote principal: orchestrate tools always denied, drive tool denied when drive is false, messaging allowed when true', () => {
    for (const tool of [
      'open_session',
      'open_terminal',
      'close_session',
      'send_input',
      'read_screen',
    ] as const) {
      expect(decide(state(worker), input({ principal: remote(), tool })), tool).toMatchObject({
        decision: 'deny',
        reason: { by: 'floor', floor: 'remote-capability' },
      });
    }
    const noDrive = remote({ messaging: true, monitor: true, drive: false });
    expect(decide(state(worker), input({ principal: noDrive, tool: 'open_file' })).reason).toEqual({
      by: 'floor',
      floor: 'remote-capability',
    });
    expect(decide(state(worker), input({ principal: remote(), tool: 'open_file' })).decision).toBe(
      'allow',
    );
    expect(
      decide(
        state(worker),
        input({
          principal: remote({ messaging: true, monitor: false, drive: false }),
          tool: 'send_message',
        }),
      ).decision,
    ).toBe('allow');
    expect(
      decide(
        state(worker),
        input({
          principal: remote({ messaging: false, monitor: true, drive: true }),
          tool: 'send_message',
        }),
      ).reason,
    ).toEqual({ by: 'floor', floor: 'remote-capability' });
  });

  it('remote principal without the capability is denied with floor remote-capability', () => {
    const r = remote({ messaging: true, monitor: false, drive: false });
    expect(decide(state(worker), input({ principal: r, tool: 'list_agents' }))).toMatchObject({
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
  });

  it('no-target action applies a home-folder folder exception', () => {
    const home = state({
      default: assignment('worker', [
        except('open_session', { kind: 'folder', path: '/work/app' }, { decision: 'deny' }),
      ]),
    });
    expect(decide(home, input({ tool: 'open_session' })).reason).toEqual({
      by: 'deny',
      point: { kind: 'default' },
    });
    const elsewhere = state({
      default: assignment('worker', [
        except('open_session', { kind: 'folder', path: '/other' }, { decision: 'deny' }),
      ]),
    });
    expect(decide(elsewhere, input({ tool: 'open_session' })).decision).toBe('ask');
  });

  it('no-target action matches a space exception via the principal projectId', () => {
    const s = state({
      default: assignment('worker', [
        except('open_session', { kind: 'space', projectId: 'p1' }, { decision: 'deny' }),
      ]),
    });
    expect(decide(s, input({ tool: 'open_session' })).decision).toBe('deny');
    expect(
      decide(s, input({ tool: 'open_session', principal: session({ projectId: 'p2' }) })).decision,
    ).toBe('ask');
  });

  it('remote address is handle@machineId', () => {
    expect(
      principalAddress({
        kind: 'remote',
        handle: 'claude-3',
        machineId: 'm-0000000a',
        trust: 'own',
        controller: false,
      }),
    ).toBe('claude-3@m-0000000a');
  });

  it('folder scope respects the separator boundary', () => {
    expect(matchesScope({ kind: 'folder', path: '/a/b' }, target({ folder: '/a/bc' }))).toBe(false);
    expect(matchesScope({ kind: 'folder', path: '/a/b' }, target({ folder: '/a/b/c' }))).toBe(true);
    expect(matchesScope({ kind: 'folder', path: '/a/b' }, target({ folder: '/a/b' }))).toBe(true);
    expect(
      matchesScope(
        { kind: 'folder', path: 'C:/work/app' },
        target({ folder: 'C:\\work\\app\\src' }),
      ),
    ).toBe(true);
    expect(
      matchesScope({ kind: 'folder', path: 'C:\\Work' }, target({ folder: 'c:/work/app' })),
    ).toBe(true);
    expect(
      matchesScope({ kind: 'folder', path: 'C:\\Work' }, target({ folder: 'c:/workapp' })),
    ).toBe(false);
    expect(matchesScope({ kind: 'path', path: '/a/b' }, target({ path: '/a/b/c' }))).toBe(false);
    expect(matchesScope({ kind: 'session', sessionId: 's2' }, target({ sessionId: 's2' }))).toBe(
      true,
    );
    expect(matchesScope({ kind: 'space', projectId: 'p1' }, target({ projectId: 'p1' }))).toBe(
      true,
    );
    expect(matchesScope({ kind: 'space', projectId: 'p1' }, target({ projectId: 'p2' }))).toBe(
      false,
    );
  });

  it('a drive-root folder scope covers paths on that drive', () => {
    expect(matchesScope({ kind: 'folder', path: 'C:\\' }, target({ folder: 'c:\\work' }))).toBe(
      true,
    );
    expect(matchesScope({ kind: 'folder', path: 'C:\\' }, target({ folder: 'd:\\work' }))).toBe(
      false,
    );
  });

  it('a posix root folder scope covers every absolute path', () => {
    expect(matchesScope({ kind: 'folder', path: '/' }, target({ folder: '/work' }))).toBe(true);
    expect(matchesScope({ kind: 'folder', path: '/' }, target({ folder: '/' }))).toBe(true);
    expect(matchesScope({ kind: 'folder', path: '/' }, target({ folder: 'c:/work' }))).toBe(false);
  });

  it('deny + override + grant reports the override', () => {
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
      { overrides: [override], grants: [grant()] },
    );
    const d = decide(s, input({ tool: 'open_session', targets: [target({ sessionId: 's2' })] }));
    expect(d.decision).toBe('allow');
    expect(d.reason).toEqual({ by: 'override', overrideId: 'o1' });
    expect(d.overrideId).toBe('o1');
    expect(d.grantId).toBeNull();
  });

  it('two session targets with one grant each are allowed', () => {
    const grants = ['s2', 's3'].map((sid) =>
      grant({ id: `g-${sid}`, on: { kind: 'session', sessionId: sid } }),
    );
    const d = decide(
      state(worker, { grants }),
      input({
        tool: 'open_session',
        targets: [target({ sessionId: 's2' }), target({ sessionId: 's3' })],
      }),
    );
    expect(d.decision).toBe('allow');
    expect(d.reason).toEqual({ by: 'grant', grantId: 'g-s2' });
    expect(d.grantId).toBe('g-s2');
  });

  it('grantIds lists every grant that allowed a target', () => {
    const two = ['s2', 's3'].map((sid) =>
      grant({ id: `g-${sid}`, on: { kind: 'session', sessionId: sid } }),
    );
    const both = input({
      tool: 'open_session',
      targets: [target({ sessionId: 's2' }), target({ sessionId: 's3' })],
    });
    const each = decide(state(worker, { grants: two }), both);
    expect(each.grantIds).toEqual(['g-s2', 'g-s3']);
    expect(each.grantId).toBe('g-s2');

    const anywhere = decide(state(worker, { grants: [grant({ id: 'g-all' })] }), both);
    expect(anywhere.grantIds).toEqual(['g-all']);

    const asks = decide(
      state(worker, { grants: [grant({ id: 'g-s2', on: { kind: 'session', sessionId: 's2' } })] }),
      both,
    );
    expect(asks.decision).toBe('ask');
    expect(asks.grantIds).toEqual([]);
    expect(asks.grantId).toBeNull();
  });

  it('deniedTarget is the target the explicit deny matched', () => {
    const folderDeny = except('open_file', { kind: 'folder', path: '/w/b' }, { decision: 'deny' });
    const d = decide(
      state({ default: assignment('worker', [folderDeny]) }),
      input({
        tool: 'open_file',
        targets: [
          target({ path: '/w/a/x.ts', folder: '/w/a' }),
          target({ path: '/w/b/y.ts', folder: '/w/b' }),
        ],
      }),
    );
    expect(d.reason.by).toBe('deny');
    expect(d.deniedTarget?.path).toBe('/w/b/y.ts');
    expect(decide(state({}), input({ tool: 'list_sessions' })).deniedTarget).toBeNull();
  });

  it('a granted target plus an assignment-allowed target is allowed', () => {
    const s = state(
      {
        default: assignment('worker', [
          except('open_session', { kind: 'folder', path: '/other' }, { decision: 'allow' }),
        ]),
      },
      { grants: [grant({ on: { kind: 'session', sessionId: 's2' } })] },
    );
    const d = decide(
      s,
      input({
        tool: 'open_session',
        targets: [target({ sessionId: 's2' }), target({ folder: '/other' })],
      }),
    );
    expect(d.decision).toBe('allow');
    expect(d.reason).toEqual({ by: 'grant', grantId: 'g1' });
  });

  it('a granted target plus an asking target still asks', () => {
    const d = decide(
      state(worker, { grants: [grant({ on: { kind: 'session', sessionId: 's2' } })] }),
      input({
        tool: 'open_session',
        targets: [target({ sessionId: 's2' }), target({ sessionId: 's3' })],
      }),
    );
    expect(d.decision).toBe('ask');
    expect(d.reason).toEqual({ by: 'profile', point: { kind: 'default' }, profileId: 'worker' });
    expect(d.grantId).toBeNull();
  });

  it('a peer grant passes for its remote principal and not for a local session', () => {
    const peerGrant = grant({
      id: 'gp',
      who: { kind: 'peer', machineId: 'm-0000000a' },
      tool: 'attach_folder',
    });
    const r = remote({ messaging: false, monitor: false, drive: true });
    const withGrant = decide(
      state(worker, { grants: [peerGrant] }),
      input({ principal: r, tool: 'attach_folder' }),
    );
    expect(withGrant.decision).toBe('allow');
    expect(withGrant.reason).toEqual({ by: 'grant', grantId: 'gp' });
    expect(
      decide(state(worker, { grants: [peerGrant] }), input({ tool: 'attach_folder' })).decision,
    ).toBe('ask');
  });

  it('a denied target with no matching override keeps the call denied', () => {
    const overrides: OneUseOverride[] = [
      {
        id: 'o-s2',
        sessionId: 's1',
        tool: 'open_session',
        target: target({ sessionId: 's2' }),
        createdAt: iso(NOW),
      },
    ];
    const s = state(
      {
        default: assignment('worker', [
          except('open_session', { kind: 'anywhere' }, { decision: 'deny' }),
        ]),
      },
      { overrides },
    );
    const d = decide(
      s,
      input({
        tool: 'open_session',
        targets: [target({ sessionId: 's2' }), target({ sessionId: 's3' })],
      }),
    );
    expect(d.decision).toBe('deny');
    expect(d.overrideIds).toEqual([]);
    expect(d.deniedTarget?.sessionId).toBe('s3');
    expect(d.reason).toEqual({ by: 'deny', point: { kind: 'default' } });
  });

  it('two denied targets each pass with their own override', () => {
    const folderDeny = (path: string) =>
      except('open_file', { kind: 'folder', path }, { decision: 'deny' });
    const override = (id: string, path: string): OneUseOverride => ({
      id,
      sessionId: 's1',
      tool: 'open_file',
      target: target({ path, folder: path.replace(/\/[^/]+$/, '') }),
      createdAt: iso(NOW),
    });
    const s = state(
      { default: assignment('worker', [folderDeny('/w/a'), folderDeny('/w/b')]) },
      { overrides: [override('oa', '/w/a/x.ts'), override('ob', '/w/b/y.ts')] },
    );
    const d = decide(
      s,
      input({
        tool: 'open_file',
        targets: [
          target({ path: '/w/a/x.ts', folder: '/w/a' }),
          target({ path: '/w/b/y.ts', folder: '/w/b' }),
        ],
      }),
    );
    expect(d.decision).toBe('allow');
    expect(d.overrideIds).toEqual(['oa', 'ob']);
    expect(d.reason).toEqual({ by: 'override', overrideId: 'oa' });
  });

  it('keeps a passed override when another target is denied by the profile', () => {
    const s = state(
      {
        default: assignment('observer', [
          except('open_file', { kind: 'folder', path: '/w/a' }, { decision: 'deny' }),
        ]),
      },
      {
        overrides: [
          {
            id: 'oa',
            sessionId: 's1',
            tool: 'open_file',
            target: target({ path: '/w/a/x.ts', folder: '/w/a' }),
            createdAt: iso(NOW),
          },
        ],
      },
    );
    const d = decide(
      s,
      input({
        tool: 'open_file',
        targets: [
          target({ path: '/w/a/x.ts', folder: '/w/a' }),
          target({ path: '/w/b/y.ts', folder: '/w/b' }),
        ],
      }),
    );
    expect(d.decision).toBe('deny');
    expect(d.overrideIds).toEqual([]);
  });

  it('reports the override when another target asks', () => {
    const s = state(
      {
        default: assignment('worker', [
          except('open_file', { kind: 'folder', path: '/w/a' }, { decision: 'deny' }),
          except('open_file', { kind: 'folder', path: '/w/b' }, { decision: 'ask' }),
        ]),
      },
      {
        overrides: [
          {
            id: 'oa',
            sessionId: 's1',
            tool: 'open_file',
            target: target({ path: '/w/a/x.ts', folder: '/w/a' }),
            createdAt: iso(NOW),
          },
        ],
      },
    );
    const d = decide(
      s,
      input({
        tool: 'open_file',
        targets: [
          target({ path: '/w/a/x.ts', folder: '/w/a' }),
          target({ path: '/w/b/y.ts', folder: '/w/b' }),
        ],
      }),
    );
    expect(d.decision).toBe('ask');
    expect(d.overrideIds).toEqual(['oa']);
  });

  it('folder scope matches a session target by its folder (cwd)', () => {
    expect(
      matchesScope(
        { kind: 'folder', path: '/work/app' },
        target({ sessionId: 's2', folder: '/work/app' }),
      ),
    ).toBe(true);
    expect(
      matchesScope(
        { kind: 'folder', path: '/work/app' },
        target({ sessionId: 's2', folder: '/other' }),
      ),
    ).toBe(false);
  });

  it('one-use override matches its path through folderKey', () => {
    const override: OneUseOverride = {
      id: 'o1',
      sessionId: 's1',
      tool: 'open_session',
      target: target({ path: 'C:\\Work\\app' }),
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
      input({ tool: 'open_session', targets: [target({ path: 'c:/work/app' })] }),
    );
    expect(d.decision).toBe('allow');
    expect(d.reason).toEqual({ by: 'override', overrideId: 'o1' });
  });

  it('reason and ids agree: grantId set iff grant, overrideId set iff override', () => {
    const denyOpen = assignment('worker', [
      except('open_session', { kind: 'anywhere' }, { decision: 'deny' }),
    ]);
    const override: OneUseOverride = {
      id: 'o1',
      sessionId: 's1',
      tool: 'open_session',
      target: target({ sessionId: 's2' }),
      createdAt: iso(NOW),
    };
    const scenarios: { s: PolicyState; i: PolicyInput }[] = [
      { s: state(worker), i: input({ tool: 'open_session' }) },
      { s: state(worker, { grants: [grant()] }), i: input({ tool: 'open_session' }) },
      {
        s: state({ default: denyOpen }, { overrides: [override] }),
        i: input({ tool: 'open_session', targets: [target({ sessionId: 's2' })] }),
      },
      {
        s: state({ default: denyOpen }, { overrides: [override], grants: [grant()] }),
        i: input({ tool: 'open_session', targets: [target({ sessionId: 's2' })] }),
      },
      { s: state({ default: denyOpen }), i: input({ tool: 'open_session' }) },
    ];
    const reasons = new Set<string>();
    for (const { s: st, i } of scenarios) {
      const d = decide(st, i);
      reasons.add(d.reason.by);
      expect(d.grantId !== null, d.reason.by).toBe(d.reason.by === 'grant');
      expect(d.overrideId !== null, d.reason.by).toBe(d.reason.by === 'override');
    }
    expect(decide(scenarios[3].s, scenarios[3].i).reason.by).toBe('override');
    expect(reasons).toEqual(new Set(['profile', 'grant', 'override', 'deny']));
  });
});

describe('visibleTools', () => {
  it('hides an anywhere deny', () => {
    const assignments = {
      default: assignment('worker', [
        except('open_session', { kind: 'anywhere' }, { decision: 'deny' }),
      ]),
    };
    expect(visibleTools(state(assignments), session(), NOW)).not.toContain('open_session');
  });

  it('hides an anywhere deny even when a grant matches', () => {
    const assignments = {
      default: assignment('worker', [
        except('open_session', { kind: 'anywhere' }, { decision: 'deny' }),
      ]),
    };
    expect(visibleTools(state(assignments, { grants: [grant()] }), session(), NOW)).not.toContain(
      'open_session',
    );
  });

  it('keeps an anywhere deny visible for a matching one-use override', () => {
    const s = state(
      {
        default: assignment('worker', [
          except('open_session', { kind: 'anywhere' }, { decision: 'deny' }),
        ]),
      },
      {
        overrides: [
          {
            id: 'o1',
            sessionId: 's1',
            tool: 'open_session',
            target: target({ sessionId: 's2' }),
            createdAt: iso(NOW),
          },
        ],
      },
    );
    expect(visibleTools(s, session(), NOW)).toContain('open_session');
  });

  it('an anywhere deny does not hide a tool that has a narrower non-deny exception at the same assignment', () => {
    const s = state({
      default: assignment('worker', [
        except('open_session', { kind: 'anywhere' }, { decision: 'deny' }),
        except('open_session', { kind: 'folder', path: '/w' }, { decision: 'allow' }),
      ]),
    });
    expect(visibleTools(s, session(), NOW)).toContain('open_session');
  });

  it('a session keeps send_message and request_input listed under anywhere denies', () => {
    const s = state({
      default: assignment('worker', [
        except('send_message', { kind: 'anywhere' }, { decision: 'deny' }),
        except('request_input', { kind: 'anywhere' }, { decision: 'deny' }),
      ]),
    });
    const visible = visibleTools(s, session(), NOW);
    expect(visible).toContain('send_message');
    expect(visible).toContain('request_input');
  });

  it('keeps a folder deny visible', () => {
    const s = state({
      default: assignment('worker', [
        except('open_session', { kind: 'folder', path: '/w' }, { decision: 'deny' }),
      ]),
    });
    expect(visibleTools(s, session(), NOW)).toContain('open_session');
  });

  it('visibleTools hides an unconditional deny', () => {
    const visible = visibleTools(state(worker), session(), NOW);
    expect(visible).toContain('open_session');
    expect(visible).not.toContain('open_terminal');
  });

  it('visibleTools keeps a profile-denied tool that has a scoped allow exception', () => {
    const s = state({
      default: assignment('worker', [
        except('open_terminal', { kind: 'folder', path: '/other' }, { decision: 'allow' }),
      ]),
    });
    expect(visibleTools(s, session(), NOW)).toContain('open_terminal');
  });

  it('visibleTools keeps send_message and request_input listed under a profile that denies them', () => {
    const custom: Profile = {
      id: 'p-x',
      name: 'Custom',
      builtIn: false,
      rules: {
        ...WORKER_PROFILE.rules,
        send_message: { ...WORKER_PROFILE.rules.send_message, decision: 'deny' },
        request_input: { ...WORKER_PROFILE.rules.request_input, decision: 'deny' },
      },
    };
    const visible = visibleTools(
      state({ default: assignment('p-x') }, { profiles: [custom] }),
      session(),
      NOW,
    );
    expect(visible).toContain('send_message');
    expect(visible).toContain('request_input');
  });

  it('visibleTools keeps a tool denied only for the home folder', () => {
    const s = state({
      default: assignment('worker', [
        except('open_file', { kind: 'folder', path: '/work/app' }, { decision: 'deny' }),
      ]),
    });
    expect(visibleTools(s, session(), NOW)).toContain('open_file');
  });

  it("visibleTools hides exactly Worker's profile denies", () => {
    const profile = BUILT_IN_PROFILES.find((p) => p.id === 'worker');
    const expected = TOOL_NAMES.filter((t) => profile?.rules[t].decision !== 'deny');
    expect(visibleTools(state(worker), session(), NOW)).toEqual(expected);
  });

  it('visibleTools uses the given now for grant expiry', () => {
    const s = state(
      { default: assignment('observer') },
      { grants: [grant({ tool: 'open_terminal', expiresAt: iso(NOW + 3_600_000) })] },
    );
    expect(visibleTools(s, session(), NOW)).toContain('open_terminal');
    expect(visibleTools(s, session(), NOW + 7_200_000)).not.toContain('open_terminal');
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
      reasonText({ by: 'deny', point: { kind: 'peer', machineId: 'm-0000000a' } }, 'deny', names),
    ).toBe('denied by exception (machine)');
  });
});

describe('missing profile and fail-closed', () => {
  it('a session whose stored profile is missing decides as Observer, not Worker', () => {
    const st = state({ 'session:s1': assignment('p-gone' as ProfileId) });
    expect(decide(st, input({ principal: session(), tool: 'open_session' })).decision).toBe('deny');
    expect(decide(st, input({ principal: session(), tool: 'list_sessions' })).decision).toBe(
      'allow',
    );
  });

  it('failClosed makes a session Observer, ignoring its stored Lead assignment', () => {
    const st = state({ 'session:s1': assignment('lead') }, { failClosed: true });
    expect(decide(st, input({ principal: session(), tool: 'open_session' })).decision).toBe('deny');
  });

  it('failClosed makes a peer Observer, ignoring the default peer assignment', () => {
    const open = decide(state({}), input({ principal: remote(), tool: 'open_file' })).decision;
    const closed = decide(
      state({}, { failClosed: true }),
      input({ principal: remote(), tool: 'open_file' }),
    ).decision;
    expect(open).not.toBe('deny');
    expect(closed).toBe('deny');
  });
});

describe('a machine never added asks under every profile (spec 4.6, RS-D6)', () => {
  const connect = (over: Partial<PolicyInput> = {}) => input({ tool: 'connect_machine', ...over });

  it('a lead allow becomes an ask for a target that is not added, and the reason says so', () => {
    const d = decide(state({ default: assignment('lead') }), connect({ forceAsk: true }));
    expect(d.decision).toBe('ask');
    expect(d.reason).toEqual({ by: 'profile', point: { kind: 'default' }, profileId: 'lead' });
  });

  it('a lead allow stands for a machine already added', () => {
    expect(decide(state({ default: assignment('lead') }), connect()).decision).toBe('allow');
  });

  it('worker asks to connect, and a forced ask under worker is marked forced too', () => {
    expect(decide(state(worker), connect()).forcedAsk).toBe(false);
    const forced = decide(state(worker), connect({ forceAsk: true }));
    expect(forced.decision).toBe('ask');
    expect(forced.forcedAsk).toBe(true);
  });

  it('a connect_machine grant does not turn a forced ask under worker into an allow', () => {
    const d = decide(
      state(worker, { grants: [grant({ tool: 'connect_machine' })] }),
      connect({ forceAsk: true }),
    );
    expect(d.decision).toBe('ask');
    expect(d.forcedAsk).toBe(true);
    expect(d.grantId).toBeNull();
  });

  it('an observer denial stays a denial for a target that is not added', () => {
    expect(
      decide(state({ default: assignment('observer') }), connect({ forceAsk: true })).decision,
    ).toBe('deny');
  });

  it('a grant does not pass a forced ask: it is still an ask, marked forced', () => {
    const d = decide(
      state({ default: assignment('lead') }, { grants: [grant({ tool: 'connect_machine' })] }),
      connect({ forceAsk: true }),
    );
    expect(d.decision).toBe('ask');
    expect(d.reason).toEqual({ by: 'profile', point: { kind: 'default' }, profileId: 'lead' });
    expect(d.forcedAsk).toBe(true);
    expect(d.grantId).toBeNull();
  });

  it('an ordinary ask is not marked forced, and a grant still passes it', () => {
    const d = decide(
      state({ default: assignment('worker') }, { grants: [grant({ tool: 'connect_machine' })] }),
      connect(),
    );
    expect(d.decision).toBe('allow');
    expect(d.forcedAsk).toBe(false);
  });

  it('list_machines is allowed under observer, worker and lead, like list_sessions', () => {
    for (const id of ['observer', 'worker', 'lead'] as const) {
      const d = decide(state({ default: assignment(id) }), input({ tool: 'list_machines' }));
      expect(d.decision, id).toBe('allow');
    }
  });
});

describe('a remote peer reaches the machine tools only through its capability (NET R21)', () => {
  const peer = (capabilities: Capabilities) => remote(capabilities);

  it('connect_machine is orchestrate: a peer with messaging and monitor is denied', () => {
    const d = decide(
      state({ default: assignment('lead') }),
      input({
        principal: peer({ messaging: true, monitor: true, drive: true }),
        tool: 'connect_machine',
        forceAsk: false,
      }),
    );
    expect(d.decision).toBe('deny');
    expect(d.reason).toEqual({ by: 'floor', floor: 'remote-capability' });
  });

  it('disconnect_machine is orchestrate as well: a peer with every other capability is denied', () => {
    const d = decide(
      state({ default: assignment('lead') }),
      input({
        principal: peer({ messaging: true, monitor: true, drive: true }),
        tool: 'disconnect_machine',
      }),
    );
    expect(d.decision).toBe('deny');
  });

  // The fleet is local to each side (spec §4.4), so a remote's monitor capability does not reach it.
  it('list_machines is fleet: a peer with monitor is still denied the local fleet view', () => {
    const d = decide(
      state({ default: assignment('worker') }),
      input({
        principal: peer({ messaging: false, monitor: true, drive: false }),
        tool: 'list_machines',
      }),
    );
    expect(d.decision).toBe('deny');
    expect(d.reason).toEqual({ by: 'floor', floor: 'remote-capability' });
  });
});

// see docs/plans/2026-11-16-remote-ssh-routed-tools.plan.md, decision 2
describe('an ssh controller is a Lead remote principal (CON-40 G2)', () => {
  const controller = (capabilities: Capabilities = ALL_CAPS): Principal =>
    remote(capabilities, true);
  const ROUTED = [
    'open_session',
    'send_input',
    'read_screen',
    'close_session',
    'list_agents',
  ] as const;

  it('a controller peer with no stored assignment is Lead: the routed tools are allowed', () => {
    const s = state({});
    for (const tool of ROUTED) {
      const d = decide(s, input({ principal: controller(), tool }));
      expect(d.decision, tool).toBe('allow');
      expect(d.reason, tool).toEqual({
        by: 'profile',
        point: { kind: 'peer', machineId: 'm-0000000a' },
        profileId: 'lead',
      });
    }
  });

  it('a TLS peer (controller false) with no stored assignment is still denied orchestrate', () => {
    const s = state({});
    for (const tool of ROUTED.filter((t) => t !== 'list_agents')) {
      const d = decide(s, input({ principal: remote(), tool }));
      expect(d.decision, tool).toBe('deny');
      expect(d.reason, tool).toEqual({ by: 'floor', floor: 'remote-capability' });
    }
  });

  it('a controller is denied the machine tools: the fleet is local to each side', () => {
    const s = state({});
    for (const tool of ['connect_machine', 'disconnect_machine', 'list_machines'] as const) {
      const d = decide(s, input({ principal: controller(), tool }));
      expect(d.decision, tool).toBe('deny');
      expect(d.reason, tool).toEqual({ by: 'floor', floor: 'remote-capability' });
    }
  });

  it('a TLS peer with a stored lead assignment is still denied open_session', () => {
    const s = state({ 'peer:m-0000000a': assignment('lead') });
    const d = decide(s, input({ principal: remote(), tool: 'open_session' }));
    expect(d.decision).toBe('deny');
    expect(d.reason).toEqual({ by: 'floor', floor: 'remote-capability' });
  });

  it('a controller with a stored stricter assignment (Observer) is denied', () => {
    const s = state({ 'peer:m-0000000a': assignment('observer') });
    const d = decide(s, input({ principal: controller(), tool: 'open_session' }));
    expect(d.decision).toBe('deny');
    expect(d.reason).toEqual({
      by: 'profile',
      point: { kind: 'peer', machineId: 'm-0000000a' },
      profileId: 'observer',
    });
  });

  it('visibleTools agrees with decide for a controller and for a TLS peer', () => {
    for (const principal of [controller(), remote()]) {
      const s = state({});
      const visible = visibleTools(s, principal, NOW);
      for (const tool of TOOL_NAMES) {
        const denied = decide(s, input({ principal, tool })).decision === 'deny';
        expect(visible.includes(tool), `${principal.kind} ${tool}`).toBe(!denied);
      }
    }
  });
});

it('enforces a session denial ahead of grants and below floors', () => {
  const denial = {
    id: 'd1',
    requestId: 'r1',
    sessionId: 's1',
    tool: 'open_session' as const,
    createdAt: new Date(NOW).toISOString(),
  };
  const s = state({ default: assignment('lead') }, { sessionDenials: [denial], grants: [grant()] });
  expect(decide(s, input({ tool: 'open_session' }))).toMatchObject({
    decision: 'deny',
    reason: { by: 'session-deny', denialId: 'd1' },
  });
  expect(decide(s, input({ tool: 'open_session', masterOn: false })).reason).toEqual({
    by: 'floor',
    floor: 'master-off',
  });
  expect(decide(s, input({ tool: 'read_inbox' })).reason.by).not.toBe('session-deny');
});

it('passes only the exact session denial target with an override and respects floors', () => {
  const denial = {
    id: 'd1',
    requestId: 'r1',
    sessionId: 's1',
    tool: 'open_session' as const,
    createdAt: iso(NOW),
  };
  const override: OneUseOverride = {
    id: 'o1',
    sessionId: 's1',
    tool: 'open_session',
    target: target({ sessionId: 's2' }),
    createdAt: iso(NOW),
  };
  const s = state(
    { default: assignment('lead') },
    { sessionDenials: [denial], overrides: [override] },
  );
  expect(
    decide(s, input({ tool: 'open_session', targets: [target({ sessionId: 's2' })] })),
  ).toMatchObject({ decision: 'allow', reason: { by: 'override', overrideId: 'o1' } });
  expect(
    decide(s, input({ tool: 'open_session', targets: [target({ sessionId: 's3' })] })),
  ).toMatchObject({ decision: 'deny', reason: { by: 'session-deny', denialId: 'd1' } });
  expect(
    decide(
      s,
      input({ tool: 'open_session', targets: [target({ sessionId: 's2' })], masterOn: false }),
    ).reason,
  ).toEqual({ by: 'floor', floor: 'master-off' });
  expect(
    decide(s, input({ tool: 'open_session', principal: session({ sessionId: 's9' }) })).reason.by,
  ).not.toBe('session-deny');
  expect(visibleTools(s, session({ sessionId: 's1' }), NOW)).toContain('open_session');
  expect(visibleTools({ ...s, overrides: [] }, session(), NOW)).not.toContain('open_session');
});
