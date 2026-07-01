---
status: active
date: 2026-07-01
tier: LITE
type: UI
---

# Mermaid diagram export (SVG + PNG)

## Problem

Mermaid diagrams render in the markdown viewer and open in a zoom overlay
(`webview/components/mermaid-zoom-overlay.tsx`), but there's no way to get the diagram
out of Conduit. When an agent produces a diagram, the user should be able to save it as a
shareable file.

## Scope

- **In:** "Export SVG" and "Export PNG" actions on the zoom-overlay toolbar; the diagram
  downloads via the browser (Chromium-in-Electron handles the save location).
- **Out:** choosing a save location beyond the browser download prompt (no host
  save-dialog IPC); other formats (JPEG/PDF); exporting from anywhere but the overlay.

## Design

Renderer-only. Pure/reusable logic lives in `webview/mermaid-export.ts`:

- `svgToBlob(svgHtml)` → `image/svg+xml` blob. Runs `normalizeSvgMarkup` first so the file
  is standalone (an XML prolog + an `xmlns`), injected idempotently.
- `svgToPngBlob(svgHtml, scale = 2)` → `Promise<Blob>`. Parse the markup, resolve the
  intrinsic size from the `viewBox` (reusing `svg-viewbox.ts` `svgViewBoxSize`, falling
  back to explicit width/height), set explicit width/height, encode as a data URL, load
  into an `Image`, draw to a `<canvas>` at `scale`, `canvas.toBlob('image/png')`. Rejects
  on load / context / encode failure.
- `download(blob, filename)` → temporary `<a download>` + `URL.createObjectURL`, then
  revoke.
- `diagramFilename(ext)` → `diagram.<ext>`.

The overlay toolbar gains two `.mermaid-zoom__btn` buttons (existing `IconDownload`,
aria-labels "Export as SVG" / "Export as PNG"); a labeled variant adds a short "SVG"/"PNG"
tag so the two identical icons are distinguishable.

## Edge cases

- **Huge diagram:** the PNG canvas is `size * scale`; very large diagrams cost memory but
  produce a valid PNG. No cap in v1 (LITE).
- **PNG rasterization failure** (bad SVG, no canvas context, load error): the promise
  rejects; the overlay logs and does nothing — no crash, no worse than a no-op.
- **External refs:** mermaid SVGs under `securityLevel:'strict'` are self-contained, so the
  exported file needs no external resources.

## Acceptance criteria

- Both Export buttons are present and labeled on the overlay toolbar.
- Export SVG downloads a non-empty file starting with `<?xml`/`<svg` and containing `<svg`.
- Export PNG downloads a valid PNG (verified in e2e; not unit-testable in jsdom).

## Test plan

- **Unit** (`test/unit/mermaid-export.test.ts`): `svgToBlob` produces a non-empty
  `image/svg+xml` blob carrying the markup + `xmlns`; `normalizeSvgMarkup` header injection
  is idempotent; `diagramFilename` output. (PNG raster needs a real canvas — e2e only.)
- **e2e** (`test/e2e/mermaid-export.e2e.mjs`): open a temp markdown doc with a mermaid
  block, open the overlay, click Export SVG, capture the download, assert the saved file is
  a valid non-empty SVG; assert the PNG button is present.
