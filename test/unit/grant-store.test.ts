import { beforeEach, describe, expect, it } from 'vitest';
import {
  createGrantStore,
  GRANT_DECAY_MS,
  GRANT_EXPIRING_MS,
  GRANT_KEEP_EXPIRED_MS,
  type GrantStore,
  grantScopeFor,
  grantWhoFor,
  isExpiring,
} from '../../src/conduit-mcp/grant-store';
import type { PolicyTarget, Principal } from '../../src/conduit-mcp/policy-types';

const T0 = Date.parse('2026-11-14T12:00:00.000Z');
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

let t = T0;
let ids = 0;
let store: GrantStore;

beforeEach(() => {
  t = T0;
  ids = 0;
  store = createGrantStore({ now: () => t, newId: () => `g${++ids}` });
});

const session = (over: Partial<Extract<Principal, { kind: 'session' }>> = {}): Principal => ({
  kind: 'session',
  sessionId: 's1',
  handle: 'alpha',
  launchedCli: null,
  homeFolder: '/home/u/proj',
  projectId: 'p1',
  ...over,
});

const remote: Principal = {
  kind: 'remote',
  handle: 'r',
  machineId: 'm-1',
  trust: 'own',
  controller: false,
  capabilities: { messaging: false, monitor: false, drive: false },
};

const target = (over: Partial<PolicyTarget> = {}): PolicyTarget => ({
  sessionId: null,
  path: null,
  folder: null,
  projectId: null,
  ...over,
});

const ANYWHERE = { kind: 'anywhere' } as const;

