# Viewer diagnostic — measurements

Run: 2026-08-08T15:31:04.119Z → 2026-08-08T15:33:11.768Z · walk 117s
Window: 1600×1000 @dpr 1 (launched hidden, CONDUIT_E2E=1)
Corpus: `C:\Users\karam\AppData\Local\Temp\conduit-viewerdiag-FZCPze`

Measurement only — no fixes proposed, no app file modified.

## 1. Mermaid — inline

| case | settle ms | svgs | errors | empty | viewBox (intrinsic) | rendered w×h | shrink factor | host client/scroll W | overflows column |
|---|---:|---:|---:|---:|---|---|---:|---|---|
| mm-tiny.md | 414 | 1 | 0 | 0 | 111.45×174 | 111.45×174 | 1 | 864/864 | false |
| mm-small.md | 304 | 1 | 0 | 0 | 617.84×382 | 617.84×382 | 1 | 864/864 | false |
| mm-medium.md | 502 | 1 | 0 | 0 | 799.88×1526 | 799.88×1526 | 1 | 849/849 | false |
| mm-huge.md | 1803 | 1 | 0 | 0 | 13176.23×798 | 864×52.31 | 0.07 | 864/864 | false |
| mm-wide.md | 835 | 1 | 0 | 0 | 9820.02×70 | 864×6.16 | 0.09 | 864/864 | false |
| mm-tall.md | 786 | 1 | 0 | 0 | 134.17×6206 | 134.17×6206 | 1 | 849/849 | false |
| mm-sequence.md | 331 | 1 | 0 | 0 | 1276×1611 | 849×1071.89 | 0.67 | 849/849 | false |
| mm-class.md | 608 | 1 | 0 | 0 | 328.01×2362 | 328×2361.91 | 1 | 849/849 | false |
| mm-state.md | 370 | 1 | 0 | 0 | 321.55×1083 | 321.55×1083 | 1 | 849/849 | false |
| mm-er.md | 448 | 1 | 0 | 0 | 140.27×1749 | 140.27×1749 | 1 | 849/849 | false |
| mm-gantt.md | 293 | 1 | 0 | 0 | 1600×460 | 864×248.39 | 0.54 | 864/864 | false |
| mm-pie.md | 359 | 1 | 0 | 0 | 613.73×450 | 613.73×450 | 1 | 864/864 | false |
| mm-mindmap.md | 481 | 1 | 0 | 0 | 745.92×380.34 | 745.91×380.33 | 1 | 864/864 | false |
| mm-gitgraph.md | 284 | 1 | 0 | 0 | 371.13×159.84 | 371.13×159.83 | 1 | 864/864 | false |
| mm-journey.md | 193 | 1 | 0 | 0 | 1300×540 | 864×565 | 0.66 | 864/864 | false |
| mm-longlabels.md | 316 | 1 | 0 | 0 | 358.5×670 | 358.5×670 | 1 | 849/849 | false |
| mm-multi.md | 524 | 8 | 0 | 0 | 397.03×70 | 397.03×70 | 1 | 849/849 | false |
| mm-broken.md | 166 | 0 | 1 | 0 | — | — | — | — | — |
| mm-empty.md | 164 | 0 | 0 | 1 | — | — | — | — | — |
| mm-in-prose.md | 479 | 2 | 0 | 0 | 587.88×87.44 | 587.88×87.44 | 1 | 849/849 | false |

**mm-multi.md (8 concurrent fences):** 8 rendered as svg, 0 as `.mermaid-error`, settled in 9ms. Errors: []

## 2. Mermaid — zoom overlay

### mm-tiny.md

- open in 9ms · stage 948×898 · content 111.45×174 · **fill ratio 0.12** · pct 100%
- content inline style: `transform: translate(0px, 0px); width: 111.453px; height: 174px;`
- inner svg: attr 100%×null, css 111.453px/174px maxWidth 111.453px, rect 111.45×174
- first-paint sampling: requestAnimationFrame (49 samples, 1 distinct widths)

