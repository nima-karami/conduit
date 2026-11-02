import type {
  DataStores,
  RuntimeHealth,
  ServerEventEnvelope,
  ServerEvents,
  ServerSettings,
  ServerSnapshot,
  UiRoute,
} from '../src/contracts/server-protocol';
import { shouldRaiseOsAttention } from '../src/os-attention';
import type { HostToWebview } from '../src/protocol';
import type { AppSessionStore, SessionFolderDiff } from './app-session-store';
import type { AppLog } from './server-client';
import type { TerminalHost } from './terminal-host';

type OpenFileInEditor = Extract<HostToWebview, { type: 'openFileInEditor' }>;

export interface ServerEventRouterDeps {
  store: Pick<AppSessionStore, 'applyServer' | 'list'>;
  terminals: Pick<TerminalHost, 'sessionsChanged' | 'show'>;
  broadcastState(): void;
  broadcast(m: HostToWebview): void;
  sendToWindow(id: number, m: HostToWebview): void;
  ownerWindowOf(sessionId: string): number | undefined;
  raiseWindow(id: number): void;
  /** Queued by the app until the renderer is ready, like an OS open. */
  openFileInEditor(m: OpenFileInEditor): void;
  /** Folder watchers, repo scans and window ownership follow the server's list. */
  sessionsApplied(diffs: SessionFolderDiff[]): void;
  onServerSettings(s: ServerSettings): void;
  onStores(s: Partial<DataStores>): void;
  onRuntime(h: RuntimeHealth): void;
  /** The UI key that gates OS attention (D9): the server emits edges unconditionally. */
  osAttention(): boolean;
  anyWindowFocused(): boolean;
  notifyAttention(sessionId: string, kind: ServerEvents['attention.edge']['kind']): void;
  flash(sessionId: string): void;
  /** Before the `sessions.changed` that first lists the session (C2 sessions.opened). */
  place(e: ServerEvents['sessions.opened']): void;
  log: AppLog;
}

/** One switch over C2's events: each lands in the store, a renderer message or an OS effect. */
export function createServerEventRouter(d: ServerEventRouterDeps): {
  snapshot(s: ServerSnapshot): void;
  event(e: ServerEventEnvelope): void;
} {
  const sessions = (views: ServerSnapshot['sessions']) => {
    const prev = d.store.list();
    const diffs = d.store.applyServer(views);
    d.sessionsApplied(diffs);
    d.terminals.sessionsChanged(prev, d.store.list());
  };

  const post = (route: UiRoute, message: HostToWebview, raise?: boolean) => {
    if (message.type === 'openFileInEditor') {
      d.openFileInEditor(message);
      return;
    }
    if (route.kind === 'broadcast') {
      d.broadcast(message);
      return;
    }
    const windowId = route.kind === 'owner' ? d.ownerWindowOf(route.sessionId) : route.windowId;
    if (windowId === undefined) return;
    d.sendToWindow(windowId, message);
    if (raise) d.raiseWindow(windowId);
  };

  const handlers: { [E in keyof ServerEvents]: (data: ServerEvents[E]) => void } = {
    'sessions.changed': (data) => {
      sessions(data.sessions);
      d.broadcastState();
    },
    'sessions.opened': (data) => d.place(data),
    'term.show': (data) => d.terminals.show(data.sessionId, data.data),
    'ui.post': (data) => post(data.route, data.message, data.raise),
    // Asks reach their windows as ui.post; the list matters only to a (re)connecting app.
    'approvals.changed': () => {},
    'attention.edge': (data) => {
      if (
        shouldRaiseOsAttention({
          becameNeedsAttention: true,
          windowFocused: d.anyWindowFocused(),
          enabled: d.osAttention(),
        })
      )
        d.notifyAttention(data.sessionId, data.kind);
    },
    'attention.flash': (data) => {
      if (d.osAttention()) d.flash(data.sessionId);
    },
    'serverSettings.changed': (data) => d.onServerSettings(data.settings),
    'data.changed': (data) => d.onStores({ [data.store]: data.value }),
    'runtime.changed': (data) => d.onRuntime(data),
    // Before the coalesced timers.changed: the toasts read this pre-fire record.
    'timers.fired': (data) => d.broadcast({ type: 'timer:fired', ...data }),
    'timers.changed': (data) => d.broadcast({ type: 'timer:state', ...data }),
    'server.stopping': (data) => d.log('info', 'server stopping', { reason: data.reason }),
    // The client re-subscribes on it itself.
    missed: () => {},
  };

  return {
    snapshot(s) {
      d.onServerSettings(s.settings);
      d.onStores(s.stores);
      d.onRuntime(s.runtime);
      sessions(s.sessions);
      d.broadcast({ type: 'timer:state', ...s.timers });
      d.broadcast({ type: 'mcp:state', state: s.mcp });
      // F7: an ask opened while this app was away is answerable from its owner window.
      for (const ask of s.pendingAsks)
        post({ kind: 'owner', sessionId: ask.callerSessionId }, { type: 'mcp:ask', ...ask });
      d.broadcastState();
    },
    event(e) {
      const handler = handlers[e.type] as (data: unknown) => void;
      handler(e.data);
    },
  };
}
