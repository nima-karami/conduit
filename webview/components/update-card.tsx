import type { HostToWebview } from '../../src/protocol';
import { post } from '../bridge';
import { IconClose, IconDownload, IconRefreshCw } from '../icons';

export type UpdateStatus = Extract<HostToWebview, { type: 'updateStatus' }>;

interface UpdateCardProps {
  status: UpdateStatus;
  dismissed: boolean;
  onDismiss: () => void;
}

export function UpdateCard({ status, dismissed, onDismiss }: UpdateCardProps) {
  if (dismissed) return null;
  const s = status.status;

  if (s === 'available' || s === 'downloading') {
    return (
      <div className="update-card">
        <div className="update-card__body">
          <IconDownload size={14} />
          <span className="update-card__text">Updating to v{status.version ?? '?'}…</span>
          <button
            type="button"
            className="update-card__dismiss"
            onClick={onDismiss}
            title="Dismiss"
          >
            <IconClose size={12} />
          </button>
        </div>
        {s === 'downloading' && (
          <div className="update-card__progress">
            <div className="update-card__bar" style={{ width: `${status.percent ?? 0}%` }} />
          </div>
        )}
      </div>
    );
  }

  if (s === 'ready') {
    return (
      <div className="update-card">
        <div className="update-card__body">
          <IconRefreshCw size={14} />
          <span className="update-card__text">v{status.version ?? '?'} ready</span>
          <button
            type="button"
            className="update-card__dismiss"
            onClick={onDismiss}
            title="Dismiss"
          >
            <IconClose size={12} />
          </button>
        </div>
        <button
          type="button"
          className="update-card__action"
          onClick={() => post({ type: 'updateRelaunch' })}
        >
          Relaunch to update
        </button>
      </div>
    );
  }

  return null;
}
