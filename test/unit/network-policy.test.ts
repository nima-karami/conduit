import { describe, expect, it, vi } from 'vitest';
import type { AuditEvent } from '../../server/network/audit-log';
import { CALL_REFUSAL_AUDIT_MS } from '../../server/network/calls';
import {
  createPolicySync,
  type PolicyDocSource,
  type PolicySync,
  REMOTE_POLICY_PUSH_MS,
} from '../../server/network/policy';
import type { RemotePolicySink } from '../../src/conduit-mcp/remote-routing';
import {
  type LinkFrame,
  type LinkState,
  OWN_DEFAULT_CAPABILITIES,
  POLICY_MIN_MINOR,
} from '../../src/contracts/link-protocol';
import type { RemotePolicyDoc, RemotePolicySnapshot } from '../../src/contracts/remote-policy';
import type { LinkRecord } from '../../src/network/link-file';

// Remote policy over the ssh link (CON-46 L3, spec 5.3, plan decisions 1 to 5). B sends its rules to
// the inbound ssh controllers at minor 5 and serves pushes and revokes only from them. A keeps the
// copy of each machine it dialed, and pushes or revokes once, call-like: never replayed.

const CTRL = 'm-ctrl0001';
const CTRL_OLD = 'm-ctrl0002';
const DIALED = 'm-dial0003';
const TLS = 'm-tls00004';

const linkRecord = (machineId: string, over: Partial<LinkRecord> = {}): LinkRecord => ({
  linkId: `l-${machineId}`,
  machineId,
  serverKey: 'key',
  ownerKey: null,
  name: `box-${machineId}`,
  trust: 'own',
  addresses: [],
  capabilities: { ...OWN_DEFAULT_CAPABILITIES },
  fingerprint: '',
  createdAt: '2026-11-16T00:00:00.000Z',
  cert: '',
  ownerTransfer: null,
  transport: 'ssh',
  ssh: null,
  machine: null,
  ...over,
});
/** An inbound ssh controller: the peer dialed me over its own ssh session. */
const controller = (machineId: string) => linkRecord(machineId);
/** A machine I dialed over ssh. */
const dialed = (machineId: string) =>
  linkRecord(machineId, { ssh: { target: 'h', node: 'n', mainJs: 'm', userData: 'u' } });
/** A TLS peer, which may never receive a snapshot or push one. */
const tls = (machineId: string) => linkRecord(machineId, { transport: 'tls', cert: 'pem' });

const DOC: RemotePolicyDoc = { profiles: [], assignments: [] };
const SNAP: RemotePolicySnapshot = { rev: 7, doc: DOC, grants: [] };

type ChangedFrame = Extract<LinkFrame, { t: 'policy.changed' }>;

interface Peer {
  record: LinkRecord;
  state: LinkState;
  minor: number | null;
}
interface Timer {
  fn: () => void;
  ms: number;
  cancelled: boolean;
}

