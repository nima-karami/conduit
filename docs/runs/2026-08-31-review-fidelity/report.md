# Run report — review fidelity (2026-08-31)

**Status: COMPLETE.** Five user-reported defects, all shipped. Spec
`docs/specs/2026-08-31-review-fidelity.md`. Released as **v0.36.1** (T1, T2, T3, T5) and
**v0.36.2** (T4). Lane detail for the paint work is in `paint-report.md` beside this file; raw
scenario output is under `logs/`.

**Tests: 3706 → 3822.** Verify green on every merge.

## The asks, and what each turned out to be

| # | The ask | The actual cause |
|---|---|---|
| T1 | "changing tabs … FORGETS the scroll position" | Not the anchor — the **height table it resolves against** |
| T2 | "red/green highlights … in Neon … needs more contrast" | A wash contract whose stated premise was **never true** |
| T3 | "the scroll map … shows nothing … shows the entire code" | A **span cliff at exactly 500 lines**, plus a 6x6px mark |
| T4 | "the x button is not aligned … outline doesn't fully go around" | The stray ring was **the app's own rule**, on Monaco's inner textarea |
| T5 | "split changes review mode … highlighting … and in the scroll map" | Monaco surfaces inheriting a palette tuned for a marker they don't have |

## What organised the middle three

`styles.css:9829` states the contract plainly: *"the +/- glyph carries add/remove … so the wash is
held at 9-15% and the marker does the work."* Sound reasoning for Conduit's own hand-built diff
rows. It was then handed verbatim to Monaco's diff editor and both overview rulers, which have no
marker at all — and measurement found `--diff-marker` is a **neutral lavender in every theme**, so
the premise never held anywhere. Neon, with the weakest wash and the darkest base, is simply where
it surfaced first.

The fix is a token split, not a global alpha bump: the faint wash stays where a marker carries the
signal, and the surfaces where nothing does get tokens of their own. The 15% Specimen ceiling is
untouched; the contrast is bought from the marker (which now genuinely carries the hue) and from a
new edge accent, which costs nothing against a ceiling that governs the fill.

## Measured, before → after

| | before | after |
|---|---|---|
| Neon added row vs unchanged | 1.14:1 | **1.314:1** |
| Neon deleted row vs unchanged | **1.07:1** | **1.133:1** |
| `+`/`−` glyph | neutral, no hue | **4.64 – 11.46:1**, the row's hue |
| Overview ruler mark | 6 px of a 14 px ruler | **9 px of 20**, error lane keeps 10 |
| Minimap mark | 2 px gutter sliver | **86 px** band |
| LCS worst case at the raised budget | 161 ms | **35 ms** (42 ms post-fix median) |
| Find widget × offset from row centre | −2.50 px | **0.00 px** |
| Find widget chevron, replace row open | +15.5 px | **0.00 px** |

## The five findings worth keeping

1. **The marker cliff was a span, not a volume.** `review-hunks.ts` gates on the distance from the
   first to the last differing line, so the 250k budget tripped at exactly 500 lines apart. A
   1200-line file with **two** changed lines 900 apart showed zero marks — while Review, on a 16x
   budget, rendered the same file fine. That asymmetry is what made it read as a bug rather than a
   limit. Fixed by making the diff faster (flat `Int32Array` table, interned line identities)
   rather than by lowering the bar.
2. **The user's own complaint was our rule, not Monaco's.** The focus ring that "doesn't fully go
   around the input field" was `styles.css:634`'s global `:focus-visible` landing on Monaco's
   inner `<textarea>` — narrower than the field, wrong radius — while Monaco drew its own blue
   border on the field itself. Two competing highlights, neither on the control. The chevron
   "looking off" was the app's toggle **switch**: our selector was a bare `.toggle` class and
   Monaco's expand chevron is a `div` carrying it. Both fixed at the root (`button.toggle`).
3. **The unexplained +6 was `.theatre`.** The diagnosis found Neon rows sampling ~6 higher per
   channel than the token arithmetic predicted. It is a fixed scanline film over the whole app at
   `z-index: 300`, lit only on Neon: 255 x 0.028 = 7.1. It explains both puzzles — only *some*
   rows showed it (a 1-in-3 scanline pitch against an 18.59px row) and the value drifted between
   runs (the sweep is animated). The first hypothesis (an antialiasing halo) was disproved by the
   builder, not defended. The contrast floors are now asserted **under the film**.
