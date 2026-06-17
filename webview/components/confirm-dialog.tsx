import { useEffect, useRef } from 'react';

export interface ConfirmState {
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  /** Optional second action rendered as a middle button between Cancel and the
   * primary Confirm button. When absent the dialog is 2-way (unchanged). */
  secondaryLabel?: string;
  onSecondary?: () => void;
  /**
   * When true, the Cancel button receives autoFocus instead of the primary
   * Confirm button — making Cancel the safe keyboard default (Enter = cancel).
   * Used for destructive confirms where an accidental Enter must not proceed
   * (e.g. the quit-guard dialog, W2).
   */
  focusCancel?: boolean;
}

export function ConfirmDialog({ state, onClose }: { state: ConfirmState; onClose: () => void }) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      } else if (e.key === 'Enter') {
        // If the Cancel button is focused, native button semantics will handle
        // the click (calling onClose). Don't also fire onConfirm here.
        if (cancelRef.current && document.activeElement === cancelRef.current) return;
        state.onConfirm();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [state, onClose]);

  return (
    <div className="modal__backdrop" onClick={onClose}>
      <div className="confirm" onClick={(e) => e.stopPropagation()} role="alertdialog">
        <span className="confirm__title">{state.title}</span>
        <p className="confirm__msg">{state.message}</p>
        <div className="confirm__actions">
          <button ref={cancelRef} className="btn" autoFocus={state.focusCancel} onClick={onClose}>
            Cancel
          </button>
          {state.secondaryLabel && state.onSecondary && (
            <button
              className="btn"
              onClick={() => {
                state.onSecondary?.();
                onClose();
              }}
            >
              {state.secondaryLabel}
            </button>
          )}
          <button
            className={`btn ${state.danger ? 'btn--danger' : 'btn--primary'}`}
            autoFocus={!state.focusCancel}
            onClick={() => {
              state.onConfirm();
              onClose();
            }}
          >
            {state.confirmLabel ?? 'Confirm'}
          </button>
        </div>
      </div>
    </div>
  );
}
