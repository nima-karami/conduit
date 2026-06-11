# Spec — Editor padding leak (wishlist C1)

**Tier:** LITE · **Feature type:** UI · **Slug:** `editor-padding`

## Problem frame

- **Job:** When a code file is open, the editor surface must fill its pane edge-to-edge.
- **Symptom:** A band of padding surrounds the Monaco editor; the translucent/dark panel
  background (`--surface`) shows through inside the area that should be the editor.
- **Actor:** Anyone viewing a code file in the center pane.
- **Success:** The Monaco surface is flush to all four edges of its container — no visible
  gap on top/left/right/bottom.
- **Non-goals:** Editor background color/theme (that's C2), panel transparency range (C3),
  terminal styling. The embedded terminal keeps its existing inset.

## Root cause

`.termwrap` (the wrapper shared by the embedded terminal **and** the document viewer in
`webview/components/center-pane.tsx`) carried `padding: 10px 12px 12px`. That inset is
correct for xterm, but `.viewer` (CodeViewer → Monaco) is a sibling inside the same
`.termwrap`, so the editor was inset by the same amount and the translucent `--surface`
background leaked through as a band.

## Behavior & states

- **Document open (code/diff/markdown):** viewer fills `.termwrap` with zero gap.
- **Terminal active:** terminal retains its `10px 12px 12px` breathing room.
- **Split terminals:** each `.termhost` still sits inside the padded stack — unchanged.
- **Empty / stale / exited states:** these render inside the terminal stack and keep the
  padding — unchanged, intentional.

## Fix

Move the padding off `.termwrap` and onto `.termstack` (the terminal-only container) in
`webview/styles.css`. `.viewer` then fills `.termwrap` edge-to-edge; the terminal path is
visually unchanged.

## Edge cases

- Diff and markdown viewers are also `.termwrap` children → they too gain the flush fill
  (markdown keeps its own internal `padding`, so its content margins are unaffected).
- Translucent-background mode (`:root:not([data-background="none"]) .termwrap`) still paints
  the surface behind the editor; Monaco draws its own opaque editor background on top, so no
  band remains.

## Acceptance criteria

- Opening a non-markdown file: `getBoundingClientRect()` of `.monaco-editor` equals that of
  `.termwrap` (same left/top/width/height) — no inset on any edge.
- `getComputedStyle('.termwrap').padding === '0px'`.
- `.termstack` retains `10px 12px 12px` so the terminal is visually unchanged.
- `npm run verify` and `npm run build` both pass.

## Scope

- **MVP = v1:** the one-line CSS relocation above. No settings, no new options.
- **Out of scope:** C2 (editor bg), C3 (transparency), any terminal padding changes.

## Decisions Needed

none
