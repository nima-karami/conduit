import { describe, expect, it } from 'vitest';
import {
  effectiveRule,
  pointKey,
  profileById,
  WORKER_PROFILE,
} from '../../src/conduit-mcp/policy-profiles';
import {
  applyLegacyPatch,
  legacyLowerPoint,
  projectLegacyLayer,
} from '../../src/conduit-mcp/policy-projection';
import type {
  Assignment,
  AssignmentPoint,
  PolicyState,
  ToolRule,
} from '../../src/conduit-mcp/policy-types';
import {
  TOOL_GROUPS,
  TOOL_NAMES,
  TOOL_SPECS,
  type ToolName,
} from '../../src/conduit-mcp/tool-policy';

const SESSION: AssignmentPoint = { kind: 'session', sessionId: 's1' };
const DEFAULT: AssignmentPoint = { kind: 'default' };
const LEAD_ONSCREEN: Assignment = { profileId: 'lead', exceptions: [], onScreenOnly: true };
const WORKER_PLAIN: Assignment = { profileId: 'worker', exceptions: [], onScreenOnly: false };

const stateOf = (entries: Array<[AssignmentPoint, Assignment]>): PolicyState => ({
  profiles: [],
  assignments: new Map(entries.map(([p, a]) => [pointKey(p), a])),
  grants: [],
  overrides: [],
});

const patched = (...args: Parameters<typeof applyLegacyPatch>): Assignment => {
  const result = applyLegacyPatch(...args);
  if (result === null) throw new Error('legacy patch refused');
  return result;
};

const ruleAt = (state: PolicyState, a: Assignment, tool: ToolName): ToolRule =>
  effectiveRule(profileById(state, a.profileId) ?? WORKER_PROFILE, a, tool, null);

const sessionAndEditor = TOOL_GROUPS.filter(
  (g) => g.group === 'sessions' || g.group === 'editor',
).flatMap((g) => g.tools);
const WHEN_TOOLS = TOOL_NAMES.filter((t) => TOOL_SPECS[t].fields.includes('when'));

describe('projectLegacyLayer', () => {
  it('projection of Lead+onScreenOnly reproduces the original all-on layer', () => {
    const state = stateOf([[SESSION, LEAD_ONSCREEN]]);
    const projected = projectLegacyLayer(state, SESSION, DEFAULT);

    expect(projected).toEqual({
      open_session: { access: 'on' },
      open_terminal: { access: 'on' },
      close_session: { access: 'on' },
      send_input: { access: 'on' },
      attach_folder: { access: 'on' },
    });
    for (const tool of sessionAndEditor) {
      const inherited = TOOL_SPECS[tool].defaults.access;
      expect(projected[tool]?.access ?? inherited, tool).toBe('on');
      expect(projected[tool]?.when, tool).toBeUndefined();
      expect(projected[tool]?.reach, tool).toBeUndefined();
      expect(projected[tool]?.move, tool).toBeUndefined();
    }
  });

  it('projection is a diff against the lower point', () => {
    const state = stateOf([
      [DEFAULT, LEAD_ONSCREEN],
      [SESSION, WORKER_PLAIN],
    ]);
    expect(projectLegacyLayer(state, SESSION, DEFAULT)).toEqual({
      open_session: { access: 'ask' },
      open_terminal: { access: 'off' },
      close_session: { access: 'ask' },
      send_input: { access: 'ask' },
      attach_folder: { access: 'ask' },
    });
    expect(projectLegacyLayer(state, DEFAULT, DEFAULT)).toEqual({});
  });
});

