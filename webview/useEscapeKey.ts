import { useEffect } from 'react';

/**
 * Invoke `onClose` whenever Escape is pressed, listening on `window` so it fires
 * even when focus has left the triggering element. Shared by modals/overlays.
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
