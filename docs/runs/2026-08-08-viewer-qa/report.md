# Viewer QA run — 2026-08-08

Systematic debug + QA pass over the three read-only file viewers: **Mermaid
diagrams in Markdown**, the **image viewer**, and the **PDF viewer**.

Spec: [`docs/specs/2026-08-08-viewer-robustness.md`](../../specs/2026-08-08-viewer-robustness.md)
Branch: `viewer-robustness` → `main` · 5 commits · +2442 / −147 across 20 files

## What prompted it

Three symptoms, reported from daily use:

1. Mermaid diagrams in Markdown were "too big" and zooming them "feels weird".
2. Clicking an image larger than the screen made it "zoom back to the screen" —
   "it doesn't fully show right away or doesn't fade in".
3. PDF viewing wanted the same treatment.

## Method

Rather than reason from the source, the run started by **measuring the running
app**. A throwaway diagnostic driver (`.autoloop/viewer-diag.mjs`, gitignored)
generated a 36-file fixture corpus — 20 Markdown/Mermaid documents spanning every
diagram type and aspect ratio, 10 images from 1×1 to 12000×400, 6 hand-written
PDFs — opened each in the real Electron app under Playwright, and recorded
geometry, a per-frame render sampler, and the console.

That produced 14 numbered defects (D1–D14) with numbers attached, which became
the spec's acceptance criteria. Every fix was then re-measured against the same
driver, so each claim below is a measurement, not an assertion.

## Root causes

Three independent mechanisms accounted for almost everything.

**The image "zoom back" was a paint-ordering bug.** `usePanZoomStage` started at
`zoom = 1` and applied the fit in a *post-paint* `useEffect`, while
`.imgstage__img` carried `transition: transform 0.08s`. So an oversized image
painted at full natural size and then **animated** down to fit — 10–11 distinct
rendered widths per image. `img-ultrawide` first painted 12000 px into a 950 px
stage. What the user saw as a bad transition was a correction being animated.

**The Mermaid overlay had two clamps fighting the zoom.**
`.mermaid-zoom__content` was a flex item in a flex stage, so its inline width was
shrunk straight back to the stage width; and mermaid's rendered root `<svg>`
carries an inline `style="max-width: Npx"`, which beats the stylesheet's
`max-width: none`. Zooming raised the percentage while the box stayed at 948 px
and the SVG stretched on one axis only — `mm-tiny` at 244% was a 272×425 box
holding a 111×425 SVG. Separately `fitScale` was `Math.min(1, …)`, so a small
diagram opened at 12% fill in a full-screen modal.

**The inline diagram was never sized by us at all.** Mermaid emits
`width="100%"` plus an inline `max-width`, so a diagram was *always* scaled to
the Markdown column regardless of aspect, and `.mermaid-diagram__svg
{ overflow-x: auto }` could never engage — it fired in 0 of 20 cases. A 9820×70
diagram rendered 864×6.16 px. Six pixels tall.

**And one that was pure luck it hadn't been reported.** `webview/pdf-setup.ts`
installs a single shared `GlobalWorkerOptions.workerPort`. Because
`PdfDocument.load` called `getDocument({ data })` with no explicit `worker`,
pdf.js assigned the *shared* worker to each loading task — so the `task.destroy()`
that runs when the viewer switches documents tore down the shared worker, and the
next `getDocument` failed. **Opening one PDF straight after another failed 4 of 5
times, and told the user their file was corrupt.**

## Shipped

| Commit | Lane | Evidence |
|---|---|---|
| `44d9388` | Spec — 89-flow map, D1–D14 root causes, acceptance criteria | — |
| `cf2b224` | PDF: singleton worker, fit-on-open, resize re-fit, widest-page fit, Ctrl+wheel | 5/5 acceptance |
| `3e85d4a` | Shared pan/zoom core + Mermaid zoom overlay | 11/11 acceptance |
| `69710a3` | Inline Mermaid: legibility floor, scroll, height cap, orphan cleanup | 6/6 acceptance |
| `cae9793` | 9-assertion real-app regression scenario + CHANGELOG | 2 consecutive passes |

### Measured before → after

