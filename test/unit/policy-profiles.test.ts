import { describe, expect, it } from 'vitest';
import {
  BUILT_IN_PROFILES,
  effectiveRule,
  pointKey,
  profileById,
  resolveTarget,
} from '../../src/conduit-mcp/policy-profiles';
import type {
  Assignment,
  Decision,
  PolicyState,
  PolicyTarget,
  Principal,
  ToolRule,
} from '../../src/conduit-mcp/policy-types';
import {
  type Access,
  TOOL_NAMES,
  TOOL_SPECS,
  type ToolName,
} from '../../src/conduit-mcp/tool-policy';

const emptyState: PolicyState = {
  profiles: [],
  assignments: new Map(),
  grants: [],
  overrides: [],
  failClosed: false,
};
const DECISION_OF: Record<Access, Decision> = { off: 'deny', ask: 'ask', on: 'allow' };
const builtIn = (id: string) => {
  const p = BUILT_IN_PROFILES.find((x) => x.id === id);
  if (!p) throw new Error(`missing built-in ${id}`);
  return p;
};
const OBSERVER_ALLOWED: readonly ToolName[] = [
  'list_sessions',
  'read_inbox',
  'read_attachment',
  'send_message',
  'wait_sessions',
  'list_agents',
  'list_machines',
  'request_input',
  'wait_request',
  'withdraw_request',
  'list_requests',
];
const LEAD_ALLOWED: readonly ToolName[] = [
  'connect_machine',
  'disconnect_machine',
  'open_session',
  'open_terminal',
  'send_input',
  'close_session',
  'attach_folder',
];
const assignment = (over: Partial<Assignment> = {}): Assignment => ({
  profileId: 'worker',
  exceptions: [],
  onScreenOnly: false,
  ...over,
});

describe('built-in profiles', () => {
  it("worker equals today's defaults", () => {
    const worker = builtIn('worker');
    for (const tool of TOOL_NAMES) {
      const spec = TOOL_SPECS[tool];
      const expected: ToolRule = {
        decision: DECISION_OF[spec.defaults.access],
        when: spec.fields.includes('when') ? (spec.defaults.when ?? null) : null,
        reach: spec.fields.includes('reach') ? (spec.defaults.reach ?? null) : null,
        move: spec.fields.includes('move') ? (spec.defaults.move ?? null) : null,
      };
      expect(worker.rules[tool], tool).toEqual(expected);
    }
    expect(worker.rules.open_session).toEqual({
      decision: 'ask',
      when: 'viewing',
      reach: null,
      move: 'yes',
    });
  });

  it('lead is worker plus the bold allows, and acts off screen wherever worker has a when', () => {
    const worker = builtIn('worker');
    const lead = builtIn('lead');
    for (const tool of TOOL_NAMES) {
      const expectedDecision = LEAD_ALLOWED.includes(tool) ? 'allow' : worker.rules[tool].decision;
      const expectedWhen = worker.rules[tool].when === null ? null : 'always';
      expect(lead.rules[tool].decision, tool).toBe(expectedDecision);
      expect(lead.rules[tool].when, tool).toBe(expectedWhen);
      expect(lead.rules[tool].reach, tool).toBe(worker.rules[tool].reach);
      expect(lead.rules[tool].move, tool).toBe(worker.rules[tool].move);
    }
    expect(lead.rules.open_terminal).toEqual({
      decision: 'allow',
      when: 'always',
      reach: null,
      move: 'yes',
    });
  });

  it('observer denies all but the read and request tools', () => {
    const observer = builtIn('observer');
    for (const tool of TOOL_NAMES) {
      const expected = OBSERVER_ALLOWED.includes(tool)
        ? builtIn('worker').rules[tool].decision
        : 'deny';
      expect(observer.rules[tool].decision, tool).toBe(expected);
    }
    expect(observer.name).toBe('Observer');
    expect(observer.builtIn).toBe(true);
  });

  // Spec 4.6 / RS-D6: a machine is added only by the owner or a Lead, and asks are forced in the engine.
  it('machines: observer denies connect and disconnect, worker asks, lead allows; list follows list_sessions', () => {
    const rule = (id: string, tool: ToolName) => builtIn(id).rules[tool].decision;
    expect(rule('observer', 'connect_machine')).toBe('deny');
    expect(rule('observer', 'disconnect_machine')).toBe('deny');
    expect(rule('worker', 'connect_machine')).toBe('ask');
    expect(rule('worker', 'disconnect_machine')).toBe('ask');
    expect(rule('lead', 'connect_machine')).toBe('allow');
    expect(rule('lead', 'disconnect_machine')).toBe('allow');
    for (const id of ['observer', 'worker', 'lead']) {
      expect(rule(id, 'list_machines'), id).toBe(rule(id, 'list_sessions'));
    }
  });

  it('profileById finds built-ins and returns null for an unknown id', () => {
    expect(profileById(emptyState, 'lead')?.name).toBe('Lead');
    expect(profileById(emptyState, 'p-missing')).toBeNull();
  });
});

describe('resolveTarget', () => {
  const none: PolicyTarget = { sessionId: null, path: null, folder: null, projectId: null };
  const local: Principal = {
    kind: 'session',
    sessionId: 's1',
    handle: 'claude-1',
    launchedCli: null,
    homeFolder: '/work/app',
    projectId: 'p1',
  };
  const remote: Principal = {
    kind: 'remote',
    handle: 'r',
    machineId: 'm1',
    trust: 'own',
    controller: false,
    capabilities: { messaging: true, monitor: true, drive: true },
  };

  it('resolves an empty target to the session home folder', () => {
    expect(resolveTarget(none, local)).toEqual({
      sessionId: null,
      path: '/work/app',
      folder: '/work/app',
      projectId: 'p1',
    });
  });

  it('leaves an empty target empty for a remote principal, which has no home', () => {
    expect(resolveTarget(none, remote)).toEqual(none);
  });

  it('leaves a target that names a session, path or folder unchanged', () => {
    const folder: PolicyTarget = { sessionId: null, path: null, folder: '/x', projectId: null };
    expect(resolveTarget(folder, local)).toBe(folder);
  });
});

describe('pointKey', () => {
  it('names each assignment point', () => {
    expect(pointKey({ kind: 'session', sessionId: 's1' })).toBe('session:s1');
    expect(pointKey({ kind: 'peer', machineId: 'm2' })).toBe('peer:m2');
    expect(pointKey({ kind: 'cli', cli: 'codex' })).toBe('cli:codex');
    expect(pointKey({ kind: 'default' })).toBe('default');
  });
});

describe('effectiveRule', () => {
  it('keeps profile fields that an exception does not set', () => {
    const rule = effectiveRule(
      builtIn('worker'),
      assignment({
        exceptions: [
          { tool: 'open_session', scope: { kind: 'anywhere' }, rule: { when: 'always' } },
        ],
      }),
      'open_session',
      null,
    );
    expect(rule).toEqual({ decision: 'ask', when: 'always', reach: null, move: 'yes' });
  });

  it('forces viewing on a rule with a when field when onScreenOnly is set', () => {
    const lead = builtIn('lead');
    expect(
      effectiveRule(
        lead,
        assignment({ profileId: 'lead', onScreenOnly: true }),
        'open_terminal',
        null,
      ).when,
    ).toBe('viewing');
    expect(
      effectiveRule(
        lead,
        assignment({ profileId: 'lead', onScreenOnly: true }),
        'send_message',
        null,
      ).when,
    ).toBeNull();
  });
});
