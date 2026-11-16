import type {
  FsErrorCode,
  GitOp,
  GitReqArgs,
  GitResult,
  LinkFrame,
  LinkState,
} from '../../src/contracts/link-protocol';
import { GIT_MIN_MINOR } from '../../src/contracts/link-protocol';
import type { ServerErrorKind } from '../../src/contracts/server-protocol';
import type { LinkRecord } from '../../src/network/link-file';
import { RpcFault } from '../transport/pipe';
import type { AuditSink } from './audit-log';
import { isDialedSsh } from './calls';

// A's git client (CON-45, plan decision 1). A asks a machine it dialed over ssh for a read of its
// git state. Like the file client, a request is never re-sent: a drop or a timeout is the caller's
// to report.

/** A git request waits at most this long for its git.res (plan decision 1, as file requests). */
export const GIT_REQ_MS = 30_000;
/** At most one `fs.refused` audit entry per link in this window, as the file client does. */
const GIT_REFUSAL_AUDIT_MS = 60_000;

/**
 * How a B refusal reaches the C2 caller. Each FsErrorCode has the ServerErrorKind of the same
 * name, except `failed`: B could not read the repo, which no kind names, so it is unavailable.
 */
const GIT_ERROR_KIND: Record<FsErrorCode, ServerErrorKind> = {
  refused: 'refused',
  not_found: 'not_found',
  too_large: 'too_large',
  unavailable: 'unavailable',
  failed: 'unavailable',
};

type GitResFrame = Extract<LinkFrame, { t: 'git.res' }>;

export interface GitClientDeps {
  /** My record of the link to a machine: only one I dialed over ssh may be asked or answer. */
  linkOf(machineId: string): LinkRecord | null;
  /** The state of my link to a machine, or null when I have none. */
  linkState(machineId: string): LinkState | null;
  /** The protocol minor the peer's hello reported; null until its hello has landed. */
  peerMinor(machineId: string): number | null;
  send(machineId: string, frame: LinkFrame): boolean | null;
  audit: AuditSink;
  now(): number;
  newId(): string;
  after(fn: () => void, ms: number): () => void;
}

export interface GitClient {
  /** Asks a machine I dialed for a git read. Rejects with an RpcFault; never re-sent. */
  request(
    machineId: string,
    op: GitOp,
    sessionId: string,
    root: string,
    args: GitReqArgs,
    signal?: AbortSignal,
  ): Promise<GitResult>;
  /** A git.res from a machine. Anything from a machine I did not dial is dropped. */
  onFrame(machineId: string, frame: GitResFrame): void;
  /** A link that drops ends its requests; a machine that left the link list has its requests ended. */
  linksChanged(views: readonly { machineId: string; state: LinkState }[]): void;
  /** A machine's connection was replaced: its requests end; nothing is re-sent. */
  reconnected(machineId: string): void;
  /** Shutdown: every pending request ends as peer_unreachable. */
  stop(): void;
}

type Outcome = { ok: true; value: GitResult } | { ok: false; fault: RpcFault };

interface Pending {
  machineId: string;
  op: GitOp;
  cancel(): void;
  settle(outcome: Outcome): void;
}

const live = (state: LinkState | null | undefined) => state === 'up' || state === 'degraded';

