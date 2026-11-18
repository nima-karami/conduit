import { useState } from 'react';
import type { McpUiState } from '../../src/conduit-mcp/ui-types';
import type { NativeSelection } from '../../src/contracts/native-launch';
import type { Session } from '../../src/types';

function modeOf(selection: NativeSelection): string {
  if (selection.status === 'unavailable') return 'Unavailable';
  const { intent } = selection;
  if (intent.requested === null) return 'CLI default';
  return intent.family === 'claude' ? intent.requested.mode : intent.requested.sandbox;
}

export function NativeImpactNotice({
  notice,
  sessions,
  dismiss,
  openSettings,
}: {
  notice: NonNullable<McpUiState['nativeImpact']>;
  sessions: readonly Session[];
  dismiss(id: string): Promise<boolean>;
  openSettings(): void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  const dismissNotice = async () => {
    setPending(true);
    setError(false);
    try {
      if (!(await dismiss(notice.id))) setError(true);
    } catch {
      setError(true);
    } finally {
      setPending(false);
    }
  };

  return (
    <aside
      className="permission-store-notice native-impact-notice"
      aria-label="Native launch settings"
    >
      <p role="status">
        Native launch settings changed for {notice.total}{' '}
        {notice.total === 1 ? 'local session' : 'local sessions'} on their next launch.
      </p>
      <details>
        <summary>Affected sessions</summary>
        <ul>
          {notice.rows.map((row) => (
            <li key={row.sessionId}>
              {sessions.find(({ id }) => id === row.sessionId)?.name ?? row.sessionId}
              {' · '}
              {modeOf(row.before)} → {modeOf(row.after)}
            </li>
          ))}
        </ul>
        {notice.total > notice.rows.length && (
          <p>
            Showing {notice.rows.length} of {notice.total} affected sessions.
          </p>
        )}
      </details>
      {error && <p role="alert">Could not dismiss this notice. Try again.</p>}
      <div className="native-impact-notice__actions">
        <button type="button" className="btn btn--sm" onClick={openSettings}>
          Permissions
        </button>
        <button
          type="button"
          className="btn btn--sm"
          disabled={pending}
          onClick={() => void dismissNotice()}
        >
          {pending ? 'Dismissing…' : 'Dismiss'}
        </button>
      </div>
    </aside>
  );
}
