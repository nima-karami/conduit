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

## Context-root measurement (T7.2)

Read-only run of a scratch script (bundled `inferContextRoot`, `detectPathTokens`, `rankCandidates`) over this machine's Claude Code transcripts and Conduit scrollback rings. No transcript content, paths or names left the machine; only the counts below.

| Source | Count |
|---|---|
| Transcripts read (top-level / subagent) | 20 / 917 |
| … with a live cwd | 925 |
| … whose cwd holds ≥ 2 repos | 36 |
| Relative path mentions (assistant text, tool-result heads) | 3774 |
| … matched to a later Read/Edit/Write of a file ending in that path | 79 |
| … truth repo outside the roots (skipped) | 4 |
| **Ambiguous samples** (path exists under ≥ 2 repos below the cwd) | **23** (all subagent; all also have an exact-cwd candidate) |
| Rings replayed (`@xterm/headless`, session found) | 4 |

| Measure (ambiguous samples) | Result |
|---|---|
| `inferContextRoot` hit / miss / no signal | 23 / 0 / 0 |
| Signal coverage | 100 % |
| Top-1 accuracy, `RANK_KEYS` with context (last pick simulated) | 100 % |
| Top-1 accuracy, baseline without context (same last pick) | 100 % |
| Top-1 without last pick, with / without context | 100 % / 100 % |
| Rings: relative tokens with a context signal | 22 / 30 (73.3 %); ambiguous 3 / 5 (60 %) |

Common token shapes: `x/x/x/x/x/x.x` (11), `x/x/x/x/x/x/x.x.x` (4), `x/x.x` (2), `x/x/x/x.x.x` (2).

Bar (plan Decisions): ≥ 30 ambiguous samples AND ≥ 80 % top-1 AND better than the baseline. Failed: 23 < 30, and 100 % is not better than the 100 % baseline (every sample had an exact-cwd candidate, which strength already ranks first).

**Decision: `context` moves to just before `shorter` (tie-breaker).** `RANK_KEYS = strength, lastPick, rootGroup, rootOrder, context, shorter`. After `rootOrder`, distinct roots are never tied, so in practice the context root shows only as the picker's "working here" label.

## v1 build (Slices 7–10, `f2937874..7f8ec088`)

Verify EXIT=0 (508 files, 7590 tests); `e2e:remote --full` EXIT=0 (205 pass); stress S6 p95 12 ms at 30 roots / 55 ms at 200 roots (budget 150), readFile ratio 1.37. 45 mutant runs, all red. UNC is unit-covered only (no SMB-free fixture). The OSC 8 wiring is isolated in `28b9dd6d` so it can be reverted alone.
