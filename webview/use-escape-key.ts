import { useEffect } from 'react';

/**
 * Invoke `onClose` whenever Escape is pressed, listening on `window` so it fires
 * even when focus has left the triggering element. For a SURFACE's own Escape (Review, the
 * history detail, the board) — never an overlay's: a menu or dialog registers on the overlay
 * stack (`useOverlayEntry` / `Popover` / `ModalLayer`), whose capture-phase listener stops the
 * event before it reaches this one. A menu dismissing itself here fires alongside the surface
 * behind it.
 */
export function useEscapeKey(onClose: () => void): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
}
