export const EDITOR_GROUP_MIN_PX = 240;

const RATIO_MIN = 0.15;
const RATIO_MAX = 0.85;
const STEP_PX = 16;
const STEP_SHIFT_PX = 64;

type StepKey = 'ArrowLeft' | 'ArrowRight' | 'Home' | 'End';

function bounds(widthPx: number): [number, number] | null {
  if (!(widthPx >= 2 * EDITOR_GROUP_MIN_PX)) return null;
  // The persisted range caps a wide pane too, so a committed ratio survives the load-time coerce.
  return [
    Math.max(RATIO_MIN, EDITOR_GROUP_MIN_PX / widthPx),
    Math.min(RATIO_MAX, (widthPx - EDITOR_GROUP_MIN_PX) / widthPx),
  ];
}

/** Clamp so neither side < min when width ≥ 2·min; below that only to [0.15, 0.85] (spec §2.6 narrow). */
export function clampSplitRatio(ratio: number, widthPx: number): number {
  const [lo, hi] = bounds(widthPx) ?? [RATIO_MIN, RATIO_MAX];
  return Math.min(hi, Math.max(lo, ratio));
}

export function stepSplitRatio(
  ratio: number,
  widthPx: number,
  key: StepKey,
  shift: boolean,
): number {
  const b = bounds(widthPx);
  if (!b) return ratio;
  if (key === 'Home') return b[0];
  if (key === 'End') return b[1];
  const px = (shift ? STEP_SHIFT_PX : STEP_PX) * (key === 'ArrowLeft' ? -1 : 1);
  return clampSplitRatio(ratio + px / widthPx, widthPx);
}