| action | pct | content w | content h | svg w | svg h | pannable |
|---|---|---:|---:|---:|---:|---|
| zoom in 1 | 125% | 139.31 | 217.5 | 111.45 | 217.5 | false |
| zoom in 2 | 156% | 174.14 | 271.88 | 111.45 | 271.88 | false |
| zoom in 3 | 195% | 217.67 | 339.84 | 111.45 | 339.84 | false |
| zoom in 4 | 244% | 272.09 | 424.8 | 111.45 | 424.8 | false |
| reset | 100% | 111.45 | 174 | 111.45 | 174 | false |
| zoom out 1 | 100% | 111.45 | 174 | 111.45 | 174 | false |
| zoom out 2 | 100% | 111.45 | 174 | 111.45 | 174 | false |
| zoom out 3 | 100% | 111.45 | 174 | 111.45 | 174 | false |
| zoom out 4 | 100% | 111.45 | 174 | 111.45 | 174 | false |
| zoom out 5 | 100% | 111.45 | 174 | 111.45 | 174 | false |
| zoom out 6 | 100% | 111.45 | 174 | 111.45 | 174 | false |

- wheel: pct 100% → 110% (changed=true); ancestor scrolled = false

### mm-medium.md

- open in 45ms · stage 948×898 · content 470.69×898 · **fill ratio 0.5** · pct 59%
- content inline style: `transform: translate(0px, 0px); width: 470.7px; height: 898px;`
- inner svg: attr 100%×null, css 470.688px/898px maxWidth 799.875px, rect 470.69×898
- first-paint sampling: requestAnimationFrame (64 samples, 2 distinct widths)

| action | pct | content w | content h | svg w | svg h | pannable |
|---|---|---:|---:|---:|---:|---|
| zoom in 1 | 74% | 588.36 | 1122.5 | 588.36 | 1122.5 | true |
| zoom in 2 | 92% | 735.45 | 1403.13 | 735.45 | 1403.13 | true |
| zoom in 3 | 115% | 919.33 | 1753.91 | 799.88 | 1753.91 | true |
| zoom in 4 | 144% | 948 | 2192.38 | 799.88 | 2192.38 | true |
| reset | 59% | 470.69 | 898 | 470.69 | 898 | false |
| zoom out 1 | 59% | 470.69 | 898 | 470.69 | 898 | false |
| zoom out 2 | 59% | 470.69 | 898 | 470.69 | 898 | false |
| zoom out 3 | 59% | 470.69 | 898 | 470.69 | 898 | false |
| zoom out 4 | 59% | 470.69 | 898 | 470.69 | 898 | false |
| zoom out 5 | 59% | 470.69 | 898 | 470.69 | 898 | false |
| zoom out 6 | 59% | 470.69 | 898 | 470.69 | 898 | false |

- wheel: pct 59% → 65% (changed=true); ancestor scrolled = false

### mm-huge.md

- open in 169ms · stage 948×898 · content 948×57.41 · **fill ratio 1** · pct 7%
- content inline style: `transform: translate(0px, 0px); width: 948px; height: 57.4143px;`
- inner svg: attr 100%×null, css 948px/57.4062px maxWidth 13176.2px, rect 948×57.41
- first-paint sampling: requestAnimationFrame (61 samples, 1 distinct widths)

| action | pct | content w | content h | svg w | svg h | pannable |
|---|---|---:|---:|---:|---:|---|
| zoom in 1 | 9% | 948 | 71.77 | 948 | 71.77 | true |
| zoom in 2 | 11% | 948 | 89.7 | 948 | 89.7 | true |
| zoom in 3 | 14% | 948 | 112.13 | 948 | 112.13 | true |
| zoom in 4 | 18% | 948 | 140.16 | 948 | 140.16 | true |
| reset | 7% | 948 | 57.41 | 948 | 57.41 | false |
| zoom out 1 | 7% | 948 | 57.41 | 948 | 57.41 | false |
| zoom out 2 | 7% | 948 | 57.41 | 948 | 57.41 | false |
| zoom out 3 | 7% | 948 | 57.41 | 948 | 57.41 | false |
| zoom out 4 | 7% | 948 | 57.41 | 948 | 57.41 | false |
| zoom out 5 | 7% | 948 | 57.41 | 948 | 57.41 | false |
| zoom out 6 | 7% | 948 | 57.41 | 948 | 57.41 | false |

