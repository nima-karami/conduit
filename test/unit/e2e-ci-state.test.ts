import { describe, expect, it } from 'vitest';
import {
  lastNightly,
  newestArtifact,
  quarantineCandidates,
  resolveTimings,
  staleCiRefs,
  updateFlakyHistory,
  updateTimings,
} from '../e2e/ci-state.mjs';

const row = (name: string, status: string, seconds = 10) => ({ name, status, seconds });
const NOW = Date.parse('2026-09-30T08:00:00Z');
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();

describe('updateTimings', () => {
  it('keeps the last 7 PASS samples per scenario and takes their median', () => {
    const prev = { samples: { a: [1, 2, 3, 4, 5, 6, 7] } };
    const t = updateTimings(prev, [row('a', 'PASS', 100), row('b', 'PASS', 20)]);
    expect(t.samples.a).toEqual([2, 3, 4, 5, 6, 7, 100]);
    expect(t.medians.a).toBe(5);
    expect(t.medians.b).toBe(20);
  });

  it('ignores every non-PASS row, and keeps scenarios this run did not touch', () => {
    const prev = { samples: { a: [10], c: [30, 40] } };
    const t = updateTimings(prev, [row('a', 'FLAKY', 999), row('b', 'FAIL', 5)]);
    expect(t.samples).toEqual({ a: [10], c: [30, 40] });
    expect(t.medians).toEqual({ a: 10, c: 35 });
  });

  it('starts from nothing', () => {
    expect(updateTimings(null, [row('a', 'PASS', 3)]).medians).toEqual({ a: 3 });
  });
});

describe('resolveTimings', () => {
  const seed = { scale: 0.5, medians: { a: 100, b: 40 } };

  it('scales the seed and lets measured medians override it', () => {
    expect(resolveTimings(seed, { medians: { a: 70 } })).toEqual({
      medians: { a: 70, b: 20 },
      source: 'e2e-state',
    });
  });

  it('falls back to the scaled seed with no state', () => {
    expect(resolveTimings(seed, null)).toEqual({ medians: { a: 50, b: 20 }, source: 'seed' });
  });
});

describe('flaky history', () => {
  it('records each FLAKY row with the run time and prunes entries older than 14 days', () => {
    const prev = { a: [daysAgo(20), daysAgo(3)], z: [daysAgo(15)] };
    const h = updateFlakyHistory(prev, [row('a', 'FLAKY'), row('b', 'FLAKY'), row('c', 'FAIL')], {
      now: NOW,
    });
    expect(h).toEqual({ a: [daysAgo(3), daysAgo(0)], b: [daysAgo(0)] });
  });

  it('a candidate is FLAKY 3 or more times inside the window', () => {
    const h = {
      a: [daysAgo(1), daysAgo(2), daysAgo(3)],
      b: [daysAgo(1), daysAgo(2)],
      c: [daysAgo(1), daysAgo(2), daysAgo(30)],
      d: [daysAgo(0), daysAgo(1), daysAgo(2), daysAgo(5)],
    };
    expect(quarantineCandidates(h, { now: NOW })).toEqual([
      { name: 'd', count: 4, last: daysAgo(0) },
      { name: 'a', count: 3, last: daysAgo(1) },
    ]);
  });
});

describe('lastNightly', () => {
  it('lists what the nightly left failing', () => {
    const rows = [
      row('a', 'FAIL'),
      row('b', 'TIMEOUT'),
      row('c', 'QUARANTINED-FAIL'),
      row('d', 'FLAKY'),
      row('e', 'INFRA'),
    ];
    expect(lastNightly(rows, { sha: 's', runId: 7, at: daysAgo(0) })).toEqual({
      sha: 's',
      runId: 7,
      at: daysAgo(0),
      failing: ['a', 'b', 'c'],
    });
  });
});

describe('newestArtifact', () => {
  it('takes the newest non-expired artifact of that name, never judging the run', () => {
    const list = {
      artifacts: [
        { id: 1, name: 'e2e-state', expired: false, created_at: daysAgo(2) },
        { id: 2, name: 'e2e-state', expired: true, created_at: daysAgo(0) },
        { id: 3, name: 'e2e-state', expired: false, created_at: daysAgo(1) },
        { id: 4, name: 'other', expired: false, created_at: daysAgo(0) },
      ],
    };
    expect(newestArtifact(list, 'e2e-state')?.id).toBe(3);
    expect(newestArtifact({ artifacts: [] }, 'e2e-state')).toBeNull();
  });
});

describe('staleCiRefs', () => {
  const ref = (name: string, commitAt: string, runs: { status: string; created_at: string }[]) => ({
    ref: `ci/e2e/${name}`,
    commitAt,
    runs,
  });

  it('sweeps a ref older than 24 h whose run never started, and one whose last run is old', () => {
    const refs = [
      ref('never-ran', daysAgo(3), []),
      ref('old-run', daysAgo(5), [{ status: 'completed', created_at: daysAgo(2) }]),
      ref('fresh-run', daysAgo(5), [{ status: 'completed', created_at: daysAgo(0.5) }]),
      ref('young-commit', daysAgo(0.2), []),
      ref('in-flight', daysAgo(9), [{ status: 'in_progress', created_at: daysAgo(3) }]),
    ];
    expect(staleCiRefs(refs, { now: NOW })).toEqual(['ci/e2e/never-ran', 'ci/e2e/old-run']);
  });
});