describe('applyLegacyPatch', () => {
  it('applyLegacyPatch sets a field on a fresh copy of the lower assignment', () => {
    const lower: Assignment = {
      profileId: 'worker',
      onScreenOnly: false,
      exceptions: [
        { tool: 'open_terminal', scope: { kind: 'anywhere' }, rule: { decision: 'allow' } },
      ],
    };
    const state = stateOf([[DEFAULT, lower]]);
    const before = structuredClone(state);

    const next = patched(state, SESSION, DEFAULT, 'open_session', { access: 'off' });

    expect(next).toEqual({
      profileId: 'worker',
      onScreenOnly: false,
      exceptions: [
        { tool: 'open_terminal', scope: { kind: 'anywhere' }, rule: { decision: 'allow' } },
        { tool: 'open_session', scope: { kind: 'anywhere' }, rule: { decision: 'deny' } },
      ],
    });
    expect(next.exceptions[0]).not.toBe(lower.exceptions[0]);
    expect(state).toEqual(before);
  });

  it('applyLegacyPatch seeds a fresh point with a full copy of the lower assignment', () => {
    const lower: Assignment = {
      profileId: 'lead',
      onScreenOnly: true,
      exceptions: [
        { tool: 'open_terminal', scope: { kind: 'anywhere' }, rule: { decision: 'allow' } },
        { tool: 'send_input', scope: { kind: 'anywhere' }, rule: { decision: 'ask' } },
      ],
    };
    const next = patched(stateOf([[DEFAULT, lower]]), SESSION, DEFAULT, 'open_file', {
      access: 'off',
    });
    expect(next).toEqual({
      profileId: 'lead',
      onScreenOnly: true,
      exceptions: [
        ...lower.exceptions,
        { tool: 'open_file', scope: { kind: 'anywhere' }, rule: { decision: 'deny' } },
      ],
    });
    expect(next.exceptions[0]).not.toBe(lower.exceptions[0]);
  });

  it('applyLegacyPatch inherit removes the exception', () => {
    const state = stateOf([
      [
        SESSION,
        {
          profileId: 'worker',
          onScreenOnly: false,
          exceptions: [
            { tool: 'open_session', scope: { kind: 'anywhere' }, rule: { decision: 'allow' } },
          ],
        },
      ],
    ]);
    const next = patched(state, SESSION, null, 'open_session', { access: 'inherit' });
    expect(next).toEqual({ profileId: 'worker', onScreenOnly: false, exceptions: [] });
  });

  it('a when patch on a Lead+1 session shows in the projection and keeps the other tools on screen', () => {
    const state = stateOf([[SESSION, LEAD_ONSCREEN]]);
    const next = patched(state, SESSION, DEFAULT, 'read_screen', { when: 'always' });
    const after = stateOf([[SESSION, next]]);

    expect(next.onScreenOnly).toBe(false);
    expect(projectLegacyLayer(after, SESSION, DEFAULT).read_screen).toEqual({ when: 'always' });
    for (const tool of WHEN_TOOLS.filter((t) => t !== 'read_screen')) {
      expect(ruleAt(after, next, tool).when, tool).toBe('viewing');
      expect(projectLegacyLayer(after, SESSION, DEFAULT)[tool]?.when, tool).toBeUndefined();
    }
  });

  it('inherit on a profile-overridden field removes it from the projection', () => {
    const state = stateOf([[SESSION, LEAD_ONSCREEN]]);
    const next = patched(state, SESSION, DEFAULT, 'send_input', { access: 'inherit' });
    const after = stateOf([[SESSION, next]]);

    expect(projectLegacyLayer(after, SESSION, DEFAULT).send_input).toBeUndefined();
    expect(ruleAt(after, next, 'send_input')).toEqual(WORKER_PROFILE.rules.send_input);
  });

  it('a set value equal to the profile clears the exception field', () => {
    const state = stateOf([
      [
        SESSION,
        {
          profileId: 'lead',
          onScreenOnly: true,
          exceptions: [
            { tool: 'send_input', scope: { kind: 'anywhere' }, rule: { decision: 'deny' } },
          ],
        },
      ],
    ]);
    const next = patched(state, SESSION, DEFAULT, 'send_input', { access: 'on' });

    expect(next.exceptions).toEqual([]);
    expect(projectLegacyLayer(stateOf([[SESSION, next]]), SESSION, DEFAULT).send_input).toEqual({
      access: 'on',
    });
  });

  it('a patch field the tool does not have changes nothing', () => {
    const state = stateOf([[SESSION, LEAD_ONSCREEN]]);
    const next = patched(state, SESSION, null, 'list_sessions', { when: 'always' });
    expect(next).toEqual(LEAD_ONSCREEN);
    const mixed = patched(state, SESSION, null, 'list_sessions', { access: 'off', when: 'always' });
    expect(mixed.exceptions).toEqual([
      { tool: 'list_sessions', scope: { kind: 'anywhere' }, rule: { decision: 'deny' } },
    ]);
    const scopedPoint: Assignment = {
      profileId: 'lead',
      onScreenOnly: true,
      exceptions: [
        {
          tool: 'send_input',
          scope: { kind: 'folder', path: '/work' },
          rule: { decision: 'allow' },
        },
      ],
    };
    expect(
      applyLegacyPatch(stateOf([[SESSION, scopedPoint]]), SESSION, null, 'list_sessions', {
        when: 'always',
      }),
    ).toEqual(scopedPoint);
  });

  it('inherit equals lower at the null target', () => {
    const lower: Assignment = {
      profileId: 'worker',
      onScreenOnly: false,
      exceptions: [
        { tool: 'send_input', scope: { kind: 'anywhere' }, rule: { decision: 'allow' } },
      ],
    };
    const resolved = (state: PolicyState, a: Assignment) =>
      effectiveRule(profileById(state, a.profileId) ?? WORKER_PROFILE, a, 'send_input', null);
    const fresh = stateOf([[DEFAULT, lower]]);
    const freshNext = patched(fresh, SESSION, DEFAULT, 'send_input', { access: 'inherit' });
    const withLead = stateOf([
      [DEFAULT, lower],
      [SESSION, LEAD_ONSCREEN],
    ]);
    const leadNext = patched(withLead, SESSION, DEFAULT, 'send_input', { access: 'inherit' });

    expect(resolved(fresh, freshNext)).toEqual(resolved(fresh, lower));
    expect(resolved(withLead, leadNext)).toEqual(resolved(fresh, lower));
  });

  it('inherit on when equals a lower with onScreenOnly', () => {
    const state = stateOf([
      [DEFAULT, LEAD_ONSCREEN],
      [SESSION, LEAD_ONSCREEN],
    ]);
    const next = patched(state, SESSION, DEFAULT, 'read_screen', { when: 'inherit' });
    const after = stateOf([
      [DEFAULT, LEAD_ONSCREEN],
      [SESSION, next],
    ]);
    expect(next.onScreenOnly).toBe(false);
    for (const tool of WHEN_TOOLS) {
      expect(ruleAt(after, next, tool), tool).toEqual(ruleAt(state, LEAD_ONSCREEN, tool));
    }
  });

  it('a point with a scoped exception refuses legacy patches', () => {
    const scoped: Assignment = {
      profileId: 'worker',
      onScreenOnly: false,
      exceptions: [
        {
          tool: 'send_input',
          scope: { kind: 'folder', path: '/work' },
          rule: { decision: 'allow' },
        },
      ],
    };
    expect(
      applyLegacyPatch(stateOf([[SESSION, scoped]]), SESSION, DEFAULT, 'open_file', {
        access: 'off',
      }),
    ).toBeNull();
  });

  it('a lower with a scoped exception refuses legacy patches', () => {
    const scoped: Assignment = {
      profileId: 'worker',
      onScreenOnly: false,
      exceptions: [
        {
          tool: 'send_input',
          scope: { kind: 'session', sessionId: 's1' },
          rule: { decision: 'allow' },
        },
      ],
    };
    expect(
      applyLegacyPatch(stateOf([[DEFAULT, scoped]]), SESSION, DEFAULT, 'open_file', {
        access: 'off',
      }),
    ).toBeNull();
  });
});

describe('legacyLowerPoint', () => {
  const CLAUDE_POINT: AssignmentPoint = { kind: 'cli', cli: 'claude' };

  it('a session launched by claude lowers onto the claude cli point when that point has an assignment', () => {
    const state = stateOf([[CLAUDE_POINT, WORKER_PLAIN]]);
    expect(legacyLowerPoint(state, 'claude')).toEqual(CLAUDE_POINT);
  });

  it('a session launched by claude with no claude cli assignment lowers onto the default', () => {
    const state = stateOf([[{ kind: 'cli', cli: 'codex' }, WORKER_PLAIN]]);
    expect(legacyLowerPoint(state, 'claude')).toEqual(DEFAULT);
  });
});
