// Responsiveness probe for the stress/load lane. Exposes `window.__conduitPerf` so an e2e
// scenario can measure how the UI holds up under load, between start() and stop(). Mirrors the
// window.__conduit*Perf observation seams (review-view, right-pane); attached unconditionally but
// idle until start(). See docs/specs/2026-07-07-stress-load-testing.md.
//
// The headline metric is MAIN-THREAD LAG: a fixed-interval timer whose drift measures how long the
// main thread was blocked. Unlike requestAnimationFrame (throttled to ~1 fps for a hidden window),
// timers keep full rate under Electron's backgroundThrottling:false, so lag is reliable while the
// lane runs the app hidden. Frame gaps are kept as a coarse gross-stall signal; long tasks
// corroborate lag where the API is available.

import { type PerfInput, type PerfReport, summarizePerf } from '../src/perf-stats';

interface Probe {
  start(label?: string): void;
  stop(): PerfReport;
  /** Emit a native performance mark (visible in the Performance panel; not summarized). */
  mark(name: string): void;
}

const LAG_INTERVAL_MS = 16; // ~60 samples/sec; drift beyond this is main-thread blocking.

let rafId = 0;
let lagTimer: ReturnType<typeof setInterval> | null = null;
let label = 'probe';
let startTime = 0;
let lastFrame = 0;
let lastLag = 0;
let frameDeltas: number[] = [];
let lagSamples: number[] = [];
let longTasks: number[] = [];
let observer: PerformanceObserver | null = null;

// The rAF loop only records the gap since the previous frame — no work of its own.
function tick(t: number): void {
  frameDeltas.push(t - lastFrame);
  lastFrame = t;
  rafId = requestAnimationFrame(tick);
}

// Each timer tick records how far beyond the scheduled interval it actually fired: that excess is
// time the main thread was busy and couldn't service the timer.
function lagTick(): void {
  const now = performance.now();
  lagSamples.push(Math.max(0, now - lastLag - LAG_INTERVAL_MS));
  lastLag = now;
}

function start(l = 'probe'): void {
  label = l;
  frameDeltas = [];
  lagSamples = [];
  longTasks = [];
  startTime = performance.now();
  lastFrame = startTime;
  lastLag = startTime;

  try {
    observer = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) longTasks.push(e.duration);
    });
    observer.observe({ entryTypes: ['longtask'] });
  } catch {
    observer = null; // longtask entry type unavailable — lag still carries the measurement.
  }

  cancelAnimationFrame(rafId);
  rafId = requestAnimationFrame(tick);
  if (lagTimer) clearInterval(lagTimer);
  lagTimer = setInterval(lagTick, LAG_INTERVAL_MS);
}

function stop(): PerfReport {
  const durationMs = performance.now() - startTime;
  cancelAnimationFrame(rafId);
  rafId = 0;
  if (lagTimer) {
    clearInterval(lagTimer);
    lagTimer = null;
  }
  if (observer) {
    for (const e of observer.takeRecords()) longTasks.push(e.duration);
    observer.disconnect();
    observer = null;
  }
  const input: PerfInput = {
    frameDeltas,
    lagSamples,
    longTaskDurations: longTasks,
    durationMs,
  };
  return summarizePerf(label, input);
}

function mark(name: string): void {
  try {
    performance.mark(name);
  } catch {
    /* performance.mark unavailable — a no-op is fine */
  }
}

export function installPerfProbe(): void {
  (window as unknown as { __conduitPerf?: Probe }).__conduitPerf = { start, stop, mark };
}
