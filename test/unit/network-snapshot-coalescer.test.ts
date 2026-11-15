import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createSnapshotCoalescer,
  SNAPSHOT_COALESCE_MS,
} from '../../server/network/snapshot-coalescer';
import type { MonitorSnapshot } from '../../src/contracts/link-protocol';

const snap = (seq: number): MonitorSnapshot => ({
  seq,
  sessions: [],
  requests: [],
  youUnread: 0,
  ownerPresence: 'here',
  agents: [],
});

function setup() {
  const applied: Array<{ machineId: string; seq: number }> = [];
  const coalescer = createSnapshotCoalescer({
    now: () => Date.now(),
    after: (fn, ms) => {
      const h = setTimeout(fn, ms);
      return () => clearTimeout(h);
    },
    apply: (machineId, s) => applied.push({ machineId, seq: s.seq }),
  });
  return { coalescer, applied };
}

describe('snapshot coalescer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('100 frames in one window apply at most twice, and the last one always lands', () => {
    const { coalescer, applied } = setup();
    for (let i = 1; i <= 100; i += 1) coalescer.offer('m-1', snap(i));
    expect(applied.length).toBeLessThanOrEqual(2);
    vi.advanceTimersByTime(SNAPSHOT_COALESCE_MS);
    expect(applied.length).toBeLessThanOrEqual(2);
    expect(applied.at(-1)).toEqual({ machineId: 'm-1', seq: 100 });
  });

  it('a lone snapshot applies at once', () => {
    const { coalescer, applied } = setup();
    coalescer.offer('m-1', snap(1));
    expect(applied).toEqual([{ machineId: 'm-1', seq: 1 }]);
  });

  it('a peer applies again once its window has passed', () => {
    const { coalescer, applied } = setup();
    coalescer.offer('m-1', snap(1));
    vi.advanceTimersByTime(SNAPSHOT_COALESCE_MS);
    coalescer.offer('m-1', snap(2));
    expect(applied.map((a) => a.seq)).toEqual([1, 2]);
  });

  it('windows are per peer', () => {
    const { coalescer, applied } = setup();
    coalescer.offer('m-1', snap(1));
    coalescer.offer('m-2', snap(1));
    expect(applied.map((a) => a.machineId)).toEqual(['m-1', 'm-2']);
  });

  it('stop drops a pending trailing apply', () => {
    const { coalescer, applied } = setup();
    coalescer.offer('m-1', snap(1));
    coalescer.offer('m-1', snap(2));
    coalescer.stop();
    vi.advanceTimersByTime(SNAPSHOT_COALESCE_MS * 2);
    expect(applied.map((a) => a.seq)).toEqual([1]);
  });
});
