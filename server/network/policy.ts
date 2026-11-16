import type {
  RemotePolicyApplyResult,
  RemotePolicyCurrent,
  RemotePolicyPushResult,
  RemotePolicySink,
} from '../../src/conduit-mcp/remote-routing';
import {
  isToolErrorCode,
  type Result,
  type ToolError,
  toolError,
} from '../../src/conduit-mcp/types';
import {
  type LinkFrame,
  type LinkState,
  POLICY_MIN_MINOR,
} from '../../src/contracts/link-protocol';
import type { RemotePolicyDoc, RemotePolicySnapshot } from '../../src/contracts/remote-policy';
import type { LinkRecord } from '../../src/network/link-file';
import type { AuditSink } from './audit-log';
import { CALL_REFUSAL_AUDIT_MS, isDialedSsh } from './calls';

// Remote policy over the ssh link (CON-46 L3, plan decisions 3 and 4). B is the only writer of its
// rules: it sends them to its inbound ssh controllers and serves a controller's push or revoke. A
// keeps a copy of each machine it dialed and pushes or revokes once, call-like, never re-sent.

/** B's side: its rules and the path a controller's push or revoke lands on. */
export interface PolicyDocSource {
  /** B's rev, portable doc and grants; null while B is not up, so nothing is sent. */
  policyDoc(): RemotePolicySnapshot | null;
  /** Fires when B's rules or grants change. Returns its unsubscribe. */
  onPolicyDocChange(fn: () => void): () => void;
  /** Applies a controller's doc; B validates it and refuses a stale rev. The audit is this module's. */
  applyRemotePolicy(baseRev: number, doc: unknown): RemotePolicyApplyResult;
  revokeRemoteGrant(
    grantId: string,
  ): { ok: true } | { ok: false; code: 'not_found' | 'policy_unavailable'; message: string };
}

export interface PolicySyncDeps {
  /** B's side: what I send and how a controller's push lands. */
  b: PolicyDocSource;
  /** A's side: the copy I keep, or null while none is set (snapshots are then dropped with an audit). */
  a: () => RemotePolicySink | null;
  /** Every link I hold, as its machine id and state. */
  links(): Array<{ machineId: string; state: LinkState }>;
  /** My record of the link to a machine, or null when I have none. */
  linkOf(machineId: string): LinkRecord | null;
  /** The protocol minor the peer's hello reported; null until its hello has landed. */
  peerMinor(machineId: string): number | null;
  send(machineId: string, frame: LinkFrame): boolean | null;
  audit: AuditSink;
  now(): number;
  after(fn: () => void, ms: number): () => void;
  newId(): string;
}

export interface PolicySync {
  /** Any policy.* frame from a machine. */
  onFrame(machineId: string, frame: LinkFrame): void;
  /** Any change to a link's state; B re-evaluates who is owed a snapshot, A reports states and ends pushes. */
  linksChanged(): void;
  /** A's side: pushes a whole doc to a dialed machine as an edit from `baseRev`. Resolves once. */
  push(machineId: string, baseRev: number, doc: RemotePolicyDoc): Promise<RemotePolicyPushResult>;
  /** A's side: revokes one of a dialed machine's grants. Resolves once. */
  revoke(machineId: string, grantId: string): Promise<Result<null>>;
  pendingCount(): number;
  stop(): void;
}

/** A push or revoke waits this long for its policy.pushed before it is an error. */
export const REMOTE_POLICY_PUSH_MS = 30_000;
/** Changes in a burst go out as one snapshot, this long after the first. */
const POLICY_COALESCE_MS = 250;
const ERROR_MESSAGE_MAX = 1024;
const ERROR_HINT_MAX = 512;

/** A push's reply inside this module: a conflict carries B's current, every other failure does not. */
type PushReply = Result<{ rev: number }> & { current?: RemotePolicyCurrent };

interface Pending {
  machineId: string;
  cancel(): void;
  resolve(result: PushReply): void;
}

const live = (state: LinkState | undefined): boolean => state === 'up' || state === 'degraded';

/** B's controller: a peer that dialed me over ssh. The record has no ssh endpoint, as it never was dialed by me. */
const isInboundController = (record: LinkRecord | null): record is LinkRecord =>
  record !== null && record.transport === 'ssh' && record.ssh === null;

/** Control characters never reach the far side's parser; text is cut to the frame's caps. */
const printable = (s: string, max: number): string =>
  Array.from(s.replace(/\p{Cc}/gu, ''))
    .slice(0, max)
    .join('');

