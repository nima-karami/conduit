import { useEffect, useMemo, useState } from 'react';
import type { OwnerPermissionView, RequestView } from '../../src/conduit-mcp/request-types';
import type { Session } from '../../src/types';
import { digestCounts } from '../away-view-model';
import { useAsks } from '../mcp-ask-store';
import { useNeedsYouView } from '../needs-you-view-store';
import { openRequest, openSessionTerminal } from '../request-open';
import {
  filterOptions,
  NO_FILTERS,
  type RequestFilters,
  type SessionInfo,
} from '../request-view-model';
import type { ConduitMcpApi } from '../use-conduit-mcp';
import { useOwnerPermissions } from '../use-owner-permissions';
import { AwayBanner } from './away-banner';
import { NeedsYouDigest } from './needs-you-digest';
import { NeedsYouMenu } from './needs-you-menu';
import { NeedsYouPane } from './needs-you-pane';

export function NeedsYouPanel({
  mcp,
  sessions,
  spaceNames,
}: {
  mcp: ConduitMcpApi;
  sessions: readonly Session[];
  spaceNames: ReadonlyMap<string, string>;
}) {
  const [view, setView] = useNeedsYouView();
  // Filters are per visit: a remount starts unfiltered.
  const [filters, setFilters] = useState<RequestFilters>(NO_FILTERS);
  const [legendOpen, setLegendOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const requests = mcp.state?.requests ?? null;
  const asks = useAsks();
  const [permissionRevision, setPermissionRevision] = useState(0);
  const ownerPermissions = useOwnerPermissions(
    mcp,
    `${asks.map((a) => a.askId).join(',')}:${permissionRevision}:${requests?.open.length ?? 0}:${requests?.ended.length ?? 0}`,
  );
  const permissions = ownerPermissions.rows;
  const permissionViews = permissions.map(permissionView);
  const combinedRequests = requests && {
    ...requests,
    open: [...requests.open, ...permissionViews.filter((r) => r.state === 'open')],
    ended: [...requests.ended, ...permissionViews.filter((r) => r.state !== 'open')],
  };
  const sessionInfo = useMemo(
    () =>
      new Map<string, SessionInfo>(
        sessions.map((s): [string, SessionInfo] => [
          s.id,
          { name: s.name, handle: s.mcpHandle ?? null },
        ]),
      ),
    [sessions],
  );

  const [historySignal, setHistorySignal] = useState(0);
  const [dismissedTo, setDismissedTo] = useState(readDismissedDigest);
  const presence = requests?.presence ?? null;
  const digest = requests && presence?.state === 'here' ? digestCounts(requests) : null;
  const showDigest = digest !== null && digest.to !== dismissedTo;

  const menu = (
    <NeedsYouMenu
      sort={view.sort}
      onSort={(sort) => setView({ ...view, sort })}
      filters={filters}
      onFilters={setFilters}
      options={filterOptions(combinedRequests?.open ?? [], {
        sessions: sessionInfo,
        spaces: spaceNames,
      })}
      show={view.show}
      onShow={(show) => setView({ ...view, show })}
      onLegend={() => setLegendOpen(true)}
    />
  );

  return (
    <div className="needs-panel">
      {presence && <AwayBanner presence={presence} onBack={() => mcp.setAway(false, null)} />}
      {showDigest && (
        <NeedsYouDigest
          counts={digest}
          onDismiss={() => {
            writeDismissedDigest(digest.to);
            setDismissedTo(digest.to);
          }}
          onShowHistory={() => setHistorySignal((n) => n + 1)}
        />
      )}
      {ownerPermissions.error && (
        <div role="alert">
          Could not load permission requests.{' '}
          <button type="button" className="btn btn--sm" onClick={ownerPermissions.retry}>
            Retry
          </button>
        </div>
      )}
      <NeedsYouPane
        historySignal={historySignal}
        requests={combinedRequests}
        permissions={permissions}
        asks={asks}
        onPermissionAnswer={async (id, answer) => {
          const result = await mcp.answerPermission(id, answer);
          setPermissionRevision((current) => current + 1);
          return result;
        }}
        sessions={sessions}
        spaceNames={spaceNames}
        sort={view.sort}
        filters={filters}
        show={view.show}
        onClearFilters={() => setFilters(NO_FILTERS)}
        menu={menu}
        legendOpen={legendOpen}
        onCloseLegend={() => setLegendOpen(false)}
        onOpen={(id) => {
          openRequest(id);
        }}
        onOpenTerminal={(sid) => {
          openSessionTerminal(sid);
        }}
        now={now}
      />
    </div>
  );
}

// Per viewer: which return digest this person already dismissed, so it isn't shown twice.
const DIGEST_KEY = 'conduit.needsYou.digestDismissed';
function readDismissedDigest(): string | null {
  try {
    return localStorage.getItem(DIGEST_KEY);
  } catch {
    return null;
  }
}
function writeDismissedDigest(to: string): void {
  try {
    localStorage.setItem(DIGEST_KEY, to);
  } catch {
    // Storage can be unavailable; the digest then hides only for this visit.
  }
}

function permissionView(r: OwnerPermissionView): RequestView {
  return {
    id: r.id,
    origin: r.machine,
    source: 'policy',
    kind: 'attend',
    requester: r.requester,
    session: r.sessionId,
    space: r.space,
    lead: r.lead,
    machine: r.machine,
    title: r.title,
    body: '',
    options: [],
    multi: false,
    draft: null,
    thread: null,
    messageId: null,
    blocked: 'permission',
    priority: 'normal',
    createdAt: r.createdAt,
    expiresAt: r.expiresAt,
    default: null,
    contentKey: r.id,
    state: r.state,
    endedAt: r.endedAt,
    answer: null,
    withdrawnBy: r.state === 'withdrawn' ? 'conduit' : null,
    withdrawReason: r.withdrawReason,
    supersededBy: null,
    deliveredAt: null,
    permission: null,
    waiting: r.state === 'open',
    waitingUntil: r.expiresAt,
  };
}
