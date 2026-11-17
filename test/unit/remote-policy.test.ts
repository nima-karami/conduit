import { describe, expect, it, vi } from 'vitest';
import type { PolicyIo } from '../../src/conduit-mcp/policy-file-fs';
import { OBSERVER } from '../../src/conduit-mcp/policy-profiles';
import type { Assignment, AssignmentPoint, Profile } from '../../src/conduit-mcp/policy-types';
import {
  createRemotePolicy,
  REMOTE_POLICY_DRAFTS_MAX_BYTES,
  type RemotePolicy,
} from '../../src/conduit-mcp/remote-policy';
import type { NetworkPort } from '../../src/conduit-mcp/remote-routing';
import { toolError } from '../../src/conduit-mcp/types';
import type { RemotePolicyDoc, RemotePolicySnapshot } from '../../src/contracts/remote-policy';

const EMPTY: RemotePolicyDoc = { profiles: [], assignments: [] };
const LEAD_DEFAULT: RemotePolicyDoc = {
  profiles: [],
  assignments: [
    {
      point: { kind: 'default' },
      assignment: { profileId: 'lead', exceptions: [], onScreenOnly: false },
    },
  ],
};
const OTHER: RemotePolicyDoc = {
  profiles: [],
  assignments: [
    {
      point: { kind: 'default' },
      assignment: { profileId: 'observer', exceptions: [], onScreenOnly: false },
    },
  ],
};
const snap = (rev: number, doc: RemotePolicyDoc = EMPTY): RemotePolicySnapshot => ({
  rev,
  doc,
  grants: [],
});
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const NAMES = (id: string) => (id === 'm-1' ? 'win-box' : id);

function draftsIo(initial: string | null = null) {
  const state = { text: initial as string | null, writes: [] as string[], fail: false };
  const io: PolicyIo = {
    read: () => state.text,
    writeSync: (t) => {
      if (state.fail) throw new Error('controller disk full');
      state.text = t;
      state.writes.push(t);
      return true;
    },
  };
  return { io, state };
}

let rigSequence = 0;
function rig(opts: { drafts?: string | null; support?: boolean } = {}) {
  const drafts = draftsIo(opts.drafts ?? null);
  const warnings: string[] = [];
  const pushPolicy = vi.fn<NetworkPort['pushPolicy']>(async () => ({
    ok: true,
    value: { rev: 4 },
  }));
  const revokeRemoteGrant = vi.fn<NetworkPort['revokeRemoteGrant']>(async () => ({
    ok: true,
    value: null,
  }));
  const network: Pick<NetworkPort, 'pushPolicy' | 'revokeRemoteGrant' | 'nativeSupport'> = {
    pushPolicy,
    revokeRemoteGrant,
    nativeSupport: () => opts.support ?? false,
  };
  let nextId = 0;
  const lifetime = ++rigSequence;
  const store = createRemotePolicy({
    network: () => network,
    draftsIo: drafts.io,
    now: () => 1_000,
    newId: () => `owner-${lifetime}-${++nextId}`,
    setTimer: () => null,
    clearTimer: () => undefined,
    warn: (m) => warnings.push(m),
  });
  return { store, drafts, pushPolicy, revokeRemoteGrant, warnings };
}

const persisted = (text: string | null) =>
  text === null ? null : (JSON.parse(text) as { version: number; drafts: Record<string, unknown> });

/** An edit made while the machine is connected or not, after its rules have arrived. */
function mirrored(store: RemotePolicy, rev = 3, doc: RemotePolicyDoc = EMPTY): void {
  store.apply('m-1', snap(rev, doc));
  store.setLinkState('m-1', 'up');
}

