/**
 * Split e2e scenarios into CI shards balanced by expected duration (greedy LPT).
 * Pure: no I/O. Used by the `prepare` job of .github/workflows/e2e.yml.
 */

function median(values) {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function planShards(names, timings, opts = {}) {
  const { targetSec = 600, cap = 16, scale = 1, setupSec = 0 } = opts;
  if (names.length === 0) return { shards: [] };

  const fallback = median(Object.values(timings));
  const items = names.map((name) => ({
    name,
    est: (Object.hasOwn(timings, name) ? timings[name] : fallback) * scale,
  }));
  const total = items.reduce((sum, i) => sum + i.est, 0);

  const wanted = opts.shards && opts.shards > 0 ? opts.shards : Math.ceil(total / targetSec);
  const count = Math.max(1, Math.min(wanted, cap, names.length));

  const shards = Array.from({ length: count }, (_, index) => ({
    index,
    names: [],
    estSec: setupSec,
  }));
  items.sort((a, b) => b.est - a.est || a.name.localeCompare(b.name));
  for (const item of items) {
    let least = shards[0];
    for (const s of shards) if (s.estSec < least.estSec) least = s;
    least.names.push(item.name);
    least.estSec += item.est;
  }
  return { shards };
}
