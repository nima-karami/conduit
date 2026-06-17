import { useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { IconClose } from '../icons';
import { dismissToast, getToastsSnapshot, subscribeToasts } from '../toast-store';

/**
 * Toast outlet (K2). Portals to document.body so it floats above everything. Surfaces a
 * save FAILURE unmissably — a success raises no toast (the dirty dot clearing is the signal).
 */
export function Toasts() {
  const toasts = useSyncExternalStore(subscribeToasts, getToastsSnapshot, getToastsSnapshot);
  if (typeof document === 'undefined' || toasts.length === 0) return null;
  return createPortal(
    <div className="toasts" role="region" aria-label="Notifications">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`toast toast--${t.variant}`}
          role={t.variant === 'error' ? 'alert' : 'status'}
        >
          <span className="toast__msg">{t.message}</span>
          <button
            type="button"
            className="toast__close"
            aria-label="Dismiss"
            onClick={() => dismissToast(t.id)}
          >
            <IconClose size={12} />
          </button>
        </div>
      ))}
    </div>,
    document.body,
  );
}