describe('remote policy store: edits and the push', () => {
  it('projects full isolated profiles and assignments for a mirrored machine', () => {
    const { store } = rig();
    mirrored(store, 3, LEAD_DEFAULT);
    const first = store.ui(NAMES)[0].policy;
    expect(first.assignments).toEqual(LEAD_DEFAULT.assignments);
    expect(first.profiles.find((p) => p.id === 'lead')?.rules.open_session.decision).toBe('allow');
    first.assignments[0].assignment.profileId = 'observer';
    const lead = first.profiles.find((p) => p.id === 'lead');
    if (!lead) throw new Error('Missing Lead profile');
    lead.rules.open_session.decision = 'deny';
    const second = store.ui(NAMES)[0].policy;
    expect(second.assignments).toEqual(LEAD_DEFAULT.assignments);
    expect(second.profiles.find((p) => p.id === 'lead')?.rules.open_session.decision).toBe('allow');
  });

  it('keeps typed local saves in the synchronous temporary service as a complete offline draft', async () => {
    const { store, drafts, pushPolicy, warnings } = rig();
    mirrored(store);
    store.setLinkState('m-1', 'down');
    const profile: Profile = {
      rules: structuredClone(OBSERVER.rules),
      id: 'p-review-copy',
      name: 'Review copy',
      builtIn: false,
    };
    profile.rules.open_session.decision = 'ask';
    const point: AssignmentPoint = { kind: 'cli', cli: 'codex' };
    const assignment: Assignment = {
      profileId: profile.id,
      exceptions: [
        { tool: 'open_file', scope: { kind: 'folder', path: '/work' }, rule: { decision: 'deny' } },
      ],
      onScreenOnly: true,
    };
    const result = store.edit('m-1', (svc) => {
      expect(svc.ui([])).toMatchObject({ readOnly: false, saveError: null, backupWarning: null });
      expect(svc.saveProfile(profile, svc.ui([]).editToken)).toEqual({ ok: true });
      const saved = svc.saveAssignment(point, assignment, svc.ui([]).editToken);
      expect(saved).toEqual({ ok: true });
      expect(svc.ui([])).toMatchObject({ readOnly: false, saveError: null, backupWarning: null });
      return saved;
    });
    expect(result).toEqual({ ok: true });
    await settle();
    const ui = store.ui(NAMES)[0];
    expect(ui).toMatchObject({
      status: 'waiting',
      link: 'down',
      rev: 3,
      refusal: null,
      policy: { readOnly: false, saveError: null, backupWarning: null },
    });
    expect(ui.policy.profiles.find((p) => p.id === profile.id)).toEqual(profile);
    expect(ui.policy.assignments).toEqual([{ point, assignment }]);
    expect(persisted(drafts.state.text)?.drafts).toEqual({
      'm-1': {
        baseRev: 3,
        doc: { profiles: [profile], assignments: [{ point, assignment }] },
        editedAt: 1_000,
      },
    });
    expect(pushPolicy).not.toHaveBeenCalled();
    expect(warnings).toEqual([]);
  });

  it('an edit while up pushes at the mirrored rev, then clears the draft and shows applied', async () => {
    const { store, pushPolicy, drafts } = rig();
    mirrored(store);
    const r = store.edit('m-1', (svc) => svc.setAssignment({ kind: 'default' }, 'lead'));
    expect(r).toEqual({ ok: true });
    await settle();
    expect(pushPolicy).toHaveBeenCalledTimes(1);
    expect(pushPolicy).toHaveBeenCalledWith('m-1', 3, LEAD_DEFAULT);
    const [ui] = store.ui(NAMES);
    expect(ui?.status).toBe('applied');
    expect(ui?.refusal).toBeNull();
    expect(persisted(drafts.state.text)?.drafts).toEqual({});
  });

  it('an edit while down is a waiting draft, persisted, and reloaded after a restart', () => {
    const first = rig();
    mirrored(first.store);
    first.store.setLinkState('m-1', 'down');
    first.store.edit('m-1', (svc) => svc.setAssignment({ kind: 'default' }, 'lead'));
    expect(first.pushPolicy).not.toHaveBeenCalled();
    expect(first.store.ui(NAMES)[0]?.status).toBe('waiting');
    expect(persisted(first.drafts.state.text)).toMatchObject({
      version: 2,
      drafts: { 'm-1': { baseRev: 3, doc: LEAD_DEFAULT } },
    });

    const restarted = rig({ drafts: first.drafts.state.text });
    const [ui] = restarted.store.ui(NAMES);
    expect(ui).toMatchObject({ machineId: 'm-1', status: 'waiting', rev: null, link: 'down' });
    expect(ui?.policy.profiles.map((p) => p.id)).toContain('observer');
  });

  it('a draft reloaded after a restart is pushed once when its rev comes back', async () => {
    const first = rig();
    mirrored(first.store);
    first.store.setLinkState('m-1', 'down');
    first.store.edit('m-1', (svc) => svc.setAssignment({ kind: 'default' }, 'lead'));
    const restarted = rig({ drafts: first.drafts.state.text });
    restarted.store.apply('m-1', snap(3));
    restarted.store.setLinkState('m-1', 'up');
    await settle();
    expect(restarted.pushPolicy).toHaveBeenCalledTimes(1);
    expect(restarted.pushPolicy).toHaveBeenCalledWith('m-1', 3, LEAD_DEFAULT);
  });

  it('reconnect with a matching rev pushes exactly once, however many snapshots arrive', async () => {
    const { store, pushPolicy } = rig();
    mirrored(store);
    store.setLinkState('m-1', 'down');
    store.edit('m-1', (svc) => svc.setAssignment({ kind: 'default' }, 'lead'));
    store.setLinkState('m-1', 'up');
    store.apply('m-1', snap(3));
    store.apply('m-1', snap(3));
    await settle();
    expect(pushPolicy).toHaveBeenCalledTimes(1);
  });

  it('a snapshot at another rev gives conflict with B copy and no push', () => {
    const { store, pushPolicy } = rig();
    mirrored(store);
    store.setLinkState('m-1', 'down');
    store.edit('m-1', (svc) => svc.setAssignment({ kind: 'default' }, 'lead'));
    store.setLinkState('m-1', 'up');
    store.apply('m-1', snap(5, OTHER));
    expect(pushPolicy).not.toHaveBeenCalled();
    const [ui] = store.ui(NAMES);
    expect(ui).toMatchObject({ status: 'conflict', rev: 5 });
    expect(ui?.conflict).not.toBeNull();
  });

  it('an edit during a conflict keeps the conflict and does not push', async () => {
    const { store, pushPolicy } = rig();
    mirrored(store);
    store.setLinkState('m-1', 'down');
    store.edit('m-1', (svc) => svc.setAssignment({ kind: 'default' }, 'lead'));
    store.setLinkState('m-1', 'up');
    store.apply('m-1', snap(5, OTHER));
    store.edit('m-1', (svc) => svc.setAssignment({ kind: 'default' }, 'worker'));
    await settle();
    expect(pushPolicy).not.toHaveBeenCalled();
    expect(store.ui(NAMES)[0]?.status).toBe('conflict');
  });

  it('discard drops the draft and returns to applied, pushing nothing', () => {
    const { store, pushPolicy, drafts } = rig();
    mirrored(store);
    store.setLinkState('m-1', 'down');
    store.edit('m-1', (svc) => svc.setAssignment({ kind: 'default' }, 'lead'));
    store.setLinkState('m-1', 'up');
    store.apply('m-1', snap(5, OTHER));
    store.discard('m-1', store.ui(NAMES)[0].policy.editToken);
    expect(pushPolicy).not.toHaveBeenCalled();
    const [ui] = store.ui(NAMES);
    expect(ui).toMatchObject({ status: 'applied', conflict: null, refusal: null });
    expect(persisted(drafts.state.text)?.drafts).toEqual({});
  });

  it('reapply rebases the draft to the conflict rev and pushes it', async () => {
    const { store, pushPolicy } = rig();
    mirrored(store);
    store.setLinkState('m-1', 'down');
    store.edit('m-1', (svc) => svc.setAssignment({ kind: 'default' }, 'lead'));
    store.setLinkState('m-1', 'up');
    store.apply('m-1', snap(5, OTHER));
    store.reapply('m-1', store.ui(NAMES)[0].policy.editToken);
    await settle();
    expect(pushPolicy).toHaveBeenCalledTimes(1);
    expect(pushPolicy).toHaveBeenCalledWith('m-1', 5, LEAD_DEFAULT);
  });

  it('a peer_unreachable push is waiting and keeps the draft', async () => {
    const { store, pushPolicy, drafts } = rig();
    pushPolicy.mockResolvedValueOnce({
      ok: false,
      error: toolError('peer_unreachable', 'the link dropped'),
    });
    mirrored(store);
    store.edit('m-1', (svc) => svc.setAssignment({ kind: 'default' }, 'lead'));
    await settle();
    expect(store.ui(NAMES)[0]?.status).toBe('waiting');
    expect(persisted(drafts.state.text)?.drafts).toMatchObject({ 'm-1': { baseRev: 3 } });
  });

  it('a policy_conflict push shows B copy as the conflict and keeps the draft', async () => {
    const { store, pushPolicy, drafts } = rig();
    pushPolicy.mockResolvedValueOnce({
      ok: false,
      error: toolError('policy_conflict', 'rules are at rev 6'),
      current: { rev: 6, doc: OTHER },
    });
    mirrored(store);
    store.edit('m-1', (svc) => svc.setAssignment({ kind: 'default' }, 'lead'));
    await settle();
    expect(store.ui(NAMES)[0]).toMatchObject({ status: 'conflict' });
    expect(persisted(drafts.state.text)?.drafts).toMatchObject({ 'm-1': { baseRev: 3 } });
  });

  it('any other push refusal is refused with its message and keeps the draft', async () => {
    const { store, pushPolicy, drafts } = rig();
    pushPolicy.mockResolvedValueOnce({
      ok: false,
      error: toolError('invalid_args', 'profiles has more than 64 entries'),
    });
    mirrored(store);
    store.edit('m-1', (svc) => svc.setAssignment({ kind: 'default' }, 'lead'));
    await settle();
    expect(store.ui(NAMES)[0]).toMatchObject({
      status: 'refused',
      refusal: 'profiles has more than 64 entries',
    });
    expect(persisted(drafts.state.text)?.drafts).toMatchObject({ 'm-1': { baseRev: 3 } });
  });

  it('gone drops the mirror and keeps the draft', () => {
    const { store, drafts } = rig();
    mirrored(store);
    store.setLinkState('m-1', 'down');
    store.edit('m-1', (svc) => svc.setAssignment({ kind: 'default' }, 'lead'));
    store.setLinkState('m-1', 'gone');
    const [ui] = store.ui(NAMES);
    expect(ui).toMatchObject({ link: 'gone', rev: null, status: 'waiting' });
    expect(persisted(drafts.state.text)?.drafts).toMatchObject({ 'm-1': { baseRev: 3 } });
  });

  it('an edit the rules refuse changes nothing and saves nothing', () => {
    const { store, drafts, pushPolicy } = rig();
    mirrored(store);
    const r = store.edit('m-1', (svc) => svc.setAssignment({ kind: 'default' }, 'p-missing'));
    expect(r).toEqual({ ok: false, error: 'unknown-profile' });
    expect(pushPolicy).not.toHaveBeenCalled();
    expect(drafts.state.writes).toEqual([]);
  });

  it('an edit to a machine with no copy is refused, not invented', () => {
    const { store } = rig();
    expect(store.edit('m-9', (svc) => svc.setAssignment({ kind: 'default' }, 'lead'))).toEqual({
      ok: false,
      error: 'no-copy',
    });
  });

  it('revoke goes to the machine that owns the grant', async () => {
    const { store, revokeRemoteGrant } = rig();
    await expect(store.revoke('m-1', 'g-9')).resolves.toEqual({ ok: true, value: null });
    expect(revokeRemoteGrant).toHaveBeenCalledWith('m-1', 'g-9');
  });
});

