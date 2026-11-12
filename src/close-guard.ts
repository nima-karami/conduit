// 'quitAndStop' is the palette's Quit and stop all agents; a plain 'quit' never stops agents.
export type AppQuitReason = 'quit' | 'update' | 'quitAndStop';
export type GuardReason = AppQuitReason | 'windowClose';
export interface GuardAsk {
  requestId: number;
  reason: GuardReason;
  running: number;
  busy: number;
}
export const ACK_TIMEOUT_MS = 3000;
export const SHOWN_TIMEOUT_MS = 12_000;
export const GRANT_TTL_MS = 5000;
// A proceeded window that has not closed by now is stuck in its beforeunload handler.
export const CLOSE_DESTROY_GRACE_MS = 5000;

export interface CloseGuardDeps {
  windowIds(): number[];
  prepare(id: number): void;
  focus(id: number): void;
  counts(id: number): { running: number; busy: number };
  ask(id: number, ask: GuardAsk): void;
  abort(id: number, requestId: number): void;
  confirmUnresponsive(id: number, signal: AbortSignal): Promise<boolean>;
  proceedApp(reason: AppQuitReason): void;
  proceedWindow(id: number): void;
  resumeWindowClose(id: number): void;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  log(message: string): void;
}
export interface CloseGuard {
  requestAppQuit(reason: AppQuitReason, firstId?: number): void;
  requestWindowClose(id: number): void;
  onAck(id: number, requestId: number): void;
  onShown(id: number, requestId: number): void;
  onDecision(id: number, requestId: number, proceed: boolean): void;
  onWindowGone(id: number): void;
  onUnresponsive(id: number): void;
  onWindowCreated(id: number): void;
  unlockAnswered(): void;
  pending(): boolean;
}

interface LiveAsk {
  id: number;
  ask: GuardAsk;
  phase: 'asked' | 'acked' | 'shown';
  timer: unknown;
  box: AbortController | null;
}
interface Answer {
  id: number;
  requestId: number;
}
interface AppGuard {
  kind: 'app';
  reason: AppQuitReason;
  toAsk: number[];
  proceeded: Answer[];
  current: LiveAsk;
}
interface WindowGuard {
  kind: 'window';
  id: number;
  current: LiveAsk;
}
type Queued = { kind: 'window'; id: number } | { kind: 'update'; firstId: number | undefined };

// Only an answered window still holds a locked dialog to release: a timed-out one was already sent
// `abort` (S2), and a gone one has no renderer.
type Outcome = 'answered' | 'timedOut' | 'gone';

/**
 * The windows that will stay open, focused first. A window whose close already proceeded is still
 * alive until its 'closed' event, but it has answered — a later quit must neither count nor ask it (S4).
 */
export function openWindowIds(
  ids: Iterable<number>,
  isLive: (id: number) => boolean,
  closing: ReadonlySet<number>,
  focused?: number,
): number[] {
  const open = [...ids].filter((id) => isLive(id) && !closing.has(id));
  if (focused === undefined || !open.includes(focused)) return open;
  return [focused, ...open.filter((id) => id !== focused)];
}