- wheel: pct 7% → 8% (changed=true); ancestor scrolled = false

### mm-wide.md

- open in 65ms · stage 948×898 · content 948×6.75 · **fill ratio 1** · pct 10%
- content inline style: `transform: translate(0px, 0px); width: 948px; height: 6.75763px;`
- inner svg: attr 100%×null, css 948px/6.75px maxWidth 9820.02px, rect 948×6.75
- first-paint sampling: requestAnimationFrame (62 samples, 1 distinct widths)

| action | pct | content w | content h | svg w | svg h | pannable |
|---|---|---:|---:|---:|---:|---|
| zoom in 1 | 12% | 948 | 8.44 | 948 | 8.44 | true |
| zoom in 2 | 15% | 948 | 10.55 | 948 | 10.55 | true |
| zoom in 3 | 19% | 948 | 13.19 | 948 | 13.19 | true |
| zoom in 4 | 24% | 948 | 16.48 | 948 | 16.48 | true |
| reset | 10% | 948 | 6.75 | 948 | 6.75 | false |
| zoom out 1 | 10% | 948 | 6.75 | 948 | 6.75 | false |
| zoom out 2 | 10% | 948 | 6.75 | 948 | 6.75 | false |
| zoom out 3 | 10% | 948 | 6.75 | 948 | 6.75 | false |
| zoom out 4 | 10% | 948 | 6.75 | 948 | 6.75 | false |
| zoom out 5 | 10% | 948 | 6.75 | 948 | 6.75 | false |
| zoom out 6 | 10% | 948 | 6.75 | 948 | 6.75 | false |

- wheel: pct 10% → 11% (changed=true); ancestor scrolled = false

### mm-tall.md

- open in 48ms · stage 948×898 · content 19.41×898 · **fill ratio 0.02** · pct 14%
- content inline style: `transform: translate(0px, 0px); width: 19.4145px; height: 898px;`
- inner svg: attr 100%×null, css 19.4062px/898px maxWidth 134.172px, rect 19.41×898
- first-paint sampling: requestAnimationFrame (64 samples, 2 distinct widths)

| action | pct | content w | content h | svg w | svg h | pannable |
|---|---|---:|---:|---:|---:|---|
| zoom in 1 | 18% | 24.27 | 1122.5 | 24.27 | 1122.5 | true |
| zoom in 2 | 23% | 30.33 | 1403.13 | 30.33 | 1403.13 | true |
| zoom in 3 | 28% | 37.91 | 1753.91 | 37.91 | 1753.91 | true |
| zoom in 4 | 35% | 47.39 | 2192.38 | 47.39 | 2192.38 | true |
| reset | 14% | 19.41 | 898 | 19.41 | 898 | false |
| zoom out 1 | 14% | 19.41 | 898 | 19.41 | 898 | false |
| zoom out 2 | 14% | 19.41 | 898 | 19.41 | 898 | false |
| zoom out 3 | 14% | 19.41 | 898 | 19.41 | 898 | false |
| zoom out 4 | 14% | 19.41 | 898 | 19.41 | 898 | false |
| zoom out 5 | 14% | 19.41 | 898 | 19.41 | 898 | false |
| zoom out 6 | 14% | 19.41 | 898 | 19.41 | 898 | false |

- wheel: pct 14% → 16% (changed=true); ancestor scrolled = false

### mm-sequence.md

- open in 23ms · stage 948×898 · content 711.25×898 · **fill ratio 0.75** · pct 56%
- content inline style: `transform: translate(0px, 0px); width: 711.265px; height: 898px;`
- inner svg: attr 100%×null, css 711.25px/898px maxWidth 1276px, rect 711.25×898
- first-paint sampling: requestAnimationFrame (61 samples, 1 distinct widths)

