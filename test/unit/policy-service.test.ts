import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActivityIo } from '../../src/conduit-mcp/activity-log';
import {
  type PolicyFile,
  parsePolicyFile,
  serializeGrantsFile,
  serializePolicyFile,
} from '../../src/conduit-mcp/policy-file';
import {
  createPolicyIo,
  POLICY_MAX_BYTES,
  type PolicyIo,
} from '../../src/conduit-mcp/policy-file-fs';
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
import { type CliKind, DEFAULT_TOOL_POLICY, TOOL_GROUPS } from '../../src/conduit-mcp/tool-policy';
import { prepareNativeLaunch } from '../../src/native-launch';

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
  backupFails?: boolean;
  idPrefix?: string;
  hasSession?: (id: string) => boolean;
  peerKnown?: (id: string) => boolean | null;
  grantBindingsCurrent?: (grant: Grant) => boolean;
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

  const policyIo: PolicyIo = {
    read: () => o.policy ?? null,
    writeSync: (t) => {
      if (writeDown) throw new Error('disk full');
      policyWrites.push(t);
      return true;
    },
  };
  const lastGoodWrites: string[] = [];
  const lastGoodIo: PolicyIo = {
    read: () => {
      if (o.lastGoodReadThrows) throw new Error('EIO');
      return o.lastGood ?? null;
    },
    writeSync: (t) => {
      if (writeDown || o.backupFails) throw new Error('disk full');
      lastGoodWrites.push(t);
      return true;
    },
  };
  const grantsIo: PolicyIo = {
    read: () => o.grants ?? null,
    writeSync: (t) => {
      if (writeDown) throw new Error('disk full');
      grantWrites.push(t);
      return true;
    },
  };
  let activityDown = o.activityFails ?? false;
  let writeDown = o.writeFails ?? false;
  const activityIo: ActivityIo = {
    append: (_day, line) => {
      if (activityDown) throw new Error('activity disk full');
      rows.push(line);
    },
    read: () => '',
    list: () => [],
    remove: () => undefined,
    readArgs: () => null,
    writeArgs: () => undefined,
  };

  const deps: PolicyServiceDeps = {
    hasSession: o.hasSession ?? (() => true),
    peerKnown: o.peerKnown ?? (() => null),
    grantBindingsCurrent: o.grantBindingsCurrent ?? (() => true),
    policyIo,
    lastGoodIo,
    grantsIo,
    activityIo,
    now: () => now,
    newId: () => `${o.idPrefix ?? 'id'}${++ids}`,
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
  it('revokes durably, restores once before the deadline, and preserves the grant binding', () => {
    const h = harness({
      policy: policyText(),
      grants: serializeGrantsFile({ version: 1, grants: [grant()] }),
    });
    h.service.start();
    const token = h.service.ui([]).editToken;
    const revoked = h.service.revokeGrantWithUndo('g1', 0, token);
    expect(revoked.ok && revoked.undoToken).toBeTruthy();
    expect(h.service.ui([]).grants[0]).toMatchObject({ state: 'revoked', lifecycleRevision: 1 });
    if (!revoked.ok || !revoked.undoToken) throw new Error('missing receipt');
    h.advance(4999);
    expect(h.service.undoGrantRevoke(revoked.undoToken)).toEqual({ ok: true });
    expect(h.service.ui([]).grants[0]).toMatchObject({ state: 'active', lifecycleRevision: 2 });
    expect(h.service.undoGrantRevoke(revoked.undoToken)).toMatchObject({ ok: false });
  });

  it('rejects receipt at deadline or after another authority mutation', () => {
    const h = harness({
      policy: policyText(),
      grants: serializeGrantsFile({ version: 1, grants: [grant(), grant({ id: 'g2' })] }),
    });
    h.service.start();
    const token = h.service.ui([]).editToken;
    const first = h.service.revokeGrantWithUndo('g1', 0, token);
    if (!first.ok || !first.undoToken) throw new Error('missing receipt');
    h.advance(5000);
    expect(h.service.undoGrantRevoke(first.undoToken)).toMatchObject({ ok: false });
    const second = h.service.revokeGrantWithUndo('g2', 0, token);
    if (!second.ok || !second.undoToken) throw new Error('missing receipt');
    h.service.peerEligibilityChanged();
    expect(h.service.undoGrantRevoke(second.undoToken)).toMatchObject({ ok: false });
  });

  it('revalidates bindings and invalidates undo when another grant or denial changes', () => {
    let live = true;
    const h = harness({
      policy: policyText(),
      grants: serializeGrantsFile({ version: 1, grants: [grant(), grant({ id: 'g2' })] }),
      grantBindingsCurrent: () => live,
    });
    h.service.start();
    const token = h.service.ui([]).editToken;
    live = false;
    expect(h.service.revokeGrantWithUndo('g1', 0, token)).toMatchObject({ ok: false });
    live = true;
    const first = h.service.revokeGrantWithUndo('g1', 0, token);
    if (!first.ok || !first.undoToken) throw new Error('missing receipt');
    expect(h.service.revokeGrant('g2')).toEqual({ ok: true });
    expect(h.service.undoGrantRevoke(first.undoToken)).toMatchObject({ ok: false });
  });

  it('keeps an undo receipt valid across grant usage but not a denial', () => {
    const h = harness({
      policy: policyText(),
      grants: serializeGrantsFile({
        version: 1,
        grants: [grant(), grant({ id: 'g2', useCount: 0 })],
      }),
    });
    h.service.start();
    const token = h.service.ui([]).editToken;
    const first = h.service.revokeGrantWithUndo('g1', 0, token);
    if (!first.ok || !first.undoToken) throw new Error('missing receipt');
    const input = {
      principal: session(),
      tool: 'open_session' as const,
      targets: [target({ sessionId: 's2' })],
      masterOn: true,
      toYou: false,
    };
    const decision = h.service.decide(input);
    expect(decision.grantIds).toContain('g2');
    expect(h.service.commit(input, decision)).toMatchObject({ ok: true });
    expect(h.service.undoGrantRevoke(first.undoToken)).toEqual({ ok: true });
    const second = h.service.revokeGrantWithUndo('g1', 2, token);
    if (!second.ok || !second.undoToken) throw new Error('missing receipt');
    expect(h.service.saveSessionDenial('r1', 's1', 'open_session', () => {})).toEqual({ ok: true });
    expect(h.service.undoGrantRevoke(second.undoToken)).toMatchObject({ ok: false });
  });

  it('rejects undo if bindings cease to be current and preserves suspended state', () => {
    let live = true;
    const h = harness({
      policy: policyText(),
      grants: serializeGrantsFile({ version: 1, grants: [grant({ state: 'suspended' })] }),
      grantBindingsCurrent: () => live,
    });
    h.service.start();
    const token = h.service.ui([]).editToken;
    const first = h.service.revokeGrantWithUndo('g1', 0, token);
    if (!first.ok || !first.undoToken) throw new Error('missing receipt');
    live = false;
    expect(h.service.undoGrantRevoke(first.undoToken)).toMatchObject({ ok: false });
    live = true;
    expect(h.service.undoGrantRevoke(first.undoToken)).toMatchObject({ ok: false });
    const h2 = harness({
      policy: policyText(),
      grants: serializeGrantsFile({ version: 1, grants: [grant({ state: 'suspended' })] }),
    });
    h2.service.start();
    const second = h2.service.revokeGrantWithUndo('g1', 0, h2.service.ui([]).editToken);
    if (!second.ok || !second.undoToken) throw new Error('missing receipt');
    expect(h2.service.undoGrantRevoke(second.undoToken)).toEqual({ ok: true });
    expect(h2.service.ui([]).grants[0]).toMatchObject({ state: 'suspended' });
  });

  it('extends and renews using current revisions and policy token', () => {
    const finite = grant({ for: '1h', expiresAt: iso(T0 + 3_600_000) });
    const h = harness({
      policy: policyText(),
      grants: serializeGrantsFile({ version: 1, grants: [finite] }),
    });
    h.service.start();
    const token = h.service.ui([]).editToken;
    expect(h.service.extendGrant('g1', 0, 'stale')).toMatchObject({ ok: false });
    expect(h.service.extendGrant('g1', 0, token)).toEqual({ ok: true });
    expect(h.service.extendGrant('g1', 0, token)).toMatchObject({ ok: false });
    h.advance(2 * 3_600_000);
    h.fire(60_000);
    expect(h.service.renewGrant('g1', 2, token)).toEqual({ ok: true });
    expect(h.service.ui([]).grants[0]).toMatchObject({
      state: 'active',
      lifecycleRevision: 3,
      expiresAt: iso(T0 + 3 * 3_600_000),
    });
  });

  it('invalidates an undo receipt when session cleanup removes a denial', () => {
    const h = harness({
      policy: policyText(),
      grants: serializeGrantsFile({ version: 1, grants: [grant()] }),
    });
    h.service.start();
    expect(h.service.saveSessionDenial('r2', 's2', 'open_session', () => {})).toEqual({ ok: true });
    const result = h.service.revokeGrantWithUndo('g1', 0, h.service.ui([]).editToken);
    if (!result.ok || !result.undoToken) throw new Error('missing receipt');
    h.service.sessionEnded('s2');
    expect(h.service.undoGrantRevoke(result.undoToken)).toMatchObject({ ok: false });
  });

  it('does not persist undo receipts across a new service instance', () => {
    const h = harness({
      policy: policyText(),
      grants: serializeGrantsFile({ version: 1, grants: [grant()] }),
    });
    h.service.start();
    const result = h.service.revokeGrantWithUndo('g1', 0, h.service.ui([]).editToken);
    if (!result.ok || !result.undoToken) throw new Error('missing receipt');
    const restarted = harness({ policy: policyText(), grants: h.grantWrites.at(-1) });
    restarted.service.start();
    expect(restarted.service.undoGrantRevoke(result.undoToken)).toMatchObject({ ok: false });
    expect(restarted.service.ui([]).grants[0]).toMatchObject({ state: 'revoked' });
  });

  it('keeps failed revoke restrictive without issuing an undo token', () => {
    const h = harness({
      policy: policyText(),
      grants: serializeGrantsFile({ version: 1, grants: [grant()] }),
    });
    h.service.start();
    h.setWriteDown(true);
    expect(h.service.revokeGrantWithUndo('g1', 0, h.service.ui([]).editToken)).toMatchObject({
      ok: false,
      error: 'save-failed',
      applied: 'tightening',
    });
    expect(h.service.ui([]).grants[0]).toMatchObject({ state: 'revoked' });
  });

  it('flushes a failed tightening on stop after disk recovery and remains revoked after restart', async () => {
    const h = harness({
      policy: policyText(),
      grants: serializeGrantsFile({ version: 1, grants: [grant()] }),
    });
    h.service.start();
    h.setWriteDown(true);
    expect(h.service.revokeGrant('g1')).toMatchObject({ ok: false, error: 'save-failed' });
    expect(h.service.ui([]).grants[0]?.state).toBe('revoked');
    h.setWriteDown(false);
    await h.service.stop();
    expect(h.grantWrites).toHaveLength(1);
    const restarted = harness({ policy: policyText(), grants: h.grantWrites[0] });
    restarted.service.start();
    expect(restarted.service.ui([]).grants[0]?.state).toBe('revoked');
  });

  it('reconciles missing anchors, session targets and confirmed unpaired peers at load', () => {
    const list = [
      grant({
        id: 'anchor',
        who: { kind: 'cli', cli: 'codex' },
        for: 'session-end',
        anchorSessionId: 'gone',
      }),
      grant({ id: 'target', on: { kind: 'session', sessionId: 'gone' } }),
      grant({ id: 'peer', who: { kind: 'peer', machineId: 'removed' } }),
      grant({ id: 'unknown', who: { kind: 'peer', machineId: 'unknown' } }),
      grant({ id: 'offline', who: { kind: 'peer', machineId: 'offline' } }),
    ];
    const h = harness({
      policy: policyText(),
      grants: serializeGrantsFile({ version: 1, grants: list }),
      hasSession: (id) => id !== 'gone',
      peerKnown: (id) => (id === 'removed' ? false : id === 'offline' ? true : null),
    });
    h.service.start();
    expect(Object.fromEntries(h.service.ui([]).grants.map((g) => [g.id, g.state]))).toEqual({
      anchor: 'expired',
      target: 'expired',
      peer: 'revoked',
      unknown: 'active',
      offline: 'active',
    });
  });

  it('uses a total three tightening retry budget despite more failures in the same outage', () => {
    const h = harness({
      policy: policyText(),
      grants: serializeGrantsFile({ version: 1, grants: [grant(), grant({ id: 'g2' })] }),
    });
    h.service.start();
    h.setWriteDown(true);
    h.service.revokeGrant('g1');
    expect(h.timers.some((t) => t.ms === 250)).toBe(true);
    h.fire(250);
    h.fire(1000);
    h.fire(5000);
    h.service.revokeGrant('g2');
    expect(h.timers.filter((t) => t.ms !== 60_000 && t.ms !== 3_600_000)).toHaveLength(0);
    expect(h.service.ui([]).saveError).toContain('active here');
    h.setWriteDown(false);
    expect(h.service.retrySave()).toEqual({ ok: true });
    expect(h.service.ui([]).saveError).toBeNull();
  });

  it('flushes pending session assignment cleanup on stop after recovery', async () => {
    const h = harness({
      policy: policyText({
        assignments: [
          {
            point: { kind: 'session', sessionId: 's1' },
            assignment: { profileId: 'lead', exceptions: [], onScreenOnly: false },
          },
        ],
      }),
    });
    h.service.start();
    h.setWriteDown(true);
    h.service.sessionEnded('s1');
    expect(h.service.ui([]).assignments).toEqual([]);
    h.setWriteDown(false);
    await h.service.stop();
    expect(parsePolicyFile(h.policyWrites.at(-1) ?? '')).toMatchObject({
      ok: true,
      file: { assignments: [] },
    });
  });

  it('keeps readonly session cleanup active without overwriting an unreadable policy', () => {
    const lastGood = policyText({
      assignments: [
        {
          point: { kind: 'session', sessionId: 's1' },
          assignment: { profileId: 'lead', exceptions: [], onScreenOnly: false },
        },
      ],
    });
    const h = harness({ policy: '{bad', lastGood });
    h.service.start();
    h.service.sessionEnded('s1');
    expect(h.service.ui([]).assignments).toEqual([]);
    expect(h.policyWrites).toEqual([]);
    expect(h.service.ui([]).saveError).toContain('active here');
  });

  it('preserves the original publication cause when rollback has a typed storage failure', async () => {
    const h = harness({
      policy: policyText(),
      grants: serializeGrantsFile({ version: 1, grants: [grant({ id: 'prior' })] }),
    });
    h.service.start();
    const original = new Error('publication failed');
    let calls = 0;
    const unsubscribe = h.service.onRemoteDocChange(() => {
      if (++calls === 1) {
        h.setWriteDown(true);
        throw original;
      }
    });
    expect(() =>
      h.service.createGrants(
        { who: 'session', on: 'target', for: 'until-revoked' },
        session(),
        'close_session',
        [target({ sessionId: 'a' })],
        'fresh',
      ),
    ).toThrow(original);
    expect(h.service.ui([]).grants.map((g) => [g.requestId, g.state])).toEqual([
      [null, 'active'],
      ['fresh', 'revoked'],
    ]);
    expect(h.service.ui([]).saveError).toContain('active here');
    unsubscribe();
    h.setWriteDown(false);
    await h.service.stop();
    expect(JSON.parse(h.grantWrites.at(-1) ?? '{}').grants.map((g: Grant) => g.state)).toEqual([
      'active',
      'revoked',
    ]);
  });

  it.each(['remote', 'changed'] as const)(
    'revokes the real published batch when %s publication throws',
    (where) => {
      const h = harness({
        policy: policyText(),
        grants: serializeGrantsFile({ version: 1, grants: [grant({ id: 'prior' })] }),
      });
      h.service.start();
      const original = new Error('publication failed');
      const cleanup = new Error('rollback publication failed');
      let calls = 0;
      const fail = () => {
        throw ++calls === 1 ? original : cleanup;
      };
      if (where === 'remote') h.service.onRemoteDocChange(fail);
      else h.deps.onChanged = fail;
      let caught: unknown;
      try {
        h.service.createGrants(
          { who: 'session', on: 'target', for: 'until-revoked' },
          session(),
          'close_session',
          [target({ sessionId: 'a' }), target({ sessionId: 'b' })],
          'fresh',
        );
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(AggregateError);
      if (!(caught instanceof AggregateError))
        throw new Error('Expected original and cleanup failure');
      expect(caught.errors).toEqual([original, cleanup]);
      expect(h.service.ui([]).grants.map((g) => [g.requestId, g.state])).toEqual([
        [null, 'active'],
        ['fresh', 'revoked'],
        ['fresh', 'revoked'],
      ]);
      expect(
        JSON.parse(h.grantWrites.at(-1) ?? '{}').grants.map((g: Grant) => [
          g.id === 'prior',
          g.state,
        ]),
      ).toEqual([
        [true, 'active'],
        [false, 'revoked'],
        [false, 'revoked'],
      ]);
    },
  );

  it.each(['remote', 'changed'] as const)(
    'keeps failed %s publication rollback restrictive through IO outage and restart recovery',
    async (where) => {
      const h = harness({
        policy: policyText(),
        grants: serializeGrantsFile({ version: 1, grants: [grant({ id: 'prior' })] }),
      });
      h.service.start();
      const original = new Error('publication failed');
      const changed = h.deps.onChanged;
      const fail = () => {
        h.setWriteDown(true);
        throw original;
      };
      const unsubscribe =
        where === 'remote'
          ? h.service.onRemoteDocChange(fail)
          : () => {
              h.deps.onChanged = changed;
            };
      if (where === 'changed') h.deps.onChanged = fail;
      expect(() =>
        h.service.createGrants(
          { who: 'session', on: 'target', for: 'until-revoked' },
          session(),
          'close_session',
          [target({ sessionId: 'a' })],
          'fresh',
        ),
      ).toThrow();
      expect(h.service.ui([]).grants.map((g) => [g.requestId, g.state])).toEqual([
        [null, 'active'],
        ['fresh', 'revoked'],
      ]);
      expect(h.service.ui([]).saveError).toContain('active here');
      unsubscribe();
      h.setWriteDown(false);
      await h.service.stop();
      const restarted = harness({ policy: policyText(), grants: h.grantWrites.at(-1) });
      restarted.service.start();
      expect(restarted.service.ui([]).grants.map((g) => [g.requestId, g.state])).toEqual([
        [null, 'active'],
        ['fresh', 'revoked'],
      ]);
    },
  );

  it('rolls back only the exact newly-created batch and persists a failed rollback on stop', async () => {
    const h = harness({
      policy: policyText(),
      grants: serializeGrantsFile({ version: 1, grants: [grant({ id: 'prior' })] }),
    });
    h.service.start();
    const made = h.service.createGrants(
      { who: 'session', on: 'target', for: 'until-revoked' },
      session(),
      'close_session',
      [target({ sessionId: 'a' }), target({ sessionId: 'b' })],
      'fresh',
    );
    expect(made.ok).toBe(true);
    if (!made.ok) throw new Error('Expected fresh batch');
    h.setWriteDown(true);
    expect(h.service.revokeGrants(made.grants.map((g) => g.id))).toEqual({
      ok: false,
      error: 'save-failed',
      applied: 'tightening',
    });
    expect(h.service.ui([]).grants.map((g) => [g.id, g.state])).toEqual([
      ['prior', 'active'],
      ...made.grants.map((g) => [g.id, 'revoked']),
    ]);
    h.setWriteDown(false);
    await h.service.stop();
    expect(
      JSON.parse(h.grantWrites.at(-1) ?? '{}').grants.map((g: Grant) => [g.id, g.state]),
    ).toEqual([['prior', 'active'], ...made.grants.map((g) => [g.id, 'revoked'])]);
  });

  it('reconciles newly authoritative peer facts and load-time idle expiry', () => {
    let known: boolean | null = null;
    const h = harness({
      policy: policyText(),
      peerKnown: () => known,
      grants: serializeGrantsFile({
        version: 1,
        grants: [
          grant({ id: 'peer', who: { kind: 'peer', machineId: 'offline' } }),
          grant({
            id: 'idle',
            for: 'session-end',
            anchorSessionId: 's1',
            createdAt: iso(T0 - 8 * 24 * 60 * MIN),
          }),
        ],
      }),
    });
    h.service.start();
    expect(h.service.ui([]).grants.map((g) => g.state)).toEqual(['active', 'expired']);
    known = false;
    h.service.reconcilePrincipals();
    expect(h.service.ui([]).grants.map((g) => g.state)).toEqual(['revoked', 'expired']);
  });

  it('persists human assignments before publication and never retries failed widening automatically', () => {
    const h = harness({ policy: policyText() });
    h.service.start();
    const before = h.service.ui([]);
    h.setWriteDown(true);
    expect(h.service.setAssignment({ kind: 'default' }, 'lead')).toEqual({
      ok: false,
      error: 'save-failed',
    });
    expect(h.service.ui([]).assignments).toEqual(before.assignments);
    expect(h.service.ui([]).editToken).toBe(before.editToken);
    expect(h.service.ui([]).saveError).toContain('could not be saved');
    h.setWriteDown(false);
    h.fire(WRITE_MS);
    h.advance(60_000);
    h.fire(60_000);
    expect(h.policyWrites).toHaveLength(0);
    expect(h.service.retrySave()).toEqual({ ok: true });
    expect(h.service.ui([]).assignments).toEqual(before.assignments);
    expect(h.policyWrites).toHaveLength(1);
  });

  it('keeps a committed primary and reports backup failure separately', () => {
    const h = harness({ policy: policyText(), backupFails: true });
    h.service.start();
    expect(h.service.setAssignment({ kind: 'default' }, 'lead')).toEqual({ ok: true });
    expect(h.service.ui([]).assignments[0]?.assignment.profileId).toBe('lead');
    expect(h.service.ui([]).saveError).toBeNull();
    expect(h.service.ui([]).backupWarning).toContain('backup');
    expect(parsePolicyFile(h.policyWrites[0] ?? '')).toMatchObject({
      ok: true,
      file: { assignments: [{ assignment: { profileId: 'lead' } }] },
    });
  });

  it('refuses stale drafts across edits and service lifetimes', () => {
    const h = harness({ policy: policyText(), idPrefix: 'first-' });
    h.service.start();
    const token = h.service.ui([]).editToken;
    const assignment = { profileId: 'lead' as const, exceptions: [], onScreenOnly: false };
    h.setWriteDown(true);
    expect(h.service.saveAssignment({ kind: 'default' }, assignment, token)).toEqual({
      ok: false,
      error: 'save-failed',
    });
    h.setWriteDown(false);
    expect(
      h.service.saveAssignment(
        { kind: 'default' },
        { ...assignment, profileId: 'observer' },
        token,
      ),
    ).toEqual({ ok: true });
    expect(h.service.saveAssignment({ kind: 'default' }, assignment, token)).toEqual({
      ok: false,
      error: 'conflict',
    });
    const other = harness({ policy: h.policyWrites[0], idPrefix: 'second-' });
    other.service.start();
    expect(
      other.service.saveAssignment({ kind: 'default' }, assignment, h.service.ui([]).editToken),
    ).toEqual({ ok: false, error: 'conflict' });
  });

  it('never deletes a builtin id even if an old file contains a shadow entry', () => {
    const h = harness({
      policy: policyText({
        profiles: [{ ...structuredClone(OBSERVER), id: 'worker', name: 'Shadow', builtIn: false }],
      }),
    });
    h.service.start();
    expect(h.service.deleteProfile('worker', 'lead', h.service.ui([]).editToken)).toEqual({
      ok: false,
      error: 'unknown-profile',
    });
    expect(h.policyWrites).toHaveLength(0);
  });

  it('atomically saves custom profiles and replaces every usage on deletion', () => {
    const h = harness({ policy: policyText() });
    h.service.start();
    const profile = {
      rules: structuredClone(OBSERVER.rules),
      id: 'p-copy' as const,
      name: 'Copy',
      builtIn: false,
    };
    expect(h.service.saveProfile(profile, h.service.ui([]).editToken)).toEqual({ ok: true });
    expect(h.service.setAssignment({ kind: 'default' }, profile.id)).toEqual({ ok: true });
    h.setWriteDown(true);
    expect(h.service.deleteProfile(profile.id, 'worker', h.service.ui([]).editToken)).toEqual({
      ok: false,
      error: 'save-failed',
    });
    expect(h.service.ui([]).assignments[0]?.assignment.profileId).toBe('p-copy');
    h.setWriteDown(false);
    expect(h.service.deleteProfile(profile.id, 'worker', h.service.ui([]).editToken)).toEqual({
      ok: true,
    });
    expect(h.service.ui([]).assignments[0]?.assignment.profileId).toBe('worker');
    expect(h.service.ui([]).profiles.some((p) => p.id === profile.id)).toBe(false);
  });

  it('saves multi-target grants all-or-none with one primary write', () => {
    const h = harness({ policy: policyText() });
    h.service.start();
    const targets = [target({ sessionId: 'a' }), target({ sessionId: 'b' })];
    const choice = { who: 'session' as const, on: 'target' as const, for: 'session-end' as const };
    h.setWriteDown(true);
    expect(h.service.createGrants(choice, session(), 'close_session', targets, 'r1')).toEqual({
      ok: false,
      error: 'save-failed',
    });
    expect(h.service.ui([]).grants).toHaveLength(0);
    h.setWriteDown(false);
    const made = h.service.createGrants(choice, session(), 'close_session', targets, 'r1');
    expect(made.ok).toBe(true);
    expect(made.ok ? made.grants : []).toHaveLength(2);
    expect(h.grantWrites).toHaveLength(1);
    expect(h.service.ui([]).grants).toHaveLength(2);
  });

  it('refuses execution when an override consumption cannot be saved and stays restrictive', () => {
    const h = harness({
      policy: policyText({
        assignments: [
          {
            point: { kind: 'default' },
            assignment: {
              profileId: 'worker',
              onScreenOnly: false,
              exceptions: [
                { tool: 'close_session', scope: { kind: 'anywhere' }, rule: { decision: 'deny' } },
              ],
            },
          },
        ],
        overrides: [
          {
            id: 'one',
            sessionId: 's1',
            tool: 'close_session',
            target: target({ sessionId: 'a' }),
            createdAt: iso(T0),
          },
        ],
      }),
    });
    h.service.start();
    const input = {
      principal: session(),
      tool: 'close_session' as const,
      targets: [target({ sessionId: 'a' })],
      masterOn: true,
      toYou: false,
    };
    const allowed = h.service.decide(input);
    expect(allowed.overrideIds).toEqual(['one']);
    h.setWriteDown(true);
    expect(h.service.commit(input, allowed)).toEqual({ ok: false, error: 'save-failed' });
    expect(h.service.decide(input).decision).toBe('deny');
    expect(h.service.ui([]).saveError).toContain('could not be saved');
  });

  it('enforces candidate byte cap and allows an oversized readable policy to be reduced', () => {
    const huge = {
      rules: structuredClone(OBSERVER.rules),
      id: 'p-huge' as const,
      name: 'Huge',
      builtIn: false,
      extra: 'x'.repeat(1024 * 1024),
    };
    const h = harness({ policy: policyText({ profiles: [huge] }) });
    h.service.start();
    expect(h.service.setAssignment({ kind: 'default' }, 'lead')).toEqual({
      ok: false,
      error: 'too-large',
    });
    expect(h.policyWrites).toHaveLength(0);
    expect(h.service.ui([]).profiles.some((p) => p.id === 'p-huge')).toBe(true);
    expect(h.service.deleteProfile('p-huge', 'worker', h.service.ui([]).editToken)).toEqual({
      ok: true,
    });
    expect(h.service.ui([]).profiles.some((p) => p.id === 'p-huge')).toBe(false);
  });

  it('rejects one-use widening on failed save and permits an explicit retry only', () => {
    const h = harness({
      policy: policyText({
        assignments: [
          {
            point: { kind: 'default' },
            assignment: {
              profileId: 'worker',
              onScreenOnly: false,
              exceptions: [
                { tool: 'close_session', scope: { kind: 'anywhere' }, rule: { decision: 'deny' } },
              ],
            },
          },
        ],
      }),
    });
    h.service.start();
    const input = {
      principal: session(),
      tool: 'close_session' as const,
      targets: [target({ sessionId: 'a' })],
      masterOn: true,
      toYou: false,
    };
    const denied = h.service.decide(input);
    h.service.noteDecision('denied', input, denied);
    h.setWriteDown(true);
    expect(h.service.allowOnce('denied')).toEqual({ ok: false, error: 'save-failed' });
    expect(h.service.decide(input).decision).toBe('deny');
    h.setWriteDown(false);
    h.fire(WRITE_MS);
    expect(h.policyWrites).toHaveLength(0);
    expect(h.service.allowOnce('denied')).toEqual({ ok: true });
    expect(h.service.decide(input).decision).toBe('allow');
  });

  it('keeps failed revocation restrictive and reports remote durability honestly', () => {
    const h = harness({
      policy: policyText(),
      grants: serializeGrantsFile({ version: 1, grants: [grant()] }),
    });
    h.service.start();
    h.setWriteDown(true);
    expect(h.service.revokeGrantByRemote('g1')).toEqual({
      ok: false,
      code: 'policy_unavailable',
      message: 'save-failed',
    });
    expect(h.service.ui([]).grants[0]?.state).toBe('revoked');
    expect(h.service.ui([]).saveError).toContain('could not be saved');
    expect(h.service.revokeGrantByRemote('missing')).toEqual({
      ok: false,
      code: 'not_found',
      message: 'not-found',
    });
    h.setWriteDown(false);
    h.fire(WRITE_MS);
    expect(h.grantWrites).toHaveLength(1);
    expect(h.service.retrySave()).toEqual({ ok: true });
    expect(JSON.parse(h.grantWrites[0] ?? '{}')).toMatchObject({ grants: [{ state: 'revoked' }] });
  });

  it('refuses an incoming remote policy before acknowledgement when the local primary fails', () => {
    const h = harness({ policy: policyText() });
    h.service.start();
    h.setWriteDown(true);
    expect(
      h.service.applyRemoteDoc(
        0,
        {
          profiles: [],
          assignments: [
            {
              point: { kind: 'default' },
              assignment: { profileId: 'lead', exceptions: [], onScreenOnly: false },
            },
          ],
        },
        true,
      ),
    ).toEqual({ ok: false, code: 'policy_unavailable', message: 'save-failed' });
    expect(h.service.remoteDoc()).toEqual({ rev: 0, doc: { profiles: [], assignments: [] } });
  });

  it('projects full profiles and assignments without sharing mutable engine state', () => {
    const points: AssignmentPoint[] = [
      { kind: 'default' },
      { kind: 'cli', cli: 'codex' },
      { kind: 'session', sessionId: 's1' },
      { kind: 'peer', machineId: 'm1' },
    ];
    const h = harness({
      policy: policyText({
        profiles: [{ ...OBSERVER, id: 'p-copy', name: 'Copy', builtIn: false }],
        assignments: points.map((point) => ({
          point,
          assignment: {
            profileId: 'p-copy',
            onScreenOnly: true,
            pinned: ['open_file.access'],
            exceptions: [
              {
                tool: 'open_file',
                scope: { kind: 'path', path: '/a' },
                rule: { decision: 'deny' },
              },
            ],
          },
        })),
      }),
    });
    h.service.start();
    const first = h.service.ui([sessionRow('s1')]);
    expect(first.profiles[0]?.rules).toEqual(OBSERVER.rules);
    expect(first.assignments).toHaveLength(4);
    first.profiles[0].rules.open_file.decision = 'allow';
    first.profiles[3].rules.open_file.decision = 'allow';
    first.assignments[0].assignment.exceptions[0].scope = { kind: 'anywhere' };
    first.assignments[0].assignment.exceptions[0].rule.decision = 'allow';
    first.assignments[1].assignment.pinned = [];
    first.assignments[0].point = { kind: 'peer', machineId: 'wrong' };
    const second = h.service.ui([sessionRow('s1')]);
    expect(second.profiles[0]?.rules.open_file.decision).toBe('deny');
    expect(second.profiles[3]?.rules.open_file.decision).toBe('deny');
    expect(second.assignments[1]?.assignment.pinned).toEqual(['open_file.access']);
    expect(second.assignments[0]).toMatchObject({
      point: { kind: 'default' },
      assignment: {
        exceptions: [{ scope: { kind: 'path', path: '/a' }, rule: { decision: 'deny' } }],
      },
    });
  });

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

  it('a failed widening warns and keeps the previous decision state', async () => {
    const h = harness({ writeFails: true });
    h.service.start();
    h.service.setAssignment({ kind: 'default' }, 'lead');
    h.fire(WRITE_MS);
    await h.service.stop();

    expect(h.warnings.some((m) => m.includes('policy.json'))).toBe(true);
    expect(h.service.ui([sessionRow('s1')]).sessions.s1?.profileId).toBe('worker');
  });

  it('revokeGrant ends a grant once and persists it', async () => {
    const h = harness({
      grants: serializeGrantsFile({ version: 1, grants: [grant({ id: 'g-keep' })] }),
    });
    h.service.start();
    expect(h.service.revokeGrant('g-keep')).toEqual({ ok: true });
    expect(h.service.revokeGrant('g-keep')).toEqual({ ok: false, error: 'not-found' });
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
    expect(created).toBeNull();
    expect(h.service.ui([]).grants).toEqual([]);
    expect(h.service.revokeGrant('missing')).toEqual({ ok: false, error: 'not-found' });
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
    expect(h.service.revokeGrant('g-s2')).toEqual({ ok: true });
    expect(h.service.commit(input, decision)).toEqual({ ok: false, error: 'policy-changed' });
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
    expect(h.service.revokeGrant('g-a')).toEqual({ ok: true });
    expect(h.service.decide(input).decision).toBe('allow');
    expect(h.service.commit(input, decision)).toEqual({ ok: false, error: 'policy-changed' });
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
    expect(h.service.commit(input, decision)).toEqual({ ok: false, error: 'policy-changed' });
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
    expect(h.service.commit(input, asked)).toEqual({ ok: true, overrides: [] });
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

    expect(h.service.commit(input, first)).toMatchObject({ ok: true });
    const afterFirst = h.service.ui([]).grants.map((g) => [g.id, g.lastUsedAt]);
    h.advance(MIN);
    expect(h.service.commit(input, second)).toEqual({ ok: false, error: 'policy-changed' });
    expect(h.service.ui([]).grants.map((g) => [g.id, g.lastUsedAt])).toEqual(afterFirst);
    expect(h.service.decide(input).decision).toBe('deny');
  });

  it('a failed override save does not count or touch the grant', () => {
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
        grants: [grant({ useCount: 0, id: 'g-s2', on: { kind: 'session', sessionId: 's2' } })],
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
    expect(first).toMatchObject({ decision: 'allow', overrideIds: ['o1'], grantIds: ['g-s2'] });
    h.setWriteDown(true);
    expect(h.service.commit(input, first)).toEqual({ ok: false, error: 'save-failed' });
    expect(h.service.ui([]).grants[0]).toMatchObject({ useCount: 0, lastUsedAt: null });
  });

  it('a successful grant consumption increments exactly once', () => {
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
        grants: [grant({ useCount: 0, id: 'g-s2', on: { kind: 'session', sessionId: 's2' } })],
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
    expect(first).toMatchObject({ decision: 'allow', overrideIds: ['o1'], grantIds: ['g-s2'] });
    expect(h.service.ui([]).grants[0]).toMatchObject({ useCount: 0, lastUsedAt: null });
    expect(h.service.commit(input, first)).toMatchObject({ ok: true });
    expect(h.service.ui([]).grants[0]).toMatchObject({ useCount: 1, lastUsedAt: iso(T0) });
    expect(h.service.commit(input, first)).toEqual({ ok: false, error: 'policy-changed' });
    expect(h.service.ui([]).grants[0]).toMatchObject({ useCount: 1 });
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
    expect(h.service.commit(input, first)).toEqual({ ok: true, overrides: [override] });
    expect(h.service.commit(input, first)).toEqual({ ok: false, error: 'policy-changed' });
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
    expect(removed).toEqual({ ok: true, overrides: [expect.objectContaining({ id: 'o1' })] });
    if (!removed.ok) throw new Error('Expected override commit');

    h.advance(MIN);
    const answer = h.service.decide({ ...input, heldOverrides: removed.overrides });
    expect(answer).toMatchObject({ decision: 'allow', overrideIds: ['o1'], grantIds: ['g-s2'] });
    const before = h.changed();
    expect(h.service.commit(input, answer, removed.overrides)).toEqual({ ok: true, overrides: [] });
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
    expect(h.service.commit(input, answer, [held])).toEqual({ ok: true, overrides: [] });
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

  it('reports a failed human save once without a timer retry', async () => {
    const h = harness({ writeFails: true });
    h.service.start();
    expect(h.service.setAssignment({ kind: 'default' }, 'lead')).toEqual({
      ok: false,
      error: 'save-failed',
    });
    const saveFailures = () => h.warnings.filter((m) => m.includes('policy.json'));
    for (let i = 0; i < 3; i++) {
      h.fire(WRITE_MS);
      await h.settle();
    }
    expect(saveFailures()).toHaveLength(1);
    h.setWriteDown(false);
    h.fire(WRITE_MS);
    await h.settle();
    expect(h.policyWrites).toHaveLength(0);
    expect(h.service.ui([]).assignments).toEqual([]);
    expect(h.service.setAssignment({ kind: 'default' }, 'lead')).toEqual({ ok: true });
    expect(h.policyWrites).toHaveLength(1);
    expect(h.service.ui([]).saveError).toBeNull();
    h.setWriteDown(true);
    expect(h.service.setAssignment({ kind: 'default' }, 'worker')).toEqual({
      ok: false,
      error: 'save-failed',
    });
    expect(saveFailures()).toHaveLength(2);
    expect(h.service.ui([sessionRow('s1')]).sessions.s1?.profileId).toBe('lead');
    await h.service.stop();
    expect(saveFailures()).toHaveLength(2);
  });

  it('explicit retry saves current conservative state without reviving the rejected human draft', async () => {
    const h = harness({ writeFails: true });
    h.service.start();
    expect(h.service.setAssignment({ kind: 'default' }, 'lead')).toEqual({
      ok: false,
      error: 'save-failed',
    });
    h.fire(WRITE_MS);
    await h.settle();
    expect(h.warnings.filter((m) => m.includes('policy.json'))).toHaveLength(1);
    h.setWriteDown(false);
    h.fire(WRITE_MS);
    await h.settle();
    expect(h.policyWrites).toHaveLength(0);
    expect(h.service.retrySave()).toEqual({ ok: true });
    expect(h.policyWrites).toHaveLength(1);
    expect(parsePolicyFile(h.policyWrites[0] ?? '')).toMatchObject({
      ok: true,
      file: { assignments: [] },
    });
    await h.service.stop();
    expect(h.policyWrites).toHaveLength(1);
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
    const result = h.service.applyRemoteDoc(0, pushed(), true);
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
    expect(h.service.applyRemoteDoc(0, pushed(), true)).toEqual({ ok: true, rev: 1 });
    const current = h.service.remoteDoc();
    const changed = h.changed();
    h.fire(WRITE_MS);
    const writes = h.policyWrites.length;
    expect(
      h.service.applyRemoteDoc(0, pushed({ profiles: [profile('p-2', 'Stale')] }), true),
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
      true,
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
    const result = h.service.applyRemoteDoc(0, doc, true);
    expect(result).toMatchObject({ ok: false, code: 'invalid_args' });
    expect(result.ok ? '' : result.message).toMatch(path);
    expect(h.service.remoteDoc().rev).toBe(0);
  });

  it('a pushed doc with no default assignment applies, and the engine falls back to the built-in default', () => {
    const h = harness({ policy: seeded() });
    h.service.start();
    const result = h.service.applyRemoteDoc(
      0,
      {
        profiles: [],
        assignments: [entry({ kind: 'peer', machineId: 'm-1' }, 'observer')],
      },
      true,
    );
    expect(result).toEqual({ ok: true, rev: 1 });
    expect(h.service.ui([sessionRow('s2')]).sessions.s2?.profileId).toBe('worker');
  });

  it('applyRemoteDoc on a readOnly policy is policy_unavailable', () => {
    const h = harness({ policy: '{"version":99}' });
    h.service.start();
    expect(h.service.ui([]).readOnly).toBe(true);
    expect(h.service.applyRemoteDoc(0, pushed(), true)).toMatchObject({
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
    h.service.applyRemoteDoc(1, pushed(), true);
    expect(seen).toEqual([1, 2]);
    off();
    h.service.setAssignment({ kind: 'default' }, 'worker');
    expect(seen).toEqual([1, 2]);
  });

  it('onRemoteDocChange also fires when a grant is made or revoked, without moving rev', () => {
    const h = harness({ policy: seeded() });
    h.service.start();
    let fired = 0;
    h.service.onRemoteDocChange(() => {
      fired += 1;
    });
    const made = h.service.createGrant(
      { who: 'session', on: 'target', for: '1h' },
      session(),
      'open_file',
      target(),
      null,
    );
    expect(made).not.toBeNull();
    expect(fired).toBe(1);
    expect(h.service.remoteDoc().rev).toBe(0);
    expect(h.service.revokeGrant(made?.id ?? '')).toEqual({ ok: true });
    expect(fired).toBe(2);
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
    expect(h.service.revokeGrantByRemote('g-keep')).toEqual({ ok: true });
    expect(h.service.grantsView()).toEqual([]);
    expect(h.service.revokeGrantByRemote('g-keep')).toMatchObject({
      ok: false,
      code: 'not_found',
    });
    expect(h.service.revokeGrantByRemote('g-nope')).toMatchObject({
      ok: false,
      code: 'not_found',
    });
    await h.service.stop();
    expect(h.grantWrites).toHaveLength(1);
  });
});

describe('native profile authority', () => {
  const point = { kind: 'default' } as const;
  const optedIn = {
    profileId: 'observer',
    exceptions: [],
    onScreenOnly: false,
    applyNative: true,
  } as const;
  const token = (service: PolicyService) => service.ui([]).editToken;

  it('keeps migrated all-on Lead native launch opted out', async () => {
    const actual = await vi.importActual<typeof import('../../src/conduit-mcp/policy-migration')>(
      '../../src/conduit-mcp/policy-migration',
    );
    vi.mocked(migrateLegacyPolicy).mockImplementationOnce(actual.migrateLegacyPolicy);
    const h = harness();
    const layer: import('../../src/conduit-mcp/tool-policy').PolicyLayer = {};
    for (const group of TOOL_GROUPS.filter((g) => g.group === 'sessions' || g.group === 'editor')) {
      for (const tool of group.tools) layer[tool] = { access: 'on' };
    }
    h.deps.legacy = () => ({
      global: DEFAULT_TOOL_POLICY,
      byCli: {},
      sessions: [{ sessionId: 's1', layer, cli: null }],
    });
    h.service.start();
    h.fire(WRITE_MS);
    const saved = parsePolicyFile(h.policyWrites[0] ?? '');
    expect(saved.ok).toBe(true);
    if (!saved.ok) throw new Error('migration did not persist');
    expect(saved.file.assignments).toEqual([
      expect.objectContaining({
        point: { kind: 'session', sessionId: 's1' },
        assignment: expect.objectContaining({ profileId: 'lead', onScreenOnly: true }),
      }),
    ]);
    expect(saved.file.assignments[0]?.assignment).not.toHaveProperty('applyNative');
    const selection = h.service.nativeLaunch('s1', 'claude');
    expect(selection).toEqual({
      status: 'available',
      intent: { family: 'claude', optedIn: false, requested: null },
    });
    const spec = { command: 'claude', args: ['--model', 'sonnet'], cwd: '/work' };
    expect(
      prepareNativeLaunch(selection, { command: 'claude', args: spec.args }, spec, 'linux'),
    ).toMatchObject({ ok: true, spec });
  });

  it('binds review to the exact local candidate', () => {
    const { service } = harness();
    service.start();
    const current = token(service);
    const assignment = { ...optedIn, exceptions: [] };
    const review = service.reviewLocalPolicy({ kind: 'assignment', point, assignment }, current);
    expect(review.ok && review.requiresNativeReview).toBe(true);
    if (!review.ok || !review.requiresNativeReview) throw new Error('review missing');
    expect(
      service.saveAssignment(
        point,
        { ...assignment, onScreenOnly: !assignment.onScreenOnly },
        current,
        review.digest,
      ),
    ).toEqual({ ok: false, error: 'native-review-required' });
    expect(service.saveAssignment(point, assignment, current, review.digest)).toEqual({ ok: true });
    expect(service.saveAssignment(point, assignment, current, review.digest)).toEqual({
      ok: false,
      error: 'conflict',
    });
  });

  it('rejects an old digest with a fresh edit token after an unrelated policy edit', () => {
    const h = harness();
    h.service.start();
    const oldToken = token(h.service);
    const assignment = { ...optedIn, exceptions: [] };
    const edit = { kind: 'assignment', point, assignment } as const;
    const oldReview = h.service.reviewLocalPolicy(edit, oldToken);
    if (!oldReview.ok || !oldReview.requiresNativeReview) throw new Error('review missing');
    const otherPoint = { kind: 'session', sessionId: 's1' } as const;
    const ordinary = { profileId: 'lead' as const, exceptions: [], onScreenOnly: false };
    expect(h.service.saveAssignment(otherPoint, ordinary, oldToken)).toEqual({ ok: true });
    const freshToken = token(h.service);
    expect(freshToken).not.toBe(oldToken);
    const before = h.service.ui([]);
    const bytes = [...h.policyWrites];
    expect(h.service.saveAssignment(point, assignment, freshToken, oldReview.digest)).toEqual({
      ok: false,
      error: 'native-review-required',
    });
    expect(h.policyWrites).toEqual(bytes);
    expect(h.service.ui([]).profiles).toEqual(before.profiles);
    expect(h.service.ui([]).assignments).toEqual(before.assignments);
    const freshReview = h.service.reviewLocalPolicy(edit, freshToken);
    if (!freshReview.ok || !freshReview.requiresNativeReview)
      throw new Error('fresh review missing');
    expect(freshReview.digest).not.toBe(oldReview.digest);
    expect(h.service.saveAssignment(point, assignment, freshToken, freshReview.digest)).toEqual({
      ok: true,
    });
  });

  it('keeps review stable across grant changes and fails closed on persistence failure', () => {
    const original = policyText();
    const h = harness({
      policy: original,
      grants: serializeGrantsFile({ version: 1, grants: [grant()] }),
    });
    h.service.start();
    let durable = original;
    const write = h.deps.policyIo.writeSync;
    h.deps.policyIo.writeSync = (bytes) => {
      const result = write(bytes);
      if (result) durable = bytes;
      return result;
    };
    const current = token(h.service);
    const assignment = { ...optedIn, exceptions: [] };
    const edit = { kind: 'assignment', point, assignment } as const;
    const review = h.service.reviewLocalPolicy(edit, current);
    if (!review.ok || !review.requiresNativeReview) throw new Error('review missing');
    expect(h.service.revokeGrant('g1')).toEqual({ ok: true });
    expect(h.service.reviewLocalPolicy(edit, current)).toEqual(review);
    expect(h.policyWrites).toEqual([]);
    expect(
      Reflect.apply(h.service.saveAssignment, h.service, [point, assignment, current, true]),
    ).toEqual({ ok: false, error: 'native-review-required' });
    expect(durable).toBe(original);
    h.setWriteDown(true);
    expect(h.service.saveAssignment(point, assignment, current, review.digest)).toEqual({
      ok: false,
      error: 'save-failed',
    });
    expect(h.policyWrites).toEqual([]);
    expect(durable).toBe(original);
    expect(h.service.ui([]).assignments).toEqual([]);
    expect(token(h.service)).toBe(current);
    h.setWriteDown(false);
    expect(h.service.saveAssignment(point, assignment, current, review.digest)).toEqual({
      ok: true,
    });
    const saved = parsePolicyFile(h.policyWrites[0] ?? '');
    if (!saved.ok) throw new Error('policy did not persist');
    expect(saved.file.assignments).toEqual([{ point, assignment }]);
    const initial = parsePolicyFile(original);
    if (!initial.ok) throw new Error('invalid fixture');
    expect(h.policyWrites[0]).toBe(
      serializePolicyFile({ ...initial.file, assignments: [{ point, assignment }], rev: 1 }),
    );
    expect(durable).toBe(h.policyWrites[0]);
    expect(h.policyWrites).toHaveLength(1);
  });

  it('normalizes pins but preserves exception order in the review digest', () => {
    const { service } = harness();
    service.start();
    const point = { kind: 'cli', cli: 'claude' } as const;
    const one = {
      tool: 'open_session',
      scope: { kind: 'anywhere' },
      rule: { decision: 'ask' },
    } as const;
    const two = {
      tool: 'send_input',
      scope: { kind: 'anywhere' },
      rule: { decision: 'deny' },
    } as const;
    const assignment = {
      ...optedIn,
      exceptions: [one, two],
      pinned: ['send_input.decision', 'open_session.decision'],
    };
    const current = token(service);
    const review = service.reviewLocalPolicy({ kind: 'assignment', point, assignment }, current);
    const reorderedPins = service.reviewLocalPolicy(
      {
        kind: 'assignment',
        point,
        assignment: { ...assignment, pinned: [...assignment.pinned].reverse() },
      },
      current,
    );
    const reorderedRules = service.reviewLocalPolicy(
      { kind: 'assignment', point, assignment: { ...assignment, exceptions: [two, one] } },
      current,
    );
    expect(review).toEqual(reorderedPins);
    expect(review).not.toEqual(reorderedRules);
  });

  it('reviews profile and replacement edits and preview does not write', () => {
    const h = harness();
    h.service.start();
    const profile = {
      ...OBSERVER,
      id: 'p-review' as const,
      name: 'Review',
      builtIn: false,
      nativeModes: { claude: 'plan' as const, codex: 'unset' as const },
    };
    const current = token(h.service);
    const review = h.service.reviewLocalPolicy({ kind: 'profile', profile }, current);
    expect(h.policyWrites).toHaveLength(0);
    if (!review.ok || !review.requiresNativeReview) throw new Error('review missing');
    expect(h.service.saveProfile(profile, current, 'wrong')).toEqual({
      ok: false,
      error: 'native-review-required',
    });
    expect(h.service.saveProfile(profile, current, review.digest)).toEqual({ ok: true });
    const next = token(h.service);
    const deletion = h.service.reviewLocalPolicy(
      { kind: 'delete-profile', profileId: profile.id, replacement: 'worker' },
      next,
    );
    if (!deletion.ok || !deletion.requiresNativeReview) throw new Error('review missing');
    expect(h.service.deleteProfile(profile.id, 'worker', next, deletion.digest)).toEqual({
      ok: true,
    });
  });

  it('requires owner consent and refuses legacy materialization over inherited opt-in', () => {
    const { service, policyWrites } = harness();
    service.start();
    const assignment = { ...optedIn, exceptions: [] };
    expect(service.saveAssignment(point, assignment, token(service))).toEqual({
      ok: false,
      error: 'native-review-required',
    });
    const review = service.reviewLocalPolicy(
      { kind: 'assignment', point, assignment },
      token(service),
    );
    if (!review.ok || !review.requiresNativeReview) throw new Error('review missing');
    expect(service.saveAssignment(point, assignment, token(service), review.digest)).toEqual({
      ok: true,
    });
    const saves = policyWrites.length;
    expect(service.setAssignment({ kind: 'session', sessionId: 's1' }, 'observer')).toEqual({
      ok: false,
      error: 'native-review-required',
    });
    expect(
      service.applyLegacyPatch({ kind: 'cli', cli: 'claude' }, point, 'send_input', {
        access: 'ask',
      }),
    ).toEqual({
      ok: false,
      error: 'native-review-required',
    });
    expect(policyWrites).toHaveLength(saves);
    expect(service.nativeLaunch('s1', 'claude')).toEqual({
      status: 'available',
      intent: { family: 'claude', optedIn: true, requested: { mode: 'plan' } },
    });
    const sessionPoint = { kind: 'session', sessionId: 's1' } as const;
    const sessionAssignment = { ...assignment, applyNative: false };
    const secondReview = service.reviewLocalPolicy(
      { kind: 'assignment', point: sessionPoint, assignment: sessionAssignment },
      token(service),
    );
    if (!secondReview.ok || !secondReview.requiresNativeReview) throw new Error('review missing');
    expect(
      service.saveAssignment(sessionPoint, sessionAssignment, token(service), secondReview.digest),
    ).toEqual({ ok: true });
    expect(service.nativeLaunch('s1', 'claude')).toEqual({
      status: 'available',
      intent: { family: 'claude', optedIn: false, requested: null },
    });
  });

  it('requires a loaded writable policy, independently of grant recovery', () => {
    const { service } = harness({ grants: '{"version":99}' });
    expect(service.nativeLaunch('s1', 'codex')).toEqual({ status: 'unavailable' });
    service.start();
    expect(service.ui([]).readOnly).toBe(true);
    expect(service.nativeLaunch('s1', 'codex')).toEqual({
      status: 'available',
      intent: { family: 'codex', optedIn: false, requested: null },
    });
    const recovery = harness({ policy: '{"version":99}', lastGood: policyText() }).service;
    recovery.start();
    expect(recovery.nativeLaunch('s1', 'codex')).toEqual({ status: 'unavailable' });
  });

  it('refuses duplicate portable profile orderings before altering a private opted-in session', () => {
    const neutral: Profile = {
      id: 'p-native',
      name: 'Neutral',
      builtIn: false,
      rules: DEFAULT_RULES,
      nativeModes: { claude: 'unset', codex: 'unset' },
    };
    const planned: Profile = {
      ...neutral,
      name: 'Plan',
      nativeModes: { claude: 'plan', codex: 'unset' },
    };
    const { service, policyWrites } = harness({
      policy: policyText({
        profiles: [neutral],
        assignments: [
          {
            point: { kind: 'session', sessionId: 's1' },
            assignment: { ...optedIn, profileId: neutral.id, exceptions: [] },
          },
        ],
      }),
    });
    service.start();
    const launch = {
      status: 'available',
      intent: { family: 'claude', optedIn: true, requested: null },
    };
    expect(service.nativeLaunch('s1', 'claude')).toEqual(launch);
    for (const profiles of [
      [planned, neutral],
      [neutral, planned],
    ]) {
      expect(service.applyRemoteDoc(0, { profiles, assignments: [] }, true)).toMatchObject({
        ok: false,
        code: 'invalid_args',
        message: expect.stringContaining('duplicates'),
      });
      expect(service.nativeLaunch('s1', 'claude')).toEqual(launch);
      expect(service.remoteDoc().rev).toBe(0);
      expect(policyWrites).toHaveLength(0);
    }
  });

  it('protects retained private assignments and refuses a legacy controller native delta', () => {
    const custom: Profile = {
      id: 'p-native',
      name: 'Native',
      builtIn: false,
      rules: DEFAULT_RULES,
    };
    const { service } = harness({
      policy: policyText({
        profiles: [custom],
        assignments: [
          {
            point: { kind: 'session', sessionId: 's1' },
            assignment: { ...optedIn, profileId: custom.id, exceptions: [] },
          },
        ],
      }),
    });
    service.start();
    expect(service.applyRemoteDoc(0, { profiles: [], assignments: [] }, true)).toMatchObject({
      ok: false,
      message: expect.stringContaining('local session'),
    });
    const withModes = { ...custom, nativeModes: { claude: 'plan', codex: 'unset' } };
    expect(
      service.applyRemoteDoc(0, { profiles: [withModes], assignments: [] }, false),
    ).toMatchObject({
      ok: false,
      code: 'policy_unavailable',
    });
    expect(
      service.applyRemoteDoc(
        0,
        { profiles: [{ ...custom, name: 'Renamed' }], assignments: [] },
        false,
      ),
    ).toEqual({
      ok: true,
      rev: 1,
    });
  });
});

it('commits session denial between marker and backup before notification, and retries idempotently', () => {
  const h = harness({ policy: policyText() });
  h.service.start();
  const before = h.changed();
  const callback = vi.fn(() => {
    expect(h.changed()).toBe(before);
    expect(JSON.parse(h.lastGoodWrites.at(-1) ?? '{}').sessionDenials).toHaveLength(1);
    expect(JSON.parse(h.policyWrites.at(-1) ?? '{}').sessionDenials).toHaveLength(1);
  });
  expect(h.service.saveSessionDenial('r1', 's1', 'open_session', callback)).toEqual({ ok: true });
  expect(callback).toHaveBeenCalledOnce();
  expect(JSON.parse(h.lastGoodWrites.at(-1) ?? '{}').sessionDenials).toHaveLength(1);
  expect(h.service.saveSessionDenial('r1', 's1', 'open_session', () => {})).toEqual({ ok: true });
  expect(h.policyWrites).toHaveLength(1);
  h.service.sessionEnded('s1');
  expect(JSON.parse(h.policyWrites.at(-1) ?? '{}')).toMatchObject({
    version: 3,
    sessionDenials: [],
  });
});

it('fails closed when a marker is the only recovery copy', () => {
  const h = harness({ lastGood: JSON.stringify({ version: 3, kind: 'recovery-unavailable' }) });
  h.service.start();
  expect(h.service.ui([]).readOnly).toBe(true);
  expect(h.legacyCalls()).toBe(0);
});

it('leaves the prior authority and wait untouched when marker or primary fails', () => {
  const h = harness({ policy: policyText() });
  h.service.start();
  const notify = vi.fn();
  const marker = vi.spyOn(h.deps.lastGoodIo, 'writeSync').mockImplementationOnce(() => {
    throw new Error('marker');
  });
  expect(h.service.saveSessionDenial('r1', 's1', 'open_session', notify)).toEqual({
    ok: false,
    error: 'save-failed',
  });
  expect(h.policyWrites).toHaveLength(0);
  expect(notify).not.toHaveBeenCalled();
  marker.mockRestore();
  const primary = vi.spyOn(h.deps.policyIo, 'writeSync').mockImplementationOnce(() => {
    throw new Error('primary');
  });
  expect(h.service.saveSessionDenial('r1', 's1', 'open_session', notify)).toEqual({
    ok: false,
    error: 'save-failed',
  });
  expect(JSON.parse(h.lastGoodWrites.at(-1) ?? '{}')).toEqual({
    version: 3,
    kind: 'recovery-unavailable',
  });
  expect(notify).not.toHaveBeenCalled();
  primary.mockRestore();
  expect(h.service.saveSessionDenial('r1', 's1', 'open_session', notify)).toEqual({ ok: true });
});

it('keeps the second denial when final backup fails and fails closed if primary is lost', () => {
  const h = harness({ policy: policyText() });
  h.service.start();
  expect(h.service.saveSessionDenial('r1', 's1', 'open_session', () => {})).toEqual({ ok: true });
  const original = h.deps.lastGoodIo.writeSync;
  vi.spyOn(h.deps.lastGoodIo, 'writeSync').mockImplementation((text) => {
    if (JSON.parse(text).kind !== 'recovery-unavailable') throw new Error('backup');
    return original(text);
  });
  expect(h.service.saveSessionDenial('r2', 's1', 'open_file', () => {})).toEqual({ ok: true });
  expect(JSON.parse(h.policyWrites.at(-1) ?? '{}').sessionDenials).toHaveLength(2);
  expect(h.service.ui([]).backupWarning).not.toBeNull();
  const restarted = harness({ lastGood: h.lastGoodWrites.at(-1) });
  restarted.service.start();
  expect(restarted.service.ui([]).readOnly).toBe(true);
  expect(restarted.legacyCalls()).toBe(0);
});

it('recovers restrictively from an actual marker after a second denial loses its backup and primary', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'con25-denial-recovery-'));
  const primaryPath = path.join(dir, 'policy.json');
  const backupPath = path.join(dir, 'policy.last-good.json');
  const primary = createPolicyIo(primaryPath);
  const backup = createPolicyIo(backupPath);
  primary.writeSync(policyText());
  const h = harness();
  h.deps.policyIo = primary;
  h.deps.lastGoodIo = backup;
  h.service.start();
  expect(h.service.saveSessionDenial('r1', 's1', 'open_session', () => {})).toEqual({ ok: true });
  expect(JSON.parse(backup.read() ?? '{}').sessionDenials).toHaveLength(1);
  const original = backup.writeSync;
  vi.spyOn(backup, 'writeSync').mockImplementation((text) => {
    if (JSON.parse(text).kind !== 'recovery-unavailable') throw new Error('final backup');
    return original(text);
  });
  expect(h.service.saveSessionDenial('r2', 's1', 'open_file', () => {})).toEqual({ ok: true });
  expect(JSON.parse(primary.read() ?? '{}').sessionDenials).toHaveLength(2);
  expect(JSON.parse(backup.read() ?? '{}')).toEqual({ version: 3, kind: 'recovery-unavailable' });
  fs.writeFileSync(primaryPath, 'corrupt');
  const restarted = harness();
  restarted.deps.policyIo = createPolicyIo(primaryPath);
  restarted.deps.lastGoodIo = createPolicyIo(backupPath);
  restarted.service.start();
  expect(restarted.service.ui([]).readOnly).toBe(true);
  expect(restarted.legacyCalls()).toBe(0);
  expect(
    restarted.service.decide({
      principal: session(),
      tool: 'open_session',
      targets: [],
      masterOn: true,
      toYou: false,
    }).decision,
  ).toBe('deny');
});

it('refuses record and byte caps without changing storage or invoking settlement', () => {
  const base = {
    id: '',
    requestId: '',
    sessionId: 's1',
    tool: 'open_session' as const,
    createdAt: iso(T0),
  };
  const full = Array.from({ length: 4096 }, (_, i) => ({
    ...base,
    id: `d${i}`,
    requestId: `r${i}`,
  }));
  const h = harness({ policy: policyText({ version: 3, sessionDenials: full }) });
  h.service.start();
  const settle = vi.fn();
  const writes = h.lastGoodWrites.length;
  expect(h.service.saveSessionDenial('overflow', 's1', 'open_session', settle)).toEqual({
    ok: false,
    error: 'too-large',
  });
  expect(h.lastGoodWrites).toHaveLength(writes);
  expect(h.policyWrites).toHaveLength(0);
  expect(settle).not.toHaveBeenCalled();
  const big = harness({
    policy: policyText({
      version: 3,
      sessionDenials: [
        { ...base, id: 'd', requestId: 'r', sessionId: 'x'.repeat(POLICY_MAX_BYTES) },
      ],
    }),
  });
  big.service.start();
  expect(big.service.saveSessionDenial('overflow', 's1', 'open_session', settle)).toEqual({
    ok: false,
    error: 'too-large',
  });
  expect(big.policyWrites).toHaveLength(0);
  expect(settle).not.toHaveBeenCalled();
});

it('propagates settlement exceptions after the durable primary without policy notification', () => {
  const h = harness({ policy: policyText() });
  h.service.start();
  const before = h.changed();
  expect(() =>
    h.service.saveSessionDenial('r1', 's1', 'open_session', () => {
      throw new Error('invariant');
    }),
  ).toThrow('invariant');
  expect(h.changed()).toBeGreaterThan(before);
  expect(JSON.parse(h.policyWrites.at(-1) ?? '{}').sessionDenials).toHaveLength(1);
  expect(JSON.parse(h.lastGoodWrites.at(-1) ?? '{}').sessionDenials).toHaveLength(1);
  expect(
    h.service.decide({
      principal: session(),
      tool: 'open_session',
      targets: [],
      masterOn: true,
      toYou: false,
    }).reason.by,
  ).toBe('session-deny');
});

it('reports recovery-unavailable distinctly and preserves backup warnings when settlement throws', () => {
  const restarted = harness({
    lastGood: JSON.stringify({ version: 3, kind: 'recovery-unavailable' }),
  });
  restarted.service.start();
  expect(restarted.warnings).toContain(
    'policy.last-good.json recovery is unavailable after a permissions save',
  );
  expect(
    restarted
      .activityRows()
      .some((row) => String(row.summary).includes('unavailable after a permissions save')),
  ).toBe(true);
  const h = harness({ policy: policyText() });
  h.service.start();
  const original = h.deps.lastGoodIo.writeSync;
  vi.spyOn(h.deps.lastGoodIo, 'writeSync').mockImplementation((text) => {
    if (JSON.parse(text).kind !== 'recovery-unavailable') throw new Error('backup');
    return original(text);
  });
  expect(() =>
    h.service.saveSessionDenial('r', 's1', 'open_session', () => {
      throw new Error('settlement');
    }),
  ).toThrow('settlement');
  expect(h.service.ui([]).backupWarning).not.toBeNull();
  expect(JSON.parse(h.lastGoodWrites.at(-1) ?? '{}').kind).toBe('recovery-unavailable');
  expect(JSON.parse(h.policyWrites.at(-1) ?? '{}').sessionDenials).toHaveLength(1);
});

it('preserves a reentrant conservative failure and retries it without backing up unwritten state', () => {
  const override: OneUseOverride = {
    id: 'o',
    sessionId: 's2',
    tool: 'open_session',
    target: target(),
    createdAt: iso(T0),
  };
  const h = harness({ policy: policyText({ overrides: [override] }) });
  h.service.start();
  const original = h.deps.policyIo.writeSync;
  let attempts = 0;
  vi.spyOn(h.deps.policyIo, 'writeSync').mockImplementation((text) => {
    attempts++;
    if (attempts === 2) throw new Error('nested failure');
    return original(text);
  });
  expect(
    h.service.saveSessionDenial('r', 's1', 'open_session', () => h.service.sessionEnded('s2')),
  ).toEqual({ ok: true });
  expect(JSON.parse(h.policyWrites.at(-1) ?? '{}').overrides).toHaveLength(1);
  expect(JSON.parse(h.lastGoodWrites.at(-1) ?? '{}').overrides).toHaveLength(1);
  expect(h.timers.some((timer) => timer.ms === 250)).toBe(true);
  h.fire(250);
  expect(JSON.parse(h.policyWrites.at(-1) ?? '{}').overrides).toHaveLength(0);
  expect(JSON.parse(h.lastGoodWrites.at(-1) ?? '{}').overrides).toHaveLength(0);
});

it('restarts correctly at each durable denial crash boundary', () => {
  const denial = {
    id: 'd',
    requestId: 'r',
    sessionId: 's1',
    tool: 'open_session' as const,
    createdAt: iso(T0),
  };
  const old = policyText();
  const next = policyText({ version: 3, sessionDenials: [denial] });
  const marker = JSON.stringify({ version: 3, kind: 'recovery-unavailable' });
  for (const [primaryText, backupText, denied] of [
    [old, old, false],
    [old, marker, false],
    [next, marker, true],
    [next, next, true],
  ] as const) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'con25-crash-state-'));
    const h = harness();
    h.deps.policyIo = createPolicyIo(path.join(dir, 'policy.json'));
    h.deps.lastGoodIo = createPolicyIo(path.join(dir, 'policy.last-good.json'));
    h.deps.policyIo.writeSync(primaryText);
    h.deps.lastGoodIo.writeSync(backupText);
    h.service.start();
    expect(h.service.ui([]).readOnly).toBe(false);
    expect(h.legacyCalls()).toBe(0);
    expect(
      h.service.decide({
        principal: session(),
        tool: 'open_session',
        targets: [],
        masterOn: true,
        toYou: false,
      }).reason.by === 'session-deny',
    ).toBe(denied);
  }
});

