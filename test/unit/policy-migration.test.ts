import { describe, expect, it } from 'vitest';
import { type LegacyPolicy, migrateLegacyPolicy } from '../../src/conduit-mcp/policy-migration';
import {
  DECISION_OF_ACCESS,
  effectiveRule,
  pointKey,
  profileById,
  WORKER_PROFILE,
} from '../../src/conduit-mcp/policy-profiles';
import type {
  Assignment,
  AssignmentPoint,
  PolicyState,
  ToolRule,
} from '../../src/conduit-mcp/policy-types';
import {
  DEFAULT_TOOL_POLICY,
  type GlobalPolicy,
  type PolicyLayer,
  type PolicyLayers,
  resolvePolicy,
  TOOL_GROUPS,
  TOOL_NAMES,
  type ToolName,
  type ToolPolicy,
} from '../../src/conduit-mcp/tool-policy';

const todayRule = (p: ToolPolicy): ToolRule => ({
  decision: DECISION_OF_ACCESS[p.access],
  when: p.when ?? null,
  reach: p.reach ?? null,
  move: p.move ?? null,
});

const sessionAndEditor = TOOL_GROUPS.filter(
  (g) => g.group === 'sessions' || g.group === 'editor',
).flatMap((g) => g.tools);

const allOnLayer = (): PolicyLayer => {
  const layer: PolicyLayer = {};
  for (const t of sessionAndEditor) layer[t] = { access: 'on' };
  return layer;
};

const stateOf = (entries: Array<[AssignmentPoint, Assignment]>): PolicyState => ({
  profiles: [],
  assignments: new Map(entries.map(([p, a]) => [pointKey(p), a])),
  grants: [],
  overrides: [],
});

const assignmentAt = (
  out: ReturnType<typeof migrateLegacyPolicy>,
  point: AssignmentPoint,
): Assignment => {
  const found = out.assignments.find((x) => pointKey(x.point) === pointKey(point));
  if (!found) throw new Error(`no assignment at ${pointKey(point)}`);
  return found.assignment;
};

const effectiveAt = (state: PolicyState, point: AssignmentPoint, tool: ToolName): ToolRule => {
  const a = state.assignments.get(pointKey(point));
  if (!a) throw new Error(`no assignment at ${pointKey(point)}`);
  return effectiveRule(profileById(state, a.profileId) ?? WORKER_PROFILE, a, tool, null);
};