describe('remote policy store: the drafts file', () => {
  it('a corrupt drafts file is warned about and never overwritten', () => {
    const { store, drafts, warnings } = rig({ drafts: '{not json' });
    expect(warnings.length).toBeGreaterThan(0);
    mirrored(store);
    store.setLinkState('m-1', 'down');
    store.edit('m-1', (svc) => svc.setAssignment({ kind: 'default' }, 'lead'));
    expect(drafts.state.writes).toEqual([]);
    expect(drafts.state.text).toBe('{not json');
  });

  it('a drafts file from a newer version is never overwritten', () => {
    const newer = JSON.stringify({ version: 99, drafts: {} });
    const { store, drafts, warnings } = rig({ drafts: newer });
    expect(warnings.length).toBeGreaterThan(0);
    mirrored(store);
    store.setLinkState('m-1', 'down');
    store.edit('m-1', (svc) => svc.setAssignment({ kind: 'default' }, 'lead'));
    expect(drafts.state.writes).toEqual([]);
    expect(drafts.state.text).toBe(newer);
  });

  it('a missing drafts file means no drafts', () => {
    const { store } = rig({ drafts: null });
    expect(store.ui(NAMES)).toEqual([]);
  });
});

it('refuses failed durable intent before publishing draft token or network push', () => {
  const { store, drafts, pushPolicy } = rig();
  mirrored(store);
  const before = store.ui(NAMES)[0].policy;
  drafts.state.fail = true;
  expect(store.edit('m-1', (svc) => svc.setAssignment({ kind: 'default' }, 'lead'))).toEqual({
    ok: false,
    error: 'save-failed',
  });
  expect(store.ui(NAMES)[0].policy.assignments).toEqual(before.assignments);
  expect(store.ui(NAMES)[0].policy.editToken).toBe(before.editToken);
  expect(store.ui(NAMES)[0].policy.saveError).toContain('saved');
  expect(drafts.state.writes).toEqual([]);
  expect(pushPolicy).not.toHaveBeenCalled();
});
it.each(['{bad', JSON.stringify({ version: 99, drafts: {} })])(
  'refuses every human edit to a protected draft store',
  (text) => {
    const { store, drafts, pushPolicy } = rig({ drafts: text });
    mirrored(store);
    expect(store.edit('m-1', (svc) => svc.setAssignment({ kind: 'default' }, 'lead'))).toEqual({
      ok: false,
      error: 'read-only',
    });
    expect(store.ui(NAMES)[0].policy).toMatchObject({
      readOnly: true,
      saveError: expect.any(String),
    });
    expect(drafts.state.text).toBe(text);
    expect(pushPolicy).not.toHaveBeenCalled();
  },
);
it('keeps editable identity stable over projection grant and link status reads', () => {
  const { store } = rig();
  mirrored(store);
  const token = store.ui(NAMES)[0].policy.editToken;
  expect(store.ui(NAMES)[0].policy.editToken).toBe(token);
  store.apply('m-1', {
    ...snap(3),
    grants: [
      {
        id: 'g',
        who: 'peer',
        tool: 'open_session',
        on: { kind: 'anywhere' },
        for: 'until-revoked',
        createdAt: new Date(0).toISOString(),
        expiresAt: null,
        lastUsedAt: null,
      },
    ],
  });
  expect(store.ui(NAMES)[0].policy.editToken).toBe(token);
  store.setLinkState('m-1', 'down');
  expect(store.ui(NAMES)[0].policy.editToken).toBe(token);
});

