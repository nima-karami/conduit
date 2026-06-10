# F8 — Animated background depth

## Goal
Give the animated background real depth: a genuinely rendered (canvas) flowing
mode beyond the CSS gradients, plus configurable intensity, theme-driven colours,
and performance-awareness.

## Modes
Keep `none / aurora / mesh / grid` (CSS). Add **`flow`**: a 2D-canvas animation of
soft, drifting, theme-coloured gradient orbs (richer + actually rendered).

## Intensity
New setting `bgIntensity: 'subtle' | 'balanced' | 'vivid'` (default balanced).
- CSS modes: scales blob opacity via a `--bgfx-mul` multiplier.
- Flow mode: scales the per-orb alpha.

## Component `AnimatedBg`
Replaces the bare `<div className="bgfx">`. Reads settings:
- `background === 'none'` → render nothing.
- CSS modes → the `.bgfx` div with the intensity multiplier.
- `flow` → a `<canvas>`; rAF loop draws N drifting radial-gradient orbs using
  theme colours read from CSS vars (`--accent`, `--blue`, `--violet`).
- **Perf:** pause the loop on `document.hidden`; honour `reduceMotion` (flow renders
  nothing, CSS modes already halt animation); recompute colours when theme changes.

## Settings UI
- Background segmented adds **Flow**.
- New **Background intensity** segmented (Subtle / Balanced / Vivid), shown only when
  a background is active.

## Acceptance criteria
1. Selecting Flow shows a moving canvas of themed orbs; colours follow the theme.
2. Intensity changes the visible strength for both CSS and flow modes.
3. reduceMotion disables flow (and halts CSS animation, already wired).
4. Animation pauses when the window/tab is hidden.
5. settings persist; typecheck + build + tests green.
