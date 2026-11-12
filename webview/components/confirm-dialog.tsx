import { useEffect, useId, useRef } from 'react';
import { IconClose } from '../icons';
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
  /** Omit the Cancel button; pair with `showClose` + `focusClose` when the X is enough. */
  hideCancel?: boolean;
  /** Top-right close control; Escape and click resolve via `onCancel` like Cancel. */
  showClose?: boolean;
  /** When true, the close button receives autoFocus instead of Cancel or Confirm. */
  focusClose?: boolean;
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

  // Shown means painted: a frame after mount runs before the paint, the second one after it.
  useEffect(() => {
    let outer = 0;
    let inner = 0;
    outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => onShownRef.current?.());
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, []);

  const cancel = () => {
    state.onCancel?.();
    restoreFocus();
    onClose();
  };

  const showCancel = !state.hideCancel;
  const focusClose = !!state.focusClose;
  const focusCancel = !!state.focusCancel && showCancel;
  const focusPrimary = !focusCancel && !focusClose;

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
        <div className="confirm__head">
          <span id={titleId} className="confirm__title">
            {state.title}
          </span>
          {state.showClose && (
            <button
              type="button"
              className="iconbtn"
              aria-label="Close"
              autoFocus={focusClose}
              data-modal-default={focusClose || undefined}
              onClick={cancel}
            >
              <IconClose size={15} />
            </button>
          )}
        </div>
        <p id={messageId} className="confirm__msg">
          {state.message}
        </p>
        <div className="confirm__actions">
          {showCancel && (
            <button
              type="button"
              className="btn"
              autoFocus={focusCancel}
              data-modal-default={focusCancel || undefined}
              onClick={cancel}
            >
              Cancel
            </button>
          )}
          {state.secondaryLabel && state.onSecondary && (
            <button
              type="button"
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
            type="button"
            className={`btn ${state.danger ? 'btn--danger' : 'btn--primary'}`}
            autoFocus={focusPrimary}
            data-modal-default={focusPrimary || undefined}
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
