# Paint lane — measurements (T2, T3, T5)

Branch `feat/review-paint`. Numbers required by ruling R3.1 (the recompute time) and R3.2 (the
painted pixels). Raw scenario logs sit beside this file; every figure below is quoted from one.

Environment: Windows 11, `devicePixelRatio = 1`, editor pane 850 x 727 CSS px, hidden window
(`CONDUIT_E2E=1`).

---

## R3.1 — recompute at the raised budget

`MAX_DECORATION_LCS_CELLS` went 250 000 → 4 000 000, matching Review's. The first measurement
missed the 100 ms bar badly, so the diff itself was rewritten: a flat `Int32Array` LCS table
instead of an array of arrays, and interned line identities instead of string comparison in the
inner loop. Median of five, `2026-08-31-paint-lcs-bench.txt`.

| fixture | arrays + strings | typed table only | shipped (typed + interned) |
|---|---|---|---|
| 4M worst case, 1999x1999, every line differs | 161 ms | 72 ms | **42 ms** |
| AC-T3.3 fixture, 2000 lines / 3 changes / span 1981 | 146 ms | 94 ms | **28 ms** |
| 1200 lines, two edits 900 apart | 61 ms | — | **8 ms** |
| long-prefix 1999x1999 (190-char shared prefix) | — | 77 ms | **29 ms** |
| 2000 lines, 50-line change (pre-existing bench) | 7 ms | — | **7 ms** |

Isolated the worst case runs ~25-42 ms; under full-suite fork contention the reviewer measured
40-45 ms. Against the 100 ms bar that is a **~2.2x margin in the worst observed conditions**, not
the 3x an isolated run suggests — the comment in `change-decorations.test.ts` says so.

Memory halves as well: 16 MB of Int32 cells at the limit, against ~32 MB of tagged numbers.

**Uncovered, and stated as such:** reverting the interning alone leaves every test green here,
because this machine clears 100 ms without it (94 ms median / 95.4 ms max on the AC-T3.3 fixture —
i.e. at the edge, and CI is slower). A threshold that separates 28 ms from 94 ms would flake on a
2x slower runner, and a ratio test does not discriminate because interning helps short lines too.
The 100 ms bar covers the pair; the typed table alone is what it catches.

---

## R3.2 — painted pixels

### Overview ruler, plain editor (`change-map-geometry`)

| quantity | before | after |
|---|---|---|
| ruler / vertical scrollbar width | 14 CSS px | **20** |
| change lane (`floor((w-1)/2)`) | 6 CSS px | **9** |
| error / warning lane | 7 CSS px | **10** (measured 10.00 beside a 9.00 change lane) |
| mark height | 6 device px (monaco's `MIN_DECORATION_HEIGHT`) | 6, unchanged |
| marks for the AC-T3.3 fixture | 0 (budget cliff) | **3**, at y `[2,5] [360,365] [719,724]` |
| mark contrast on the ruler plate | — | **7.479:1** on `21,22,27` (AC-T3.8 floor 3) |

### Minimap (`MinimapPosition.Inline`, blockers Q2)

| quantity | `Gutter` (before) | `Inline` (after) |
|---|---|---|
| mark width | 2 device px | **86** (of a 94 px minimap) |
| mark height | `minimapLineHeight` = 3 px | 3 px, unchanged |
| alpha | opaque | **128** — translucent, so the code silhouette still reads through |

`minimap.size` is left alone per Q2, so the minimap still scrolls; whole-file coverage is the
ruler's job and each mark is verified by revealing it.

### Untracked file (AC-T3.5)

One whole-file marker used to paint an unbroken 4344 px stripe. Now: 1 gutter decoration, **0**
with a ruler colour, **0** with a minimap colour, and no change hue anywhere on either canvas.

### Review rows, real screenshot pixels, per theme (`review-row-pixels`, film dialled out)

| theme | add row | CR vs unchanged | del row | CR vs unchanged |
|---|---|---|---|---|
| aero-dark | `#232f2d` | 1.304 (was 1.30) | `#2f1e20` | 1.133 (was 1.14) |
| aero | `#28363b` | 1.327 (was 1.32) | `#34252e` | 1.135 (was 1.14) |
| **neon** | `#052a21` | **1.314** (was 1.14) | `#2b0b21` | **1.133** (was 1.07) |

`+`/`−` glyph on the composited row, live from the DOM: 6.073 / 4.637 on aero-dark; 6.08 / 4.83
aero; 11.46 / 5.20 neon. Edge accent sampled at x=1 as exactly `--change-added` / `--change-deleted`
in every theme, ≥ 3:1 against its own row.

### Split diff (`split-diff-map`)

Every wash is now the theme's own change hue, so a line and the word inside it are one colour:

| key | value (aero-dark) | step |
|---|---|---|
| `diffEditor.insertedLineBackground` | `rgba(95, 190, 134, 0.22)` | **1.507:1** vs unchanged |
| `diffEditor.removedLineBackground` | `rgba(224, 100, 90, 0.29)` | **1.504:1** |
| `diffEditor.insertedTextBackground` | `rgba(95, 190, 134, 0.23)` | **1.518:1** vs its line |
| `diffEditor.removedTextBackground` | `rgba(224, 100, 90, 0.32)` | **1.515:1** |
| `diffEditorOverview.insertedForeground` | `95,190,134` at alpha **255** | 3 runs `[1,4] [353,356] [706,709]` |
| `diffEditorOverview.removedForeground` | `224,100,90` at alpha 255 | same |

Every step is the smallest alpha that clears its own floor. Contrast composes exactly when the
foreground is lighter than both backgrounds, so overshooting a wash is subtracted directly from the
syntax token underneath it: the line+word composite has `4.5 / (1.5 x 1.5) = 2.0` to give, minus
alpha quantisation — **1.97**, measured **2.012**.

---

## Two findings recorded rather than fixed

**Blockers Q7 — the unexplained "+6 on every channel" is `.theatre`** (`styles.css` ~6478): a
fixed film over the whole app at `z-index: 300`, lit only on Neon, whose background is a repeating
scanline of 2 px transparent then 1 px of white at 0.028, under an animated sweep peaking at 0.022.
255 x 0.028 = 7.1. The 1-in-3 pitch against an 18.59 px row is why only some rows showed it; the
animation is why the value drifted between runs. It films a changed row and the unchanged row
beside it identically and lifts the darker one proportionally more, so the filmed pair reads
*better*: add 1.395, del 1.169 at the worst stacking, against 1.313 / 1.133 plain. The floors are
asserted on it in `test/unit/diff-tokens.test.ts`.

**Monaco owns the diff panes' minimap.** `diffEditorEditors.js:160-161` sets
`minimap.enabled = false` on both sides with no guard, re-applied on every option update, because
its own whole-file diff overview takes that column. `diff-viewer.tsx`'s hard-coded `false` was not
overriding the user; AC-T5.4's "a minimap in both panes" is unbuildable, and the diff overview is
the map. `split-diff-map` pins the `false` so a monaco upgrade that lifts the restriction fails.
