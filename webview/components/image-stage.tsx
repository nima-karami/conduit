import { useCallback, useEffect, useState } from 'react';
import { IconRotate, IconZoomIn, IconZoomOut, IconZoomReset } from '../icons';
import { zoomPercent } from '../image-zoom';
import { usePanZoomStage } from '../use-pan-zoom-stage';

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
 * once per side in the image diff. The zoom/pan/keyboard/pointer interaction is the
 * shared `usePanZoomStage` hook (also used by the Mermaid zoom overlay); this component
 * adds the image-specific parts: rotation, natural-size capture, and load errors. All
 * pointer actions have a keyboard pathway (Ctrl/Cmd +/-/0, arrows, R) per spec §7.
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
  const [natural, setNatural] = useState<Natural | null>(null);
  const [rotation, setRotation] = useState(0);
  const [loadError, setLoadError] = useState(false);

  const rotNatural = natural ? rotatedNatural(natural, rotation) : null;

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
    setAnnounce,
    setPan,
  } = usePanZoomStage(rotNatural, { resetKey: src, onReset: () => setRotation(0) });

  // Image-specific reset on a new src (the hook resets zoom/pan/userZoomed via resetKey).
  // biome-ignore lint/correctness/useExhaustiveDependencies: src change is the reset trigger.
  useEffect(() => {
    setRotation(0);
    setLoadError(false);
    // natural is re-captured by the img onLoad/ref for the new src.
  }, [src]);

  const rotate = useCallback(() => {
    setRotation((r) => (r + 90) % 360);
    setPan({ x: 0, y: 0 });
    setAnnounce('Rotated 90°');
  }, [setPan, setAnnounce]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'r' || e.key === 'R') {
      e.preventDefault();
      rotate();
      return;
    }
    onCoreKeyDown(e);
  };

  // Capture natural dimensions. data: URLs (every image here) often decode before React
  // attaches onLoad, so onLoad can never fire — read naturalWidth eagerly via the ref
  // when the element is already complete, and again on onLoad for the non-cached case.
  const captureNatural = useCallback(
    (img: HTMLImageElement | null) => {
      if (!img?.complete || img.naturalWidth === 0) return;
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
        {...pointerHandlers}
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
          <button type="button" className="imgstage__btn" aria-label="Zoom out" onClick={zoomOut}>
            <IconZoomOut size={14} />
          </button>
          <span className="imgstage__zoom" aria-hidden="true">
            {zoomPercent(zoom)}
          </span>
          <button type="button" className="imgstage__btn" aria-label="Zoom in" onClick={zoomIn}>
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
