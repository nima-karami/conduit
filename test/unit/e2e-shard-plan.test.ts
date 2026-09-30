import { describe, expect, it } from 'vitest';
import { planShards } from '../e2e/ci-shard-plan.mjs';

const timings: Record<string, number> = { a: 100, b: 80, c: 60, d: 40, e: 20, f: 10, g: 5 };
const names = Object.keys(timings);

describe('planShards', () => {
  it('places every name exactly once', () => {
    const { shards } = planShards(names, timings, { shards: 3 });
    const placed = shards.flatMap((s) => s.names).sort();
    expect(placed).toEqual([...names].sort());
  });

  it('keeps the longest shard within ideal + largest item', () => {
    const { shards } = planShards(names, timings, { shards: 3 });
    const total = names.reduce((sum, n) => sum + timings[n], 0);
    const ideal = total / 3;
    const longest = Math.max(...shards.map((s) => s.estSec));
    expect(longest).toBeLessThanOrEqual(ideal + Math.max(...Object.values(timings)));
  });

  it('respects the cap and never makes more shards than names', () => {
    expect(planShards(names, timings, { shards: 50, cap: 4 }).shards).toHaveLength(4);
    expect(planShards(['a', 'b'], timings, { shards: 10 }).shards).toHaveLength(2);
  });

  it('derives the count from total × scale / target when shards is 0', () => {
    // total 315 s × 2 = 630 s over a 100 s target → 7 shards (capped by 7 names)
    expect(planShards(names, timings, { shards: 0, targetSec: 100, scale: 2 }).shards).toHaveLength(
      7,
    );
    expect(planShards(names, timings, { targetSec: 1000 }).shards).toHaveLength(1);
  });

  it('gives an unknown name the median of the known timings', () => {
    const { shards } = planShards(['zzz'], timings, { shards: 1 });
    expect(shards[0].estSec).toBe(40);
  });

  it('adds setup time to every shard estimate', () => {
    const { shards } = planShards(['a', 'b'], timings, { shards: 2, setupSec: 30 });
    expect(shards.map((s) => s.estSec).sort()).toEqual([110, 130]);
  });

  it('returns no shards for an empty selection', () => {
    expect(planShards([], timings).shards).toEqual([]);
  });
});
