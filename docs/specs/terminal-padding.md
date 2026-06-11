# Spec — Terminal still inset within its container (wishlist C4)

**Tier:** LITE · **Feature type:** UI · **Slug:** `terminal-padding`

## Problem frame

- **Job:** When a terminal session is active, the xterm surface must fill its pane
  edge-to-edge — flush like the code editor, not floating inside a padded band.
- **Symptom:** The C1 fix made the editor fill its tab but **preserved** the terminal's
  inset by relocating `padding: 10px 12px 12px` from `.termwrap` onto `.termstack` (the
  terminal-only container). The translucent/dark panel background (`--surface`) shows
  through as a band around the terminal.
- **Actor:** Anyone with a running terminal session in the center pane.
- **Success:** The xterm grid sits flush to all four edges of `.termwrap` — no visible
  band leaking the panel background — and the grid still fits correctly (no clipped last
  row/column, no overflow).
- **Non-goals:** Editor padding (C1, already done), editor background (C2), panel
  transparency range (C3), terminal theme/colors, the inner xterm readability gutter.

## Root cause

`.termstack` (terminal-only container, sibling of `.viewer` inside `.termwrap` in
`webview/components/center-pane.tsx`) carries `padding: 10px 12px 12px`. That inset
pushes the terminal in from the `.termwrap` edges, so the translucent `--surface`
background leaks as a band around the xterm grid.

## Behavior & states

- **Terminal active:** xterm fills `.termwrap` edge-to-edge; no band.
- **Split terminals:** each `.termhost` fills the now-flush `.termstack` (split divider
  `border-left` on `.termhost + .termhost` unchanged).
- **Document open:** `.termstack` is `display:none`; `.viewer` already fills flush (C1) —
  unchanged.
- **Empty / stale / exited states:** `.center-empty` / `.stale` are `position:absolute;
  inset:0` overlays painted on `var(--bg)` — they already fill `.termwrap` regardless of
  `.termstack` padding, so removing the inset does not regress them.

## Fit / resize correctness (the critical part)

xterm sizing is driven by `FitAddon.fit()` in `webview/components/terminal-pane.tsx`,
called from a `ResizeObserver` on the `.termpane` element (plus on theme/font change).
Removing the `.termstack` inset enlarges `.termpane`'s laid-out box; the existing
`ResizeObserver` fires automatically and `fit.fit()` recomputes `cols`/`rows` and posts
`term:resize` to the PTY. No new code is required for fit to stay correct — the geometry
change is exactly the kind the observer already handles.

Readability/scrollbar breathing room is preserved by xterm's **own internal** gutter,
`.termpane .xterm { padding: 4px }`, which lives **inside** the xterm viewport (part of
the terminal surface, painted by xterm) and does **not** leak the panel background. This
satisfies the task's preference: any small gutter lives inside xterm, not as a container
padding showing the panel.

## Fix

In `webview/styles.css`, zero the inset on the terminal-only stack: change
`.termstack { padding: 10px 12px 12px; }` to `.termstack { padding: 0; }`. The terminal
then fills `.termwrap` edge-to-edge; the inner `.xterm` 4px gutter and the
ResizeObserver-driven fit are untouched.

## Edge cases & failure modes

- **Hidden pane fit:** `fitIfVisible()` already guards `offsetWidth/Height === 0`, so a
  `display:none` terminal is not fit to garbage; the flush change doesn't alter that.
- **Split mode:** the divider is a 1px `border-left` between `.termhost`s, not padding —
  unaffected; both panes now sit flush to the stack edges.
- **Translucent background mode** (`:root:not([data-background="none"]) .termwrap`): the
  surface paints behind the terminal; xterm honors `allowTransparency`, so the animated
  backdrop shows through the grid itself (intended) rather than as an inset band.
- **Scrollbar:** xterm's `.xterm-viewport` scrollbar (9px) renders inside the flush
  viewport; no horizontal clip because fit sizes cols to the available width.

## Defaults vs. settings

- **Default (only path):** flush, zero container padding. No setting — there is no
  durable user preference to expose for an inset band the user explicitly wants gone.

## Scope slicing

- **MVP = v1:** the one-line CSS change above (`.termstack` padding → 0).
- **Out of scope:** the inner `.xterm` 4px gutter (keep — it's inside the surface), any
  fit-addon refactor, terminal theming, C1/C2/C3.

## Acceptance criteria

- `getComputedStyle('.termstack').padding === '0px'`.
- With a terminal active, `.termhost` (or `.termpane`) `getBoundingClientRect()` matches
  `.termwrap`'s content box on all four edges — no inset band of `--surface` visible
  around the terminal.
- The xterm grid still fits: no clipped last row/column, no overflow; `fit.fit()` runs on
  the resize and `term.cols`/`term.rows` reflect the enlarged box.
- `npm run verify` and `npm run build` both pass.

## Decisions Needed

none
