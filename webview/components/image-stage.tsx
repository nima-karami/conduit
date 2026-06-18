import { useCallback, useEffect, useRef, useState } from 'react';
import { IconRotate, IconZoomIn, IconZoomOut, IconZoomReset } from '../icons';
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

// Arrow-key pan step (CSS px per keypress) when zoomed in.
const PAN_KEY_STEP = 48;

interface Natural {
  w: number;
  h: number;
}

/** Swap w/h for 90°/270° so pan/fit reason about the on-screen (rotated) bounds. */
function rotatedNatural(n: Natural, rotation: number): Natural {
  return rotation % 180 === 0 ? n : { w: n.h, h: n.w };
}

/**
 * A zoomable / pannable / rotatable image surface. Used standalone (ImageViewer) and
 * once per side in the image diff. All pointer actions have a keyboard pathway
 * (Ctrl/Cmd +/-/0, arrows, R) per spec §7. Zoom/rotate state is local and resets when
 * `src` changes (per-document, not persisted).
 */
export function ImageStage({
  src,
  label,
  caption,
  showControls = true,
  className,
  onNatural,
}: {
  src: string;
  /** Accessible name for the image region (filename / "Original" / "Changed"). */
  label: string;
  /** Right-aligned footer text (dimensions · size). Zoom % is appended by the stage. */
  caption?: string;
  showControls?: boolean;
  className?: string;
  /** Fired once the image decodes with its natural pixel dimensions. */
  onNatural?: (dims: { w: number; h: number }) => void;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const [natural, setNatural] = useState<Natural | null>(null);
  const [pane, setPane] = useState({ w: 0, h: 0 });
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState<Pan>({ x: 0, y: 0 });
  const [rotation, setRotation] = useState(0);
  const [loadError, setLoadError] = useState(false);
  // User has taken manual control of zoom; until then we track fit-to-pane on resize.
  const [userZoomed, setUserZoomed] = useState(false);
  const [announce, setAnnounce] = useState('');

  const rotNatural = natural ? rotatedNatural(natural, rotation) : null;
  const fit = rotNatural ? fitScale(rotNatural, pane) : 1;

  // Reset all view state whenever the image source changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: src change is the reset trigger.
  useEffect(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setRotation(0);
    setUserZoomed(false);
    setLoadError(false);
    // natural is re-captured by the img onLoad/ref for the new src; not nulled here to
    // avoid a clobber race where the reset effect runs after the ref already set it.
  }, [src]);

  // Track the pane size so fit + pan bounds stay correct across layout changes.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const measure = () => setPane({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // While the user hasn't manually zoomed, snap to fit (and re-snap on resize/rotate).
  useEffect(() => {
    if (userZoomed || !rotNatural || pane.w === 0) return;
    setZoom(fit);
    setPan({ x: 0, y: 0 });
  }, [fit, userZoomed, rotNatural, pane.w]);

  const applyZoom = useCallback(
    (next: number, keepPointer?: { x: number; y: number }) => {
      if (!rotNatural) return;
      const clamped = clampZoom(next, fit);
      setUserZoomed(true);
      setZoom(clamped);
      setPan((p) => {
        const repositioned = keepPointer ? panToKeepPointer(p, keepPointer, zoom, clamped) : p;
        return clampPan(repositioned, rotNatural, pane, clamped);
      });
      setAnnounce(`Zoom ${zoomPercent(clamped)}`);
    },
    [rotNatural, fit, pane, zoom],
  );

  const resetView = useCallback(() => {
    setUserZoomed(false);
    setRotation(0);
    setPan({ x: 0, y: 0 });
    if (rotNatural) {
      const f = fitScale(natural ?? { w: 1, h: 1 }, pane);
      setZoom(f);
      setAnnounce(`Zoom ${zoomPercent(f)} (fit)`);
    }
  }, [rotNatural, natural, pane]);

  const rotate = useCallback(() => {
    setRotation((r) => (r + 90) % 360);
    setPan({ x: 0, y: 0 });
    setAnnounce('Rotated 90°');
  }, []);

  const panBy = useCallback(
    (dx: number, dy: number) => {
      if (!rotNatural) return;
      setPan((p) => clampPan({ x: p.x + dx, y: p.y + dy }, rotNatural, pane, zoom));
    },
    [rotNatural, pane, zoom],
  );

  const onWheel = (e: React.WheelEvent) => {
    // Wheel zooms (Ctrl/Cmd optional — matches VS Code). Prevent the page from scrolling.
    e.preventDefault();
    const dir = e.deltaY < 0 ? 1 : -1;
    const rect = stageRef.current?.getBoundingClientRect();
    const pointer = rect
      ? { x: e.clientX - rect.left - rect.width / 2, y: e.clientY - rect.top - rect.height / 2 }
      : undefined;
    applyZoom(stepZoom(zoom, dir, WHEEL_STEP, fit), pointer);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
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
    if (e.key === 'r' || e.key === 'R') {
      e.preventDefault();
      rotate();
      return;
    }
    if (!rotNatural || !canPan(rotNatural, pane, zoom)) return;
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

  // Pointer-drag panning (pointer events so mouse + pen + touch all work).
  const dragRef = useRef<{ id: number; x: number; y: number } | null>(null);
  const pannable = rotNatural ? canPan(rotNatural, pane, zoom) : false;
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

  // Capture natural dimensions. data: URLs (every image here) often decode before React
  // attaches onLoad, so onLoad can never fire — read naturalWidth eagerly via the ref
  // when the element is already complete, and again on onLoad for the non-cached case.
  const captureNatural = useCallback(
    (img: HTMLImageElement | null) => {
      if (!img || !img.complete || img.naturalWidth === 0) return;
      const dims = { w: img.naturalWidth, h: img.naturalHeight };
      setNatural((prev) => (prev?.w === dims.w && prev?.h === dims.h ? prev : dims));
      onNatural?.(dims);
    },
    [onNatural],
  );

  // pixelated above 1× natural — pixel inspection is the point of zooming in (spec §5).
  const pixelated = zoom > 1;
  const footer = `${caption ? `${caption} · ` : ''}${zoomPercent(zoom)}`;

  return (
    <div className={`imgstage${className ? ` ${className}` : ''}`}>
      <div
        ref={stageRef}
        className={`imgstage__stage${pannable ? ' imgstage__stage--pannable' : ''}`}
        role="img"
        aria-label={label}
        tabIndex={0}
        onWheel={onWheel}
        onKeyDown={onKeyDown}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        {loadError ? (
          <div className="viewer__notice">Could not render image.</div>
        ) : (
          <img
            ref={captureNatural}
            src={src}
            alt=""
            draggable={false}
            className="imgstage__img"
            style={{
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom}) rotate(${rotation}deg)`,
              imageRendering: pixelated ? 'pixelated' : 'auto',
            }}
            onLoad={(e) => captureNatural(e.currentTarget)}
            onError={() => setLoadError(true)}
          />
        )}
      </div>
      {showControls && !loadError && (
        <div className="imgstage__controls" role="toolbar" aria-label={`Image controls: ${label}`}>
          <button
            type="button"
            className="imgstage__btn"
            aria-label="Zoom out"
            onClick={() => applyZoom(stepZoom(zoom, -1, BUTTON_STEP, fit))}
          >
            <IconZoomOut size={14} />
          </button>
          <span className="imgstage__zoom" aria-hidden="true">
            {zoomPercent(zoom)}
          </span>
          <button
            type="button"
            className="imgstage__btn"
            aria-label="Zoom in"
            onClick={() => applyZoom(stepZoom(zoom, 1, BUTTON_STEP, fit))}
          >
            <IconZoomIn size={14} />
          </button>
          <button
            type="button"
            className="imgstage__btn"
            aria-label="Reset zoom to fit"
            onClick={resetView}
          >
            <IconZoomReset size={14} />
          </button>
          <button
            type="button"
            className="imgstage__btn"
            aria-label="Rotate 90 degrees"
            onClick={rotate}
          >
            <IconRotate size={14} />
          </button>
        </div>
      )}
      {caption !== undefined && !loadError && <div className="imgstage__caption">{footer}</div>}
      <div className="sr-only" aria-live="polite">
        {announce}
      </div>
    </div>
  );
}
