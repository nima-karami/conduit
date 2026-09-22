---
status: active
date: 2026-08-08
tier: LITE
type: UI
---

# macOS top bar: traffic lights own the left, identity owns the right

## Problem

The `macos-window-chrome` branch (native traffic lights, hide the custom `.winctl`,
move the logo) was built against an older top bar that had no Workspace/Board/Canvas
switcher and no search pill. Main has since grown both, so rebasing the branch
conflicts, and the branch's own layout (logo/nav crowded near the lights) no longer
fits: on mac today, the native traffic lights render *and* the app's own
minimize/maximize/close buttons still render on the right — a visible duplicate.

## Scope

- **In:** mac-only (`isMac`-gated) rearrangement of `webview/components/top-bar.tsx`'s
  three regions; removing the custom `.winctl` group entirely on mac; exporting
  `isMac` from `webview/shortcuts.ts` instead of `top-bar.tsx` redeclaring it
  (Nima's nit, PR #2); correcting the `trafficLightPosition` y-offset and its stale
  "44px" comment in `electron/main.ts`.
- **Out:** any change to the Windows/Linux layout or its `.winctl` code path; live
  re-centering of the traffic lights when density changes or fullscreen is
  entered/exited (would need new main↔renderer IPC — Nima flagged this as optional
  cosmetic follow-up, not a blocker).

## Design

**`top-bar.tsx`.** Each element becomes a variable computed once, independent of
platform: `logo`, `nav` (back/forward), `viewswitch` (the Workspace/Board/Canvas
segmented control), `attnchipEl` (the "N needs you" chip, `null` when nothing is
waiting). Placement then branches on `isMac` (imported from `shortcuts.ts`, which
gains the export — it's already computed there, just not exported today):

- `topbar__left`: mac → `nav`. non-mac → `logo` + `viewswitch` (unchanged).
- `topbar__center`: unchanged either way — the search omnibar.
- `topbar__right`: mac → `attnchipEl` → `viewswitch` → `logo`. non-mac → `nav` →
  `attnchipEl` → `winctl` (unchanged).

No `winctl` renders at all on mac — the native traffic lights are the only window
controls.

**`styles.css`.** `.topbar--mac` keeps a `padding-left` sized to clear the traffic
lights (tuned visually against real hardware, since the exact value depends on the
light group's rendered footprint). `padding-right` was retuned too, not dropped as
originally planned: the right region's own `gap` alone left the logo sitting closer
to the window edge than the lights sit to the opposite edge, so `padding-right: 16px`
brings the two margins into visual balance (also tuned visually against real
hardware).

**`electron/main.ts`.** `trafficLightPosition: { x: 13, y: 14 }` is commented as
tuned for "the 44px custom top bar", but `--density-topbar-h` at default density
actually computes to `round(38px * 1.5, 1px)` = 57px — the comment and the offset
are both stale. Retune `y` for the real default height and fix the comment to say
so.

## Edge cases

- **Compact density / fullscreen:** the lights will sit slightly off-center in
  compact density (~47px top bar) or when fullscreen hides them entirely (the left
  padding becomes dead space). Deliberately deferred — see Scope/Out. Anyone
  revisiting this should look at `BrowserWindow.setWindowButtonPosition` driven by
  the same `win.onMaximizeChange`-style event pattern already in `top-bar.tsx`.
- **Neon theme:** `:root[data-theme="neon"]` sets `--win-pad: 0` (default is `12px`),
  so the whole shell — including the top bar — sits 12px higher against the window
  edge than the traffic-light offset was tuned for. Same class of cosmetic gap as
  compact density/fullscreen above, deliberately left unfixed for the same reason
  (see that bullet's follow-up pointer).
- **Drag region:** the top bar's `-webkit-app-region: drag` must still cover the
  space between the lights and the first control, and between the last right-side
  control and the window edge — verify by actually dragging the window, not just
  visually inspecting spacing.
- **Windows/Linux:** unaffected — the non-mac branches of `topbar__left`/`topbar__right`
  are the same variables in the same order as before; confirmed by reading the diff,
  not on a Windows machine (none available in this environment).

## Acceptance criteria

- On macOS: traffic lights flush left, back/forward immediately to their right;
  search stays centered; on the right, attention chip (when present), then
  Workspace/Board/Canvas tabs, then the logo flush at the right edge.
- On macOS: no minimize/maximize/close buttons render anywhere.
- Window drag still works from the empty space in the top bar.
- `isMac` has exactly one definition (`shortcuts.ts`), imported everywhere it's
  needed.
- Windows/Linux: unchanged — logo+tabs left, nav+badge+min/max/close right.

## Test plan

This is a CSS/layout change with no new pure logic to unit test. Verification is
manual on real macOS hardware (available in this environment): light centering at
default density, no overlap between the lights and back/forward, drag from the
gaps, tab/badge/logo order and spacing at the right edge. Windows/Linux are
verified by code inspection only (their JSX/CSS branch is untouched) since no
Windows machine is available here.
