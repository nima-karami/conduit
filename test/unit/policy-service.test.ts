import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActivityIo } from '../../src/conduit-mcp/activity-log';
import {
  type PolicyFile,
  parsePolicyFile,
  serializeGrantsFile,
  serializePolicyFile,
} from '../../src/conduit-mcp/policy-file';
import { migrateLegacyPolicy } from '../../src/conduit-mcp/policy-migration';
import {
  createPolicyService,
  type PolicyService,
  type PolicyServiceDeps,
} from '../../src/conduit-mcp/policy-service';
import type {
  Exception,
  Grant,
  OneUseOverride,
  PolicyTarget,
  Principal,
} from '../../src/conduit-mcp/policy-types';
import type { RequestsIo } from '../../src/conduit-mcp/request-file-fs';

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
const sessionRow = (sessionId: string) => ({ sessionId, handleCli: null, launchedCli: null });

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
      if (o.writeFails) throw new Error('disk full');
      policyWrites.push(t);
    },
  };
  const grantsIo: RequestsIo = {
    read: () => o.grants ?? null,
    write: async (t) => {
      if (o.writeFails) throw new Error('disk full');
      grantWrites.push(t);
    },
  };
  const activityIo: ActivityIo = {
    append: (_day, line) => {
      if (o.activityFails) throw new Error('activity disk full');
      rows.push(line);
    },
    list: () => [],
    remove: () => undefined,
    readArgs: () => null,
    writeArgs: () => undefined,
  };

  const deps: PolicyServiceDeps = {
    policyIo,
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
      return { global: {} as never, byCli: {}, sessions: [] };
    },
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
    grantWrites,
    activityRows,
    warnings,
    timers,
    legacyCalls: () => legacyCalls,
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

  it('decide touches every matched grant and consumes an override', async () => {
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
    const used = h.service.decide({
      principal: session(),
      tool: 'open_session',
      targets: [target({ sessionId: 's2' }), target({ sessionId: 's3' })],
      masterOn: true,
      toYou: false,
    });
    expect(used.decision).toBe('allow');
    expect(used.grantIds).toEqual(['g-s2', 'g-s3']);
    const touched = h.service.ui([]).grants.map((g) => [g.id, g.lastUsedAt]);
    expect(touched).toEqual([
      ['g-s2', iso(h.now())],
      ['g-s3', iso(h.now())],
    ]);

    const passed = h.service.decide({
      principal: session(),
      tool: 'open_session',
      targets: [target({ sessionId: 's9' })],
      masterOn: true,
      toYou: false,
    });
    expect(passed).toMatchObject({
      decision: 'allow',
      reason: { by: 'override', overrideId: 'o1' },
    });

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
    expect(h.service.decide(input)).toMatchObject({
      decision: 'allow',
      reason: { by: 'override' },
    });
    expect(h.service.decide(input).decision).toBe('deny');
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
    h.service.activity.record({
      lane: 'conduit',
      principal: { handle: 'alpha', sessionId: 's1', machineId: null },
      cli: null,
      action: 'open_session',
      target: null,
      summary: null,
      decision: 'allow',
      decidedBy: 'profile',
      outcome: 'ok',
      durationMs: null,
      requestId: null,
      count: null,
    });

    expect(h.warnings.some((m) => m.includes('activity'))).toBe(true);
    expect(h.service.activity.writable()).toBe(false);
    expect(
      h.service.decide({
        principal: session(),
        tool: 'list_sessions',
        targets: [],
        masterOn: true,
        toYou: false,
      }).decision,
    ).toBe('allow');
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
});
