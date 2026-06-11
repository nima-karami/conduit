# Autonomous build-loop — run report (2026-06-11)

Drove the Conduit wishlist (`docs/wishlist.md`, groups A–G) to verified completion via
the autonomous build-loop. **31 items shipped, 0 blocked.** Each ran in a fresh-context
subagent (spec → build → verify); LITE items built straight from spec, FULL items got a
plan + code-review pass. Every item was verified behind `npm run verify` + `npm run build`
and, for UI, exercised with Playwright (screenshots to temp, never committed).

- **26 items merged to `main`** (one feature per commit), tip `675da41`, `npm run verify` green.
- **5 north-star items on `autoloop/conduit-northstar`** (5 commits ahead of main, **NOT merged**),
  tip `71267e4`, `npm run verify` green — a disposable exploration for review; discard the
  branch and `main` is unaffected.
- Unit tests grew **83 → 215** on main (**→ 304** on the northstar branch).

## Shipped to `main` (26)

| Item | Commit | What |
|---|---|---|
| C1 editor-padding | `acb0e24` | Editor fills its container; padding band removed |
| A2 md-reflow | `af5e4c5` | Markdown viewer reflows full-width on sidebar collapse |
| C2 editor-bg | `658d9e9` | Editor background follows theme `--bg` (matches markdown) |
| C4 terminal-padding | `c0d4cae` | Terminal flush to its container (xterm fit preserved) |
| E2 word-wrap | `7be97de` | Alt+Z word-wrap toggle + setting + command |
| E3 tab-containment | `82e0889` | Editor tab strip clips + scrolls; no Explorer overlap |
| E4 link-handling | `5add3fa` | Links open non-destructively (host guards + openExternal) |
| F2 minimap | `4efe19e` | Canvas minimap renders nodes + tracking viewport |
| F3 edge-labels | `9eb9af4` | Add/edit text labels on canvas edges |
| G2 board-copy | `774ad80` | Duplicate a board card |
| G5 board-dates | `b5ffe29` | Created/updated timestamps on cards |
| menu-system | `06c11e5` | Hardened shared ContextMenu (clamp, keyboard, ARIA) |
| F1 canvas-ctx-menu | `095cf91` | Node + pane context menus on the canvas |
| G1 board-ctx-menu | `3c0c498` | Card + column context menus on the board |
| E5 ctx-menu-overhaul | `c5675d7` | Editor menu → shared menu + essential actions |
| A1 view-switcher | `0b027bd` | Top-bar switcher; mutually-exclusive views (no stacking) |
| D3 session-meta | `e522c78` | Repo-first naming + lastActiveAt + sort + tab display |
| D1 sort-filter-menu | `e6d34e8` | Sessions sort/filter in a three-dot dropdown |
| B1 drag-handles | `4038588` | Drag panels from the bar; handle widgets + grab-hand gone |
| D2 group-reorder | `f046059` | Drag whole project groups; sessions move together |
| D4 runtime-icon | `a0f2503` | Agent/shell-derived icon on each session tab |
| D5 busy-indicator | `b328bbc` | Busy + needs-attention states; float-to-top |
| C3 transparency | `6bb368d` | Panel 0–100% + granular code-block styling |
| F4 canvas-kinds | `1f5e1d6` | 11 architectural node kinds + per-kind icons + migration |
| E1 goto-def | `3684195` | TS-worker warm-up + loading state (latency) |
| A3 collapse-explorer | `675da41` | Hide Explorer; panel-toggle menu + palette commands |

Plus capture/chore commits (wishlist A2–A3/C4 captures, `.autoloop` gitignore).

## North-star — on `autoloop/conduit-northstar` (5, NOT merged — review & keep-or-discard)

Built last, isolated, per the user's instruction ("something to look at tomorrow; if I don't
like the direction we can throw it away"). They share one `.conduit/` foundation, so they
accumulate on one branch rather than merging individually.

| Item | What |
|---|---|
| conduit-adr | ADR 0002: `.conduit/` artifact format + ownership model + shared persistence layer |
| F0 conduit-canvas | Architecture canvas persists to `.conduit/architecture.json` (legacy migration) |
| G0 conduit-board | Feature board → per-project `.conduit/board.json` + live external-edit watcher |
| G3 board-spec-docs | Cards tie to `.conduit/specs/<id>.md` (traversal-safe) + spec editor |
| G4 board-skill-transitions | `.conduit/pipeline.json` transition→skill map; surfaces on move |

**Key design decision (ADR 0002, pressure-tested by architecture-critic):** `.conduit/` is a
**human-owned source of truth the agent *proposes* to — never blind-overwrites.** The
committed root `board.json` (the overnight agent's surface) is left untouched; convergence is
deliberately deferred. The agentic-board "skill on transition" **surfaces/records** the hook —
Conduit can't execute a Claude skill, so an external agent drains `.conduit/pipeline-queue.json`.
> Note: the northstar branch also edits `CLAUDE.md` (the root-`board.json` gotcha goes stale if
> the app stops using it). That change lives only on the branch — discarding the branch reverts it.

## Decisions taken autonomously (recorded, not asked)

- **E1 go-to-def:** kept the custom worker-backed action (CLAUDE.md: native goto doesn't reliably
  bundle under esbuild); solved the *actual* pain (5–10s cold start) by warming the TS worker.
- **D4 runtime-icon:** mapped the session's known launch spec to an icon; live PTY child-process
  detection deferred (fragile on Windows).
- **D5 busy:** "done" = output quiescence after activity; float-to-top only on non-manual sorts.
- **A2 md-reflow:** full-width (over centered) per the user's stated preference.

## Needs manual confirmation in the real Electron app

The browser preview can't exercise the host bridge / PTY / FS. These were unit- + build- +
typecheck-verified and (where possible) host-temp round-tripped, but the live loop wants a
hands-on pass:
- **E1:** the 5–10s→fast latency on a fresh *large* repo (preview's mock project is trivial).
- **D4/D5:** the full PTY output → busy → idle → attention → focus-clears loop.
- **E4:** external-link open via `shell.openExternal` (no main process in preview).
- **F0/G0/G3/G4 (northstar):** live `.conduit/*` IPC round-trips + the board file-watcher
  reflecting an external agent's edit.
- **B1:** a real panel drag-drop re-dock + tab reorder (HTML5 DnD drop isn't fully scriptable).

## State

- Ledger: `.autoloop/` (gitignored) — `tasks.yaml` all `done`, `blockers.md` empty (nothing quarantined).
- Not pushed (local commits only) — awaiting the user's go to push `main` and/or the northstar branch.
