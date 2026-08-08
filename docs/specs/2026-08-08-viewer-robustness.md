---
status: active
date: 2026-08-08
---

# Viewer robustness — Mermaid, image, PDF

**Tier:** FULL **Feature type:** UI
**One-line request:** the mermaid "memory" diagrams "were just too big then and it just
feels weird" — map out 20–30 user flows for diagram sizes / styles / zoom, do the same
for images ("it zooms back to the screen… it doesn't fully show right away or doesn't
fade in, it's just not a good transition") and for PDF; make all three viewers solid.

## Problem frame

- **Job:** read a diagram, an image, or a PDF inside Conduit without fighting the
  viewer — it opens showing the thing, at a size that makes sense, and zoom does what
  zoom does everywhere else.
- **Actors:** the human reading a repo (markdown docs with mermaid, design assets,
  vendor PDFs). Agents never drive these surfaces.
- **Success outcomes (observable):** every viewer paints once at a correct size; every
  zoom-in visibly enlarges; no viewer reports a working file as corrupt; a resize never
  leaves a stale fit.
- **Evidence base:** `.autoloop/evidence/viewer-diag.md` (real app, 1600×1000, hidden
  launch, 122 s walk) — 14 numbered defects **D1–D14** with measurements. This spec adds
  three more found while reading the implementation: **N1–N3** (§2).
- **Non-goals:** see §4.

---

## §1 Flow map

The headline deliverable. `Measured today` cites `.autoloop/evidence/viewer-diag.md`;
`UNTESTED` means the diagnostic did not exercise it — no measurement is invented.

### Mermaid — inline (in rendered Markdown)

| # | Flow | Expected | Measured today | Verdict |
|---:|---|---|---|---|
| 1 | Tiny diagram (`mm-tiny`, 111×174) | renders 1:1, legible | 111.45×174, shrink 1 | OK |
| 2 | Narrower than the column (`mm-small`, 618×382) | 1:1 | 617.84×382, shrink 1 | OK |
| 3 | Slightly wider than the column (`mm-sequence`, 1276×1611) | scroll or scale a little; stays legible | 849×1071.89 (0.67×) | BUG D1 |
| 4 | Much wider than the column (`mm-gantt` 1600×460, `mm-journey` 1300×540) | ditto | 864×248 (0.54×), 864×565 (0.66×) | BUG D1 |
| 5 | Extremely wide, ≫10× column (`mm-wide`, 9820×70) | scroll horizontally at a legible scale | **864×6.16 px** (0.09×) — a 6-pixel-tall smear | BUG D1, D2 |
| 6 | Enormous both axes (`mm-huge`, 13176×798) | ditto | 864×52.31 (0.07×) | BUG D1, D2 |
| 7 | Extremely tall (`mm-tall`, 134×6206) | capped at ~70 vh, scrolls or scales | rendered 1:1 at **6206 px tall**, shoving the prose off screen | BUG N1 |
| 8 | Flowchart (`mm-medium`, 800×1526) | fits column, capped height | 799.88×1526 1:1 — 1526 px tall | BUG N1 |
| 9 | Sequence diagram | legible | 0.67× downscale | BUG D1 |
| 10 | Class diagram (`mm-class`, 328×2362) | capped height | 1:1 at 2362 px tall | BUG N1 |
| 11 | State diagram (`mm-state`, 322×1083) | 1:1 | 321.55×1083, shrink 1 | OK |
| 12 | ER diagram (`mm-er`, 140×1749) | 1:1, capped height | 1:1 at 1749 px tall | BUG N1 |
| 13 | Gantt (`mm-gantt`) | legible | 0.54× | BUG D1 |
| 14 | Pie (`mm-pie`, 614×450) | 1:1 | shrink 1 | OK |
| 15 | Mindmap (`mm-mindmap`, 746×380) | 1:1 | shrink 1 | OK |
| 16 | gitGraph (`mm-gitgraph`, 371×160) | 1:1 | shrink 1 | OK |
| 17 | User journey (`mm-journey`) | legible | 0.66× | BUG D1 |
| 18 | Long labels (`mm-longlabels`, 358×670) | 1:1 | shrink 1 | OK |
| 19 | Unicode / CJK / RTL labels | glyphs measured correctly, no clipping | — | UNTESTED |
| 20 | 8 diagrams in one document (`mm-multi`) | all render, no cross-talk | 8/8 SVG, 0 errors, settled 633 ms | OK |
| 21 | Invalid syntax (`mm-broken`) | error card with the parse message | error card correct — **plus one orphan `#dmermaid-*` node left in `<body>`** | BUG D3 |
| 22 | Empty fence (`mm-empty`) | "Empty diagram" empty state | 1 empty state, 0 errors | OK |
| 23 | Diagram inside a long prose document (`mm-in-prose`) | renders in flow | 2 SVGs, 587.88×87.44 | OK |
| 24 | Theme switch while a diagram is on screen | re-renders in the new palette, no flash of the old one | — | UNTESTED |
| 25 | Markdown pane resized while a diagram is on screen | re-fits to the new column width | — | UNTESTED |
| 26 | Diagram scaled to the legibility floor | an obvious way out (expand to overlay) | affordance is `opacity: 0` until `:hover` / `:focus-visible` — invisible on touch, easy to miss | BUG N2 |

### Mermaid — zoom overlay

| # | Flow | Expected | Measured today | Verdict |
|---:|---|---|---|---|
| 27 | Open from the expand button | opens fast, focus inside | 10–203 ms, stage 948×898 | OK |
| 28 | Open by clicking the diagram body | same as 27, except on a scrolling wrapper (C5) where the click belongs to the scroll region | — | UNTESTED |
| 29 | Fit on open, tiny diagram (`mm-tiny`) | fills the modal | 111.45×174 in 948×898 — **fill ratio 0.12** at "100%" | BUG D6 |
| 30 | Fit on open, medium (`mm-medium`) | fills the modal | fill 0.5 at 59% | BUG D6 |
| 31 | Fit on open, tall (`mm-tall`) | fills on the constrained axis | fill 0.02 at 14% | BUG D6 |
| 32 | Fit on open, enormous (`mm-huge`, `mm-wide`) | fills the modal width | fill 1.0 at 7% / 10% | OK |
| 33 | Zoom in ×4 toward the ceiling (`mm-huge`, `mm-wide`) | each step visibly enlarges | 4 of 4 steps: **width stayed 948 px** while the readout climbed 9→18% | BUG D4 |
| 34 | Zoom in ×4 (`mm-sequence`) | ditto | 2 of 4 steps produced no width change | BUG D4 |
| 35 | Zoom in ×4 (`mm-tiny`, `mm-medium`) | aspect ratio preserved | at 244% the box is 272×425 but the SVG is **111.45**×425 — stretched vertically only | BUG D5 |
| 36 | Zoom out ×6 to the floor | stops at fit, never smaller | every case clamped at its fit % across 6 steps | OK |
| 37 | Reset to fit | returns to the open state | returns to fit % and pan 0,0 | OK |
| 38 | Wheel zoom toward the cursor | zooms about the pointer; page does not scroll | % changes on every gesture; no ancestor scrolled — **but `preventDefault()` is discarded** (passive listener) | BUG D10 |
| 39 | Cursor-anchoring accuracy of wheel zoom | the point under the cursor stays put | only the % was sampled | UNTESTED |
| 40 | Drag-pan while zoomed | pans within bounds | `pannable=true` on wide fixtures whose content is **already fully visible** at 948 px | BUG D4 |
| 41 | Drag-pan while fitted | no-op | `pannable=false` at fit on every fixture | OK |
| 42 | Arrow-key pan | pans by 48 px per press when pannable | — | UNTESTED |
| 43 | Ctrl/Cmd `+` / `−` / `0` | zoom in / out / reset-to-fit | — | UNTESTED |
| 44 | Esc closes | overlay closes | — | UNTESTED |
| 45 | Backdrop click closes | overlay closes | — | UNTESTED |
| 46 | Focus returns to the trigger on close | expand button refocused | — | UNTESTED (implemented, `mermaid-diagram.tsx:114`) |
| 47 | Export SVG | file downloads | — | UNTESTED here (covered by `mermaid-export.e2e.mjs`) |
| 48 | Export PNG | file downloads | — | UNTESTED here (same) |

### Image viewer

| # | Flow | Expected | Measured today | Verdict |
|---:|---|---|---|---|
| 49 | 1×1 pixel image | visible at a usable size | 1×1 px in a 950×798 stage at "100%"; 4 zoom-ins reach **2.44 px** | D9 — **BY DESIGN**, see §6.5 |
| 50 | Small image (64×64) | ditto | 64 px; 4 zoom-ins reach 156 px | D9 — **BY DESIGN**, see §6.5 |
| 51 | Smaller than the pane (800×600) | paints once at 1:1 | 1 distinct rendered width | OK |
| 52 | 1.26× the pane (1200×700) | paints once, already fitted | first paint **1200 px (1.26× stage)** then animates down over **11 distinct widths** | BUG D7 |
| 53 | 4.2× the pane (4000×3000) | ditto | first paint 4000 px (4.21×), 10 distinct widths | BUG D7 |
| 54 | Ultra-wide (12000×400) | ditto | first paint 12000 px (**12.63× stage**), 11 distinct widths | BUG D7 |
| 55 | Ultra-tall (400×12000) | ditto | first paint 12000 px tall (15.04× stage), 11 distinct widths | BUG D7 |
| 56 | SVG with an explicit size (2400×1600) | ditto | first paint 2400 px (2.53×), 11 distinct widths | BUG D7 |
| 57 | SVG with **no** intrinsic size (viewBox 225×150) | laid out at 225×150, readout truthful | laid out at **950 px = 4.22× natural** while the readout says "100%" and the caption says "225 × 150 px" | BUG D8 |
| 58 | Pan an intrinsic-size-less SVG | pans when it overflows | `pannable=false`, drag moved 0/0 — pan math uses 225 px, screen shows 950 px | BUG D8 |
| 59 | Corrupt file | notice, controls hidden | `.viewer__notice` "Could not render image.", no hang | OK |
| 60 | Zoom in to the 800% ceiling | clamps at 800% | only 4 steps measured (max 244%) | UNTESTED |
| 61 | Zoom out to the fit floor | clamps at fit | every case clamped at fit after 6 steps | OK |
| 62 | Wheel at the fit floor (ultra-tall) | no change | 7% → 7%, `changed=false` | OK |
| 63 | Zoom-step fidelity (raster) | rendered px tracks the % exactly | 125%→1000 px, 156%→1250 px on 800×600 | OK |
| 64 | Drag-pan | image follows the cursor 1:1, no lag | delta exact, **but each frame is re-animated by `transition: transform 0.08s`** — the "mushy" drag | BUG D7 |
| 65 | Rotate at 0 / 90 / 180 / 270 and its effect on fit + pan bounds | fit and pan bounds use the rotated bounds | — | UNTESTED |
| 66 | Switch to a different image in the same viewer | resets to fit, one paint | — | UNTESTED |
| 67 | Window resize while fitted | re-fits | — | UNTESTED (hook has a `ResizeObserver`) |
| 68 | Window resize while zoomed | keeps the user's zoom, re-clamps pan | — | UNTESTED |
| 69 | Side-by-side diff, linked zoom/pan/rotate | both sides move together | — | UNTESTED here (covered by `image-diff.e2e.mjs`) |

### PDF viewer

| # | Flow | Expected | Measured today | Verdict |
|---:|---|---|---|---|
| 70 | Open a portrait doc (`pdf-1page`, 612×792) | opens fitted to width | opens at 100%, no fit pressed; 612 px in a 935 px viewport (no overflow by luck) | BUG D12 |
| 71 | Open a landscape doc (1224×792) | fitted | 1224 px canvas in 935 px → **overflows on open** | BUG D12 |
| 72 | Open a mixed-page-size doc | fitted to the widest page | overflows on open | BUG D12, D14 |
| 73 | Open a 5000 pt page | fitted | 5000 px canvas in 935 px → overflows | BUG D12 |
| 74 | Open a 20-page doc | loads, placeholders keep the scrollbar stable | loaded (after the D11 retry); page sizes stream in | OK (once D11 is fixed) |
| 75 | **Switch from one PDF straight to another** | the second loads | **4 of 5 transitions failed** with "could not be opened (corrupt or invalid PDF)"; every fixture loads fine in isolation | **BUG D11 (critical)** |
| 76 | Corrupt doc | notice, no hang | notice in 44 ms | OK |
| 77 | Password-protected doc | "password-protected (unsupported)" notice | — | UNTESTED |
| 78 | Fit width, uniform doc | no horizontal overflow | 145% / 887 px in 935 px, overflow false | OK |
| 79 | Fit width, mixed-size doc | no page overflows | scaled off page 1 (612 pt) → page 4 (1584 pt) renders ~2297 px, still overflowing | BUG D14 |
| 80 | Fit page | whole page visible | — | UNTESTED |
| 81 | Zoom in / out from the toolbar | scale steps by 20% | — | UNTESTED |
| 82 | Rotate | pages re-lay out rotated, active fit recomputed | 90° → zoom 112%, sizes swapped correctly (`888x686`) | OK |
| 83 | Pane resize with a fit active | fit recomputes | **5 of 5** kept the stale scale; widening back did not restore it; `aria-pressed="true"` stayed on the whole time | BUG D13 |
| 84 | Page jump (type a page number) | scrolls to that page | — | UNTESTED |
| 85 | Outline navigation | jumps to the destination page | — | UNTESTED |
| 86 | Thumbnails | render lazily, click jumps | — | UNTESTED |
| 87 | Find with matches | count + highlight + scroll | — | UNTESTED |
| 88 | Find with no matches | `0/0`, no highlight, no scroll | — | UNTESTED |
| 89 | Ctrl/Cmd + wheel zoom | zooms like every other PDF reader | no wheel handler exists in `pdf-viewer.tsx` | BUG N3 |

---

## §2 Root causes

### Established (D1–D14)

| # | Mechanism | Where |
|---|---|---|
| **D1** | mermaid's rendered root `<svg>` carries `width="100%"` **plus** an inline `max-width:<intrinsic>px`. The injected SVG is styled `max-width: 100%`, so it always scales to the column width and shrinks vertically with it — a 9820×70 diagram becomes 864×6.16 px. | `webview/components/mermaid-diagram.tsx:107` (injection); `webview/styles.css:10028-10032` |
| **D2** | Because the SVG is capped at 100% of the host width, `scrollWidth` never exceeds `clientWidth`, so the escape hatch never engages — dead code at every fixture size up to 13176 px intrinsic. | `webview/styles.css:10023-10026` |
| **D3** | On a parse error `mermaid.render` throws **before** its own temp-node cleanup, leaving the offscreen `<div id="d<id>">` it appended to `<body>`. The component removes it only in the effect cleanup (unmount / dep change), never on the error path itself. | `webview/components/mermaid-diagram.tsx:54-59` (catch), `:62-69` (cleanup) |
| **D4** | `.mermaid-zoom__content` is a flex item in a `display:flex` stage with no `flex-shrink` override, so its inline `width` is shrunk back to the stage width. The percentage readout rises while the box does not — and `canPan` still computes off `natural × zoom`, so drag is enabled over a box that is fully visible. | `webview/styles.css:10084-10095`; content sizing `webview/components/mermaid-zoom-overlay.tsx:99-103`; `canPan` `webview/image-zoom.ts:85-92` |
| **D5** | mermaid's root `<svg>` carries an inline `style="max-width: Npx"`. An inline style beats the stylesheet's `max-width: none`, so the SVG stays clamped at its intrinsic width while its container grows — the diagram stretches on the height axis only. | `webview/styles.css:10102-10107` vs the injected SVG's own `style` attribute |
| **D6** | `fitScale` is `Math.min(1, pane.w/natural.w, pane.h/natural.h)` — it never upscales. Correct for raster (pixel fidelity) but wrong for a vector diagram in a full-screen modal. | `webview/image-zoom.ts:96-102` |
| **D7** | `usePanZoomStage` starts at `zoom = 1`; pane measurement and the snap-to-fit both run in post-paint `useEffect`s, and `.imgstage__img` carries `transition: transform 0.08s ease-out`. So an oversized image **paints at natural size and then animates down** (10–11 distinct widths measured). The same transition re-animates every drag frame — the mushy pan. | `webview/use-pan-zoom-stage.ts:78, 102-110, 113-117`; `webview/styles.css:9509-9511` |
| **D8** | The `<img>` layout box is never pinned to the natural pixel size, so an SVG with no intrinsic dimensions lays out at the stage width, while `naturalWidth`/`naturalHeight` (from its viewBox) feed the zoom readout, the caption and the pan math. Three numbers, three different realities. | `webview/components/image-stage.tsx:103-111`, `:132-144`; `webview/styles.css:9506-9514` |
| **D9** | Same `Math.min(1, …)` as D6: "reset to fit" on a 1×1 or 64×64 image is a speck in the middle of a 950×798 pane. | `webview/image-zoom.ts:101` |
| **D10** | The handler is attached through React's `onWheel` prop; React attaches `wheel` as a **passive** listener, so the `e.preventDefault()` inside is discarded — 15 console errors over the run. Latent here (no scrollable ancestor in this layout) but a real bug the moment one exists. | handler `webview/use-pan-zoom-stage.ts:162-173`; consumers `webview/components/image-stage.tsx:125`, `webview/components/mermaid-zoom-overlay.tsx:92` |
| **D11** | **Critical.** `pdf-setup.ts` installs a single shared `GlobalWorkerOptions.workerPort`. `getDocument` is called **without** an explicit `worker`, so pdf.js assigns the shared worker to that loading task. When the viewer switches documents, its cleanup calls `task.destroy()` — which tears down the **shared** worker. The next `getDocument` fails, and the generic catch reports it to the user as file corruption. | `webview/pdf-setup.ts:15-19`; `webview/pdf-document.ts:42`, `:106-110`; `webview/components/pdf-viewer.tsx:91-95`, `:83-90` |
| **D12** | No fit is applied on open — `scale` initialises to 1 and `fit` to `'none'`; `applyFit` runs only from the toolbar buttons. 3 of 5 documents need a horizontal scroll the moment they open. | `webview/components/pdf-viewer.tsx:122-123`, `:188-207`, `:350-367` |
| **D13** | `applyFit` is computed once from `container.clientWidth/clientHeight`. The only re-run is a `rotation` effect; there is no `ResizeObserver` on the scroll container, so a resize leaves the scale stale while `aria-pressed="true"` keeps claiming the fit holds. | `webview/components/pdf-viewer.tsx:188-207`, `:219-221` |
| **D14** | Fit is derived from `baseDims[0]` — page 1 only. In a mixed-size document the widest page is scaled by page 1's ratio and still overflows. | `webview/components/pdf-viewer.tsx:191-203` |

### Found while reading the implementation (N1–N3)

| # | Mechanism | Where |
|---|---|---|
| **N1** | Nothing caps an inline diagram's height. Any diagram narrower than the column renders 1:1 at whatever height mermaid produced — 6206 px (`mm-tall`), 2362 px (`mm-class`), 1749 px (`mm-er`) — pushing the surrounding prose off screen. | `webview/components/mermaid-diagram.tsx:89-108`; `webview/styles.css:10023-10032` (no `max-height`) |
| **N2** | `.mermaid-diagram__expand` is `opacity: 0; pointer-events: none` until `:hover` or `:focus-visible`. It is the escape hatch for a floor-scaled diagram, and it is invisible until you happen to hover. | `webview/styles.css:10035-10059` |
| **N3** | `pdf-viewer.tsx` binds no wheel handler at all — Ctrl/Cmd+wheel scrolls instead of zooming, unlike every other PDF reader. | `webview/components/pdf-viewer.tsx:252-292` (keyboard only) |

---

## §3 Required behaviour + acceptance criteria

Four lanes. The architecture below is **settled** — implement it, don't re-open it.

### Lane A — shared pan/zoom core

Files: `webview/image-zoom.ts`, `webview/use-pan-zoom-stage.ts`, its consumers
(`image-stage.tsx`, `mermaid-zoom-overlay.tsx`), `webview/styles.css`.

**A1 — fit before first paint.** Pane measurement and snap-to-fit both move to
`useLayoutEffect`, so the fitted zoom is applied before the browser paints.

**A2 — `ready` + fade-in.** The hook exposes `ready = natural size known ∧ pane measured
∧ fit applied`. Content renders at `opacity: 0` until `ready`, then fades in over ~120 ms.
This is the "fade in" the user asked for. Linked stages (the side-by-side diff) each own
their own `ready`; one side being slower must not hold the other back.

**A3 — no transform transition.** `transition: transform` is removed from
`.imgstage__img`. Zoom steps and drag-pan become instantaneous — this kills the animated
shrink (D7) *and* the mushy drag. The only animation left is the opacity fade-in, and
`prefers-reduced-motion: reduce` drops that too (content appears at full opacity once
`ready`).

**A4 — pin the layout box.** The `<img>` gets explicit `width`/`height` attributes equal
to its natural pixel size, so the transform scale, the zoom readout, the caption and the
pan bounds all agree — for raster, for sized SVG, and for intrinsic-size-less SVG alike.

**A5 — native non-passive wheel.** The hook binds `wheel` itself on the stage element via
`addEventListener('wheel', handler, { passive: false })` inside an effect. The React
`onWheel` prop is removed from every consumer, and the hook stops returning `onWheel`.

**A6 — `allowUpscale`, and a fit-relative ceiling.** `fitScale(natural, pane, { allowUpscale })`:
`false` (default) keeps the never-upscale rule for raster images; `true` lets the vector
overlay fill the modal. The hook takes it as an option and forwards it.

`MAX_ZOOM = 8` is currently absolute, which breaks Lane B's own acceptance criterion: an
upscaled fit for `mm-tiny` is ~5.16×, so the 3rd and 4th zoom-in clamp and produce no
width change — the exact D4 symptom. **Under `allowUpscale: true` the ceiling becomes
fit-relative: `max(MAX_ZOOM, fit × MAX_ZOOM)`.** Raster is unaffected (`fit ≤ 1`, so the
ceiling stays 8×).

**A7 — the changed public contract.** These are the only signature changes; every call
site must be updated in the same change.

```ts
// webview/image-zoom.ts
export function fitScale(
  natural: Size, pane: Size, opts?: { allowUpscale?: boolean },
): number;
export function clampZoom(zoom: number, fit: number, opts?: { allowUpscale?: boolean }): number;

// webview/use-pan-zoom-stage.ts
export function usePanZoomStage(
  natural: Size | null,
  opts?: {
    resetKey?: unknown;
    onReset?: () => void;
    shared?: SharedPanZoomState;
    allowUpscale?: boolean;   // NEW — A6
  },
): {
  ready: boolean;             // NEW — A2
  /* onWheel REMOVED — A5 binds it natively */
  stageRef; zoom; pan; pannable; zoomIn; zoomOut; resetView;
  onCoreKeyDown; pointerHandlers; announce; setAnnounce; setPan;
};
```

Call sites: `webview/components/image-stage.tsx:75` and `:125` (drop `onWheel`),
`webview/components/mermaid-zoom-overlay.tsx:30` and `:92` (drop `onWheel`, pass
`allowUpscale: true`), and `webview/components/image-diff.tsx:209` (the linked-stage
parent — unchanged API, but its two stages each gate on their own `ready`).

**Acceptance (Lane A)**

- For every image fixture, the **first** rendered width equals the final rendered width
  (one distinct width, not 10–11) and never exceeds the stage width for an image larger
  than the stage.
- Zero `Unable to preventDefault inside passive event listener invocation` console
  errors across a full viewer walk (was 15).
- `img-vector.svg` (viewBox 225×150, no intrinsic size): laid-out box is 225×150, readout
  "100%", and a drag at ≥ fit zoom moves the image by the cursor delta when it overflows.
- No computed `transition-property` containing `transform` on `.imgstage__img`.
- **Rotation:** at each of 0/90/180/270 the fit uses the rotated bounds (a 12000×400 image
  rotated 90° fits its height, not its width), the pan bounds swap with it, and rotating
  while zoomed keeps the zoom and re-clamps the pan inside the new bounds.

```gherkin
Feature: Viewer first paint
  Scenario: An image four times the pane opens without a flash
    Given a 4000x3000 image and a 950x798 stage
    When the image viewer opens
    Then the first painted width is 950px
    And no intermediate width larger than 950px is ever painted
    And the image fades from transparent to opaque over about 120ms

  Scenario: Reduced motion
    Given the OS requests reduced motion
    When the image viewer opens
    Then the image appears at full opacity with no tween, on the frame it becomes ready
```

The reduced-motion scenario deliberately does **not** say "opaque on the first painted
frame". The opacity gate is what guarantees no wrongly-sized content is ever shown; forcing
`opacity: 1` under reduced motion would reinstate exactly the flash this lane removes for
the users least able to tolerate it. Reduced motion drops the *tween*, not the gate.

### Lane B — Mermaid zoom overlay

**B1 — the content box must not shrink.** `.mermaid-zoom__content { flex: 0 0 auto; }`
so its size is the zoom-driven size, not the stage width (D4). This is a **new rule** —
the sheet has none for that class today, only `.mermaid-zoom__content svg`
(`webview/styles.css:10102-10107`).

**B2 — normalise the injected SVG.** A **new pure, unit-tested helper** next to
`webview/svg-viewbox.ts` (`webview/svg-normalize.ts`) strips `max-width` from the root
`<svg>`'s inline `style` and removes its `width`/`height` **attributes**, so the SVG
fills its container at any zoom (D5, D1). Contract:

```ts
/** Root <svg> only. Body untouched. No-op when neither max-width nor width/height present. */
export function normalizeSvgForZoom(svgHtml: string): string;
```

- Must not alter anything after the opening `<svg …>` tag.
- Must be a no-op (returns an equal string) on an SVG with neither.
- Must preserve `viewBox`, `id`, `class`, `role`, `aria-*` and any other attribute.
- Must leave a `style` attribute that had other declarations intact minus `max-width`.

**B3 — fit fills the modal.** The overlay calls the hook with `allowUpscale: true` (A6),
so a small diagram fills the modal on open (D6).

**B4 — the dialog traps Tab.** The overlay is `aria-modal="true"` but Tab currently walks
out of it into the page behind. Focus cycles within the dialog (stage → toolbar buttons →
stage); Esc and the close button remain the exits, and focus still returns to the trigger.

**B5 — bound the rendered box.** B1 removes the accidental shrink that was masking this:
`mm-huge` (13176×798) at the fit-relative ceiling would ask for a ~105,000 px-wide
element. The rendered content box is clamped to a maximum edge of **16,384 px** (the
browser's own surface limit); the zoom readout reports the applied scale, so it never
claims a zoom the box did not take.

**Acceptance (Lane B)**

- For every mermaid fixture, **four consecutive zoom-ins each strictly increase the
  rendered SVG width**. This depends on A6's fit-relative ceiling — with the absolute
  `MAX_ZOOM = 8`, an upscaled fit clamps within two steps on the small fixtures.
- The rendered aspect ratio stays within **1%** of the viewBox aspect at every zoom level.
- At fit, `contentWidth/stageWidth ≥ 0.9` **or** `contentHeight/stageHeight ≥ 0.9`.
- `pannable` is false whenever the content is fully visible, true otherwise — checked
  against the *rendered* box, not `natural × zoom`.

### Lane C — Mermaid inline

**C1 — a pure scale function** (`webview/mermaid-scale.ts`, unit-tested) decides the
rendered inline size:

```ts
export interface InlineScaleInput {
  natural: { w: number; h: number };   // from the viewBox
  columnWidth: number;
  maxHeight: number;                   // ≈ 0.7 × viewport height
  minScale: number;                    // legibility floor, default 0.35
}
export interface InlineScaleResult {
  scale: number;
  width: number;   // px, applied to the SVG
  height: number;  // px
  scrolls: boolean; // true when scale hit the floor and the box exceeds the column
}
export function inlineDiagramScale(i: InlineScaleInput): InlineScaleResult;
```

Rules: scale down to fit `columnWidth` **and** `maxHeight`; never below `minScale`; never
above 1 (inline never upscales — the overlay is for that). The component applies the
result as explicit `width`/`height` px on the SVG, so it no longer depends on mermaid's
`width="100%"` (D1), and `.mermaid-diagram__svg { overflow-x: auto }` finally engages
when `scrolls` is true (D2).

**C2 — height cap.** An inline diagram must not exceed ~**70 vh** at its rendered scale
(N1). Past the cap it scales down until it hits the floor, then the wrapper scrolls.

**C3 — clean up the orphan immediately.** The parse-error path removes the
`#d<diagramId>` node in the `catch`, not only on unmount/dep-change (D3). The existing
cleanup stays (it also covers the cancelled-render case).

**C4 — a discoverable escape hatch.** The expand-to-overlay affordance is the way out for
anything hitting the floor or the height cap. When `scrolls` is true **or** the height cap
bit, the affordance is **persistently visible** (not hover-gated) — N2. It keeps its
existing icon and its existing accessible name ("Open diagram in zoom viewer"); no visible
text label is added, so §10's "no new chrome" holds. For diagrams rendering at 1:1 it
stays hover-revealed, where it is a nicety rather than a necessity — **except on a
coarse/no-hover pointer** (`@media (hover: none)`), where it is always visible, since
"reveal on hover" has no meaning there and N2's own diagnosis was touch invisibility.

**C5 — the scroll wrapper is keyboard-reachable.** C1 makes
`.mermaid-diagram__svg { overflow-x: auto }` actually engage for the first time, which
creates a scrollable region. When `scrolls` is true the wrapper gets `tabIndex={0}`,
`role="region"` and an accessible name ("Diagram, scrollable") so it can be scrolled with
the keyboard (WCAG 2.1.1). When it does not scroll, no tab stop is added — an
unconditional one would put a stop on every diagram in a document. In that state the
body click is **not** an overlay trigger either: it is the only pointer path to focusing
the region, and C4 has already made the expand button persistent, so the way out is not
lost. A non-scrolling diagram keeps click-to-open.

**Acceptance (Lane C)**

- No inline diagram renders taller than 70% of the viewport height.
- No inline diagram renders at a scale below `minScale`; any diagram that would have,
  scrolls horizontally instead (`scrollWidth > clientWidth`).
- `mm-wide` (9820×70) renders at ≥ 0.35 scale inside a horizontally scrollable wrapper,
  not at 6 px tall.
- After rendering `mm-broken`, `document.querySelectorAll('[id^="dmermaid-"]').length === 0`
  while the error card is displayed.
- On a diagram at the floor, the expand affordance is visible without hovering.

### Lane D — PDF

Items are numbered **PD1–PD5** so they never read as defect IDs.

**PD1 — one worker, never destroyed by a document.** `webview/pdf-setup.ts` owns a
**singleton `PDFWorker`** built from the shared port and exports it; `PdfDocument.load`
passes it explicitly: `getDocument({ data, worker })`. A per-document `task.destroy()`
then tears down only that task (D11).

**PD2 — fit on open.** Once page dimensions are known, apply **fit-width** and set
`fit = 'width'` so the toolbar state is truthful from the first frame (D12).

**PD3 — an active fit stays correct.** A `ResizeObserver` on the scroll container
recomputes an active fit on resize, and the fit also recomputes when `baseDims` change as
page sizes stream in. `fit === 'none'` (explicit user zoom) is never touched (D13).

**PD4 — fit off the right page.** Fit-width uses the **widest** page; fit-page uses the
largest bounding box (max width × max height across pages, rotation-aware). Extract as a
pure, unit-tested `webview/pdf-fit.ts` so the geometry is testable without a document
(D14).

**PD5 — Ctrl/Cmd+wheel zooms** via a native non-passive listener on the scroll container,
matching every other PDF reader; plain wheel keeps scrolling (N3).

**Acceptance (Lane D)**

- **5 consecutive PDF→PDF switches all load** (0 "corrupt or invalid PDF" notices).
- Every fixture opens with `aria-pressed="true"` on Width and no horizontal overflow.
- `pdf-mixed.pdf` after fit-width: no page overflows horizontally.
- After a window resize (narrow, then wide again) the page still fits and the toolbar's
  `aria-pressed` state matches reality.
- Ctrl+wheel changes the zoom percentage; plain wheel changes `scrollTop` and not the
  zoom.

### EARS requirements

- *Ubiquitous:* The viewers shall paint content only once its fitted size is known.
- *Event:* When a viewer's content and pane size are both known, the viewer shall apply
  the fit scale before the first paint and then fade the content in over ~120 ms.
- *Event:* When the user zooms in on the diagram overlay, the viewer shall increase the
  rendered diagram width, preserving the viewBox aspect ratio within 1%.
- *Event:* When the user opens a PDF while another PDF is open, the viewer shall load the
  new document successfully.
- *Event:* When the container of a PDF with an active fit resizes, the viewer shall
  recompute that fit.
- *State:* While `prefers-reduced-motion: reduce` is set, the viewers shall present
  content at full opacity with no transition.
- *State:* While an inline diagram is rendered at the legibility floor, the markdown
  viewer shall show the expand affordance persistently.
- *Unwanted:* If a mermaid parse fails, then the component shall remove its offscreen
  temp node immediately and show the parse message.
- *Unwanted:* If a document fails to load because its worker was torn down, then — this
  must be unreachable after Lane PD1; a load failure shall only ever reflect the file.
- *Unwanted:* If the rendered content fits the stage on both axes, then dragging shall be
  a no-op and the pannable cursor shall not appear.

---

## §4 Non-goals

Explicitly out of scope. This is a correctness pass, not a feature pass.

- **No new viewer features:** no annotations, no printing/print preview, no text-selection
  rework in the PDF text layer, no continuous/spread page modes, no page-thumbnail
  reordering, no image editing/cropping.
- **No toolbar redesign.** Control layout, iconography and placement stay as they are.
  (N2 changes *when* the mermaid expand button is visible, not what it looks like.)
- **No change to how the host reads files.** `FileContentDTO`, the data-URL transport, the
  size caps and the IPC surface are untouched; every fix is renderer-side.
- **No new dependency.** pdf.js, mermaid and their versions stay pinned as-is.
- **No mermaid version bump** to chase upstream sizing behaviour — the normaliser (B2)
  makes us independent of it.
- **No persistence** of per-document zoom/fit/rotation across sessions.
- Diagram/image/PDF **rendering performance** (canvas tiling, worker pools, mermaid render
  time) is not in scope beyond not regressing it.

---

## §5 Test plan

### Unit (pure, `test/unit/`) — vitest, part of `npm run verify`

| Function | File | What is asserted |
|---|---|---|
| `fitScale(natural, pane, { allowUpscale })` | `webview/image-zoom.ts` | never > 1 when `allowUpscale:false`; upscales to the constrained axis when `true`; degenerate sizes → 1; both axes respected |
| `normalizeSvgForZoom` | `webview/svg-normalize.ts` (new) | strips `max-width` from the root `style` only; removes root `width`/`height` attributes; keeps `viewBox`/`id`/`class`/`aria-*`; leaves other `style` declarations; **no-op** when neither present; body bytes unchanged; tolerates attribute order, single/double quotes, self-closed and multi-line tags |
| `inlineDiagramScale` | `webview/mermaid-scale.ts` (new) | fits the column; respects `maxHeight`; clamps at `minScale` and reports `scrolls: true`; never upscales; 1:1 when it already fits |
| `fitScaleForPages` (widest page / largest box) | `webview/pdf-fit.ts` (new) | width fit uses the max page width, page fit the max bounding box; rotation-aware swap; clamped to `[MIN_SCALE, MAX_SCALE]`; single-page and empty inputs |
| `clampZoom(zoom, fit, { allowUpscale })` | `webview/image-zoom.ts` | ceiling is `8` for raster; `fit × 8` when upscaling, so four button-steps from an upscaled fit all still increase (A6); floor is always `fit` |
| Rendered-box clamp (B5) | `webview/mermaid-scale.ts` | a requested box beyond 16,384 px on either edge is clamped, aspect preserved, and the reported scale is the applied one |
| `canPan` / `clampPan` against the **rendered** box | `webview/image-zoom.ts` | false when content fits on both axes at the rendered size |
| `rotatedNatural` × fit × pan bounds | `webview/image-zoom.ts` / `image-stage.tsx` | at 90°/270° the fit uses swapped bounds and `clampPan` bounds swap with it |
| `usePanZoomStage` readiness + snap across a reset | `test/unit/pan-zoom-ready.test.ts` (jsdom) | a `resetKey` change with the content unchanged returns `ready` to true and the zoom to fit — both used to be keyed on dependencies a reset does not move |

### Real-app e2e — `test/e2e/viewer-robustness.e2e.mjs`

New scenario on the shared harness (`test/e2e/harness.mjs`), run with
`node test/e2e/run-smoke.mjs viewer-robustness` (see CLAUDE.md — this is the repo's
runtime-proof convention; e2e is not part of `verify`). Reuse the diagnostic's corpus
generator so fixtures and measurements stay comparable.

**Implemented — the 13 assertions the scenario actually makes.** Each guards a fix nothing
else covers.

| # | Behaviour | Assertion |
|---:|---|---|
| 1 | **First paint** (D7, flows 52–56) | a 4000 px image is sampled per rAF *and* per inline-style mutation from mount; no sample is wider than the stage |
| 2 | **Passive-listener errors** (D10) | console error count for `Unable to preventDefault` is 0 across the whole walk |
| 3 | **Intrinsic-size-less SVG** (D8/A4, flow 57) | `img-vector.svg`'s laid-out box equals its natural size and is narrower than the stage |
| 4 | **Overlay zoom monotonicity** (D4/D5) | 3 further zoom-ins each strictly increase the rendered SVG width; aspect within 1% |
| 5 | **Overlay fit** (D6) | fill ratio ≥ 0.9 on at least one axis at fit |
| 6 | **Inline floor + scroll** (D1/D2/C1) | `wide.md` renders at ≥ 0.35 scale and `scrollWidth > clientWidth` |
| 7 | **Mermaid orphan node** (D3) | 0 `[id^="dmermaid-"]` nodes in `<body>` while the error card shows |
| 8 | **PDF→PDF switch** (D11) | the second document loads, 0 "could not be opened" notices |
| 9 | **PDF fit on open** (D12) | landscape doc opens with `aria-pressed="true"` on Width and no horizontal overflow |
| 10 | **No transform transition** (A3) | computed `transition-property` on `.imgstage__img` contains neither `transform` nor `all` |
| 11 | **Expand affordance** (C4/N2) | on a floor-scaled diagram the expand button computes `opacity: 1`, hit-testable, with the pointer parked away from it |
| 12 | **Five consecutive PDF→PDF switches** (Lane D acceptance) | all 5 render the expected page count, 0 error notices |
| 13 | **PDF resize re-fit** (PD3/D13) | narrow then widen: the rendered page shrinks and grows back, never overflows, and Width's `aria-pressed` stays truthful throughout |

**Accepted as unmeasured, with a reason.** Listed rather than deleted — this is what the
scenario does *not* prove, so nobody reads the 13 above as more coverage than they are.

| Row / flow | Why it is not asserted |
|---|---|
| Fade-in timing (A2) | the app launches hidden, so rAF is throttled to ~1 fps — an opacity *tween* cannot be sampled, only its settled value. The gate it exists for is covered by row 1 (nothing wrongly sized is ever painted). |
| `prefers-reduced-motion` (A3) | Playwright's emulation reaches the renderer, but the assertion would only re-read the same computed `transition` row 10 already reads. |
| PDF mixed-size fit-width (D14) | needs a mixed-page fixture; the geometry is the unit-tested `fitScaleForPages`, and the viewer feeds it every page's size. |
| Inline height cap (N1/C2) | the cap is a share of `window.innerHeight`, which the hidden launch reports but never lays out against a real viewport; `inlineDiagramScale` is unit-tested against it. |
| Zoom readout / drag on the vector SVG (flow 58) | row 3 pins the layout box, which is the mechanism; the readout and pan math read the same number. |
| Rotation (flow 65) | `rotatedNatural` × fit × pan bounds is unit-covered; no rotation-specific DOM defect was measured. |
| Ctrl+wheel (PD5/N3) | Playwright's `mouse.wheel` does not carry a modifier state the native listener sees; needs a synthesised `WheelEvent`, which would test the synthesis. |
| Scrollable region keyboard (C5) | the tab stop and accessible name are static props on a `scrolls` wrapper, and row 6 proves `scrolls` is reached. |
| Overlay focus trap (B4) | Tab-cycling through a hidden window's focus ring is exactly the kind of assertion that passes against a build no user could operate. |
| Image → image switch (flow 66), image resize (flows 67–68) | the reset-and-refit path is now unit-covered in `test/unit/pan-zoom-ready.test.ts`, which is where its two regressions actually lived. |
| Flows 24, 25, 28, 42–45, 60, 80–81, 84 | the "cheap to fold in" bucket from the original plan. None is a lane fix: they are pre-existing interactions this spec does not change. Not added. |
| Flow 19 (unicode/CJK/RTL labels) | the fix is size-driven and label-agnostic; no assertion was ever specified. |
| Flows 47–48, 69 | covered by `mermaid-export.e2e.mjs` / `image-diff.e2e.mjs`. |
| Flow 77 (password-protected) | needs an encrypted fixture; the mapping is unit-visible via `PdfLoadException`. |
| Flows 85–88 (outline, thumbnails, find) | untouched by this spec, covered by `pdf-viewer.e2e.mjs`. |

Existing `pdf-viewer.e2e.mjs`, `image-diff.e2e.mjs`, `rich-content.e2e.mjs` and
`mermaid-export.e2e.mjs` must stay green — they are the regression net for the surfaces
this touches.

### Re-run the diagnostic

The evidence walk that produced `.autoloop/evidence/viewer-diag.md` is re-runnable. Re-run
it after the lanes land and diff the tables — every `BUG Dn` / `BUG Nn` row in §1 should
flip. The two `BY DESIGN` rows (49, 50 / D9) are the exception and stay as measured.
Heads-up from CLAUDE.md: PTY-adjacent e2es fail on a loaded machine the same way a real
regression does; re-run a failure alone before believing it.

---

## §6 Assumptions & queued decisions

### Assumptions taken

1. **Legibility floor `minScale = 0.35`** — a starting value, not a measured one. Tunable
   product call (see Decisions Needed).
2. **Inline height cap ≈ 70 vh** — chosen so a diagram never fully displaces the prose
   around it while staying large enough to read. Tunable alongside (1).
3. **Fade duration ~120 ms**, opacity only. Matches the existing `.imgstage__controls`
   `transition: opacity 0.12s`, so the viewers stay internally consistent.
4. **Inline never upscales.** A small diagram stays 1:1 inline; the overlay is where a
   small diagram fills the screen. Keeps prose rhythm predictable.
5. **Raster keeps the never-upscale fit** (`allowUpscale: false`), so D9 (a 1×1 image as a
   speck) is *accepted behaviour* inline with the fit rule — the user can still zoom to
   800%. Only the vector overlay upscales.
6. **No persistence** of zoom/fit/rotation per document (consistent with today).
7. **No i18n layer exists in this repo** — user-facing strings are literals in components.
   New strings follow that pattern; percentages keep going through `zoomPercent()` so the
   number formatting stays in one place. Nothing here introduces concatenated sentences or
   count-dependent plurals, so there is no new pluralization surface.
8. **The diagnostic corpus is representative.** Unicode/CJK/RTL labels (flow 19) were not
   measured; the fix is size-driven and label-agnostic, so no separate mechanism is
   specified for them — but flow 19 should be added to the corpus.
9. `prefers-reduced-motion` is honoured by dropping the fade entirely rather than
   shortening it.

### Decisions Needed

- **[normal] Legibility floor value.** `0.35` is a guess. The trade-off: a lower floor
  keeps more giant diagrams inline (no scrollbar) at the cost of readability; a higher
  floor makes more diagrams scroll. Default taken: `0.35`, exposed as a constant so one
  edit retunes it. Not exposed as a user setting.
- **[normal] Fit-width on open as the PDF default.** Fit-width is what most readers do and
  it removes the horizontal scroll on open; the alternative is fit-page (whole first page
  visible, smaller text). Default taken: **fit-width**, per the settled §3 Lane PD2.
- **[normal] Inline height cap value (70 vh).** Same shape of trade-off as the floor;
  default taken as specified.
- **[normal] Does the mermaid expand affordance become persistent for *all* diagrams?**
  Default taken: **no** — persistent only when the diagram is scaled to the floor or hit
  the height cap (C4), hover-revealed otherwise, so ordinary docs keep their clean look.

No `high` flags: every decision above is a tunable constant or a reversible default, and
none of them changes the shape of the work.

---

## §7 State catalog (UI)

| Component | State | What the user sees | Action / CTA |
|---|---|---|---|
| Image stage | loading (`!ready`) | checkerboard stage, controls hidden, content at `opacity: 0` | — |
| Image stage | ideal | image fitted (or at the user's zoom), fading in once; controls on hover/focus | zoom / rotate / reset |
| Image stage | error | `.viewer__notice` "Could not render image."; controls and caption hidden | — |
| Image stage | zoomed past 1× | `image-rendering: pixelated`; grab cursor when pannable | drag / arrows / reset |
| Image stage | at fit | no pan cursor, drag is a no-op | zoom in |
| Mermaid inline | loading | `.mermaid-loading` placeholder, `aria-label="Rendering diagram…"` | — |
| Mermaid inline | ideal (fits) | diagram at 1:1, expand button on hover | click / expand |
| Mermaid inline | scaled to floor / height-capped | diagram in a horizontally scrollable wrapper, **expand button persistently visible** | expand to overlay |
| Mermaid inline | parse error | `.mermaid-error` message + the source fence; no orphan node | fix the fence |
| Mermaid inline | empty fence | `EmptyState` "Empty diagram" | — |
| Mermaid overlay | loading (`!ready`) | modal chrome and toolbar painted immediately, diagram at `opacity: 0` | — |
| Mermaid overlay | ideal | diagram filling the modal, `%` readout, toolbar | zoom / pan / export / close |
| Mermaid overlay | zoomed | grab cursor, pan bounded to the rendered box | drag / arrows / reset |
| PDF | loading | "Loading PDF…" notice | — |
| PDF | ideal | pages fitted to width, Width `aria-pressed="true"` | zoom / fit / rotate / find |
| PDF | partial (page sizes streaming) | placeholder-height pages; fit recomputes as real sizes arrive | scroll |
| PDF | error — corrupt | "“name” could not be opened (corrupt or invalid PDF)." | — |
| PDF | error — password | "“name” is password-protected (unsupported)." | — |
| PDF | find, no matches | `0/0`, prev/next disabled, no scroll | edit the query |
| PDF | find, matches | `n/total`, highlighted runs, scrolled to the active match | Enter / Shift+Enter |
| PDF | outline absent | "No outline" in the sidebar | switch to Thumbnails |

Not applicable: **first-run/blank-slate** (a viewer only exists because a file was opened
— there is no "never used yet" state to explain), **empty-after-action** (nothing here
clears), offline/degraded, permission-denied, not-found, saving/failed-save,
limit-reached — these viewers are read-only over an already-loaded local payload. The
host-side size cap surfaces as the existing "Binary file — no diff preview." notice,
unchanged by this spec.

## §8 Interaction inventory (UI)

| Component | Actions | Pointer | Keyboard | Touch | Context menu | ARIA |
|---|---|---|---|---|---|---|
| Image stage | zoom, pan, rotate, reset | wheel (non-passive), drag, toolbar clicks | Ctrl/Cmd `+`/`−`/`0`, arrows (pan), `R` (rotate) | `touch-action: none`; pinch not handled (unchanged) | none (unchanged) | `role="img"`, `aria-label` = filename; `aria-live="polite"` announces zoom % and "Rotated 90°" |
| Image toolbar | zoom in/out/reset/rotate | click | Tab + Enter/Space | tap | none | `role="toolbar"`, `aria-label="Image controls: <name>"`, per-button `aria-label` |
| Mermaid inline | open overlay; scroll a floor-scaled diagram | click the SVG **or** the expand button — except when the wrapper `scrolls`, where the body click is reserved so a mouse user can focus the region to arrow-scroll it and the (then persistent) expand button is the only way in; drag-scroll the wrapper | Tab to the expand button, Enter/Space; Tab into the wrapper + arrows when `scrolls` (C5) | tap the SVG body when it fits, otherwise the expand button, which is always visible under `@media (hover: none)` per C4 | none | expand button `aria-label="Open diagram in zoom viewer"`; scroll wrapper `role="region"` + name when `scrolls` |
| Mermaid overlay stage | zoom, pan, close | wheel (non-passive), drag, backdrop click | Ctrl/Cmd `+`/`−`/`0`, arrows, Esc; **Tab cycles within the dialog** (B4) | `touch-action: none` | none | `role="dialog"`, `aria-modal="true"`, `aria-label="Diagram viewer"`; focus moves in on open and **returns to the trigger on close** |
| Mermaid overlay toolbar | zoom, reset, export SVG/PNG, close | click | Tab + Enter/Space | tap | none | `role="toolbar"`; `aria-live="polite"` zoom announcements |
| PDF scroll area | scroll, zoom | wheel (scroll), **Ctrl/Cmd+wheel (zoom, non-passive)** | PageUp/PageDown, Home/End, Ctrl `+`/`−`, Ctrl+F | native scroll | none | — |
| PDF toolbar | page prev/next, jump, zoom, fit width/page, rotate, find | click, type | Tab + Enter/Space; Enter commits the page jump | tap | none | per-button `aria-label`; `aria-pressed` on Width/Page/Find/Sidebar **must stay truthful after a resize** |
| PDF sidebar | outline / thumbnails | click | Tab + Enter/Space | tap | none | `role="tablist"`/`role="tab"` + `aria-selected`; thumbs `aria-label="Go to page N"` |

Every pointer action already has a keyboard pathway; this spec adds none that doesn't
(Ctrl+wheel duplicates the existing Ctrl `+`/`−`). No drag-only action exists, so WCAG
2.5.7 is satisfied by the existing arrow-key pan.

## §9 Accessibility & i18n

- **Keyboard operability:** unchanged and preserved — removing the React `onWheel` prop
  (A5) must not remove any keyboard path; `onCoreKeyDown` stays the single source for
  Ctrl `+`/`−`/`0` and arrow-pan.
- **Visible focus (a fix, not a preservation):** `.imgstage__stage` and
  `.mermaid-zoom__stage` are `tabIndex={0}` and are the *only* keyboard targets for
  zoom/pan, yet both set `outline: none` (`webview/styles.css:9494`, `:10091`) — a WCAG
  2.4.7 failure today. Both gain a `:focus-visible` indicator using the app's existing
  `--focus-ring`, inset so it is not clipped by the stage's `overflow: hidden`. The same
  applies to the new C5 scroll wrapper. Making the mermaid expand affordance persistent
  (C4) **must not** drop its `:focus-visible` rule.
- **Focus containment:** the mermaid overlay declares `aria-modal="true"` but Tab escapes
  it into the page behind — B4 closes that.
- **Accessible names:** every new/changed control keeps an `aria-label`; the persistent
  expand affordance keeps "Open diagram in zoom viewer".
- **Announcements:** zoom changes already go through `aria-live="polite"`. The fade-in is
  purely visual and needs no announcement; `ready` must not gate the live region.
- **Truthful state:** `aria-pressed` on the PDF fit buttons is a correctness requirement,
  not a nicety — D13's stale fit made it lie. Assert it in e2e.
- **Colour is never the only signal:** unchanged; nothing here introduces a colour-only
  state.
- **Reduced motion:** the fade is the only animation and is dropped under
  `prefers-reduced-motion: reduce`; comprehension never depends on it (A3).
- **Contrast / forced colours:** unchanged; no new text or chrome.
- **i18n:** the repo has no i18n layer (see §6.7). New user-facing strings are literals in
  the component, single sentences, no runtime concatenation; percentages go through
  `zoomPercent()`. Layouts here are content-sized, so the ~30% text-expansion rule affects
  only the PDF toolbar labels ("Width"/"Page"), which are already in flexible flex rows.
  RTL: the viewers are geometric, not directional — no mirroring is specified, and diagram
  content mirrors only if the SVG itself does.

## §10 Design tokens

No new tokens. Semantic roles in play, all existing: `--panel` / `--panel-2` (stage and
toolbar grounds), `--border`, `--text` / `--text-dim`, `--raise` (expand affordance),
`--state-edge-hover`, `--checker-a` / `--checker-b` (the image checkerboard), `--r-sm` /
`--r-md`. The fade uses opacity only — no colour is introduced, so all three themes
(Aero / Aero Dark / Neon) and any high-contrast setting inherit correctly.

## §11 Scope slicing

- **MVP (must):** Lane PD1 (D11 — the critical PDF worker bug), Lane A1–A7 (D7, D8, D10),
  Lane B1–B3 + B5 (D4, D5, D6), Lane C1–C3 + C5 (D1, D2, D3, N1). A6 is MVP because B3
  consumes it.
- **v1 (should):** Lane PD2–PD5 (D12, D13, D14, N3), Lane C4 (N2), Lane B4 (focus trap),
  the `viewer-robustness` e2e scenario, and the diagnostic re-run.
- **Vision (could):** pinch-zoom on touch; per-document view-state memory (would extend
  the shipped `view-state-store`); mermaid render-time budget for very large graphs.
- **Out of scope:** §4.

## §12 Defaults vs. settings

| Decision | Default | Configurable? | Rationale |
|---|---|---|---|
| Inline legibility floor | `0.35` | no (constant) | one number to retune; a setting for it would be noise |
| Inline height cap | ~70 vh | no (constant) | same |
| Fade duration | 120 ms | no | matches the existing control fade |
| Raster fit upscaling | off | no | pixel fidelity — an upscaled raster is a lie about the file |
| Vector overlay upscaling | on | no | a full-screen modal showing a diagram at 12% is the bug |
| PDF fit on open | fit-width | no | matches every other PDF reader; removes the open-time h-scroll |
| Zoom/fit/rotation persistence | none | no | consistent with today; out of scope |

## §13 Edge cases & failure modes

| Condition | Expected behaviour |
|---|---|
| Content never decodes (corrupt image / PDF) | existing notice; `ready` never becomes true, so nothing is faded in and no controls show |
| Natural size is 0 or unknown | fit falls back to 1; no division by zero (`fitScale` already guards) |
| Pane measures 0 (hidden tab, collapsed pane) | `ready` stays false; on re-measure the fit applies before the next paint |
| Zero pages / empty `baseDims` | fit is a no-op; existing "Loading PDF…" holds |
| Page sizes still streaming when fit-width runs | fit recomputes on each `baseDims` change (Lane PD3) so the widest page wins as soon as it is known |
| Rapid PDF→PDF→PDF switching | each `task.destroy()` affects only its own task (Lane PD1); a superseded load is already guarded by `alive` |
| A mermaid render is superseded by a theme switch mid-flight | `cancelled` guard stays; the orphan-node removal (C3) is idempotent |
| An SVG with no `viewBox` **and** no intrinsic size | falls back to the measured bounding box (existing overlay path); inline scale treats it as 1:1 |
| Linked diff stages with different natural sizes | each side computes its own `ready`. **The shared snap-to-fit stays last-writer-wins** — both stages write the same `setZoom` with a `fit` computed from their own `natural`, so whichever side decodes last wins and the other can overflow its pane at "fit". Pre-existing (unchanged by this work) and left as-is: the correct rule is `min(fitA, fitB)`, which needs the shared bundle to carry a per-stage fit. Tracked in the run report, not fixed here. |
| Wheel gesture while `!ready` | ignored — no zoom state exists yet to change |
| `MAX_ZOOM` reached (raster) | clamps; the readout stops at 800% |
| Ceiling reached on a huge diagram in the overlay | B1 removes the shrink that used to mask this, so the box would want ~105,000 px on `mm-huge`; B5 clamps the rendered edge to 16,384 px and the readout reports the applied scale, not the requested one |
| Rotate while zoomed | zoom is preserved, fit and pan bounds recompute off the rotated bounds, pan is re-clamped (never left outside) |
| Rotate an intrinsic-size-less SVG | A4 pins the layout box, so `rotatedNatural()` and the pan bounds agree with what is on screen |

## Self-audit

Template sections 1–13 are all present (problem frame, behaviour/states, edge cases,
defaults, scope slicing, acceptance criteria, state catalog, interaction inventory,
a11y/i18n, tokens, assumptions, decisions-needed). The "Data / interface contract" is §3:
three new pure-function signatures plus **A7**, the changed `usePanZoomStage` / `fitScale`
shape and its call sites — there is no host or network interface in this feature
(renderer-only, §4). Acceptance criteria appear as declarative bullets per lane plus EARS
and Gherkin (FULL tier). Flow map: 89 numbered flows against a required minimum of 34.

A read-only reviewer pass spot-checked 14 of the source citations in §2 (all correct,
including the subtle D5 and D11 mechanisms) and found 16 coverage gaps, since closed:
the fit-relative ceiling (A6) that Lane B's own criterion needed, the changed hook
contract (A7), the overlay focus trap (B4), the huge-box clamp (B5), the keyboard-
reachable scroll region (C5), the touch/no-hover affordance rule and its label (C4), the
`outline: none` focus failure (§9), the Lane D → PD renumber that was colliding with
defect IDs, D9 reclassified `BY DESIGN` rather than left as an unfixed BUG, rotation
specified and tested, the MVP/v1 split that had B3 depending on a v1 item, and §5 rows
for D8, A3, C4, C5, B4, PD5 plus an explicit disposition for every remaining `UNTESTED`
flow.
