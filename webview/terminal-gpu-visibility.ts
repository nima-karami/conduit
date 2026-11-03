// When a pane's WebGL renderer follows its visibility (memory audit 2026-11-03, mem-terminals #2).
// xterm pauses rendering from its own IntersectionObserver on the screen element, and a renderer
// swapped in while paused stays blank until that observer reports the pane visible again. So:
// - hide releases at once, from the commit that hides the pane: xterm has not seen the
//   intersection change yet, so the DOM renderer that takes over still draws its rows, and those
//   rows are what shows in the first frame after the pane reappears;
// - show attaches only once the pane's own observer (created after xterm's, so called after it)
//   reports the pane intersecting, when xterm is no longer paused. Before any report, or with no
//   observer at all, nothing is paused and the attach is immediate.

export interface GpuVisibilityGate {
  /** The pane's visible prop, from the commit that changed it. */
  setWanted(visible: boolean): void;
  /** The pane's IntersectionObserver report on xterm's screen element. */
  intersection(isIntersecting: boolean): void;
}

export function createGpuVisibilityGate(
  initialWanted: boolean,
  apply: (visible: boolean) => void,
): GpuVisibilityGate {
  let wanted = initialWanted;
  let intersecting: boolean | null = null;
  return {
    setWanted(visible) {
      wanted = visible;
      if (!visible) apply(false);
      else if (intersecting !== false) apply(true);
    },
    intersection(isIntersecting) {
      intersecting = isIntersecting;
      if (isIntersecting && wanted) apply(true);
    },
  };
}
