# Viewer diagnostic — measurements

Run: 2026-08-08T16:14:25.316Z → 2026-08-08T16:16:40.158Z · walk 126s
Window: 1600×1000 @dpr 1 (launched hidden, CONDUIT_E2E=1)
Corpus: `C:\Users\karam\AppData\Local\Temp\conduit-viewerdiag-iYeZpI`

Measurement only — no fixes proposed, no app file modified.

## 1. Mermaid — inline

| case | settle ms | svgs | errors | empty | viewBox (intrinsic) | rendered w×h | shrink factor | host client/scroll W | overflows column |
|---|---:|---:|---:|---:|---|---|---:|---|---|
| mm-tiny.md | 871 | 1 | 0 | 0 | 111.45×174 | 111.45×174 | 1 | 864/864 | false |
| mm-small.md | 733 | 1 | 0 | 0 | 617.84×382 | 617.84×382 | 1 | 864/864 | false |
| mm-medium.md | 937 | 1 | 0 | 0 | 799.88×1526 | 366.91×700 | 0.46 | 849/849 | false |
| mm-huge.md | 2277 | 1 | 0 | 0 | 13176.23×798 | 4611.67×279.3 | 0.35 | 864/4612 | true |
| mm-wide.md | 1293 | 1 | 0 | 0 | 9820.02×70 | 3437×24.5 | 0.35 | 864/3437 | true |
| mm-tall.md | 1185 | 1 | 0 | 0 | 134.17×6206 | 46.95×2172.09 | 0.35 | 834/834 | false |
| mm-sequence.md | 735 | 1 | 0 | 0 | 1276×1611 | 554.44×700 | 0.43 | 849/849 | false |
| mm-class.md | 1063 | 1 | 0 | 0 | 328.01×2362 | 114.8×826.69 | 0.35 | 834/834 | false |
| mm-state.md | 886 | 1 | 0 | 0 | 321.55×1083 | 207.83×700 | 0.65 | 849/849 | false |
| mm-er.md | 873 | 1 | 0 | 0 | 140.27×1749 | 56.13×700 | 0.4 | 849/849 | false |
| mm-gantt.md | 794 | 1 | 0 | 0 | 1600×460 | 864×248.39 | 0.54 | 864/864 | false |
| mm-pie.md | 735 | 1 | 0 | 0 | 613.73×450 | 613.73×450 | 1 | 864/864 | false |
| mm-mindmap.md | 809 | 1 | 0 | 0 | 745.92×380.34 | 745.91×380.33 | 1 | 864/864 | false |
| mm-gitgraph.md | 683 | 1 | 0 | 0 | 371.13×159.84 | 371.13×159.83 | 1 | 864/864 | false |
| mm-journey.md | 641 | 1 | 0 | 0 | 1300×540 | 864×358.89 | 0.66 | 864/864 | false |
| mm-longlabels.md | 714 | 1 | 0 | 0 | 358.5×670 | 358.5×670 | 1 | 849/849 | false |
| mm-multi.md | 970 | 8 | 0 | 0 | 397.03×70 | 397.03×70 | 1 | 849/849 | false |
| mm-broken.md | 592 | 0 | 1 | 0 | — | — | — | — | — |
| mm-empty.md | 562 | 0 | 0 | 1 | — | — | — | — | — |
| mm-in-prose.md | 923 | 2 | 0 | 0 | 587.88×87.44 | 587.88×87.44 | 1 | 849/849 | false |

**mm-multi.md (8 concurrent fences):** 8 rendered as svg, 0 as `.mermaid-error`, settled in 4ms. Errors: []

## 2. Mermaid — zoom overlay

### mm-tiny.md

- open in 6ms · stage 948×898 · content 575.19×898 · **fill ratio 0.61** · pct 516%
- content inline style: `transform: translate(0px, 0px); width: 575.201px; height: 898px;`
- inner svg: attr null×null, css 575.188px/898px maxWidth none, rect 575.19×898
- first-paint sampling: requestAnimationFrame (41 samples, 1 distinct widths)

