import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActivityIo } from '../../src/conduit-mcp/activity-log';
import {
  type PolicyFile,
  parsePolicyFile,
  serializeGrantsFile,
  serializePolicyFile,
} from '../../src/conduit-mcp/policy-file';
import { migrateLegacyPolicy } from '../../src/conduit-mcp/policy-migration';
import { OBSERVER } from '../../src/conduit-mcp/policy-profiles';
import {
  createPolicyService,
  type PolicyService,
  type PolicyServiceDeps,
} from '../../src/conduit-mcp/policy-service';
import type {
  AssignmentPoint,
  Exception,
  Grant,
  OneUseOverride,
  PolicyTarget,
  Principal,
  Profile,
  ProfileId,
} from '../../src/conduit-mcp/policy-types';
import type { RequestsIo } from '../../src/conduit-mcp/request-file-fs';
import { type CliKind, DEFAULT_TOOL_POLICY } from '../../src/conduit-mcp/tool-policy';

const DEFAULT_RULES = OBSERVER.rules;

vi.mock('../../src/conduit-mcp/policy-migration', () => ({
  migrateLegacyPolicy: vi.fn(() => ({
    assignments: [],
    migratedFrom: null,
    notes: { onScreenOnlyOffered: [] },
  })),
}));

const T0 = Date.parse('2026-11-14T12:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();
const MIN = 60_000;
const WRITE_MS = 250;

const target = (over: Partial<PolicyTarget> = {}): PolicyTarget => ({
  sessionId: null,
  path: null,
  folder: null,
  projectId: null,
  ...over,
});
const session = (over: Partial<Extract<Principal, { kind: 'session' }>> = {}): Principal => ({
  kind: 'session',
  sessionId: 's1',
  handle: 'alpha',
  launchedCli: null,
  homeFolder: '/work/app',
  projectId: 'p1',
  ...over,
});
const sessionRow = (sessionId: string) => ({ sessionId, launchedCli: null });

const policyText = (over: Partial<PolicyFile> = {}): string =>
  serializePolicyFile({
    version: 1,
    profiles: [],
    assignments: [],
    overrides: [],
    migratedFrom: null,
    notes: { onScreenOnlyOffered: [] },
    ...over,
  });

const grant = (over: Partial<Grant> = {}): Grant => ({
  id: 'g1',
  who: { kind: 'session', sessionId: 's1' },
  tool: 'open_session',
  on: { kind: 'anywhere' },
  for: 'until-revoked',
  anchorSessionId: null,
  createdAt: iso(T0),
  expiresAt: null,
  lastUsedAt: null,
  state: 'active',
  endedAt: null,
  requestId: null,
  ...over,
});

interface Opts {
  policy?: string | null;
  lastGood?: string | null;
  lastGoodReadThrows?: boolean;
  launchedCli?: Record<string, CliKind | null | undefined>;
  grants?: string | null;
  activityFails?: boolean;
  writeFails?: boolean;
}

function harness(o: Opts = {}) {
  let now = T0;
  let ids = 0;
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const policyWrites: string[] = [];
  const grantWrites: string[] = [];
  const rows: string[] = [];
  const warnings: string[] = [];
  let changed = 0;
  let legacyCalls = 0;

  const policyIo: RequestsIo = {
    read: () => o.policy ?? null,
    write: async (t) => {
      if (writeDown) throw new Error('disk full');
      policyWrites.push(t);
    },
  };
  const lastGoodWrites: string[] = [];
  const lastGoodIo: RequestsIo = {
    read: () => {
      if (o.lastGoodReadThrows) throw new Error('EIO');
      return o.lastGood ?? null;
    },
    write: async (t) => {
      if (writeDown) throw new Error('disk full');
      lastGoodWrites.push(t);
    },
  };
  const grantsIo: RequestsIo = {
    read: () => o.grants ?? null,
    write: async (t) => {
      if (writeDown) throw new Error('disk full');
      grantWrites.push(t);
    },
  };
  let activityDown = o.activityFails ?? false;
  let writeDown = o.writeFails ?? false;
  const activityIo: ActivityIo = {
    append: (_day, line) => {
      if (activityDown) throw new Error('activity disk full');
      rows.push(line);
    },
    list: () => [],
    remove: () => undefined,
    readArgs: () => null,
    writeArgs: () => undefined,
  };

  const deps: PolicyServiceDeps = {
    policyIo,
    lastGoodIo,
    grantsIo,
    activityIo,
    now: () => now,
    newId: () => `id${++ids}`,
    setTimer: (fn, ms) => {
      const t = { fn, ms };
      timers.push(t);
      return t;
    },
    clearTimer: (t) => {
      const i = timers.indexOf(t as { fn: () => void; ms: number });
      if (i >= 0) timers.splice(i, 1);
    },
    warn: (m) => {
      warnings.push(m);
    },
    legacy: () => {
      legacyCalls += 1;
      return { global: DEFAULT_TOOL_POLICY, byCli: {}, sessions: [] };
    },
    launchedCli: (id) => (o.launchedCli && id in o.launchedCli ? o.launchedCli[id] : null),
    onChanged: () => {
      changed += 1;
    },
  };
  const service: PolicyService = createPolicyService(deps);

  /** Runs the timers due at `ms`, the way the host's clock would. */
  const fire = (ms: number) => {
    for (const t of timers.filter((x) => x.ms === ms)) {
      timers.splice(timers.indexOf(t), 1);
      t.fn();
    }
  };
  const activityRows = () => rows.map((r) => JSON.parse(r) as Record<string, unknown>);

  return {
    service,
    deps,
    fire,
    policyWrites,
    lastGoodWrites,
    grantWrites,
    activityRows,
    warnings,
    timers,
    legacyCalls: () => legacyCalls,
    setActivityDown: (down: boolean) => {
      activityDown = down;
    },
    setWriteDown: (down: boolean) => {
      writeDown = down;
    },
    settle: async () => {
      for (let i = 0; i < 10; i++) await Promise.resolve();
    },
    changed: () => changed,
    advance: (ms: number) => {
      now += ms;
    },
    now: () => now,
  };
}

beforeEach(() => {
  vi.mocked(migrateLegacyPolicy).mockClear();
});

describe('policy service', () => {
  it.each([{ launchedCli: null }, { launchedCli: 'codex' as const }])(
    'projects session overrides against the launched CLI ($launchedCli)',
    (row) => {
      const h = harness({
        policy: policyText({
          assignments: [
            {
              point: { kind: 'cli', cli: 'claude' },
              assignment: { profileId: 'observer', exceptions: [], onScreenOnly: false },
            },
            {
              point: { kind: 'cli', cli: 'codex' },
              assignment: { profileId: 'worker', exceptions: [], onScreenOnly: false },
            },
            {
              point: { kind: 'session', sessionId: 's1' },
              assignment: { profileId: 'worker', exceptions: [], onScreenOnly: false },
            },
          ],
        }),
      });
      h.service.start();
      expect(h.service.ui([{ sessionId: 's1', ...row }]).legacy.sessions.s1).toEqual({});
    },
  );

  it("the launched CLI projection lowers onto that CLI's assignment when it differs from default", () => {
    const observer = { profileId: 'observer' as const, exceptions: [], onScreenOnly: false };
    const worker = { profileId: 'worker' as const, exceptions: [], onScreenOnly: false };
    const viaCli = harness({
      policy: policyText({
        assignments: [
          { point: { kind: 'cli', cli: 'claude' }, assignment: observer },
          { point: { kind: 'session', sessionId: 's1' }, assignment: worker },
        ],
      }),
    });
    viaCli.service.start();
    const viaDefault = harness({
      policy: policyText({
        assignments: [
          { point: { kind: 'default' }, assignment: observer },
          { point: { kind: 'session', sessionId: 's1' }, assignment: worker },
        ],
      }),
    });
    viaDefault.service.start();

    const layer = viaCli.service.ui([{ sessionId: 's1', launchedCli: 'claude' }]).legacy.sessions
      .s1;
    expect(Object.keys(layer ?? {}).length).toBeGreaterThan(0);
    expect(layer).toEqual(viaDefault.service.ui([sessionRow('s1')]).legacy.sessions.s1);
  });

  it('rejects a legacy patch for a scoped assignment without changing or writing policy', async () => {
    const h = harness({
      policy: policyText({
        assignments: [
          {
            point: { kind: 'default' },
            assignment: {
              profileId: 'worker',
              onScreenOnly: false,
              exceptions: [
                {
                  tool: 'open_file',
                  scope: { kind: 'folder', path: '/work/app' },
                  rule: { decision: 'deny' },
                },
              ],
            },
          },
        ],
      }),
    });
    h.service.start();
    const before = h.service.ui([]);
    const changed = h.changed();
    expect(
      h.service.applyLegacyPatch({ kind: 'default' }, null, 'open_file', { access: 'off' }),
    ).toEqual({ ok: false, error: 'scoped' });
    expect(h.service.ui([])).toEqual(before);
    expect(h.changed()).toBe(changed);
    h.fire(WRITE_MS);
    await h.service.stop();
    expect(h.policyWrites).toEqual([]);
  });

  it('a default edit reaches a session tweaked in the old dialog and leaves no override there', () => {
    const h = harness();
    h.service.start();
    expect(
      h.service.applyLegacyPatch(
        { kind: 'session', sessionId: 's1' },
        { kind: 'default' },
        'open_file',
        { access: 'off' },
      ),
    ).toEqual({ ok: true });
    expect(
      h.service.applyLegacyPatch({ kind: 'default' }, null, 'send_input', { access: 'on' }),
    ).toEqual({ ok: true });
    const ui = h.service.ui([{ sessionId: 's1', launchedCli: null }]);
    expect(ui.legacy.sessions.s1).toEqual({ open_file: { access: 'off' } });
    expect(ui.legacy.global.send_input).toEqual({ access: 'on' });
  });

  it('missing policy.json migrates from legacy and persists once', async () => {
    vi.mocked(migrateLegacyPolicy).mockReturnValueOnce({
      assignments: [
        {
          point: { kind: 'default' },
          assignment: { profileId: 'lead', exceptions: [], onScreenOnly: true },
        },
      ],
      migratedFrom: 'v0.64',
      notes: { onScreenOnlyOffered: [] },
    });
    const h = harness({ policy: null });
    h.service.start();
    expect(h.legacyCalls()).toBe(1);
    h.fire(WRITE_MS);
    await h.service.stop();

    expect(h.policyWrites).toHaveLength(1);
    const saved = parsePolicyFile(h.policyWrites[0] ?? '');
    expect(saved.ok && saved.file.migratedFrom).toBe('v0.64');
    expect(saved.ok && saved.file.assignments).toEqual([
      {
        point: { kind: 'default' },
        assignment: { profileId: 'lead', exceptions: [], onScreenOnly: true },
      },
    ]);
  });

  it('a migrated kind assignment writes one note row', () => {
    vi.mocked(migrateLegacyPolicy).mockReturnValueOnce({
      assignments: [
        {
          point: { kind: 'cli', cli: 'claude' },
          assignment: { profileId: 'lead', exceptions: [], onScreenOnly: true },
        },
        {
          point: { kind: 'default' },
          assignment: { profileId: 'lead', exceptions: [], onScreenOnly: true },
        },
      ],
      migratedFrom: 'v0.64',
      notes: { onScreenOnlyOffered: [] },
    });
    const h = harness({ policy: null });
    h.service.start();

    const notes = h.activityRows().filter((r) => r.action === 'migration');
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      lane: 'note',
      cli: 'claude',
      summary: 'kind rule for claude now applies only to sessions Conduit launched',
    });
  });

  it('newer policy.json → readOnly, never written', async () => {
    const newer = '{"version":99,"profiles":[],"assignments":[],"overrides":[]}';
    const h = harness({ policy: newer });
    h.service.start();

    expect(h.service.ui([]).readOnly).toBe(true);
    expect(h.warnings.length).toBeGreaterThan(0);
    expect(h.service.setAssignment({ kind: 'default' }, 'lead')).toEqual({
      ok: false,
      error: 'read-only',
    });
    h.service.decide({
      principal: session(),
      tool: 'list_sessions',
      targets: [],
      masterOn: true,
      toYou: false,
    });
    h.fire(WRITE_MS);
    await h.service.stop();
    expect(h.policyWrites).toEqual([]);
  });

  it('commit touches every matched grant and consumes an override; decide alone changes neither', async () => {
    const exception: Exception = {
      tool: 'open_session',
      scope: { kind: 'session', sessionId: 's9' },
      rule: { decision: 'deny' },
    };
    const override: OneUseOverride = {
      id: 'o1',
      sessionId: 's1',
      tool: 'open_session',
      target: target({ sessionId: 's9' }),
      createdAt: iso(T0),
    };
    const h = harness({
      policy: policyText({
        assignments: [
          {
            point: { kind: 'session', sessionId: 's1' },
            assignment: { profileId: 'worker', exceptions: [exception], onScreenOnly: false },
          },
        ],
        overrides: [override],
      }),
      grants: serializeGrantsFile({
        version: 1,
        grants: [
          grant({ id: 'g-s2', on: { kind: 'session', sessionId: 's2' } }),
          grant({ id: 'g-s3', on: { kind: 'session', sessionId: 's3' } }),
        ],
      }),
    });
    h.service.start();

    h.advance(5 * MIN);
    const usedInput = {
      principal: session(),
      tool: 'open_session' as const,
      targets: [target({ sessionId: 's2' }), target({ sessionId: 's3' })],
      masterOn: true,
      toYou: false,
    };
    const used = h.service.decide(usedInput);
    expect(used.decision).toBe('allow');
    expect(used.grantIds).toEqual(['g-s2', 'g-s3']);
    expect(h.service.ui([]).grants.map((g) => [g.id, g.lastUsedAt])).toEqual([
      ['g-s2', null],
      ['g-s3', null],
    ]);
    h.service.commit(usedInput, used);
    expect(h.service.ui([]).grants.map((g) => [g.id, g.lastUsedAt])).toEqual([
      ['g-s2', iso(h.now())],
      ['g-s3', iso(h.now())],
    ]);

    const passedInput = {
      principal: session(),
      tool: 'open_session' as const,
      targets: [target({ sessionId: 's9' })],
      masterOn: true,
      toYou: false,
    };
    const passed = h.service.decide(passedInput);
    expect(passed).toMatchObject({
      decision: 'allow',
      reason: { by: 'override', overrideId: 'o1' },
    });
    h.service.commit(passedInput, passed);

    const again = h.service.decide({
      principal: session(),
      tool: 'open_session',
      targets: [target({ sessionId: 's9' })],
      masterOn: true,
      toYou: false,
    });
    expect(again.decision).toBe('deny');

    h.fire(WRITE_MS);
    await h.service.stop();
    const saved = parsePolicyFile(h.policyWrites.at(-1) ?? '');
    expect(saved.ok && saved.file.overrides).toEqual([]);
  });

  it('sessionEnded expires grants and drops the session assignment', async () => {
    const h = harness({
      policy: policyText({
        assignments: [
          {
            point: { kind: 'session', sessionId: 's1' },
            assignment: { profileId: 'lead', exceptions: [], onScreenOnly: false },
          },
        ],
      }),
      grants: serializeGrantsFile({ version: 1, grants: [grant()] }),
    });
    h.service.start();
    expect(h.service.ui([sessionRow('s1')]).sessions.s1?.source).toBe('session');

    h.service.sessionEnded('s1');

    const ui = h.service.ui([sessionRow('s1')]);
    expect(ui.grants[0]?.state).toBe('expired');
    expect(ui.sessions.s1?.source).toBe('default');
    h.fire(WRITE_MS);
    await h.service.stop();
    const saved = parsePolicyFile(h.policyWrites.at(-1) ?? '');
    expect(saved.ok && saved.file.assignments).toEqual([]);
  });

  it('allowOnce on a remembered explicit deny creates a one-use override', () => {
    const exception: Exception = {
      tool: 'open_session',
      scope: { kind: 'anywhere' },
      rule: { decision: 'deny' },
    };
    const h = harness({
      policy: policyText({
        assignments: [
          {
            point: { kind: 'session', sessionId: 's1' },
            assignment: { profileId: 'worker', exceptions: [exception], onScreenOnly: false },
          },
        ],
      }),
    });
    h.service.start();
    const input = {
      principal: session(),
      tool: 'open_session' as const,
      targets: [target({ path: '/work/app/x' })],
      masterOn: true,
      toYou: false,
    };
    const denied = h.service.decide(input);
    expect(denied.reason.by).toBe('deny');
    const activityId = h.service.activity.record({
      lane: 'conduit',
      principal: { handle: 'alpha', sessionId: 's1', machineId: null },
      cli: null,
      action: 'open_session',
      target: null,
      summary: null,
      decision: 'deny',
      decidedBy: 'policy',
      outcome: 'denied',
      durationMs: null,
      requestId: null,
      count: null,
    });
    h.service.noteDecision(activityId, input, denied);

    expect(h.service.allowOnce(activityId)).toEqual({ ok: true });
    const passed = h.service.decide(input);
    expect(passed).toMatchObject({
      decision: 'allow',
      reason: { by: 'override' },
    });
    h.service.commit(input, passed);
    expect(h.service.decide(input).decision).toBe('deny');
  });

  it('allowOnce fires onChanged once when it saves an override, so tool lists re-sync', () => {
    const exception: Exception = {
      tool: 'open_session',
      scope: { kind: 'anywhere' },
      rule: { decision: 'deny' },
    };
    const h = harness({
      policy: policyText({
        assignments: [
          {
            point: { kind: 'session', sessionId: 's1' },
            assignment: { profileId: 'worker', exceptions: [exception], onScreenOnly: false },
          },
        ],
      }),
    });
    h.service.start();
    const input = {
      principal: session(),
      tool: 'open_session' as const,
      targets: [target({ path: '/work/app/x' })],
      masterOn: true,
      toYou: false,
    };
    const denied = h.service.decide(input);
    const activityId = h.service.activity.record({
      lane: 'conduit',
      principal: { handle: 'alpha', sessionId: 's1', machineId: null },
      cli: null,
      action: 'open_session',
      target: null,
      summary: null,
      decision: 'deny',
      decidedBy: 'policy',
      outcome: 'denied',
      durationMs: null,
      requestId: null,
      count: null,
    });
    h.service.noteDecision(activityId, input, denied);

    const before = h.changed();
    expect(h.service.allowOnce(activityId)).toEqual({ ok: true });
    expect(h.changed()).toBe(before + 1);
  });

  it('allowOnce on a floor deny → not-overridable', () => {
    const h = harness();
    h.service.start();
    const input = {
      principal: session(),
      tool: 'list_sessions' as const,
      targets: [],
      masterOn: false,
      toYou: false,
    };
    const denied = h.service.decide(input);
    expect(denied.reason).toEqual({ by: 'floor', floor: 'master-off' });
    const activityId = h.service.activity.record({
      lane: 'conduit',
      principal: { handle: 'alpha', sessionId: 's1', machineId: null },
      cli: null,
      action: 'list_sessions',
      target: null,
      summary: null,
      decision: 'deny',
      decidedBy: 'floor',
      outcome: 'denied',
      durationMs: null,
      requestId: null,
      count: null,
    });
    h.service.noteDecision(activityId, input, denied);

    expect(h.service.allowOnce(activityId)).toEqual({ ok: false, error: 'not-overridable' });
    expect(h.service.allowOnce('nope')).toEqual({ ok: false, error: 'not-found' });
  });

  it('activity write failure keeps local decisions working', () => {
    const h = harness({ activityFails: true });
    h.service.start();
    const row = {
      lane: 'conduit' as const,
      principal: { handle: 'alpha', sessionId: 's1', machineId: null },
      cli: null,
      action: 'open_session',
      target: null,
      summary: null,
      decision: 'allow' as const,
      decidedBy: 'profile',
      outcome: 'ok' as const,
      durationMs: null,
      requestId: null,
      count: null,
    };
    h.service.activity.record(row);
    expect(h.service.activity.writable()).toBe(false);
    expect(h.warnings.filter((m) => m.includes('activity'))).toHaveLength(1);

    expect(
      h.service.decide({
        principal: session(),
        tool: 'list_sessions',
        targets: [],
        masterOn: true,
        toYou: false,
      }).decision,
    ).toBe('allow');

    h.setActivityDown(false);
    h.service.activity.record(row);
    expect(h.activityRows().map((r) => r.lane)).toEqual(['note', 'conduit']);
    expect(h.activityRows()[0]).toMatchObject({ action: 'gap' });
  });

  it('createGrant returns null when the scope cannot bind', async () => {
    const h = harness();
    h.service.start();
    const homeless = session({ homeFolder: null });

    expect(
      h.service.createGrant(
        { who: 'session', on: 'target', for: '1h' },
        homeless,
        'open_file',
        target(),
        null,
      ),
    ).toBeNull();
    h.fire(WRITE_MS);
    await h.service.stop();
    expect(h.grantWrites).toEqual([]);
  });

  it('ui labels a migrated lead "Lead +1"', () => {
    vi.mocked(migrateLegacyPolicy).mockReturnValueOnce({
      assignments: [
        {
          point: { kind: 'default' },
          assignment: { profileId: 'lead', exceptions: [], onScreenOnly: true },
        },
      ],
      migratedFrom: 'v0.64',
      notes: { onScreenOnlyOffered: ['s1'] },
    });
    const h = harness({ policy: null });
    h.service.start();

    const ui = h.service.ui([sessionRow('s1')]);
    expect(ui.sessions.s1).toEqual({
      profileId: 'lead',
      profileName: 'Lead',
      exceptions: 1,
      source: 'default',
      label: 'Lead +1',
    });
    expect(ui.profiles.map((p) => p.id)).toEqual(['observer', 'worker', 'lead']);
  });

  it('stop flushes the current hour of counts', async () => {
    const h = harness();
    h.service.start();
    h.service.activity.record({
      lane: 'conduit',
      principal: { handle: 'alpha', sessionId: 's1', machineId: null },
      cli: null,
      action: 'list_sessions',
      target: null,
      summary: null,
      decision: 'allow',
      decidedBy: 'counted',
      outcome: 'ok',
      durationMs: null,
      requestId: null,
      count: null,
    });
    expect(h.activityRows()).toEqual([]);

    await h.service.stop();

    const counted = h.activityRows().filter((r) => r.action === 'list_sessions');
    expect(counted).toHaveLength(1);
    expect(counted[0]).toMatchObject({ count: 1, lane: 'conduit' });
  });

  it('setAssignment rejects an unknown profile and removes the assignment on null', () => {
    const h = harness({
      policy: policyText({
        assignments: [
          {
            point: { kind: 'session', sessionId: 's1' },
            assignment: { profileId: 'worker', exceptions: [], onScreenOnly: false },
          },
        ],
      }),
    });
    h.service.start();
    expect(h.service.setAssignment({ kind: 'session', sessionId: 's1' }, 'p-missing')).toEqual({
      ok: false,
      error: 'unknown-profile',
    });
    expect(h.service.ui([sessionRow('s1')]).sessions.s1?.source).toBe('session');

    expect(h.service.setAssignment({ kind: 'session', sessionId: 's1' }, null)).toEqual({
      ok: true,
    });
    expect(h.service.ui([sessionRow('s1')]).sessions.s1?.source).toBe('default');
    expect(h.changed()).toBe(1);
  });

  it('a failed write warns and keeps the decision state', async () => {
    const h = harness({ writeFails: true });
    h.service.start();
    h.service.setAssignment({ kind: 'default' }, 'lead');
    h.fire(WRITE_MS);
    await h.service.stop();

    expect(h.warnings.some((m) => m.includes('policy.json'))).toBe(true);
    expect(h.service.ui([sessionRow('s1')]).sessions.s1?.profileId).toBe('lead');
  });

  it('revokeGrant ends a grant once and persists it', async () => {
    const h = harness({
      grants: serializeGrantsFile({ version: 1, grants: [grant({ id: 'g-keep' })] }),
    });
    h.service.start();
    expect(h.service.revokeGrant('g-keep')).toBe(true);
    expect(h.service.revokeGrant('g-keep')).toBe(false);
    expect(h.service.ui([]).grants[0]?.state).toBe('revoked');
    await h.service.stop();
    expect(h.grantWrites).toHaveLength(1);
  });

  it('peerRevoked ends that peer grants, persists once, and notifies only when one changed', async () => {
    const h = harness({
      grants: serializeGrantsFile({
        version: 1,
        grants: [
          grant({ id: 'g-peer', who: { kind: 'peer', machineId: 'm-1' } }),
          grant({ id: 'g-other', who: { kind: 'peer', machineId: 'm-2' } }),
        ],
      }),
    });
    h.service.start();
    const before = h.changed();
    h.service.peerRevoked('m-1');
    expect(h.changed()).toBe(before + 1);
    const states = Object.fromEntries(h.service.ui([]).grants.map((g) => [g.id, g.state]));
    expect(states).toEqual({ 'g-peer': 'revoked', 'g-other': 'active' });
    h.service.peerRevoked('m-1');
    expect(h.changed()).toBe(before + 1);
    await h.service.stop();
    expect(h.grantWrites).toHaveLength(1);
  });

  it('allowOnce overrides the denied target on a multi-target call', () => {
    const folderDeny: Exception = {
      tool: 'open_file',
      scope: { kind: 'folder', path: '/w/b' },
      rule: { decision: 'deny' },
    };
    const h = harness({
      policy: policyText({
        assignments: [
          {
            point: { kind: 'session', sessionId: 's1' },
            assignment: { profileId: 'worker', exceptions: [folderDeny], onScreenOnly: false },
          },
        ],
      }),
    });
    h.service.start();
    const input = {
      principal: session(),
      tool: 'open_file' as const,
      targets: [
        target({ path: '/w/a/x.ts', folder: '/w/a' }),
        target({ path: '/w/b/y.ts', folder: '/w/b' }),
      ],
      masterOn: true,
      toYou: false,
    };
    const denied = h.service.decide(input);
    expect(denied.reason.by).toBe('deny');
    const activityId = h.service.activity.record({
      lane: 'conduit',
      principal: { handle: 'alpha', sessionId: 's1', machineId: null },
      cli: null,
      action: 'open_file',
      target: null,
      summary: null,
      decision: 'deny',
      decidedBy: 'policy',
      outcome: 'denied',
      durationMs: null,
      requestId: null,
      count: null,
    });
    h.service.noteDecision(activityId, input, denied);

    expect(h.service.allowOnce(activityId)).toEqual({ ok: true });
    expect(h.service.decide(input)).toMatchObject({
      decision: 'allow',
      reason: { by: 'override' },
    });
  });

  it('allowOnce is single-use per denial', () => {
    const exception: Exception = {
      tool: 'open_session',
      scope: { kind: 'anywhere' },
      rule: { decision: 'deny' },
    };
    const h = harness({
      policy: policyText({
        assignments: [
          {
            point: { kind: 'session', sessionId: 's1' },
            assignment: { profileId: 'worker', exceptions: [exception], onScreenOnly: false },
          },
        ],
      }),
    });
    h.service.start();
    const input = {
      principal: session(),
      tool: 'open_session' as const,
      targets: [target({ sessionId: 's2' })],
      masterOn: true,
      toYou: false,
    };
    const denied = h.service.decide(input);
    const activityId = h.service.activity.record({
      lane: 'conduit',
      principal: { handle: 'alpha', sessionId: 's1', machineId: null },
      cli: null,
      action: 'open_session',
      target: null,
      summary: null,
      decision: 'deny',
      decidedBy: 'policy',
      outcome: 'denied',
      durationMs: null,
      requestId: null,
      count: null,
    });
    h.service.noteDecision(activityId, input, denied);

    expect(h.service.allowOnce(activityId)).toEqual({ ok: true });
    expect(h.service.allowOnce(activityId)).toEqual({ ok: false, error: 'not-found' });
  });

  it('sessionEnded also removes that session overrides and remembered denies', async () => {
    const denyAll: Exception = {
      tool: 'open_session',
      scope: { kind: 'anywhere' },
      rule: { decision: 'deny' },
    };
    const h = harness({
      policy: policyText({
        assignments: [
          {
            point: { kind: 'session', sessionId: 's1' },
            assignment: { profileId: 'worker', exceptions: [denyAll], onScreenOnly: false },
          },
        ],
        overrides: [
          {
            id: 'o-s1',
            sessionId: 's1',
            tool: 'open_session',
            target: target({ sessionId: 's7' }),
            createdAt: iso(T0),
          },
          {
            id: 'o-s9',
            sessionId: 's9',
            tool: 'open_session',
            target: target({ sessionId: 's2' }),
            createdAt: iso(T0),
          },
        ],
      }),
    });
    h.service.start();
    const input = {
      principal: session(),
      tool: 'open_session' as const,
      targets: [target({ sessionId: 's2' })],
      masterOn: true,
      toYou: false,
    };
    const denied = h.service.decide(input);
    const activityId = h.service.activity.record({
      lane: 'conduit',
      principal: { handle: 'alpha', sessionId: 's1', machineId: null },
      cli: null,
      action: 'open_session',
      target: null,
      summary: null,
      decision: 'deny',
      decidedBy: 'policy',
      outcome: 'denied',
      durationMs: null,
      requestId: null,
      count: null,
    });
    h.service.noteDecision(activityId, input, denied);
    h.service.sessionEnded('s1');
    expect(h.service.allowOnce(activityId)).toEqual({ ok: false, error: 'not-overridable' });
    h.fire(WRITE_MS);
    await h.service.stop();
    const saved = parsePolicyFile(h.policyWrites.at(-1) ?? '');
    expect(saved.ok && saved.file.overrides.map((o) => o.id)).toEqual(['o-s9']);
  });

  it('no timers remain after stop', async () => {
    const h = harness({
      grants: serializeGrantsFile({ version: 1, grants: [grant({ id: 'g-x' })] }),
    });
    h.service.start();
    expect(h.timers.length).toBeGreaterThan(0);
    await h.service.stop();
    expect(h.timers).toEqual([]);
    h.service.decide({
      principal: session(),
      tool: 'list_sessions',
      targets: [],
      masterOn: true,
      toYou: false,
    });
    h.service.revokeGrant('g-x');
    expect(h.timers).toEqual([]);
  });

  it('corrupt policy.json is never written', async () => {
    const h = harness({ policy: '{not json' });
    h.service.start();
    expect(h.service.setAssignment({ kind: 'default' }, 'lead')).toEqual({
      ok: false,
      error: 'read-only',
    });
    expect(
      h.service.applyLegacyPatch({ kind: 'default' }, null, 'list_sessions', { access: 'off' }),
    ).toEqual({
      ok: false,
      error: 'read-only',
    });
    h.service.sessionEnded('s1');
    h.service.decide({
      principal: session(),
      tool: 'list_sessions',
      targets: [],
      masterOn: true,
      toYou: false,
    });
    h.fire(WRITE_MS);
    await h.service.stop();
    expect(h.policyWrites).toEqual([]);
    expect(h.service.ui([]).readOnly).toBe(true);
  });

  it('newer grants.json is never written', async () => {
    const h = harness({ grants: '{"version":99,"grants":[]}' });
    h.service.start();
    const created = h.service.createGrant(
      { who: 'session', on: 'anywhere', for: 'until-revoked' },
      session(),
      'open_session',
      target(),
      null,
    );
    expect(created).not.toBeNull();
    expect(h.service.revokeGrant(created?.id ?? '')).toBe(true);
    h.service.decide({
      principal: session(),
      tool: 'open_session',
      targets: [target()],
      masterOn: true,
      toYou: false,
    });
    h.fire(WRITE_MS);
    await h.service.stop();
    expect(h.grantWrites).toEqual([]);
    expect(h.warnings.some((m) => m.includes('grants.json'))).toBe(true);
  });

  it.each([
    ['unreadable', '{not json'],
    ['newer', '{"version":99,"profiles":[],"assignments":[],"overrides":[]}'],
  ])('a %s policy.json loads the last-good copy, read-only', async (_kind, policy) => {
    const good = policyText({
      assignments: [
        {
          point: { kind: 'session', sessionId: 's1' },
          assignment: { profileId: 'observer', exceptions: [], onScreenOnly: false },
        },
      ],
    });
    const h = harness({ policy, lastGood: good });
    h.service.start();

    expect(h.service.ui([sessionRow('s1')]).sessions.s1?.profileId).toBe('observer');
    expect(h.service.ui([sessionRow('s1')]).readOnly).toBe(true);
    expect(migrateLegacyPolicy).not.toHaveBeenCalled();
    const notes = h.activityRows().filter((r) => r.action === 'policy-unreadable');
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      lane: 'note',
      summary: 'Permissions file unreadable; using the last saved copy',
    });
    h.fire(WRITE_MS);
    await h.service.stop();
    expect(h.policyWrites).toEqual([]);
    expect(h.lastGoodWrites).toEqual([]);
  });

  it('an unreadable policy.json with no good copy makes every session Observer, read-only', async () => {
    const h = harness({ policy: '{not json', lastGood: null });
    h.service.start();

    expect(migrateLegacyPolicy).not.toHaveBeenCalled();
    expect(h.service.ui([sessionRow('s1')]).sessions.s1?.profileId).toBe('observer');
    expect(h.service.ui([sessionRow('s1')]).readOnly).toBe(true);
    expect(
      h.service.decide({
        principal: session(),
        tool: 'open_session',
        targets: [],
        masterOn: true,
        toYou: false,
      }).decision,
    ).toBe('deny');
    h.fire(WRITE_MS);
    await h.service.stop();
    expect(h.policyWrites).toEqual([]);
    expect(h.lastGoodWrites).toEqual([]);
  });

  it('a successful load and a save each write the last-good copy', async () => {
    const h = harness({ policy: policyText() });
    h.service.start();
    h.fire(WRITE_MS);
    expect(h.lastGoodWrites).toHaveLength(1);
    expect(parsePolicyFile(h.lastGoodWrites[0] ?? '').ok).toBe(true);

    expect(h.service.setAssignment({ kind: 'default' }, 'lead')).toEqual({ ok: true });
    h.fire(WRITE_MS);
    await h.settle();
    const last = h.lastGoodWrites.at(-1) ?? '';
    expect(parsePolicyFile(last)).toMatchObject({
      ok: true,
      file: { assignments: [{ point: { kind: 'default' }, assignment: { profileId: 'lead' } }] },
    });
    await h.service.stop();
  });

  it('a grant revoked between decide and commit refuses the commit', () => {
    const h = harness({
      grants: serializeGrantsFile({
        version: 1,
        grants: [grant({ id: 'g-s2', on: { kind: 'session', sessionId: 's2' } })],
      }),
    });
    h.service.start();
    const input = {
      principal: session(),
      tool: 'open_session' as const,
      targets: [target({ sessionId: 's2' })],
      masterOn: true,
      toYou: false,
    };
    const decision = h.service.decide(input);
    expect(decision).toMatchObject({ decision: 'allow', grantIds: ['g-s2'] });
    expect(h.service.revokeGrant('g-s2')).toBe(true);
    expect(h.service.commit(input, decision)).toBeNull();
  });

  it('a revoked grant refuses the commit even when another grant still allows the call', () => {
    const h = harness({
      grants: serializeGrantsFile({
        version: 1,
        grants: [
          grant({ id: 'g-a', on: { kind: 'session', sessionId: 's2' } }),
          grant({ id: 'g-b', on: { kind: 'session', sessionId: 's2' } }),
        ],
      }),
    });
    h.service.start();
    const input = {
      principal: session(),
      tool: 'open_session' as const,
      targets: [target({ sessionId: 's2' })],
      masterOn: true,
      toYou: false,
    };
    const decision = h.service.decide(input);
    expect(decision.decision).toBe('allow');
    expect(decision.grantIds).toEqual(['g-a']);
    expect(h.service.revokeGrant('g-a')).toBe(true);
    expect(h.service.decide(input).decision).toBe('allow');
    expect(h.service.commit(input, decision)).toBeNull();
  });

  it('a deny exception added between decide and commit refuses the commit', () => {
    const h = harness();
    h.service.start();
    expect(
      h.service.applyLegacyPatch({ kind: 'default' }, null, 'open_session', { access: 'on' }),
    ).toEqual({ ok: true });
    const input = {
      principal: session(),
      tool: 'open_session' as const,
      targets: [],
      masterOn: true,
      toYou: false,
    };
    const decision = h.service.decide(input);
    expect(decision.decision).toBe('allow');
    expect(
      h.service.applyLegacyPatch(
        { kind: 'session', sessionId: 's1' },
        { kind: 'default' },
        'open_session',
        { access: 'off' },
      ),
    ).toEqual({ ok: true });
    expect(h.service.commit(input, decision)).toBeNull();
  });

  it('a commit whose fresh decide still allows goes through, and an ask still commits', () => {
    const h = harness();
    h.service.start();
    const input = {
      principal: session(),
      tool: 'open_session' as const,
      targets: [],
      masterOn: true,
      toYou: false,
    };
    const asked = h.service.decide(input);
    expect(asked.decision).toBe('ask');
    expect(h.service.commit(input, asked)).toEqual([]);
  });

  it('allowOnce does not duplicate an existing override', async () => {
    const exception: Exception = {
      tool: 'open_file',
      scope: { kind: 'anywhere' },
      rule: { decision: 'deny' },
    };
    const h = harness({
      policy: policyText({
        assignments: [
          {
            point: { kind: 'session', sessionId: 's1' },
            assignment: { profileId: 'worker', exceptions: [exception], onScreenOnly: false },
          },
        ],
      }),
    });
    h.service.start();
    const input = {
      principal: session(),
      tool: 'open_file' as const,
      targets: [target({ path: 'C:/Work/X.ts', folder: 'C:/Work' })],
      masterOn: true,
      toYou: false,
    };
    const first = h.service.activity.record({
      lane: 'conduit',
      principal: { handle: 'alpha', sessionId: 's1', machineId: null },
      cli: null,
      action: 'open_session',
      target: null,
      summary: null,
      decision: 'deny',
      decidedBy: 'policy',
      outcome: 'denied',
      durationMs: null,
      requestId: null,
      count: null,
    });
    const second = h.service.activity.record({
      lane: 'conduit',
      principal: { handle: 'alpha', sessionId: 's1', machineId: null },
      cli: null,
      action: 'open_session',
      target: null,
      summary: null,
      decision: 'deny',
      decidedBy: 'policy',
      outcome: 'denied',
      durationMs: null,
      requestId: null,
      count: null,
    });
    h.service.noteDecision(first, input, h.service.decide(input));
    const equivalent = { ...input, targets: [target({ path: 'c:/work/x.ts', folder: 'c:/work' })] };
    h.service.noteDecision(second, equivalent, h.service.decide(equivalent));

    expect(h.service.allowOnce(first)).toEqual({ ok: true });
    expect(h.service.allowOnce(second)).toEqual({ ok: true });
    expect(h.service.allowOnce(second)).toEqual({ ok: false, error: 'not-found' });
    h.fire(WRITE_MS);
    await h.service.stop();
    const saved = parsePolicyFile(h.policyWrites.at(-1) ?? '');
    expect(saved.ok && saved.file.overrides).toHaveLength(1);
  });

  it('commit consumes every override the call passed', async () => {
    const folderDeny = (path: string): Exception => ({
      tool: 'open_file',
      scope: { kind: 'folder', path },
      rule: { decision: 'deny' },
    });
    const override = (id: string, path: string): OneUseOverride => ({
      id,
      sessionId: 's1',
      tool: 'open_file',
      target: target({ path, folder: path.slice(0, path.lastIndexOf('/')) }),
      createdAt: iso(T0),
    });
    const h = harness({
      policy: policyText({
        assignments: [
          {
            point: { kind: 'session', sessionId: 's1' },
            assignment: {
              profileId: 'worker',
              exceptions: [folderDeny('/w/a'), folderDeny('/w/b')],
              onScreenOnly: false,
            },
          },
        ],
        overrides: [override('oa', '/w/a/x.ts'), override('ob', '/w/b/y.ts')],
      }),
    });
    h.service.start();
    const input = {
      principal: session(),
      tool: 'open_file' as const,
      targets: [
        target({ path: '/w/a/x.ts', folder: '/w/a' }),
        target({ path: '/w/b/y.ts', folder: '/w/b' }),
      ],
      masterOn: true,
      toYou: false,
    };
    const passed = h.service.decide(input);
    expect(passed).toMatchObject({ decision: 'allow', overrideIds: ['oa', 'ob'] });
    h.service.commit(input, passed);
    expect(h.service.decide(input).decision).toBe('deny');
    h.fire(WRITE_MS);
    await h.service.stop();
    const saved = parsePolicyFile(h.policyWrites.at(-1) ?? '');
    expect(saved.ok && saved.file.overrides).toEqual([]);
  });

  it('a second commit of an already spent override is refused and touches no grant', () => {
    const exception: Exception = {
      tool: 'open_session',
      scope: { kind: 'session', sessionId: 's9' },
      rule: { decision: 'deny' },
    };
    const override: OneUseOverride = {
      id: 'o1',
      sessionId: 's1',
      tool: 'open_session',
      target: target({ sessionId: 's9' }),
      createdAt: iso(T0),
    };
    const h = harness({
      policy: policyText({
        assignments: [
          {
            point: { kind: 'session', sessionId: 's1' },
            assignment: { profileId: 'worker', exceptions: [exception], onScreenOnly: false },
          },
        ],
        overrides: [override],
      }),
      grants: serializeGrantsFile({
        version: 1,
        grants: [grant({ id: 'g-s2', on: { kind: 'session', sessionId: 's2' } })],
      }),
    });
    h.service.start();
    const input = {
      principal: session(),
      tool: 'open_session' as const,
      targets: [target({ sessionId: 's9' }), target({ sessionId: 's2' })],
      masterOn: true,
      toYou: false,
    };
    const first = h.service.decide(input);
    const second = h.service.decide(input);
    expect(first).toMatchObject({ decision: 'allow', overrideIds: ['o1'], grantIds: ['g-s2'] });
    expect(second).toMatchObject({ decision: 'allow', overrideIds: ['o1'], grantIds: ['g-s2'] });

    expect(h.service.commit(input, first)).not.toBeNull();
    const afterFirst = h.service.ui([]).grants.map((g) => [g.id, g.lastUsedAt]);
    h.advance(MIN);
    expect(h.service.commit(input, second)).toBeNull();
    expect(h.service.ui([]).grants.map((g) => [g.id, g.lastUsedAt])).toEqual(afterFirst);
    expect(h.service.decide(input).decision).toBe('deny');
  });

  it('decide changes nothing; commit removes an override once and fires onChanged only then', () => {
    const override: OneUseOverride = {
      id: 'oa',
      sessionId: 's1',
      tool: 'open_file',
      target: target({ path: '/w/a/x.ts', folder: '/w/a' }),
      createdAt: iso(T0),
    };
    const h = harness({
      policy: policyText({
        assignments: [
          {
            point: { kind: 'session', sessionId: 's1' },
            assignment: {
              profileId: 'worker',
              onScreenOnly: false,
              exceptions: [
                {
                  tool: 'open_file',
                  scope: { kind: 'folder', path: '/w/a' },
                  rule: { decision: 'deny' },
                },
              ],
            },
          },
        ],
        overrides: [override],
      }),
    });
    h.service.start();
    const input = {
      principal: session(),
      tool: 'open_file' as const,
      targets: [target({ path: '/w/a/x.ts', folder: '/w/a' })],
      masterOn: true,
      toYou: false,
    };
    const before = h.changed();
    const first = h.service.decide(input);
    expect(first).toMatchObject({ decision: 'allow', overrideIds: ['oa'] });
    expect(h.service.decide(input)).toMatchObject({ decision: 'allow', overrideIds: ['oa'] });
    expect(h.changed()).toBe(before);

    h.service.commit(input, first);
    expect(h.changed()).toBe(before + 1);
    h.service.commit(input, first);
    expect(h.changed()).toBe(before + 1);
    expect(h.service.decide(input).decision).toBe('deny');
  });

  it('commit returns the override records it removed, and null once they are spent', () => {
    const override: OneUseOverride = {
      id: 'oa',
      sessionId: 's1',
      tool: 'open_file',
      target: target({ path: '/w/a/x.ts', folder: '/w/a' }),
      createdAt: iso(T0),
    };
    const h = harness({
      policy: policyText({
        assignments: [
          {
            point: { kind: 'session', sessionId: 's1' },
            assignment: {
              profileId: 'worker',
              onScreenOnly: false,
              exceptions: [
                {
                  tool: 'open_file',
                  scope: { kind: 'folder', path: '/w/a' },
                  rule: { decision: 'deny' },
                },
              ],
            },
          },
        ],
        overrides: [override],
      }),
    });
    h.service.start();
    const input = {
      principal: session(),
      tool: 'open_file' as const,
      targets: [target({ path: '/w/a/x.ts', folder: '/w/a' })],
      masterOn: true,
      toYou: false,
    };
    const first = h.service.decide(input);
    expect(h.service.commit(input, first)).toEqual([override]);
    expect(h.service.commit(input, first)).toBeNull();
  });

  it('a held override passes the still-saved check after its commit removed it, and only grants are touched', () => {
    const h = harness({
      policy: policyText({
        assignments: [
          {
            point: { kind: 'session', sessionId: 's1' },
            assignment: {
              profileId: 'worker',
              onScreenOnly: false,
              exceptions: [
                {
                  tool: 'open_session',
                  scope: { kind: 'session', sessionId: 's9' },
                  rule: { decision: 'deny' },
                },
              ],
            },
          },
        ],
        overrides: [
          {
            id: 'o1',
            sessionId: 's1',
            tool: 'open_session',
            target: target({ sessionId: 's9' }),
            createdAt: iso(T0),
          },
        ],
      }),
      grants: serializeGrantsFile({
        version: 1,
        grants: [grant({ id: 'g-s2', on: { kind: 'session', sessionId: 's2' } })],
      }),
    });
    h.service.start();
    const input = {
      principal: session(),
      tool: 'open_session' as const,
      targets: [target({ sessionId: 's9' }), target({ sessionId: 's2' })],
      masterOn: true,
      toYou: false,
    };
    const removed = h.service.commit(input, h.service.decide(input));
    expect(removed).toEqual([expect.objectContaining({ id: 'o1' })]);

    h.advance(MIN);
    const answer = h.service.decide({ ...input, heldOverrides: removed ?? [] });
    expect(answer).toMatchObject({ decision: 'allow', overrideIds: ['o1'], grantIds: ['g-s2'] });
    const before = h.changed();
    expect(h.service.commit(input, answer, removed ?? [])).toEqual([]);
    expect(h.changed()).toBe(before);
    expect(h.service.ui([]).grants.map((g) => [g.id, g.lastUsedAt])).toEqual([
      ['g-s2', iso(h.now())],
    ]);
  });

  it('committing a held override leaves a saved override for the same target', () => {
    const saved: OneUseOverride = {
      id: 'o2',
      sessionId: 's1',
      tool: 'open_session',
      target: target({ sessionId: 's9' }),
      createdAt: iso(T0),
    };
    const held: OneUseOverride = { ...saved, id: 'o1' };
    const h = harness({
      policy: policyText({
        assignments: [
          {
            point: { kind: 'session', sessionId: 's1' },
            assignment: {
              profileId: 'worker',
              onScreenOnly: false,
              exceptions: [
                {
                  tool: 'open_session',
                  scope: { kind: 'session', sessionId: 's9' },
                  rule: { decision: 'deny' },
                },
              ],
            },
          },
        ],
        overrides: [saved],
      }),
    });
    h.service.start();
    const input = {
      principal: session(),
      tool: 'open_session' as const,
      targets: [target({ sessionId: 's9' })],
      masterOn: true,
      toYou: false,
    };
    const answer = h.service.decide({ ...input, heldOverrides: [held] });
    expect(answer).toMatchObject({ decision: 'allow', overrideIds: ['o1'] });
    expect(h.service.commit(input, answer, [held])).toEqual([]);
    expect(h.service.decide(input)).toMatchObject({ decision: 'allow', overrideIds: ['o2'] });
  });

  it('retains a passed override when another target is denied by the profile', async () => {
    const override: OneUseOverride = {
      id: 'oa',
      sessionId: 's1',
      tool: 'open_file',
      target: target({ path: '/w/a/x.ts', folder: '/w/a' }),
      createdAt: iso(T0),
    };
    const h = harness({
      policy: policyText({
        assignments: [
          {
            point: { kind: 'session', sessionId: 's1' },
            assignment: {
              profileId: 'observer',
              onScreenOnly: false,
              exceptions: [
                {
                  tool: 'open_file',
                  scope: { kind: 'folder', path: '/w/a' },
                  rule: { decision: 'deny' },
                },
              ],
            },
          },
        ],
        overrides: [override],
      }),
    });
    h.service.start();
    const input = {
      principal: session(),
      tool: 'open_file' as const,
      targets: [
        target({ path: '/w/a/x.ts', folder: '/w/a' }),
        target({ path: '/w/b/y.ts', folder: '/w/b' }),
      ],
      masterOn: true,
      toYou: false,
    };
    expect(h.service.decide(input)).toMatchObject({ decision: 'deny', overrideIds: [] });
    expect(h.service.setAssignment({ kind: 'session', sessionId: 's1' }, 'worker')).toEqual({
      ok: true,
    });
    h.fire(WRITE_MS);
    await h.service.stop();
    const saved = parsePolicyFile(h.policyWrites.at(-1) ?? '');
    expect(saved.ok && saved.file.overrides).toEqual([override]);
  });

  it('commit consumes a passed override when another target asks', () => {
    const h = harness({
      policy: policyText({
        assignments: [
          {
            point: { kind: 'session', sessionId: 's1' },
            assignment: {
              profileId: 'worker',
              onScreenOnly: false,
              exceptions: [
                {
                  tool: 'open_file',
                  scope: { kind: 'folder', path: '/w/a' },
                  rule: { decision: 'deny' },
                },
                {
                  tool: 'open_file',
                  scope: { kind: 'folder', path: '/w/b' },
                  rule: { decision: 'ask' },
                },
              ],
            },
          },
        ],
        overrides: [
          {
            id: 'oa',
            sessionId: 's1',
            tool: 'open_file',
            target: target({ path: '/w/a/x.ts', folder: '/w/a' }),
            createdAt: iso(T0),
          },
        ],
      }),
    });
    h.service.start();
    const input = {
      principal: session(),
      tool: 'open_file' as const,
      targets: [
        target({ path: '/w/a/x.ts', folder: '/w/a' }),
        target({ path: '/w/b/y.ts', folder: '/w/b' }),
      ],
      masterOn: true,
      toYou: false,
    };
    const asked = h.service.decide(input);
    expect(asked).toMatchObject({ decision: 'ask', overrideIds: ['oa'] });
    h.service.commit(input, asked);
    expect(h.service.decide(input).decision).toBe('deny');
  });

  it('a failing disk warns once per outage', async () => {
    const h = harness({ writeFails: true });
    h.service.start();
    h.service.setAssignment({ kind: 'default' }, 'lead');
    const saveFailures = () => h.warnings.filter((m) => m.includes('policy.json'));
    for (let i = 0; i < 3; i++) {
      h.fire(WRITE_MS);
      await h.settle();
    }
    expect(saveFailures()).toHaveLength(1);

    h.setWriteDown(false);
    h.fire(WRITE_MS);
    await h.settle();
    expect(h.policyWrites).toHaveLength(1);

    h.setWriteDown(true);
    h.service.setAssignment({ kind: 'default' }, 'worker');
    h.fire(WRITE_MS);
    await h.settle();
    expect(saveFailures()).toHaveLength(2);
    await h.service.stop();
  });

  it('a failed save is retried until it succeeds', async () => {
    const h = harness({ writeFails: true });
    h.service.start();
    h.service.setAssignment({ kind: 'default' }, 'lead');
    h.fire(WRITE_MS);
    await h.settle();
    expect(h.warnings.filter((m) => m.includes('policy.json'))).toHaveLength(1);

    h.setWriteDown(false);
    h.fire(WRITE_MS);
    await h.settle();
    expect(h.policyWrites).toHaveLength(1);
    await h.service.stop();
  });
});

