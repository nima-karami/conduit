import type { ReactNode } from 'react';
import { useEffect, useRef } from 'react';
import type { Region } from '../../src/layout';
import { isPanelDragTarget } from '../drag-guard';

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
 * Frame around a movable side panel: a top bar that is itself the re-dock drag surface,
 * a resize handle on the center-facing edge, and drop-target behaviour. Width is driven
 * by `widthVar` (live on resize, committed on release). A panel-move drag starts only
 * from the bar's empty background (see `isPanelDragTarget`), never from a control in it.
 */
export function PanelFrame({
  region,
  title,
  widthVar,
  edge,
  onWidthCommit,
  dock,
  onPanelContextMenu,
  barless = false,
  children,
}: {
  region: Region;
  title: string;
  widthVar: string; // e.g. '--left-w'
  edge: 'left' | 'right'; // center-facing edge
  onWidthCommit: (width: number) => void;
  dock: DockHandlers;
  // Opens the panel show/hide menu. Bound at the panel root, so it must check
  // `e.defaultPrevented` to no-op when a child item menu already handled the event (B1).
  onPanelContextMenu?: (e: React.MouseEvent) => void;
  // No top drag-bar — the child owns its header band and is the panel-move drag surface
  // (via `moveGrip`, like DocTabs), so the header aligns with the center tab strip.
  barless?: boolean;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const resizing = useRef(false);
  // Callers pass a fresh closure each render; as an effect dep it would re-run the effect, and
  // so end the drag, on every render that lands mid-drag.
  const commitRef = useRef(onWidthCommit);
  commitRef.current = onWidthCommit;

  // Every drag must end in a commit: the settings provider only re-writes a width var when the
  // setting changes, so a live width left uncommitted stays out of sync with settings for good.
  useEffect(() => {
    const root = document.documentElement;
    const end = () => {
      if (!resizing.current) return;
      resizing.current = false;
      document.body.classList.remove('resizing');
      const px = parseInt(getComputedStyle(root).getPropertyValue(widthVar), 10);
      if (!Number.isNaN(px)) commitRef.current(px);
    };
    const onMove = (e: MouseEvent) => {
      if (!resizing.current || !ref.current) return;
      // No button held: the mouseup was released outside the window and never reached us.
      if (e.buttons === 0) {
        end();
        return;
      }
      e.preventDefault();
      const r = ref.current.getBoundingClientRect();
      const w = edge === 'right' ? e.clientX - r.left : r.right - e.clientX;
      root.style.setProperty(widthVar, `${clamp(w)}px`);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', end);
    window.addEventListener('blur', end);
    return () => {
      end();
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', end);
      window.removeEventListener('blur', end);
    };
  }, [edge, widthVar]);

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
      onContextMenu={onPanelContextMenu}
      onDragOver={dock.onDragOver}
      onDrop={(e) => {
        e.preventDefault();
        dock.onDrop();
      }}
    >
      {!barless && (
        <div
          className="panel__bar"
          draggable
          aria-label={`Move ${title} panel`}
          onDragStart={(e) => {
            if (!isPanelDragTarget(e.target as Element, e.currentTarget)) {
              e.preventDefault();
              return;
            }
            e.dataTransfer.effectAllowed = 'move';
            dock.onDragStart();
          }}
          onDragEnd={dock.onDragEnd}
        />
      )}
      <div className="panel__body">{children}</div>
      <div
        className={`panel__resize panel__resize--${edge}`}
        onMouseDown={startResize}
        title="Drag to resize"
      />
    </div>
  );
}
