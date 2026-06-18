import { useCallback, useEffect, useRef, useState } from 'react';
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
} from './image-zoom';

// Arrow-key pan step (CSS px per keypress) when zoomed in.
const PAN_KEY_STEP = 48;

interface Size {
  w: number;
  h: number;
}

/**
 * Shared zoom/pan/fit state machine for a centered, transformable surface — used by
 * both the image viewer (`ImageStage`, over an `<img>`) and the Mermaid zoom overlay
 * (over an SVG). The pure geometry lives in `image-zoom.ts`; this hook is the React
 * orchestration above it (pane measurement, snap-to-fit, wheel/keyboard/pointer-drag),
 * so the interaction layer exists once instead of being copied per surface.
 *
 * `natural` is the content's intrinsic size already adjusted for any rotation by the
 * caller (null until known). `resetKey` resets zoom/pan when it changes (e.g. a new
 * image src); `onReset` runs inside reset-to-fit so a caller can clear extra view
 * state (e.g. rotation).
 */
export function usePanZoomStage(
  natural: Size | null,
  opts: { resetKey?: unknown; onReset?: () => void } = {},
) {
  const { resetKey, onReset } = opts;
  const stageRef = useRef<HTMLDivElement>(null);
  const [pane, setPane] = useState({ w: 0, h: 0 });
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState<Pan>({ x: 0, y: 0 });
  const [userZoomed, setUserZoomed] = useState(false);
  const [announce, setAnnounce] = useState('');

  const hasSize = !!natural && natural.w > 0 && natural.h > 0 && pane.w > 0;
  const fit = hasSize ? fitScale(natural, pane) : 1;

  // Reset the view when the content identity changes (image src; the overlay mounts
  // fresh per open and omits this).
  // biome-ignore lint/correctness/useExhaustiveDependencies: resetKey is the reset trigger
  useEffect(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setUserZoomed(false);
  }, [resetKey]);

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

  // Snap to fit until the user manually zooms (and re-snap on resize/rotate).
  useEffect(() => {
    if (userZoomed || !hasSize) return;
    setZoom(fit);
    setPan({ x: 0, y: 0 });
  }, [fit, userZoomed, hasSize]);

  const applyZoom = useCallback(
    (next: number, keepPointer?: { x: number; y: number }) => {
      if (!hasSize || !natural) return;
      const clamped = clampZoom(next, fit);
      setUserZoomed(true);
      setZoom(clamped);
      setPan((p) => {
        const repositioned = keepPointer ? panToKeepPointer(p, keepPointer, zoom, clamped) : p;
        return clampPan(repositioned, natural, pane, clamped);
      });
      setAnnounce(`Zoom ${zoomPercent(clamped)}`);
    },
    [hasSize, natural, fit, pane, zoom],
  );

  const resetView = useCallback(() => {
    onReset?.();
    setUserZoomed(false);
    setPan({ x: 0, y: 0 });
    if (hasSize) {
      setZoom(fit);
      setAnnounce(`Zoom ${zoomPercent(fit)} (fit)`);
    }
  }, [hasSize, fit, onReset]);

  const panBy = useCallback(
    (dx: number, dy: number) => {
      if (!hasSize || !natural) return;
      setPan((p) => clampPan({ x: p.x + dx, y: p.y + dy }, natural, pane, zoom));
    },
    [hasSize, natural, pane, zoom],
  );

  // Button-step zoom (coarse) — convenience so callers don't re-derive stepZoom/fit.
  const zoomIn = useCallback(
    () => applyZoom(stepZoom(zoom, 1, BUTTON_STEP, fit)),
    [applyZoom, zoom, fit],
  );
  const zoomOut = useCallback(
    () => applyZoom(stepZoom(zoom, -1, BUTTON_STEP, fit)),
    [applyZoom, zoom, fit],
  );

  const onWheel = useCallback(
    (e: React.WheelEvent) => {
      e.preventDefault();
      const dir = e.deltaY < 0 ? 1 : -1;
      const rect = stageRef.current?.getBoundingClientRect();
      const pointer = rect
        ? { x: e.clientX - rect.left - rect.width / 2, y: e.clientY - rect.top - rect.height / 2 }
        : undefined;
      applyZoom(stepZoom(zoom, dir, WHEEL_STEP, fit), pointer);
    },
    [applyZoom, zoom, fit],
  );

  /** Handle the shared keys (Ctrl/Cmd +/-/0, arrow-pan). Returns true if it consumed
   *  the event so a caller can add its own keys (rotate, Esc) around it. */
  const onCoreKeyDown = useCallback(
    (e: React.KeyboardEvent): boolean => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && (e.key === '+' || e.key === '=')) {
        e.preventDefault();
        applyZoom(stepZoom(zoom, 1, BUTTON_STEP, fit));
        return true;
      }
      if (mod && (e.key === '-' || e.key === '_')) {
        e.preventDefault();
        applyZoom(stepZoom(zoom, -1, BUTTON_STEP, fit));
        return true;
      }
      if (mod && e.key === '0') {
        e.preventDefault();
        resetView();
        return true;
      }
      if (!hasSize || !natural || !canPan(natural, pane, zoom)) return false;
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
        return true;
      }
      return false;
    },
    [applyZoom, resetView, panBy, zoom, fit, hasSize, natural, pane],
  );

  const dragRef = useRef<{ id: number; x: number; y: number } | null>(null);
  const pannable = hasSize && natural ? canPan(natural, pane, zoom) : false;
  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (!pannable) return;
      dragRef.current = { id: e.pointerId, x: e.clientX, y: e.clientY };
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    [pannable],
  );
  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const d = dragRef.current;
      if (!d || d.id !== e.pointerId) return;
      panBy(e.clientX - d.x, e.clientY - d.y);
      dragRef.current = { id: e.pointerId, x: e.clientX, y: e.clientY };
    },
    [panBy],
  );
  const endDrag = useCallback((e: React.PointerEvent) => {
    if (dragRef.current?.id === e.pointerId) dragRef.current = null;
  }, []);

  return {
    stageRef,
    zoom,
    pan,
    pannable,
    zoomIn,
    zoomOut,
    resetView,
    onWheel,
    onCoreKeyDown,
    pointerHandlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: endDrag,
      onPointerCancel: endDrag,
    },
    announce,
    setAnnounce,
    setPan,
  };
}
