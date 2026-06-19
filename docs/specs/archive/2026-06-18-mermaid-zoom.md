---
status: implemented
date: 2026-06-18
tier: FULL
type: UI
---

# Zoom / pan a Mermaid diagram fullscreen

## Problem frame

**Job:** Mermaid diagrams in docs are often dense (large flowcharts, sequence
diagrams, ER diagrams). Inline in the doc column they're shrunk to fit width and
become unreadable. A reader needs to open a diagram, zoom in on a region, and pan
around — the way the image viewer already lets them with images.

**Actor:** anyone viewing a `.md` with a non-trivial Mermaid diagram.

**Success:** clicking a rendered diagram opens a fullscreen overlay showing the same
(crisp, vector) SVG; the user can zoom in/out (buttons + wheel), pan (drag + arrow
keys), reset to fit, and close (Esc / backdrop / button). The diagram stays sharp at
any zoom because it's SVG, not raster.

**Non-goals:** editing the diagram; exporting to PNG/SVG file (possible later);
zoom state persistence; pinch-zoom tuning beyond what wheel covers.

## Behavior & states

States: **inline** (current) → **overlay open** (zoom/pan) → **closed** (back to
inline). 

- **Affordance:** the inline diagram gets `cursor: zoom-in` and an explicit
  hover "expand" button (top-right, like the code-block copy button). The expand
  button is the **keyboard path** (real `<button>`, Tab-focusable, Enter/Space opens);
  the diagram SVG itself is a mouse-only convenience click target. (Implementation
  note: making the SVG div a second `role=button` tab stop was rejected — it would
  duplicate the expand button's announcement and add a redundant tab stop, worse a11y
  than one clear button.)
- **Overlay open:** fixed full-viewport layer above the app; dark scrim; the SVG
  centered, transformed by `translate(pan) scale(zoom)`. A toolbar (zoom out, live %,
  zoom in, reset-to-fit, close) sits in a corner.
  - **Zoom:** wheel (fine, 10%) and buttons (coarse, 25%), multiplicative, clamped to
    `[fit, MAX_ZOOM]` — reuse `webview/image-zoom.ts` (`stepZoom`/`clampZoom`/
    `panToKeepPointer`/`zoomPercent`). Wheel zooms toward the pointer.
  - **Pan:** pointer-drag (pointer events) and arrow keys when zoomed beyond fit;
    clamped so the diagram can't be lost off-screen (`clampPan`).
  - **Fit:** initial zoom = fit-to-pane (whole diagram visible, never upscaled past
    1×). Reset returns to fit + centered.
- **Closed by:** Esc, clicking the scrim (not the diagram), or the close button.
  Focus returns to the diagram trigger.

## Data / interface contract

- The SVG's intrinsic size comes from the rendered `<svg>`'s `viewBox` (mermaid always
  emits one); width/height = viewBox w/h. Used as `natural` for fit/pan math.
- New component `webview/components/mermaid-zoom-overlay.tsx`:
  `{ svgHtml: string; onClose: () => void }`. Self-contained zoom/pan state; reuses
  `image-zoom.ts` helpers. Renders the SVG via the same strict-mode
  `dangerouslySetInnerHTML` already audited for mermaid output (securityLevel:'strict'
  — no new injection surface; it's the identical SVG string).
- `MermaidDiagram` gains overlay open/close state and the trigger affordance. The SVG
  string it already holds is passed through unchanged.
- Reusable pure helper if needed: `svgViewBoxSize(svgEl): {w,h}` (unit-testable
  parse of the viewBox attribute) in a small module so the dimension logic is tested
  without a DOM.

## Edge cases & failure modes

- **Diagram still rendering / errored** → no trigger; only a successfully rendered
  SVG is clickable.
- **SVG missing/odd viewBox** → fall back to the element's `getBoundingClientRect`
  or a 1:1 assumption; never crash, never divide by zero (guarded like `fitScale`).
- **Multiple diagrams** → each opens its own overlay; only one open at a time
  (opening is per-instance; the overlay is modal).
- **Very large/wide diagram** → fit scale < 1 so it's fully visible initially.
- **Esc while a terminal/input is focused elsewhere** → the overlay's key handler is
  scoped/active only while open and stops propagation, so it doesn't clash.
- **Reduced motion** → no zoom animation needed; transforms are direct.
- **Scroll lock** → body scroll is locked while the overlay is open, restored on
  close.

## Accessibility / i18n

- Overlay is `role="dialog"` `aria-modal="true"` `aria-label="Diagram viewer"`;
  focus moves into it on open and returns to the trigger on close.
- Every pointer action has a keyboard path (Ctrl/Cmd +/-/0, arrows, Esc) — mirrors
  the image viewer's a11y contract.
- Control buttons have `aria-label`s; live zoom % announced via an `aria-live`
  region. Labels are English (consistent with the app).

## Defaults vs. settings

No setting. Click-to-zoom is always available; fit-on-open is the safe default.
Rationale: matches the existing image-viewer interaction; no divergent preference.

## Scope slicing

- **MVP:** click → overlay; wheel/button zoom; drag/arrow pan; reset-to-fit;
  Esc/scrim/button close; focus management; SVG stays crisp.
- **v1 (optional, only if cheap):** copy-diagram-source / export buttons.
- **Out of scope:** PNG export, persisted zoom, pinch gestures, minimap.

## Acceptance criteria

- AC1: Clicking a rendered diagram opens an overlay containing the same SVG.
  (playwright: click `.mermaid-diagram`, assert `[role=dialog]` + an `svg` inside it)
- AC2: Zoom-in button increases the transform scale (diagram visibly larger);
  the live % updates. (playwright: read % text or transform before/after)
- AC3: Reset returns to fit; Esc closes the overlay and it's removed from the DOM.
  (playwright: press Esc, assert no `[role=dialog]`)
- AC4: Dragging pans the diagram (transform translate changes). (playwright mouse
  drag, assert transform delta)
- AC5: `svgViewBoxSize` parses a `viewBox` string correctly and falls back safely on
  a malformed/absent one. (unit)
- AC6: Inline (non-overlay) rendering is unchanged for existing docs; `npm run
  verify` green.

## Decisions Needed

none — interaction model mirrors the shipped image viewer (image-viewer-zoom-and-
diffs); reuses its pure zoom math. Export deferred to keep MVP tight.
