import { useEffect, useRef, useState } from 'react';
import type { RequestView } from '../../src/conduit-mcp/request-types';
import { closeRequestTab, openRequest, openSessionTerminal } from '../request-open';
import { REQ_STR } from '../request-strings';
import { type SessionInfo, sortRequests } from '../request-view-model';
import { useConduitMcp } from '../use-conduit-mcp';
import { RequestTemplate } from './request-template';

const NO_SESSIONS: ReadonlyMap<string, SessionInfo> = new Map();

/** Open requests in the order Needs you leads with: waiting first, then urgent, then by deadline. */
export function soonestOpen(open: readonly RequestView[]): RequestView[] {
  return sortRequests(open, 'soonest', NO_SESSIONS);
}

/** A clock for the countdowns; ticks once a second. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

export interface RequestTabProps {
  requestId: string;
  sessionName: string;
}

export function RequestTab({ requestId, sessionName }: RequestTabProps) {
  const api = useConduitMcp();
  // Only a request answered here closes its tab: one withdrawn or answered elsewhere keeps its
  // ended banner so unsent text stays copyable (spec §5).
  const answeredHere = useRef(false);
  const now = useNow();
  const requests = api.state?.requests ?? null;
  const ordered = soonestOpen(requests?.open ?? []);
  const at = ordered.findIndex((r) => r.id === requestId);
  const r: RequestView | undefined =
    at >= 0 ? ordered[at] : requests?.ended.find((x) => x.id === requestId);

  if (!r) {
    return (
      <section className="reqtpl-tab reqtpl-tab__gone" role="status">
        <p>{REQ_STR.reqTab.gone}</p>
        <p>{REQ_STR.reqTab.goneHint}</p>
      </section>
    );
  }

  const after = at >= 0 ? ordered[at + 1] : undefined;
  const moreCount = at >= 0 ? ordered.length - at - 1 : 0;

  return (
    <div className="reqtpl-tab">
      <RequestTemplate
        request={r}
        sessionName={sessionName}
        mode="tab"
        moreCount={moreCount}
        now={now}
        onSend={async (answer) => {
          const result = await api.answerRequest(r.id, answer);
          if (result.ok) answeredHere.current = true;
          return result;
        }}
        onNext={() => {
          if (answeredHere.current) {
            closeRequestTab(r.id);
            const next = ordered.find((x) => x.id !== r.id);
            if (next) openRequest(next.id);
            return;
          }
          if (after) openRequest(after.id);
        }}
        onOpenAsTab={() => openRequest(r.id, { asTab: true })}
        onOpenTerminal={() => {
          if (r.session !== null) openSessionTerminal(r.session);
        }}
      />
    </div>
  );
}