describe('fail-closed and missing profile', () => {
  const peer: Principal = {
    kind: 'remote',
    handle: 'claude-3',
    machineId: 'm-0000000a',
    trust: 'own',
    controller: false,
    capabilities: { messaging: true, monitor: true, drive: true },
  };

  it('with no saved copy, a peer decides as Observer, not as the default peer assignment', () => {
    const closed = harness({ policy: '{not json', lastGood: null });
    closed.service.start();
    const open = harness({ policy: policyText() });
    open.service.start();
    const input = {
      principal: peer,
      tool: 'open_file' as const,
      targets: [],
      masterOn: true,
      toYou: false,
    };
    expect(open.service.decide(input).decision).not.toBe('deny');
    expect(closed.service.decide(input).decision).toBe('deny');
  });

  it('a profile change keeps the session pins in the persisted file', async () => {
    const h = harness({
      policy: policyText({
        assignments: [
          {
            point: { kind: 'session', sessionId: 's1' },
            assignment: {
              profileId: 'worker',
              exceptions: [],
              onScreenOnly: false,
              pinned: ['open_file.access'],
            },
          },
        ],
      }),
    });
    h.service.start();
    expect(h.service.setAssignment({ kind: 'session', sessionId: 's1' }, 'observer')).toEqual({
      ok: true,
    });
    h.fire(WRITE_MS);
    await h.service.stop();
    const saved = h.policyWrites.at(-1);
    if (saved === undefined) throw new Error('no policy write');
    const parsed = parsePolicyFile(saved);
    if (!parsed.ok) throw new Error('unreadable policy write');
    const s1 = parsed.file.assignments.find((a) => a.point.kind === 'session');
    expect(s1?.assignment).toEqual({
      profileId: 'observer',
      exceptions: [],
      onScreenOnly: false,
      pinned: ['open_file.access'],
    });
  });

  it('a session whose launched CLI is unknown lowers onto the default and takes a default edit', () => {
    const h = harness({ launchedCli: { s1: undefined } });
    h.service.start();
    h.service.applyLegacyPatch(
      { kind: 'session', sessionId: 's1' },
      { kind: 'default' },
      'open_file',
      {
        access: 'off',
      },
    );
    h.service.applyLegacyPatch({ kind: 'default' }, null, 'send_input', { access: 'on' });
    expect(h.service.ui([sessionRow('s1')]).legacy.sessions.s1).toEqual({
      open_file: { access: 'off' },
    });
  });

  it('a sleeping session whose CLI is known from its persisted record inherits the default', () => {
    const h = harness({ launchedCli: { s1: 'claude' } });
    h.service.start();
    h.service.applyLegacyPatch(
      { kind: 'session', sessionId: 's1' },
      { kind: 'default' },
      'open_file',
      {
        access: 'off',
      },
    );
    h.service.applyLegacyPatch({ kind: 'default' }, null, 'send_input', { access: 'on' });
    expect(h.service.ui([{ sessionId: 's1', launchedCli: 'claude' }]).legacy.sessions.s1).toEqual({
      open_file: { access: 'off' },
    });
  });

  it('a missing policy.json is rebuilt from the last-good copy, and migration is skipped', async () => {
    const good = policyText({
      assignments: [
        {
          point: { kind: 'default' },
          assignment: { profileId: 'lead', exceptions: [], onScreenOnly: false },
        },
      ],
    });
    const h = harness({ policy: null, lastGood: good });
    h.service.start();
    expect(migrateLegacyPolicy).not.toHaveBeenCalled();
    expect(h.service.ui([]).readOnly).toBe(false);
    h.fire(WRITE_MS);
    await h.service.stop();
    expect(parsePolicyFile(h.policyWrites.at(-1) ?? '')).toMatchObject({
      ok: true,
      file: { assignments: [{ point: { kind: 'default' }, assignment: { profileId: 'lead' } }] },
    });
  });

  it.each([
    [
      'is unreadable',
      { lastGood: '{not json' },
      'Permissions file missing and its saved copy is unreadable; every session is Observer',
    ],
    [
      'is from a newer version',
      { lastGood: '{"version":99,"profiles":[],"assignments":[],"overrides":[]}' },
      'Permissions file missing and its saved copy is from a newer version; every session is Observer',
    ],
    [
      'cannot be read',
      { lastGoodReadThrows: true },
      'Permissions file missing and its saved copy could not be read; every session is Observer',
    ],
  ])(
    'a missing policy.json with a last-good copy that %s fails closed and never migrates',
    async (_kind, saved, summary) => {
      const h = harness({ policy: null, ...saved });
      h.service.start();

      expect(migrateLegacyPolicy).not.toHaveBeenCalled();
      expect(h.legacyCalls()).toBe(0);
      expect(h.service.ui([sessionRow('s1')]).readOnly).toBe(true);
      expect(h.service.ui([sessionRow('s1')]).sessions.s1?.profileId).toBe('observer');
      expect(
        h.service.decide({
          principal: session(),
          tool: 'open_session',
          targets: [],
          masterOn: true,
          toYou: false,
        }).decision,
      ).toBe('deny');
      expect(h.service.setAssignment({ kind: 'default' }, 'lead')).toEqual({
        ok: false,
        error: 'read-only',
      });
      h.fire(WRITE_MS);
      await h.service.stop();
      expect(h.policyWrites).toEqual([]);
      expect(h.lastGoodWrites).toEqual([]);
      expect(h.activityRows().filter((r) => r.action === 'policy-unreadable')).toMatchObject([
        { summary },
      ]);
    },
  );

  it('a session whose stored profile is missing shows Observer in the UI', () => {
    const h = harness({
      policy: policyText({
        assignments: [
          {
            point: { kind: 'session', sessionId: 's1' },
            assignment: { profileId: 'p-gone', exceptions: [], onScreenOnly: false },
          },
        ],
      }),
    });
    h.service.start();
    expect(h.service.ui([sessionRow('s1')]).sessions.s1).toMatchObject({
      profileId: 'p-gone',
      profileName: 'Observer',
    });
  });
});

