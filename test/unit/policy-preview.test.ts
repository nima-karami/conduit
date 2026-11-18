import { expect, it } from 'vitest';
import { createPolicyService } from '../../src/conduit-mcp/policy-service';
import { DEFAULT_TOOL_POLICY } from '../../src/conduit-mcp/tool-policy';

it('previews a draft without saving and rejects a stale token', () => {
  let id = 0;
  const io = { read: () => null, writeSync: () => true as const };
  const days = new Map<string, string>();
  const service = createPolicyService({
    policyIo: io,
    lastGoodIo: io,
    grantsIo: io,
    activityIo: {
      append(day, line) {
        days.set(day, (days.get(day) ?? '') + line);
      },
      read: (day) => days.get(day) ?? '',
      list: () => [...days].map(([day, text]) => ({ day, bytes: Buffer.byteLength(text) })),
      remove() {},
      readArgs: () => null,
      writeArgs() {},
    },
    hasSession: () => true,
    peerKnown: () => null,
    grantBindingsCurrent: () => true,
    now: () => Date.parse('2026-11-14T12:00:00.000Z'),
    monotonicNow: () => 0,
    newId: () => `id${++id}`,
    setTimer: () => null,
    clearTimer() {},
    warn() {},
    legacy: () => ({ global: DEFAULT_TOOL_POLICY, byCli: {}, sessions: [] }),
    launchedCli: () => null,
    onChanged() {},
  });
  service.start();
  const token = service.ui([]).editToken;
  const input = {
    principal: {
      kind: 'session' as const,
      sessionId: 's1',
      handle: 'a',
      launchedCli: null,
      homeFolder: null,
      projectId: null,
    },
    tool: 'close_session' as const,
    targets: [{ sessionId: 's2', path: null, folder: null, projectId: null }],
    masterOn: true,
    toYou: false,
  };
  const draft = {
    point: { kind: 'session' as const, sessionId: 's1' },
    assignment: { profileId: 'lead' as const, exceptions: [], onScreenOnly: false },
  };
  const before = service.decide(input);
  const preview = service.preview(input, draft, token);
  expect(preview.ok).toBe(true);
  if (preview.ok) expect(preview.runtime).toBe('unevaluated');
  const traced = service.decideWithTrace(input, 1);
  expect(traced.trace).not.toBeNull();
  for (let i = 0; i < 1001; i++)
    service.activity.record({
      lane: 'conduit',
      principal: { handle: 'a', sessionId: 's1', machineId: null },
      cli: null,
      action: 'close_session',
      target: null,
      summary: null,
      decision: traced.decision.decision,
      decidedBy: 'policy',
      outcome: 'ok',
      durationMs: null,
      requestId: null,
      count: null,
      ...(traced.trace ? { trace: traced.trace } : {}),
    });
  const day = '2026-11-14';
  const saved = days.get(day);
  if (!saved) throw new Error('missing activity');
  const legacy = JSON.parse(saved.split('\n')[0]);
  legacy.id = 'legacy';
  delete legacy.trace;
  const malformed = { ...legacy, id: 'malformed', trace: { v: 1 } };
  days.set(day, `${saved}${JSON.stringify(legacy)}\n${JSON.stringify(malformed)}\n`);
  const replay = service.replay(draft, token);
  expect(replay).toMatchObject({
    ok: true,
    sampled: 1000,
    truncated: true,
    skipped: { aggregate: 0, legacy: 1, incomplete: 1, remote: 0 },
  });
  if (replay.ok && preview.ok)
    expect(replay.changed).toBe(preview.decision.decision === before.decision ? 0 : 1000);
  expect(service.decide(input)).toEqual(before);
  expect(service.preview(input, draft, 'stale')).toEqual({ ok: false, error: 'conflict' });
  expect(service.replay(draft, 'stale')).toEqual({ ok: false, error: 'conflict' });
  days.set(day, `${saved}invalid\n`);
  expect(service.replay(draft, token)).toEqual({ ok: false, error: 'unavailable' });
});
