# Three-process build — run report (2026-11-01 → 2026-11-02)

Unattended multi-agent build of ADR 0007 on `feat/three-process`: the Electron app becomes a client of a new Conduit
server process, which runs agents in herdr-core `hc` 0.1.16. Lead: Claude (Opus 5.5); executors: Codex (gpt-6.1-sol,
Luna subagents), Claude Opus and Sonnet subagents. Ledger: `.autoloop/` (gitignored).

## Outcome
- Agents survive app quit, update and server crashes; a relaunch adopts them on the same hc terminal.
- The server owns sessions, MCP (shim C6 gen 2, persistent tokens, bindings), attention, scrollback, timers, settings.
- node-pty is gone; the installer bundles Node 24.18.0 and hc 0.1.16 (pinned + sha256, fetched at build time).
- New UI: background-service banner (unavailable / stopped / newer version / degraded, Retry, "Restart agents to
  update"), "input paused" overlay, Retry launch / Discard, Quit vs "Quit and stop all agents", exited panes keep output.

## Evidence
- `npm run verify` on the integration tip: exit 0 (637 files, 9732 tests; check, typecheck, build, fallow, audit, gitleaks).
- Remote e2e, full suite on GitHub Windows runners: 230 PASS / 3 FAIL / 1 QUARANTINED (run 41484301423); the 3 were
  fixed and pass remotely (dirty-quit-windows, logging, mf-files + neighbours dirty-quit, quit-guard). Net: every
  scenario passes except `scrollback-inrun`, quarantined on an hc residual (below). Remote verify job: success.
- New real-hc scenarios: server-standalone (walking skeleton), server-runtime, hc-client, adopt-on-relaunch,
  server-restart-supervisor, hc-core-restart, fast-exit-shown, notice-visible-session, mcp-open-windowless,
  typing-through-server.
- Runtime QA on the real app: cold start via hc; a real Claude Code session connects to Conduit's MCP and calls
  `list_sessions` through the server (one Haiku turn); quit → relaunch keeps `ping` and claude alive and connected;
  `hc kill` of the supervisor → input paused → recovery; 4 crashes/hour → stopped + Retry; quit-and-stop kills all.
- Packaged smoke (unpacked electron-builder build, no installer): layout, runtime-dir preparation, supervisor on the
  bundled node + hc, a shell session, adopt on relaunch, quit-and-stop, runtime GC — pass; the packaged MCP shim path bug it
  found is fixed (`--shim-dir`).
- herdr-core network audit: hc 0.1.16 has no telemetry/analytics/update check; only user-invoked `hc update`,
  `hc machine`, `--on` reach the network, and a guard test forbids Conduit from calling them (`docs/runs/2026-11-02-hc-spike/network-audit.md`).

## What the reviews caught (the process worked because of them)
- 9 design review rounds (Opus critic, Codex, Cursor) before code; every lane reviewed (Opus), most re-reviewed.
- The highest-value reviews were whole-tree Codex reviews after integration: 9 server recovery blockers
  (`docs/runs/2026-11-01-three-process-design/codex-review-server-integrated.md`) and 5 app blockers
  (`codex-review-app-integrated.md`) that per-lane reviews with doubles had missed.
- The e2e suite found product bugs the unit gates couldn't: server env (hc XDG leaking into the server), refusal order,
  attention latch, launch ranking, auto-relaunch on cold start, scrollback geometry after resize.

## Residuals (accepted, documented in CHANGELOG / ADR 0007 "As built")
- hc's attach history paint hard-breaks soft-wrapped lines (upstream request) → `scrollback-inrun` quarantined.
- hc sends no repaint after a resize (measured); the ring records the size boundary itself.
- The C2/MCP named pipe is unauthenticated (same-user SMB clients; Everyone read) — M28.
- Background processes started in a session end with it (M23); a kill-on-close job without breakaway can take the core
  down (M17, re-check in the real installer pass).
- Signing would sign the bundled hc.exe/OpenConsole.exe with Conduit's cert — decide before signing goes live.
- Agents inherit `CLAUDE_CODE_*` if Conduit is started from a Claude Code terminal (also true in v0.51).
- Not covered: the real NSIS install/update/uninstall pass (M16), a Codex CLI real-agent run (token-rotation risk to the
  user's login), visible-window rendering polish.

## Upstream requests for herdr-core
- Soft-wrap fidelity in the history paint; an end-of-paint marker (D20); `spawn_pending` kept under `keep:false` (D21);
  per-terminal env-injection opt-out (D16/M25); a way to unset a variable in `terminal.run.env` (M22); `foreground` = the
  console's foreground process on Windows (M27); template commands without `sh` (M9).

## Process learnings
- Codex's 5 h window ran out twice (3 parallel high-effort lanes ≈ 40 min); budget Codex per lane, use medium effort.
- Claude subagents can't write .md — have them return reports as text.
- `verify:quick` doesn't build — every gate needs `node esbuild.mjs`.
- Whole-tree cross-harness review after integration is worth more than another per-lane round.
- Probing agents leak servers/hc cores unless told to tear down and verify by process scan.
- Incident: an unquoted heredoc in a lead-written brief executed `hc server restart` on the user's default hc session
  (holder kept the PTYs; the only live terminal survived). Briefs are now written with quoted heredocs or the Write tool.