function setup(opts: { sendOk?: boolean | null; sink?: RemotePolicySink | null } = {}) {
  const peers = new Map<string, Peer>();
  const sent: Array<{ machineId: string; frame: LinkFrame }> = [];
  const audit: AuditEvent[] = [];
  const timers: Timer[] = [];
  const clock = { t: 1_000_000 };
  let snap: RemotePolicySnapshot | null = SNAP;
  let sendOk: boolean | null = opts.sendOk === undefined ? true : opts.sendOk;
  let n = 0;
  const changeListeners = new Set<() => void>();
  const sinkCalls: Array<
    | { kind: 'apply'; machineId: string; snap: RemotePolicySnapshot }
    | { kind: 'state'; machineId: string; state: string }
  > = [];
  const sink: RemotePolicySink | null =
    opts.sink === undefined
      ? {
          apply: (machineId, s) => {
            sinkCalls.push({ kind: 'apply', machineId, snap: s });
          },
          setLinkState: (machineId, state) => {
            sinkCalls.push({ kind: 'state', machineId, state });
          },
        }
      : opts.sink;

  const b = {
    policyDoc: vi.fn<PolicyDocSource['policyDoc']>(() => snap),
    onPolicyDocChange: vi.fn<PolicyDocSource['onPolicyDocChange']>((fn) => {
      changeListeners.add(fn);
      return () => {
        changeListeners.delete(fn);
      };
    }),
    applyRemotePolicy: vi.fn<PolicyDocSource['applyRemotePolicy']>(() => ({ ok: true, rev: 8 })),
    revokeRemoteGrant: vi.fn<PolicyDocSource['revokeRemoteGrant']>(() => ({ ok: true })),
  } satisfies PolicyDocSource;

  const policy: PolicySync = createPolicySync({
    b,
    a: () => sink,
    links: () => [...peers].map(([machineId, p]) => ({ machineId, state: p.state })),
    linkOf: (machineId) => peers.get(machineId)?.record ?? null,
    peerMinor: (machineId) => peers.get(machineId)?.minor ?? null,
    send: (machineId, frame) => {
      sent.push({ machineId, frame });
      return sendOk;
    },
    audit: { record: (e) => audit.push(e) },
    now: () => clock.t,
    after: (fn, ms) => {
      const t: Timer = { fn, ms, cancelled: false };
      timers.push(t);
      return () => {
        t.cancelled = true;
      };
    },
    newId: () => `p-${++n}`,
  });

  /** Fires every timer still armed, as the clock passing its deadline would. */
  const fire = () => {
    for (const t of timers)
      if (!t.cancelled) {
        t.cancelled = true;
        t.fn();
      }
  };
  const frames = <T extends LinkFrame['t']>(t: T, machineId?: string) =>
    sent
      .filter((s) => s.frame.t === t && (machineId === undefined || s.machineId === machineId))
      .map((s) => s.frame as Extract<LinkFrame, { t: T }>);

  return {
    policy,
    b,
    audit,
    sent,
    timers,
    clock,
    fire,
    frames,
    sinkCalls,
    put(record: LinkRecord, state: LinkState, minor: number | null) {
      peers.set(record.machineId, { record, state, minor });
    },
    setState(machineId: string, state: LinkState) {
      const p = peers.get(machineId);
      if (p) p.state = state;
    },
    changed: () => policy.linksChanged(),
    /** B's rules changed: every listener the policy sync holds fires, as the host would. */
    changeDoc() {
      for (const fn of changeListeners) fn();
    },
    setSnap(next: RemotePolicySnapshot | null) {
      snap = next;
    },
    setSendOk(next: boolean | null) {
      sendOk = next;
    },
  };
}

describe('B: snapshots go only to inbound ssh controllers at minor 5', () => {
  it('sends the full snapshot on link up to a controller at minor 5, and to no other link', () => {
    const t = setup();
    t.put(controller(CTRL), 'up', POLICY_MIN_MINOR);
    t.put(dialed(DIALED), 'up', POLICY_MIN_MINOR);
    t.put(tls(TLS), 'up', POLICY_MIN_MINOR);
    t.changed();
    expect(t.frames('policy.changed')).toEqual([{ t: 'policy.changed', ...SNAP }]);
    expect(t.sent.map((s) => s.machineId)).toEqual([CTRL]);
  });

  it('sends a coalesced change 250 ms after the first, once per controller, and never to a dialed link', () => {
    const t = setup();
    t.put(controller(CTRL), 'up', POLICY_MIN_MINOR);
    t.put(dialed(DIALED), 'up', POLICY_MIN_MINOR);
    t.changed();
    t.sent.length = 0;
    t.changeDoc();
    t.changeDoc();
    t.changeDoc();
    expect(t.sent).toHaveLength(0);
    expect(t.timers.at(-1)?.ms).toBe(250);
    t.fire();
    expect(t.sent.map((s) => s.machineId)).toEqual([CTRL]);
    expect(t.frames('policy.changed')).toHaveLength(1);
  });

  it('sends nothing to a controller whose link is not live', () => {
    const t = setup();
    t.put(controller(CTRL), 'down', POLICY_MIN_MINOR);
    t.changed();
    expect(t.sent).toHaveLength(0);
  });
});

