import { useEffect, useRef } from 'react';
import { ModalLayer } from './modal-layer';

export function QuitScrim() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ref.current?.focus();
    const swallow = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('keydown', swallow, true);
    return () => window.removeEventListener('keydown', swallow, true);
  }, []);

  return (
    <ModalLayer>
      <div ref={ref} className="quit-scrim" role="status" aria-busy="true" tabIndex={-1}>
        Closing…
      </div>
    </ModalLayer>
  );
}
