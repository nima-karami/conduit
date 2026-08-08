# Viewer QA run — 2026-08-08

Systematic debug + QA pass over the three read-only file viewers: **Mermaid
diagrams in Markdown**, the **image viewer**, and the **PDF viewer**.

Spec: [`docs/specs/archive/2026-08-08-viewer-robustness.md`](../../specs/archive/2026-08-08-viewer-robustness.md)
Branch: `viewer-robustness` → `main` · 5 commits · +2442 / −147 across 20 files

## What prompted it

Three symptoms, reported from daily use:

1. Mermaid diagrams in Markdown were "too big" and zooming them "feels weird".
2. Clicking an image larger than the screen made it "zoom back to the screen" —
   "it doesn't fully show right away or doesn't fade in".
3. PDF viewing wanted the same treatment.

## Method

Rather than reason from the source, the run started by **measuring the running
app**. A throwaway diagnostic driver (`.autoloop/viewer-diag.mjs` — gitignored
run-state, kept on disk but deliberately not committed; the regressions it found
are pinned by `test/e2e/viewer-robustness.e2e.mjs` instead)
generated a 36-file fixture corpus — 20 Markdown/Mermaid documents spanning every
diagram type and aspect ratio, 10 images from 1×1 to 12000×400, 6 hand-written
PDFs — opened each in the real Electron app under Playwright, and recorded
geometry, a per-frame render sampler, and the console.

The measurements are preserved in `evidence/` next to this report:
`01-diagnostic-before.md` is the pre-fix baseline; `02`–`04` are the per-lane
re-measurements after each fix landed.

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
| `a833fe7` | Spec corrections — two claims the code did not meet | — |
| `610060d` | Code-review fixes (8 items) + 4 more e2e assertions | 13 assertions, 2 consecutive passes |

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
- Full 77-scenario suite run twice as the pre-integration regression check.
  `main` had not moved, so the merge is a fast-forward and the branch tree **is**
  the merged tree.

### On the suite failures

Both full runs had a handful of red scenarios, and neither set was the same:
run 1 failed `attention` and `terminal-commit-link`; run 2 failed
`arch-node-graph`, `markdown-viewer` and `repo-rescan`. **All five pass when run
alone**, and none of the five overlaps the other run — a real regression fails
the same scenario every time. The failure messages are the load shapes CLAUDE.md
already documents (a blurred-window focus assertion, "the shell echoed what we
typed", an empty clipboard read), and `arch-node-graph` alone takes 107 s
because of the known unvirtualised architecture canvas, so it simply exceeds its
budget behind 70 other Electron launches.

`terminal-commit-link` was chased properly rather than assumed: it produced
**three different failure messages across four runs** and passes on both `main`
and this branch. Both of its failure modes are startup races the scenario
already retries for.

## What the review round caught

An independent review of the whole diff found no Critical issues but three
things worth the extra round, all of which are now fixed in `610060d`:

- **A latent invisible-content latch in the shared hook.** `ready` was set false
  on every `resetKey` change but only ever set back true by an effect keyed on
  `hasSize`. A consumer that changed `resetKey` while `natural` stayed non-null
  would have left the content at `opacity: 0` **forever** — visible controls over
  an empty stage. It only worked because `ImageStage` happens to null `natural`
  in the same commit. Fixing it turned up the same shape in the snap-to-fit
  effect. Both are now covered by a test verified to fail against the old wiring.
- **`svg-normalize` ate other attributes' values.** The size-attribute strip ran
  as a regex across the whole root tag, so
  `<svg data-x="a width=b" width="10">` came out as `<svg data-x="a">`. Mermaid
  puts `accTitle`/`accDescr` on the root as `aria-label`, so a diagram titled
  "Bandwidth width=2 test" silently lost part of its accessible name. Replaced
  with a real attribute-list walk.
- **The e2e claimed coverage it didn't have.** Nine assertions against a spec
  section listing many more. Four of the highest-value gaps were closed (PD3
  resize re-fit — which guards an accepted architectural deviation and had no
  test at all; five consecutive PDF switches; the C4 affordance measured with
  `getComputedStyle` rather than a click that bypasses visibility; and A3's
  computed `transition-property`). The rest were moved into an explicit
  "accepted as unmeasured" bucket in the spec's §5 with a reason each, rather
  than left implying coverage that didn't exist.

Chasing an unrelated suite failure also turned up that `pdf-setup.ts` was doing
real work at module import time — it is in the eager bundle, so **every Conduit
launch was spawning the pdf.js worker and running its handshake even if no PDF
was ever opened**. Now lazy, created on first load.

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
7. **`jsdom` was added as a devDependency** — flagging this one hardest, because
   it is the only change here that touches the dependency surface. The `ready`
   latch lives in effect wiring, which no pure function test can reach, so
   covering it needs a DOM. That cuts against this repo's deliberate pattern of
   extracting geometry into pure modules *so that* the unit layer needs no DOM.
   It is dev-only, opt-in per test file (`@vitest-environment`), and `fallow` and
   `npm audit` are unchanged. If you'd rather keep the unit layer DOM-free, the
   alternative is to drop it and cover the regression in the real-app e2e
   instead (open image A, then a same-sized image B, assert content is visible).

## Not done

- **The image diff's linked snap-to-fit is last-writer-wins.** Both linked stages
  write the same shared `setZoom` with a `fit` computed from their own `natural`,
  so whichever side decodes last wins and the other can overflow its pane at
  "fit". **Pre-existing — this work did not cause or worsen it**, and it is
  outside the reported scope, so it was left alone; the spec's §13 was corrected
  to stop claiming otherwise. The right fix is `min(fitA, fitB)`, which needs the
  shared state bundle to carry a per-stage fit.
- **D9 reclassified as by-design, not a bug.** A 1×1 image sits as a speck at
  "fit" because raster never upscales — deliberate (pixel fidelity). Flagged so a
  future diagnostic diff doesn't read it as a regression.
- **Password-protected PDFs** remain unsupported; the typed error path exists and
  shows a specific notice, but no fixture exercises it and no unlock UI was added.
- Flows the diagnostic could not drive are listed with an explicit disposition in
  the spec's §5 rather than silently dropped.
