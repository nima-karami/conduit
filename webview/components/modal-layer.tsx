import type { HTMLAttributes, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useOverlayEntry } from '../use-overlay-entry';

export interface ModalLayerProps
  extends Omit<HTMLAttributes<HTMLDivElement>, 'className' | 'children'> {
  /** Scrim click (e.target === e.currentTarget). */
  onDismiss?: () => void;
  /** Escape from the overlay stack, in place of `onDismiss` — for a modal whose Escape steps back
   *  rather than closes. The stack binds keydown in the capture phase, so no inner handler can. */
  onEscape?: () => void;
  backdropClass?: string;
  children: ReactNode;
}

/** A portaled backdrop, stacked by mount order among the app's open modals. */
export function ModalLayer({
  onDismiss,
  onEscape,
  backdropClass = 'modal__backdrop',
  children,
  onClick,
  style,
  ...rest
}: ModalLayerProps) {
  const { depth } = useOverlayEntry('modal', onEscape ?? onDismiss);

  return createPortal(
    <div
      className={backdropClass}
      style={{ zIndex: `calc(var(--layer-modal) + ${Math.max(depth, 0)})`, ...style }}
      onClick={(e) => {
        onClick?.(e);
        if (e.target === e.currentTarget) onDismiss?.();
      }}
      {...rest}
    >
      {children}
    </div>,
    document.body,
  );
}
