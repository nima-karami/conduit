import { describe, expect, it } from 'vitest';
import {
  effectiveRule,
  pointKey,
  profileById,
  WORKER_PROFILE,
} from '../../src/conduit-mcp/policy-profiles';
import { applyLegacyPatch, projectLegacyLayer } from '../../src/conduit-mcp/policy-projection';
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

    const next = applyLegacyPatch(state, SESSION, DEFAULT, 'open_session', { access: 'off' });

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
        {
          tool: 'open_terminal',
          scope: { kind: 'folder', path: '/work' },
          rule: { decision: 'ask' },
        },
      ],
    };
    const next = applyLegacyPatch(stateOf([[DEFAULT, lower]]), SESSION, DEFAULT, 'open_file', {
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
    const next = applyLegacyPatch(state, SESSION, null, 'open_session', { access: 'inherit' });
    expect(next).toEqual({ profileId: 'worker', onScreenOnly: false, exceptions: [] });
  });

  it('a when patch on a Lead+1 session shows in the projection and keeps the other tools on screen', () => {
    const state = stateOf([[SESSION, LEAD_ONSCREEN]]);
    const next = applyLegacyPatch(state, SESSION, DEFAULT, 'read_screen', { when: 'always' });
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
    const next = applyLegacyPatch(state, SESSION, DEFAULT, 'send_input', { access: 'inherit' });
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
    const next = applyLegacyPatch(state, SESSION, DEFAULT, 'send_input', { access: 'on' });

    expect(next.exceptions).toEqual([]);
    expect(projectLegacyLayer(stateOf([[SESSION, next]]), SESSION, DEFAULT).send_input).toEqual({
      access: 'on',
    });
  });

  it('clearing onScreenOnly never loosens a scoped when', () => {
    const scoped: Assignment = {
      profileId: 'lead',
      onScreenOnly: true,
      exceptions: [
        {
          tool: 'send_input',
          scope: { kind: 'folder', path: '/work' },
          rule: { when: 'always' },
        },
      ],
    };
    const state = stateOf([[SESSION, scoped]]);
    const target = { sessionId: null, path: '/work/x', folder: '/work', projectId: null };
    const next = applyLegacyPatch(state, SESSION, DEFAULT, 'read_screen', { when: 'always' });

    const whenAt = (a: Assignment): ToolRule['when'] =>
      effectiveRule(profileById(state, a.profileId) ?? WORKER_PROFILE, a, 'send_input', target)
        .when;
    expect(next.onScreenOnly).toBe(false);
    expect(whenAt(scoped)).toBe('viewing');
    expect(whenAt(next)).toBe('viewing');
  });

  it("a legacy edit overrides the same tool's scoped exceptions", () => {
    const state = stateOf([
      [
        SESSION,
        {
          profileId: 'worker',
          onScreenOnly: false,
          exceptions: [
            {
              tool: 'send_input',
              scope: { kind: 'session', sessionId: 's1' },
              rule: { decision: 'allow' },
            },
          ],
        },
      ],
    ]);
    const next = applyLegacyPatch(state, SESSION, DEFAULT, 'send_input', { access: 'off' });
    const target = { sessionId: 's1', path: null, folder: null, projectId: null };

    expect(next.exceptions).toEqual([
      { tool: 'send_input', scope: { kind: 'anywhere' }, rule: { decision: 'deny' } },
    ]);
    expect(effectiveRule(WORKER_PROFILE, next, 'send_input', target).decision).toBe('deny');
  });

  it('a patch field the tool does not have changes nothing', () => {
    const state = stateOf([[SESSION, LEAD_ONSCREEN]]);
    const next = applyLegacyPatch(state, SESSION, null, 'list_sessions', { when: 'always' });
    expect(next).toEqual(LEAD_ONSCREEN);
  });

  it("a legacy when edit reaches the patched tool's own scoped exception", () => {
    const scoped: Assignment = {
      profileId: 'lead',
      onScreenOnly: true,
      exceptions: [
        {
          tool: 'read_screen',
          scope: { kind: 'folder', path: '/work' },
          rule: { when: 'viewing' },
        },
      ],
    };
    const state = stateOf([[SESSION, scoped]]);
    const target = { sessionId: null, path: '/work/x', folder: '/work', projectId: null };
    const next = applyLegacyPatch(state, SESSION, DEFAULT, 'read_screen', { when: 'always' });

    expect(
      effectiveRule(
        profileById(state, next.profileId) ?? WORKER_PROFILE,
        next,
        'read_screen',
        target,
      ).when,
    ).toBe('always');
  });

  it('inherit equals lower at every scope', () => {
    const lower: Assignment = {
      profileId: 'worker',
      onScreenOnly: false,
      exceptions: [
        { tool: 'send_input', scope: { kind: 'anywhere' }, rule: { decision: 'allow' } },
        {
          tool: 'send_input',
          scope: { kind: 'folder', path: '/secrets' },
          rule: { decision: 'deny' },
        },
      ],
    };
    const targets = [
      null,
      { sessionId: null, path: '/secrets/x', folder: '/secrets', projectId: null },
      { sessionId: null, path: '/other/x', folder: '/other', projectId: null },
    ];
    const resolvedAt = (state: PolicyState, a: Assignment, target: (typeof targets)[number]) =>
      effectiveRule(profileById(state, a.profileId) ?? WORKER_PROFILE, a, 'send_input', target);

    const fresh = stateOf([[DEFAULT, lower]]);
    const freshNext = applyLegacyPatch(fresh, SESSION, DEFAULT, 'send_input', {
      access: 'inherit',
    });
    const withLead = stateOf([
      [DEFAULT, lower],
      [SESSION, LEAD_ONSCREEN],
    ]);
    const leadNext = applyLegacyPatch(withLead, SESSION, DEFAULT, 'send_input', {
      access: 'inherit',
    });

    const withOwnScoped = stateOf([
      [DEFAULT, lower],
      [
        SESSION,
        {
          profileId: 'worker',
          onScreenOnly: false,
          exceptions: [
            {
              tool: 'send_input',
              scope: { kind: 'folder', path: '/other' },
              rule: { decision: 'deny' },
            },
          ],
        },
      ],
    ]);
    const ownNext = applyLegacyPatch(withOwnScoped, SESSION, DEFAULT, 'send_input', {
      access: 'inherit',
    });

    for (const target of targets) {
      const label = JSON.stringify(target);
      expect(resolvedAt(fresh, freshNext, target), `fresh ${label}`).toEqual(
        resolvedAt(fresh, lower, target),
      );
      expect(resolvedAt(withLead, leadNext, target), `lead ${label}`).toEqual(
        resolvedAt(fresh, lower, target),
      );
      expect(resolvedAt(withOwnScoped, ownNext, target), `own ${label}`).toEqual(
        resolvedAt(fresh, lower, target),
      );
    }
  });
});
