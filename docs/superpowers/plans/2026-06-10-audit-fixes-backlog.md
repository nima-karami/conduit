# Audit-fixes backlog (Agent Deck)

> Fully-autonomous, depth-first. Skill: `deep-feature-build`. Branch: `audit-fixes`
> (off main). Per item: design doc → full implementation (incl. hard core) → verify
> (typecheck + build + vitest + preview/CDP) → commit → next. These are the gaps an
> audit found after the F1–F9 build shipped some things partial/missing.

## Status: [ ] todo  [~] wip  [x] done

### T1 — Themeable terminal  [x]
xterm theme + font hardcoded in TerminalPane. Make terminal colours + mono font
follow the selected theme/font settings, updating live on change.

### T2 — Real WebGL shader background  [x]
Add a genuine GLSL/WebGL fragment-shader background mode (flowing noise/plasma),
beyond the 2D-canvas Flow. Theme-coloured, intensity-aware, perf-aware.

### T3 — Configurable session-card roles  [x]
Let the user choose which field is the title / subtitle / detail (and card style),
not just per-field visibility. Live preview.

### T4 — Set/rebind shortcuts  [x]
Real keybinding editing in Settings → Shortcuts: capture keys, persist, detect
conflicts, reset to default. The actual key handling must read from the persisted
bindings (refactor App's hardcoded keydown to a data-driven matcher).

### T5 — Go-to-definition  [ ]
Enable Monaco's TS/JS language worker; register/enable go-to-definition + peek for
open files (cross-file where models are loaded).

### T6 — Split panes  [ ]  (biggest, last)
View multiple terminals/sessions at once: split the center work area into panes,
not just tab switching. Persisted split layout.

## Notes
- Each feature: `docs/superpowers/specs/2026-06-10-tN-<name>.md`.
- Keep typecheck/build/tests green; commit per item. Don't push/merge (user reviews).
- See skill `deep-feature-build`, memory [[feedback-deep-feature-build]], [[overnight-features]].