describe('grant store', () => {
  it('counts successful touches for new grants while preserving legacy unknown counts', () => {
    const grant = store.create(
      { kind: 'session', sessionId: 's1' },
      'send_message',
      ANYWHERE,
      '1h',
      null,
      null,
    );
    expect(grant.useCount).toBe(0);
    store.touch(grant.id);
    expect(store.all()[0].useCount).toBe(1);
    store.load([{ ...grant, useCount: Number.MAX_SAFE_INTEGER }]);
    store.touch(grant.id);
    expect(store.all()[0].useCount).toBe(Number.MAX_SAFE_INTEGER);
    const { useCount: _count, ...legacy } = grant;
    store.load([legacy]);
    store.touch(grant.id);
    expect(store.all()[0].useCount).toBeUndefined();
  });

  it('extends, expires, renews, and restores with monotonic revisions', () => {
    const g = store.create(
      { kind: 'session', sessionId: 's1' },
      'send_message',
      ANYWHERE,
      '1h',
      null,
      null,
    );
    store.touch(g.id);
    expect(store.all()[0].lifecycleRevision).toBe(0);
    t += MIN;
    expect(store.extend(g.id, 0)).toMatchObject({
      expiresAt: iso(T0 + 2 * HOUR),
      lastConsentedAt: iso(t),
      lifecycleRevision: 1,
    });
    expect(store.extend(g.id, 0)).toBeNull();
    t = T0 + 2 * HOUR;
    store.tick();
    expect(store.all()[0]).toMatchObject({ state: 'expired', lifecycleRevision: 2 });
    expect(store.renew(g.id, 2)).toMatchObject({
      id: g.id,
      who: g.who,
      on: g.on,
      expiresAt: iso(t + HOUR),
      lifecycleRevision: 3,
    });
    const previous = store.all()[0];
    expect(store.revoke(g.id)).toMatchObject({ lifecycleRevision: 4 });
    expect(store.restore(previous, 4)).toMatchObject({ state: 'active', lifecycleRevision: 5 });
    expect(store.restore(previous, 4)).toBeNull();
  });

  it('restores suspended grants as suspended and rejects unsafe revision overflow', () => {
    const g = store.create(
      { kind: 'session', sessionId: 's1' },
      'send_message',
      ANYWHERE,
      '1h',
      null,
      null,
    );
    const suspended = { ...g, state: 'suspended' as const };
    store.load([suspended]);
    store.revoke(g.id);
    expect(store.restore(suspended, 1)).toMatchObject({ state: 'suspended', lifecycleRevision: 2 });
    store.load([{ ...g, lifecycleRevision: Number.MAX_SAFE_INTEGER }]);
    expect(store.extend(g.id, Number.MAX_SAFE_INTEGER)).toBeNull();
  });

  it('renews the original 24-hour duration and refuses stale or altered restoration', () => {
    const g = store.create(
      { kind: 'session', sessionId: 's1' },
      'send_message',
      ANYWHERE,
      '24h',
      null,
      null,
    );
    t += DAY;
    expect(store.extend(g.id, 0)).toBeNull();
    store.tick();
    expect(store.renew(g.id, 1)).toMatchObject({ expiresAt: iso(t + DAY), lifecycleRevision: 2 });
    const prior = store.all()[0];
    store.revoke(g.id);
    expect(store.restore({ ...prior, on: { kind: 'session', sessionId: 'other' } }, 3)).toBeNull();
    expect(store.restore({ ...prior, expiresAt: iso(t + 2 * DAY) }, 3)).toBeNull();
    expect(store.restore(prior, 3)).toMatchObject({ lifecycleRevision: 4 });
  });

  it('uses explicit consent for session-end idle decay', () => {
    const g = store.create(
      { kind: 'session', sessionId: 's1' },
      'send_message',
      ANYWHERE,
      'session-end',
      's1',
      null,
    );
    store.load([{ ...g, lastConsentedAt: iso(T0 + DAY) }]);
    t = T0 + GRANT_DECAY_MS + 1;
    expect(store.tick()).toHaveLength(0);
    t += DAY;
    expect(store.tick()).toHaveLength(1);
  });

  it('session-end grant expires at sessionEnded and after 7 days unused', () => {
    const byEnd = store.create(
      { kind: 'session', sessionId: 's1' },
      'send_message',
      ANYWHERE,
      'session-end',
      null,
      null,
    );
    const byAnchor = store.create(
      { kind: 'cli', cli: 'claude' },
      'read_inbox',
      ANYWHERE,
      'session-end',
      's2',
      null,
    );
    const forever = store.create(
      { kind: 'cli', cli: 'claude' },
      'list_sessions',
      ANYWHERE,
      'until-revoked',
      's2',
      null,
    );

    t += 1000;
    expect(store.sessionEnded('s1').map((g) => [g.id, g.state, g.endedAt])).toEqual([
      [byEnd.id, 'expired', iso(T0 + 1000)],
    ]);
    expect(store.sessionEnded('s2').map((g) => g.id)).toEqual([byAnchor.id]);
    expect(store.all().find((g) => g.id === forever.id)?.state).toBe('active');

    const idle = store.create(
      { kind: 'cli', cli: 'codex' },
      'read_inbox',
      ANYWHERE,
      'session-end',
      null,
      null,
    );
    t += GRANT_DECAY_MS;
    expect(store.tick()).toEqual([]);
    expect(store.all().find((g) => g.id === idle.id)?.state).toBe('active');
    t += 1;
    expect(store.tick().map((g) => [g.id, g.state])).toEqual([[idle.id, 'expired']]);
  });

  it('touch resets decay', () => {
    const g = store.create(
      { kind: 'cli', cli: 'claude' },
      'read_inbox',
      ANYWHERE,
      'session-end',
      null,
      null,
    );
    t += 6 * DAY;
    store.touch(g.id);
    t += 6 * DAY;
    expect(store.tick()).toEqual([]);
    t += DAY + 1;
    expect(store.tick().map((x) => x.state)).toEqual(['expired']);
  });

  it('1h grant expires at its time', () => {
    const hour = store.create(
      { kind: 'session', sessionId: 's1' },
      'send_message',
      ANYWHERE,
      '1h',
      null,
      null,
    );
    expect(hour.expiresAt).toBe(iso(T0 + HOUR));
    expect(
      store.create(
        { kind: 'session', sessionId: 's1' },
        'send_message',
        ANYWHERE,
        '24h',
        null,
        null,
      ).expiresAt,
    ).toBe(iso(T0 + DAY));
    expect(
      store.create(
        { kind: 'session', sessionId: 's1' },
        'send_message',
        ANYWHERE,
        'until-revoked',
        null,
        null,
      ).expiresAt,
    ).toBeNull();

    t += HOUR - 1;
    expect(store.tick()).toEqual([]);
    expect(store.all().find((g) => g.id === hour.id)?.state).toBe('active');
    t += 1;
    expect(store.tick().map((g) => [g.id, g.state, g.endedAt])).toEqual([
      [hour.id, 'expired', iso(T0 + HOUR)],
    ]);
  });

  it('tick leaves suspended grants alone', () => {
    const g = store.create(
      { kind: 'session', sessionId: 's1' },
      'send_message',
      ANYWHERE,
      '1h',
      null,
      null,
    );
    store.load([{ ...g, state: 'suspended' }]);
    t += 2 * HOUR;
    expect(store.tick()).toEqual([]);
    expect(store.all().map((x) => x.state)).toEqual(['suspended']);
  });

  it('revoke sets revoked and endedAt', () => {
    const g = store.create(
      { kind: 'cli', cli: 'claude' },
      'send_message',
      ANYWHERE,
      'until-revoked',
      null,
      null,
    );
    t += MIN;
    const revoked = store.revoke(g.id);
    expect(revoked?.state).toBe('revoked');
    expect(revoked?.endedAt).toBe(iso(T0 + MIN));
    expect(store.revoke(g.id)).toBeNull();
    expect(store.revoke('nope')).toBeNull();

    store.load([{ ...g, state: 'suspended', endedAt: null }]);
    expect(store.revoke(g.id)?.state).toBe('revoked');
  });

  it('tick purges expired after 24 h', () => {
    const g = store.create(
      { kind: 'session', sessionId: 's1' },
      'send_message',
      ANYWHERE,
      '1h',
      null,
      null,
    );
    t += HOUR;
    expect(store.tick().map((x) => x.id)).toEqual([g.id]);
    t += GRANT_KEEP_EXPIRED_MS;
    expect(store.tick()).toEqual([]);
    expect(store.all().map((x) => x.id)).toEqual([g.id]);
    t += 1;
    expect(store.tick()).toEqual([]);
    expect(store.all()).toEqual([]);
  });

  it('isExpiring under 10 min', () => {
    const g = store.create(
      { kind: 'session', sessionId: 's1' },
      'send_message',
      ANYWHERE,
      '1h',
      null,
      null,
    );
    const forever = store.create(
      { kind: 'session', sessionId: 's1' },
      'send_message',
      ANYWHERE,
      'until-revoked',
      null,
      null,
    );
    const edge = T0 + HOUR - GRANT_EXPIRING_MS;
    expect(isExpiring(g, T0)).toBe(false);
    expect(isExpiring(g, edge)).toBe(false);
    expect(isExpiring(g, edge + 1)).toBe(true);
    expect(isExpiring(g, T0 + HOUR)).toBe(false);
    expect(isExpiring(forever, edge + 1)).toBe(false);
    expect(isExpiring({ ...g, state: 'revoked' }, edge + 1)).toBe(false);
  });

  it('grantWhoFor cli returns null for a non-launched session', () => {
    expect(grantWhoFor('cli', session())).toBeNull();
    expect(grantWhoFor('cli', session({ launchedCli: 'codex' }))).toEqual({
      kind: 'cli',
      cli: 'codex',
    });
    expect(grantWhoFor('cli', remote)).toBeNull();
    expect(grantWhoFor('session', session())).toEqual({ kind: 'session', sessionId: 's1' });
    expect(grantWhoFor('session', remote)).toBeNull();
    expect(grantWhoFor('peer', remote)).toEqual({ kind: 'peer', machineId: 'm-1' });
    expect(grantWhoFor('peer', session())).toBeNull();
  });

  it('grantScopeFor target picks session scope for a session target and path scope otherwise', () => {
    const p = session();
    expect(grantScopeFor('target', target({ sessionId: 's9' }), p)).toEqual({
      kind: 'session',
      sessionId: 's9',
    });
    expect(grantScopeFor('target', target({ path: '/w/a.ts' }), p)).toEqual({
      kind: 'path',
      path: '/w/a.ts',
    });
    expect(grantScopeFor('target', target({ path: '/w/a.ts' }), remote)).toEqual({
      kind: 'path',
      path: '/w/a.ts',
    });
  });

  it('grantScopeFor returns null instead of widening', () => {
    const p = session({ homeFolder: null });
    expect(grantScopeFor('target', target(), p)).toBeNull();
    expect(grantScopeFor('folder', target(), p)).toBeNull();
    expect(grantScopeFor('folder', target({ path: '/w/a.ts' }), p)).toBeNull();
    expect(grantScopeFor('target', target(), remote)).toBeNull();
    expect(grantScopeFor('folder', target(), remote)).toBeNull();
    expect(grantScopeFor('anywhere', target({ sessionId: 's9' }), p)).toEqual(ANYWHERE);
  });

  it("a no-target call grants on the caller's home folder", () => {
    const p = session();
    expect(grantScopeFor('target', target(), p)).toEqual({
      kind: 'path',
      path: '/home/u/proj',
    });
    expect(grantScopeFor('folder', target(), p)).toEqual({
      kind: 'folder',
      path: '/home/u/proj',
    });
  });

  it("grantScopeFor folder uses the target folder (a file's parent, a session's cwd)", () => {
    const p = session();
    expect(grantScopeFor('folder', target({ path: '/w/a.ts', folder: '/w' }), p)).toEqual({
      kind: 'folder',
      path: '/w',
    });
    expect(grantScopeFor('folder', target({ sessionId: 's9', folder: '/cwd/s9' }), p)).toEqual({
      kind: 'folder',
      path: '/cwd/s9',
    });
    expect(grantScopeFor('folder', target({ folder: '/w' }), remote)).toEqual({
      kind: 'folder',
      path: '/w',
    });
  });

  it('sessionEnded also expires a grant on the ended session', () => {
    const onSession = store.create(
      { kind: 'cli', cli: 'claude' },
      'send_message',
      { kind: 'session', sessionId: 's7' },
      'until-revoked',
      null,
      null,
    );
    const elsewhere = store.create(
      { kind: 'cli', cli: 'claude' },
      'send_message',
      { kind: 'session', sessionId: 's8' },
      'until-revoked',
      null,
      null,
    );
    expect(store.sessionEnded('s7').map((g) => g.id)).toEqual([onSession.id]);
    expect(store.all().find((g) => g.id === elsewhere.id)?.state).toBe('active');
  });

  it('isExpiring also flags a session-end grant nearing its decay', () => {
    const g = store.create(
      { kind: 'cli', cli: 'claude' },
      'read_inbox',
      ANYWHERE,
      'session-end',
      null,
      null,
    );
    const decayAt = T0 + GRANT_DECAY_MS;
    expect(isExpiring(g, decayAt - GRANT_EXPIRING_MS)).toBe(false);
    expect(isExpiring(g, decayAt - GRANT_EXPIRING_MS + 1)).toBe(true);
    expect(isExpiring(g, decayAt)).toBe(false);

    t += DAY;
    store.touch(g.id);
    const touched = store.all()[0];
    const touchedDecayAt = T0 + DAY + GRANT_DECAY_MS;
    expect(isExpiring(touched, touchedDecayAt - GRANT_EXPIRING_MS + 1)).toBe(true);
    expect(isExpiring(touched, decayAt - GRANT_EXPIRING_MS + 1)).toBe(false);
  });

  it('all() returns copies the caller cannot use to mutate the store', () => {
    store.create(
      { kind: 'cli', cli: 'claude' },
      'send_message',
      { kind: 'path', path: '/a' },
      'until-revoked',
      null,
      null,
    );
    const [first] = store.all();
    first.state = 'revoked';
    if (first.on.kind === 'path') first.on.path = '/zzz';
    expect(store.all()[0].state).toBe('active');
    expect(store.all()[0].on).toEqual({ kind: 'path', path: '/a' });
  });

  it('peerRevoked ends every active or suspended grant of that peer as revoked', () => {
    const peer = { kind: 'peer', machineId: 'm-1' } as const;
    const a = store.create(peer, 'send_message', ANYWHERE, 'until-revoked', null, null);
    const b = store.create(peer, 'read_inbox', ANYWHERE, '24h', null, null);
    const suspended = store.create(peer, 'read_inbox', ANYWHERE, '24h', null, null);
    store.load(
      store.all().map((g) => (g.id === suspended.id ? { ...g, state: 'suspended' as const } : g)),
    );
    t += MIN;
    const changed = store.peerRevoked('m-1');
    expect(changed.map((g) => g.id).sort()).toEqual([a.id, b.id, suspended.id].sort());
    expect(changed.every((g) => g.state === 'revoked' && g.endedAt === iso(T0 + MIN))).toBe(true);
    expect(store.all().every((g) => g.state === 'revoked')).toBe(true);
  });

  it('peerRevoked leaves other peers, session and cli grants, and already-ended grants alone', () => {
    const other = store.create(
      { kind: 'peer', machineId: 'm-2' },
      'send_message',
      ANYWHERE,
      'until-revoked',
      null,
      null,
    );
    const cli = store.create(
      { kind: 'cli', cli: 'claude' },
      'send_message',
      ANYWHERE,
      'until-revoked',
      null,
      null,
    );
    const sessionGrant = store.create(
      { kind: 'session', sessionId: 's1' },
      'send_message',
      ANYWHERE,
      'until-revoked',
      null,
      null,
    );
    const ended = store.create(
      { kind: 'peer', machineId: 'm-1' },
      'read_inbox',
      ANYWHERE,
      'until-revoked',
      null,
      null,
    );
    store.revoke(ended.id);
    expect(store.peerRevoked('m-1')).toEqual([]);
    expect(store.all().find((g) => g.id === other.id)?.state).toBe('active');
    expect(store.all().find((g) => g.id === cli.id)?.state).toBe('active');
    expect(store.all().find((g) => g.id === sessionGrant.id)?.state).toBe('active');
  });
});
