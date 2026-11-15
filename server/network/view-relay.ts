import type {
  Capabilities,
  LinkFrame,
  LinkState,
  MonitorSession,
} from '../../src/contracts/link-protocol';
import type { ServerEvents } from '../../src/contracts/server-protocol';
import type { TerminalRuntime } from '../../src/contracts/terminal-runtime';
import type { TermGeometry, WindowsPtyInfo } from '../../src/protocol';
import { RpcFault } from '../transport/pipe';

type ViewFrame = Extract<
  LinkFrame,
  { t: 'view.open' | 'view.opened' | 'view.data' | 'view.size' | 'view.end' | 'view.close' }
>;
type Observer = NonNullable<Awaited<ReturnType<TerminalRuntime['observe']>>>;
type AttachResult = {
  viewId: string;
  firstPaint: string;
  size: TermGeometry;
  windowsPty: WindowsPtyInfo | null;
  drive: boolean;
};
type ViewLink = {
  machineId: string;
  state: LinkState;
  capabilities: Capabilities;
  peerCapabilities: Capabilities | null;
};
export interface ViewRelayDeps {
  links(): ViewLink[];
  sessions(): Pick<MonitorSession, 'sessionId'>[];
  observe: TerminalRuntime['observe'];
  windowsPty(): WindowsPtyInfo | null;
  send(machineId: string, frame: LinkFrame): boolean | null;
  emitTo<E extends 'remote.data' | 'remote.state'>(
    peer: object,
    type: E,
    data: ServerEvents[E],
  ): void;
  now(): number;
  newId(): string;
  log(message: string): void;
}
interface Served {
  machineId: string;
  viewId: string;
  sessionId: string;
  observer: Observer | null;
}
interface Viewed {
  peer: object;
  machineId: string;
  sessionId: string;
  viewId: string;
  opened: boolean;
  frozen: boolean;
  resolve(result: AttachResult): void;
  reject(error: Error): void;
}
const live = (state: LinkState | undefined) => state === 'up' || state === 'degraded';
const key = (machineId: string, viewId: string) => `${machineId}\0${viewId}`;
const MAX_VIEWS_PER_PEER = 8;
const encode = (s: string) => Buffer.from(s, 'utf8').toString('base64');
const decode = (s: string) => Buffer.from(s, 'base64').toString('utf8');

