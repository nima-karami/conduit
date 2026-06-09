# Overnight decision log

Autonomous build decisions, newest last. Review/override anything here.
Policy: **decide & document** — reasonable call at each fork, keep building.

| # | When | Fork | Decision | Reasoning |
|---|------|------|----------|-----------|
| 1 | 2026-06-08 | Project layout | Single extension package at repo root | Simplest; no monorepo needed for one extension |
| 2 | 2026-06-08 | Webview framework | React + esbuild | Stated default in design; fast bundling |