export function createCloseGuard(deps: CloseGuardDeps): CloseGuard {
  let lastRequestId = 0;
  let guard: AppGuard | WindowGuard | null = null;
  let queue: Queued[] = [];
  let lastProceeded: Answer[] = [];

  const isLive = (id: number) => deps.windowIds().includes(id);

  function nextLive(toAsk: number[]): number | undefined {
    for (let id = toAsk.shift(); id !== undefined; id = toAsk.shift()) if (isLive(id)) return id;
    return undefined;
  }

  function stopAsk(a: LiveAsk): void {
    if (a.timer !== null) deps.clearTimer(a.timer);
    a.timer = null;
    a.box?.abort();
    a.box = null;
  }

  function startTimer(a: LiveAsk, ms: number, awaited: string): void {
    a.timer = deps.setTimer(() => {
      a.timer = null;
      deps.abort(a.id, a.ask.requestId);
      deps.log(
        `close guard: window ${a.id} sent no ${awaited} for request ${a.ask.requestId} in ${ms} ms; proceeding`,
      );
      settle(a, true, 'timedOut');
    }, ms);
  }

  function askWindow(id: number, reason: GuardReason): LiveAsk {
    deps.prepare(id);
    lastRequestId += 1;
    const ask: GuardAsk = { requestId: lastRequestId, reason, ...deps.counts(id) };
    const a: LiveAsk = { id, ask, phase: 'asked', timer: null, box: null };
    deps.ask(id, ask);
    startTimer(a, ACK_TIMEOUT_MS, 'ACK');
    return a;
  }

  function finishApp(reason: AppQuitReason, proceeded: Answer[]): void {
    guard = null;
    queue = [];
    lastProceeded = proceeded;
    deps.proceedApp(reason);
  }

  function settle(a: LiveAsk, proceed: boolean, how: Outcome): void {
    const g = guard;
    if (!g || g.current !== a) return;
    stopAsk(a);
    if (g.kind === 'window') {
      guard = null;
      if (proceed) deps.proceedWindow(g.id);
      drain();
      return;
    }
    if (!proceed) {
      guard = null;
      for (const p of g.proceeded) deps.abort(p.id, p.requestId);
      drain();
      return;
    }
    if (how === 'answered') g.proceeded.push({ id: a.id, requestId: a.ask.requestId });
    const next = nextLive(g.toAsk);
    if (next === undefined) finishApp(g.reason, g.proceeded);
    else g.current = askWindow(next, g.reason);
  }

  function drain(): void {
    while (!guard) {
      const item = queue.shift();
      if (!item) return;
      if (item.kind === 'update') requestAppQuit('update', item.firstId);
      else if (isLive(item.id)) deps.resumeWindowClose(item.id);
    }
  }

  // A shown dialog that the user cannot see (display not updating) must not trap them: a repeat
  // request is their way to reach the native box that can close the window without it.
  function openBox(a: LiveAsk): void {
    if (a.phase !== 'shown' || a.box) return;
    const box = new AbortController();
    a.box = box;
    void deps.confirmUnresponsive(a.id, box.signal).then((closeAnyway) => {
      a.box = null;
      if (closeAnyway) settle(a, true, 'answered');
    });
  }

  function reprobe(a: LiveAsk): void {
    if (a.phase === 'shown') deps.ask(a.id, a.ask);
    deps.focus(a.id);
    openBox(a);
  }

  function liveAsk(id: number, requestId: number): LiveAsk | null {
    const a = guard?.current;
    return a && a.id === id && a.ask.requestId === requestId ? a : null;
  }

  function requestAppQuit(reason: AppQuitReason, firstId?: number): void {
    if (guard?.kind === 'window' && reason === 'update') {
      const i = queue.findIndex((q) => q.kind === 'update');
      if (i >= 0) queue[i] = { kind: 'update', firstId };
      else queue.push({ kind: 'update', firstId });
      return;
    }
    if (guard) {
      if (guard.kind === 'app' && reason === 'update') guard.reason = 'update';
      reprobe(guard.current);
      return;
    }
    const ids = deps.windowIds();
    const toAsk =
      firstId !== undefined && ids.includes(firstId)
        ? [firstId, ...ids.filter((id) => id !== firstId)]
        : ids;
    const first = nextLive(toAsk);
    if (first === undefined) {
      finishApp(reason, []);
      return;
    }
    lastProceeded = [];
    guard = { kind: 'app', reason, toAsk, proceeded: [], current: askWindow(first, reason) };
  }

  return {
    requestAppQuit,
    requestWindowClose(id) {
      if (guard?.kind === 'window' && guard.id !== id) {
        if (!queue.some((q) => q.kind === 'window' && q.id === id))
          queue.push({ kind: 'window', id });
        return;
      }
      if (guard) {
        reprobe(guard.current);
        return;
      }
      guard = { kind: 'window', id, current: askWindow(id, 'windowClose') };
    },
    onAck(id, requestId) {
      const a = liveAsk(id, requestId);
      if (a?.phase !== 'asked') return;
      stopAsk(a);
      a.phase = 'acked';
      startTimer(a, SHOWN_TIMEOUT_MS, 'dialog');
    },
    onShown(id, requestId) {
      const a = liveAsk(id, requestId);
      if (!a || a.phase === 'shown') return;
      stopAsk(a);
      a.phase = 'shown';
    },
    onDecision(id, requestId, proceed) {
      const a = liveAsk(id, requestId);
      if (a) settle(a, proceed, 'answered');
    },
    onWindowGone(id) {
      lastProceeded = lastProceeded.filter((p) => p.id !== id);
      if (guard?.kind === 'app') guard.proceeded = guard.proceeded.filter((p) => p.id !== id);
      const a = guard?.current;
      if (a && a.id === id) settle(a, true, 'gone');
    },
    onUnresponsive(id) {
      const a = guard?.current;
      if (a && a.id === id) openBox(a);
    },
    onWindowCreated(id) {
      if (guard?.kind === 'app' && !guard.toAsk.includes(id)) guard.toAsk.push(id);
    },
    unlockAnswered() {
      const answered = lastProceeded;
      lastProceeded = [];
      for (const p of answered) deps.abort(p.id, p.requestId);
    },
    pending: () => guard !== null,
  };
}

/** The part of a BrowserWindow the fallback needs. */
export interface CloseFallbackWindow {
  id: number;
  isDestroyed(): boolean;
  destroy(): void;
  once(event: 'closed', listener: () => void): unknown;
}
/**
 * Destroys a window whose proceeded close is still pending after the grace period (its renderer is
 * stuck, e.g. in beforeunload). Destroy skips beforeunload, so the close cannot hang.
 */
export function armCloseFallback(
  w: CloseFallbackWindow,
  deps: {
    setTimer(fn: () => void, ms: number): unknown;
    clearTimer(h: unknown): void;
    log(m: string): void;
  },
): void {
  const timer = deps.setTimer(() => {
    if (w.isDestroyed()) return;
    deps.log(
      `close guard: window ${w.id} still open ${CLOSE_DESTROY_GRACE_MS} ms after its close proceeded; destroying it`,
    );
    w.destroy();
  }, CLOSE_DESTROY_GRACE_MS);
  w.once('closed', () => deps.clearTimer(timer));
}

export interface QuitGrant {
  issue(): void;
  consume(): boolean;
}
export function createQuitGrant(deps: {
  ttlMs: number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(h: unknown): void;
  onExpire(): void;
}): QuitGrant {
  let timer: unknown = null;
  let armed = false;
  const disarm = () => {
    if (timer !== null) deps.clearTimer(timer);
    timer = null;
    armed = false;
  };
  return {
    issue() {
      disarm();
      armed = true;
      timer = deps.setTimer(() => {
        timer = null;
        armed = false;
        deps.onExpire();
      }, deps.ttlMs);
    },
    consume() {
      if (!armed) return false;
      disarm();
      return true;
    },
  };
}
