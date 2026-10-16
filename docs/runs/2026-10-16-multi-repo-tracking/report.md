# Run report — multi-repo tracking (2026-10-16)

Spec: [2026-10-16-multi-repo-tracking.md](../../specs/2026-10-16-multi-repo-tracking.md) ·
Plan: [2026-10-16-multi-repo-tracking.plan.md](../../plans/2026-10-16-multi-repo-tracking.plan.md)

## Baseline (before engine)

Slice 0, on unmodified product code (base `8f307d1c`, built with `npm run build`, scenarios committed in 77db54b6). Lane: `npm run test:stress -- multi-repo` → both scenarios PASS, exit 0.

**Machine conditions.** Win11 Pro, local, app hidden (`CONDUIT_E2E=1`), scenarios serial. CPU busy fraction sampled for 2 s before each launch (after the fixture build): cap 0.03, tickets 0.077, both under the 0.3 idle bar. Desktop apps (Chrome, TeamViewer, two Conduit instances) open but quiet (~4 % whole-machine load). Phase A lag moved by more than 2× between an earlier solo tickets run and the lane run, so treat lag as ±2× noise; the git counts are stable.

Topology: tickets = non-git `ws/` with 20 repos × 1,500 files + 4 `ticket-k/` folders × 4 linked worktrees; 5 writers (each ticket's first worktree + main repo `repo-005`), each writing a new untracked file and appending to a tracked file every 200 ms for 10 s, then 5 s settle. Cap = non-git `ws/` with 200 repos × 50 files, 4 writers. Probe reset after the first fill.

### Ticket topology (`multi-repo-tickets`)

| Metric | Phase A (parent only) | Phase B (parent + ticket 0 split) | Solo run A / B |
|---|---|---|---|
| Parent repo set | 36 | — | 36 |
| First fill | 2,198 ms, 367 git | — | 6,615 ms, 339 git |
| git processes (15 s) | 382 | 429 | 199 / 475 |
| `status -uall` calls | 288 | 324 | 144 / 360 |
| `diff --numstat` calls | 80 | 90 | 40 / 100 |
| Repos given a `status` | **36 of 36** | **36 of 36** | 36 / 36 |
| `status` per written repo (max) | 8 | 9 | 4 / 10 |
| `statusOutsideWritten` (calls / repos) | **248 / 31** | **279 / 31** | 124/31 / 310/31 |
| Arrival lag, parent p50/p95/max | 1,765 / 2,733 / 3,127 ms | 1,223 / 2,039 / 2,439 ms | A 3,523/7,086/8,279; B 1,269/2,047/2,656 |
| Spec §7 refresh lag | n/a (no `repoDelta` yet) | n/a | n/a |
| Parent saw agent files | 250/250 | 250/250 | 235/235, 250/250 |
| Ticket 0 (split) saw own files | — | **0 of 50** | 0 of 50 |
| Host main-thread lag p95 / max | 13 / 378 ms | 14 / 320 ms | 20/76, 13/396 |
| Renderer block (A+B window) | 2,032 ms, max stall 130 ms | | 3,997 ms, max stall 1,011 ms |
| git: last 3 s of settle → next 3 s | 20 → — | 0 → 0 | 18, 23 → 0 |
| Commit seen by ticket 0 (active) | **not seen within 5 s; 0 change messages after the commit** | | not seen, 0 messages |

### 200 repos at the cap (`multi-repo-cap`)

| Metric | Value |
|---|---|
| Repos scanned | 200 (cap respected) |
| First fill | 14,026 ms, 1,008 git |
| git processes (15 s) | 819 |
| `status` calls / repos | 773 / **200 of 200** |
| `status` per written repo (max) | 4 |
| `statusOutsideWritten` | **757 / 196** |
| Arrival lag p50/p95/max | 4,010 / 6,649 / 7,635 ms |
| Writes seen | **184 / 200** |
| Host main-thread lag p95 / max | 12 / 37 ms |
| Renderer block | 921 ms, max stall 102 ms |
| git: last 3 s of settle → next 3 s | 178 → 27 (queue still draining) |

First attempt, same build: 814 git / 768 status / 200 repos / lag p95 6,731 ms / 187 of 200 seen.

### Spec §2 ASSUMED rows, resolved

| Claim | Result |
|---|---|
| Any fire refreshes every repo in each visible owning session | **Confirmed**: `status` in all 36 (200) repos while 5 (4) were written; unwritten repos took 87 % (98 %) of status calls |
| Parent's repo set includes every ticket worktree | **Confirmed**: 36 |
| Ticket session stays stale after `git add`/`commit` | **Confirmed**: no change message within 5 s of the commit |
| A split session may be unwatched | **Confirmed in effect**: the split session received no change list (only the active session pulls `requestProject`) |
| Overlapping sessions not deduplicated | Not separable: the split session got no refresh to duplicate |

### Reading the baseline

- Work scales with repos in the session, not repos written: at 200 repos one 10 s burst costs ~800 git processes, lag is 4–7 s, and 8 % of writes never showed.
- 36-repo lag p95 is 2–7 s against the §7 target of ≤ 1 s.
- The host thread stays responsive (p95 ≤ 20 ms): the cost is git process churn and latency, not main-thread blocking.