describe('B: below minor 5, nothing is sent', () => {
  it('sends no snapshot on up, and none on a change, to a controller at minor 4', () => {
    const t = setup();
    t.put(controller(CTRL), 'up', POLICY_MIN_MINOR - 1);
    t.changed();
    t.changeDoc();
    t.fire();
    expect(t.sent).toHaveLength(0);
  });

  it('sends nothing to a controller whose hello has not landed', () => {
    const t = setup();
    t.put(controller(CTRL), 'up', null);
    t.changed();
    expect(t.sent).toHaveLength(0);
  });
});

describe('B: pushes and revokes come only from an inbound ssh controller', () => {
  it('applies a push from a controller, replies policy.pushed ok, and audits it under the link machine id', () => {
    const t = setup();
    t.put(controller(CTRL), 'up', POLICY_MIN_MINOR);
    t.policy.onFrame(CTRL, { t: 'policy.push', id: 'p-a', baseRev: 7, doc: DOC });
    expect(t.b.applyRemotePolicy).toHaveBeenCalledWith(7, DOC);
    expect(t.frames('policy.pushed', CTRL)).toEqual([
      { t: 'policy.pushed', id: 'p-a', ok: true, rev: 8 },
    ]);
    expect(t.audit).toEqual([
      { kind: 'policy.pushed', peer: CTRL, detail: { machineId: CTRL, rev: 8 } },
    ]);
  });

  it('audits a conflict as policy.refused with its code, and keeps B copy', () => {
    const t = setup();
    t.put(controller(CTRL), 'up', POLICY_MIN_MINOR);
    t.b.applyRemotePolicy.mockReturnValueOnce({
      ok: false,
      code: 'policy_conflict',
      message: 'rules changed on this machine',
      current: { rev: 9, doc: DOC },
    });
    t.policy.onFrame(CTRL, { t: 'policy.push', id: 'p-z', baseRev: 7, doc: DOC });
    expect(t.audit).toEqual([
      { kind: 'policy.refused', peer: CTRL, detail: { machineId: CTRL, code: 'policy_conflict' } },
    ]);
  });

  it('keeps B current rev and doc on a conflict, and replies it with current', () => {
    const t = setup();
    t.put(controller(CTRL), 'up', POLICY_MIN_MINOR);
    const current = { rev: 9, doc: DOC };
    t.b.applyRemotePolicy.mockReturnValueOnce({
      ok: false,
      code: 'policy_conflict',
      message: 'rules changed on this machine',
      current,
    });
    t.policy.onFrame(CTRL, { t: 'policy.push', id: 'p-b', baseRev: 7, doc: DOC });
    expect(t.frames('policy.pushed', CTRL)).toEqual([
      {
        t: 'policy.pushed',
        id: 'p-b',
        ok: false,
        error: {
          code: 'policy_conflict',
          message: 'rules changed on this machine',
          retryable: false,
        },
        current,
      },
    ]);
  });

  it('refuses a push from a dialed link as not_controller, applies nothing, and audits it', () => {
    const t = setup();
    t.put(dialed(DIALED), 'up', POLICY_MIN_MINOR);
    t.policy.onFrame(DIALED, { t: 'policy.push', id: 'p-c', baseRev: 7, doc: DOC });
    expect(t.b.applyRemotePolicy).not.toHaveBeenCalled();
    expect(t.frames('policy.pushed', DIALED)).toEqual([
      {
        t: 'policy.pushed',
        id: 'p-c',
        ok: false,
        error: {
          code: 'not_controller',
          message: 'policy is changed only from an ssh controller',
          retryable: false,
        },
      },
    ]);
    expect(t.audit).toEqual([
      {
        kind: 'policy.refused',
        peer: DIALED,
        detail: { machineId: DIALED, code: 'not_controller' },
      },
    ]);
  });

  it('refuses a revoke from a TLS peer, revokes nothing, and audits it under its own frame', () => {
    const t = setup();
    t.put(tls(TLS), 'up', POLICY_MIN_MINOR);
    t.policy.onFrame(TLS, { t: 'policy.revoke', id: 'p-d', grantId: 'g-1' });
    expect(t.b.revokeRemoteGrant).not.toHaveBeenCalled();
    expect(t.frames('policy.pushed', TLS)[0]).toMatchObject({
      ok: false,
      error: { code: 'not_controller' },
    });
    expect(t.audit).toEqual([
      {
        kind: 'policy.refused',
        peer: TLS,
        detail: { machineId: TLS, code: 'not_controller' },
      },
    ]);
  });

  it('audits a refused push and a refused revoke even within one refusal window', () => {
    const t = setup();
    t.put(dialed(DIALED), 'up', POLICY_MIN_MINOR);
    t.policy.onFrame(DIALED, { t: 'policy.push', id: 'p-e', baseRev: 7, doc: DOC });
    t.policy.onFrame(DIALED, { t: 'policy.revoke', id: 'p-f', grantId: 'g-1' });
    expect(t.audit.map((e) => e.detail)).toEqual([
      { machineId: DIALED, code: 'not_controller' },
      { machineId: DIALED, code: 'not_controller' },
    ]);
  });

  it('audits a refused push at most once per link per refusal window', () => {
    const t = setup();
    t.put(dialed(DIALED), 'up', POLICY_MIN_MINOR);
    t.policy.onFrame(DIALED, { t: 'policy.push', id: 'p-g', baseRev: 7, doc: DOC });
    t.policy.onFrame(DIALED, { t: 'policy.push', id: 'p-h', baseRev: 7, doc: DOC });
    expect(t.audit).toHaveLength(1);
    t.clock.t += CALL_REFUSAL_AUDIT_MS;
    t.policy.onFrame(DIALED, { t: 'policy.push', id: 'p-i', baseRev: 7, doc: DOC });
    expect(t.audit).toHaveLength(2);
  });

  it('audits a push under the link machine id, never a machine id a frame names', () => {
    const t = setup();
    t.put(controller(CTRL), 'up', POLICY_MIN_MINOR);
    // A frame that also carries a machine id: the link's id must win, the frame's is ignored.
    const spoofed = {
      t: 'policy.push' as const,
      id: 'p-j',
      baseRev: 7,
      doc: DOC,
      machineId: CTRL_OLD,
    };
    t.policy.onFrame(CTRL, spoofed);
    expect(t.audit).toEqual([
      { kind: 'policy.pushed', peer: CTRL, detail: { machineId: CTRL, rev: 8 } },
    ]);
  });

  it('revokes a grant under the link machine id, and replies ok with B current rev', () => {
    const t = setup();
    t.put(controller(CTRL), 'up', POLICY_MIN_MINOR);
    t.policy.onFrame(CTRL, { t: 'policy.revoke', id: 'p-k', grantId: 'g-9' });
    expect(t.b.revokeRemoteGrant).toHaveBeenCalledWith('g-9');
    expect(t.frames('policy.pushed', CTRL)).toEqual([
      { t: 'policy.pushed', id: 'p-k', ok: true, rev: 7 },
    ]);
    expect(t.audit).toEqual([
      { kind: 'policy.pushed', peer: CTRL, detail: { machineId: CTRL, grantId: 'g-9' } },
    ]);
  });

  it('audits a revoke that found no grant as policy.refused not_found', () => {
    const t = setup();
    t.put(controller(CTRL), 'up', POLICY_MIN_MINOR);
    t.b.revokeRemoteGrant.mockReturnValueOnce({
      ok: false,
      code: 'not_found',
      message: 'no such grant',
    });
    t.policy.onFrame(CTRL, { t: 'policy.revoke', id: 'p-l', grantId: 'g-x' });
    expect(t.audit).toEqual([
      { kind: 'policy.refused', peer: CTRL, detail: { machineId: CTRL, code: 'not_found' } },
    ]);
  });
});

