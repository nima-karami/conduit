# North-Star roadmap — what to build next

Date: 2026-06-23 · Baseline: `main` @ v0.8.3

A prioritization of everything **parked / vision / deferred** across the specs,
ranked by leverage toward Conduit's North Star (tempered by the near-term
daily-driver lens). Sources: the three active specs (`docs/specs/`), ADR 0002,
the archived-spec deferral harvest, and [[conduit-daily-driver-goal]].

This is a **living pointer**, not a commitment — when a tier is picked up it gets a
real spec (`docs/specs/`) and/or implementation plan. Delete/replace entries here as
they ship.

## North Star (the lens)

Conduit = a beautiful desktop **control tower for collaborating with multiple CLI
coding agents** — where agents aren't raw terminals but **structured, steerable
conversations**, and project knowledge (architecture, board, specs, plans) is a
**living artifact humans and agents co-edit** through the human-owned /
agent-proposes loop (ADR 0002). Near-term lens: **make it the daily driver.**

## The key finding

The single biggest leap toward that North Star is **already built — and rotting.**

The `chat-ui` branch (~32 commits) contains the entire agent-collaboration pivot,
fully specced + unit-tested + smoke-tested:

- **agent-chat-ui** — structured turns, rich tool cards, inline approvals, Auto
  mode, skills picker, transcript resume (`docs/specs/2026-06-17-agent-chat-ui.md`).
- **skill-installer** — bundled skills → `.claude/skills/`
  (`docs/specs/2026-06-17-skill-installer.md`).
- **interactive-plans** — commentable, round-tripped `.conduit/plan.json`
  (`docs/specs/2026-06-17-interactive-plans.md`).
- **T2 scrollback persistence** across restart (a daily-driver reliability item).

That branch is now **~144 commits behind `main`**. It is blocked on the unresolved
**D-2 integration decision**, and the merge cost grows every day it sits. This is
the central fact the roadmap is built around.

## Priorities

### P0 — Land the agent chat surface  ·  *built; decision-blocked, not work-blocked*

This **is** the North Star pivot: terminal multiplexer → agent collaboration
surface. The work is done; what's missing is the call to integrate it and pay down
the 144-commit drift on `chat-ui`. Highest leverage by a wide margin.

- **Action:** resolve D-2 → produce an integration plan → merge the chat-ui family
  (chat UI + skill installer + interactive plans + scrollback) into `main`.
- **Net-new follow-ons once landed** (designed seams, additive):
  - **Codex adapter** — implements the existing `ChatAdapter`; translates
    `codex exec --json` JSONL ↔ the normalized `ChatEvent` union.
  - **Interactive option-buttons** — the `interactive_prompt` / `prompt_response`
    seam reserved in the chat-ui spec §10; renders agent-offered choices as buttons.

### P1 — Close the round-trip: generate project knowledge from the repo

ADR 0002's end-state. The proposal loop (agent proposes → human accepts) already
ships for board + architecture; the **missing half is the agent _drafting_
architecture/board from the codebase** (generate-from-repo). Uniquely Conduit, and
it compounds with P0 (an agent in chat proposes a canvas/plan).

- **Generate-from-repo** — agent reads the tree and writes a `*.proposed.json`
  architecture/board for human accept/reject. No spec yet → first candidate for
  `/feature-spec`.
- **G0** — converge Conduit's own root `board.json` onto `.conduit/` (explicitly
  deferred in ADR 0002 §3: teach the overnight agent the proposal flow, exempt the
  own-repo board, or dual-write during transition).

### P2 — Daily-driver reliability finishers  ·  *cheap trust wins*

- **Multi-window layout persistence across restart** — which session in which
  window + geometry (deferred in the multi-window spec; v1 restores all into one).
- **Live foreground-process / output-driven busy detection** (D5 + the
  runtime-icon "live PTY process detection" vision) — makes attention routing
  *accurate*, not just heuristic.
- (Scrollback restore rides in with P0.)

### P3 — "Live in it" editor depth

Table stakes for replacing a real editor in daily use:

- **Fuzzy file search (Ctrl+P)** (file-browser spec deferral).
- **Project-wide go-to-definition** via the TS language worker (goto-def vision).
- **Per-file git history / blame**, commit compare / range diff (history-tabs
  non-goals).
- **Per-session document tabs** (file-browser spec: v1 keeps a single shared set).

### P4 — Polish / vision tail

Lower leverage; pick up opportunistically:

- Menu **submenus** (menu-system deferral) + a pure `orderMenuItems(groups)` helper
  (context-menu-consistency vision).
- **Type-to-filter** in themed dropdowns (git-ref-dropdown, path-link
  disambiguation).
- Image **pan/zoom** beyond fit/1:1; PDF niceties (links, password, remembered
  zoom).
- **Code signing + macOS notarization** — also unblocks mac auto-update
  (macos-test-build vision). See [[conduit-electron-builder-win-signing-config]].

## Recommendation

**P0 first.** It is simultaneously the highest-value item *and* already built;
leaving it to rot on a stale branch is the worst available outcome. Everything in
P1–P4 is more valuable *after* the chat surface exists on `main`.
