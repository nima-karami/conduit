# Run report — MCP tool policies + app-control tools (2026-10-30/31)

Branch `feat/mcp-policy` (worktree `G:\awby\conduit-wt\mcp-policy`), base main `1b4d90f2` (v0.50.0).
114 commits, 111 files, +16.6k / −1.1k. **Not merged to main, not pushed, not released** (not asked).

Specs: [tool-policy](../../specs/2026-10-30-conduit-mcp-tool-policy.md) (A),
[app-control](../../specs/2026-10-30-conduit-mcp-app-control.md) (B).
Plans: [A](../../plans/2026-10-30-conduit-mcp-tool-policy.plan.md), [B](../../plans/2026-10-30-conduit-mcp-app-control.plan.md).

## Shipped on the branch

**A — tool policies** (replaces the v0.50 on/off switches)
- Per tool: **Access** off · ask · on, **When** viewing · always, **Reach** self · opened · window · any,
  **Move** yes · no — only the fields that apply to a tool are shown/stored.
- Layers resolve field by field: session override > per-CLI (from the session's handle prefix) > global.
- **Ask**: a non-modal approval card in the caller's window (never takes focus; Enter in the terminal
  can't approve; pager; 400 ms swap guard with visibly disabled buttons; fixed button position;
  Approve / Deny / Always for this session). Per-CLI timeouts (claude 120 s, codex/cursor 50 s,
  opencode/other 25 s); CLI `notifications/cancelled` removes the card and sends no reply; window
  reload/crash/close, session move/delete and master-off cancel waiting asks. Codex's auto-approve no
  longer bypasses the human.
- `viewing` is fail-closed per window (minimised counts; unreported = not on screen).
- Settings → MCP tools: one policy editor with a "Defaults for" CLI tablist and inherited-source text;
  the session dialog edits the session layer.
- v0.50 migration: `true` → on + always (no narrowing); messaging `false` → off; control `false` → new
  default; session `false` → off; both keys present → old overlays new; old keys never written back.
- Rate: act budget (10/min/agent, 20/min total) and show budget (30/min/agent).

**B — seven app-control tools** (all policy-gated): `close_session`, `focus_session`, `attach_folder`,
`close_files`, `open_review`, `open_git_history`, `open_url`, on a window-bound `mcp:ui`
request/response. `open_file` now opens in the caller's session. Refs are classified host-side
(leading `-` and control chars refused before git; `--end-of-options` on `git log`).

**Defaults** (spec A §3.2): messaging on; `open_file`, `close_files`, `open_review`,
`open_git_history`, `open_url`, `focus_session` **on** (while viewing); `open_session`,
`close_session`, `attach_folder` **ask**; `open_terminal` **off**.

## Evidence (all exit codes read from captured logs, not relayed)

| Gate | Result |
|---|---|
| `npm run verify` @4ae6862b, idle machine | exit 0 — 579 files, 9058 tests (+ lint, tsc, build, fallow, audit, gitleaks) |
| e2e:remote `--affected` @2529b07c | 223 PASS, 9 excluded, 1 flaky (`paste`, untouched), verify job ok — run 41177160681 |
| e2e:remote targeted after each later fix round | 41175544919 (55/55 incl. every Review scenario), 41177982865 (5/5), 41179804934 (7/7), 41182042864 (6/6) |
| e2e:remote `--affected` @4ae6862b (final HEAD) | **224 PASS, 9 excluded, 0 flaky, verify job ok — run 41182711570** |
| Independent code reviews | 11 rounds; every REVISE fixed and re-reviewed; final rounds APPROVE |
| Runtime QA (real app, hidden windows, fake MCP agent) | A: pass after a neon overflow fix; B: fail (3 defects) → fixed → re-check **pass** @1f49bada |

New e2e: `conduit-mcp-policy`, `conduit-mcp-policy-migrate`, `conduit-mcp-app-sessions`,
`-files`, `-git`, `-web`; updated `conduit-mcp-control*`, `review-tab-state`.

## Behaviour changes worth knowing (decided during the run)
- **Tool opens and focus:** an agent's open never moves the human's caret while it stays visible;
  if the open hides the focused pane (terminal/editor/Board), focus lands on the opened view (never
  inside a web page) and is announced.
- **Review focus:** Review no longer focuses itself on mount — user opens and Back/Forward request it
  explicitly. Side effect: switching session / Board→editor / launch restore onto Review no longer
  focuses its scroller (matches every other view). Web tabs now take focus on their host container
  when a user activates them.
- **Split partner:** a tool open from the split partner lands in its own layout; a file/web tab the
  shown session already holds stays with it (no cursor jump). Review/History singletons do move.
- Fixed a pre-existing Neon bug: the session MCP tools dialog's 2 px horizontal overflow (chamfer frame
  was also the scroll container).

## Decisions for you (defaults taken)
- **D-merge:** merge `feat/mcp-policy` to main and release? (Not done — not asked.)
- **Double prompt in Claude:** profile sessions launch with `--allowedTools` = messaging only, so an
  `ask` tool prompts in Claude *and* on the card. Follow-up: allow `mcp__conduit__*` and let the policy
  be the only gate (and similarly Codex approve mode, Cursor `Mcp(conduit:*)`, raise Codex/OpenCode
  tool timeouts in their install entries).
- **CLI layer** keys on the handle prefix — a shell where `claude` ran first stays on the Claude layer.
- **"Always for this session"** persists in sessions.json (spec D2); research suggested in-memory.
- Card wording is "<handle> requests <tool>" + a one-line summary ("Close codex-2").

## Known residuals / follow-ups (final review, non-blocking)
- Switching session (palette/shortcut) out of a caret the switch hides, onto a session whose Review has
  its find bar open, leaves focus on body (a session switch requests no focus — same as other views).
- A `prefer` landing in Review's find bar doesn't `select()` the existing query.
- ~8 direct writers share the nav live region; route them all through `createLiveAnnouncer`.

## Not covered
Real CLIs end to end (fake agent through the real shim/token/endpoint only); relaunch persistence of an
"Always" override; per-CLI schema acceptance (flat schemas pinned by a unit test instead); forced-colors
and real screen readers; a real-time screenshot of the 400 ms guard (frozen-clock shots instead).

## Research
`.autoloop/evidence/research.md` (MCP cancel/progress/elicitation/annotations; CLI timeouts and
approval models; IAM/Cedar/OPA/Casbin/K8s/VS Code layering; approval UX). Adopted: per-CLI ask
timeouts, no reply after cancel, no elicitation. Rejected: restrict-only locks (one human owns every
layer), progress keep-alives.

## Process notes (tagged learnings, 44 bullets in `.autoloop/learnings.md`; highlights)
- [build-and-verify] A background `cmd; echo exit=$?` notification reports 0 even when `cmd` failed —
  read the captured `exit=` line.
- [CLAUDE.md candidate] `grammar-linear.test.ts` timing asserts fail under concurrent load; run the
  full verify on an idle machine.
- [CLAUDE.md candidate] A "focus stays put" e2e must park focus somewhere the action can hide.
- [runtime-qa] Hidden Electron windows throttle rAF (~700 ms/frame): measure latency in the page; use
  `page.clock` to capture sub-second states.
- [review] A pager kept as an index into a live list is a consent hazard; key by id and guard swaps.
- [implementation-plan] Plans written before their dependency is built need a re-bind pass against the
  real code (Part B's arch review found 7 mismatches).
- Codex/OpenCode sessions weren't connected, so Claude subagents did the building and reviewing
  (deviation from the cheap-agents preference, recorded in goal.md).
