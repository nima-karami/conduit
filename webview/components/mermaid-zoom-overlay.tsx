import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { IconClose, IconZoomIn, IconZoomOut, IconZoomReset } from '../icons';
import { type Size, svgViewBoxSize } from '../svg-viewbox';
import { usePanZoomStage } from '../use-pan-zoom-stage';

/**
 * Fullscreen zoom/pan viewer for a rendered Mermaid SVG. The SVG string is the same
 * one MermaidDiagram already injects under securityLevel:'strict' — no new injection
 * surface. The zoom/pan interaction is the shared `usePanZoomStage` hook (same one the
 * image viewer uses); this component only adds the modal chrome: backdrop, Esc-to-close,
 * focus + scroll-lock, and the SVG sizing.
 */
export function MermaidZoomOverlay({ svgHtml, onClose }: { svgHtml: string; onClose: () => void }) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [natural, setNatural] = useState<Size>({ w: 0, h: 0 });

  const {
    stageRef,
    zoom,
    pan,
    pannable,
    zoomIn,
    zoomOut,
    resetView,
    onWheel,
    onCoreKeyDown,
    pointerHandlers,
    announce,
  } = usePanZoomStage(natural.w > 0 ? natural : null);

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
  }, [stageRef]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
      return;
    }
    onCoreKeyDown(e);
  };

  return (
    // Backdrop-click close is an enhancement; Esc + the close button are the keyboard
    // paths. (a11y lint group is disabled repo-wide.)
    <div className="mermaid-zoom__backdrop" onClick={onClose}>
      <div
        className="mermaid-zoom"
        role="dialog"
        aria-modal="true"
        aria-label="Diagram viewer"
        onClick={(e) => e.stopPropagation()}
      >
        <div
          ref={stageRef}
          className={`mermaid-zoom__stage${pannable ? ' mermaid-zoom__stage--pannable' : ''}`}
          tabIndex={0}
          onWheel={onWheel}
          onKeyDown={onKeyDown}
          {...pointerHandlers}
        >
          <div
            ref={contentRef}
            className="mermaid-zoom__content"
            style={{
              width: natural.w ? natural.w * zoom : undefined,
              height: natural.h ? natural.h * zoom : undefined,
              transform: `translate(${pan.x}px, ${pan.y}px)`,
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
            onClick={zoomOut}
          >
            <IconZoomOut size={15} />
          </button>
          <span className="mermaid-zoom__pct" aria-hidden="true">
            {`${Math.round(zoom * 100)}%`}
          </span>
          <button type="button" className="mermaid-zoom__btn" aria-label="Zoom in" onClick={zoomIn}>
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