it('full edits use stable owner CAS and reject local-only values before projection', () => {
  const { store, drafts, pushPolicy } = rig();
  mirrored(store);
  store.setLinkState('m-1', 'down');
  const token = store.ui(NAMES)[0].policy.editToken;
  expect(
    store.editFull('m-1', token, {
      kind: 'assignment',
      point: { kind: 'default' },
      assignment: { profileId: 'lead', exceptions: [], onScreenOnly: false },
    }),
  ).toEqual({ ok: true });
  const writes = drafts.state.writes.length;
  expect(
    store.editFull('m-1', token, {
      kind: 'assignment',
      point: { kind: 'default' },
      assignment: null,
    }),
  ).toEqual({ ok: false, error: 'conflict' });
  const current = store.ui(NAMES)[0].policy.editToken;
  const invalid = {
    kind: 'assignment',
    point: { kind: 'session', sessionId: 'local' },
    assignment: { profileId: 'lead', exceptions: [], onScreenOnly: false },
  } as unknown as import('../../src/conduit-mcp/ui-types').RemotePolicyEdit;
  expect(store.editFull('m-1', current, invalid)).toEqual({ ok: false, error: 'invalid-value' });
  expect(
    store.editFull('m-1', current, {
      kind: 'assignment',
      point: { kind: 'default' },
      assignment: {
        profileId: 'lead',
        onScreenOnly: false,
        exceptions: [
          {
            tool: 'close_session',
            scope: { kind: 'session', sessionId: 'local' },
            rule: { decision: 'allow' },
          },
        ],
      },
    }),
  ).toEqual({ ok: false, error: 'invalid-value' });
  expect(drafts.state.writes).toHaveLength(writes);
  expect(pushPolicy).not.toHaveBeenCalled();
  const restarted = rig({ drafts: drafts.state.text });
  expect(restarted.store.ui(NAMES)[0].policy.editToken).not.toBe(current);
  expect(restarted.store.ui(NAMES)[0].policy.assignments).toEqual(LEAD_DEFAULT.assignments);
});
it('conflict revision changes rotate intent and stale reapply never writes or pushes', () => {
  const { store, drafts, pushPolicy } = rig();
  mirrored(store);
  store.setLinkState('m-1', 'down');
  store.edit('m-1', (svc) => svc.setAssignment({ kind: 'default' }, 'lead'));
  store.apply('m-1', snap(10, OTHER));
  const old = store.ui(NAMES)[0].policy.editToken;
  store.apply('m-1', snap(11, OTHER));
  expect(store.ui(NAMES)[0].policy.editToken).not.toBe(old);
  const count = drafts.state.writes.length;
  expect(store.reapply('m-1', old)).toEqual({ ok: false, error: 'conflict' });
  expect(drafts.state.writes).toHaveLength(count);
  expect(pushPolicy).not.toHaveBeenCalled();
});
it('discard and reapply failures preserve exact durable draft and token', () => {
  const { store, drafts, pushPolicy } = rig();
  mirrored(store);
  store.setLinkState('m-1', 'down');
  store.edit('m-1', (svc) => svc.setAssignment({ kind: 'default' }, 'lead'));
  store.apply('m-1', snap(10, OTHER));
  const token = store.ui(NAMES)[0].policy.editToken;
  const text = drafts.state.text;
  drafts.state.fail = true;
  expect(store.discard('m-1', token)).toEqual({ ok: false, error: 'save-failed' });
  expect(store.reapply('m-1', token)).toEqual({ ok: false, error: 'save-failed' });
  expect(drafts.state.text).toBe(text);
  expect(store.ui(NAMES)[0]).toMatchObject({
    status: 'conflict',
    policy: { editToken: token, assignments: LEAD_DEFAULT.assignments },
  });
  expect(pushPolicy).not.toHaveBeenCalled();
});
it('old connection completion cannot clear the same draft submitted in a new lifetime', async () => {
  const { store, pushPolicy, drafts } = rig();
  const replies: Array<(value: Awaited<ReturnType<NetworkPort['pushPolicy']>>) => void> = [];
  pushPolicy.mockImplementation(() => new Promise((done) => replies.push(done)));
  mirrored(store);
  store.edit('m-1', (svc) => svc.setAssignment({ kind: 'default' }, 'lead'));
  await settle();
  store.setLinkState('m-1', 'down');
  store.setLinkState('m-1', 'up');
  store.apply('m-1', snap(3));
  await settle();
  expect(pushPolicy).toHaveBeenCalledTimes(2);
  replies[0]({ ok: true, value: { rev: 4 } });
  await settle();
  expect(store.ui(NAMES)[0].status).toBe('pushing');
  expect(persisted(drafts.state.text)?.drafts['m-1']).toBeDefined();
  replies[1]({ ok: true, value: { rev: 4 } });
  await settle();
  expect(store.ui(NAMES)[0]).toMatchObject({
    status: 'applied',
    policy: { assignments: LEAD_DEFAULT.assignments },
  });
});
it('successful ack promotes submitted rules before cleanup and failed cleanup never resends current intent', async () => {
  const { store, pushPolicy, drafts } = rig();
  let reply!: (value: Awaited<ReturnType<NetworkPort['pushPolicy']>>) => void;
  pushPolicy.mockImplementation(
    () =>
      new Promise((done) => {
        reply = done;
      }),
  );
  mirrored(store);
  store.edit('m-1', (svc) => svc.setAssignment({ kind: 'default' }, 'lead'));
  await settle();
  const token = store.ui(NAMES)[0].policy.editToken;
  drafts.state.fail = true;
  reply({ ok: true, value: { rev: 4 } });
  await settle();
  expect(store.ui(NAMES)[0]).toMatchObject({
    rev: 4,
    status: 'applied',
    policy: {
      assignments: LEAD_DEFAULT.assignments,
      editToken: token,
      saveError: expect.stringContaining('applied'),
    },
  });
  const restarted = rig({ drafts: drafts.state.text });
  restarted.store.apply('m-1', snap(4, LEAD_DEFAULT));
  expect(restarted.store.ui(NAMES)[0].status).toBe('conflict');
  expect(restarted.pushPolicy).not.toHaveBeenCalled();
  drafts.state.fail = false;
  expect(store.retrySave('m-1', token)).toEqual({ ok: true });
  expect(pushPolicy).toHaveBeenCalledTimes(1);
  expect(persisted(drafts.state.text)?.drafts).toEqual({});
  expect(store.ui(NAMES)[0].policy.editToken).toBe(token);
});
it('rejected network promises are visible refusals without unhandled rejection', async () => {
  const { store, pushPolicy } = rig();
  pushPolicy.mockRejectedValueOnce(new Error('transport exploded'));
  mirrored(store);
  store.edit('m-1', (svc) => svc.setAssignment({ kind: 'default' }, 'lead'));
  await settle();
  expect(store.ui(NAMES)[0]).toMatchObject({ status: 'refused', refusal: 'transport exploded' });
});
it('same-link old snapshots cannot overwrite current rules but reconnect accepts lower recovery', () => {
  const { store } = rig();
  mirrored(store, 9, LEAD_DEFAULT);
  const token = store.ui(NAMES)[0].policy.editToken;
  store.apply('m-1', snap(8, OTHER));
  expect(store.ui(NAMES)[0]).toMatchObject({
    rev: 9,
    policy: { editToken: token, assignments: LEAD_DEFAULT.assignments },
  });
  store.setLinkState('m-1', 'down');
  store.apply('m-1', snap(8, OTHER));
  expect(store.ui(NAMES)[0]).toMatchObject({ rev: 8, policy: { assignments: OTHER.assignments } });
  expect(store.ui(NAMES)[0].policy.editToken).not.toBe(token);
});
it('oversized loaded aggregate stays protected and visibly read-only', () => {
  const text =
    JSON.stringify({ version: 1, drafts: {} }) + ' '.repeat(REMOTE_POLICY_DRAFTS_MAX_BYTES);
  const { store, drafts } = rig({ drafts: text });
  mirrored(store);
  expect(store.ui(NAMES)[0].policy).toMatchObject({
    readOnly: true,
    saveError: expect.stringContaining('large'),
  });
  expect(store.retrySave('m-1', store.ui(NAMES)[0].policy.editToken)).toEqual({
    ok: false,
    error: 'read-only',
  });
  expect(drafts.state.text).toBe(text);
});

