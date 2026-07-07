---
status: shipped
date: 2026-07-07
tier: FULL
---

# Stress / load testing lane

## Problem

Conduit's whole value is *interactive* responsiveness, yet there was no way to measure it under
load and no load generator. The only load-ish test was `review-virtualize.e2e.mjs` (a 350-file
corpus that asserts DOM windowing but measures no timing). We needed to (1) generate high load per
slice and for the whole app, and (2) measure interactivity while it's under that load, so
regressions are catchable and the current ceilings are on record.

## The measurement problem (and the fix)

There was no responsiveness telemetry anywhere (no `performance.mark`, no FPS, no long-task probe).
The obvious metric — animation-frame cadence — is a **trap under the hidden e2e launch**: Chromium
throttles `requestAnimationFrame` to ~1 fps for a non-visible page, so an idle hidden window already
reads ~1000 ms "frame gaps." The lane must run hidden (standing rule), so frame gaps are only a
coarse gross-stall signal.

The reliable metric is **main-thread lag**: a fixed-interval (16 ms) timer's drift measures how long
the main thread was blocked between ticks. `backgroundThrottling:false` (already set on the window)
keeps timers at full rate even while hidden, so lag is trustworthy. `lag.totalMs` ≈ cumulative
blocking; `lag.maxMs` is the worst single stall. The Long Tasks API corroborates it where available.

- Pure reducer `src/perf-stats.ts` (`summarizePerf`) — unit-tested (`test/unit/perf-stats.test.ts`).
- Renderer probe `webview/perf-probe.ts` (`window.__conduitPerf.start/stop/mark`) — samples timer
  lag + frames + long tasks between start/stop; attached unconditionally, idle until started.

The probe is self-checked in `whole-app.stress.mjs`: an idle window reads ~0 block; a deliberate
4×250 ms main-thread block reads ~1000 ms with ≥3 stalls (and long tasks fire) — proving the metric
detects jank, which is what makes every other scenario's numbers meaningful.

## The lane

Separate from `verify` and from the smoke suite — Windows-only, drives the real GUI hidden, **not in
CI verify** (perf numbers are environment-sensitive). Files live in `test/e2e/stress/`:

- `harness-stress.mjs` — thin layer over the base `harness.mjs`: `startPerf`/`stopPerf`,
  `measureUntil` (input→observable-effect latency, polled not rAF), `waitForShellReady` (resends an
  echo marker until the PTY is at its prompt — openSession only waits for the session to register),
  `emitReport` (a `##PERF##` sentinel line the runner parses), `assertInvariant`, and load generators.
- `run-stress.mjs` — globs `*.stress.mjs`, 420 s/scenario, aggregates the `##PERF##` lines into a
  printed table + `docs/runs/2026-07-07-stress-load/baseline.json`. `npm run test:stress`.

### Assert vs advisory (the load-bearing distinction)

Timing budgets are **advisory** (print + recorded, never fail). Structural **invariants** fail the
lane — a virtualization window that stops windowing, a scrollback that stops capping, edges that
vanish on move, a corpus that drops nodes. That split is what lets an advisory lane still guard
against real regressions without flaking on a loaded machine's numbers.

### Scenarios (7)

`terminal-firehose` (100k-line cmd flood), `arch-canvas-scale` (500 nodes / 2000 edges + drag),
`explorer-10k` (10k-file tree), `monaco-2mb` (2 MB minified file), `markdown-heavy` (300 sections +
40 mermaid), `persistence-churn` (8 sessions, rapid mutations, quit-flush + relaunch-restore), and
`whole-app` (probe self-check + canvas-drag-under-firehose). Each drives the real app through the
existing observation seams (`__conduitFilesPerf`, `__archDoc`, `__cap`, `window.monaco`, …). The
500-node ArchDoc generator is a shared, unit-tested `arch-corpus.mjs`.

## What the first run found (see the run report)

Terminal firehose is resilient (14k IPC messages / 2 MB → ~124 ms block; xterm's write buffer +
activity coalescing absorb it). The **architecture canvas is the ceiling**: loading 500 nodes freezes
the main thread ~21 s and dragging one node ~42 s (the O(N) full-doc rebuild per drag frame ×
unvirtualized DOM). Explorer/Monaco/Markdown hold up (windowing, the 2 MB read cap, bounded find).
Fixes (arch virtualization + drag-rebuild coalescing first) are follow-ups, not part of this change.

## Follow-ups

Arch canvas: `onlyRenderVisibleElements` + coalesce the per-drag-frame rebuild (the #1 win).
`term:data` host-side coalescing. Markdown chunked/virtualized render. Optionally promote a subset of
invariants to CI if a headless path is found.
