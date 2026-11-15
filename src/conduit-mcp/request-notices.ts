// Node-free: the timers are injected so the burst rule is testable without real time.
// Summaries carry only Conduit's own words (kind and count), never agent text: see spec §4.5.
import type { RequestKind, RequestRecord } from './request-types';

export const REQUEST_NOTICE_WINDOW_MS = 10_000;

export interface RequestNoticesDeps {
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(t: unknown): void;
  away(): boolean;
  emit(edge: { sessionId: string; kind: 'request'; requestKind: RequestKind; count: number }): void;
}

export interface RequestNotices {
  added(r: Pick<RequestRecord, 'session' | 'kind' | 'priority'>): void;
  dispose(): void;
}

interface Burst {
  timer: unknown;
  held: number;
  first: { sessionId: string; kind: RequestKind } | null;
}

export function createRequestNotices(deps: RequestNoticesDeps): RequestNotices {
  let burst: Burst | null = null;
  let disposed = false;

  const openBurst = (): void => {
    const timer = deps.setTimer(closeBurst, REQUEST_NOTICE_WINDOW_MS);
    burst = { timer, held: 0, first: null };
  };

  function closeBurst(): void {
    const ended = burst;
    if (ended === null) return;
    if (ended.first === null) {
      burst = null;
      return;
    }
    openBurst();
    deps.emit({
      sessionId: ended.first.sessionId,
      kind: 'request',
      requestKind: ended.first.kind,
      count: ended.held,
    });
  }

  return {
    added(r) {
      if (disposed) return;
      if (r.session === null) return;
      if (deps.away() && r.priority !== 'urgent') return;
      if (burst === null) {
        openBurst();
        deps.emit({ sessionId: r.session, kind: 'request', requestKind: r.kind, count: 1 });
        return;
      }
      burst.held += 1;
      burst.first ??= { sessionId: r.session, kind: r.kind };
    },
    dispose(): void {
      disposed = true;
      if (burst !== null) deps.clearTimer(burst.timer);
      burst = null;
    },
  };
}
