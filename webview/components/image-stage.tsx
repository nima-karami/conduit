import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { IconRotate, IconZoomIn, IconZoomOut, IconZoomReset } from '../icons';
import { zoomPercent } from '../image-zoom';
import { type SharedPanZoomState, usePanZoomStage } from '../use-pan-zoom-stage';

/** Rotation lifted to a parent so linked stages rotate together (side-by-side diff). */
export interface SharedRotationState {
  rotation: number;
  setRotation: Dispatch<SetStateAction<number>>;
}

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
  shared,
  sharedRotation,
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
  /** When set, this stage's zoom/pan is linked to siblings sharing the same state. */
  shared?: SharedPanZoomState;
  /** When set, this stage's rotation is linked to siblings sharing the same state. */
  sharedRotation?: SharedRotationState;
}) {
  const [natural, setNatural] = useState<Natural | null>(null);
  const ownRotation = useState(0);
  const rotation = sharedRotation ? sharedRotation.rotation : ownRotation[0];
  const setRotation = sharedRotation ? sharedRotation.setRotation : ownRotation[1];
  const [loadError, setLoadError] = useState(false);

  const rotNatural = natural ? rotatedNatural(natural, rotation) : null;

  const {
    ready,
    stageRef,
    zoom,
    pan,
    pannable,
    zoomIn,
    zoomOut,
    resetView,
    onCoreKeyDown,
    pointerHandlers,
    announce,
    setAnnounce,
    setPan,
  } = usePanZoomStage(rotNatural, { resetKey: src, onReset: () => setRotation(0), shared });

  // Held in a ref so the decode below depends on `src` alone, as it claims to: an inline
  // lambda for onNatural would otherwise re-run it on every parent render, blanking
  // `natural` and making the image drop out and re-decode.
  const onNaturalRef = useRef(onNatural);
  useEffect(() => {
    onNaturalRef.current = onNatural;
  });

  // Decode off-DOM first so the rendered <img> can carry its natural size from its very
  // first layout (spec §3 A4). Reading naturalWidth off the mounted element instead means
  // the browser lays the image out at whatever the source implies — full natural size for
  // a big raster, the container width for an intrinsic-size-less SVG — and paints that
  // before React can fit it (D7/D8).
  // biome-ignore lint/correctness/useExhaustiveDependencies: src change is the reset trigger.
  useEffect(() => {
    setRotation(0);
    setLoadError(false);
    setNatural(null);
    let alive = true;
    const probe = new Image();
    probe.onload = () => {
      if (!alive) return;
      const dims = { w: probe.naturalWidth, h: probe.naturalHeight };
      setNatural(dims);
      onNaturalRef.current?.(dims);
    };
    probe.onerror = () => {
      if (alive) setLoadError(true);
    };
    probe.src = src;
    return () => {
      alive = false;
    };
  }, [src]);

  const rotate = useCallback(() => {
    setRotation((r) => (r + 90) % 360);
    setPan({ x: 0, y: 0 });
    setAnnounce('Rotated 90°');
  }, [setPan, setAnnounce, setRotation]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'r' || e.key === 'R') {
      e.preventDefault();
      rotate();
      return;
    }
    onCoreKeyDown(e);
  };

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
        onKeyDown={onKeyDown}
        {...pointerHandlers}
      >
        {loadError ? (
          <div className="viewer__notice">Could not render image.</div>
        ) : (
          natural && (
            <img
              src={src}
              alt=""
              width={natural.w}
              height={natural.h}
              draggable={false}
              className={`imgstage__img${ready ? ' imgstage__img--ready' : ''}`}
              style={{
                transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom}) rotate(${rotation}deg)`,
                imageRendering: pixelated ? 'pixelated' : 'auto',
              }}
              onError={() => setLoadError(true)}
            />
          )
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
