# Spaces + agent tree — run report (2026-11-02 → 2026-11-03)

Multi-agent build of `feat/sidebar-tree` on top of `feat/three-process`. Lead: Claude (Opus 5.5). Executors: Claude Opus/Sonnet subagents, Codex (gpt-6.1-sol, later as co-orchestrator with gpt-6-luna subagents), OpenCode, Cursor CLI. Spec `docs/specs/2026-11-02-sidebar-agent-tree.md`, plan `docs/plans/2026-11-02-sidebar-agent-tree.plan.md`. Design canvas (approved by the user): claude.ai artifact "Conduit sidebar redesign" (Design + Flows pages).

## Outcome
- Left panel: Spaces (filter: All / each Space / No space) + Agents grouped by status (Pinned, Needs you, Done, Working, Idle, Stopped folded), 30px rows (26px compact) with auto agent icons, ages, hover pin/close, nested sub-agents from `openedBy` with tree connectors; the active agent's row is always revealed once per activation.
- Header: logo, "Conduit", back/forward; search; Files / Changes / Messages toggles drive the right panel (no tab row, no drag grip — move via its menu); view switcher and attention chip removed.
- Status bar card under the centre column; "need you" count routes like the old chip.
- Bottom-right floating stack (24px equal inset): update card (all states, %), toasts, MCP approval card.
- Done = server-counted completions not yet seen in the focused terminal; Needs you = blocked/bell/pending ask.
- Messages follow the sidebar's Space with a "This agent" filter.
- Terminal fonts bundled locally (no Google Fonts), loaded before the first terminal; late faces re-measure + clear the glyph atlas. Fixes letters in two typefaces and the symbol fallback; symbols ✔ ⏺ ⎿ ✻ come from Segoe UI Symbol on Windows (no bundled mono font has them).

## Evidence
- `npm run verify` on the integrated tree: green except the long-known load-sensitive `grammar-linear` (groovy < 50 ms) and `git-history` LFS hook timeout, which pass alone and on the Linux CI verify job (green on every remote run).
- Remote e2e: last full run 239 PASS / 1 FAIL (`sidebar-space-filter`, fixed at a4d0a72c and confirmed with the other sidebar scenarios: 4/4 PASS). `scrollback-inrun` stays quarantined (hc history-paint soft wraps, from the three-process run).
- Runtime QA on the packaged unpacked build in Aero Dark / Aero / Neon: PASS, no console errors.

## What the reviews caught
Every lane had an independent review; each caught real bugs before merge: right panel snapping back to the remembered tab; rows remounting on regroup (focus + rename lost); completions double-counted when a CLI stops reporting; bell reason latched; boot font timer always "timing out"; Codex whole-tree review: snooze projection mismatch, Go to not showing the terminal, Space branch memory global, font change with no terminals skipping the lifecycle. Remote e2e then found: Review measured heights width-blind (fixed per width), a first-mount width "change" resetting scroll, a one-frame Done flash for a viewed completion, the reveal firing late on a Space switch.

## Residuals
- Board/Canvas full-window overlays cover the status bar (switcher hidden from the header for now).
- Non-Windows terminals lack ✔ ⏺ ⎿ ✻ glyph coverage (Noto Sans Symbols 2 would cover all but ⎿ — not bundled).
- Packaging signs bundled hc.exe/OpenConsole.exe with Conduit's cert (from the three-process run) — decide before signing goes live.

## Process learnings
- Codex's sandbox can't execute `C:\Program Files\nodejs\node.exe`; a copy of the pinned `build/vendor/node/node.exe` inside the worktree runs tests and builds.
- hc templates fail on this machine (`sh` not on the core's PATH); launch CLIs with direct argv.
- Cursor shows a workspace-trust prompt per worktree and approval prompts invisible to hc; the user delegated approvals to the lead (read-only/gate commands only).
- Lanes that "can't run e2e" must still get their e2e assumptions checked remotely early — four remote rounds were mostly stale selectors and harness assumptions.
- Running 3+ lanes with Node gates plus local Electron e2e exhausted memory once; keep ≤3 concurrent and e2e remote.
