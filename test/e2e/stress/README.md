# Stress / load lane

Measures Conduit's **interactivity under load** — how responsive the UI stays while a slice is
hammered. Separate from the smoke suite and **not** part of `npm run verify` (Windows-only, drives
the real GUI hidden, and the numbers are environment-sensitive). Spec:
`docs/specs/archive/2026-07-07-stress-load-testing.md`.

## Run it

```
npm run test:stress                          # the whole lane
node test/e2e/stress/run-stress.mjs arch     # only scenarios matching a filter term
```

Kill orphaned electrons first if a prior run was interrupted:
`cmd //c "taskkill /F /IM electron.exe /T"`.

The runner prints a per-scenario table and writes `docs/runs/2026-07-07-stress-load/baseline.json`.

## The metric

The headline number is **`block` (main-thread lag)** — cumulative ms the main thread was blocked,
from the drift of a 16 ms timer. It's the reliable signal because the lane runs the app **hidden**,
where Chromium throttles `requestAnimationFrame` to ~1 fps — so `frameGapMax` is only a coarse
gross-stall detector, not a smoothness measure. `maxStall` is the worst single freeze; `stalls`
counts lag samples over 50 ms; `longTasks` corroborates via the Long Tasks API.

The probe (`window.__conduitPerf`, `webview/perf-probe.ts`) and the pure `summarizePerf`
(`src/perf-stats.ts`) are unit-tested, and `whole-app.stress.mjs` self-checks that the probe
actually distinguishes a deliberately-blocked window from an idle one.

## Assert vs advisory

Each scenario **asserts structural invariants** (these FAIL the lane): the explorer must window, not
mount all 10k rows; the terminal must recover after a flood; the arch corpus must load with nothing
dropped and edges must survive a move; sessions must restore on relaunch. The **timing numbers are
advisory** — they print and are recorded, but never fail the run (perf thresholds flake on loaded
machines). That split is the whole point: a green run means no structural regression, and the
baseline tells you where each slice's performance ceiling is.

## Adding a scenario

Create `test/e2e/stress/<slice>.stress.mjs` using `runStress(name, fn)` from `harness-stress.mjs`.
Inside: generate load (a `mkdtempSync` corpus — never write into the repo), `startPerf`/`stopPerf`
around the load window, `assertInvariant(...)` for anything structural, and `emitReport(name,
report, extra)` for the numbers. The runner discovers it automatically.