| action | pct | content w | content h | svg w | svg h | pannable |
|---|---|---:|---:|---:|---:|---|
| zoom in 1 | 645% | 719 | 1122.5 | 719 | 1122.5 | true |
| zoom in 2 | 806% | 898.75 | 1403.13 | 898.75 | 1403.13 | true |
| zoom in 3 | 1008% | 1123.44 | 1753.91 | 1123.44 | 1753.91 | true |
| zoom in 4 | 1260% | 1404.3 | 2192.38 | 1404.3 | 2192.38 | true |
| reset | 516% | 575.19 | 898 | 575.19 | 898 | false |
| zoom out 1 | 516% | 575.19 | 898 | 575.19 | 898 | false |
| zoom out 2 | 516% | 575.19 | 898 | 575.19 | 898 | false |
| zoom out 3 | 516% | 575.19 | 898 | 575.19 | 898 | false |
| zoom out 4 | 516% | 575.19 | 898 | 575.19 | 898 | false |
| zoom out 5 | 516% | 575.19 | 898 | 575.19 | 898 | false |
| zoom out 6 | 516% | 575.19 | 898 | 575.19 | 898 | false |

- wheel: pct 516% → 568% (changed=true); ancestor scrolled = false

### mm-medium.md

- open in 15ms · stage 948×898 · content 470.69×898 · **fill ratio 0.5** · pct 59%
- content inline style: `transform: translate(0px, 0px); width: 470.7px; height: 898px;`
- inner svg: attr null×null, css 470.688px/898px maxWidth none, rect 470.69×898
- first-paint sampling: requestAnimationFrame (60 samples, 1 distinct widths)

| action | pct | content w | content h | svg w | svg h | pannable |
|---|---|---:|---:|---:|---:|---|
| zoom in 1 | 74% | 588.36 | 1122.5 | 588.36 | 1122.5 | true |
| zoom in 2 | 92% | 735.45 | 1403.13 | 735.45 | 1403.13 | true |
| zoom in 3 | 115% | 919.33 | 1753.91 | 919.33 | 1753.91 | true |
| zoom in 4 | 144% | 1149.16 | 2192.38 | 1149.16 | 2192.38 | true |
| reset | 59% | 470.69 | 898 | 470.69 | 898 | false |
| zoom out 1 | 59% | 470.69 | 898 | 470.69 | 898 | false |
| zoom out 2 | 59% | 470.69 | 898 | 470.69 | 898 | false |
| zoom out 3 | 59% | 470.69 | 898 | 470.69 | 898 | false |
| zoom out 4 | 59% | 470.69 | 898 | 470.69 | 898 | false |
| zoom out 5 | 59% | 470.69 | 898 | 470.69 | 898 | false |
| zoom out 6 | 59% | 470.69 | 898 | 470.69 | 898 | false |

- wheel: pct 59% → 65% (changed=true); ancestor scrolled = false

### mm-huge.md

- open in 46ms · stage 948×898 · content 948×57.41 · **fill ratio 1** · pct 7%
- content inline style: `transform: translate(0px, 0px); width: 948px; height: 57.4143px;`
- inner svg: attr null×null, css 948px/57.4062px maxWidth none, rect 948×57.41
- first-paint sampling: requestAnimationFrame (54 samples, 1 distinct widths)

| action | pct | content w | content h | svg w | svg h | pannable |
|---|---|---:|---:|---:|---:|---|
| zoom in 1 | 9% | 1185 | 71.77 | 1185 | 71.77 | true |
| zoom in 2 | 11% | 1481.25 | 89.7 | 1481.25 | 89.7 | true |
| zoom in 3 | 14% | 1851.56 | 112.13 | 1851.56 | 112.13 | true |
| zoom in 4 | 18% | 2314.45 | 140.16 | 2314.45 | 140.16 | true |
| reset | 7% | 948 | 57.41 | 948 | 57.41 | false |
| zoom out 1 | 7% | 948 | 57.41 | 948 | 57.41 | false |
| zoom out 2 | 7% | 948 | 57.41 | 948 | 57.41 | false |
| zoom out 3 | 7% | 948 | 57.41 | 948 | 57.41 | false |
| zoom out 4 | 7% | 948 | 57.41 | 948 | 57.41 | false |
| zoom out 5 | 7% | 948 | 57.41 | 948 | 57.41 | false |
| zoom out 6 | 7% | 948 | 57.41 | 948 | 57.41 | false |

- wheel: pct 7% → 8% (changed=true); ancestor scrolled = false

### mm-wide.md