export function createGitClient(deps: GitClientDeps): GitClient {
  /** The last refusal audit per link, so a flood of refused frames audits once a minute. */
  const lastRefusal = new Map<string, number>();
  /** Requests I sent and have not answered, by request id. Each is answered once, then forgotten. */
  const pending = new Map<string, Pending>();
  /** Machines seen on the link list, so one that leaves it is noticed once. */
  const known = new Set<string>();

  const finish = (id: string, outcome: Outcome): void => {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    p.cancel();
    p.settle(outcome);
  };

  const unreachable = (message: string): RpcFault => new RpcFault('peer_unreachable', message);

  /** Why a machine cannot be asked right now, or null when it can. Only a dialed, live, current peer. */
  const gate = (machineId: string): RpcFault | null => {
    const record = deps.linkOf(machineId);
    if (record === null) return unreachable('no link to that machine');
    if (!isDialedSsh(record))
      return new RpcFault('refused', `${record.name} was not added over ssh`);
    if (!live(deps.linkState(machineId))) return unreachable(`${record.name} is not connected`);
    const minor = deps.peerMinor(machineId);
    if (minor === null) return unreachable(`${record.name} has not said hello yet`);
    if (minor < GIT_MIN_MINOR)
      return new RpcFault('peer_incompatible', `${record.name} runs a Conduit without git reads`);
    return null;
  };

  const settleMachine = (machineId: string, message: string): void => {
    for (const [id, p] of [...pending]) {
      if (p.machineId === machineId) finish(id, { ok: false, fault: unreachable(message) });
    }
  };

  const refuse = (machineId: string): void => {
    const at = deps.now();
    const last = lastRefusal.get(machineId);
    if (last !== undefined && at - last < GIT_REFUSAL_AUDIT_MS) return;
    lastRefusal.set(machineId, at);
    deps.audit.record({
      kind: 'fs.refused',
      peer: machineId,
      detail: { reason: 'not_dialed', frame: 'git.res' },
    });
  };

  return {
    request(machineId, op, sessionId, root, args, signal) {
      const fault = gate(machineId);
      if (fault !== null) return Promise.reject(fault);
      if (signal?.aborted)
        return Promise.reject(new RpcFault('unavailable', 'the request was cancelled'));
      return new Promise<GitResult>((resolve, reject) => {
        const id = deps.newId();
        const cancelTimer = deps.after(
          () => finish(id, { ok: false, fault: unreachable('the git request timed out') }),
          GIT_REQ_MS,
        );
        const onAbort = () =>
          finish(id, {
            ok: false,
            fault: new RpcFault('unavailable', 'the request was cancelled'),
          });
        signal?.addEventListener('abort', onAbort, { once: true });
        pending.set(id, {
          machineId,
          op,
          cancel: () => {
            cancelTimer();
            signal?.removeEventListener('abort', onAbort);
          },
          settle: (outcome) => (outcome.ok ? resolve(outcome.value) : reject(outcome.fault)),
        });
        const sent = deps.send(machineId, { t: 'git.req', id, op, sessionId, root, args });
        // Refused at once: nothing was sent, so nothing can run.
        if (sent !== true)
          finish(id, { ok: false, fault: unreachable('the git request was not sent') });
      });
    },

    onFrame(machineId, frame) {
      if (!isDialedSsh(deps.linkOf(machineId))) return refuse(machineId);
      const p = pending.get(frame.id);
      if (!p || p.machineId !== machineId) return;
      if (!frame.ok) {
        finish(frame.id, {
          ok: false,
          fault: new RpcFault(GIT_ERROR_KIND[frame.error.code], frame.error.message),
        });
        return;
      }
      if (frame.result.op !== p.op) {
        finish(frame.id, {
          ok: false,
          fault: new RpcFault('unavailable', `the answer to ${p.op} was not a ${p.op}`),
        });
        return;
      }
      finish(frame.id, { ok: true, value: frame.result });
    },

    linksChanged(views) {
      const linked = new Set(views.map((v) => v.machineId));
      for (const v of views) {
        known.add(v.machineId);
        if (!live(v.state))
          settleMachine(v.machineId, 'the link dropped before the answer came back');
      }
      for (const machineId of [...known]) {
        if (linked.has(machineId)) continue;
        known.delete(machineId);
        settleMachine(machineId, "the machine left this machine's links");
      }
    },

    reconnected(machineId) {
      settleMachine(machineId, 'the connection to the machine was replaced');
    },

    stop() {
      for (const id of [...pending.keys()])
        finish(id, { ok: false, fault: unreachable('Conduit is stopping the network') });
    },
  };
}
