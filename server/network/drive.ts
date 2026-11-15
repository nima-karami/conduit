import path from 'node:path';
import type { Capabilities, LinkFrame, LinkState } from '../../src/contracts/link-protocol';
import type { TermGeometry } from '../../src/protocol';
import { RpcFault } from '../transport/pipe';
import type { AuditSink } from './audit-log';

// Drive: a person at another machine's GUI types into, resizes, opens and closes my sessions
// (spec §4.1; plan Slice 8 and its handover rulings). It is remote execution, so the serving side
// re-checks my own record of the link on every frame and never trusts the peer's claims.

export type DriveFrame = Extract<
  LinkFrame,
  { t: 'drive.input' | 'drive.resize' | 'drive.open' | 'drive.close' | 'drive.result' }
>;

export interface DriveLink {
  machineId: string;
  state: LinkState;
  /** My record of the link: what I let that machine do. */
  capabilities: Capabilities;
  /** Its record of the link: what it lets me do. */
  peerCapabilities: Capabilities | null;
}

/** Input data larger than this in one frame is refused, not truncated. */
export const DRIVE_INPUT_MAX_BYTES = 64 * 1024;
/** At most one `drive.refused` audit entry per link in this window; never one per keystroke. */
export const DRIVE_REFUSAL_AUDIT_MS = 60_000;
/** `remote.open` / `remote.close` give up waiting for `drive.result` after this. */
export const DRIVE_RESULT_TIMEOUT_MS = 15_000;

export interface DriveDeps {
  links(): DriveLink[];
  /** True only for a live local session (running, with a terminal). */
  liveSession(sessionId: string): boolean;
  /** True only for an id in the domain's registered agents store. */
  agentExists(agentId: string): boolean;
  isDirectory(absolutePath: string): Promise<boolean>;
  /** services.ts `applyHumanInput(id, data, null)`: the C2 human input path. */
  applyHumanInput(sessionId: string, data: string): boolean;
  /** `runtime.resize` then `domain.resized`. */
  resize(sessionId: string, size: TermGeometry): void;
  /** The C2 `sessions.create` + `sessions.start` semantics; resolves to the new session id. */
  openSession(agentId: string, folder: string): Promise<string>;
  /** The C2 `sessions.close` semantics. */
  closeSession(sessionId: string): Promise<void>;
  send(machineId: string, frame: LinkFrame): boolean | null;
  audit: AuditSink;
  now(): number;
  newId(): string;
  after(fn: () => void, ms: number): () => void;
  log(message: string): void;
}

export interface Drive {
  /** Serving side for drive.input/resize/open/close; viewer side for drive.result. */
  onFrame(machineId: string, frame: DriveFrame): Promise<void>;
  /** Any change to a link's state or capabilities, including revoke. */
  linkChanged(machineId: string): void;
  /** Viewer side (C2 `remote.input`). Throws RpcFault `peer_unreachable` or `capability_off`. */
  input(machineId: string, sessionId: string, data: string): void;
  /** Viewer side (C2 `remote.resize`). */
  resize(machineId: string, sessionId: string, cols: number, rows: number): void;
  /** Viewer side (C2 `remote.open`). Resolves on `drive.result`. */
  open(machineId: string, agentId: string, folder: string): Promise<{ sessionId: string }>;
  /** Viewer side (C2 `remote.close`). */
  close(machineId: string, sessionId: string): Promise<void>;
  stop(): void;
}

const live = (state: LinkState) => state === 'up' || state === 'degraded';

/** The capability seam: I let this machine drive right now. Never consults the peer's record. */
export function driveAllowed(link: DriveLink | undefined): boolean {
  return link !== undefined && live(link.state) && link.capabilities.drive === true;
}

/** Terminal dimensions a remote resize may ask for; the peer's own geometry is never trusted. */
const MAX_DIMENSION = 10_000;

const dimension = (n: unknown): n is number =>
  typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= MAX_DIMENSION;

/** Folder segments split on either separator, so a `..` is caught on every platform. */
const hasParentSegment = (folder: string): boolean => folder.split(/[\\/]+/).includes('..');

interface Pending {
  machineId: string;
  cancel(): void;
  resolve(sessionId: string | null): void;
  reject(error: Error): void;
}

