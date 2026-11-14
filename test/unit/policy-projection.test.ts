import { describe, expect, it } from 'vitest';
import { pointKey } from '../../src/conduit-mcp/policy-profiles';
import { applyLegacyPatch, projectLegacyLayer } from '../../src/conduit-mcp/policy-projection';
import type { Assignment, AssignmentPoint, PolicyState } from '../../src/conduit-mcp/policy-types';
import { TOOL_GROUPS, TOOL_SPECS } from '../../src/conduit-mcp/tool-policy';

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

const sessionAndEditor = TOOL_GROUPS.filter(
  (g) => g.group === 'sessions' || g.group === 'editor',
).flatMap((g) => g.tools);

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

  it('applyLegacyPatch seeds a fresh point with only the lower anywhere exceptions', () => {
    const lower: Assignment = {
      profileId: 'worker',
      onScreenOnly: false,
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
    expect(next.exceptions).toEqual([
      { tool: 'open_terminal', scope: { kind: 'anywhere' }, rule: { decision: 'allow' } },
      { tool: 'open_file', scope: { kind: 'anywhere' }, rule: { decision: 'deny' } },
    ]);
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
});
