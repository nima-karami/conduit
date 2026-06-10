# Deep Build Backlog (Agent Deck)

> **Mode:** fully autonomous, depth-first. Skill: `deep-feature-build`. Branch:
> `overnight-features`. For EACH feature: write a full design doc → implement to
> the design's acceptance criteria (incl. the hard core) → verify (typecheck +
> build + vitest + preview/CDP screenshot) → commit → next. Do NOT ship stubs.
> Remote `origin` = github.com/nima-karami/agent-deck (push blocked for agent; user pushes).

This run REPLACES the shallow baseline (commits df882b1..a54f2b3) with deep versions.
Original list order, with the user's 2026-06-10 refinements folded in.

## Status: [ ] todo  [~] in progress  [x] done

### F1 — Settings + customization cleanup  [x]
- Remove the agents/skills/instructions/hooks/mcp customization buttons entirely
  (not needed for now). Reclaim that sidebar space.
- Deepen Settings: real, useful settings beyond appearance (behaviour/general),
  organised; persisted. Design doc enumerates the full set.

### F2 — Working app chrome / navigation  [x]
- Fix collapse-sidebar button (topbar) — actually collapse/expand the left panel.
- Fix back/forward buttons — real navigation history across opened docs/sessions.
- Design doc defines the history model (what back/forward traverse).

### F3 — Configurable session cards  [x]
- Not just 3 presets: per-field visibility + control over what each card shows
  (title, subtitle, agent, time, path, git stat, status, icon…), with ordering/
  density. Design doc defines the field model + the settings UI for it.

### F4 — Command palette depth  [x]
- Beyond fuzzy file/session: recents, richer command set, content/symbol search,
  scoping, better keyboard model. Design doc defines modes + ranking.

### F5 — Context menus depth  [ ]
- Full action sets for sessions, tabs, files, changes; consistent; wired to host.

### F6 — Drag & drop: reorder sessions + tabs  [ ]
- Sessions reorderable (within/between project groups); tabs reorderable.
  Persisted order. Design doc defines DnD model + persistence.

### F7 — Configurable dockable layout  [ ]  ← the flagship miss
- Drag panes into different slots / dock positions; resize (already done) + move +
  rearrange. Persisted layout. Design doc defines the slot/dock model.

### F8 — Animated background depth  [ ]
- Real depth: WebGL/shader option + richer modes, configurable intensity/colours,
  performance-aware. Design doc defines modes + controls.

## Notes
- Each feature gets its own design doc: `docs/superpowers/specs/2026-06-10-fN-<name>.md`.
- Commit per feature with a clear message; keep typecheck/build/tests green.
- See skill `deep-feature-build` + memory [[feedback-deep-feature-build]].
