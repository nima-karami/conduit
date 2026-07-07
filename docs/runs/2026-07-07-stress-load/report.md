# Run report — stress / load testing lane (2026-07-07)

Built a reusable stress/load lane for Conduit and recorded the first baseline. Goal: generate high
load per slice **and** for the whole app, and measure **interactivity** (main-thread responsiveness)
while it's under that load — so regressions are catchable and the current ceilings are on record.

Spec: `docs/specs/archive/2026-07-07-stress-load-testing.md`. Lane: `npm run test:stress` (Windows,
hidden GUI, **not** in `verify`). Baseline data: `baseline.json` (this dir).

## What shipped

- **`src/perf-stats.ts`** — pure `summarizePerf` reducer (unit-tested, `test/unit/perf-stats.test.ts`).
- **`webview/perf-probe.ts`** — `window.__conduitPerf.start/stop/mark`, attached at renderer startup.
- **`test/e2e/stress/`** — `harness-stress.mjs` (probe control, `measureUntil`, `waitForShellReady`,
  load generators, `emitReport`, `assertInvariant`), `run-stress.mjs` (runner + baseline writer),
  `arch-corpus.mjs` (shared, unit-tested 500-node generator), and 7 `*.stress.mjs` scenarios.
- Wiring: `test:stress` script, `.fallowrc` entry glob, spec + INDEX row + this report.

`npm run verify` stays green (probe is a live import; reducer + corpus unit-tested; Playwright stays
path-resolved; the lane is out of the gate). Full lane: **7 passed / 0 failed**.

## The measurement pivot (the hard part)

There was zero responsiveness telemetry. The obvious metric — animation-frame cadence — is a **trap
under the hidden launch**: Chromium throttles `requestAnimationFrame` to ~1 fps for a non-visible
page, so an idle hidden window already reads ~1000 ms "frame gaps." Confirmed empirically (idle
`frameGapMax` ≈ 1000 ms across every scenario).

The reliable metric is **main-thread lag** — the drift of a fixed 16 ms timer, which
`backgroundThrottling:false` keeps at full rate while hidden. `whole-app`'s self-check proves it
works: an idle window reads **block ≈ 92 ms**, a deliberate 4×250 ms block reads **block ≈ 1066 ms,
4 stalls** (and Long Tasks corroborate: 5 tasks / 1111 ms). So `block` (cumulative main-thread block)
is the headline interactivity number; frame gaps are kept only as a coarse gross-stall signal.

## Baseline (first run — advisory numbers, one machine under some load)

| Scenario | block (ms) | worst stall | stalls | long tasks | invariant |
|---|--:|--:|--:|--:|---|
| **arch-canvas-load** (500n/2000e) | **92,754** | **47,578 ms** | 11 | 23 / 91,518 ms | loads, nothing dropped ✓ |
| explorer-10k (scroll) | 32,505 | 1,026 ms | 33 | 33 / 31,963 ms | windows (mounted ≪ 10k) ✓ |
| markdown-heavy (300 §, 40 mermaid) | 4,906 | 2,181 ms | 4 | 7 / 4,796 ms | renders + find ✓ |
| monaco-2mb | 3,336 | 1,999 ms | 4 | 3 / 3,140 ms | model opens ✓ |
| arch-canvas-drag (1 node) | 2,539 | 257 ms | 3 | 1 / 210 ms | edges survive move ✓ |
| whole-app (drag under firehose) | 2,073 | 600 ms | 2 | 4 / 1,065 ms | app functional ✓ |
| terminal-firehose (9.5k msgs, 1.6 MB) | 216 | 18 ms | 0 | 0 | terminal recovers ✓ |
| persistence-churn (8 sess + relaunch) | 157 | 14 ms | 0 | 0 | sessions restore ✓ |

(Numbers are environment-sensitive — the arch-drag block in particular varied 2.5s–50s across runs
depending on machine load. The **ranking and orders of magnitude** are the signal, not the exact ms.)

## Ceilings found (→ follow-ups, per "document now, fix later")

1. **Architecture canvas is the ceiling — by far.** Loading a 500-node / 2000-edge graph froze the
   main thread for a **single 47-second stall** (92 s cumulative). The canvas has no node
   virtualization (`<ReactFlow>` renders every node/edge) and rebuilds the whole doc on every drag
   frame. **Fix (biggest win): `onlyRenderVisibleElements` + coalesce the per-drag-frame full-doc
   rebuild.** The v0.24.0 edge-drop fix held at scale (model & DOM both kept all 2000 edges).
2. **Explorer at 10k is a *new* secondary ceiling.** DOM windowing works (the invariant passed —
   mounted rows stayed a screenful), yet the scenario still blocked ~32 s / 1 s worst stall: the flat
   row list is rebuilt (`walk` + `findIndex`, O(N)) on every render/scroll, and load runs
   `git check-ignore --stdin` over all 10k names + a full readdir. **Fix: memoize/incrementalize the
   row-list build; cap/stream the ignore check.**
3. **Markdown + Monaco: multi-second open freezes** (≈2 s worst stall each) — the full-doc
   rehype+highlight+mermaid pass and the 2 MB tokenize. Bounded (2 MB read cap; find is cached) but
   noticeable. **Fix: chunk/virtualize the markdown render; consider deferring mermaid.**
4. **Resilient:** terminal firehose (9.5k IPC messages / 1.6 MB → 216 ms block — xterm's write
   buffer + 120 ms activity coalescing absorb it) and session/persistence churn (157 ms, clean quit +
   restore). No action.

## Notes / gotchas for next time

- Run hidden ⇒ `block` (timer lag), not frame rate, is the interactivity metric. Documented in the
  spec + README so nobody "fixes" the frame-gap numbers.
- `waitForShellReady` must **resend** its marker until the PTY is at its prompt — input fired right
  after `openSession` is dropped (the PTY spawns a beat later). First cut sent once and hung.
- Opening the command palette *during* a terminal firehose is racy — in `whole-app`, open the canvas
  first, then flood, then interact.
- Kill orphaned electrons before a run: `cmd //c "taskkill /F /IM electron.exe /T"`.
