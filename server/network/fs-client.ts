import type {
  FsErrorCode,
  FsOp,
  FsResult,
  LinkFrame,
  LinkState,
} from '../../src/contracts/link-protocol';
import { FS_MIN_MINOR } from '../../src/contracts/link-protocol';
import type { ServerEventSink } from '../../src/contracts/server-ports';
import type { ServerErrorKind } from '../../src/contracts/server-protocol';
import type { LinkRecord } from '../../src/network/link-file';
import { RpcFault } from '../transport/pipe';
import type { AuditSink } from './audit-log';
import { isDialedSsh } from './calls';

// A's file client (CON-43, plan decisions 1, 7 and 8). A asks a machine it dialed over ssh for a
// listing, a read or a stat, and watches folders there. A request is never re-sent: a drop or a
// timeout is the caller's to report. A watch is desired state, re-sent each time its link is up.

/** A file request waits at most this long for its fs.res (plan decision 7). */
export const FS_REQ_MS = 30_000;
/**
 * B caps the watches it holds per link at 64 (plan decision 6). A stops asking first, so the
 * 65th watch is refused here and never reaches B.
 */
export const FS_WATCHES_PER_MACHINE = 64;
/** At most one `fs.refused` audit entry per link in this window, as calls and drive do. */
export const FS_REFUSAL_AUDIT_MS = 60_000;

/**
 * How a B refusal reaches the C2 caller. Each FsErrorCode has the ServerErrorKind of the same
 * name, except `failed`: B could not read the file, which no kind names, so it is unavailable.
 */
const FS_ERROR_KIND: Record<FsErrorCode, ServerErrorKind> = {
  refused: 'refused',
  not_found: 'not_found',
  too_large: 'too_large',
  unavailable: 'unavailable',
  failed: 'unavailable',
};

type FsResFrame = Extract<LinkFrame, { t: 'fs.res' }>;
type FsChangedFrame = Extract<LinkFrame, { t: 'fs.changed' }>;

export interface FsClientDeps {
  /** My record of the link to a machine: only one I dialed over ssh may be asked or answer. */
  linkOf(machineId: string): LinkRecord | null;
  /** The state of my link to a machine, or null when I have none. */
  linkState(machineId: string): LinkState | null;
  /** The protocol minor the peer's hello reported; null until its hello has landed. */
  peerMinor(machineId: string): number | null;
  send(machineId: string, frame: LinkFrame): boolean | null;
  /** Pushes a server event to one app peer: a change is for the peer that watched it. */
  emitTo(peer: object, ...event: Parameters<ServerEventSink>): void;
  audit: AuditSink;
  now(): number;
  newId(): string;
  after(fn: () => void, ms: number): () => void;
}

export interface FsViewLink {
  machineId: string;
  state: LinkState;
}

export interface FsClient {
  /** Asks a machine I dialed for a file op. Rejects with an RpcFault; never re-sent. */
  request(
    machineId: string,
    op: FsOp,
    sessionId: string,
    path: string,
    signal?: AbortSignal,
  ): Promise<FsResult>;
  /** Registers a watch for an app peer; sent now if its link is up, else when it comes up. */
  watch(peer: object, machineId: string, sessionId: string, path: string): string;
  /** Drops a watch the peer owns; throws not_found for any other. */
  unwatch(peer: object, watchId: string): void;
  /** An fs.res or fs.changed from a machine. Anything from a machine I did not dial is dropped. */
  onFrame(machineId: string, frame: FsResFrame | FsChangedFrame): void;
  /** Any change to the link list: a link that comes up re-sends its watches; one that drops ends its requests. */
  linksChanged(views: readonly FsViewLink[]): void;
  /** A machine that left the link list: its requests end and its watches are dropped. */
  forget(machineId: string): void;
  /** An app peer disconnected: its watches are dropped and B is told to unwatch them. */
  peerGone(peer: object): void;
  /** A machine's connection was replaced: its requests end; its watches are sent again on the new one. */
  reconnected(machineId: string): void;
  /** Shutdown: every pending request ends as peer_unreachable. */
  stop(): void;
}

type Outcome = { ok: true; value: FsResult } | { ok: false; fault: RpcFault };

interface Pending {
  machineId: string;
  op: FsOp;
  cancel(): void;
  settle(outcome: Outcome): void;
}

interface Watch {
  watchId: string;
  peer: object;
  machineId: string;
  sessionId: string;
  path: string;
  /** Whether B has been sent this watch on the current link. A down link clears it. */
  sent: boolean;
}

const live = (state: LinkState | null | undefined) => state === 'up' || state === 'degraded';