describe('A: snapshots are accepted only from machines I dialed', () => {
  it('feeds the sink the snapshot of a dialed machine, under the machine id', () => {
    const t = setup();
    t.put(dialed(DIALED), 'up', POLICY_MIN_MINOR);
    const frame: ChangedFrame = { t: 'policy.changed', ...SNAP };
    t.policy.onFrame(DIALED, frame);
    expect(t.sinkCalls).toEqual([{ kind: 'apply', machineId: DIALED, snap: SNAP }]);
  });

  it('refuses a snapshot from a controller or a TLS peer, keeps nothing, and audits it', () => {
    const t = setup();
    t.put(controller(CTRL), 'up', POLICY_MIN_MINOR);
    t.put(tls(TLS), 'up', POLICY_MIN_MINOR);
    t.policy.onFrame(CTRL, { t: 'policy.changed', ...SNAP });
    t.policy.onFrame(TLS, { t: 'policy.changed', ...SNAP });
    expect(t.sinkCalls.filter((c) => c.kind === 'apply')).toHaveLength(0);
    expect(t.audit.map((e) => e.detail)).toEqual([
      { machineId: CTRL, code: 'not_dialed' },
      { machineId: TLS, code: 'not_dialed' },
    ]);
  });

  it('refuses a snapshot from a machine with no record at all', () => {
    const t = setup();
    t.policy.onFrame(DIALED, { t: 'policy.changed', ...SNAP });
    expect(t.sinkCalls).toHaveLength(0);
    expect(t.audit).toEqual([
      {
        kind: 'policy.refused',
        peer: DIALED,
        detail: { machineId: DIALED, code: 'not_dialed' },
      },
    ]);
  });

  it('drops a snapshot with an audit when no sink is set, rather than keeping it', () => {
    const t = setup({ sink: null });
    t.put(dialed(DIALED), 'up', POLICY_MIN_MINOR);
    t.policy.onFrame(DIALED, { t: 'policy.changed', ...SNAP });
    expect(t.audit).toEqual([
      {
        kind: 'policy.refused',
        peer: DIALED,
        detail: { machineId: DIALED, code: 'policy_unavailable' },
      },
    ]);
  });

  it('ignores a pushed reply from a machine I did not dial', async () => {
    const t = setup();
    t.put(dialed(DIALED), 'up', POLICY_MIN_MINOR);
    t.put(controller(CTRL), 'up', POLICY_MIN_MINOR);
    // A dialed machine's push is pending; a reply to its id from another link must not settle it.
    const pending = t.policy.push(DIALED, 7, DOC);
    t.policy.onFrame(CTRL, { t: 'policy.pushed', id: 'p-1', ok: true, rev: 8 });
    expect(t.policy.pendingCount()).toBe(1);
    t.policy.onFrame(DIALED, { t: 'policy.pushed', id: 'p-1', ok: true, rev: 8 });
    expect(await pending).toEqual({ ok: true, value: { rev: 8 } });
  });
});

