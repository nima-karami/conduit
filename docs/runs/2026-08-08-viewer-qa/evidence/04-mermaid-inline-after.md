# Lane C — mermaid inline, post-fix evidence

Real app, hidden launch, 1600x1000. Source: `.autoloop/viewer-diag.mjs`.

## Acceptance

| Check | Verdict | Evidence |
|---|---|---|
| No inline diagram taller than 70% of the 1000px viewport (700px) | **PASS** | 0 of 26 exceed it; tallest wrapper = 700px |
| No inline diagram below the 0.35 legibility floor | **PASS** | min rendered scale across 26 diagrams = 0.35 |
| Every floor-scaled diagram scrolls instead | **PASS** | 4 at the floor: mm-huge.md sx=true sy=false, mm-wide.md sx=true sy=false, mm-tall.md sx=false sy=true, mm-class.md sx=false sy=true |
| mm-wide (9820x70) renders at >= 0.35 scale in a horizontally scrollable wrapper | **PASS** | scale=0.35 rendered=3437x24.5 scrollX=true (was 864x6.16 at 0.09) |
| mm-broken leaves 0 orphan [id^="dmermaid-"] nodes while the error card shows | **PASS** | orphans=0, errorCards=1 |
| Expand affordance visible without hover on every floor-scaled diagram, hover-gated elsewhere | **PASS** | mm-huge.md opacity=1 hovered=false, mm-wide.md opacity=1 hovered=false, mm-tall.md opacity=1 hovered=false, mm-class.md opacity=1 hovered=false; unconstrained diagrams showing it: 0 |
| Scroll wrappers are keyboard reachable, and only those | **PASS** | 4 tab stops for 4 scrolling wrappers; roles=region/Diagram, scrollable |
| All 20 inline cases still render, mm-multi still 8 SVGs / 0 errors | **PASS** | 20 cases, 26 diagrams rendered, mm-multi=8 svg/0 err, unexpected error cases=0 |

## Per-diagram measurements

| Case | # | viewBox | scale | rendered | wrapper h | % vh | scroll x/y | tab stop | expand opacity |
|---|---:|---|---:|---|---:|---:|---|---|---:|
| mm-tiny.md | 0 | 111.453125x174 | 1 | 111.45x174 | 174 | 0.174 | –/– | no | 0 |
| mm-small.md | 0 | 617.84375x382 | 1 | 617.84x382 | 382 | 0.382 | –/– | no | 0.0537755 |
| mm-medium.md | 0 | 799.875x1526 | 0.459 | 366.91x700 | 700 | 0.7 | –/– | no | 0 |
| mm-huge.md | 0 | 13176.234375x798 | 0.35 | 4611.67x279.3 | 279 | 0.279 | x/– | yes (region, "Diagram, scrollable") | 0.0531033 |
| mm-wide.md | 0 | 9820.015625x70 | 0.35 | 3437x24.5 | 25 | 0.025 | x/– | yes (region, "Diagram, scrollable") | 0 |
| mm-tall.md | 0 | 134.171875x6206 | 0.35 | 46.95x2172.09 | 700 | 0.7 | –/y | yes (region, "Diagram, scrollable") | 0 |
| mm-sequence.md | 0 | 1276x1611 | 0.435 | 554.44x700 | 700 | 0.7 | –/– | no | 0 |
| mm-class.md | 0 | 328.01171875x2362 | 0.35 | 114.8x826.69 | 700 | 0.7 | –/y | yes (region, "Diagram, scrollable") | 0 |
| mm-state.md | 0 | 321.546875x1083 | 0.646 | 207.83x700 | 700 | 0.7 | –/– | no | 0.0547371 |
| mm-er.md | 0 | 140.265625x1749 | 0.4 | 56.13x700 | 700 | 0.7 | –/– | no | 0.054069 |
| mm-gantt.md | 0 | 1600x460 | 0.54 | 864x248.39 | 248 | 0.248 | –/– | no | 0 |
| mm-pie.md | 0 | 613.734375x450 | 1 | 613.73x450 | 450 | 0.45 | –/– | no | 0 |
| mm-mindmap.md | 0 | 745.9205322265625x380.3419494628906 | 1 | 745.91x380.33 | 380 | 0.38 | –/– | no | 0 |
| mm-gitgraph.md | 0 | 371.130615234375x159.8401641845703 | 1 | 371.13x159.83 | 160 | 0.16 | –/– | no | 0 |
| mm-journey.md | 0 | 1300x540 | 0.665 | 864x358.89 | 359 | 0.359 | –/– | no | 0 |
| mm-longlabels.md | 0 | 358.5x670 | 1 | 358.5x670 | 670 | 0.67 | –/– | no | 0 |
| mm-multi.md | 0 | 397.03125x70 | 1 | 397.03x70 | 70 | 0.07 | –/– | no | 0 |
| mm-multi.md | 1 | 450x267 | 1 | 450x267 | 267 | 0.267 | –/– | no | 0 |
| mm-multi.md | 2 | 148.265625x276 | 1 | 148.27x276 | 276 | 0.276 | –/– | no | 0 |
| mm-multi.md | 3 | 56.234375x274 | 1 | 56.23x274 | 274 | 0.274 | –/– | no | 0 |
| mm-multi.md | 4 | 116x470 | 1 | 116x470 | 470 | 0.47 | –/– | no | 0 |
| mm-multi.md | 5 | 571.203125x450 | 1 | 571.2x450 | 450 | 0.45 | –/– | no | 0 |
| mm-multi.md | 6 | 1600x148 | 0.531 | 849x78.53 | 79 | 0.079 | –/– | no | 0 |
| mm-multi.md | 7 | 700x540 | 1 | 700x540 | 540 | 0.54 | –/– | no | 0 |
| mm-in-prose.md | 0 | 587.875x87.44380187988281 | 1 | 587.88x87.44 | 87 | 0.087 | –/– | no | 0 |
| mm-in-prose.md | 1 | 321.546875x1083 | 0.646 | 207.83x700 | 700 | 0.7 | –/– | no | 0 |