it('rejects an oversized aggregate candidate before write and preserves existing intent', () => {
  const exceptions: Assignment['exceptions'] = Array.from({ length: 64 }, (_, i) => ({
    tool: 'open_file',
    scope: { kind: 'path', path: `/${String(i).padStart(3, '0')}${'x'.repeat(800)}` },
    rule: { decision: 'allow' },
  }));
  const doc: RemotePolicyDoc = {
    profiles: [],
    assignments: Array.from({ length: 4 }, (_, i) => ({
      point: { kind: 'peer', machineId: `peer-${i}` },
      assignment: { profileId: 'worker', exceptions, onScreenOnly: false },
    })),
  };
  const drafts = Object.fromEntries(
    Array.from({ length: 61 }, (_, i) => [`m-${i}`, { baseRev: 3, doc, editedAt: 1_000 }]),
  );
  const text = JSON.stringify({ version: 1, drafts });
  expect(Buffer.byteLength(text)).toBeLessThan(REMOTE_POLICY_DRAFTS_MAX_BYTES);
  expect(Buffer.byteLength(JSON.stringify({ version: 1, drafts }, null, 2))).toBeGreaterThan(
    REMOTE_POLICY_DRAFTS_MAX_BYTES,
  );
  const { store, drafts: io, pushPolicy } = rig({ drafts: text });
  expect(store.edit('m-0', (svc) => svc.setAssignment({ kind: 'default' }, 'lead'))).toEqual({
    ok: false,
    error: 'too-large',
  });
  expect(io.state.writes).toEqual([]);
  expect(io.state.text).toBe(text);
  expect(pushPolicy).not.toHaveBeenCalled();
});

