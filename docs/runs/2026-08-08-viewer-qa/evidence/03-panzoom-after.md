# Pan/zoom lanes A + B — post-fix evidence

Run: 2026-08-08T15:48:49.483Z → 2026-08-08T15:50:57.502Z · walk 117s · window 1600×1000
Source: `node .autoloop/viewer-diag.mjs` (real app, launched hidden, CONDUIT_E2E=1).
Baseline for every row is `.autoloop/evidence/viewer-diag.md` from before the change.

## Lane A

| fixture | natural | stage | distinct rendered widths (was 10–11) | first W | first > stage | transition-property |
|---|---|---|---:|---:|---|---|
| img-1x1.png | 1×1 | 950×798 | **1** [1] | 1 | false | `opacity 0.12s ease-out` |
| img-64.png | 64×64 | 950×798 | **1** [64] | 64 | false | `opacity 0.12s ease-out` |
| img-800x600.png | 800×600 | 950×798 | **1** [800] | 800 | false | `opacity 0.12s ease-out` |
| img-4000x3000.png | 4000×3000 | 950×798 | **1** [950] | 950 | false | `opacity 0.12s ease-out` |
| img-ultrawide.png | 12000×400 | 950×798 | **1** [950] | 950 | false | `opacity 0.12s ease-out` |
| img-ultratall.png | 400×12000 | 950×798 | **1** [26.6] | 26.6 | false | `opacity 0.12s ease-out` |
| img-exactpane.png | 1200×700 | 950×798 | **1** [950] | 950 | false | `opacity 0.12s ease-out` |
| img-vector.svg | 225×150 | 950×798 | **1** [225] | 225 | false | `opacity 0.12s ease-out` |
| img-vector-sized.svg | 2400×1600 | 950×798 | **1** [950] | 950 | false | `opacity 0.12s ease-out` |
| img-corrupt.png | null×null | —×— | **0** [] | — | null | `—` |

## Lane B

| fixture | fit % | fill W | fill H | pannable @ fit | 4 zoom-ins (pct / rendered SVG width) | strictly increasing | max aspect error |
|---|---|---:|---:|---|---|---|---:|
| mm-tiny.md | 516% | 0.61 | 1 | false | 645%/719 → 806%/898.75 → 1008%/1123.44 → 1260%/1404.3 | **true** | 0% |
| mm-medium.md | 59% | 0.5 | 1 | false | 74%/588.36 → 92%/735.45 → 115%/919.33 → 144%/1149.16 | **true** | 0.003% |
| mm-huge.md | 7% | 1 | 0.06 | false | 9%/1185 → 11%/1481.25 → 14%/1851.56 → 18%/2314.45 | **true** | 0.011% |
| mm-wide.md | 10% | 1 | 0.01 | false | 12%/1185 → 15%/1481.25 → 19%/1851.56 → 24%/2314.45 | **true** | 0.11% |
| mm-tall.md | 14% | 0.02 | 1 | false | 18%/24.27 → 23%/30.33 → 28%/37.91 → 35%/47.39 | **true** | 0.024% |
| mm-sequence.md | 56% | 0.75 | 1 | false | 70%/889.08 → 87%/1111.34 → 109%/1389.19 → 136%/1736.48 | **true** | 0.001% |

## Verdicts

| criterion | measurement | result |
|---|---|---|
| A — one distinct rendered width per image fixture | 9/9 | **PASS** |
| A — first rendered width never exceeds the stage for an oversized image | 9/9 (0 flashes) | **PASS** |
| A — passive-listener console errors (was 15) | 0 | **PASS** |
| A3 — no `transform` in the computed transition on `.imgstage__img` | `opacity 0.12s ease-out` | **PASS** |
| A4 — intrinsic-size-less SVG lays out at its natural box with a truthful readout | layout 225×150, natural 225×150, readout "100%" (was 950 px at "100%") | **PASS** |
| A4/EARS — drag moves by the cursor delta exactly when the box overflows | img-1x1.png fits→no-op; img-64.png fits→no-op; img-800x600.png Δ-120/-80; img-4000x3000.png Δ-120/-80; img-ultrawide.png Δ-120/0; img-ultratall.png Δ0/-80; img-exactpane.png Δ-120/-80; img-vector.svg fits→no-op; img-vector-sized.svg Δ-120/-80 | **PASS** |
| A5 — wheel still zooms and no ancestor scrolls | 9/9 (img-1x1.png 1→1.1px; img-64.png 64→70.4px; img-800x600.png 800→880px; img-4000x3000.png 950→1045px; img-ultrawide.png 950→1045px; img-ultratall.png 26.6→29.26px; img-exactpane.png 950→1045px; img-vector.svg 225→247.5px; img-vector-sized.svg 950→1045px) | **PASS** |
| B1/B2/A6 — four consecutive zoom-ins each strictly increase the rendered SVG width | 6/6 fixtures | **PASS** |
| B2 — rendered aspect stays within 1% of the viewBox aspect | max 0.1% | **PASS** |
| B3 — at fit, contentW/stageW ≥ 0.9 or contentH/stageH ≥ 0.9 | 6/6 | **PASS** |
| B — `pannable` false whenever the rendered box is fully visible | 6/6 at fit | **PASS** |

11/11 PASS.
