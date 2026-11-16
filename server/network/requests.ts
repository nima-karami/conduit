import { isToolErrorCode, type ToolError, toolError } from '../../src/conduit-mcp/types';
import type {
  LinkFrame,
  LinkState,
  RequestAnswerBody,
  RequestMirror,
} from '../../src/contracts/link-protocol';
import { REQUEST_MIRROR_MIN_MINOR } from '../../src/contracts/link-protocol';
import type { LinkRecord } from '../../src/network/link-file';
import type { AuditSink } from './audit-log';
import { CALL_REFUSAL_AUDIT_MS, isDialedSsh } from './calls';

// Remote requests over the ssh link (CON-42 L4, spec 5.3, plan decision 1). B mirrors its open
// requests to the controller that owns it, and applies that controller's answers. A keeps the
// mirror of each machine it dialed and answers those requests call-like: never re-sent.

/** B's side: its open requests, and the answer path a controller's answer is applied through. */
export interface RequestMirrorSource {
  /** B's open requests plus those that ended in the last 10 min. Bounded by REQUEST_MIRROR_MAX. */
  mirrorOf(): RequestMirror[];
  /** Fires when a mirrored request changes. Returns its unsubscribe. */
  onMirrorChange(fn: () => void): () => void;
  /** Applies an owner's answer to a request of mine. `machineId` is the link's, never the frame's. */
  applyRemoteAnswer(
    requestId: string,
    answer: RequestAnswerBody,
    answerId: string,
    machineId: string,
  ): Promise<ApplyRemoteAnswerResult>;
}

export type RemoteAnswerError = {
  code: string;
  message: string;
  retryable: boolean;
  hint?: string;
};
export type ApplyRemoteAnswerResult = { ok: true } | { ok: false; error: RemoteAnswerError };
export type RemoteAnswerResult = { ok: true } | { ok: false; error: ToolError };

/** What A keeps of each machine's mirror, and whether that machine's link is up. */
export type MirrorLinkState = 'up' | 'down' | 'gone';

/** A's side: the mirror store, fed per machine. */
export interface RequestMirrorSink {
  apply(machineId: string, seq: number, requests: RequestMirror[], machineName: string): void;
  setLinkState(machineId: string, state: MirrorLinkState): void;
}

/** An answer waits this long for its request.answered before it is an error. */
export const REMOTE_ANSWER_MS = 30_000;
/** Mirror changes in a burst go out as one snapshot, this long after the first. */
const MIRROR_COALESCE_MS = 250;
const ERROR_CODE_MAX = 64;
const ERROR_MESSAGE_MAX = 1024;
const ERROR_HINT_MAX = 512;