/** A code this build does not know is `refused`: the peer's message still reaches the caller. */
const codeOf = (code: string): ToolError['code'] => (isToolErrorCode(code) ? code : 'refused');

const toPushResult = (r: PushReply): RemotePolicyPushResult => {
  if (r.ok) return { ok: true, value: r.value };
  if (r.current === undefined) return { ok: false, error: r.error };
  return { ok: false, error: r.error, current: r.current };
};

/** The mirror store sees a degraded link as up: it still carries frames, as calls treat it. */
const sinkStateOf = (state: LinkState): 'up' | 'down' | 'gone' => {
  if (live(state)) return 'up';
  return state === 'revoked' ? 'gone' : 'down';
};

export function createPolicySync(deps: PolicySyncDeps): PolicySync {
  /** The last refusal audit per reason, frame and link: a flood of refusals audits once a minute. */
  const lastRefusal = new Map<string, number>();
  /** Pushes and revokes I sent and have not seen answered, by id. Each is settled once, then forgotten. */
  const pending = new Map<string, Pending>();
  /** The state last reported to A's copy per dialed machine. */
  const reported = new Map<string, 'up' | 'down' | 'gone'>();
  /** The controllers that are live and at a minor that takes snapshots: the ones a snapshot goes to. */
  let eligible = new Set<string>();
  let cancelChangeTimer: (() => void) | null = null;

  /**
   * A refusal is audited with its code. The throttle is per frame as well, so a refused push and a
   * refused revoke from one link are each audited, never one hiding the other.
   */
  const refuse = (code: string, frame: string, machineId: string): void => {
    const key = `${frame}:${code}:${machineId}`;
    const at = deps.now();
    const last = lastRefusal.get(key);
    if (last !== undefined && at - last < CALL_REFUSAL_AUDIT_MS) return;
    lastRefusal.set(key, at);
    deps.audit.record({ kind: 'policy.refused', peer: machineId, detail: { machineId, code } });
  };

  const sendSnapshot = (machineId: string): void => {
    const snap = deps.b.policyDoc();
    if (snap === null) return;
    deps.send(machineId, {
      t: 'policy.changed',
      rev: snap.rev,
      doc: snap.doc,
      grants: snap.grants,
    });
  };

  const mirrorable = (machineId: string, state: LinkState): boolean => {
    if (!isInboundController(deps.linkOf(machineId))) return false;
    if (!live(state)) return false;
    const minor = deps.peerMinor(machineId);
    return minor !== null && minor >= POLICY_MIN_MINOR;
  };

  const scheduleChange = (): void => {
    if (cancelChangeTimer !== null) return;
    cancelChangeTimer = deps.after(() => {
      cancelChangeTimer = null;
      for (const machineId of eligible) sendSnapshot(machineId);
    }, POLICY_COALESCE_MS);
  };
  const unsubscribeChange = deps.b.onPolicyDocChange(scheduleChange);

  /** B's reply to a controller's push or revoke. The machine it names is always the link's. */
  const replyPushed = (machineId: string, id: string, result: PushReply): void => {
    if (result.ok) {
      deps.send(machineId, { t: 'policy.pushed', id, ok: true, rev: result.value.rev });
      return;
    }
    const { error, current } = result;
    deps.send(machineId, {
      t: 'policy.pushed',
      id,
      ok: false,
      error: {
        code: error.code,
        message: printable(error.message, ERROR_MESSAGE_MAX),
        retryable: error.retryable,
        ...(error.hint === undefined ? {} : { hint: printable(error.hint, ERROR_HINT_MAX) }),
      },
      ...(current === undefined ? {} : { current }),
    });
  };

  const notController = (machineId: string, id: string, frame: string): void => {
    refuse('not_controller', frame, machineId);
    replyPushed(machineId, id, {
      ok: false,
      error: {
        code: 'not_controller',
        message: 'policy is changed only from an ssh controller',
        retryable: false,
      },
    });
  };

  const onPush = (machineId: string, frame: Extract<LinkFrame, { t: 'policy.push' }>): void => {
    const link = deps.linkOf(machineId);
    // Rules are changed only by the owner's controller link, so a peer that is not one is refused.
    if (!isInboundController(link)) {
      notController(machineId, frame.id, 'policy.push');
      return;
    }
    const res = deps.b.applyRemotePolicy(frame.baseRev, frame.doc);
    if (res.ok) {
      deps.audit.record({
        kind: 'policy.pushed',
        peer: link.machineId,
        detail: { machineId: link.machineId, rev: res.rev },
      });
      replyPushed(machineId, frame.id, { ok: true, value: { rev: res.rev } });
      return;
    }
    refuse(res.code, 'policy.push', link.machineId);
    replyPushed(machineId, frame.id, {
      ok: false,
      error: { code: res.code, message: res.message, retryable: false },
      ...(res.current === undefined ? {} : { current: res.current }),
    });
  };

  const onRevoke = (machineId: string, frame: Extract<LinkFrame, { t: 'policy.revoke' }>): void => {
    const link = deps.linkOf(machineId);
    if (!isInboundController(link)) {
      notController(machineId, frame.id, 'policy.revoke');
      return;
    }
    const res = deps.b.revokeRemoteGrant(frame.grantId);
    if (!res.ok) {
      refuse(res.code, 'policy.revoke', link.machineId);
      replyPushed(machineId, frame.id, {
        ok: false,
        error: { code: res.code, message: res.message, retryable: false },
      });
      return;
    }
    deps.audit.record({
      kind: 'policy.pushed',
      peer: link.machineId,
      detail: { machineId: link.machineId, grantId: frame.grantId },
    });
    // A revoke changes B's grants, not its rev; the reply still carries the rev the controller sees.
    const snap = deps.b.policyDoc();
    replyPushed(
      machineId,
      frame.id,
      snap === null
        ? {
            ok: false,
            error: {
              code: 'policy_unavailable',
              message: 'this machine is not ready to take remote policy',
              retryable: false,
            },
          }
        : { ok: true, value: { rev: snap.rev } },
    );
  };

  const onChanged = (
    machineId: string,
    frame: Extract<LinkFrame, { t: 'policy.changed' }>,
  ): void => {
    // A's copy holds only rules a machine I dialed sent; any other peer's snapshot is ignored.
    if (!isDialedSsh(deps.linkOf(machineId))) {
      refuse('not_dialed', 'policy.changed', machineId);
      return;
    }
    const sink = deps.a();
    if (sink === null) {
      refuse('policy_unavailable', 'policy.changed', machineId);
      return;
    }
    sink.apply(machineId, { rev: frame.rev, doc: frame.doc, grants: frame.grants });
  };

  const onPushed = (machineId: string, frame: Extract<LinkFrame, { t: 'policy.pushed' }>): void => {
    if (!isDialedSsh(deps.linkOf(machineId))) {
      refuse('not_dialed', 'policy.pushed', machineId);
      return;
    }
    const p = pending.get(frame.id);
    // A late reply (already settled, or timed out) and one from another machine are both ignored.
    if (!p || p.machineId !== machineId) return;
    settle(
      frame.id,
      frame.ok
        ? { ok: true, value: { rev: frame.rev } }
        : {
            ok: false,
            error: {
              code: codeOf(frame.error.code),
              message: frame.error.message,
              retryable: frame.error.retryable,
              ...(frame.error.hint === undefined ? {} : { hint: frame.error.hint }),
            },
            ...(frame.current === undefined ? {} : { current: frame.current }),
          },
    );
  };

  const onFrame = (machineId: string, frame: LinkFrame): void => {
    if (frame.t === 'policy.push') onPush(machineId, frame);
    else if (frame.t === 'policy.revoke') onRevoke(machineId, frame);
    else if (frame.t === 'policy.changed') onChanged(machineId, frame);
    else if (frame.t === 'policy.pushed') onPushed(machineId, frame);
  };

  const settle = (id: string, result: PushReply): void => {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    p.cancel();
    p.resolve(result);
  };

  const unreachable = (message: string, hint?: string): ToolError => ({
    ...toolError('peer_unreachable', message, undefined, hint === undefined ? undefined : { hint }),
  });

  /** Whether a push or revoke may be sent to this machine now, and under what name it is called. */
  const gate = (
    machineId: string,
  ): { ok: true; name: string } | { ok: false; error: ToolError } => {
    const record = deps.linkOf(machineId);
    if (record === null) return { ok: false, error: unreachable('no link to that machine') };
    const name = record.name;
    if (!isDialedSsh(record))
      return {
        ok: false,
        error: toolError('peer_unsupported', `${name} was not added over ssh`, undefined, {
          hint: 'the rules go only to a machine added over ssh',
        }),
      };
    const state = deps.links().find((v) => v.machineId === machineId)?.state;
    if (state === 'revoked')
      return { ok: false, error: toolError('peer_revoked', `${name} is revoked`) };
    if (state !== 'up')
      return {
        ok: false,
        error: unreachable(`${name} is not connected`, `connect_machine ${name} first`),
      };
    const minor = deps.peerMinor(machineId);
    if (minor === null) return { ok: false, error: unreachable(`${name} has not said hello yet`) };
    if (minor < POLICY_MIN_MINOR)
      return {
        ok: false,
        error: toolError(
          'peer_incompatible',
          `${name} runs a Conduit that cannot take remote policy`,
          undefined,
          { hint: `update Conduit on ${name}` },
        ),
      };
    return { ok: true, name };
  };

  /**
   * Sends one call-like frame and waits for its reply. A timeout, a drop or a refused send ends it
   * as peer_unreachable; nothing here re-sends it, so the frame goes out at most once.
   */
  const dispatch = (machineId: string, frameFor: (id: string) => LinkFrame): Promise<PushReply> => {
    const g = gate(machineId);
    if (!g.ok) return Promise.resolve({ ok: false, error: g.error });
    const { name } = g;
    return new Promise<PushReply>((resolve) => {
      const id = deps.newId();
      const cancelTimer = deps.after(
        () =>
          settle(id, {
            ok: false,
            error: {
              ...toolError('peer_unreachable', `${name} did not answer in time`, undefined, {
                // The owner may have landed the change before the reply was lost; it is never sent again.
                hint: 'the change was not sent again; check the rules on that machine before you change them',
              }),
              retryable: false,
            },
          }),
        REMOTE_POLICY_PUSH_MS,
      );
      pending.set(id, { machineId, cancel: cancelTimer, resolve });
      const sent = deps.send(machineId, frameFor(id));
      // Refused at once: nothing went out, so nothing can land.
      if (sent !== true)
        settle(id, {
          ok: false,
          error: unreachable(`${name} is not connected`, `connect_machine ${name} first`),
        });
    });
  };

  const linksChanged = (): void => {
    const views = deps.links();

    // B: a controller that just became eligible gets the full rules now; the rest follow on change.
    const nowEligible = new Set<string>();
    for (const v of views) if (mirrorable(v.machineId, v.state)) nowEligible.add(v.machineId);
    for (const machineId of nowEligible) if (!eligible.has(machineId)) sendSnapshot(machineId);
    eligible = nowEligible;

    // A: the state of each machine I dialed, reported to its copy on a change only. One I no longer hold is gone.
    const sink = deps.a();
    if (sink !== null) {
      const dialedNow = new Map<string, 'up' | 'down' | 'gone'>();
      for (const v of views)
        if (isDialedSsh(deps.linkOf(v.machineId))) dialedNow.set(v.machineId, sinkStateOf(v.state));
      for (const [machineId, state] of dialedNow) {
        if (reported.get(machineId) === state) continue;
        reported.set(machineId, state);
        sink.setLinkState(machineId, state);
      }
      for (const machineId of [...reported.keys()]) {
        if (dialedNow.has(machineId)) continue;
        reported.delete(machineId);
        sink.setLinkState(machineId, 'gone');
      }
    }

    // A pending push ends with its link: a drop or a removal is peer_unreachable, a revoke peer_revoked.
    const stateOf = new Map(views.map((v) => [v.machineId, v.state]));
    for (const [id, p] of [...pending]) {
      const state = stateOf.get(p.machineId);
      if (live(state)) continue;
      settle(
        id,
        state === 'revoked'
          ? {
              ok: false,
              error: toolError('peer_revoked', "the machine was removed from this machine's links"),
            }
          : {
              ok: false,
              error: unreachable(
                'the link dropped before the reply came back',
                'the change was not sent again; check the rules on that machine before you change them',
              ),
            },
      );
    }
  };

  const push = (
    machineId: string,
    baseRev: number,
    doc: RemotePolicyDoc,
  ): Promise<RemotePolicyPushResult> =>
    dispatch(machineId, (id) => ({ t: 'policy.push', id, baseRev, doc })).then(toPushResult);

  const revoke = (machineId: string, grantId: string): Promise<Result<null>> =>
    dispatch(machineId, (id) => ({ t: 'policy.revoke', id, grantId })).then(
      (r): Result<null> => (r.ok ? { ok: true, value: null } : { ok: false, error: r.error }),
    );

  return {
    onFrame,
    linksChanged,
    push,
    revoke,
    pendingCount: () => pending.size,
    stop() {
      unsubscribeChange();
      cancelChangeTimer?.();
      cancelChangeTimer = null;
      for (const id of [...pending.keys()])
        settle(id, { ok: false, error: unreachable('Conduit is stopping the network') });
    },
  };
}
