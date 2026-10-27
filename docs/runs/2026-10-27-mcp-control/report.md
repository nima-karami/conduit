# Run report: Conduit MCP control tools (2026-10-27)

Spec: [2026-10-27-conduit-mcp-control-tools](../../specs/2026-10-27-conduit-mcp-control-tools.md) ·
Plan: [plan](../../plans/2026-10-27-conduit-mcp-control-tools.plan.md) · Branch `feat/mcp-control`
(base `935b32c0`, head `3799e499`). **Not merged** into `feat/conduit-mcp` or `main`.

## Shipped on the branch

- **Tools:**
  - `open_session`: a registered profile or shell in a folder.
  - `open_terminal`: any command as argv. The command is persisted, so Relaunch, Duplicate and
    restore re-run it. A command whose leaf matches an adapter (`claude`, `codex`,
    `cursor-agent`) gets MCP and a handle.
  - `open_file`: opens at a line and column, in the session that owns the path, else the caller's.
- **Placement:** new sessions land in the caller's window and project, with a `focus` flag that
  holds even with auto-switch on. They're attributed "Opened by &lt;handle&gt;".
- **Switches:**
  - Settings → per-tool switches. The control tools are off by default.
  - Right-click a session → **MCP tools…** gives Inherit / On / Off per tool.
  - Every call is gated. Each connection gets its own tool list, with `list_changed` on change.
  - Rate limits: 10 per minute per caller, 20 per minute overall.

| Slice | Commits |
|---|---|
| Spec, plan, review amendments | c8962fce, 361cc9f3, 4848b020 |
| S1 model · S2 server core | e334305e · 3f3318ca |
| S3 host gate · S4 launch seam, MCP create/open, handles | 3f6da4e4 · 1d897751, 66d8e2cd, a32e4a53 |
| S5 renderer (auto-switch, file opens, dialog, Settings) | bab5ce4d, 97277767, 5e5109c3, ca1768c0 |
| Review fixes, S6 e2e, CHANGELOG, text-fit | e2940a27, 833b4b33, 3e219d59, 38f1ec33, a6ebd7c1, 37657cfa, a289bf8e, 7ef1a24a |
| Regression fix (file opens without `source`) | 3799e499 |

## Evidence

- **Gate:** remote run [40567194626](https://github.com/nima-karami/conduit/actions/runs/40567194626)
  at `3799e499`.
  - The `verify` job (ubuntu, the full gate) succeeded.
  - E2E: **215 PASS, 0 FAIL**, 9 excluded.
  - The excluded focus scenarios that this branch touches pass locally: `attention`,
    `multi-window-restore`, `terminal-focus`, `terminal-exit-focus` and `split-editor-focus-keep`.
  - Local `verify:quick` fails only `grammar-linear` groovy < 50 ms, under full-suite load (50–53
    ms). It passes alone, and it passes in remote `verify`.
- **New e2e:** `conduit-mcp-control` (seen red without the fake's `list_changed`) and
  `conduit-mcp-control-terminal`.
- **Reviews:**
  - Spec r1: 5 blockers, all applied.
  - Architecture critic: REVISE, 1 blocker (a kill race in `term:start`), applied.
  - Code review of S1–S4 and of S5–S6: both APPROVE, with should-fixes all applied.
- **Runtime QA with a real Claude Code client** (v2.1.311, Haiku, permission prompts approved by
  hand, no bypass flags):
  - Enabling or disabling a tool reaches the live Claude **without a relaunch**.
  - `git worktree add` then `open_session` gave a new active session in the caller's project.
  - `open_file` routed to the owning session, with Monaco at [40,3].
  - A session without the switch never sees the tools.
  - Screenshots were kept in the scratch dir during the run.

## Regression caught and fixed

The first remote run had 20 red LSP, goto and language scenarios.
- **Cause:** e2e helpers send `openFileInEditor` without the new `source` field, and the renderer
  read that as an unfocused MCP open.
- **Confirmed:** the same scenarios pass on base `935b32c0`.
- **Fix:** the MCP branch is keyed on `source === 'mcp'`, and the helpers send `source: 'os'`.

## Decisions for you

1. **[high] D3, Codex and `open_terminal`.** Codex auto-approves the whole Conduit MCP server, so
   a Codex session with `open_terminal` enabled runs commands without a Codex prompt. Your switch
   is the only guard, and the Settings copy says so.
2. **Sidebar keyboard focus.** Closing the MCP tools dialog can't return focus to the session
   row: rows aren't focusable. That needs a sidebar-wide decision.
3. **`open_failed`.** It was added as non-retryable, since a retry could repeat a half-done open.
4. **Merge order.** `feat/conduit-mcp-inband` (`bd62a444`) also edits `conduit-mcp-host.ts`.
   Expect conflicts whichever lands second.

## Not covered

- Codex, Cursor and OpenCode as clients of the control tools: `list_changed` handling and
  approval behavior.
- `open_terminal`, `focus:false` and the error codes with a real client. The fake-agent e2e
  covers them.
- Whether a background Claude's MCP permission prompt raises "Needs you". It was observed as
  "Busy" for about 6 s.
- Markdown files open in the rendered viewer, which scrolls to the line but has no cursor.

## Learnings

- **[implementation-plan]** Turning an IPC message into a discriminated union broke the untyped
  `.mjs` e2e senders silently. Discriminate on the **new** variant.
- **[autonomous-build-loop]** Never read a timing-budget unit test under concurrent agent load;
  remote `verify` is the arbiter.
- **[autonomous-build-loop]** Running the architecture critic alongside the first build slices cost
  no rework: its findings went to later slices or to the live executor.