describe('A: link state reaches the sink', () => {
  it('reports up, down and gone for machines I dialed, and only on a change', () => {
    const t = setup();
    t.put(dialed(DIALED), 'up', POLICY_MIN_MINOR);
    t.changed();
    t.changed();
    expect(t.sinkCalls).toEqual([{ kind: 'state', machineId: DIALED, state: 'up' }]);
    t.setState(DIALED, 'down');
    t.changed();
    expect(t.sinkCalls.at(-1)).toEqual({ kind: 'state', machineId: DIALED, state: 'down' });
    t.setState(DIALED, 'revoked');
    t.changed();
    expect(t.sinkCalls.at(-1)).toEqual({ kind: 'state', machineId: DIALED, state: 'gone' });
  });

  it('treats a degraded link as up, and does not report a machine that dialed me', () => {
    const t = setup();
    t.put(dialed(DIALED), 'degraded', POLICY_MIN_MINOR);
    t.put(controller(CTRL), 'up', POLICY_MIN_MINOR);
    t.changed();
    expect(t.sinkCalls).toEqual([{ kind: 'state', machineId: DIALED, state: 'up' }]);
  });
});

describe('A: a push resolves ok or conflict with current', () => {
  it('sends one policy.push under a fresh id and resolves ok on its policy.pushed', async () => {
    const t = setup();
    t.put(dialed(DIALED), 'up', POLICY_MIN_MINOR);
    const pending = t.policy.push(DIALED, 7, DOC);
    expect(t.frames('policy.push', DIALED)).toEqual([
      { t: 'policy.push', id: 'p-1', baseRev: 7, doc: DOC },
    ]);
    t.policy.onFrame(DIALED, { t: 'policy.pushed', id: 'p-1', ok: true, rev: 8 });
    expect(await pending).toEqual({ ok: true, value: { rev: 8 } });
    expect(t.policy.pendingCount()).toBe(0);
  });

  it('resolves a conflict with the error code and B current, and never re-sends', async () => {
    const t = setup();
    t.put(dialed(DIALED), 'up', POLICY_MIN_MINOR);
    const pending = t.policy.push(DIALED, 7, DOC);
    const current = { rev: 9, doc: DOC };
    t.policy.onFrame(DIALED, {
      t: 'policy.pushed',
      id: 'p-1',
      ok: false,
      error: { code: 'policy_conflict', message: 'rules changed', retryable: false },
      current,
    });
    expect(await pending).toEqual({
      ok: false,
      error: { code: 'policy_conflict', message: 'rules changed', retryable: false },
      current,
    });
    expect(t.frames('policy.push')).toHaveLength(1);
  });

  it('maps a code the policy set does not know to refused, and keeps the message', async () => {
    const t = setup();
    t.put(dialed(DIALED), 'up', POLICY_MIN_MINOR);
    const pending = t.policy.push(DIALED, 7, DOC);
    t.policy.onFrame(DIALED, {
      t: 'policy.pushed',
      id: 'p-1',
      ok: false,
      error: { code: 'something_new', message: 'a newer code', retryable: false },
    });
    expect(await pending).toEqual({
      ok: false,
      error: { code: 'refused', message: 'a newer code', retryable: false },
    });
  });

  it('keeps the code B sends for a revoke that found no grant', async () => {
    const t = setup();
    t.put(dialed(DIALED), 'up', POLICY_MIN_MINOR);
    const pending = t.policy.revoke(DIALED, 'g-1');
    t.policy.onFrame(DIALED, {
      t: 'policy.pushed',
      id: 'p-1',
      ok: false,
      error: { code: 'not_found', message: 'no such grant', retryable: false },
    });
    expect(await pending).toEqual({
      ok: false,
      error: { code: 'not_found', message: 'no such grant', retryable: false },
    });
  });

  it('revoke sends one policy.revoke and resolves ok on its policy.pushed', async () => {
    const t = setup();
    t.put(dialed(DIALED), 'up', POLICY_MIN_MINOR);
    const pending = t.policy.revoke(DIALED, 'g-1');
    expect(t.frames('policy.revoke', DIALED)).toEqual([
      { t: 'policy.revoke', id: 'p-1', grantId: 'g-1' },
    ]);
    t.policy.onFrame(DIALED, { t: 'policy.pushed', id: 'p-1', ok: true, rev: 8 });
    expect(await pending).toEqual({ ok: true, value: null });
  });
});