| | Before | After |
|---|---|---|
| Oversized image, first painted width (950 px stage) | 12000 px, 10–11 distinct widths | 950 px, **1** width |
| Passive-listener console errors per walk | 15 | **0** |
| viewBox-only SVG layout box (natural 225×150) | 950×633 at "100%" | **225×150** at "100%" |
| Overlay zoom-in ×4, rendered width (`mm-huge`) | 948 → 948 → 948 → 948 | 1185 → 1481 → 1852 → **2314** |
| Overlay fit fill ratio (`mm-tiny`) | 0.12 | **1.00** |
| Overlay aspect drift across zoom levels | broken (one axis only) | **≤ 0.1%** |
| Inline `mm-wide` (9820×70) | 864×6.16 px, never scrolled | **3437×24.5 px at 0.35×, scrolls** |
| Inline diagrams over the 70 vh cap | uncapped | **0 of 26** |
| Orphan `#dmermaid-*` nodes after a parse error | 1 | **0** |
| PDF → PDF switches that loaded | 1/5 | **5/5** |
| PDFs overflowing horizontally on open | 3/5 | **0/5** |
| Active fit stale after a window resize | 5/5 | **0/5** |

Unit coverage went 2621 → 2671 tests; four new pure modules carry the geometry
(`webview/pdf-fit.ts`, `svg-normalize.ts`, `mermaid-scale.ts`, plus `image-zoom.ts`
extensions), so the maths is testable without a browser.

Accessibility items that surfaced while reading the code and were fixed in
passing: the overlay claimed `aria-modal` but Tab walked out of it; both stages
were `tabIndex={0}` with `outline: none` (a live WCAG 2.4.7 failure); the newly
scrollable diagram wrapper needed a tab stop and an accessible name.

## Verification

- `npm run verify` green on the final tree (unfiltered), 2671 unit tests.
- `node test/e2e/run-smoke.mjs viewer-robustness` — new scenario, 9 assertions,
  each naming the defect it guards and its pre-fix number. Passed twice
  consecutively (31.5 s, 29.2 s).
- **Negative control**: reverting the snap-to-fit from `useLayoutEffect` back to
  `useEffect` and rebuilding made assertion 1 fail with the exact pre-fix number
  (4000 px in a 790 px stage). The test discriminates; it isn't decorative.
- Adjacent scenarios re-run green: `pdf-viewer`, `image-diff`, `md-images`,
  `rich-content`, `mermaid-export`, `markdown-viewer`.
- Full 77-scenario suite run as the pre-integration regression check.

## Decisions taken without asking (unattended run)

These are tunable and worth a second opinion:

1. **Legibility floor `0.35`.** Below this an inline diagram scrolls instead of
   shrinking further. At the floor, a 140:1 diagram like `mm-wide` is still a
   thumbnail — legible-ish, with the (now persistent) expand button as the real
   way to read it. Raising the floor makes more diagrams scroll; lowering it
   brings back tiny diagrams. One constant in `webview/mermaid-scale.ts`.
2. **~70 vh inline height cap.** Same shape of call, same file.
3. **PDF `MIN_SCALE` 0.25 → 0.1.** A 5000 pt page needs ~0.18× to fit the pane;
   with the old floor "no horizontal overflow on open" was unachievable. Matches
   pdf.js's own viewer floor.
4. **Fit-width (not fit-page) as the PDF default on open.** Matches Chrome and
   the VS Code PDF extension.
5. **`transition: transform` removed rather than retimed.** Zoom steps and
   drag-pan are now instantaneous; the only animation is the opacity fade-in. This
   is what fixes both the animated shrink and the mushy drag, but it does mean
   zoom no longer eases.
6. **The overlay's zoom readout stays absolute** (relative to viewBox units), so a
   small diagram reads "516%" at fit. Honest, and matches Figma/draw.io, but a
   fit-relative readout is the alternative if that reads oddly in use.

## Not done

- **D9 reclassified as by-design, not a bug.** A 1×1 image sits as a speck at
  "fit" because raster never upscales — deliberate (pixel fidelity). Flagged so a
  future diagnostic diff doesn't read it as a regression.
- **Password-protected PDFs** remain unsupported; the typed error path exists and
  shows a specific notice, but no fixture exercises it and no unlock UI was added.
- Flows the diagnostic could not drive are listed with an explicit disposition in
  the spec's §5 rather than silently dropped.