export function createViewRelay(deps: ViewRelayDeps) {
  const served = new Map<string, Served>();
  const viewed = new Map<string, Viewed>();
  const link = (machineId: string) => deps.links().find((l) => l.machineId === machineId);
  const endFrame = (
    machineId: string,
    viewId: string,
    reason: 'refused' | 'resync' | 'closed' | 'exited',
    exitCode: number | null = null,
  ) => deps.send(machineId, { t: 'view.end', viewId, reason, exitCode });
  const removeServed = (v: Served, reason?: 'refused' | 'resync') => {
    if (served.get(key(v.machineId, v.viewId)) !== v) return;
    served.delete(key(v.machineId, v.viewId));
    v.observer?.close();
    if (reason) endFrame(v.machineId, v.viewId, reason);
  };
  const push = (v: Served, frame: LinkFrame) => {
    if (served.get(key(v.machineId, v.viewId)) !== v) return;
    const result = deps.send(v.machineId, frame);
    if (result === false) removeServed(v, 'resync');
    else if (result === null) removeServed(v);
  };
  const serve = async (machineId: string, frame: Extract<ViewFrame, { t: 'view.open' }>) => {
    const peer = link(machineId);
    const k = key(machineId, frame.viewId);
    const previous = served.get(k);
    if (previous) {
      removeServed(previous, 'refused');
      return;
    }
    if (
      !peer ||
      !live(peer.state) ||
      !peer.capabilities.monitor ||
      !deps.sessions().some((s) => s.sessionId === frame.sessionId) ||
      [...served.values()].filter((v) => v.machineId === machineId).length >= MAX_VIEWS_PER_PEER
    ) {
      endFrame(machineId, frame.viewId, 'refused');
      return;
    }
    const v: Served = {
      machineId,
      viewId: frame.viewId,
      sessionId: frame.sessionId,
      observer: null,
    };
    served.set(k, v);
    try {
      const observer = await deps.observe(frame.sessionId, {
        data: (data) => push(v, { t: 'view.data', viewId: v.viewId, data: encode(data) }),
        size: (size) => push(v, { t: 'view.size', viewId: v.viewId, size }),
        end: (reason, exitCode) => {
          if (served.get(k) !== v) return;
          served.delete(k);
          endFrame(machineId, v.viewId, reason, exitCode);
        },
      });
      if (served.get(k) !== v) {
        observer?.close();
        return;
      }
      if (
        !observer ||
        !link(machineId)?.capabilities.monitor ||
        !deps.sessions().some((s) => s.sessionId === frame.sessionId)
      ) {
        observer?.close();
        removeServed(v, 'refused');
        return;
      }
      v.observer = observer;
      push(v, {
        t: 'view.opened',
        viewId: v.viewId,
        firstPaint: encode(observer.firstPaint),
        size: observer.size,
        windowsPty: deps.windowsPty(),
      });
    } catch (error) {
      deps.log(`view observer failed: ${String(error)}`);
      removeServed(v, 'refused');
    }
  };
  const state = (
    v: Viewed,
    status: 'live' | 'frozen' | 'exited' | 'resyncing',
    size: TermGeometry | null = null,
  ) =>
    deps.emitTo(v.peer, 'remote.state', {
      viewId: v.viewId,
      state: status,
      since: status === 'frozen' ? new Date(deps.now()).toISOString() : null,
      size,
    });
  const removeViewed = (v: Viewed, error?: Error) => {
    if (viewed.get(v.viewId) !== v) return;
    viewed.delete(v.viewId);
    if (!v.opened) v.reject(error ?? new RpcFault('unavailable', 'view closed'));
  };
  return {
    attach(peer: object, machineId: string, sessionId: string): Promise<AttachResult> {
      const l = link(machineId);
      if (!l || l.state === 'revoked')
        return Promise.reject(new RpcFault('peer_revoked', 'link revoked or unknown'));
      if (!live(l.state)) return Promise.reject(new RpcFault('peer_unreachable', 'link is down'));
      if (!l.peerCapabilities?.monitor)
        return Promise.reject(new RpcFault('capability_off', 'peer has not enabled monitor'));
      const viewId = deps.newId();
      return new Promise((resolve, reject) => {
        const v: Viewed = {
          peer,
          machineId,
          sessionId,
          viewId,
          opened: false,
          frozen: false,
          resolve,
          reject,
        };
        viewed.set(viewId, v);
        if (deps.send(machineId, { t: 'view.open', viewId, sessionId }) === null)
          removeViewed(v, new RpcFault('peer_unreachable', 'link is down'));
      });
    },
    detach(peer: object, viewId: string): void {
      const v = viewed.get(viewId);
      if (!v || v.peer !== peer) throw new RpcFault('not_found', 'view not found');
      deps.send(v.machineId, { t: 'view.close', viewId });
      removeViewed(v);
    },
    disconnected(peer: object): void {
      for (const v of viewed.values())
        if (v.peer === peer) {
          deps.send(v.machineId, { t: 'view.close', viewId: v.viewId });
          removeViewed(v);
        }
    },
    revoking(machineId: string): void {
      for (const v of served.values()) if (v.machineId === machineId) removeServed(v, 'refused');
    },
    linkChanged(machineId: string): void {
      const l = link(machineId);
      for (const v of served.values())
        if (v.machineId === machineId && (!l || !l.capabilities.monitor || l.state === 'revoked'))
          removeServed(v, 'refused');
        else if (v.machineId === machineId && !live(l?.state)) removeServed(v);
      for (const v of viewed.values()) {
        if (v.machineId !== machineId) continue;
        if (!l || l.state === 'revoked' || (l.peerCapabilities && !l.peerCapabilities.monitor)) {
          if (v.opened) state(v, 'exited');
          removeViewed(v, new RpcFault('capability_off', 'monitor unavailable'));
          continue;
        }
        if (!live(l.state) && !v.frozen) {
          if (!v.opened) {
            removeViewed(v, new RpcFault('peer_unreachable', 'link is down'));
            continue;
          }
          v.frozen = true;
          state(v, 'frozen');
        } else if (live(l.state) && v.frozen) {
          v.frozen = false;
          state(v, 'resyncing');
          deps.send(machineId, { t: 'view.open', viewId: v.viewId, sessionId: v.sessionId });
        }
      }
    },
    async onFrame(machineId: string, frame: ViewFrame): Promise<void> {
      if (frame.t === 'view.open') return serve(machineId, frame);
      if (frame.t === 'view.close') {
        const v = served.get(key(machineId, frame.viewId));
        if (v) removeServed(v);
        return;
      }
      const v = viewed.get(frame.viewId);
      if (!v || v.machineId !== machineId) return;
      if (frame.t === 'view.opened') {
        if (!v.opened) {
          v.opened = true;
          v.resolve({
            viewId: v.viewId,
            firstPaint: decode(frame.firstPaint),
            size: frame.size,
            windowsPty: frame.windowsPty,
            drive: link(machineId)?.peerCapabilities?.drive ?? false,
          });
        } else {
          state(v, 'live', frame.size);
          deps.emitTo(v.peer, 'remote.data', { viewId: v.viewId, data: decode(frame.firstPaint) });
        }
      } else if (frame.t === 'view.data')
        deps.emitTo(v.peer, 'remote.data', { viewId: v.viewId, data: decode(frame.data) });
      else if (frame.t === 'view.size') state(v, 'live', frame.size);
      else if (frame.reason === 'resync' && v.opened) {
        state(v, 'resyncing');
        deps.send(machineId, { t: 'view.open', viewId: v.viewId, sessionId: v.sessionId });
      } else {
        if (v.opened) state(v, 'exited');
        removeViewed(v, new RpcFault('refused', frame.reason));
      }
    },
    stop(): void {
      for (const v of served.values()) removeServed(v);
      for (const v of viewed.values()) removeViewed(v);
    },
  };
}
