import type { ReactNode } from 'react';
import { useEffect, useRef } from 'react';
import type { Region } from '../../src/layout';

const MIN = 180;
const MAX = 640;
const clamp = (n: number) => Math.min(MAX, Math.max(MIN, n));

export interface DockHandlers {
  isOver: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: () => void;
}

/**
 * Frame around a movable side panel: a drag grip (to re-dock the panel), a resize
 * handle on the center-facing edge, and drop-target behaviour. Width is driven by
 * `widthVar`; resizing sets it live and commits on release.
 */
export function PanelFrame({
  region,
  title,
  widthVar,
  edge,
  onWidthCommit,
  dock,
  children,
}: {
  region: Region;
  title: string;
  widthVar: string; // e.g. '--left-w'
  edge: 'left' | 'right'; // center-facing edge
  onWidthCommit: (width: number) => void;
  dock: DockHandlers;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const resizing = useRef(false);

  useEffect(() => {
    const root = document.documentElement;
    const onMove = (e: MouseEvent) => {
      if (!resizing.current || !ref.current) return;
      e.preventDefault();
      const r = ref.current.getBoundingClientRect();
      const w = edge === 'right' ? e.clientX - r.left : r.right - e.clientX;
      root.style.setProperty(widthVar, `${clamp(w)}px`);
    };
    const onUp = () => {
      if (!resizing.current) return;
      resizing.current = false;
      document.body.classList.remove('resizing');
      const px = parseInt(getComputedStyle(root).getPropertyValue(widthVar), 10);
      if (!Number.isNaN(px)) onWidthCommit(px);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [edge, widthVar, onWidthCommit]);

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    resizing.current = true;
    document.body.classList.add('resizing');
  };

  return (
    <div
      className={`panel panel--${region} ${dock.isOver ? 'panel--droptarget' : ''}`}
      ref={ref}
      style={{ width: `var(${widthVar})` }}
      onDragOver={dock.onDragOver}
      onDrop={(e) => {
        e.preventDefault();
        dock.onDrop();
      }}
    >
      <div
        className="panel__grip"
        draggable
        title={`Drag to move the ${title} panel`}
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = 'move';
          dock.onDragStart();
        }}
        onDragEnd={dock.onDragEnd}
      >
        <span className="panel__griptitle">{title}</span>
        <span className="panel__gripdots">⠿</span>
      </div>
      <div className="panel__body">{children}</div>
      <div
        className={`panel__resize panel__resize--${edge}`}
        onMouseDown={startResize}
        title="Drag to resize"
      />
    </div>
  );
}
