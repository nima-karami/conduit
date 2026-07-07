import { describe, expect, it } from 'vitest';
import { DROPPED_FRAME_MS, percentile, STALL_MS, summarizePerf } from '../../src/perf-stats';

const input = (over = {}) => ({
  frameDeltas: [],
  lagSamples: [],
  longTaskDurations: [],
  durationMs: 0,
  ...over,
});

describe('percentile', () => {
  it('returns 0 for an empty array', () => {
    expect(percentile([], 0.95)).toBe(0);
  });

  it('uses nearest-rank on the sorted array (order-independent)', () => {
    const vals = [50, 10, 30, 20, 40];
    expect(percentile(vals, 0.95)).toBe(50); // ceil(0.95*5)=5 -> last
    expect(percentile(vals, 0.5)).toBe(30); // ceil(0.5*5)=3 -> middle
    expect(percentile(vals, 0.2)).toBe(10); // ceil(0.2*5)=1 -> first
  });

  it('clamps p=0 and p=1 to first and last', () => {
    expect(percentile([5, 1, 9], 0)).toBe(1);
    expect(percentile([5, 1, 9], 1)).toBe(9);
  });
});

describe('summarizePerf', () => {
  it('computes frame stats from a known delta array', () => {
    const deltas = [16.7, 16.7, 16.7, 16.7, 100];
    const r = summarizePerf('t', input({ frameDeltas: deltas, durationMs: 166.8 }));

    expect(r.label).toBe('t');
    expect(r.frames).toBe(5);
    expect(r.maxFrameGapMs).toBe(100);
    expect(r.droppedFrames).toBe(1);
    expect(r.meanFrameMs).toBe(33.4);
    expect(r.p95FrameMs).toBe(100);
    expect(r.durationMs).toBe(166.8);
  });

  it('counts every frame above the dropped threshold (strictly)', () => {
    const r = summarizePerf('t', input({ frameDeltas: [10, 33, 32, 64, 200] }));
    expect(r.droppedFrames).toBe(3); // 33, 64, 200 (32 is not > 32)
    expect(DROPPED_FRAME_MS).toBe(32);
  });

  it('summarizes main-thread lag (the reliable metric): total/max/stalls', () => {
    // A smooth run has near-zero lag; two ticks stalled 80ms and 120ms.
    const r = summarizePerf('t', input({ lagSamples: [0, 1, 80, 2, 120, 0], durationMs: 200 }));
    expect(r.lag.samples).toBe(6);
    expect(r.lag.totalMs).toBe(203);
    expect(r.lag.maxMs).toBe(120);
    expect(r.lag.stalls).toBe(2); // 80 and 120 exceed STALL_MS
    expect(STALL_MS).toBe(50);
  });

  it('aggregates long tasks into count/total/max', () => {
    const r = summarizePerf('t', input({ longTaskDurations: [80, 120, 55] }));
    expect(r.longTasks).toEqual({ count: 3, totalMs: 255, maxMs: 120 });
  });

  it('is safe on empty inputs (idle window)', () => {
    const r = summarizePerf('idle', input());
    expect(r.frames).toBe(0);
    expect(r.meanFrameMs).toBe(0);
    expect(r.p95FrameMs).toBe(0);
    expect(r.maxFrameGapMs).toBe(0);
    expect(r.droppedFrames).toBe(0);
    expect(r.lag).toEqual({ samples: 0, maxMs: 0, totalMs: 0, stalls: 0 });
    expect(r.longTasks).toEqual({ count: 0, totalMs: 0, maxMs: 0 });
  });

  it('rounds to 0.1ms', () => {
    const r = summarizePerf(
      't',
      input({ frameDeltas: [16.666, 16.666, 16.666], durationMs: 49.998 }),
    );
    expect(r.meanFrameMs).toBe(16.7);
    expect(r.durationMs).toBe(50);
  });
});