| action | pct | content w | content h | svg w | svg h | pannable |
|---|---|---:|---:|---:|---:|---|
| zoom in 1 | 70% | 889.08 | 1122.5 | 889.08 | 1122.5 | true |
| zoom in 2 | 87% | 948 | 1403.13 | 948 | 1403.13 | true |
| zoom in 3 | 109% | 948 | 1753.91 | 948 | 1753.91 | true |
| zoom in 4 | 136% | 948 | 2192.38 | 948 | 2192.38 | true |
| reset | 56% | 711.25 | 898 | 711.25 | 898 | false |
| zoom out 1 | 56% | 711.25 | 898 | 711.25 | 898 | false |
| zoom out 2 | 56% | 711.25 | 898 | 711.25 | 898 | false |
| zoom out 3 | 56% | 711.25 | 898 | 711.25 | 898 | false |
| zoom out 4 | 56% | 711.25 | 898 | 711.25 | 898 | false |
| zoom out 5 | 56% | 711.25 | 898 | 711.25 | 898 | false |
| zoom out 6 | 56% | 711.25 | 898 | 711.25 | 898 | false |

- wheel: pct 56% → 61% (changed=true); ancestor scrolled = false

## 3. Image viewer

| case | natural | stage | first rendered W | last rendered W | distinct Ws | first W > stage | first H > stage | sampling |
|---|---|---|---:|---:|---:|---|---|---|
| img-1x1.png | 1×1 | 950×798 | 1 | 1 | 1 | **false** (0×) | **false** (0×) | requestAnimationFrame |
| img-64.png | 64×64 | 950×798 | 64 | 64 | 1 | **false** (0.07×) | **false** (0.08×) | requestAnimationFrame |
| img-800x600.png | 800×600 | 950×798 | 800 | 800 | 1 | **false** (0.84×) | **false** (0.75×) | requestAnimationFrame |
| img-4000x3000.png | 4000×3000 | 950×798 | 4000 | 950 | 11 | **true** (4.21×) | **true** (3.76×) | requestAnimationFrame |
| img-ultrawide.png | 12000×400 | 950×798 | 12000 | 950 | 11 | **true** (12.63×) | **false** (0.5×) | requestAnimationFrame |
| img-ultratall.png | 400×12000 | 950×798 | 400 | 26.6 | 11 | **false** (0.42×) | **true** (15.04×) | requestAnimationFrame |
| img-exactpane.png | 1200×700 | 950×798 | 1200 | 950 | 11 | **true** (1.26×) | **false** (0.88×) | requestAnimationFrame |
| img-vector.svg | 225×150 | 950×798 | 950 | 950 | 1 | **false** (1×) | **false** (0.79×) | requestAnimationFrame |
| img-vector-sized.svg | 2400×1600 | 950×798 | 2400 | 950 | 11 | **true** (2.53×) | **true** (2.01×) | requestAnimationFrame |
| img-corrupt.png | null×null | 950×798 | — | 0 | 1 | **null** (null×) | **null** (null×) | MutationObserver(style) |

| case | wheel zoom | wheel changed | ancestor scrolled |
|---|---|---|---|
| img-1x1.png | 100% → 110% | true | false |
| img-64.png | 100% → 110% | true | false |
| img-800x600.png | 100% → 110% | true | false |
| img-4000x3000.png | 24% → 26% | true | false |
| img-ultrawide.png | 8% → 9% | true | false |
| img-ultratall.png | 7% → 7% | false | false |
| img-exactpane.png | 79% → 87% | true | false |
| img-vector.svg | 100% → 110% | true | false |
| img-vector-sized.svg | 40% → 44% | true | false |

| case | zoom text | caption | rendered ÷ natural | natural == fixture | imageRendering | transition | load-error notice |
|---|---|---|---:|---|---|---|---|
| img-1x1.png | 100% | 1 × 1 px · 69 B · 100% | 1 | true | auto | transform 0.08s ease-out | — |
| img-64.png | 100% | 64 × 64 px · 7.6 KB · 100% | 1 | true | auto | transform 0.08s ease-out | — |
| img-800x600.png | 100% | 800 × 600 px · 11.8 KB · 100% | 1 | true | auto | transform 0.08s ease-out | — |
| img-4000x3000.png | 24% | 4000 × 3000 px · 328.2 KB · 24% | 0.24 | true | auto | transform 0.08s ease-out | — |
| img-ultrawide.png | 8% | 12000 × 400 px · 259.3 KB · 8% | 0.08 | true | auto | transform 0.08s ease-out | — |
| img-ultratall.png | 7% | 400 × 12000 px · 106.6 KB · 7% | 0.07 | true | auto | transform 0.08s ease-out | — |
| img-exactpane.png | 79% | 1200 × 700 px · 21.4 KB · 79% | 0.79 | true | auto | transform 0.08s ease-out | — |
| img-vector.svg | 100% | 225 × 150 px · 258 B · 100% | 4.22 | null | auto | transform 0.08s ease-out | — |
| img-vector-sized.svg | 40% | 2400 × 1600 px · 307 B · 40% | 0.4 | true | auto | transform 0.08s ease-out | — |
| img-corrupt.png | null | null | — | null | null | null | Could not render image. |