describe('remote policy doc', () => {
  const profile = (id: ProfileId, name = 'Mine'): Profile => ({
    id,
    name,
    builtIn: false,
    rules: DEFAULT_RULES,
  });
  const entry = (
    point: AssignmentPoint,
    profileId: ProfileId,
  ): PolicyFile['assignments'][number] => ({
    point,
    assignment: { profileId, exceptions: [], onScreenOnly: false },
  });
  const sessionAssignment = entry({ kind: 'session', sessionId: 's1' }, 'lead');
  const override: OneUseOverride = {
    id: 'o1',
    sessionId: 's1',
    tool: 'open_file',
    target: { sessionId: null, path: '/w/a.ts', folder: null, projectId: null },
    createdAt: iso(T0),
  };
  const seeded = () =>
    policyText({
      profiles: [profile('p-1', 'Old')],
      assignments: [
        sessionAssignment,
        entry({ kind: 'cli', cli: 'claude' }, 'observer'),
        entry({ kind: 'default' }, 'worker'),
      ],
      overrides: [override],
    });
  const pushed = (over: Record<string, unknown> = {}) => ({
    profiles: [profile('p-2', 'Pushed')],
    assignments: [
      entry({ kind: 'default' }, 'p-2'),
      entry({ kind: 'peer', machineId: 'm-1' }, 'worker'),
    ],
    ...over,
  });

  it('a fresh policy starts at rev 0 and a default edit bumps it once', () => {
    const h = harness();
    h.service.start();
    expect(h.service.remoteDoc().rev).toBe(0);
    expect(h.service.setAssignment({ kind: 'default' }, 'worker')).toEqual({ ok: true });
    expect(h.service.remoteDoc().rev).toBe(1);
    expect(h.service.setAssignment({ kind: 'default' }, 'worker')).toEqual({ ok: true });
    expect(h.service.remoteDoc().rev).toBe(1);
  });

  it('rev bumps on portable changes only: not for session points, grants, overrides or sessions ending', () => {
    const h = harness({
      policy: seeded(),
      grants: serializeGrantsFile({ version: 1, grants: [grant()] }),
    });
    h.service.start();
    expect(h.service.remoteDoc().rev).toBe(0);
    h.service.setAssignment({ kind: 'session', sessionId: 's1' }, 'worker');
    expect(h.service.remoteDoc().rev).toBe(0);
    h.service.revokeGrant('g1');
    h.service.sessionEnded('s1');
    expect(h.service.remoteDoc().rev).toBe(0);
    expect(
      h.service.applyLegacyPatch({ kind: 'default' }, null, 'open_file', { access: 'off' }),
    ).toEqual({ ok: true });
    expect(h.service.remoteDoc().rev).toBe(1);
  });

  it('a legacy patch that touches only a session point does not bump', () => {
    const h = harness({ policy: seeded() });
    h.service.start();
    h.service.applyLegacyPatch(
      { kind: 'session', sessionId: 's1' },
      { kind: 'default' },
      'open_file',
      { access: 'off' },
    );
    expect(h.service.remoteDoc().rev).toBe(0);
  });

  it('rev survives a restart', async () => {
    const h = harness({ policy: seeded() });
    h.service.start();
    h.service.setAssignment({ kind: 'default' }, 'lead');
    h.service.setAssignment({ kind: 'default' }, 'worker');
    h.service.setAssignment({ kind: 'default' }, 'lead');
    h.fire(WRITE_MS);
    await h.service.stop();
    const saved = h.policyWrites.at(-1);
    if (saved === undefined) throw new Error('no write');
    const again = harness({ policy: saved });
    again.service.start();
    expect(again.service.remoteDoc().rev).toBe(3);
  });

  it('a file without rev reads as rev 0 and remoteDoc projects its non-session assignments', () => {
    const h = harness({ policy: seeded() });
    h.service.start();
    const { rev, doc } = h.service.remoteDoc();
    expect(rev).toBe(0);
    expect(doc.profiles.map((p) => p.id)).toEqual(['p-1']);
    expect(doc.assignments.map((a) => a.point)).toEqual([
      { kind: 'cli', cli: 'claude' },
      { kind: 'default' },
    ]);
  });

  it('applyRemoteDoc on a matching rev replaces profiles and non-session assignments, keeps session assignments and overrides, and bumps rev', async () => {
    const h = harness({ policy: seeded() });
    h.service.start();
    const before = h.changed();
    const result = h.service.applyRemoteDoc(0, pushed(), 'm-owner');
    expect(result).toEqual({ ok: true, rev: 1 });
    expect(h.changed()).toBe(before + 1);
    expect(h.service.remoteDoc().rev).toBe(1);
    h.fire(WRITE_MS);
    await h.service.stop();
    const saved = parsePolicyFile(h.policyWrites.at(-1) ?? '');
    if (!saved.ok) throw new Error('saved file unreadable');
    expect(saved.file.rev).toBe(1);
    expect(saved.file.profiles.map((p) => p.id)).toEqual(['p-2']);
    expect(saved.file.assignments.map((a) => a.point)).toEqual([
      { kind: 'session', sessionId: 's1' },
      { kind: 'default' },
      { kind: 'peer', machineId: 'm-1' },
    ]);
    expect(saved.file.assignments[0]?.assignment.profileId).toBe('lead');
    expect(saved.file.overrides).toEqual([override]);
  });

  it('applyRemoteDoc refuses a stale baseRev with policy_conflict and the current copy, and changes nothing', async () => {
    const h = harness({ policy: seeded() });
    h.service.start();
    expect(h.service.applyRemoteDoc(0, pushed(), 'm-owner')).toEqual({ ok: true, rev: 1 });
    const current = h.service.remoteDoc();
    const changed = h.changed();
    h.fire(WRITE_MS);
    const writes = h.policyWrites.length;
    expect(
      h.service.applyRemoteDoc(0, pushed({ profiles: [profile('p-2', 'Stale')] }), 'm-owner'),
    ).toEqual({
      ok: false,
      code: 'policy_conflict',
      message: expect.any(String),
      current,
    });
    expect(h.service.remoteDoc()).toEqual(current);
    expect(h.changed()).toBe(changed);
    h.fire(WRITE_MS);
    await h.service.stop();
    expect(h.policyWrites.length).toBe(writes);
  });

  it('applyRemoteDoc refuses an invalid doc as invalid_args and keeps rev', () => {
    const h = harness({ policy: seeded() });
    h.service.start();
    const result = h.service.applyRemoteDoc(
      0,
      pushed({ assignments: [entry({ kind: 'session', sessionId: 's9' }, 'worker')] }),
      'm-owner',
    );
    expect(result).toMatchObject({ ok: false, code: 'invalid_args' });
    expect(result.ok ? '' : result.message).toMatch(/^assignments\[0\]\.point/);
    expect(h.service.remoteDoc().rev).toBe(0);
  });

  it.each([
    [
      'profiles',
      pushed({ profiles: Array.from({ length: 65 }, (_, i) => profile(`p-${i}`)) }),
      /^profiles /,
    ],
    [
      'a name',
      pushed({ profiles: [profile('p-2', 'x'.repeat(81))] }),
      /^profiles\[0\]\.name too long/,
    ],
  ])('applyRemoteDoc refuses a doc over the %s cap', (_label, doc, path) => {
    const h = harness({ policy: seeded() });
    h.service.start();
    const result = h.service.applyRemoteDoc(0, doc, 'm-owner');
    expect(result).toMatchObject({ ok: false, code: 'invalid_args' });
    expect(result.ok ? '' : result.message).toMatch(path);
    expect(h.service.remoteDoc().rev).toBe(0);
  });

  it('applyRemoteDoc on a readOnly policy is policy_unavailable', () => {
    const h = harness({ policy: '{"version":99}' });
    h.service.start();
    expect(h.service.ui([]).readOnly).toBe(true);
    expect(h.service.applyRemoteDoc(0, pushed(), 'm-owner')).toMatchObject({
      ok: false,
      code: 'policy_unavailable',
    });
  });

  it('onRemoteDocChange fires once per portable change and stops after unsubscribe', () => {
    const h = harness({
      policy: seeded(),
      grants: serializeGrantsFile({ version: 1, grants: [grant()] }),
    });
    h.service.start();
    const seen: number[] = [];
    const off = h.service.onRemoteDocChange(() => seen.push(h.service.remoteDoc().rev));
    h.service.setAssignment({ kind: 'session', sessionId: 's1' }, 'worker');
    expect(seen).toEqual([]);
    h.service.setAssignment({ kind: 'default' }, 'lead');
    expect(seen).toEqual([1]);
    h.service.applyRemoteDoc(1, pushed(), 'm-owner');
    expect(seen).toEqual([1, 2]);
    off();
    h.service.setAssignment({ kind: 'default' }, 'worker');
    expect(seen).toEqual([1, 2]);
  });

  it('grantsView shows live grants only, with a display string for who', () => {
    const h = harness({
      grants: serializeGrantsFile({
        version: 1,
        grants: [
          grant({ id: 'g-live' }),
          grant({ id: 'g-peer', who: { kind: 'peer', machineId: 'm-7' } }),
          grant({ id: 'g-revoked', state: 'revoked', endedAt: iso(T0) }),
          grant({ id: 'g-expired', expiresAt: iso(T0 - MIN) }),
          grant({ id: 'g-cli', who: { kind: 'cli', cli: 'codex' } }),
        ],
      }),
    });
    h.service.start();
    const view = h.service.grantsView();
    expect(view.map((g) => g.id)).toEqual(['g-live', 'g-peer', 'g-cli']);
    expect(view[1]).toEqual({
      id: 'g-peer',
      tool: 'open_session',
      who: 'm-7',
      on: { kind: 'anywhere' },
      for: 'until-revoked',
      createdAt: iso(T0),
      expiresAt: null,
      lastUsedAt: null,
    });
    expect(view[0]).not.toHaveProperty('expiring');
    expect(view[0]).not.toHaveProperty('state');
  });

  it('revokeGrantByRemote ends a live grant once, and an unknown id is not_found', async () => {
    const h = harness({
      grants: serializeGrantsFile({ version: 1, grants: [grant({ id: 'g-keep' })] }),
    });
    h.service.start();
    expect(h.service.revokeGrantByRemote('g-keep', 'm-owner')).toEqual({ ok: true });
    expect(h.service.grantsView()).toEqual([]);
    expect(h.service.revokeGrantByRemote('g-keep', 'm-owner')).toMatchObject({
      ok: false,
      code: 'not_found',
    });
    expect(h.service.revokeGrantByRemote('g-nope', 'm-owner')).toMatchObject({
      ok: false,
      code: 'not_found',
    });
    await h.service.stop();
    expect(h.grantWrites).toHaveLength(1);
  });
});
