# CON-57 report — MCP as one full-screen Settings section

**Branch:** `CON-57-mcp-full-screen` in `~/projects/.wt/conduit/CON-57`, 46 commits on top of `main@ce1d7e87` (v0.69.0).
**Tested code SHA: `9c19e272`.** The commits after it are docs only (this report). Not merged, not pushed (the `ci/e2e/*` temporary refs the e2e tool creates are auto-deleted by its runs; owner approved that).
**Spec:** `docs/specs/2026-11-18-mcp-full-screen.md` · **Plan:** `docs/plans/2026-11-18-mcp-full-screen.plan.md` · **Ledger:** `goal.md`, `learnings.md`, `baseline.md`, `architecture-critique.md` in this folder.
**Design source (owner-approved):** canvas page "MCP · full-screen settings" (https://claude.ai/artifact/Uxi8ZiJTXqXt6GEcttbz6J), boards D1–D7.

## What shipped (renderer only; `git diff --stat ce1d7e87 -- src/conduit-mcp` is empty)
- Settings is a full-screen page under the title bar with a **Back to Conduit** button; the workbench stays mounted and is `inert` while it is open; focus returns to the opener after Back/Esc.
- "MCP" and "Permissions" are one section, **MCP**, with title, subtitle and underline tabs **Settings | Roles | Agents | Grants | Activity**. Activity moved out of the center pane (the `permissions-activity` doc kind is deleted; it was never persisted).
- **Roles** (was Profiles): list with Role | Type | Used by | five group pills (Allowed/Mixed/Denied + counts); drawer (built-in read-only + Duplicate role; custom Edit/Duplicate/Delete); editor with collapsed groups (Sessions open), per-tool "More options". Review and delete pages unchanged (full panel).
- **Agents** (was Assignments): "New agents start with [role]", list with a role select and an "N changes"/"Follows role" chip, drawer (role, each change as `tool: role says X → this agent: Y`, "Edit changes", "Reset all to role", what the agent can do, Check a request). A role picked in the list is staged; nothing applies until Review → Apply.
- One Esc ladder (Roles/Agents sub-views → release notes → close); agent deep link (`agentKey`) from the session dialog and Activity add-exception; every `openSettingsAt` site retargeted (table in the plan).
- Copy says "role" (identifiers unchanged). CHANGELOG `[Unreleased]` › `### Changed` has 5 user-facing bullets.

## Gates (exit codes captured directly)
| Gate | Result |
|---|---|
| Baseline `npm run verify` at the base commit | exit 0 (916 files, 14,946 tests) |
| Final `flock … npm run verify` at `9c19e272` | **exit 0** (921 files, 15,025 tests; fallow, audit, security ok) |
| `npm run e2e:remote -- --full` at `9c19e272` (run 44431949336) | result artifact `status: passed`: **300 PASS, 0 FAIL, no flaky/retry-pass**; 9 EXCLUDED, 2 SKIP (net-ssh-bootstrap, paste-linux), 1 QUARANTINED-FAIL (`scrollback-inrun`, quarantined since 2026-11-02, unrelated). The tool printed "cancelled" only because another lane's full run (`052377f`) started as mine finished; all 16 shards, verify and report jobs are green. A clean uncontested re-run is available if you want one. |
| Named remote e2e per slice | S1 11/11 PASS, S2 10/10 PASS, S3 `permissions-session` FAILED once (update notice covered the bottom-right action; test fixed) then 2/2 PASS, S4 8/8 PASS |
| `src/conduit-mcp` diff vs base; CON-60 files (`electron/updater.ts`, `deb-install-failure.ts`, update toast/card, whats-new) | both empty |

## Independent reviews (fresh read-only reviewers, none saw the build story)
Architecture critique of the plan (REVISE → plan revised), then one review per slice and per fix round: S1, S2, S3+S2 fixes, S4+S3 fixes, S4 fixes+S5 — all **APPROVE, 0 blockers**. Every in-scope finding was reproduced and fixed (Esc ladder gaps, stale selection/resurrected draft, deep-link spend, ARIA validity, CSS leak, 1024 px list, hover-rule guard…). Integrity scan (NUL/BOM/EOL/UTF-8) clean on every range.

## Screens vs canvas (headless Chromium, real components, stubbed data layer; PNGs in `/tmp/claude-1000/con57/shots/png/`)
Matches D1–D7 in structure: page + Back, MCP title/subtitle/underline tabs, Roles pills and drawer, editor, Agents list/chip/drawer, Grants, Activity. Measured: no horizontal overflow at 1440 or 1024 (`measurements.json`). Differences from the canvas: change rows are plain text lines (no per-row Reset buttons, no inline "Add a change" form — deferred by plan); drawer actions sit at the end of the content, not a sticky footer; at 1024 px the drawer overlays the list and hides the Type column.

## NOT_COVERED (say so plainly)
- Electron was never launched (hidden-only rule); screenshots come from a stubbed bridge, so real policy data, real title bar, install rows and "Check a request" selects were not exercised visually.
- The Agents/Roles flows are covered by unit tests and by remote e2e (`permissions-session` etc.), not by a human click-through.
- 1024 px visual quality beyond the measurements; light/Neon themes.

## Deviations from the plan
Executors ran at the session's own model tier (cannot delegate upward); T2.3–T2.5 landed as one commit (types cannot compile between them); Slice 3 ran as one executor instead of two parallel groups; `conduit-mcp-strings.ts` was edited in T3.1/T3.4 (components needed their copy); `mcp.saveAssignment` is the real API name; per-tool Screen condition added next to the old global one.

## Decisions queued for the owner (defaults taken, all reversible)
1. **[high] Bottom-right is reserved for floating notices.** The update notice / approval card covers the drawer's bottom-right actions (Cancel, Review and save, Delete); a remote e2e failed on it and now dismisses the notice. Recommended: move drawer actions to the drawer header and update canvas D3–D5.
2. Approval card "For this agent, always" / Allow ▾ (canvas E3) not built; E1 (row-menu submenu), E2 (Customize drawer), E4 (refusal fix flow) not built (out of this run's scope).
3. "Reset to <built-in role>" omitted (needs the app to remember a custom role's source).
4. Runtime hint strings in the frozen policy code still say "Settings → Permissions" (`src/conduit-mcp/tool-policy.ts:451`, `screen-tools.ts:50`, `app-control-tools.ts:200`, `test/unit/conduit-mcp-call-flow.test.ts:406`).
5. Editor shows both the old global Screen condition and the new per-tool one; pick one.
6. Palette command still says "Open Permissions Activity" (page heading still says that too).
7. Drawer layout classes for Agents reuse `.permissions-roles*` names (cosmetic rename).