it('a read failure is read-only and never overwritten by a human operation', () => {
  const writeSync = vi.fn(() => true as const);
  const store = createRemotePolicy({
    network: () => undefined,
    draftsIo: {
      read: () => {
        throw new Error('read denied');
      },
      writeSync,
    },
    now: () => 1_000,
    newId: () => 'read-failure-owner',
    setTimer: () => null,
    clearTimer: () => undefined,
    warn: () => undefined,
  });
  mirrored(store);
  expect(store.ui(NAMES)[0].policy).toMatchObject({
    readOnly: true,
    saveError: expect.stringContaining('read'),
  });
  expect(
    store.editFull('m-1', store.ui(NAMES)[0].policy.editToken, {
      kind: 'assignment',
      point: { kind: 'default' },
      assignment: null,
    }),
  ).toEqual({ ok: false, error: 'read-only' });
  expect(writeSync).not.toHaveBeenCalled();
});

it('full custom profile changes and deletion survive controller restart', () => {
  const { store, drafts } = rig();
  mirrored(store);
  store.setLinkState('m-1', 'down');
  const token = () => store.ui(NAMES)[0].policy.editToken;
  const profile: Profile = {
    rules: structuredClone(OBSERVER.rules),
    id: 'p-portable',
    name: 'Portable',
    builtIn: false,
  };
  expect(store.editFull('m-1', token(), { kind: 'profile', profile })).toEqual({ ok: true });
  expect(
    store.editFull('m-1', token(), {
      kind: 'assignment',
      point: { kind: 'default' },
      assignment: { profileId: profile.id, exceptions: [], onScreenOnly: false },
    }),
  ).toEqual({ ok: true });
  const restart = rig({ drafts: drafts.state.text });
  expect(restart.store.ui(NAMES)[0].policy.profiles).toContainEqual(profile);
  expect(restart.store.ui(NAMES)[0].policy.assignments[0].assignment.profileId).toBe(profile.id);
  expect(
    store.editFull('m-1', token(), {
      kind: 'delete-profile',
      profileId: profile.id,
      replacement: 'worker',
    }),
  ).toEqual({ ok: true });
  const after = rig({ drafts: drafts.state.text }).store.ui(NAMES)[0].policy;
  expect(after.profiles.find((p) => p.id === profile.id)).toBeUndefined();
  expect(after.assignments[0].assignment.profileId).toBe('worker');
});