### img-1x1.png zoom series

in: 125%/1.25px → 156%/1.56px → 195%/1.95px → 244%/2.44px

out: 195%/1.95px → 156%/1.56px → 125%/1.25px → 100%/1px → 100%/1px → 100%/1px

drag-pan: pannable=false moved=false (Δx 0, Δy 0) · transition `transform 0.08s ease-out`

### img-64.png zoom series

in: 125%/80px → 156%/100px → 195%/125px → 244%/156.25px

out: 195%/125px → 156%/100px → 125%/80px → 100%/64px → 100%/64px → 100%/64px

drag-pan: pannable=false moved=false (Δx 0, Δy 0) · transition `transform 0.08s ease-out`

### img-800x600.png zoom series

in: 125%/1000px → 156%/1250px → 195%/1562.5px → 244%/1953.13px

out: 195%/1562.5px → 156%/1250px → 125%/1000px → 100%/800px → 100%/800px → 100%/800px

drag-pan: pannable=true moved=true (Δx -120, Δy -80) · transition `transform 0.08s ease-out`

### img-4000x3000.png zoom series

in: 30%/1187.5px → 37%/1484.38px → 46%/1855.47px → 58%/2319.34px

out: 46%/1855.47px → 37%/1484.38px → 30%/1187.5px → 24%/950px → 24%/950px → 24%/950px

drag-pan: pannable=true moved=true (Δx -120, Δy -80) · transition `transform 0.08s ease-out`

### img-ultrawide.png zoom series

in: 10%/1187.5px → 12%/1484.38px → 15%/1855.47px → 19%/2319.34px

out: 15%/1855.47px → 12%/1484.38px → 10%/1187.5px → 8%/950px → 8%/950px → 8%/950px

drag-pan: pannable=true moved=true (Δx -120, Δy 0) · transition `transform 0.08s ease-out`

### img-ultratall.png zoom series

in: 8%/33.25px → 10%/41.56px → 13%/51.95px → 16%/64.94px

out: 13%/51.95px → 10%/41.56px → 8%/33.25px → 7%/26.6px → 7%/26.6px → 7%/26.6px

drag-pan: pannable=true moved=true (Δx 0, Δy -80) · transition `transform 0.08s ease-out`

### img-exactpane.png zoom series

in: 99%/1187.5px → 124%/1484.38px → 155%/1855.47px → 193%/2319.34px

out: 155%/1855.47px → 124%/1484.38px → 99%/1187.5px → 79%/950px → 79%/950px → 79%/950px

drag-pan: pannable=true moved=true (Δx -120, Δy -80) · transition `transform 0.08s ease-out`

### img-vector.svg zoom series

in: 125%/1187.5px → 156%/1484.38px → 195%/1855.47px → 244%/2319.34px

out: 195%/1855.47px → 156%/1484.38px → 125%/1187.5px → 100%/950px → 100%/950px → 100%/950px

drag-pan: pannable=false moved=false (Δx 0, Δy 0) · transition `transform 0.08s ease-out`

### img-vector-sized.svg zoom series

in: 49%/1187.5px → 62%/1484.38px → 77%/1855.47px → 97%/2319.34px

out: 77%/1855.47px → 62%/1484.38px → 49%/1187.5px → 40%/950px → 40%/950px → 40%/950px

drag-pan: pannable=true moved=true (Δx -120, Δy -80) · transition `transform 0.08s ease-out`

## 4. PDF viewer

