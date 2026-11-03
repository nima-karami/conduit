import type { HostToWebview } from '../../src/protocol';
import { post } from '../bridge';
import { CHROME_STR, clampPercent } from '../chrome-strings';
import { IconClose, IconDownload, IconRefreshCw } from '../icons';

export type UpdateStatus = Extract<HostToWebview, { type: 'updateStatus' }>;

interface UpdateCardProps {
  status: UpdateStatus;
  dismissed: boolean;
  onDismiss: () => void;
  onWhatsNew: () => void;
}

/** Checking, up to date and error stay Settings → About's business (spec §7 floating updates). */
export function updateCardVisible(status: UpdateStatus | null, dismissed: boolean): boolean {
  if (!status || dismissed) return false;
  return (
    status.status === 'available' || status.status === 'downloading' || status.status === 'ready'
  );
}

/**
 * The one persistent update item in the toast stack. Every state renders the same root element,
 * so a progress tick or the ready swap updates it in place instead of stacking a second card.
 */
export function UpdateCard({ status, dismissed, onDismiss, onWhatsNew }: UpdateCardProps) {
  if (!updateCardVisible(status, dismissed)) return null;
  const s = status.status;
  const pct = clampPercent(status.percent);

  return (
    <div className="update-card" data-update-toast data-update-state={s}>
      <div className="update-card__body">
        {s === 'ready' ? <IconRefreshCw size={14} /> : <IconDownload size={14} />}
        {/* The live text changes only with the lifecycle; the percent sits outside it so a
            download does not re-announce on every tick. */}
        <span className="update-card__text" role="status">
          {s === 'ready'
            ? CHROME_STR.update.ready(status.version)
            : CHROME_STR.update.updating(status.version)}
        </span>
        {s === 'downloading' && (
          <span className="update-card__percent">{CHROME_STR.update.percent(pct)}</span>
        )}
        <button
          type="button"
          className="update-card__dismiss"
          onClick={onDismiss}
          title={CHROME_STR.update.dismiss}
          aria-label={CHROME_STR.update.dismiss}
        >
          <IconClose size={12} />
        </button>
      </div>
      {s === 'downloading' && (
        <div
          className="update-card__progress"
          role="progressbar"
          aria-label={CHROME_STR.update.download}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
        >
          <div className="update-card__bar" style={{ width: `${pct}%` }} />
        </div>
      )}
      {s === 'ready' && (
        <>
          {status.releaseNotes?.trim() && (
            <button type="button" className="update-card__notes" onClick={onWhatsNew}>
              {CHROME_STR.update.whatsNew}
            </button>
          )}
          <button
            type="button"
            className="update-card__action"
            onClick={() => post({ type: 'updateRelaunch' })}
          >
            {CHROME_STR.update.relaunch}
          </button>
        </>
      )}
    </div>
  );
}