4. **Aero shipped two different reds in the new surface.** The review caught a wash inheriting the
   base theme's brick (ΔE00 12.95 from Aero's own change colour) while the word highlight beside
   it used Aero's salmon — the exact bug T2 existed to fix, reproduced in the surface built to fix
   it. Aero Dark had the same split. Every wash now states its own theme's hue and the ΔE00 gate
   covers all six tokens instead of two.
5. **An acceptance criterion cannot be lowered to match what was built.** A builder cut a
   legibility floor 17.5% to pay for stronger word emphasis, arguing two ACs were mutually
   unsatisfiable. The arithmetic said otherwise. Pushed back — and the builder then found the
   *structural* cause neither of us had: one token served two surfaces with different floors, and
   no single alpha meets both. Splitting it let every step be the smallest that clears its own
   floor, landing the composite at 2.012, above the derived value.

## Process

- **Eight lane reviews across three runs; eight found real defects green gates missed.** This run
  contributed four: the incomplete Review source-change reset (introduced by T1 itself), the Aero
  wash, and two e2e sections that passed no matter what — one targeting a class that exists
  nowhere in the product, its 30-second timeout swallowed by an empty `catch`, then comparing a
  string to itself; the other counting distinct pixel rows instead of contiguous runs, so it was
  satisfied by two of three marks *or* by one solid stripe — the stripe being precisely the defect
  its sibling scenario exists to catch.
- **Diagnosis before speccing paid for itself twice.** Both the 500-line cliff and the 6x6px mark
  were invisible from the code and obvious from the measurement. The spec cites numbers, not
  symptoms, and two of the conductor's own hypotheses were corrected by evidence before any code
  was written.
- **The riskiest change was cleared on evidence, not argument.** The LCS rewrite feeds hunk
  staging, where a wrong boundary means data loss. The reviewer reimplemented old and new side by
  side and differentially fuzzed the full result: **27,437 cases, 0 mismatches**.
- **Four green-but-broken tests, and the pattern is now well understood.** One was in the file
  written to prevent them: a guard asserting the restore is spelled `useLayoutEffect`, when
  pre-paint restore actually depends on the *viewport-measuring* effect also being one. Demote
  that unrelated-looking effect and the list silently goes back to painting at zero — with the
  guard and the e2e both green.
- **Attribution before blame, twice.** `review-compare` failed three times, so the builder
  detached its worktree to the pre-run baseline and reproduced it there. `goto-index` fails from
  any repo-internal worktree by construction (it rejects paths containing a dot-directory segment).
  Neither was a regression.

## Deliberately not done

- **No e2e run against merged `main`.** Each lane ran its scenarios green on its own branch and
  every merged tree passed `npm run verify`, but the user waived the full gate for this batch.
  `review-tab-state` is the scenario a merge could most plausibly have broken.
- **The LCS interning has no test that fails without it.** Removing it measures 94 ms against a
  100 ms bar locally; any threshold sharp enough to catch that would flake on a slower runner, and
  a ratio test does not discriminate because interning helps short lines too. Recorded as
  uncovered rather than papered over with a fragile number.
- **Three T4 mutations are uncovered** (widget padding, match-count centring, the buttons' own
  focus ring) — each below what a test could assert honestly.
- **`minimap.size: 'fit'` was considered and rejected.** The overview ruler is already a true
  whole-file overview; forcing the minimap to fit would cost it its own job and still yield only a
  1px hairline. That reversal made one acceptance criterion unreachable — the conductor's call,
  recorded rather than quietly dropped.

## Filed in `docs/wishlist.md`

- **Monaco widgets read the wrong token scope on Aero**: `ensureTheme` resolves at
  `documentElement` while the editor lives in `.termwrap`, which Aero re-scopes to the ink tiers —
  so every Monaco widget paints page tiers over an ink editor (a white bar on a dark editor).
  Pre-existing; the proper fix drags in restating the focus-ring tokens in two more blocks.
- Neon at a lowered `codeOpacity` with `--theatre` lit is unmeasured; all floors assume default.

## Two traps documented for future visual tests (`test/e2e/row-color.mjs`)

- `--code-bg` follows the settings' `surfaceColor`, not `--code-base`, so poking `data-theme` onto
  `<html>` moves the theme tokens but leaves the diff surface where the profile booted — any
  per-theme visual test that pokes the attribute measures a chimera. Boot per theme instead.
- `.rhunk__lines` paints nothing; the surface is `.rhunks.inkbox`, whose background serialises as
  `color(srgb …)`. A naive `rgb()` regex drops it silently and lands the measurement on `.rcard`,
  inventing a ratio no pixel has.
