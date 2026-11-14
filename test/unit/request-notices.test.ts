import { describe, expect, it } from 'vitest';
import {
  createRequestNotices,
  REQUEST_NOTICE_WINDOW_MS,
  type RequestNoticesDeps,
} from '../../src/conduit-mcp/request-notices';
import type { RequestKind, RequestPriority } from '../../src/conduit-mcp/request-types';

interface Edge {
  sessionId: string;
  kind: 'request';
  requestKind: RequestKind;
  count: number;
}

function harness(opts: { away?: boolean } = {}) {
  let now = 0;
  let seq = 0;
  let awayNow = opts.away ?? false;
  const timers = new Map<number, { fn: () => void; at: number }>();
  const edges: Edge[] = [];
  const deps: RequestNoticesDeps = {
    setTimer(fn, ms) {
      const id = ++seq;
      timers.set(id, { fn, at: now + ms });
      return id;
    },
    clearTimer(t) {
      if (typeof t === 'number') timers.delete(t);
    },
    away: () => awayNow,
    emit: (e) => {
      edges.push(e);
    },
  };
  const notices = createRequestNotices(deps);
  const advance = (ms: number) => {
    const end = now + ms;
    for (;;) {
      let next: [number, { fn: () => void; at: number }] | undefined;
      for (const e of timers) {
        if (e[1].at <= end && (next === undefined || e[1].at < next[1].at)) next = e;
      }
      if (next === undefined) break;
      timers.delete(next[0]);
      now = next[1].at;
      next[1].fn();
    }
    now = end;
  };
  const request = (
    sessionId: string | null,
    kind: RequestKind = 'confirm',
    priority: RequestPriority = 'normal',
  ) => notices.added({ session: sessionId, kind, priority });
  return {
    notices,
    edges,
    advance,
    request,
    setAway: (v: boolean) => {
      awayNow = v;
    },
  };
}

describe('request notices', () => {
  it('the first request notifies at once', () => {
    const h = harness();
    h.request('s1', 'confirm');
    expect(h.edges).toEqual([
      { sessionId: 's1', kind: 'request', requestKind: 'confirm', count: 1 },
    ]);
  });

  it('a burst within 10 s becomes one summary with the count', () => {
    const h = harness();
    h.request('s1', 'confirm');
    h.request('s2', 'choose');
    h.request('s3', 'text');
    expect(h.edges).toHaveLength(1);
    h.advance(REQUEST_NOTICE_WINDOW_MS);
    expect(h.edges).toEqual([
      { sessionId: 's1', kind: 'request', requestKind: 'confirm', count: 1 },
      { sessionId: 's2', kind: 'request', requestKind: 'choose', count: 2 },
    ]);
  });

  it('away holds a normal request', () => {
    const h = harness({ away: true });
    h.request('s1', 'confirm', 'normal');
    expect(h.edges).toEqual([]);
  });

  it('an urgent request notifies while away', () => {
    const h = harness({ away: true });
    h.request('s1', 'review', 'urgent');
    expect(h.edges).toEqual([
      { sessionId: 's1', kind: 'request', requestKind: 'review', count: 1 },
    ]);
  });

  it('a request with no session is skipped', () => {
    const h = harness();
    h.request(null);
    expect(h.edges).toEqual([]);
    h.request('s1');
    expect(h.edges).toHaveLength(1);
  });

  it('a quiet window closes and the next request notifies at once', () => {
    const h = harness();
    h.request('s1');
    h.advance(REQUEST_NOTICE_WINDOW_MS);
    expect(h.edges).toHaveLength(1);
    h.request('s2', 'text');
    expect(h.edges).toEqual([
      { sessionId: 's1', kind: 'request', requestKind: 'confirm', count: 1 },
      { sessionId: 's2', kind: 'request', requestKind: 'text', count: 1 },
    ]);
  });

  it('an urgent request inside a window only adds to the count', () => {
    const h = harness();
    h.request('s1');
    h.request('s2', 'confirm', 'urgent');
    expect(h.edges).toHaveLength(1);
    h.advance(REQUEST_NOTICE_WINDOW_MS);
    expect(h.edges[1]).toMatchObject({ sessionId: 's2', count: 1 });
  });

  it('dispose cancels the open window so its summary never fires', () => {
    const h = harness();
    h.request('s1');
    h.request('s2');
    h.notices.dispose();
    h.advance(REQUEST_NOTICE_WINDOW_MS);
    expect(h.edges).toHaveLength(1);
  });
});