it('full portable size and exception limits refuse without saving or rotating intent', () => {
  const { store, drafts, pushPolicy } = rig();
  mirrored(store);
  store.setLinkState('m-1', 'down');
  const before = store.ui(NAMES)[0].policy;
  const profile: Profile = {
    rules: structuredClone(OBSERVER.rules),
    id: 'p-too-large',
    builtIn: false,
    name: 'x'.repeat(256 * 1024),
  };
  expect(store.editFull('m-1', before.editToken, { kind: 'profile', profile })).toEqual({
    ok: false,
    error: 'invalid-value',
  });
  const exceptions: Assignment['exceptions'] = Array.from({ length: 65 }, () => ({
    tool: 'open_file',
    scope: { kind: 'anywhere' },
    rule: { decision: 'deny' },
  }));
  expect(
    store.editFull('m-1', before.editToken, {
      kind: 'assignment',
      point: { kind: 'default' },
      assignment: { profileId: 'worker', exceptions, onScreenOnly: false },
    }),
  ).toEqual({ ok: false, error: 'invalid-value' });
  expect(
    store.editFull('m-1', before.editToken, {
      kind: 'assignment',
      point: { kind: 'default' },
      assignment: {
        profileId: 'worker',
        exceptions: [
          {
            tool: 'open_file',
            scope: { kind: 'path', path: `/${'x'.repeat(1024)}` },
            rule: { decision: 'deny' },
          },
        ],
        onScreenOnly: false,
      },
    }),
  ).toEqual({ ok: false, error: 'invalid-value' });
  expect(store.ui(NAMES)[0].policy).toEqual(before);
  expect(drafts.state.writes).toEqual([]);
  expect(pushPolicy).not.toHaveBeenCalled();
});

