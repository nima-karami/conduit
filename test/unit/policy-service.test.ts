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
import { DEFAULT_TOOL_POLICY } from '../../src/conduit-mcp/tool-policy';

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
    const used = h.service.decide({
      principal: session(),
      tool: 'open_session',
      targets: [target({ sessionId: 's2' }), target({ sessionId: 's3' })],
      masterOn: true,
      toYou: false,
    });
    expect(used.decision).toBe('allow');
    expect(used.grantIds).toEqual(['g-s2', 'g-s3']);
    expect(h.service.ui([]).grants.map((g) => [g.id, g.lastUsedAt])).toEqual([
      ['g-s2', null],
      ['g-s3', null],
    ]);
    h.service.commit(used);
    expect(h.service.ui([]).grants.map((g) => [g.id, g.lastUsedAt])).toEqual([
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
    h.service.commit(passed);

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
    h.service.commit(passed);
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

  it('an unreadable policy.json evaluates the pre-upgrade settings, read-only', async () => {
    vi.mocked(migrateLegacyPolicy).mockReturnValueOnce({
      assignments: [
        {
          point: { kind: 'session', sessionId: 's1' },
          assignment: { profileId: 'observer', exceptions: [], onScreenOnly: false },
        },
      ],
      migratedFrom: 'v0.64',
      notes: { onScreenOnlyOffered: [] },
    });
    const h = harness({ policy: '{not json' });
    h.service.start();

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
    const notes = h.activityRows().filter((r) => r.action === 'policy-unreadable');
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      lane: 'note',
      summary: 'Permissions file unreadable; using pre-upgrade settings',
    });
    h.fire(WRITE_MS);
    await h.service.stop();
    expect(h.policyWrites).toEqual([]);
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
    h.service.commit(passed);
    expect(h.service.decide(input).decision).toBe('deny');
    h.fire(WRITE_MS);
    await h.service.stop();
    const saved = parsePolicyFile(h.policyWrites.at(-1) ?? '');
    expect(saved.ok && saved.file.overrides).toEqual([]);
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

    h.service.commit(first);
    expect(h.changed()).toBe(before + 1);
    h.service.commit(first);
    expect(h.changed()).toBe(before + 1);
    expect(h.service.decide(input).decision).toBe('deny');
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
    h.service.commit(asked);
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
