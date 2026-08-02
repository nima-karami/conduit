# Ledger — 2026-08-01 state vocabulary + chrome polish

Source of truth for this run. Re-read after any compaction before acting.
Status is one of: `queued` / `building` / `verified` / `landed <sha>` / `blocked`.

Base: `bcf0d15` (v0.25.1), main, clean.

| ID | Lane | Tier | Deps | Status | Evidence |
|---|---|---|---|---|---|
| V | Interaction state vocabulary | FULL | — | building | worktree `.claude/worktrees/V`, branch `feat/state-vocabulary` |
| I | Theme-coupled chrome icons | FULL | — | **landed `fb48cc3`** | build `7071e7a`; merged tree verify exit 0, 2511 tests |
| C | Content-tier icon sharpening (Neon) | LITE | I, V | queued | from blocker I-2, ratified |
| S | Remove collapse-sidebar button | LITE | — | **landed `7da0a11`** | build `beac69f`; merged tree verify exit 0, 2386 tests |
| B | Band baseline alignment | LITE | V | queued | |
| P | Omni-search session state affordance | FULL | V | queued | |
| R | Aero pill radii | LITE | V | queued | |
| G | Neon branch picker consistency | FULL | V | queued | |

## Findings carried in from the Phase-0 audit

These are established facts, already verified against the tree. Lanes must fix the
named root cause, not the symptom.

**Hover census** — 27 distinct hover fill values across ~72 fill-changing hover
rules. `--raise` (19), `--panel-2` (18), `--accent-soft` (17) are used
interchangeably for the same kind of surface.

**Dead token** — `styles.css:9574` `.imgstage__btn:hover { background: var(--hover); }`
references `--hover`, which is defined nowhere and has no fallback. The rule is
invalid at computed-value time and paints nothing.

**Missing hover** — `.rtab` (Files/Changes) and `.palette__row` (omni results) have
no `:hover` rule at all.

**Disabled** — eight treatments: `0.3 / 0.35 / 0.4 / 0.45 / 0.6 / 0.7`, colour-only,
background-swap.

**Cascade defect** — `.filerow--revealed` (`:5275`) follows `.filerow--selected`
(`:5258`) at equal specificity, so a row that is both loses the selected fill.

**Branch menu inversion** — the *current* branch row is rendered `disabled`
(`branch-switcher-menu.tsx:193-195`), so `.ctxmenu__item:disabled` paints it
`--text-faint`: the selected item is the dimmest row in the menu.

**Band alignment — two independent root causes.**
1. `.panel` carries `border: 1px solid var(--border)` (`:553`) but the centre
   column is deliberately not a panel (`.center` `:1882`, `.termwrap` `:3256` — both
   borderless). So `.sidebar__head` and `.right__tabs` start at `Y+1` while
   `.tabbar-wrap` starts at `Y+0`. The side bands are exactly 1px low.
2. `--density-topbar-h: calc(var(--density-band-h) * 1.5)` (`:647`) with Compact's
   `--density-band-h: 31px` (`:705`) yields **46.5px** — a half-pixel origin for the
   entire workbench, so every 1px hairline below it straddles two device rows and
   antialiases to a smeared ~2px line.

**Pill radius already exists** — `--r-round: 999px` (`:66`), squaring to `0px` in
Neon (`:264`). Lane R reuses it; it must not introduce a new token. Note the
segmented-control nesting maths: `.viewswitch` track is `--r-ctl` with `2px`
padding, so the inner chip needs `outer − padding`, not `--r-badge`.

**Palette session rows** — `app.tsx:1964-1971` builds entries with a hardcoded
`<IconTerminal size={14} />` and no state at all; `PaletteEntry`
(`command-palette.tsx:6-16`) has no field to carry it. `sessionIconState()` and
`SESSION_STATE_WORD` already exist in `src/session-icon.ts:38-58` and are ready to
wire in. `activeId` is already in the memo's dependency list but unused for
sessions.

**Collapse-sidebar button** — `top-bar.tsx:120-127`, a bare `.iconbtn` with no state
class, no `aria-pressed`, and a glyph that does not change. The Explorer has no
button at all. Both panels already toggle via the command palette
(`app.tsx:2093-2108`), a context menu bound in three places (`app.tsx:1854-1866`),
and `Mod+B` / `Mod+Shift+E` (`shortcuts.ts:64-70`). Panels can be re-docked left or
right by dragging (`dock-reorder.ts`), which is what makes a fixed "collapse the
left one" button incoherent.

## Decisions

- **D1** Accent means state, never pointer proximity. Hover is a neutral wash
  everywhere. This is the rule that resolves most of the reported inconsistency.
- **D2** Three roles (quiet / field / solid), applied via `:where()` selector lists
  in one section of `styles.css` — zero specificity, so genuine per-component
  deviations still override without a specificity fight, and component files stay
  untouched except where a state is inexpressible in the current DOM.
- **D3** "On/armed" (outline tint) and "selected" (tinted fill + spine) are
  different looks for different meanings. Solid accent fill is reserved for
  segmented-control active chips and `--primary` buttons.
- **D4** A guard test enforces the census. Without it the sheet rots back — that is
  precisely how it reached 27 hover values.

## Ratified forks

- **I-1 — Compare redrawn onto the 16 grid: KEEP.** The chrome tier's premise is
  hand-authored 16-grid glyphs; a Lucide component inside it was the anomaly, and it
  was the one glyph no theme could reshape. Removing the `.icon--lucide` stroke
  rescale and its magic factor is a bonus. Revert path stays recorded in
  `blockers.md`.
- **I-2 — content tier stays Lucide, but gets sharpened: ACCEPTED as lane C.** The
  persisted contract covers *names*, not rendering, so a Neon-only CSS pass over
  caps/joins/`rx` sharpens the content tier without touching what `iconOverride`
  writes to `sessions.json`. A family swap remains forbidden.

## Conductor-owned follow-ups

- **CHANGELOG.** Lane S correctly declined to write one: `CHANGELOG.md` has no
  `[Unreleased]` section, so five lanes editing the same head would conflict every
  time. The conductor folds all lanes into one entry at release.
- **Biome CSS warnings.** Main carries 12 pre-existing "descending specificity"
  warnings (non-gating). Lane V rewrites large parts of the sheet — check the count
  does not grow, and prefer to reduce it, but do NOT let it become a reason to
  escalate specificity.

## Blockers

None yet. See `blockers.md`.