describe('A: a push that cannot land resolves at once or times out, and is never replayed', () => {
  it('resolves peer_unreachable after 30 s, sends the frame once, and ignores a late reply', async () => {
    const t = setup();
    t.put(dialed(DIALED), 'up', POLICY_MIN_MINOR);
    const pending = t.policy.push(DIALED, 7, DOC);
    const timer = t.timers.find((x) => x.ms === REMOTE_POLICY_PUSH_MS);
    expect(timer).toBeDefined();
    t.fire();
    const result = await pending;
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'peer_unreachable', retryable: false },
    });
    expect(t.frames('policy.push')).toHaveLength(1);
    t.policy.onFrame(DIALED, { t: 'policy.pushed', id: 'p-1', ok: true, rev: 8 });
    expect(t.policy.pendingCount()).toBe(0);
  });

  it('resolves peer_unreachable at once when the link drops, and never re-sends the push', async () => {
    const t = setup();
    t.put(dialed(DIALED), 'up', POLICY_MIN_MINOR);
    const pending = t.policy.push(DIALED, 7, DOC);
    t.setState(DIALED, 'down');
    t.changed();
    expect(await pending).toMatchObject({ ok: false, error: { code: 'peer_unreachable' } });
    // The link comes back: nothing is replayed; the reconnect rule is A's store, not this sync.
    t.setState(DIALED, 'up');
    t.changed();
    expect(t.frames('policy.push')).toHaveLength(1);
  });

  it('resolves peer_unreachable when the machine is no longer linked at all', async () => {
    const t = setup();
    t.put(dialed(DIALED), 'up', POLICY_MIN_MINOR);
    const pending = t.policy.push(DIALED, 7, DOC);
    t.setState(DIALED, 'down');
    t.changed();
    expect(await pending).toMatchObject({ ok: false, error: { code: 'peer_unreachable' } });
  });

  it('resolves peer_revoked at once when the machine is revoked', async () => {
    const t = setup();
    t.put(dialed(DIALED), 'up', POLICY_MIN_MINOR);
    const pending = t.policy.push(DIALED, 7, DOC);
    t.setState(DIALED, 'revoked');
    t.changed();
    expect(await pending).toMatchObject({ ok: false, error: { code: 'peer_revoked' } });
  });

  it('refuses at once with peer_unreachable and a connect hint when the link is not up', async () => {
    const t = setup();
    t.put(dialed(DIALED), 'down', POLICY_MIN_MINOR);
    const result = await t.policy.push(DIALED, 7, DOC);
    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({
        code: 'peer_unreachable',
        hint: `connect_machine ${`box-${DIALED}`} first`,
      }),
    });
    expect(t.sent).toHaveLength(0);
  });

  it('gives peer_unreachable when the send itself is refused, with nothing sent', async () => {
    const t = setup({ sendOk: null });
    t.put(dialed(DIALED), 'up', POLICY_MIN_MINOR);
    const result = await t.policy.push(DIALED, 7, DOC);
    expect(result).toMatchObject({ ok: false, error: { code: 'peer_unreachable' } });
    expect(t.policy.pendingCount()).toBe(0);
  });
});

