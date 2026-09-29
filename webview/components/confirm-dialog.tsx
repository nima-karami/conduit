import { useEffect, useId, useRef } from 'react';
import { useFocusTrap } from '../use-focus-trap';
import { ModalLayer } from './modal-layer';

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
  /** Runs on Cancel, Esc and backdrop, never on the primary or secondary action. An opener that
   * awaits an answer must set it (see dirty-quit-guard plan, ConfirmDialog invariant B1a). */
  onCancel?: () => void;
  onShown?: () => void;
}

export function ConfirmDialog({ state, onClose }: { state: ConfirmState; onClose: () => void }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const { restoreFocus } = useFocusTrap(dialogRef);
  const titleId = useId();
  const messageId = useId();
  const onShownRef = useRef(state.onShown);

  useEffect(() => {
    onShownRef.current?.();
  }, []);

  const cancel = () => {
    state.onCancel?.();
    restoreFocus();
    onClose();
  };

  return (
    <ModalLayer onDismiss={cancel}>
      <div
        ref={dialogRef}
        className="confirm chamfer"
        onClick={(e) => e.stopPropagation()}
        role="alertdialog"
        aria-modal
        aria-labelledby={titleId}
        aria-describedby={messageId}
      >
        <span id={titleId} className="confirm__title">
          {state.title}
        </span>
        <p id={messageId} className="confirm__msg">
          {state.message}
        </p>
        <div className="confirm__actions">
          <button
            className="btn"
            autoFocus={state.focusCancel}
            data-modal-default={state.focusCancel || undefined}
            onClick={cancel}
          >
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
            data-modal-default={!state.focusCancel || undefined}
            onClick={() => {
              state.onConfirm();
              onClose();
            }}
          >
            {state.confirmLabel ?? 'Confirm'}
          </button>
        </div>
      </div>
    </ModalLayer>
  );
}
