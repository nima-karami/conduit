import { useEffect, useRef } from 'react';
import { useSettings } from '../settings';

const MIN = 180;
const MAX = 640;
const clamp = (n: number) => Math.min(MAX, Math.max(MIN, n));

/**
 * Two drag handles on the sidebar|center and center|right seams. Dragging sets
 * the --left-w / --right-w CSS vars live (no React re-render per move); on release
 * the final width is persisted via settings.
 */
export function PanelResizers() {
  const { update } = useSettings();
  const drag = useRef<null | 'left' | 'right'>(null);

  useEffect(() => {
    const root = document.documentElement;
    const onMove = (e: MouseEvent) => {
      if (!drag.current) return;
      e.preventDefault();
      if (drag.current === 'left') root.style.setProperty('--left-w', `${clamp(e.clientX)}px`);
      else root.style.setProperty('--right-w', `${clamp(window.innerWidth - e.clientX)}px`);
    };
    const onUp = () => {
      const side = drag.current;
      if (!side) return;
      drag.current = null;
      document.body.classList.remove('resizing');
      const px = parseInt(getComputedStyle(root).getPropertyValue(side === 'left' ? '--left-w' : '--right-w'), 10);
      if (!Number.isNaN(px)) update(side === 'left' ? { leftWidth: px } : { rightWidth: px });
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
  }, [update]);

  const start = (side: 'left' | 'right') => (e: React.MouseEvent) => {
    e.preventDefault();
    drag.current = side;
    document.body.classList.add('resizing');
  };

  return (
    <>
      <div className="resizer resizer--left" onMouseDown={start('left')} title="Drag to resize" />
      <div className="resizer resizer--right" onMouseDown={start('right')} title="Drag to resize" />
    </>
  );
}