| case | pages | open zoom | canvas CSS W | scroll client W | overflows on open | Width pressed | Page pressed | 1st open failed → retry |
|---|---|---|---|---:|---|---|---|---|
| pdf-1page.pdf | / 1 | 145% | 887px | 935 | **false** | true | false | no |
| pdf-20page.pdf | / 20 | 145% | 887px | 935 | **false** | true | false | no |
| pdf-landscape.pdf | / 3 | 72% | 887px | 935 | **false** | true | false | no |
| pdf-mixed.pdf | / 4 | 56% | 343px | 935 | **false** | true | false | no |
| pdf-huge-page.pdf | / 1 | 18% | 887px | 935 | **false** | true | false | no |
| pdf-corrupt.pdf | — | — | — | — | **null** | null | null | no |


### Lane D acceptance

- **PD1 — PDF→PDF switching:** 5/5 transitions behaved correctly (4/4 valid documents loaded on the FIRST attempt, 0 spurious "corrupt or invalid PDF" notices).
- **PD2/PD4 — fit on open:** 5/5 documents opened with Width `aria-pressed="true"` and no horizontal overflow (pdf-1page.pdf 145%/overflow false/pressed true; pdf-20page.pdf 145%/overflow false/pressed true; pdf-landscape.pdf 72%/overflow false/pressed true; pdf-mixed.pdf 56%/overflow false/pressed true; pdf-huge-page.pdf 18%/overflow false/pressed true).
- **PD4 — widest page:** `pdf-mixed.pdf` after fit-width → 56%, page sizes ["343x444","334x472","343x888","888x343"] in a 935 px viewport → overflow **false**.
- **PD3 — resize:** fit stale on 0/5 documents; after narrow→wide: pdf-1page.pdf 33%→145% (overflow false, Width pressed true); pdf-20page.pdf 31%→145% (overflow false, Width pressed true); pdf-landscape.pdf 17%→72% (overflow false, Width pressed true); pdf-mixed.pdf 13%→56% (overflow false, Width pressed true); pdf-huge-page.pdf 10%→18% (overflow false, Width pressed true)
- **PD5 — wheel:** ctrl+wheel changed the zoom on 5/5; plain wheel scrolled without zooming on 5/5. pdf-1page.pdf: plain 145%@0→145%@300, ctrl 145%→165%; pdf-20page.pdf: plain 145%@0→145%@300, ctrl 145%→165%; pdf-landscape.pdf: plain 72%@0→72%@300, ctrl 72%→92%; pdf-mixed.pdf: plain 56%@0→56%@300, ctrl 56%→76%; pdf-huge-page.pdf: plain 18%@0→18%@129, ctrl 18%→38%

### pdf-1page.pdf

- after **Width**: zoom 145%, canvas 887px, scroll 935, overflow false
- after **window → 900px**: zoom 33%, canvas 202px, scroll 250, overflow false → **fit stale = false**
- after **window → 1600px**: zoom 145%, canvas 887px, scroll 935
- after **rotate 90°**: zoom 114%, page sizes ["902x697"]
- page sizes on open: ["887x1148"]

### pdf-20page.pdf

- after **Width**: zoom 145%, canvas 887px, scroll 935, overflow false
- after **window → 900px**: zoom 31%, canvas 188px, scroll 235, overflow false → **fit stale = false**
- after **window → 1600px**: zoom 145%, canvas 887px, scroll 935
- after **rotate 90°**: zoom 112%, page sizes ["888x686"]
- page sizes on open: ["887x1148"]

### pdf-landscape.pdf

- after **Width**: zoom 72%, canvas 887px, scroll 935, overflow false
- after **window → 900px**: zoom 17%, canvas 202px, scroll 250, overflow false → **fit stale = false**
- after **window → 1600px**: zoom 72%, canvas 887px, scroll 935
- after **rotate 90°**: zoom 112%, page sizes ["888x1371"]
- page sizes on open: ["887x574"]

### pdf-mixed.pdf

- after **Width**: zoom 56%, canvas 343px, scroll 935, overflow false
- after **window → 900px**: zoom 13%, canvas 79px, scroll 250, overflow false → **fit stale = false**
- after **window → 1600px**: zoom 56%, canvas 343px, scroll 935
- after **rotate 90°**: zoom 56%, page sizes ["444x343","472x334","888x343","343x888"]
- page sizes on open: ["343x444","334x472","343x888","888x343"]

### pdf-huge-page.pdf

