/**
 * The nightly `e2e-state` artifact: timings, flaky history, the last nightly's failures, and the
 * ref sweep's decision. Pure; the `prepare`, `state`, `report` and `sweep` jobs of
 * .github/workflows/e2e.yml do the I/O. Spec: docs/specs/2026-09-29-remote-e2e-lean-loop.md §3.
 */
import { median } from './ci-shard-plan.mjs';

const DAY_MS = 86_400_000;
const SAMPLES = 7;
const FAILING = new Set(['FAIL', 'TIMEOUT', 'QUARANTINED-FAIL']);

/**
 * Rolling median over the last `SAMPLES` nightly PASS durations. A retried pass (FLAKY) carries
 * a failed attempt's teardown in its time, so only PASS counts.
 *
 * @param {{ samples?: Record<string, number[]> } | null} prev
 * @param {{ name: string, status: string, seconds: number }[]} rows
 */
export function updateTimings(prev, rows) {
  const samples = { ...(prev?.samples ?? {}) };
  for (const r of rows) {
    if (r.status !== 'PASS') continue;
    samples[r.name] = [...(samples[r.name] ?? []), r.seconds].slice(-SAMPLES);
  }
  const medians = {};
  for (const [name, s] of Object.entries(samples)) medians[name] = median(s);
  return { samples, medians };
}

/**
 * Shard-planning durations: the seed (local medians) scaled to runner speed, overridden by what the
 * runner measured. The result is already at runner speed, so plan it with `scale` 1.
 */
export function resolveTimings(seed, state) {
  const medians = {};
  for (const [name, s] of Object.entries(seed.medians)) medians[name] = s * (seed.scale ?? 1);
  if (!state?.medians) return { medians, source: 'seed' };
  return { medians: { ...medians, ...state.medians }, source: 'e2e-state' };
}

/** `{ name: [iso…] }`: one entry per FLAKY nightly result, pruned to `days`. */
export function updateFlakyHistory(prev, rows, { now, days = 14 }) {
  const cutoff = now - days * DAY_MS;
  const at = new Date(now).toISOString();
  const out = {};
  for (const [name, times] of Object.entries(prev ?? {})) {
    const kept = times.filter((t) => Date.parse(t) >= cutoff);
    if (kept.length) out[name] = kept;
  }
  for (const r of rows) if (r.status === 'FLAKY') out[r.name] = [...(out[r.name] ?? []), at];
  return out;
}

/** Scenarios FLAKY at least `min` times in the last `days` (spec §B4); most frequent first. */
export function quarantineCandidates(history, { now, days = 14, min = 3 }) {
  const cutoff = now - days * DAY_MS;
  return Object.entries(history ?? {})
    .map(([name, times]) => {
      const inside = times.filter((t) => Date.parse(t) >= cutoff).sort();
      return { name, count: inside.length, last: inside[inside.length - 1] };
    })
    .filter((c) => c.count >= min)
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

export function lastNightly(rows, { sha, runId, at }) {
  return { sha, runId, at, failing: rows.filter((r) => FAILING.has(r.status)).map((r) => r.name) };
}

/**
 * The newest non-expired artifact called `name` from a `GET /actions/artifacts?name=` payload. By
 * creation time only: a red nightly's state is as current as a green one's. Only a run on `main`
 * counts: a `mode=nightly` dispatch on any other ref must not become every later run's state.
 */
export function newestArtifact(list, name) {
  const live = (list?.artifacts ?? []).filter(
    (a) => a.name === name && !a.expired && a.workflow_run?.head_branch === 'main',
  );
  live.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  return live[0] ?? null;
}

const IN_FLIGHT = new Set(['queued', 'in_progress', 'waiting', 'pending', 'requested']);

/**
 * `ci/e2e/*` refs the nightly sweep deletes: nothing in flight on them, and neither created nor run
 * within `maxAgeMs`. `createdAt` is the ref's `branch_creation` entry in the repository activity
 * log: the commit can be days older than the push (`e2e:remote` on an old commit), and between the
 * push and its dispatch showing up the ref has no run yet. Only without a creation entry does the
 * commit time stand in. A run's own `cleanup` job deletes the rest.
 *
 * @param {{ ref: string, createdAt: string | null, commitAt: string,
 *   runs: { status: string, created_at: string }[] }[]} refs
 */
export function staleCiRefs(refs, { now, maxAgeMs = DAY_MS }) {
  return refs
    .filter(({ createdAt, commitAt, runs }) => {
      if (runs.some((r) => IN_FLIGHT.has(r.status))) return false;
      const born = Math.max(
        Date.parse(createdAt ?? commitAt),
        ...runs.map((r) => Date.parse(r.created_at)),
      );
      return now - born > maxAgeMs;
    })
    .map((r) => r.ref);
}