describe('A: the minor gate', () => {
  it('gives peer_incompatible with an update hint, and sends nothing, below minor 5', async () => {
    const t = setup();
    t.put(dialed(DIALED), 'up', POLICY_MIN_MINOR - 1);
    const result = await t.policy.push(DIALED, 7, DOC);
    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({
        code: 'peer_incompatible',
        hint: `update Conduit on box-${DIALED}`,
      }),
    });
    expect(t.sent).toHaveLength(0);
  });

  it('gives peer_unreachable while the peer has not said hello yet', async () => {
    const t = setup();
    t.put(dialed(DIALED), 'up', null);
    const result = await t.policy.revoke(DIALED, 'g-1');
    expect(result).toMatchObject({ ok: false, error: { code: 'peer_unreachable' } });
    expect(t.sent).toHaveLength(0);
  });
});

describe('policy sync stops cleanly', () => {
  it('settles a pending push as peer_unreachable and unsubscribes on stop', async () => {
    const t = setup();
    t.put(dialed(DIALED), 'up', POLICY_MIN_MINOR);
    const pending = t.policy.push(DIALED, 7, DOC);
    t.policy.stop();
    expect(await pending).toMatchObject({ ok: false, error: { code: 'peer_unreachable' } });
    expect(t.policy.pendingCount()).toBe(0);
  });
});
