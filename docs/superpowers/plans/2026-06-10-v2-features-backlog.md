# Agent Deck v2 features — backlog (resumption anchor)

Branch: `v2-features` (off `main`). Autonomous multi-hour build. Plan each feature in
depth (design notes below) BEFORE implementing it; commit per feature after
typecheck + build + vitest pass. This file is the resumption anchor — read first.

User request (2026-06-10), three groups:

## Group 1 — visual fixes
- **F1 Editor tabs**: make doc tabs read as real tabs (seated on the editor edge),
  not floating cards.
- **F2 Background blur/transparency**: the animated background is invisible. Cause:
  `.center`/`.termwrap` are opaque `var(--bg)`; side panels use hardcoded
  `blur(7px)` at 80% opacity. Add user settings for blur amount + surface opacity;
  apply across panels, center chrome, tabbar, topbar, and the xterm terminal
  (`allowTransparency`) so the bg actually shows through.
- **F3 Go-to-definition**: two "Go to Definition" entries in the editor context menu
  (Monaco built-in + our worker-backed custom one). Consolidate to ONE working
  entry by suppressing the built-in duplicate. Keep cross-file working.
- **F4 Movable panes**: sessions & explorer re-dock, but center (terminal/editor)
  can't — it has no drag grip. Give CenterPane a grip wired to
  `dockHandlers('center')` so all three regions swap slots. (moveBefore + layout
  already support any permutation.)

## Group 2 — sessions pane
- **F5 Cross-dir drag + sort/filter**: drag/drop is constrained to one project
  group (`dragGroup.current === groupPath`) and the grouped render snaps cards
  back. Redesign Sidebar: toolbar with filter input + sort (Manual/Name/Recent/
  Status/Project) + group-by-project toggle; flat orderable list so cards drag
  across directories. Host `reorderSessions(order)` already reorders globally.

## Group 3 — architecture canvas (BIG)
- **F6**: visual, editable, NESTED architecture diagram — like Pencil.dev but for
  software architecture; visual-programming feel (Grasshopper). An agent generates
  a high-level box/edge diagram the user can edit; clicking a box drills into a
  nested sub-canvas for that component. Replaces flat-markdown reading of
  architecture. Requires web research (React Flow/@xyflow vs tldraw vs custom),
  brainstorming, a design doc + plan, THEN a deep build. See its own spec under
  docs/superpowers/specs/ when written.

## Status
- [ ] F1 editor tabs
- [ ] F2 background blur/transparency
- [ ] F3 go-to-definition consolidation
- [ ] F4 movable center pane
- [ ] F5 sessions cross-dir drag + sort/filter
- [ ] F6 architecture canvas (research → spec → plan → build)

Constraints: scratch artifacts to `%TEMP%\claude-scratch` only; never commit them;
`git status` clean of scratch before each commit. Commit trailer:
`Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