- after **Width**: zoom 18%, canvas 887px, scroll 935, overflow false
- after **window → 900px**: zoom 10%, canvas 500px, scroll 250, overflow true → **fit stale = false**
- after **window → 1600px**: zoom 18%, canvas 887px, scroll 935
- after **rotate 90°**: zoom 18%, page sizes ["887x887"]
- page sizes on open: ["887x887"]

## 5. Console

16 messages captured; 2 distinct interesting.

- `15×` error: Unable to preventDefault inside passive event listener invocation.
- `1×` warning: Warning: Indexing all PDF objects

## 6. Per-case errors

None — every case completed.

---

# Observations that look like defects

Derived from the measurements above. Numeric evidence only — no remedies proposed.

## Mermaid — inline

### D1. Wide diagrams are silently downscaled to the column instead of scrolling; tall-aspect content collapses to a few pixels

- `mm-wide.md`: intrinsic 9820.02×70 rendered at 864×6.16 px (scale 0.09×)
- `mm-huge.md`: intrinsic 13176.23×798 rendered at 864×52.31 px (scale 0.07×)
- `mm-gantt.md`: intrinsic 1600×460 rendered at 864×248.39 px (scale 0.54×)
- `mm-journey.md`: intrinsic 1300×540 rendered at 864×565 px (scale 0.66×)
- `mm-sequence.md`: intrinsic 1276×1611 rendered at 849×1071.89 px (scale 0.67×)
- mermaid emits `width="100%"` + inline `max-width:<intrinsic>px`, so the SVG always fits the column width and shrinks vertically with it.
- Worst case `mm-wide.md` is **6.16 px tall** on screen.

### D2. `.mermaid-diagram__svg { overflow-x: auto }` never engages

- 0 of 20 markdown cases produced `scrollWidth > clientWidth`.
- Because the SVG is capped at 100% of the host width there is nothing to scroll — the escape hatch for an oversized diagram is dead code at every fixture size measured (up to a 13176 px intrinsic width).

### D3. A failed `mermaid.render` leaves its offscreen temp node in `<body>`

- `mm-broken.md`: 1 `#dmermaid-*` node(s) still attached to `document.body` while the error card is displayed.
- Every other case measured 0, so the leak is specific to the parse-error path.

## Mermaid — zoom overlay

### D4. Zoom-in raises the percentage while the rendered diagram stops growing at the stage width

- `mm-huge.md` (stage 948 px, opens at 948 px): 9%→948px, 11%→948px, 14%→948px, 18%→948px — 4 of 4 zoom-in steps produced **no width change**.
- `mm-wide.md` (stage 948 px, opens at 948 px): 12%→948px, 15%→948px, 19%→948px, 24%→948px — 4 of 4 zoom-in steps produced **no width change**.
- `mm-sequence.md` (stage 948 px, opens at 711.25 px): 70%→889.08px, 87%→948px, 109%→948px, 136%→948px — 2 of 4 zoom-in steps produced **no width change**.
- The content box is a flex item in the stage, so its inline `width` is shrunk back to the stage width; the percentage readout keeps climbing regardless.
- Meanwhile `pannable` reports [true] — the pan math believes intrinsic×zoom overflows the stage (e.g. 13176×0.09 = 1185 px vs a 948 px stage), so dragging is enabled over a box that is in fact already fully visible at 948 px.

### D5. The inner SVG stays clamped by mermaid's inline `max-width` while the content box grows — the diagram is stretched vertically only

- `mm-tiny.md` at 244%: content box 272.09×424.8 px but the SVG renders 111.45×424.8 px (its computed `max-width` is 111.453px).
- `mm-medium.md` at 144%: content box 948×2192.38 px but the SVG renders 799.88×2192.38 px (its computed `max-width` is 799.875px).
- Width is pinned at the intrinsic value while height follows the zoom, so the aspect ratio is wrong at every zoom level above fit.

### D6. The overlay opens far smaller than the modal for any diagram narrower than the stage

- `mm-tiny.md`: stage 948×898 px, content 111.45×174 px — **fill ratio 0.12** at "100%".
- `mm-medium.md`: stage 948×898 px, content 470.69×898 px — **fill ratio 0.5** at "59%".
- `mm-tall.md`: stage 948×898 px, content 19.41×898 px — **fill ratio 0.02** at "14%".
- Fit is `min(1, …)`, so "fit" never scales a small diagram up; a full-screen modal is opened to show something a fraction of its width.

