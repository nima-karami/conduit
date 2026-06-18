import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { IconClose, IconZoomIn, IconZoomOut, IconZoomReset } from '../icons';
import {
  BUTTON_STEP,
  canPan,
  clampPan,
  clampZoom,
  fitScale,
  type Pan,
  panToKeepPointer,
  stepZoom,
  WHEEL_STEP,
  zoomPercent,
} from '../image-zoom';
import { type Size, svgViewBoxSize } from '../svg-viewbox';

// Arrow-key pan step (CSS px per keypress) when zoomed in.
const PAN_KEY_STEP = 56;

/**
 * Fullscreen zoom/pan viewer for a rendered Mermaid SVG. The SVG string is the same
 * one MermaidDiagram already injects under securityLevel:'strict' — no new injection
 * surface. Zoom/pan geometry is reused from image-zoom.ts so it matches the image
 * viewer and stays unit-tested. Every pointer action has a keyboard path.
 */
export function MermaidZoomOverlay({ svgHtml, onClose }: { svgHtml: string; onClose: () => void }) {
  const stageRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [natural, setNatural] = useState<Size>({ w: 0, h: 0 });
  const [pane, setPane] = useState({ w: 0, h: 0 });
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState<Pan>({ x: 0, y: 0 });
  const [userZoomed, setUserZoomed] = useState(false);
  const [announce, setAnnounce] = useState('');

  const hasSize = natural.w > 0 && natural.h > 0 && pane.w > 0;
  const fit = hasSize ? fitScale(natural, pane) : 1;

  // Read the diagram's intrinsic size from its viewBox once injected; fall back to the
  // rendered bounding box when the viewBox is absent/malformed.
  useLayoutEffect(() => {
    const svg = contentRef.current?.querySelector('svg');
    if (!svg) return;
    let size = svgViewBoxSize(svg.getAttribute('viewBox'));
    if (size.w === 0) {
      const r = svg.getBoundingClientRect();
      size = { w: r.width || 1, h: r.height || 1 };
    }
    setNatural(size);
  }, []);

  // Track the stage size for fit + pan bounds.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const measure = () => setPane({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Snap to fit until the user manually zooms (and re-snap on resize).
  useEffect(() => {
    if (userZoomed || !hasSize) return;
    setZoom(fit);
    setPan({ x: 0, y: 0 });
  }, [fit, userZoomed, hasSize]);

  // Lock body scroll while open.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  // Move focus into the dialog on open so keyboard control works immediately.
  useEffect(() => {
    stageRef.current?.focus();
  }, []);

  const applyZoom = useCallback(
    (next: number, keepPointer?: { x: number; y: number }) => {
      if (!hasSize) return;
      const clamped = clampZoom(next, fit);
      setUserZoomed(true);
      setZoom(clamped);
      setPan((p) => {
        const repositioned = keepPointer ? panToKeepPointer(p, keepPointer, zoom, clamped) : p;
        return clampPan(repositioned, natural, pane, clamped);
      });
      setAnnounce(`Zoom ${zoomPercent(clamped)}`);
    },
    [hasSize, fit, natural, pane, zoom],
  );

  const resetView = useCallback(() => {
    setUserZoomed(false);
    setPan({ x: 0, y: 0 });
    if (hasSize) {
      setZoom(fit);
      setAnnounce(`Zoom ${zoomPercent(fit)} (fit)`);
    }
  }, [hasSize, fit]);

  const panBy = useCallback(
    (dx: number, dy: number) => {
      if (!hasSize) return;
      setPan((p) => clampPan({ x: p.x + dx, y: p.y + dy }, natural, pane, zoom));
    },
    [hasSize, natural, pane, zoom],
  );

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const dir = e.deltaY < 0 ? 1 : -1;
    const rect = stageRef.current?.getBoundingClientRect();
    const pointer = rect
      ? { x: e.clientX - rect.left - rect.width / 2, y: e.clientY - rect.top - rect.height / 2 }
      : undefined;
    applyZoom(stepZoom(zoom, dir, WHEEL_STEP, fit), pointer);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
      return;
    }
    const mod = e.metaKey || e.ctrlKey;
    if (mod && (e.key === '+' || e.key === '=')) {
      e.preventDefault();
      applyZoom(stepZoom(zoom, 1, BUTTON_STEP, fit));
      return;
    }
    if (mod && (e.key === '-' || e.key === '_')) {
      e.preventDefault();
      applyZoom(stepZoom(zoom, -1, BUTTON_STEP, fit));
      return;
    }
    if (mod && e.key === '0') {
      e.preventDefault();
      resetView();
      return;
    }
    if (!hasSize || !canPan(natural, pane, zoom)) return;
    const arrows: Record<string, [number, number]> = {
      ArrowLeft: [PAN_KEY_STEP, 0],
      ArrowRight: [-PAN_KEY_STEP, 0],
      ArrowUp: [0, PAN_KEY_STEP],
      ArrowDown: [0, -PAN_KEY_STEP],
    };
    const delta = arrows[e.key];
    if (delta) {
      e.preventDefault();
      panBy(delta[0], delta[1]);
    }
  };

  const dragRef = useRef<{ id: number; x: number; y: number } | null>(null);
  const pannable = hasSize ? canPan(natural, pane, zoom) : false;
  const onPointerDown = (e: React.PointerEvent) => {
    if (!pannable) return;
    dragRef.current = { id: e.pointerId, x: e.clientX, y: e.clientY };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d || d.id !== e.pointerId) return;
    panBy(e.clientX - d.x, e.clientY - d.y);
    dragRef.current = { id: e.pointerId, x: e.clientX, y: e.clientY };
  };
  const endDrag = (e: React.PointerEvent) => {
    if (dragRef.current?.id === e.pointerId) dragRef.current = null;
  };

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: backdrop close is an enhancement; Esc + the close button are the keyboard paths.
    <div className="mermaid-zoom__backdrop" onClick={onClose}>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: dialog surface stops backdrop-close propagation; interaction is keyboard-served via the focusable stage. */}
      <div
        className="mermaid-zoom"
        role="dialog"
        aria-modal="true"
        aria-label="Diagram viewer"
        onClick={(e) => e.stopPropagation()}
      >
        {/* biome-ignore lint/a11y/noStaticElementInteractions: pannable surface; all actions have keyboard paths via onKeyDown. */}
        <div
          ref={stageRef}
          className={`mermaid-zoom__stage${pannable ? ' mermaid-zoom__stage--pannable' : ''}`}
          tabIndex={0}
          onWheel={onWheel}
          onKeyDown={onKeyDown}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          <div
            ref={contentRef}
            className="mermaid-zoom__content"
            style={{
              width: natural.w || undefined,
              height: natural.h || undefined,
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
            }}
            // Same strict-mode SVG string MermaidDiagram already renders.
            // biome-ignore lint/security/noDangerouslySetInnerHtml: mermaid SVG under securityLevel:'strict'
            dangerouslySetInnerHTML={{ __html: svgHtml }}
          />
        </div>
        <div className="mermaid-zoom__controls" role="toolbar" aria-label="Diagram controls">
          <button
            type="button"
            className="mermaid-zoom__btn"
            aria-label="Zoom out"
            onClick={() => applyZoom(stepZoom(zoom, -1, BUTTON_STEP, fit))}
          >
            <IconZoomOut size={15} />
          </button>
          <span className="mermaid-zoom__pct" aria-hidden="true">
            {zoomPercent(zoom)}
          </span>
          <button
            type="button"
            className="mermaid-zoom__btn"
            aria-label="Zoom in"
            onClick={() => applyZoom(stepZoom(zoom, 1, BUTTON_STEP, fit))}
          >
            <IconZoomIn size={15} />
          </button>
          <button
            type="button"
            className="mermaid-zoom__btn"
            aria-label="Reset zoom to fit"
            onClick={resetView}
          >
            <IconZoomReset size={15} />
          </button>
          <button
            type="button"
            className="mermaid-zoom__btn"
            aria-label="Close diagram viewer"
            onClick={onClose}
          >
            <IconClose size={15} />
          </button>
        </div>
        <div className="sr-only" aria-live="polite">
          {announce}
        </div>
      </div>
    </div>
  );
}
