import { useEffect, useState } from 'react';
import type { ActivityPage, ActivityQuery } from '../../src/conduit-mcp/activity-query';

export function SessionPermissionActivity({
  sessionId,
  getActivity,
}: {
  sessionId: string;
  getActivity(query: ActivityQuery): Promise<ActivityPage | null>;
}) {
  const [state, setState] = useState<
    { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; page: ActivityPage }
  >({ kind: 'loading' });
  useEffect(() => {
    let active = true;
    setState({ kind: 'loading' });
    void getActivity({ sessionId, limit: 5 }).then(
      (page) => {
        if (!active) return;
        if (!page) setState({ kind: 'error', message: 'Activity could not be loaded.' });
        else if (page.error) setState({ kind: 'error', message: page.error });
        else setState({ kind: 'ready', page });
      },
      () => {
        if (active) setState({ kind: 'error', message: 'Activity could not be loaded.' });
      },
    );
    return () => {
      active = false;
    };
  }, [sessionId, getActivity]);
  return (
    <section className="session-permissions__section" aria-label="Recent activity">
      <h3 className="session-permissions__heading">Recent activity</h3>
      {state.kind === 'loading' ? (
        <p role="status">Loading activity…</p>
      ) : state.kind === 'error' ? (
        <p role="alert">{state.message}</p>
      ) : state.page.rows.length === 0 ? (
        <p>No recent activity for this session.</p>
      ) : (
        <ul className="session-permissions__activity">
          {state.page.rows.map((row) => (
            <li key={row.id}>
              <time dateTime={row.at}>{new Date(row.at).toLocaleString()}</time>
              {' · '}
              {row.action}
              {row.target ? ` · ${row.target}` : ''}
              {row.decision ? ` · ${row.decision}` : ''}
              {row.outcome ? ` · ${row.outcome}` : ''}
              {row.summary ? ` · ${row.summary}` : ''}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
