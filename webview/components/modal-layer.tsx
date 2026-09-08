import type { HTMLAttributes, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useOverlayEntry } from '../use-overlay-entry';

export interface ModalLayerProps
  extends Omit<HTMLAttributes<HTMLDivElement>, 'className' | 'children'> {
  /** Scrim click (e.target === e.currentTarget) + Escape when top. */
  onDismiss?: () => void;
  backdropClass?: string;
  children: ReactNode;
}

/** A portaled backdrop, stacked by mount order among the app's open modals. */
export function ModalLayer({
  onDismiss,
  backdropClass = 'modal__backdrop',
  children,
  onClick,
  style,
  ...rest
}: ModalLayerProps) {
  const { depth } = useOverlayEntry('modal', onDismiss);

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
