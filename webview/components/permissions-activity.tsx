import { useEffect, useRef, useState } from 'react';
import type { ActivityEntry, ActivityLookup } from '../../src/conduit-mcp/activity-log';
import type { ActivityPage, ActivityQuery } from '../../src/conduit-mcp/activity-query';
import { CLI_KINDS } from '../../src/conduit-mcp/tool-policy';
import { subscribe } from '../bridge';
import { type ActivityExceptionSource, PermissionsActivityWhy } from './permissions-activity-why';

export interface ActivityScope {
  sessionId?: string;
  machineId?: string;
  item?: Pick<ActivityEntry, 'id' | 'at'>;
}

type Option = { id: string; name: string };
type Filters = {
  session: string;
  cli: NonNullable<ActivityQuery['cli']> | '';
  machine: string;
  decision: NonNullable<ActivityQuery['decision']> | '';
  action: string;
  since: string;
  lane: NonNullable<ActivityQuery['lane']> | '';
};

export function PermissionsActivity({
  sessionId,
  machineId,
  getActivity,
  item,
  getActivityRow,
  allowOnce,
  onAddException,
  sessions = [],
  machines = [],
}: {
  sessionId?: string;
  machineId?: string;
  getActivity(query: ActivityQuery): Promise<ActivityPage | null>;
  item?: Pick<ActivityEntry, 'id' | 'at'>;
  getActivityRow?(id: string, at: string): Promise<ActivityLookup | null>;
  allowOnce?(id: string, at: string): Promise<boolean>;
  onAddException?(source: ActivityExceptionSource): void;
  sessions?: readonly Option[];
  machines?: readonly Option[];
}) {
  const [filters, setFilters] = useState<Filters>({
    session: sessionId ?? '',
    cli: '',
    machine: machineId ?? '',
    decision: '',
    action: '',
    since: '',
    lane: '',
  });
  const [rows, setRows] = useState<ActivityEntry[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [writable, setWritable] = useState(true);
  const [pagination, setPagination] = useState<{ before?: string }>({});
  const [lookupError, setLookupError] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const [selected, setSelected] = useState<ActivityEntry | null>(null);
  const [focusIndex, setFocusIndex] = useState(0);
  const rowRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const change = <K extends keyof Filters>(key: K, value: Filters[K]) => {
    setPagination({});
    setSelected(null);
    setFocusIndex(0);
    setFilters((previous) => ({ ...previous, [key]: value }));
  };
  useEffect(() => {
    if (!item || !getActivityRow) return;
    let alive = true;
    void getActivityRow(item.id, item.at).then(
      (found) => {
        if (!alive) return;
        if (found?.ok) setSelected(found.row);
        else setLookupError('This Activity entry is unavailable.');
      },
      () => {
        if (alive) setLookupError('This Activity entry is unavailable.');
      },
    );
    return () => {
      alive = false;
    };
  }, [item, getActivityRow]);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    const cursor = pagination.before;
    const since = filters.since ? new Date(filters.since) : null;
    void getActivity({
      ...(filters.session ? { sessionId: filters.session } : {}),
      ...(filters.cli ? { cli: filters.cli } : {}),
      ...(filters.machine ? { machineId: filters.machine } : {}),
      ...(filters.decision ? { decision: filters.decision } : {}),
      ...(filters.action.trim() ? { action: filters.action.trim() } : {}),
      ...(since && Number.isFinite(since.getTime()) ? { since: since.toISOString() } : {}),
      ...(filters.lane ? { lane: filters.lane } : {}),
      ...(cursor ? { before: cursor } : {}),
      limit: 50,
    }).then(
      (page) => {
        if (!alive) return;
        if (page) setWritable(page.writable);
        if (!page || page.error) setError(page?.error ?? 'Activity could not be loaded.');
        else {
          setRows((previous) => (cursor ? [...previous, ...page.rows] : page.rows));
          setNext(page.next);
        }
        setLoading(false);
      },
      () => {
        if (alive) {
          setError('Activity could not be loaded.');
          setLoading(false);
        }
      },
    );
    return () => {
      alive = false;
    };
  }, [filters, pagination, getActivity]);
  useEffect(() => {
    if (
      pagination.before ||
      filters.machine ||
      filters.lane === 'observed' ||
      filters.lane === 'note'
    )
      return;
    let refresh: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = subscribe((message) => {
      if (
        message.type !== 'mcp:activityRecorded' ||
        (filters.session && message.sessionId !== filters.session)
      )
        return;
      if (refresh !== undefined) clearTimeout(refresh);
      refresh = setTimeout(() => setPagination({}), 200);
    });
    return () => {
      unsubscribe();
      if (refresh !== undefined) clearTimeout(refresh);
    };
  }, [filters.session, filters.machine, filters.lane, pagination.before]);
  const sessionName = (id: string | null) => sessions.find((s) => s.id === id)?.name ?? id;
  const machineName = (id: string | null) => machines.find((m) => m.id === id)?.name ?? id;
  const actor = (row: ActivityEntry) =>
    [
      row.principal.handle,
      sessionName(row.principal.sessionId),
      machineName(row.principal.machineId),
    ]
      .filter(Boolean)
      .join(' · ') || 'Unknown';
  return (
    <section className="permissions-activity" aria-label="Permissions Activity">
      <header className="permissions-activity__header">
        <h1 ref={heading} tabIndex={-1}>
          Permissions Activity
        </h1>
        <button
          type="button"
          className="btn btn--sm"
          onClick={() => {
            setPagination({});
          }}
        >
          Refresh
        </button>
      </header>
      {lookupError && <p role="alert">{lookupError}</p>}
      <div className="permissions-activity__filters">
        <label>
          Session{' '}
          <input
            list="activity-sessions"
            value={filters.session}
            onChange={(e) => change('session', e.target.value)}
            placeholder="All sessions (ID)"
          />
        </label>
        <datalist id="activity-sessions">
          {sessions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </datalist>{' '}
        <label>
          Agent kind{' '}
          <select
            value={filters.cli}
            onChange={(e) => change('cli', e.target.value as Filters['cli'])}
          >
            <option value="">All agents</option>
            {CLI_KINDS.map((cli) => (
              <option key={cli} value={cli}>
                {cli}
              </option>
            ))}
          </select>
        </label>{' '}
        <label>
          Machine{' '}
          <input
            list="activity-machines"
            value={filters.machine}
            onChange={(e) => change('machine', e.target.value)}
            placeholder="All machines (ID)"
          />
        </label>
        <datalist id="activity-machines">
          {machines.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </datalist>{' '}
        <label>
          Decision{' '}
          <select
            value={filters.decision}
            onChange={(e) => change('decision', e.target.value as Filters['decision'])}
          >
            <option value="">All decisions</option>
            <option value="allow">Allow</option>
            <option value="ask">Ask</option>
            <option value="deny">Deny</option>
          </select>
        </label>{' '}
        <label>
          Action{' '}
          <input
            value={filters.action}
            onChange={(e) => change('action', e.target.value)}
            placeholder="Exact action"
          />
        </label>{' '}
        <label>
          Since{' '}
          <input
            type="datetime-local"
            value={filters.since}
            onChange={(e) => change('since', e.target.value)}
          />
        </label>{' '}
        <label>
          Source{' '}
          <select
            value={filters.lane}
            onChange={(e) => change('lane', e.target.value as Filters['lane'])}
          >
            <option value="">All sources</option>
            <option value="conduit">Conduit</option>
            <option value="observed">Observed</option>
            <option value="note">Note</option>
          </select>
        </label>
      </div>
      {!writable && (
        <p role="status">Activity recording is unavailable; the history may have gaps.</p>
      )}
      {loading && <p role="status">Loading activity…</p>}
      {error && <p role="alert">{error}</p>}
      {!loading && !error && rows.length === 0 && <p>No activity found.</p>}
      {rows.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Time</th>
              <th>Source</th>
              <th>Actor</th>
              <th>Agent</th>
              <th>Tool / action</th>
              <th>Target</th>
              <th>Decision</th>
              <th>Decided by</th>
              <th>Duration</th>
              <th>Details</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={row.id}>
                <td>
                  <time dateTime={row.at}>{new Date(row.at).toLocaleString()}</time>
                </td>
                <td>
                  {row.lane === 'observed'
                    ? 'Observed'
                    : row.lane === 'conduit'
                      ? 'Conduit'
                      : 'Note'}
                </td>
                <td>{actor(row)}</td>
                <td>{row.cli ?? '—'}</td>
                <td>{row.action === 'gap' ? 'Activity gap' : row.action}</td>
                <td>{row.target ?? '—'}</td>
                <td>{row.decision ?? '—'}</td>
                <td>{row.decidedBy || '—'}</td>
                <td>{row.durationMs === null ? '—' : `${row.durationMs} ms`}</td>
                <td>
                  <button
                    type="button"
                    className="btn btn--sm"
                    ref={(node) => {
                      rowRefs.current[index] = node;
                    }}
                    tabIndex={focusIndex === index ? 0 : -1}
                    onFocus={() => setFocusIndex(index)}
                    onClick={() => setSelected(row)}
                    onKeyDown={(e) => {
                      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                        e.preventDefault();
                        const nextIndex = Math.max(
                          0,
                          Math.min(rows.length - 1, index + (e.key === 'ArrowDown' ? 1 : -1)),
                        );
                        setFocusIndex(nextIndex);
                        rowRefs.current[nextIndex]?.focus();
                      }
                    }}
                  >
                    Why
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {next && !loading && !error && (
        <button
          type="button"
          className="btn btn--sm"
          onClick={() => setPagination({ before: next })}
        >
          Load more
        </button>
      )}
      {selected && (
        <div className="permissions-activity__why">
          <PermissionsActivityWhy
            key={JSON.stringify([selected.id, selected.at])}
            row={selected}
            canAllowOnce={
              !!allowOnce &&
              !!selected.trace?.winnerDigest &&
              sessions.some((session) => session.id === selected.principal.sessionId)
            }
            canEditException={
              !!onAddException &&
              sessions.some((session) => session.id === selected.principal.sessionId)
            }
            onAllowOnce={(row) => allowOnce?.(row.id, row.at) ?? Promise.resolve(false)}
            onAddException={(source) => onAddException?.(source)}
            onClose={() => {
              setSelected(null);
              (rowRefs.current[focusIndex] ?? heading.current)?.focus();
            }}
          />
        </div>
      )}
    </section>
  );
}