describe('migrateLegacyPolicy', () => {
  it('all-on override becomes Lead with onScreenOnly and resolves identically for all 23 tools', () => {
    const layer = allOnLayer();
    const out = migrateLegacyPolicy({
      global: DEFAULT_TOOL_POLICY,
      byCli: {},
      sessions: [{ sessionId: 's1', layer, cli: null }],
    });
    const point: AssignmentPoint = { kind: 'session', sessionId: 's1' };
    expect(assignmentAt(out, point)).toEqual({
      profileId: 'lead',
      exceptions: [],
      onScreenOnly: true,
    });

    const state = stateOf([[point, assignmentAt(out, point)]]);
    for (const tool of TOOL_NAMES) {
      const today = todayRule(
        resolvePolicy(tool, { session: layer, global: DEFAULT_TOOL_POLICY }).policy,
      );
      expect(effectiveAt(state, point, tool), tool).toEqual(today);
    }
  });

  it('partial override becomes Worker + one exception per changed tool', () => {
    const out = migrateLegacyPolicy({
      global: DEFAULT_TOOL_POLICY,
      byCli: {},
      sessions: [
        {
          sessionId: 's1',
          layer: { open_file: { access: 'off' }, read_screen: { when: 'always' } },
          cli: null,
        },
      ],
    });
    expect(out.assignments).toEqual([
      {
        point: { kind: 'session', sessionId: 's1' },
        assignment: {
          profileId: 'worker',
          onScreenOnly: false,
          exceptions: [
            { tool: 'read_screen', scope: { kind: 'anywhere' }, rule: { when: 'always' } },
            { tool: 'open_file', scope: { kind: 'anywhere' }, rule: { decision: 'deny' } },
          ],
        },
      },
    ]);
  });

  it('a session layer resolves over its CLI layer and global, as today', () => {
    const cliLayer: PolicyLayer = { open_file: { access: 'off' }, read_screen: { reach: 'any' } };
    const sessionLayer: PolicyLayer = { open_file: { access: 'on' } };
    const out = migrateLegacyPolicy({
      global: DEFAULT_TOOL_POLICY,
      byCli: { claude: cliLayer },
      sessions: [{ sessionId: 's1', layer: sessionLayer, cli: 'claude' }],
    });
    const point: AssignmentPoint = { kind: 'session', sessionId: 's1' };
    const state = stateOf([[point, assignmentAt(out, point)]]);
    for (const tool of TOOL_NAMES) {
      const today = todayRule(
        resolvePolicy(tool, {
          session: sessionLayer,
          cli: cliLayer,
          global: DEFAULT_TOOL_POLICY,
        }).policy,
      );
      expect(effectiveAt(state, point, tool), tool).toEqual(today);
    }
    expect(assignmentAt(out, point).exceptions).toEqual([
      { tool: 'read_screen', scope: { kind: 'anywhere' }, rule: { reach: 'any' } },
    ]);
  });

  it('default-equal global layer writes no default assignment', () => {
    const out = migrateLegacyPolicy({ global: DEFAULT_TOOL_POLICY, byCli: {}, sessions: [] });
    expect(out.assignments).toEqual([]);
    expect(out.migratedFrom).toBe('v0.64');
    expect(out.notes).toEqual({ onScreenOnlyOffered: [] });
  });

  it('CLI layer becomes a kind assignment', () => {
    const out = migrateLegacyPolicy({
      global: DEFAULT_TOOL_POLICY,
      byCli: { claude: { open_file: { access: 'off' } } },
      sessions: [],
    });
    expect(out.assignments).toEqual([
      {
        point: { kind: 'cli', cli: 'claude' },
        assignment: {
          profileId: 'worker',
          onScreenOnly: false,
          exceptions: [
            { tool: 'open_file', scope: { kind: 'anywhere' }, rule: { decision: 'deny' } },
          ],
        },
      },
    ]);
  });

  it('an empty layer writes no assignment', () => {
    const out = migrateLegacyPolicy({
      global: DEFAULT_TOOL_POLICY,
      byCli: { claude: {} },
      sessions: [{ sessionId: 's1', layer: {}, cli: 'claude' }],
    });
    expect(out.assignments).toEqual([]);
  });

  it('onScreenOnlyOffered lists the migrated leads', () => {
    const out = migrateLegacyPolicy({
      global: DEFAULT_TOOL_POLICY,
      byCli: {},
      sessions: [
        { sessionId: 's1', layer: allOnLayer(), cli: null },
        { sessionId: 's2', layer: { open_file: { access: 'off' } }, cli: null },
        { sessionId: 's3', layer: allOnLayer(), cli: null },
      ],
    });
    expect(out.notes.onScreenOnlyOffered).toEqual(['s1', 's3']);
  });
});

describe('exactness with a non-default global', () => {
  const global: GlobalPolicy = structuredClone(DEFAULT_TOOL_POLICY);
  global.read_screen.reach = 'any';
  global.focus_session.move = 'no';
  global.send_message.access = 'off';
  global.open_file.when = 'always';
  const claudeLayer: PolicyLayer = { send_input: { reach: 'self' } };
  const sessionLayer: PolicyLayer = { open_session: { access: 'on' } };
  const legacy: LegacyPolicy = {
    global,
    byCli: { claude: claudeLayer },
    sessions: [{ sessionId: 's1', layer: sessionLayer, cli: 'claude' }],
  };

  const points: Array<{ point: AssignmentPoint; layers: PolicyLayers }> = [
    { point: { kind: 'default' }, layers: { global } },
    { point: { kind: 'cli', cli: 'claude' }, layers: { cli: claudeLayer, global } },
    {
      point: { kind: 'session', sessionId: 's1' },
      layers: { session: sessionLayer, cli: claudeLayer, global },
    },
  ];

  it('every point resolves every tool and field exactly as today', () => {
    const out = migrateLegacyPolicy(legacy);
    const state = stateOf(points.map(({ point }) => [point, assignmentAt(out, point)]));
    for (const { point, layers } of points) {
      for (const tool of TOOL_NAMES) {
        expect(effectiveAt(state, point, tool), `${pointKey(point)} ${tool}`).toEqual(
          todayRule(resolvePolicy(tool, layers).policy),
        );
      }
    }
  });
});
