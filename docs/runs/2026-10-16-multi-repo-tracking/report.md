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

## After engine — Slice 2 (`55180787`, 1 s cooldown)

Same lane, same fixtures, machine idle (busy 0.08 cap / 0.18 then 0.06 tickets). Lane EXIT=1 on the §7 lag AC only; every other invariant passes. Values: lane run (rerun).

| Metric | Before (Phase A) | After (Phase A) | After (Phase B) |
|---|---|---|---|
| git processes (15 s) | 382 | **69 (69)** | 70 (71) |
| `status -uall` calls | 288 | 55 (55) | 55 (55) |
| `diff --numstat` calls | 80 | 0 (line counts on demand) | 0 |
| Repos given a `status` | 36 of 36 | **5 of 36** (the written ones) | 5 of 36 |
| `statusOutsideWritten` | 248 / 31 | **0 / 0** | 0 / 0 |
| First fill | 2,198 ms | 865 ms (727) | — |
| Arrival lag p95 | 2,733 ms | 1,050 ms (1,063) | 998 ms (1,027) |
| §7 refresh lag p95 / max | n/a | **1,039 / 1,126 ms (1,047 / 1,127) — FAIL vs ≤ 1,000** | 971 / 1,034 ms |
| Split session saw own files | 0 of 50 | — | **50 of 50** |
| Commit seen by ticket session | not seen in 5 s | **372 ms (370)** | |
| Host main-thread lag p95 | 13 ms | 13 ms | 13 ms |

| 200-repo cap | Before | After |
|---|---|---|
| git processes (15 s) | 819 | **58** |
| `status` calls / repos | 773 / 200 | **44 / 4** |
| `statusOutsideWritten` | 757 / 196 | **0 / 0** |
| Lag p95 | 6,649 ms | 943 ms (§7: 938) |
| Writes seen | 184 / 200 | **200 / 200** |
| First fill | 14,026 ms | 12,311 ms |
| Settle tail (git in next 3 s) | 27 (still draining) | 0 |

**The lag miss is the cooldown, not load.** Under continuous writes the next run starts at `lastStart + cooldown`, so lag ≈ U(0, cooldown) + status time → p95 ≈ 0.95 s + 40–90 ms. Decided: cooldown 800 ms (spec §13); re-measured below.

## After engine — Slice 2b (`775bbc7a`, 800 ms cooldown)

Lane EXIT=0, both scenarios PASS with the §7 lag gate active (machine busy 0.036 cap / 0.068 tickets).

| Metric | Tickets A | Tickets B | Cap (200) |
|---|---|---|---|
| git / status / numstat (15 s) | 79 / 65 / 0 | 80 / 65 / 0 | 66 / 52 / 0 |
| Repos given a `status` | 5 | 5 | 4 |
| `status` per written repo (max; cap ⌈10 s / 0.8 s⌉ + 2 = 15) | 13 | 13 | 13 |
| `statusOutsideWritten` | 0 | 0 | 0 |
| Arrival lag p95 / max | 916 / 974 ms | 851 / 877 ms | 846 / 864 ms |
| **§7 refresh lag p95** | **900 ms** | **819 ms** | **827 ms** |
| Writes seen | 250/250 | 250/250; split session 50/50 | 200/200 |
| Commit seen by ticket session | 481 ms | | |
| Host main-thread lag p95 | 14 ms | 13 ms | 13 ms |
| Settle tail | 0 | 0 | 0 |

The 800 ms cooldown costs +10 status per 15 s across 5 written repos (55 → 65) and buys p95 1,039 → 900 ms. A background session receives no deltas (it renders from the tracker's cache on switch-in, spec §2), so ticket 0's 0/50 in Phase A is by design. Spec §6 revival trigger (p95 > 1 s or git busy > 70 %): **not met** — the tracked set and tiers stay parked.

## After engine + search scope (`7cb58eaf`, final)

Lane EXIT=0, both scenarios PASS, gate active (machine busy 0.01 cap / 0.064 tickets). Evidence: `.autoloop/evidence/final-stress.log` (local, gitignored).

| Metric | Baseline (before engine) | Tickets A | Tickets B | Cap (200) |
|---|---|---|---|---|
| git / status (15 s) | cap 819 | 98 / 65 | 89 / 65 | 70 / 52 |
| `statusOutsideWritten` | tickets 248 | 0 | 0 | 0 |
| **§7 refresh lag p95** | cap 6.6 s | **879 ms** | **797 ms** | **785 ms** |
| Writes seen | cap 184/200 | 250/250 | 250/250; split session 50/50 | 200/200 |
| Commit seen by ticket session | stale | 397 ms | | |
| Host main-thread lag p95 | | 14 ms | 15 ms | 13 ms |
| Idle git after the burst | | 0 | 0 | 0 |

The search index (S3/S4 + four review rounds) adds no git while idle: the quick-open freshness signal only marks the list stale, and `ls-files` runs on demand. Git counts sit within run-to-run noise of S2b (79/80/66 → 98/89/70; S3/S4 to here ranged 90–98 on tickets A). Renderer responsiveness (advisory) is unchanged across S2b, S3/S4, r1 and final (tickets blockMs 4958–5831, maxStall ≈1 s; that 1 s frame gap predates the engine). Spec §6 revival trigger (p95 > 1 s or git busy > 70 %): **not met** — the tracked set stays parked. The 200-repo cap holds with margin (p95 785 ms vs the 1 s gate).