- open in 22ms · stage 948×898 · content 948×6.75 · **fill ratio 1** · pct 10%
- content inline style: `transform: translate(0px, 0px); width: 948px; height: 6.75763px;`
- inner svg: attr null×null, css 948px/6.75px maxWidth none, rect 948×6.75
- first-paint sampling: requestAnimationFrame (57 samples, 1 distinct widths)

| action | pct | content w | content h | svg w | svg h | pannable |
|---|---|---:|---:|---:|---:|---|
| zoom in 1 | 12% | 1185 | 8.44 | 1185 | 8.44 | true |
| zoom in 2 | 15% | 1481.25 | 10.55 | 1481.25 | 10.55 | true |
| zoom in 3 | 19% | 1851.56 | 13.19 | 1851.56 | 13.19 | true |
| zoom in 4 | 24% | 2314.45 | 16.48 | 2314.45 | 16.48 | true |
| reset | 10% | 948 | 6.75 | 948 | 6.75 | false |
| zoom out 1 | 10% | 948 | 6.75 | 948 | 6.75 | false |
| zoom out 2 | 10% | 948 | 6.75 | 948 | 6.75 | false |
| zoom out 3 | 10% | 948 | 6.75 | 948 | 6.75 | false |
| zoom out 4 | 10% | 948 | 6.75 | 948 | 6.75 | false |
| zoom out 5 | 10% | 948 | 6.75 | 948 | 6.75 | false |
| zoom out 6 | 10% | 948 | 6.75 | 948 | 6.75 | false |

- wheel: pct 10% → 11% (changed=true); ancestor scrolled = false

### mm-tall.md

- open in 32ms · stage 948×898 · content 19.41×898 · **fill ratio 0.02** · pct 14%
- content inline style: `transform: translate(0px, 0px); width: 19.4145px; height: 898px;`
- inner svg: attr null×null, css 19.4062px/898px maxWidth none, rect 19.41×898
- first-paint sampling: requestAnimationFrame (58 samples, 1 distinct widths)

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

- open in 8ms · stage 948×898 · content 711.25×898 · **fill ratio 0.75** · pct 56%
- content inline style: `transform: translate(0px, 0px); width: 711.265px; height: 898px;`
- inner svg: attr null×null, css 711.25px/898px maxWidth none, rect 711.25×898
- first-paint sampling: requestAnimationFrame (61 samples, 1 distinct widths)

| action | pct | content w | content h | svg w | svg h | pannable |
|---|---|---:|---:|---:|---:|---|
| zoom in 1 | 70% | 889.08 | 1122.5 | 889.08 | 1122.5 | true |
| zoom in 2 | 87% | 1111.34 | 1403.13 | 1111.34 | 1403.13 | true |
| zoom in 3 | 109% | 1389.19 | 1753.91 | 1389.19 | 1753.91 | true |
| zoom in 4 | 136% | 1736.48 | 2192.38 | 1736.48 | 2192.38 | true |
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
| img-4000x3000.png | 4000×3000 | 950×798 | 950 | 950 | 1 | **false** (1×) | **false** (0.89×) | requestAnimationFrame |
| img-ultrawide.png | 12000×400 | 950×798 | 950 | 950 | 1 | **false** (1×) | **false** (0.04×) | requestAnimationFrame |
| img-ultratall.png | 400×12000 | 950×798 | 26.6 | 26.6 | 1 | **false** (0.03×) | **false** (1×) | requestAnimationFrame |
| img-exactpane.png | 1200×700 | 950×798 | 950 | 950 | 1 | **false** (1×) | **false** (0.69×) | requestAnimationFrame |
| img-vector.svg | 225×150 | 950×798 | 225 | 225 | 1 | **false** (0.24×) | **false** (0.19×) | requestAnimationFrame |
| img-vector-sized.svg | 2400×1600 | 950×798 | 950 | 950 | 1 | **false** (1×) | **false** (0.79×) | requestAnimationFrame |
| img-corrupt.png | null×null | 950×827 | — | — | 0 | **null** (null×) | **null** (null×) | MutationObserver(style) |

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
| img-1x1.png | 100% | 1 × 1 px · 69 B · 100% | 1 | true | auto | opacity 0.12s ease-out | — |
| img-64.png | 100% | 64 × 64 px · 7.6 KB · 100% | 1 | true | auto | opacity 0.12s ease-out | — |
| img-800x600.png | 100% | 800 × 600 px · 11.8 KB · 100% | 1 | true | auto | opacity 0.12s ease-out | — |
| img-4000x3000.png | 24% | 4000 × 3000 px · 328.2 KB · 24% | 0.24 | true | auto | opacity 0.12s ease-out | — |
| img-ultrawide.png | 8% | 12000 × 400 px · 259.3 KB · 8% | 0.08 | true | auto | opacity 0.12s ease-out | — |
| img-ultratall.png | 7% | 400 × 12000 px · 106.6 KB · 7% | 0.07 | true | auto | opacity 0.12s ease-out | — |
| img-exactpane.png | 79% | 1200 × 700 px · 21.4 KB · 79% | 0.79 | true | auto | opacity 0.12s ease-out | — |
| img-vector.svg | 100% | 225 × 150 px · 258 B · 100% | 1 | null | auto | opacity 0.12s ease-out | — |
| img-vector-sized.svg | 40% | 2400 × 1600 px · 307 B · 40% | 0.4 | true | auto | opacity 0.12s ease-out | — |
| img-corrupt.png | null | null | — | null | null | null | Could not render image. |

