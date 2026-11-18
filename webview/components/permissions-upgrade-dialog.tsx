import { useId, useLayoutEffect, useRef, useState } from 'react';
import type { PolicyEditResult, PolicyUiState } from '../../src/conduit-mcp/policy-types';
import { useFocusTrap } from '../use-focus-trap';
import { ModalLayer } from './modal-layer';

export function PermissionsUpgradeDialog({
  migration,
  editToken,
  acknowledge,
  sessions,
  onReview,
  onReviewSession,
  onDone,
}: {
  migration: NonNullable<PolicyUiState['migration']>;
  editToken: string;
  acknowledge(token: string): Promise<PolicyEditResult | null>;
  sessions: Readonly<Record<string, { name: string; onScreenOnly: boolean }>>;
  onReview(): void;
  onReviewSession(sessionId: string): void;
  onDone(): void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const doneRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const { restoreFocus } = useFocusTrap(ref);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useLayoutEffect(() => {
    if (busy) ref.current?.focus();
    else doneRef.current?.focus();
  }, [busy]);
  const done = async () => {
    if (busy) return;
    setBusy(true);
    const result = await acknowledge(editToken);
    setBusy(false);
    if (!result?.ok) {
      setError('Could not save your acknowledgement. Please try again.');
      return;
    }
    onDone();
    requestAnimationFrame(restoreFocus);
  };
  return (
    <ModalLayer onDismiss={() => {}}>
      <div
        ref={ref}
        className="whats-new permissions-upgrade"
        role="dialog"
        aria-modal
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <h2 id={titleId} className="whats-new__title">
          Permissions have a new home
        </h2>
        <div className="whats-new__body">
          <p>We converted your existing tool settings to permission profiles and exceptions.</p>
          <table className="permissions-upgrade__table">
            <thead>
              <tr>
                <th scope="col">Previous setting</th>
                <th scope="col">Converted to</th>
              </tr>
            </thead>
            <tbody>
              {migration.summary?.map((row) => (
                <tr
                  key={
                    row.point.kind === 'session'
                      ? row.point.sessionId
                      : row.point.kind === 'cli'
                        ? row.point.cli
                        : 'default'
                  }
                >
                  <th scope="row">
                    {row.point.kind === 'default'
                      ? row.provenance === 'resolved-global'
                        ? 'Resolved global settings'
                        : 'Global'
                      : row.point.kind === 'cli'
                        ? row.point.cli
                        : (sessions[row.point.sessionId]?.name ?? row.point.sessionId)}
                    {': '}
                    {row.fields
                      .map((field) => `${field.tool} ${field.field} ${field.value}`)
                      .join(', ')}
                  </th>
                  <td>
                    {row.profileId === 'lead' ? 'Lead' : 'Worker'}
                    {row.exceptions ? ` + ${row.exceptions} exceptions` : ''}
                    {row.onScreenOnly ? ' · only while on screen' : ''}
                  </td>
                </tr>
              ))}
              {migration.offeredSessionIds.map((id) => (
                <tr key={id}>
                  <th scope="row">{sessions[id]?.name ?? id}</th>
                  <td>
                    {sessions[id]?.onScreenOnly ? (
                      <button
                        className="btn btn--sm"
                        type="button"
                        disabled={busy}
                        onClick={() => onReviewSession(id)}
                      >
                        Review on-screen limit
                      </button>
                    ) : (
                      'An on-screen limit was offered during the upgrade.'
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {migration.summaryTruncated && (
            <p>Additional converted settings are available in Settings.</p>
          )}
          <p>
            Activity records Conduit permission decisions from today. Each agent’s own CLI
            separately controls its shell commands and file edits.
          </p>
          {error && <p role="alert">{error}</p>}
        </div>
        <div className="whats-new__footer">
          <span className="whats-new__spacer" />
          <button type="button" className="btn" disabled={busy} onClick={onReview}>
            Review in Settings
          </button>
          <button
            type="button"
            className="btn btn--primary"
            ref={doneRef}
            disabled={busy}
            onClick={() => void done()}
          >
            Done
          </button>
        </div>
      </div>
    </ModalLayer>
  );
}