it('warns before notifying when a durable marker outlives a failed denial primary, and clears only after backup', () => {
  const h = harness({ policy: policyText() });
  h.service.start();
  const settle = vi.fn();
  const notice = vi.fn(() => h.service.ui([]).backupWarning);
  h.deps.onChanged = notice;
  const primary = vi.spyOn(h.deps.policyIo, 'writeSync').mockImplementationOnce(() => {
    throw new Error('primary');
  });
  expect(h.service.saveSessionDenial('r', 's1', 'open_session', settle)).toEqual({
    ok: false,
    error: 'save-failed',
  });
  expect(notice).toHaveReturnedWith(expect.stringContaining('backup'));
  const warning = h.service.ui([]).backupWarning;
  expect(warning).toContain('backup');
  expect(h.policyWrites).toHaveLength(0);
  expect(JSON.parse(h.lastGoodWrites.at(-1) ?? '{}').kind).toBe('recovery-unavailable');
  expect(settle).not.toHaveBeenCalled();
  primary.mockRestore();
  const marker = vi.spyOn(h.deps.lastGoodIo, 'writeSync').mockImplementationOnce(() => {
    throw new Error('marker');
  });
  expect(h.service.saveSessionDenial('r', 's1', 'open_session', settle)).toEqual({
    ok: false,
    error: 'save-failed',
  });
  expect(h.service.ui([]).backupWarning).toBe(warning);
  expect(JSON.parse(h.lastGoodWrites.at(-1) ?? '{}').kind).toBe('recovery-unavailable');
  marker.mockRestore();
  expect(h.service.saveSessionDenial('r', 's1', 'open_session', settle)).toEqual({ ok: true });
  expect(h.service.ui([]).backupWarning).toBeNull();
  expect(settle).toHaveBeenCalledOnce();
});
