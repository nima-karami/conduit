import type { AttentionPort } from '../../src/contracts/server-ports';
import type { WindowPresence } from '../../src/contracts/server-protocol';

/** The app connection a presence came from; the server's C2 peer object. */
export type AppConnection = object;

export interface PresenceMirror {
  update(conn: AppConnection, windows: readonly WindowPresence[]): void;
  /** An app disconnect is not a window reset: its asks wait out the grace (F7 step 3). */
  disconnect(conn: AppConnection): void;
  ownerWindowOf(sessionId: string): number | null;
  windowReady(windowId: number): boolean;
  onScreen(windowId: number, sessionId: string): boolean;
  /** The app's own id for a namespaced one; null once that window or its connection is gone. */
  localOf(windowId: number): { conn: AppConnection; windowId: number } | null;
  /** The namespaced id for an app's window id, allocated on first sight. */
  globalOf(conn: AppConnection, windowId: number): number;
  /** Whether any app connection is still known. */
  connected(): boolean;
}

interface Known {
  conn: AppConnection;
  local: number;
  state: WindowPresence | undefined;
}

/**
 * The server's view of the app's windows (F7, C2 WindowPresence), keyed by C2 connection: every id
 * the host and AttentionPort see is namespaced, so two apps' window 1 never meet. The host's window
 * events are derived here: a session's owner changing between two updates is a move, a window gone
 * or no longer ready is a reset.
 */
export function createPresenceMirror(deps: {
  attention: Pick<AttentionPort, 'setVisible' | 'dropWindow' | 'clearAll'>;
  onSessionMoved(sessionId: string): void;
  onWindowReset(windowId: number): void;
}): PresenceMirror {
  const ids = new Map<AppConnection, Map<number, number>>();
  const windows = new Map<number, Known>();
  let nextId = 1;

  const globalOf = (conn: AppConnection, local: number): number => {
    let byLocal = ids.get(conn);
    if (!byLocal) {
      byLocal = new Map();
      ids.set(conn, byLocal);
    }
    let g = byLocal.get(local);
    if (g === undefined) {
      g = nextId++;
      byLocal.set(local, g);
      windows.set(g, { conn, local, state: undefined });
    }
    return g;
  };

  const ownerWindowOf = (sessionId: string): number | null => {
    for (const [g, w] of windows) if (w.state?.ownedSessionIds.includes(sessionId)) return g;
    return null;
  };
  const owners = (): Map<string, number> => {
    const out = new Map<string, number>();
    for (const [g, w] of windows)
      for (const s of w.state?.ownedSessionIds ?? []) if (!out.has(s)) out.set(s, g);
    return out;
  };

  const forget = (conn: AppConnection, g: number) => {
    windows.delete(g);
    const byLocal = ids.get(conn);
    const local = [...(byLocal ?? [])].find(([, id]) => id === g)?.[0];
    if (local !== undefined) byLocal?.delete(local);
  };

  return {
    update(conn, next) {
      const before = owners();
      const seen = new Set<number>();
      const resets: number[] = [];
      for (const p of next) {
        const g = globalOf(conn, p.windowId);
        seen.add(g);
        const w = windows.get(g);
        if (!w) continue;
        if (w.state?.ready && !p.ready) resets.push(g);
        w.state = p;
        deps.attention.setVisible(g, p.visibleSessionIds);
      }
      for (const [g, w] of [...windows]) {
        if (w.conn !== conn || seen.has(g)) continue;
        if (w.state) resets.push(g);
        forget(conn, g);
        deps.attention.dropWindow(g);
      }
      for (const g of resets) deps.onWindowReset(g);
      const after = owners();
      for (const [s, was] of before) {
        const now = after.get(s);
        if (now !== undefined && now !== was) deps.onSessionMoved(s);
      }
    },

    disconnect(conn) {
      for (const [g, w] of [...windows]) {
        if (w.conn !== conn) continue;
        windows.delete(g);
        deps.attention.dropWindow(g);
      }
      ids.delete(conn);
      if (ids.size === 0) deps.attention.clearAll();
    },

    ownerWindowOf,
    windowReady: (g) => windows.get(g)?.state?.ready === true,
    onScreen: (g, sessionId) => {
      const s = windows.get(g)?.state;
      return s?.ready === true && s.visibleSessionIds.includes(sessionId);
    },
    localOf: (g) => {
      const w = windows.get(g);
      return w ? { conn: w.conn, windowId: w.local } : null;
    },
    globalOf,
    connected: () => ids.size > 0,
  };
}
