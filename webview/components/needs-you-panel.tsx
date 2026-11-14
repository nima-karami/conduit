import { useEffect, useMemo, useState } from 'react';
import type { Session } from '../../src/types';
import { useNeedsYouView } from '../needs-you-view-store';
import { openRequest, openSessionTerminal } from '../request-open';
import {
  filterOptions,
  NO_FILTERS,
  type RequestFilters,
  type SessionInfo,
} from '../request-view-model';
import type { ConduitMcpApi } from '../use-conduit-mcp';
import { NeedsYouMenu } from './needs-you-menu';
import { NeedsYouPane } from './needs-you-pane';

// The right pane is not handed the sidebar's project list, so cards show no space names yet.

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
    <NeedsYouPane
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
  );
}