## Image viewer

### D7. First-paint flash: the image paints at full natural size, then shrinks to fit

- `img-4000x3000.png`: natural 4000×3000, stage 950×798 — first rendered 4000×3000 px (**4.21× stage width, 3.76× stage height**), settling at 950×712.5; 11 distinct rendered widths observed.
- `img-ultrawide.png`: natural 12000×400, stage 950×798 — first rendered 12000×400 px (**12.63× stage width, 0.5× stage height**), settling at 950×31.67; 11 distinct rendered widths observed.
- `img-ultratall.png`: natural 400×12000, stage 950×798 — first rendered 400×12000 px (**0.42× stage width, 15.04× stage height**), settling at 26.6×798; 11 distinct rendered widths observed.
- `img-exactpane.png`: natural 1200×700, stage 950×798 — first rendered 1200×700 px (**1.26× stage width, 0.88× stage height**), settling at 950×554.17; 11 distinct rendered widths observed.
- `img-vector-sized.svg`: natural 2400×1600, stage 950×798 — first rendered 2400×1600 px (**2.53× stage width, 2.01× stage height**), settling at 950×633.33; 11 distinct rendered widths observed.
- Sampling method: requestAnimationFrame.
- The intermediate widths are the 80 ms `transition: transform` on `.imgstage__img`, i.e. the overshoot is an animated shrink, not a single dropped frame.
- Non-flashing controls: `img-1x1.png`, `img-64.png`, `img-800x600.png`, `img-vector.svg` — every image that already fits paints once.

### D8. An SVG with no intrinsic width/height is laid out at the stage width while the readout claims 100%

- `img-vector.svg`: `naturalWidth`×`naturalHeight` = 225×150, rendered 950×633.33 px = **4.22× natural**, zoom readout "100%", caption "225 × 150 px · 258 B · 100%".
- Zoom-in compounds it: ["125%/1187.5px","156%/1484.38px","195%/1855.47px","244%/2319.34px"] — "125%" of a 225 px-wide graphic renders 1187.5 px.
- `pannable` = false and a drag moved the image 0/0 px, because the pan math uses the 225 px figure, not what is on screen.

### D9. Small images are unreadable and cannot be enlarged to the pane

- `img-1x1.png`: 1×1 shown at 1×1 px inside a 950×798 stage at "100%"; four zoom-ins reach 2.44 px (244%).
- `img-64.png`: 64×64 shown at 64×64 px inside a 950×798 stage at "100%"; four zoom-ins reach 156.25 px (244%).
- Fit is capped at 1×, so the "reset to fit" state of a small image is a speck in the middle of the pane.

### D10. The wheel handler calls `preventDefault()` inside a passive listener — the call is discarded

- `15×` console error: "Unable to preventDefault inside passive event listener invocation." over the run (one per wheel gesture on `.imgstage__stage` / `.mermaid-zoom__stage`).
- Zoom still changed on every wheel gesture measured (e.g. `img-1x1.png` 100%→110%, `img-64.png` 100%→110%, `img-800x600.png` 100%→110%) and no ancestor scrolled in this layout, so the effect is latent rather than visible here — but the default action is not actually suppressed.

## PDF viewer

## Behaviours that measured correct

- Corrupt image → `.viewer__notice` "Could not render image." with controls hidden; corrupt PDF → notice in 160 ms, no hang.
- Invalid mermaid → one `.mermaid-error` with the parse message; empty fence → the "Empty diagram" empty state (1 rendered).
- 8 concurrent `mermaid.render` calls in one document all resolved to SVG (8/8, 0 errors) in 524 ms.
- Raster zoom-in/out steps track the percentage exactly (e.g. `img-800x600.png` 125%→1000 px, 156%→1250 px), drag-pan moves the image by the exact cursor delta, and mixed-size PDF pages lay out at their own sizes.
- Every generated PNG decoded to its fixture dimensions (`naturalWidth`/`naturalHeight` matched for 8/8 raster + sized-SVG cases).