### img-1x1.png zoom series

in: 125%/1.25px → 156%/1.56px → 195%/1.95px → 244%/2.44px

out: 195%/1.95px → 156%/1.56px → 125%/1.25px → 100%/1px → 100%/1px → 100%/1px

drag-pan: pannable=false moved=false (Δx 0, Δy 0) · transition `opacity 0.12s ease-out`

### img-64.png zoom series

in: 125%/80px → 156%/100px → 195%/125px → 244%/156.25px

out: 195%/125px → 156%/100px → 125%/80px → 100%/64px → 100%/64px → 100%/64px

drag-pan: pannable=false moved=false (Δx 0, Δy 0) · transition `opacity 0.12s ease-out`

### img-800x600.png zoom series

in: 125%/1000px → 156%/1250px → 195%/1562.5px → 244%/1953.13px

out: 195%/1562.5px → 156%/1250px → 125%/1000px → 100%/800px → 100%/800px → 100%/800px

drag-pan: pannable=true moved=true (Δx -120, Δy -80) · transition `opacity 0.12s ease-out`

### img-4000x3000.png zoom series

in: 30%/1187.5px → 37%/1484.38px → 46%/1855.47px → 58%/2319.34px

out: 46%/1855.47px → 37%/1484.38px → 30%/1187.5px → 24%/950px → 24%/950px → 24%/950px

drag-pan: pannable=true moved=true (Δx -120, Δy -80) · transition `opacity 0.12s ease-out`

### img-ultrawide.png zoom series

in: 10%/1187.5px → 12%/1484.38px → 15%/1855.47px → 19%/2319.34px

out: 15%/1855.47px → 12%/1484.38px → 10%/1187.5px → 8%/950px → 8%/950px → 8%/950px

drag-pan: pannable=true moved=true (Δx -120, Δy 0) · transition `opacity 0.12s ease-out`

### img-ultratall.png zoom series

in: 8%/33.25px → 10%/41.56px → 13%/51.95px → 16%/64.94px

out: 13%/51.95px → 10%/41.56px → 8%/33.25px → 7%/26.6px → 7%/26.6px → 7%/26.6px

drag-pan: pannable=true moved=true (Δx 0, Δy -80) · transition `opacity 0.12s ease-out`

### img-exactpane.png zoom series

in: 99%/1187.5px → 124%/1484.38px → 155%/1855.47px → 193%/2319.34px

out: 155%/1855.47px → 124%/1484.38px → 99%/1187.5px → 79%/950px → 79%/950px → 79%/950px

drag-pan: pannable=true moved=true (Δx -120, Δy -80) · transition `opacity 0.12s ease-out`

### img-vector.svg zoom series

in: 125%/281.25px → 156%/351.56px → 195%/439.45px → 244%/549.32px

out: 195%/439.45px → 156%/351.56px → 125%/281.25px → 100%/225px → 100%/225px → 100%/225px

drag-pan: pannable=false moved=false (Δx 0, Δy 0) · transition `opacity 0.12s ease-out`

