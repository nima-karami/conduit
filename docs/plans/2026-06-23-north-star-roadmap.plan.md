# North-Star roadmap — what to build next

Date: 2026-06-23 (rev 2) · Baseline: `main` @ v0.8.3

A prioritization of the **parked / vision / deferred** work across the specs, ranked by
leverage toward Conduit's North Star (tempered by the near-term daily-driver lens). Sources:
ADR 0002, the archived-spec deferral harvest, and [[conduit-daily-driver-goal]].

This is a **living pointer**, not a commitment — when a tier is picked up it gets a real spec
(`docs/specs/`) and/or implementation plan. Delete/replace entries as they ship.

## North Star (the lens)

Conduit = a beautiful desktop **control tower for running and collaborating with multiple CLI
coding agents**, where project knowledge (architecture, board, specs) is a **living artifact
humans and agents co-edit** through the human-owned / agent-proposes loop (ADR 0002). Near-term
lens: **make it the daily driver.**

## Abandoned — the agent chat surface (2026-06-23)

The chat-UI family (agent chat UI + skill installer + interactive plans, built on the now-deleted
`chat-ui` branch) was **discarded**. It drove Claude Code via the **Agent SDK**, which requires a
billed `ANTHROPIC_API_KEY` and **cannot use a Claude Pro/Max subscription** (Anthropic bars
subscription OAuth from the SDK — ToS, Feb 2026). The whole point was a UI on the *subscription*,
which the SDK can't deliver. Only revisitable via a raw `claude` **CLI** adapter (subscription
auth; ToS gray area for redistribution). Branch tip recoverable at `aa27476`. See
[[conduit-chat-ui-run]].

## Priorities

### P1 — Close the round-trip: generate project knowledge from the repo

ADR 0002's end-state. The proposal loop (agent proposes → human accepts) already ships for board
+ architecture; the **missing half is the agent _drafting_ architecture/board from the codebase**
(generate-from-repo). Uniquely Conduit, and it works on the subscription/offline model (the agent
writes a file; Conduit renders + round-trips it).

- **Generate-from-repo** — agent reads the tree and writes a `*.proposed.json` architecture/board
  for human accept/reject. No spec yet → first candidate for `/feature-spec`.
- **G0** — converge Conduit's own root `board.json` onto `.conduit/` (deferred in ADR 0002 §3).

### P2 — Daily-driver reliability finishers  ·  *cheap trust wins*

- **Multi-window layout persistence across restart** — which session in which window + geometry
  (deferred in the multi-window spec; v1 restores all into one).
- **Live foreground-process / output-driven busy detection** (D5 + the runtime-icon "live PTY
  process detection" vision) — makes attention routing *accurate*, not just heuristic.

### P3 — "Live in it" editor depth

Table stakes for replacing a real editor in daily use:

- **Fuzzy file search (Ctrl+P)** (file-browser spec deferral).
- **Project-wide go-to-definition** via the TS language worker (goto-def vision).
- **Per-file git history / blame**, commit compare / range diff (history-tabs non-goals).
- **Per-session document tabs** (file-browser spec: v1 keeps a single shared set).

### P4 — Polish / vision tail

Lower leverage; pick up opportunistically:

- Menu **submenus** (menu-system deferral) + a pure `orderMenuItems(groups)` helper
  (context-menu-consistency vision).
- **Type-to-filter** in themed dropdowns (git-ref-dropdown, path-link disambiguation).
- Image **pan/zoom** beyond fit/1:1; PDF niceties (links, password, remembered zoom).
- **Code signing + macOS notarization** — also unblocks mac auto-update (macos-test-build
  vision). See [[conduit-electron-builder-win-signing-config]].

## Recommendation

**Start with P1 (generate-from-repo).** With the chat surface off the table, it's the
highest-leverage North-Star item *and* it fits the subscription/offline model (no metered API).
Spec it via `/feature-spec` first.
