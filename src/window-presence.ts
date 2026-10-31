// Node-free. Fail-closed on purpose: a policy check must never treat an unknown or reloading window
// as showing a session. session-activity's visible set is fail-open and stays separate
// (spec 2026-10-30-conduit-mcp-tool-policy §2.3).

export interface WindowPresence {
  /** Main-frame navigation began or the renderer died: not ready, no visible report. */
  startLoading(windowId: number): void;
  markReady(windowId: number): void;
  setVisible(windowId: number, ids: readonly string[]): void;
  drop(windowId: number): void;
  isReady(windowId: number): boolean;
  /** Fail-closed: ready AND reported since the last startLoading AND id in that report. */
  isOnScreen(windowId: number, sessionId: string): boolean;
}

interface WindowState {
  ready: boolean;
  /** null: no report since the last startLoading. */
  visible: ReadonlySet<string> | null;
}

export function createWindowPresence(): WindowPresence {
  const windows = new Map<number, WindowState>();
  const stateOf = (windowId: number): WindowState => {
    let s = windows.get(windowId);
    if (!s) {
      s = { ready: false, visible: null };
      windows.set(windowId, s);
    }
    return s;
  };
  return {
    startLoading: (windowId) => {
      windows.set(windowId, { ready: false, visible: null });
    },
    markReady: (windowId) => {
      stateOf(windowId).ready = true;
    },
    setVisible: (windowId, ids) => {
      stateOf(windowId).visible = new Set(ids);
    },
    drop: (windowId) => {
      windows.delete(windowId);
    },
    isReady: (windowId) => windows.get(windowId)?.ready === true,
    isOnScreen: (windowId, sessionId) => {
      const s = windows.get(windowId);
      return s?.ready === true && s.visible !== null && s.visible.has(sessionId);
    },
  };
}
