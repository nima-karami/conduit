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

export interface PendingAppCreateMatcher {
  begin(windowId: number): symbol;
  opened(event: ServerEvents['sessions.opened']): void;
  resolve(token: symbol, sessionId: string): void;
  cancel(token: symbol): void;
  isHeld(sessionId: string): boolean;
}

/** Matches app-created sessions by the id returned from C2, even when opened arrives first. */
export function createPendingAppCreateMatcher(
  place: (event: ServerEvents['sessions.opened'], windowId?: number) => void,
): PendingAppCreateMatcher {
  const pending = new Map<symbol, { windowId: number; sessionId?: string }>();
  const unresolved = new Set<symbol>();
  const bySession = new Map<string, symbol>();
  const opened = new Map<string, ServerEvents['sessions.opened']>();

  const flushUnmatched = () => {
    if (unresolved.size > 0) return;
    for (const [sessionId, event] of opened) {
      if (bySession.has(sessionId)) continue;
      opened.delete(sessionId);
      place(event);
    }
  };

  const consume = (token: symbol, event: ServerEvents['sessions.opened']) => {
    const create = pending.get(token);
    if (!create) return false;
    pending.delete(token);
    unresolved.delete(token);
    if (create.sessionId !== undefined) bySession.delete(create.sessionId);
    place(event, create.windowId);
    flushUnmatched();
    return true;
  };

  return {
    begin(windowId) {
      const token = Symbol('app-create');
      pending.set(token, { windowId });
      unresolved.add(token);
      return token;
    },
    opened(event) {
      if (event.openerSessionId !== undefined) return;
      const token = bySession.get(event.sessionId);
      if (token !== undefined && consume(token, event)) return;
      if (unresolved.size === 0) place(event);
      else opened.set(event.sessionId, event);
    },
    resolve(token, sessionId) {
      const create = pending.get(token);
      if (!create) return;
      create.sessionId = sessionId;
      unresolved.delete(token);
      bySession.set(sessionId, token);
      const event = opened.get(sessionId);
      if (event) {
        opened.delete(sessionId);
        consume(token, event);
      } else flushUnmatched();
    },
    cancel(token) {
      const create = pending.get(token);
      if (!create) return;
      pending.delete(token);
      unresolved.delete(token);
      if (create.sessionId !== undefined) bySession.delete(create.sessionId);
      flushUnmatched();
    },
    isHeld(sessionId) {
      return opened.has(sessionId);
    },
  };
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
    if (message.type === 'mcp:ask' || message.type === 'mcp:askClosed')
      approvalRecipients.add(windowId);
    if (raise) d.raiseWindow(windowId);
  };

  const approvalRecipients = new Set<number>();

  const handlers: { [E in keyof ServerEvents]: (data: ServerEvents[E]) => void } = {
    'sessions.changed': (data) => {
      sessions(data.sessions);
      d.broadcastState();
    },
    'sessions.opened': (data) => d.place(data),
    'term.show': (data) => d.terminals.show(data.sessionId, data.data),
    'ui.post': (data) => post(data.route, data.message, data.raise),
    'approvals.changed': (data) => syncApprovals(data.pending),
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

  const syncApprovals = (pending: ServerSnapshot['pendingAsks']) => {
    const owners = new Map<number, typeof pending>();
    for (const session of d.store.list()) {
      const windowId = d.ownerWindowOf(session.id);
      if (windowId !== undefined && !owners.has(windowId)) owners.set(windowId, []);
    }
    for (const ask of pending) {
      const windowId = d.ownerWindowOf(ask.callerSessionId);
      if (windowId === undefined) continue;
      const list = owners.get(windowId) ?? [];
      list.push(ask);
      owners.set(windowId, list);
    }
    const recipients = new Set([...approvalRecipients, ...owners.keys()]);
    for (const windowId of recipients)
      d.sendToWindow(windowId, { type: 'mcp:asksSnapshot', asks: owners.get(windowId) ?? [] });
    approvalRecipients.clear();
    for (const windowId of owners.keys()) approvalRecipients.add(windowId);
  };

  return {
    snapshot(s) {
      d.onServerSettings(s.settings);
      d.onStores(s.stores);
      d.onRuntime(s.runtime);
      sessions(s.sessions);
      d.broadcast({ type: 'timer:state', ...s.timers });
      d.broadcast({ type: 'mcp:state', state: s.mcp });
      // F7: every owner receives the full set so a missed close cannot leave a stale card.
      syncApprovals(s.pendingAsks);
      d.broadcastState();
    },
    event(e) {
      const handler = handlers[e.type] as (data: unknown) => void;
      handler(e.data);
    },
  };
}