describe('remote native review', () => {
  const native: RemotePolicyDoc = {
    ...OTHER,
    assignments: OTHER.assignments.map(({ point, assignment }) => ({
      point,
      assignment: { ...assignment, applyNative: true },
    })),
  };
  const edit = { kind: 'assignment', ...native.assignments[0] } as const;
  const token = (store: RemotePolicy) => store.ui(NAMES)[0].policy.editToken;
  const draftText = (version: number, proof: unknown = undefined) =>
    JSON.stringify({
      version,
      drafts: { 'm-1': { baseRev: 3, doc: native, editedAt: 1_000, nativeReview: proof } },
    });

  it('a v1 draft cannot mint proof via an upgrade or a Conduit edit, and review persists it', async () => {
    const reviewed = rig({ support: true });
    mirrored(reviewed.store);
    expect(reviewed.store.editFull('m-1', token(reviewed.store), edit, true)).toEqual({ ok: true });
    const savedReview = JSON.parse(reviewed.drafts.state.text ?? '').drafts['m-1'].nativeReview;
    expect(savedReview).toBeDefined();
    const { store, drafts, pushPolicy } = rig({
      drafts: draftText(1, savedReview),
      support: true,
    });
    mirrored(store);
    await settle();
    expect(pushPolicy).not.toHaveBeenCalled();
    expect(store.ui(NAMES)[0]).toMatchObject({
      status: 'refused',
      nativeReviewRequired: true,
      nativeSupport: true,
      conflict: { assignments: [] },
    });
    expect(
      store.edit('m-1', (svc) =>
        svc.applyLegacyPatch({ kind: 'default' }, null, 'send_input', { access: 'ask' }),
      ),
    ).toEqual({ ok: true });
    expect(persisted(drafts.state.text)?.drafts['m-1']).not.toHaveProperty('nativeReview');
    expect(store.reapply('m-1', token(store))).toEqual({
      ok: false,
      error: 'native-review-required',
    });
    pushPolicy.mockImplementationOnce(() => new Promise(() => undefined));
    expect(store.reapply('m-1', token(store), true)).toEqual({ ok: true });
    const saved = persisted(drafts.state.text);
    expect(saved).toMatchObject({
      version: 2,
      drafts: {
        'm-1': {
          nativeReview: {
            version: 1,
            baseHash: expect.stringMatching(/^[a-f0-9]{64}$/),
            desiredHash: expect.stringMatching(/^[a-f0-9]{64}$/),
          },
        },
      },
    });
    const restart = rig({ drafts: drafts.state.text, support: true });
    mirrored(restart.store);
    await settle();
    expect(restart.pushPolicy).toHaveBeenCalledTimes(1);
  });

  it('rejects missing consent, old receivers, stale epochs and proof-save failure', async () => {
    const legacy = rig();
    mirrored(legacy.store);
    expect(legacy.store.editFull('m-1', token(legacy.store), edit, true)).toEqual({
      ok: false,
      error: 'native-review-required',
    });
    const { store, drafts, pushPolicy } = rig({ support: true });
    mirrored(store);
    const old = token(store);
    expect(store.editFull('m-1', old, edit)).toEqual({
      ok: false,
      error: 'native-review-required',
    });
    store.connectionReplaced('m-1');
    expect(store.editFull('m-1', old, edit, true)).toEqual({ ok: false, error: 'conflict' });
    expect(store.editFull('m-1', token(store), edit, true)).toEqual({
      ok: false,
      error: 'native-review-required',
    });
    mirrored(store);
    drafts.state.fail = true;
    expect(store.editFull('m-1', token(store), edit, true)).toEqual({
      ok: false,
      error: 'save-failed',
    });
    await settle();
    expect(pushPolicy).not.toHaveBeenCalled();
    expect(drafts.state.text).toBeNull();
    expect(store.ui(NAMES)[0]?.policy.assignments).toEqual([]);
  });

  it('rejects erased, malformed and stale proof after a controller restart', async () => {
    const original = rig({ support: true });
    mirrored(original.store);
    expect(original.store.editFull('m-1', token(original.store), edit, true)).toEqual({ ok: true });
    const saved = JSON.parse(original.drafts.state.text ?? '');
    const proof = saved.drafts['m-1'].nativeReview;
    for (const untrusted of [
      undefined,
      { ...proof, version: 2 },
      { ...proof, baseHash: 'malformed' },
      { ...proof, desiredHash: 'a'.repeat(64) },
    ]) {
      const { store, pushPolicy } = rig({ drafts: draftText(2, untrusted), support: true });
      mirrored(store);
      await settle();
      expect(pushPolicy).not.toHaveBeenCalled();
      expect(store.ui(NAMES)[0]).toMatchObject({
        status: 'refused',
        nativeReviewRequired: true,
        nativeSupport: true,
      });
    }
  });

  it('an unreadable snapshot arriving before dispatch makes the old display stale', async () => {
    const { store, pushPolicy } = rig({ support: true });
    mirrored(store);
    expect(store.editFull('m-1', token(store), edit, true)).toEqual({ ok: true });
    const before = token(store);
    const invalid = { ...EMPTY, assignments: [{}] } as unknown as RemotePolicyDoc;
    store.apply('m-1', snap(4, invalid));
    await settle();
    expect(pushPolicy).not.toHaveBeenCalled();
    expect(token(store)).not.toBe(before);
    expect(store.ui(NAMES)[0]).toMatchObject({ rev: 3, status: 'waiting', conflict: null });
    expect(store.reapply('m-1', token(store), true)).toEqual({ ok: false, error: 'not-found' });
  });

  it('an invalid push conflict cannot replace the receiver policy used for review', async () => {
    const { store, pushPolicy } = rig({ support: true });
    const invalid = { ...EMPTY, assignments: [{}] } as unknown as RemotePolicyDoc;
    pushPolicy.mockResolvedValueOnce({
      ok: false,
      error: toolError('policy_conflict', 'conflict'),
      current: { rev: 4, doc: invalid },
    });
    mirrored(store);
    expect(store.editFull('m-1', token(store), edit, true)).toEqual({ ok: true });
    await settle();
    expect(store.ui(NAMES)[0]).toMatchObject({ rev: 3, status: 'waiting', conflict: null });
    expect(store.reapply('m-1', token(store), true)).toEqual({ ok: false, error: 'not-found' });
  });

  it('strips neutral fields for an old receiver and promotes what went over the wire', async () => {
    const peer = { support: false };
    const { store, pushPolicy } = rig(peer);
    mirrored(store);
    expect(
      store.editFull('m-1', token(store), {
        ...edit,
        assignment: { ...edit.assignment, applyNative: false },
      }),
    ).toEqual({ ok: true });
    await settle();
    expect(pushPolicy).toHaveBeenCalledWith('m-1', 3, OTHER);
    expect(store.ui(NAMES)[0]?.policy.assignments).toEqual(OTHER.assignments);
    peer.support = true;
    store.connectionReplaced('m-1');
    mirrored(store, 4, OTHER);
    expect(store.ui(NAMES)[0]).toMatchObject({ status: 'applied', nativeSupport: true });
    expect(pushPolicy).toHaveBeenCalledTimes(1);
  });
});