export function createDrive(deps: DriveDeps): Drive {
  /** The last `drive.refused` audit per link, so a flood of keystrokes audits once a minute. */
  const lastRefusal = new Map<string, number>();
  /** Sessions with a drive.start audit for each link-up, cleared when the link stops driving. */
  const started = new Map<string, Set<string>>();
  const pending = new Map<string, Pending>();
  const link = (machineId: string) => deps.links().find((l) => l.machineId === machineId);
  const allowed = (machineId: string): boolean => driveAllowed(link(machineId));

  const refuse = (machineId: string, reason: string): void => {
    const at = deps.now();
    const last = lastRefusal.get(machineId);
    if (last !== undefined && at - last < DRIVE_REFUSAL_AUDIT_MS) return;
    lastRefusal.set(machineId, at);
    deps.audit.record({ kind: 'drive.refused', peer: machineId, detail: { reason } });
  };

  const stopFor = (machineId: string): void => {
    const sessions = started.get(machineId);
    if (!sessions) return;
    started.delete(machineId);
    for (const sessionId of sessions)
      deps.audit.record({ kind: 'drive.stop', peer: machineId, detail: { sessionId } });
  };

  const finish = (
    requestId: string,
    outcome: { ok: true; sessionId: string | null } | { ok: false; error: Error },
  ): void => {
    const p = pending.get(requestId);
    if (!p) return;
    pending.delete(requestId);
    p.cancel();
    if (outcome.ok) p.resolve(outcome.sessionId);
    else p.reject(outcome.error);
  };

  const answer = (
    machineId: string,
    requestId: string,
    ok: boolean,
    sessionId: string | null,
    error: string | null,
  ): void => {
    deps.send(machineId, { t: 'drive.result', requestId, ok, sessionId, error });
  };

  const serveInput = (machineId: string, frame: { sessionId: string; data: string }): void => {
    if (!allowed(machineId)) {
      refuse(machineId, 'capability_off');
      return;
    }
    if (!deps.liveSession(frame.sessionId)) {
      refuse(machineId, 'no_session');
      return;
    }
    if (Buffer.byteLength(frame.data, 'utf8') > DRIVE_INPUT_MAX_BYTES) {
      refuse(machineId, 'too_large');
      return;
    }
    if (!deps.applyHumanInput(frame.sessionId, frame.data)) return;
    let sessions = started.get(machineId);
    if (!sessions) {
      sessions = new Set();
      started.set(machineId, sessions);
    }
    if (sessions.has(frame.sessionId)) return;
    sessions.add(frame.sessionId);
    deps.audit.record({
      kind: 'drive.start',
      peer: machineId,
      detail: { sessionId: frame.sessionId },
    });
  };

  const serveResize = (
    machineId: string,
    frame: { sessionId: string; cols: number; rows: number },
  ): void => {
    if (!allowed(machineId)) {
      refuse(machineId, 'capability_off');
      return;
    }
    if (!deps.liveSession(frame.sessionId)) {
      refuse(machineId, 'no_session');
      return;
    }
    if (!dimension(frame.cols) || !dimension(frame.rows)) {
      refuse(machineId, 'bad_size');
      return;
    }
    deps.resize(frame.sessionId, { cols: frame.cols, rows: frame.rows });
  };

  const serveOpen = async (
    machineId: string,
    frame: { requestId: string; agentId: string; folder: string },
  ): Promise<void> => {
    if (!allowed(machineId)) {
      refuse(machineId, 'capability_off');
      answer(machineId, frame.requestId, false, null, 'capability_off');
      return;
    }
    const { agentId, folder } = frame;
    if (
      !deps.agentExists(agentId) ||
      !path.isAbsolute(folder) ||
      hasParentSegment(folder) ||
      !(await deps.isDirectory(folder))
    ) {
      refuse(machineId, 'bad_open');
      answer(machineId, frame.requestId, false, null, 'refused');
      return;
    }
    // The await above is where drive can be turned off or the link revoked: check again before acting.
    if (!allowed(machineId)) {
      refuse(machineId, 'capability_off');
      answer(machineId, frame.requestId, false, null, 'capability_off');
      return;
    }
    try {
      const sessionId = await deps.openSession(agentId, folder);
      answer(machineId, frame.requestId, true, sessionId, null);
    } catch (err) {
      deps.log(`drive open failed: ${String(err)}`);
      answer(machineId, frame.requestId, false, null, 'refused');
    }
  };

  const serveClose = async (
    machineId: string,
    frame: { requestId: string; sessionId: string },
  ): Promise<void> => {
    if (!allowed(machineId)) {
      refuse(machineId, 'capability_off');
      answer(machineId, frame.requestId, false, null, 'capability_off');
      return;
    }
    if (!deps.liveSession(frame.sessionId)) {
      answer(machineId, frame.requestId, false, null, 'unknown_session');
      return;
    }
    try {
      await deps.closeSession(frame.sessionId);
      answer(machineId, frame.requestId, true, null, null);
    } catch (err) {
      deps.log(`drive close failed: ${String(err)}`);
      answer(machineId, frame.requestId, false, null, 'refused');
    }
  };

  /** The viewer's own gate: my record of the peer's link and its record of my drive. */
  const viewerGate = (machineId: string): void => {
    const l = link(machineId);
    if (!l || l.state === 'revoked') throw new RpcFault('peer_revoked', 'link revoked or unknown');
    if (!live(l.state)) throw new RpcFault('peer_unreachable', 'link is down');
    if (l.peerCapabilities?.drive !== true)
      throw new RpcFault('capability_off', 'peer has not enabled drive');
  };

  /** Sends a request that the peer answers with drive.result, and resolves on that answer. */
  const call = (
    machineId: string,
    build: (requestId: string) => LinkFrame,
  ): Promise<string | null> =>
    new Promise((resolve, reject) => {
      viewerGate(machineId);
      const requestId = deps.newId();
      const cancel = deps.after(
        () =>
          finish(requestId, {
            ok: false,
            error: new RpcFault('peer_unreachable', 'no drive.result from the peer in time'),
          }),
        DRIVE_RESULT_TIMEOUT_MS,
      );
      pending.set(requestId, { machineId, cancel, resolve, reject });
      if (deps.send(machineId, build(requestId)) !== true)
        finish(requestId, {
          ok: false,
          error: new RpcFault('peer_unreachable', 'link is down'),
        });
    });

  return {
    async onFrame(machineId, frame) {
      switch (frame.t) {
        case 'drive.input':
          return serveInput(machineId, frame);
        case 'drive.resize':
          return serveResize(machineId, frame);
        case 'drive.open':
          return serveOpen(machineId, frame);
        case 'drive.close':
          return serveClose(machineId, frame);
        case 'drive.result': {
          const p = pending.get(frame.requestId);
          if (!p || p.machineId !== machineId) return;
          if (frame.ok) {
            finish(frame.requestId, { ok: true, sessionId: frame.sessionId });
            return;
          }
          finish(frame.requestId, {
            ok: false,
            error: new RpcFault(
              frame.error === 'capability_off' ? 'capability_off' : 'refused',
              frame.error ?? 'refused',
            ),
          });
          return;
        }
      }
    },
    linkChanged(machineId) {
      const l = link(machineId);
      if (!driveAllowed(l)) stopFor(machineId);
      if (l && live(l.state)) return;
      const revoked = !l || l.state === 'revoked';
      for (const [requestId, p] of [...pending]) {
        if (p.machineId !== machineId) continue;
        finish(requestId, {
          ok: false,
          error: revoked
            ? new RpcFault('peer_revoked', 'link revoked or unknown')
            : new RpcFault('peer_unreachable', 'link is down'),
        });
      }
    },
    input(machineId, sessionId, data) {
      viewerGate(machineId);
      if (deps.send(machineId, { t: 'drive.input', sessionId, data }) !== true)
        throw new RpcFault('peer_unreachable', 'link is down');
    },
    resize(machineId, sessionId, cols, rows) {
      viewerGate(machineId);
      if (deps.send(machineId, { t: 'drive.resize', sessionId, cols, rows }) !== true)
        throw new RpcFault('peer_unreachable', 'link is down');
    },
    open(machineId, agentId, folder) {
      return call(machineId, (requestId) => ({
        t: 'drive.open',
        requestId,
        agentId,
        folder,
      })).then((sessionId) => {
        if (sessionId === null) throw new RpcFault('refused', 'peer returned no session');
        return { sessionId };
      });
    },
    async close(machineId, sessionId) {
      await call(machineId, (requestId) => ({ t: 'drive.close', requestId, sessionId }));
    },
    stop() {
      for (const machineId of [...started.keys()]) stopFor(machineId);
      for (const requestId of [...pending.keys()])
        finish(requestId, {
          ok: false,
          error: new RpcFault('unavailable', 'drive stopped'),
        });
    },
  };
}
