import { useEffect, useMemo, useState } from 'react';
import type { Session } from '../../src/types';
import { digestCounts } from '../away-view-model';
import { useNeedsYouView } from '../needs-you-view-store';
import { openRequest, openSessionTerminal } from '../request-open';
import {
  filterOptions,
  NO_FILTERS,
  type RequestFilters,
  type SessionInfo,
} from '../request-view-model';
import type { ConduitMcpApi } from '../use-conduit-mcp';
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
      options={filterOptions(requests?.open ?? [], {
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
      <NeedsYouPane
        historySignal={historySignal}
        requests={requests}
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
