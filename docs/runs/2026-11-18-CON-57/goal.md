# CON-57 — MCP as one full-screen section (run goal)

**Outcome (user-visible).** Settings is a full-screen view with a Back button, not a centered modal.
"MCP" and "Permissions" are one section, **MCP**, with tabs Settings | Roles | Agents | Grants |
Activity. Roles = today's permission profiles (built-ins read-only + Duplicate; custom Edit / Duplicate /
Delete). Agents = today's assignments (one role per agent, a few resettable "changes"). Right-click an
agent in the sidebar → Permissions submenu (switch role, Reset to role, Customize…). Customize opens
a side drawer. Approval card: Allow once / Allow ▾.

**Design source (owner-approved).** Canvas https://claude.ai/artifact/Uxi8ZiJTXqXt6GEcttbz6J, page "MCP ·
full-screen settings" (D1–D7, E1–E4). Shipped-state reference: page "Permissions v0.68.4" (PM1–PM8).

**Branch / base.** `CON-57-mcp-full-screen` off main @ ce1d7e87 (v0.69.0), worktree
`~/projects/.wt/conduit/CON-57`. Commit on this branch only. **No merge to main, no push** (lead merges).

**Gates (Phase 0).** `npm run verify` (CLAUDE.md gate; locked with `flock /tmp/claude-1000/conduit-gate.lock`),
inner loop `npm run verify:quick`, e2e via `npm run e2e:remote` (named / `--affected`; `--full` before any
merge decision), local e2e only ONE scenario by name, headless only (no visible window).
Baseline at kickoff: `npm run typecheck` clean on a fresh worktree of ce1d7e87.

**Mandate.** Scope budget: the slices in `tasks.yaml`. Stop when every slice is verified-done or
quarantined.

**Waivers / user decisions.**
- 2026-11-18 owner: build it myself on this branch; read-only rule lifted for this task only.
- UI-only first: no change to `src/conduit-mcp` policy model or persistence.
- 2026-11-18 owner: `npm run e2e:remote` may push its temporary `ci/e2e/<sha>-<rand>` ref to origin (auto-deleted by the run). The branch itself is never pushed or merged by this run.

**Decisions queued (not guessed).**
1. "Reset to <built-in>" on a custom role needs the app to remember which role it was copied from (model change).
2. Does "For this agent, always" stay in the approval card's Allow menu, or only temporary grants?
3. Rename "profile" → "role" in copy only, or also identifiers?
4. Per-CLI defaults (today) live under "Defaults by agent type" on the Agents tab.

**Lead requirements (claude-3, 2026-11-18T22:57, m_dlblduowv52vux22).**
- Stay out of CON-60's files: `electron/updater.ts`, `deb-install-failure.ts`, update toast/card, whats-new.
- `verify:quick` while working; one full `flock /tmp/claude-1000/conduit-gate.lock npm run verify` before reporting, exit code captured directly (not piped).
- `npm run e2e:remote -- --full` on the final commit: 0 failures, 0 retry-passes. Update e2e selectors for the new layout; keep every assertion's strength.
- CHANGELOG `[Unreleased]` → `### Changed`, every bullet user-facing.
- Keep every Settings entry point working: row menu "Permissions…", MCP tools, Activity "why", others found in the map.
- Headless only for renders; compare a screenshot of each screen with the canvas before reporting.
- Report as `report.md` in this worktree + `send_message` `REPORT CON-57 <path>` to claude-3. Queue the product decisions to the owner.

**Conductor tier.** Session model (Sonnet 5.5); delegated judgment work one tier down, mechanical work at
the floor. No Conduit sessions opened by this run.
