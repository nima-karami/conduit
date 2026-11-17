import { describe, expect, it, vi } from 'vitest';
import { createRemotePolicy, type RemotePolicy } from '../../src/conduit-mcp/remote-policy';
import type { NetworkPort } from '../../src/conduit-mcp/remote-routing';
import type { RequestsIo } from '../../src/conduit-mcp/request-file-fs';
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
  const state = { text: initial as string | null, writes: [] as string[] };
  const io: RequestsIo = {
    read: () => state.text,
    write: async (t) => {
      state.text = t;
      state.writes.push(t);
    },
  };
  return { io, state };
}

function rig(opts: { drafts?: string | null } = {}) {
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
  const network: Pick<NetworkPort, 'pushPolicy' | 'revokeRemoteGrant'> = {
    pushPolicy,
    revokeRemoteGrant,
  };
  const store = createRemotePolicy({
    network: () => network,
    draftsIo: drafts.io,
    now: () => 1_000,
    newId: () => 'id',
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
      version: 1,
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
    store.discard('m-1');
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
    store.reapply('m-1');
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
