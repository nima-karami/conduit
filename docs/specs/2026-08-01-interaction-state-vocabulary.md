---
status: active
date: 2026-08-01
---

# Interaction state vocabulary

## Problem

State is expressed ad hoc, per component, by whoever wrote it. An audit of
`webview/styles.css` (10,104 lines) found:

- **27 distinct hover fill values.** The top three (`--raise`, `--panel-2`,
  `--accent-soft`) cover 54 of ~72 fill-changing hover rules but are used
  interchangeably for the *same kind* of surface: `.tab:hover` is `--panel-2`
  while `.filerow:hover` is `--raise`; `.iconbtn:hover` is `--raise` while
  `.tabbar__overflow-btn:hover` — visually the same icon button in the same row —
  is `--panel-2`; `.git-indicator__*:hover` is `--accent-soft` while the branch
  chip beside it in the same band is `--panel-2`.
- **8 distinct `:disabled` treatments**: opacity `0.3 / 0.35 / 0.4 / 0.45 / 0.6 /
  0.7`, colour-only, and background-swap. Only four components neutralise
  `:disabled:hover`.
- **Surfaces with no hover at all**: `.rtab` (Files/Changes — the only tab-like
  surface in the app without one) and `.palette__row` (the omni-search results —
  the app's primary search surface).
- **No pressed state anywhere.** Every `:active` in the sheet is a `cursor` change.
- **`--hover` is referenced but never defined** (`.imgstage__btn:hover`), so that
  rule is dead.
- **Toggles that cannot express "on"**: `.iconbtn` has no on-state, so the
  collapse-sidebar button looked identical collapsed or expanded.
- **Three dropdown triggers with no open-state** (`git-indicator__branch`,
  `gh__reffilter`, `repo-picker__trigger`); only `.selectfield--open` has one.
- Ten focus treatments bypass `--focus-ring` for a bespoke
  `outline: 2px solid var(--accent)`.

The result is what the user reported: hovering the view switcher darkens, hovering
the git-band icons goes neon, hovering the right-pane tabs does nothing, hovering an
editor tab only brightens text, hovering a file row fills grey, and hovering a
palette row goes neon. Six surfaces, six answers.

## The vocabulary

Two ideas carry the whole design.

**1. Accent means state, never pointer proximity.** Hover is a neutral wash. It
says "the pointer is here", nothing more. Accent is reserved for *what the app is
actually doing* — what is selected, current, or armed. This single rule resolves
most of the inconsistency above: the git-band icons going neon on hover was
spending the accent colour on a mouse position.

**2. Three roles, one ladder each.** Every interactive surface is exactly one of:

| Role | Rest | Meaning |
|---|---|---|
| **quiet** | transparent | rows, tabs, icon buttons, menu items — things that live inside a surface |
| **field** | bordered | inputs and dropdown triggers — things you type in or open |
| **solid** | filled | the one primary action in a view |

### States

| State | quiet | field | solid |
|---|---|---|---|
| rest | `background: transparent`, `color: --text-dim` | `background: --raise`, `border: --state-edge` | `background: --accent`, `color: --on-accent` |
| hover | `background: --state-hover-bg`, `color: --state-hover-fg` | `border-color: --state-edge-hover` | `background: --accent-2` |
| press | `background: --state-press-bg` | `border-color: --state-edge-open` | `filter: brightness(0.94)` |
| selected / current | `background: --state-sel-bg`, `color: --state-sel-fg`, spine | — | — |
| selected + hover | `background: --state-sel-hover-bg` | — | — |
| open (menu showing) | — | `border-color: --state-edge-open` | — |
| on / armed | `color: --state-on-fg`, `border-color: --state-on-fg`, fill unchanged | — | — |
| disabled | `opacity: --state-disabled-o`, no hover response | same | same |
| focus | `box-shadow: var(--focus-ring)` — no exceptions | | |

Two distinct "engaged" looks, deliberately kept apart:

- **on / armed** is an outline tint — accent glyph and accent edge over an
  unchanged fill. This is `.search__filterstoggle--on`, which the user cited as
  the reference. It reads as engaged without becoming a chip that competes with
  its neighbours. Use it for independent toggles.
- **selected** is a tinted fill plus, for a row in a list, a 2px accent spine.
  Use it for "this is the current one of N".

Solid accent fill is reserved for the active chip of a segmented control
(`.viewswitch__btn--on`, `.seg__btn--active`) and for `--primary` buttons. Nothing
else earns a solid accent fill.

### Tokens

Defined once in `:root`, retuned per theme. These are the *only* values a state
rule may use.

```css
--state-hover-bg
--state-hover-fg
--state-press-bg
--state-sel-bg
--state-sel-fg
--state-sel-hover-bg
--state-on-fg
--state-edge
--state-edge-hover
--state-edge-open
--state-disabled-o
--state-spine        /* width of the selected-row accent marker */
```

Theme retuning is where the personality lives, and it is the *only* place a theme
gets a say. Aero washes neutral; Neon tints its washes toward accent and adds glow
to the on/selected steps. Neither theme may introduce a new state *concept* — only
new values for these.

### Mechanism

The vocabulary is applied through `:where()` role selector lists in one dedicated
section of `styles.css`, not by adding classes across every component. `:where()`
contributes zero specificity, so the vocabulary is a floor that a genuine
per-component deviation (a danger menu item, the window close button's red) still
overrides naturally, without a specificity fight.

Components are edited only where a state is genuinely **inexpressible** in the
current DOM — e.g. `.iconbtn` gains an `--on` modifier and `aria-pressed`.

### Enforcement

`test/unit/state-vocabulary.test.ts` parses the stylesheet and fails on:

1. a `:hover` rule whose `background` is not one of the state tokens (allow-list
   for the named deviations),
2. more than one `:disabled` opacity value,
3. any `--state-*` token referenced but not defined,
4. any role-list surface missing a hover rule,
5. a bespoke `outline: …px solid var(--accent)` on `:focus-visible`.

The rules above are not style advice; without the test they rot back within a
release, which is exactly how the sheet reached 27 hover values.

## Non-goals

- Renaming existing BEM classes.
- Changing what any surface *does*; this is purely how state is expressed.
- Reworking the colour palette. Tokens re-point at existing palette values.
