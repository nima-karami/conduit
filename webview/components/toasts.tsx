import { type ReactNode, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { IconClose } from '../icons';
import { dismissToast, getToastsSnapshot, subscribeToasts } from '../toast-store';
import { useWorkbenchChromeState } from '../workbench-chrome-state';
import { UpdateCard } from './update-card';

/**
 * The window's one floating stack (K2; sidebar-agent-tree spec §7 floating updates). Portals to
 * document.body so it floats above everything and never shifts layout. Docked cards (`children`,
 * e.g. the approval card) sit on top, transient toasts below them, and the persistent update item
 * last, nearest the anchor. The outlet stays mounted even when empty: a live region that exists
 * before its message arrives is the one assistive tech reliably announces.
 */
export function Toasts({ children }: { children?: ReactNode }) {
  const toasts = useSyncExternalStore(subscribeToasts, getToastsSnapshot, getToastsSnapshot);
  const { update } = useWorkbenchChromeState();
  if (typeof document === 'undefined') return null;
  return createPortal(
    <div className="toasts" role="region" aria-label="Notifications" data-toast-stack>
      {children}
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`toast toast--${t.variant}`}
          role={t.variant === 'error' ? 'alert' : 'status'}
        >
          <span className="toast__msg">
            {t.message}
            {t.code && (
              <>
                {' '}
                <code className="toast__code">{t.code}</code>
              </>
            )}
          </span>
          {t.action && (
            <button
              type="button"
              className="toast__action"
              onClick={() => {
                t.action?.run();
                dismissToast(t.id);
              }}
            >
              {t.action.label}
            </button>
          )}
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
      {update.status && (
        <UpdateCard
          key="update"
          status={update.status}
          dismissed={update.dismissed}
          onDismiss={update.dismiss}
        />
      )}
    </div>,
    document.body,
  );
}