export function createFsClient(deps: FsClientDeps): FsClient {
  /** The last refusal audit per link, so a flood of refused frames audits once a minute. */
  const lastRefusal = new Map<string, number>();
  /** Requests I sent and have not answered, by request id. Each is answered once, then forgotten. */
  const pending = new Map<string, Pending>();
  const watches = new Map<string, Watch>();
  /** Whether each link was live at the last link change, to act once on up and down. */
  const lastLive = new Map<string, boolean>();

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
    if (minor < FS_MIN_MINOR)
      return new RpcFault('peer_incompatible', `${record.name} runs a Conduit without file access`);
    return null;
  };

  const sendWatch = (w: Watch): void => {
    if (w.sent || gate(w.machineId) !== null) return;
    w.sent =
      deps.send(w.machineId, {
        t: 'fs.watch',
        watchId: w.watchId,
        sessionId: w.sessionId,
        path: w.path,
      }) === true;
  };

  const unwatchOnPeer = (w: Watch): void => {
    if (!w.sent) return;
    deps.send(w.machineId, { t: 'fs.unwatch', watchId: w.watchId });
  };

  const settleMachine = (machineId: string, message: string): void => {
    for (const [id, p] of [...pending]) {
      if (p.machineId === machineId) finish(id, { ok: false, fault: unreachable(message) });
    }
  };

  const forget = (machineId: string): void => {
    lastLive.delete(machineId);
    settleMachine(machineId, "the machine left this machine's links");
    for (const [id, w] of [...watches]) {
      if (w.machineId === machineId) watches.delete(id);
    }
  };

  const refuse = (machineId: string, frame: LinkFrame): void => {
    const at = deps.now();
    const last = lastRefusal.get(machineId);
    if (last !== undefined && at - last < FS_REFUSAL_AUDIT_MS) return;
    lastRefusal.set(machineId, at);
    deps.audit.record({
      kind: 'fs.refused',
      peer: machineId,
      detail: { reason: 'not_dialed', frame: frame.t },
    });
  };

  return {
    request(machineId, op, sessionId, path, signal) {
      const fault = gate(machineId);
      if (fault !== null) return Promise.reject(fault);
      if (signal?.aborted)
        return Promise.reject(new RpcFault('unavailable', 'the request was cancelled'));
      return new Promise<FsResult>((resolve, reject) => {
        const id = deps.newId();
        const cancelTimer = deps.after(
          () => finish(id, { ok: false, fault: unreachable('the file request timed out') }),
          FS_REQ_MS,
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
        const sent = deps.send(machineId, { t: 'fs.req', id, op, sessionId, path });
        // Refused at once: nothing was sent, so nothing can run.
        if (sent !== true)
          finish(id, { ok: false, fault: unreachable('the file request was not sent') });
      });
    },

    watch(peer, machineId, sessionId, path) {
      const record = deps.linkOf(machineId);
      if (record === null) throw new RpcFault('not_found', `No link to ${machineId}`);
      if (!isDialedSsh(record))
        throw new RpcFault('refused', `${record.name} was not added over ssh`);
      // A peer that is known to predate file access would never serve this watch: refuse it now.
      const minor = deps.peerMinor(machineId);
      if (minor !== null && minor < FS_MIN_MINOR)
        throw new RpcFault(
          'peer_incompatible',
          `${record.name} runs a Conduit without file access`,
        );
      let owned = 0;
      for (const w of watches.values()) if (w.peer === peer && w.machineId === machineId) owned++;
      if (owned >= FS_WATCHES_PER_MACHINE)
        throw new RpcFault('refused', `at most ${FS_WATCHES_PER_MACHINE} watches per machine`);
      const w: Watch = { watchId: deps.newId(), peer, machineId, sessionId, path, sent: false };
      watches.set(w.watchId, w);
      sendWatch(w);
      return w.watchId;
    },

    unwatch(peer, watchId) {
      const w = watches.get(watchId);
      if (w === undefined || w.peer !== peer) throw new RpcFault('not_found', 'No such watch');
      watches.delete(watchId);
      unwatchOnPeer(w);
    },

    onFrame(machineId, frame) {
      if (!isDialedSsh(deps.linkOf(machineId))) return refuse(machineId, frame);
      if (frame.t === 'fs.res') {
        const p = pending.get(frame.id);
        if (!p || p.machineId !== machineId) return;
        if (!frame.ok) {
          finish(frame.id, {
            ok: false,
            fault: new RpcFault(FS_ERROR_KIND[frame.error.code], frame.error.message),
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
        return;
      }
      const w = watches.get(frame.watchId);
      if (!w || w.machineId !== machineId) return;
      deps.emitTo(w.peer, 'remote.fs.changed', { watchId: w.watchId, paths: frame.paths });
    },

    linksChanged(views) {
      const linked = new Set(views.map((v) => v.machineId));
      for (const v of views) {
        const isLive = live(v.state);
        lastLive.set(v.machineId, isLive);
        if (!isLive) {
          settleMachine(v.machineId, 'the link dropped before the answer came back');
          for (const w of watches.values()) if (w.machineId === v.machineId) w.sent = false;
          continue;
        }
        for (const w of watches.values()) if (w.machineId === v.machineId) sendWatch(w);
      }
      for (const machineId of [...lastLive.keys()]) {
        if (!linked.has(machineId)) forget(machineId);
      }
    },

    forget,

    reconnected(machineId) {
      settleMachine(machineId, 'the connection to the machine was replaced');
      for (const w of watches.values()) if (w.machineId === machineId) w.sent = false;
      for (const w of watches.values()) if (w.machineId === machineId) sendWatch(w);
    },

    peerGone(peer) {
      for (const [id, w] of [...watches]) {
        if (w.peer !== peer) continue;
        watches.delete(id);
        unwatchOnPeer(w);
      }
    },

    stop() {
      for (const id of [...pending.keys()])
        finish(id, { ok: false, fault: unreachable('Conduit is stopping the network') });
    },
  };
}
