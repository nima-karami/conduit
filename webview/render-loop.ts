/**
 * Drive `draw` on every animation frame, pausing while the tab is hidden to save
 * CPU/GPU. `draw` receives the rAF timestamp. Returns an idempotent `stop()` that
 * cancels the pending frame and detaches the visibility listener — call it from an
 * effect cleanup (and, for WebGL, on `webglcontextlost`). Shared by the canvas
 * backgrounds so the loop/visibility plumbing lives in one place.
 */
export function runRenderLoop(draw: (t: number) => void): () => void {
  let running = !document.hidden;
  let raf = 0;
  const tick = (t: number) => {
    draw(t);
    if (running) raf = requestAnimationFrame(tick);
  };
  if (running) raf = requestAnimationFrame(tick);

  const onVis = () => {
    const next = !document.hidden;
    if (next === running) return;
    running = next;
    if (running) raf = requestAnimationFrame(tick);
    else cancelAnimationFrame(raf);
  };
  document.addEventListener('visibilitychange', onVis);

  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    running = false;
    cancelAnimationFrame(raf);
    document.removeEventListener('visibilitychange', onVis);
  };
}
