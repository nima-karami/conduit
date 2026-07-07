// Responsiveness statistics for the stress/load lane. Pure + unit-tested so the
// measurement math is trustworthy independent of the renderer probe that feeds it
// (webview/perf-probe.ts). See docs/specs/2026-07-07-stress-load-testing.md.
//
// HIDDEN-WINDOW NOTE: the lane runs the app hidden (CONDUIT_E2E), and Chromium throttles
// requestAnimationFrame to ~1 fps for a non-visible page. So FRAME gaps are only a coarse
// "gross stall" signal (they still catch a >1s freeze). The reliable interactivity metric is
// MAIN-THREAD LAG — the drift of a fixed-interval timer, which backgroundThrottling:false keeps
// running at full rate even while hidden. `lag.totalMs` ≈ cumulative blocking; `lag.maxMs` is the
// worst single stall. Long tasks (>50ms) corroborate it.

/**
 * A frame delta above this (ms) is a dropped/janky frame — more than ~two frames at 60 Hz.
 * A fixed, comparable threshold across machines rather than a per-monitor budget.
 */
export const DROPPED_FRAME_MS = 32;

/** A main-thread lag sample above this (ms) is a perceptible stall. */
export const STALL_MS = 50;

export interface LagStats {
  /** Number of timer-lag samples taken. */
  samples: number;
  /** Worst single stall (ms) — the longest the main thread was blocked between ticks. */
  maxMs: number;
  /** Sum of lag across all samples (ms) — approximates cumulative main-thread blocking. */
  totalMs: number;
  /** Count of samples exceeding {@link STALL_MS}. */
  stalls: number;
}

export interface PerfReport {
  label: string;
  durationMs: number;
  /** Animation frames observed (throttled to ~1 fps while hidden — coarse signal only). */
  frames: number;
  meanFrameMs: number;
  p95FrameMs: number;
  /** Longest gap between frames — catches gross (>1s) stalls even under the hidden-window throttle. */
  maxFrameGapMs: number;
  droppedFrames: number;
  /**
   * Main-thread lag — the reliable interactivity metric under hidden launch.
   */
  lag: LagStats;
  /**
   * Main-thread long tasks (>50 ms, Long Tasks API). Corroborates lag when available.
   */
  longTasks: { count: number; totalMs: number; maxMs: number };
}

export interface PerfInput {
  /** Gaps (ms) between successive animation frames. */
  frameDeltas: number[];
  /** Excess delay (ms) of each fixed-interval timer tick beyond its scheduled interval. */
  lagSamples: number[];
  /** Durations (ms) of observed long tasks. */
  longTaskDurations: number[];
  /** Wall-clock length of the sample window (ms). */
  durationMs: number;
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

/**
 * The p-th percentile (0..1) of `values` using nearest-rank on the sorted array.
 * Empty input → 0. Exported for the unit tests.
 */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil(p * sorted.length);
  const idx = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[idx];
}

/**
 * Reduce a window of raw measurements into a {@link PerfReport}. Pure: the same inputs always
 * produce the same report, so the probe's plumbing can be verified against known arrays.
 */
export function summarizePerf(label: string, input: PerfInput): PerfReport {
  const { frameDeltas, lagSamples, longTaskDurations, durationMs } = input;

  const frames = frameDeltas.length;
  const frameSum = frameDeltas.reduce((a, b) => a + b, 0);
  const maxGap = frames > 0 ? Math.max(...frameDeltas) : 0;

  const lagSum = lagSamples.reduce((a, b) => a + b, 0);
  const lagMax = lagSamples.length > 0 ? Math.max(...lagSamples) : 0;

  const ltTotal = longTaskDurations.reduce((a, b) => a + b, 0);
  const ltMax = longTaskDurations.length > 0 ? Math.max(...longTaskDurations) : 0;

  return {
    label,
    durationMs: round1(durationMs),
    frames,
    meanFrameMs: round1(frames > 0 ? frameSum / frames : 0),
    p95FrameMs: round1(percentile(frameDeltas, 0.95)),
    maxFrameGapMs: round1(maxGap),
    droppedFrames: frameDeltas.filter((d) => d > DROPPED_FRAME_MS).length,
    lag: {
      samples: lagSamples.length,
      maxMs: round1(lagMax),
      totalMs: round1(lagSum),
      stalls: lagSamples.filter((d) => d > STALL_MS).length,
    },
    longTasks: {
      count: longTaskDurations.length,
      totalMs: round1(ltTotal),
      maxMs: round1(ltMax),
    },
  };
}