### img-vector-sized.svg zoom series

in: 49%/1187.5px → 62%/1484.38px → 77%/1855.47px → 97%/2319.34px

out: 77%/1855.47px → 62%/1484.38px → 49%/1187.5px → 40%/950px → 40%/950px → 40%/950px

drag-pan: pannable=true moved=true (Δx -120, Δy -80) · transition `opacity 0.12s ease-out`

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

1 messages captured; 1 distinct interesting.

- `1×` warning: Warning: Indexing all PDF objects

## 6. Per-case errors

None — every case completed.

---

# Observations that look like defects

Derived from the measurements above. Numeric evidence only — no remedies proposed.

## Mermaid — inline

### D1. Wide diagrams are silently downscaled to the column instead of scrolling; tall-aspect content collapses to a few pixels

- `mm-wide.md`: intrinsic 9820.02×70 rendered at 3437×24.5 px (scale 0.35×)
- `mm-gantt.md`: intrinsic 1600×460 rendered at 864×248.39 px (scale 0.54×)
- `mm-huge.md`: intrinsic 13176.23×798 rendered at 4611.67×279.3 px (scale 0.35×)
- `mm-journey.md`: intrinsic 1300×540 rendered at 864×358.89 px (scale 0.66×)
- `mm-medium.md`: intrinsic 799.88×1526 rendered at 366.91×700 px (scale 0.46×)
- `mm-sequence.md`: intrinsic 1276×1611 rendered at 554.44×700 px (scale 0.43×)
- `mm-state.md`: intrinsic 321.55×1083 rendered at 207.83×700 px (scale 0.65×)
- `mm-er.md`: intrinsic 140.27×1749 rendered at 56.13×700 px (scale 0.4×)
- `mm-class.md`: intrinsic 328.01×2362 rendered at 114.8×826.69 px (scale 0.35×)
- `mm-tall.md`: intrinsic 134.17×6206 rendered at 46.95×2172.09 px (scale 0.35×)
- mermaid emits `width="100%"` + inline `max-width:<intrinsic>px`, so the SVG always fits the column width and shrinks vertically with it.
- Worst case `mm-wide.md` is **24.5 px tall** on screen.

### D2. `.mermaid-diagram__svg { overflow-x: auto }` never engages

- 2 of 20 markdown cases produced `scrollWidth > clientWidth`.
- Because the SVG is capped at 100% of the host width there is nothing to scroll — the escape hatch for an oversized diagram is dead code at every fixture size measured (up to a 13176 px intrinsic width).

## Mermaid — zoom overlay

### D3. The overlay opens far smaller than the modal for any diagram narrower than the stage

- `mm-medium.md`: stage 948×898 px, content 470.69×898 px — **fill ratio 0.5** at "59%".
- `mm-tall.md`: stage 948×898 px, content 19.41×898 px — **fill ratio 0.02** at "14%".
- Fit is `min(1, …)`, so "fit" never scales a small diagram up; a full-screen modal is opened to show something a fraction of its width.

## Image viewer

### D4. Small images are unreadable and cannot be enlarged to the pane

- `img-1x1.png`: 1×1 shown at 1×1 px inside a 950×798 stage at "100%"; four zoom-ins reach 2.44 px (244%).
- `img-64.png`: 64×64 shown at 64×64 px inside a 950×798 stage at "100%"; four zoom-ins reach 156.25 px (244%).
- Fit is capped at 1×, so the "reset to fit" state of a small image is a speck in the middle of the pane.

## PDF viewer

## Behaviours that measured correct

- Corrupt image → `.viewer__notice` "Could not render image." with controls hidden; corrupt PDF → notice in 173 ms, no hang.
- Invalid mermaid → one `.mermaid-error` with the parse message; empty fence → the "Empty diagram" empty state (1 rendered).
- 8 concurrent `mermaid.render` calls in one document all resolved to SVG (8/8, 0 errors) in 970 ms.
- Raster zoom-in/out steps track the percentage exactly (e.g. `img-800x600.png` 125%→1000 px, 156%→1250 px), drag-pan moves the image by the exact cursor delta, and mixed-size PDF pages lay out at their own sizes.
- Every generated PNG decoded to its fixture dimensions (`naturalWidth`/`naturalHeight` matched for 8/8 raster + sized-SVG cases).