export interface RequestsDeps {
  /** B's side: what I mirror and how an answer lands. */
  b: RequestMirrorSource;
  /** A's side: where the mirrors I receive are kept. */
  a: RequestMirrorSink;
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

export interface Requests {
  /** Any request.* frame from a machine. Answers are served here; the other frames resolve at once. */
  onFrame(machineId: string, frame: LinkFrame): Promise<void>;
  /** Any change to a link's state; a link that is not live ends its pending answers. */
  linksChanged(): void;
  /** A's side: answers one of a dialed machine's requests. Resolves once, never re-sends. */
  answerRemote(
    machineId: string,
    requestId: string,
    answer: RequestAnswerBody,
  ): Promise<RemoteAnswerResult>;
  pendingCount(): number;
  stop(): void;
}

interface Pending {
  machineId: string;
  cancel(): void;
  resolve(result: RemoteAnswerResult): void;
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

/** The mirror store sees a degraded link as up: it still carries frames, as calls treat it. */
function mirrorStateOf(state: LinkState): MirrorLinkState {
  if (live(state)) return 'up';
  return state === 'revoked' ? 'gone' : 'down';
}

export function createRequests(deps: RequestsDeps): Requests {
  /** The last refusal audit per reason and link: a flood of refusals audits once a minute. */
  const lastRefusal = new Map<string, number>();
  /** Answers I sent and have not seen answered, by answer id. Each is settled once, then forgotten. */
  const pending = new Map<string, Pending>();
  /** The mirror state last reported to A's store per dialed machine. */
  const reported = new Map<string, MirrorLinkState>();
  /** The controllers that are live and at a minor that takes mirrors: the ones a snapshot goes to. */
  let eligible = new Set<string>();
  let lastSeq = 0;
  let cancelMirrorTimer: (() => void) | null = null;

  const refuse = (reason: string, machineId: string): void => {
    const key = `${reason}:${machineId}`;
    const at = deps.now();
    const last = lastRefusal.get(key);
    if (last !== undefined && at - last < CALL_REFUSAL_AUDIT_MS) return;
    lastRefusal.set(key, at);
    deps.audit.record({ kind: 'request.refused', peer: machineId, detail: { reason } });
  };

  // A seq that is always above the last one sent, and never below the clock: a restarted B cannot
  // send a number A already holds, so a snapshot from before the restart is never mistaken for newer.
  const nextSeq = (): number => {
    lastSeq = Math.max(lastSeq + 1, deps.now());
    return lastSeq;
  };

  const sendSnapshot = (machineId: string): void => {
    deps.send(machineId, { t: 'request.mirror', seq: nextSeq(), requests: deps.b.mirrorOf() });
  };

  const mirrorable = (machineId: string, state: LinkState): boolean => {
    if (!isInboundController(deps.linkOf(machineId))) return false;
    if (!live(state)) return false;
    const minor = deps.peerMinor(machineId);
    return minor !== null && minor >= REQUEST_MIRROR_MIN_MINOR;
  };

  const settle = (answerId: string, result: RemoteAnswerResult): void => {
    const p = pending.get(answerId);
    if (!p) return;
    pending.delete(answerId);
    p.cancel();
    p.resolve(result);
  };

  const unreachable = (message: string, hint?: string): RemoteAnswerResult => ({
    ok: false,
    error: toolError(
      'peer_unreachable',
      message,
      undefined,
      hint === undefined ? undefined : { hint },
    ),
  });

  const scheduleMirror = (): void => {
    if (cancelMirrorTimer !== null) return;
    cancelMirrorTimer = deps.after(() => {
      cancelMirrorTimer = null;
      for (const machineId of eligible) sendSnapshot(machineId);
    }, MIRROR_COALESCE_MS);
  };
  const unsubscribeMirror = deps.b.onMirrorChange(scheduleMirror);

  const onMirror = (
    machineId: string,
    frame: Extract<LinkFrame, { t: 'request.mirror' }>,
  ): void => {
    const record = deps.linkOf(machineId);
    // Only a machine I dialed may fill my Needs-you queue; anyone else is ignored and audited.
    if (record === null || !isDialedSsh(record)) {
      refuse('not_dialed', machineId);
      return;
    }
    deps.a.apply(machineId, frame.seq, frame.requests, record.name);
  };

  const answeredFrame = (
    answerId: string,
    result: ApplyRemoteAnswerResult,
  ): Extract<LinkFrame, { t: 'request.answered' }> => {
    if (result.ok) return { t: 'request.answered', answerId, ok: true };
    const { error } = result;
    return {
      t: 'request.answered',
      answerId,
      ok: false,
      error: {
        code: printable(error.code, ERROR_CODE_MAX),
        message: printable(error.message, ERROR_MESSAGE_MAX),
        retryable: error.retryable,
        ...(error.hint === undefined ? {} : { hint: printable(error.hint, ERROR_HINT_MAX) }),
      },
    };
  };

  const onAnswer = async (
    machineId: string,
    frame: Extract<LinkFrame, { t: 'request.answer' }>,
  ): Promise<void> => {
    const link = deps.linkOf(machineId);
    // An answer decides a request on B, so only the owner's controller link may carry one.
    if (link === null || !isInboundController(link)) {
      refuse('not_controller', machineId);
      deps.send(machineId, {
        t: 'request.answered',
        answerId: frame.answerId,
        ok: false,
        error: {
          code: 'refused',
          message: 'answers are taken only from an ssh controller',
          retryable: false,
        },
      });
      return;
    }
    // The machine is the link's own: a peer names a request, never the machine that answers it.
    const result = await deps.b.applyRemoteAnswer(
      frame.requestId,
      frame.answer,
      frame.answerId,
      link.machineId,
    );
    deps.send(link.machineId, answeredFrame(frame.answerId, result));
  };

  const onAnswered = (
    machineId: string,
    frame: Extract<LinkFrame, { t: 'request.answered' }>,
  ): void => {
    const p = pending.get(frame.answerId);
    // A late answer (already settled, or timed out) and one from another machine are both ignored.
    if (!p || p.machineId !== machineId) return;
    if (!isDialedSsh(deps.linkOf(machineId))) return;
    settle(
      frame.answerId,
      frame.ok
        ? { ok: true }
        : {
            ok: false,
            error: {
              code: isToolErrorCode(frame.error.code) ? frame.error.code : 'refused',
              message: frame.error.message,
              retryable: frame.error.retryable,
              ...(frame.error.hint === undefined ? {} : { hint: frame.error.hint }),
            },
          },
    );
  };

  const onFrame = async (machineId: string, frame: LinkFrame): Promise<void> => {
    if (frame.t === 'request.mirror') onMirror(machineId, frame);
    else if (frame.t === 'request.answer') await onAnswer(machineId, frame);
    else if (frame.t === 'request.answered') onAnswered(machineId, frame);
  };

  const linksChanged = (): void => {
    const views = deps.links();

    // B: a controller that just became mirrorable gets the full snapshot now; the rest follow on change.
    const nowEligible = new Set<string>();
    for (const v of views) if (mirrorable(v.machineId, v.state)) nowEligible.add(v.machineId);
    for (const machineId of nowEligible) if (!eligible.has(machineId)) sendSnapshot(machineId);
    eligible = nowEligible;

    // A: the state of each machine I dialed. One that I no longer hold is gone.
    const dialedNow = new Map<string, MirrorLinkState>();
    for (const v of views)
      if (isDialedSsh(deps.linkOf(v.machineId))) dialedNow.set(v.machineId, mirrorStateOf(v.state));
    for (const [machineId, state] of dialedNow) {
      if (reported.get(machineId) === state) continue;
      reported.set(machineId, state);
      deps.a.setLinkState(machineId, state);
    }
    for (const machineId of [...reported.keys()]) {
      if (dialedNow.has(machineId)) continue;
      reported.delete(machineId);
      deps.a.setLinkState(machineId, 'gone');
    }

    // A pending answer ends with its link: a drop is peer_unreachable, a revoke or removal peer_revoked.
    const stateOf = new Map(views.map((v) => [v.machineId, v.state]));
    for (const [answerId, p] of [...pending]) {
      const state = stateOf.get(p.machineId);
      if (live(state)) continue;
      settle(
        answerId,
        state === undefined || state === 'revoked'
          ? {
              ok: false,
              error: toolError('peer_revoked', "the machine was removed from this machine's links"),
            }
          : unreachable('the link dropped before the answer came back'),
      );
    }
  };

  const answerRemote = (
    machineId: string,
    requestId: string,
    answer: RequestAnswerBody,
  ): Promise<RemoteAnswerResult> => {
    const record = deps.linkOf(machineId);
    if (record === null) return Promise.resolve(unreachable('no link to that machine'));
    if (!isDialedSsh(record))
      return Promise.resolve({
        ok: false,
        error: toolError('peer_unsupported', `${record.name} was not added over ssh`, undefined, {
          hint: 'answers go only to a machine added over ssh',
        }),
      });
    const state = deps.links().find((v) => v.machineId === machineId)?.state;
    if (state === 'revoked')
      return Promise.resolve({
        ok: false,
        error: toolError('peer_revoked', `${record.name} is revoked`),
      });
    if (state !== 'up')
      return Promise.resolve(
        unreachable(
          `${record.name} is not connected`,
          'connect the machine, then answer again; the answer was not sent',
        ),
      );
    const minor = deps.peerMinor(machineId);
    if (minor === null)
      return Promise.resolve(unreachable(`${record.name} has not said hello yet`));
    if (minor < REQUEST_MIRROR_MIN_MINOR)
      return Promise.resolve({
        ok: false,
        error: toolError(
          'peer_incompatible',
          `${record.name} runs a Conduit that cannot take remote answers`,
          undefined,
          { hint: `update Conduit on ${record.name}` },
        ),
      });

    return new Promise<RemoteAnswerResult>((resolve) => {
      const answerId = deps.newId();
      const cancelTimer = deps.after(
        () =>
          settle(answerId, {
            ok: false,
            error: {
              ...toolError(
                'peer_unreachable',
                `${record.name} did not answer in time`,
                undefined,
                // The owner may have answered before the reply was lost; the answer is never re-sent.
                { hint: 'the answer was not sent again; check the request before you answer it' },
              ),
              retryable: false,
            },
          }),
        REMOTE_ANSWER_MS,
      );
      pending.set(answerId, { machineId, cancel: cancelTimer, resolve });
      const sent = deps.send(machineId, { t: 'request.answer', answerId, requestId, answer });
      // Refused at once: nothing went out, so nothing can be applied.
      if (sent !== true)
        settle(
          answerId,
          unreachable(`${record.name} is not connected`, 'connect the machine first'),
        );
    });
  };

  return {
    onFrame,
    linksChanged,
    answerRemote,
    pendingCount: () => pending.size,
    stop() {
      unsubscribeMirror();
      cancelMirrorTimer?.();
      cancelMirrorTimer = null;
      for (const answerId of [...pending.keys()])
        settle(answerId, unreachable('Conduit is stopping the network'));
    },
  };
}
