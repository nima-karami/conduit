# Terminal path links — run report

## MVP resolve budget (Slice 6)

Scenario: `test/e2e/stress/terminal-path-resolve.stress.mjs`, idle machine (busy 0.04).

| Session | Warm p50 | Warm p95 | Budget p95 | With a dir token, p95 (advisory) |
|---|---|---|---|---|
| 30 repos × 50 files | 6 ms | 10 ms | 50 ms | 11 ms |
| 200 repos × 10 files | 31 ms | 46 ms | 150 ms | 44 ms |

Each sample is one `resolvePathToken` round trip timed in the renderer: 10 tokens per post (exact-cwd, exact-root fan-out, suffix, `…` elision, misses), 50 posts after 5 warm-ups, taken after the tracker's first git pass. A dir token is stat'ed in every root by design (rule 4), so it is measured separately.

The first run failed (p95 55 ms / 5,580 ms). Three fixes, each from a profile:

1. A `git rev-parse` per request → memoised `repoTopLevel` (30 roots: p50 50 → 9 ms).
2. A git toplevel per candidate root → a registered repo root or the cwd git root answers itself (200 roots: p50 5,207 → 115 ms).
3. A quadratic deepest-root scan → an ancestor walk over a key map (CPU 100.6 → 23.0 ms; p95 161 → 46 ms).

Advisory: `readFile` p95 is 38 ms alone and 1,073 ms with 50 200-root resolves in flight (28×, above the plan's 2× call-out line). The cause is main-thread contention.
