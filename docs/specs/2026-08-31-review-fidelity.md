---
status: active
date: 2026-08-31
supersedes: 2026-08-27-review-supercharge.md (§3 ignore-whitespace invariant only)
---

# Feature Spec: Review fidelity — tab state memory, change-signal palette, scroll maps, find widget

**Tier:** FULL (per item: **T1 LITE · T2 FULL · T3 FULL · T4 LITE · T5 FULL**)   **Feature type:** UI
**Mode:** autonomous — no human in the loop. Every would-be question is an assumption (§15) or a
queued item (§16); nothing blocks.

**The user's ask, verbatim** (`.autoloop/goal.md`):

1. "changing tabs from review changes to other tabs and back to review changes FORGETS the scroll
   position. Make sure the state of that review changes tab and everything that is folded,
   unfolded, expanded, etc. is fully remembered WHILE that review changes tab is open."
2. "The red/green highlights of the changed lines in the Neon theme is not as clear. Needs more
   contrast."
3. "The scroll map on the right hand side of an editor when viewing a file with changed lines
   should clearly show changed lines in the map. Right now, in some cases it shows nothing, in some
   other cases, it shows the entire code. The whole point is being able to navigate and figure out
   where the changes are."
4. "the search box for the code editor needs to be styled properly … the x button is not aligned
   well vertically, the chevron on the left side looks off … the input field outline when selected
   doesn't fully go around the input field which violates our UI UX everywhere else."
5. "Make sure the split changes review mode works perfectly in terms of highlighting changed lines
   in the code editor and in the scroll map."

All five are fidelity defects in surfaces shipped by the 2026-08-27 review-supercharge epic
(`docs/specs/archive/2026-08-27-review-supercharge.md`) — not new features. Every measurement below
comes from `.autoloop/evidence/2026-08-31-diagnosis.md`; every architectural call comes from
`.autoloop/blockers.md` and is transcribed here as a decision, not re-opened.

---

## 0. The finding that organises T2, T3 and T5

**The change-signal palette was tuned for Conduit's own hand-built diff rows and then reused
verbatim on Monaco's surfaces, which have no compensating marker.**

`webview/styles.css:9824-9828` states the contract in its own words: *"The +/- glyph carries
add/remove rather than the row hue: `--syn-string` is green and so is `--diff-add`, so the wash is
held at 9-15% and the marker does the work."* That reasoning is sound for `.rline` — a row Conduit
renders itself, which always carries a coloured `+`/`−` in its own column. It does not transfer to:

| Surface | Uses | Marker present? | Result |
|---|---|---|---|
| Review row `.rline--add` / `--del` (`styles.css:9852-9857`) | `--diff-add` / `--diff-remove` | yes, `.rline__sign` | the contract's intended case |
| Monaco diff panes (`monaco-theme.ts:88-89`) | the **same** two tokens | **no** — and `insertedTextBackground`/`removedTextBackground` are `#00000000` (`:92-93`) | a 9-15% wash is the only signal |
| Monaco diff overview ruler | `diffEditorOverview.insertedForeground` / `removedForeground` **unset** | no | Monaco derives the ruler from those same faint washes |
| Neon everywhere | `--diff-add: rgba(0,255,150,.09)`, `--diff-remove: rgba(255,45,155,.10)` (`styles.css:384-385`) vs the default theme's .13/.15 | no | the weakest wash of the three themes on the darkest base |

And the contract's premise is **false as shipped**: measured, `--diff-marker` is a neutral
lavender/grey in all three themes (`#a7b0c2`, `#a7b0c2`, `#9a92c8` — `styles.css:186`, `:386`). The
glyph carries add/remove by *shape* only. It has never carried hue, so the low alpha was never paid
for.

**Decision (binding, from `blockers.md` "T2 / T3 / T5 share ONE root cause"): a token split, not a
global alpha bump.** Keep the faint wash where a marker carries the signal; introduce explicit,
stronger tokens for the surfaces where nothing else does. Raising `--diff-add` / `--diff-remove`
themselves is refused — it would blow the Specimen token contract's 9-15% ceiling on the Review
list, which is the one place the contract is actually satisfied.

### 0.1 The token split (names are normative)

| Token | New? | Serves | Stops using |
|---|---|---|---|
| `--diff-add` / `--diff-remove` | **kept** — the 15% *ceiling* is unchanged, but **Neon's own values rise .09/.10 → .15** to reach it (§3 decision 2; the departure from the ruling's letter is recorded in §16) | `.rline--add` / `.rline--del` row wash only | — |
| `--diff-editor-add` / `--diff-editor-remove` | **new** | Monaco diff-editor changed-line wash: `diffEditor.insertedLineBackground` / `removedLineBackground`, and the diff gutter `diffEditorGutter.insertedLineBackground` / `removedLineBackground` (both exist in monaco 0.55.1, `colors/editorColors.js:78-81`) | `--diff-add` / `--diff-remove` |
| `--diff-word-add` / `--diff-word-remove` | **new** | intra-line (word) emphasis on **both** surfaces: `.rline--add .rline__word` / `.rline--del .rline__word` (`styles.css:10136-10141`) and `diffEditor.insertedTextBackground` / `removedTextBackground` | the hardcoded `rgba(108,193,138,.34)` / `rgba(224,114,111,.34)`; and `#00000000` on the Monaco side |
| `--diff-sign-add` / `--diff-sign-remove` | **new**, opaque, hue-carrying | `.rline--add .rline__sign` / `.rline--del .rline__sign` — the `+`/`−` glyph | `--diff-marker` |
| `--diff-marker` | no — **not re-tuned** | the neutral default on `.rline__sign` (context rows and any row with no add/remove identity) | — |
| `--change-added` / `--change-modified` / `--change-deleted` | no — **unchanged** (diagnosis B-4: Neon's are the strongest of the three themes at 15.2 / 14.1 / 5.9:1; leave them alone) | editor gutter bars, editor overview ruler + minimap marks, **and now** `diffEditorOverview.insertedForeground` / `removedForeground` in the split diff | — (the split-diff rulers stop deriving from `--diff-add`/`--diff-remove`) |

`--diff-marker` has exactly **one** consumer in the *source* tree today (`styles.css:9834`) — plus
one assertion pair in `test/e2e/review-diff-syntax.e2e.mjs:152-159`, which this spec invalidates on
purpose (§13 risk 4, §14). Adding siblings rather than re-tuning it is deliberate: it bounds the
blast radius to the `.rline__sign` rule set and leaves the neutral available for rows that
genuinely have no add/remove identity.

`--change-*` becoming the shared ruler vocabulary is what delivers the T5 ruling's *"one visual
language for 'where are the changes' across the plain editor and the split diff."*

---

## 1. Problem frame

- **Job:** the user reviews agent-written changes across three surfaces (Review list, plain editor,
  split diff) and needs each one to (a) hold its place while they work and (b) show *where* the
  changes are at a glance, in every theme.
- **Actors:** the user (reviewer). No host or agent participation beyond what already ships.
- **Success outcomes:**
  - Leaving and returning to the Review tab restores everything the user had arranged — scroll,
    folds, collapse, filter, find bar, cursor — with no visible jump.
  - A changed row is distinguishable from an unchanged one at a glance in every theme, not only
    under a colour-picker.
  - A file with a handful of scattered changes shows a handful of marks — never zero, never a solid
    stripe — on both the overview ruler and the minimap, in the plain editor and in split mode.
  - The editor's find widget reads as a Conduit control, with the whole field lighting up on focus.
- **Non-goals:** a Conduit-owned replacement for Monaco's find widget (T4 restyles Monaco's, it does
  not rebuild it); persisting Review state across app restart (the ask is explicit: *"WHILE that
  review changes tab is open"*); a new user-facing setting for any of T2-T5; re-tuning the syntax
  palette; touching the editor's `--change-*` gutter marks; an i18n layer (repo convention).

---

## 2. T1 — Review tab state memory   **[LITE]**

> Already in flight on `feat/review-tab-state`. Recorded here for the archive; the conductor's
> ruling is the source of truth and is transcribed verbatim in substance.

### Root cause (established by reading, 2026-08-31)

- `uiCacheRef`, `measuredRef`, `requestedRef` are per-instance `useRef`s in `ReviewView`
  (`webview/components/review-view.tsx:500-504`). Switching tabs unmounts `ReviewView`
  (`center-pane.tsx:322` renders it only when `activeDoc.kind === 'review'`), so **every card's
  collapsed / fold / show-remaining state and every measured card height is destroyed.**
- `fileFilter`, `bulk`, the find-bar state (`searchOpen` / `query` / `caseSensitive` / `searchAll` /
  `matchIndex`), `focusedPath` and `cursor` are plain `useState`
  (`review-view.tsx:307-314` for the find bar and `fileFilter`; `:525` `focusedPath`, `:595` `cursor`, `:1100` `bulk`) — also destroyed.
- The scroll **anchor** does survive: `mergeReviewViewState` + `useDebouncedFlush`'s unmount flush
  already persist `{topPath, offset}`. But `resolveReviewAnchor` re-resolves it against `heightOf`,
  which falls back to `estimateCardHeight` once `measuredRef` is empty — so the restored offset is
  computed from estimates, not the real layout.

### Decisions

1. **The seam is the existing `webview/view-state-store.ts`.** Extend the
   `{ kind: 'reviewAnchor' }` entry (`view-state-store.ts:19`). No parallel mechanism; **not** solved
   by keeping `ReviewView` mounted behind `display:none` — a hidden scroller loses `scrollTop` when
   it has no layout box, trading one bug for a subtler one, and `center-pane.tsx`'s web-tab
   precedent exists to keep a WebView *warm*, a different problem.
2. **The store holds the LIVE `Map` objects.** It is renderer memory with the same lifetime as the
   tab, so `uiCacheRef.current` and `measuredRef.current` point *at* the store's maps. One object,
   no capture/sync step, nothing to get out of date. Documented in the store's header comment.
3. **Entry lifetime is already correct and must not change.** `markClosing(id)`
   (`view-state-store.ts`) on tab close drops it — matching *"WHILE that review changes tab is
   open"*. A source change already calls `deleteViewState`; it must **also** drop the card and
   measured maps. A source change is a content reset, and stale card state under a different
   changeset is worse than none.
   *Built as `adoptReviewSource(id, sourceKey)`, which clears the maps **in place** and zeroes the
   anchor — dropping the entry outright would orphan the maps the mounted view already aliases.
   `deleteViewState` was removed with its only caller. The trigger is the `sourceKey` the store
   last adopted, not one an instance remembers: Review is a singleton doc whose source is
   retargeted and activated in one dispatch, so the view that must reset is often one mounting
   fresh, which has no previous key of its own to compare.*
4. **Restore lands before first paint.** The current restore effect is gated on
   `viewportHeight !== 0`, which is 0 for the first committed frame, so the list paints at scrollTop
   0 and then jumps. Measure the scroller in a `useLayoutEffect` (CLAUDE.md's "apply fit before
   first paint" rule) so the restore happens in the same frame.
5. **Modals and transient confirmations do not persist:** `helpOpen`, `composer`, `confirm`.

The **first committed frame** half of the T1 criterion is verified statically, not by smoke test
(`test/unit/review-restore-prepaint.test.ts`): the only difference a passive restore makes is one
painted frame, the final offset is identical either way, and the e2e suite runs the window hidden,
where rAF is throttled to ~1fps and no probe can sample it. The guard asserts the coupling the
guarantee actually rests on — the restore *and* the viewport measurement it rides are both layout
effects. The guarantee covers the mount path; a pane that starts at zero height is measured later by
the ResizeObserver, outside React's batching, and that restore lands after a paint.

The builder **must prove the observed scroll failure with a failing e2e before fixing it** — the
anchor mechanism exists, so the failure mode is estimate-based resolution plus the first-frame gate,
not an absent capture. Do not assume.

### Acceptance criteria (T1)

- Given a Review tab scrolled to file N with card N-2 collapsed, one fold expanded, "Show remaining"
  pressed on one card, a file filter typed, the find bar open with a query and case-sensitivity on,
  and the hunk cursor parked on a specific hunk: switching to another tab and back restores **all
  nine** — scroll, collapse, fold, show-remaining, `fileFilter`, `searchOpen` + `query`,
  `caseSensitive`, `matchIndex` and `cursor` — and the scroller's `scrollTop` on the
  **first committed frame** after remount is within **2 px** of its value before the switch, with no
  intermediate frame at 0. `bulk` (the collapse-all/expand-all latch) is restored with them, so a
  round-trip does not re-expand what the user collapsed. *(2 px, not 0: a sub-pixel row-height rounding difference is not a
  regression; a jump the eye can see is.)*
- Closing the Review tab and reopening it restores nothing (fresh state).
- Changing the Review source drops the card/measured maps and the anchor together; no card renders
  another changeset's fold state.
- `helpOpen`, an open composer and an open confirm dialog are all closed after a round-trip.
- **`focusedPath` is deliberately NOT restored** (amended 2026-08-31, during the build; conductor
  accepted). It was listed above as a tenth item, and it is the one piece of this state that is not
  the user's — it mirrors real DOM focus, set by the scroller's `onFocusCapture` and cleared by
  `onBlurCapture`. After a remount focus is genuinely somewhere else and no blur will ever fire, so
  a restored value would pin its card in the virtualization window permanently, with nothing able to
  release it. Restoring the focus itself is not the alternative: spec 2026-06-30 §10 forbids a plain
  tab switch moving focus. The card the user was on is still reachable through `cursor`, which *is*
  restored — and which is what `j`/`k` and the focus ring actually follow.

### Edge cases (T1)

| Condition | Expected |
|---|---|
| Source changes while scrolled | anchor **and** card/measured maps drop together (decision 3); the list re-renders from the top, no card wearing another changeset's fold state |
| Tab closed inside the 120 ms capture debounce | `markClosing` tombstones the id, so the unmount flush cannot resurrect the entry (`view-state-store.ts:38`, existing behaviour) |
| The file filter hides the anchored path | the anchor resolves to the nearest **visible** card; it is never restored to a hidden one |
| Restored offset is past the end of a now-shorter list | clamped (`clampScrollTop`, `view-state-store.ts:104`) |
| Two windows on the same repo | the store is per-renderer, so each window keeps its own place — no cross-window sync, and none is wanted |
| Remount before any measurement exists | `estimateCardHeight` still backs the first frame; the `useLayoutEffect` measurement corrects within the same frame |

---

## 3. T2 — Neon diff contrast   **[FULL]**

### Measured root cause

Composited over each theme's `--code-base` (which *is* the surface: `.rhunk__lines` sits on
`--code-surface`, sampled pixels equal `--code-base` exactly in all three themes), a changed row
against an unchanged one:

| Theme | base | add row | del row | **CR add** | **CR del** | ΔE00 add | ΔE00 del |
|---|---|---|---|---|---|---|---|
| aero-dark | `#15161b` | `#232f2d` | `#2f1e20` | **1.30** | **1.14** | 11.4 | 11.2 |
| aero | `#1b1e2b` | `#28363b` | `#34242e` | **1.32** | **1.14** | 11.6 | 10.3 |
| **neon** | `#06050c` | `#051c18` | `#1f091a` | **1.14** | **1.07** | **13.1** | **12.1** |

Neon is the only theme whose wash alpha was *reduced* (.09/.10) **and** which has the darkest base,
so the two effects compound: its deleted row is a **7% luminance step**, half of aero-dark's.

**ΔE00 says the opposite** (Neon scores highest) because its hues are the most saturated. That is
precisely the trap: the tint is chromatically distinct but almost luminance-neutral, so it survives
a colour-picker and fails a glance — and it fails hardest for anyone with a red/green deficiency,
who has only the luminance channel left. **This item is specified in contrast, never in ΔE.**

Two supporting findings:

- **The stylesheet's justification is false** (§0): `--diff-marker` is neutral in all three themes,
  so the row's identity rests entirely on a 9-10% wash worth 1.07-1.14:1 on Neon.
- **`.rline__word` is theme-blind** (`styles.css:10136-10141`): hardcoded
  `rgba(108,193,138,.34)` / `rgba(224,114,111,.34)`, which measure ΔE00 **1.6 / 4.6** from
  aero-dark's `--change-added` / `--change-deleted` (i.e. sampled from the default theme) but
  **15.6 / 19.1** from Neon's — a warm-brick word highlight inside a magenta deleted row.
- **Not the problem:** the editor's `--change-*` gutter marks. On Neon they are 15.2 / 14.1 / 5.9:1,
  the strongest of the three themes. Leave them alone.

### Decisions

1. **Buy the contrast from the marker, not the wash.** `--diff-sign-add` / `--diff-sign-remove`
   (§0.1) become saturated, hue-carrying, opaque glyph colours per theme — making the stylesheet's
   own claim true for the first time. `--diff-add` / `--diff-remove` stay inside the Specimen
   contract's 15% ceiling.
2. **Neon's row wash rises to the ceiling** (.09 → .15 add, .10 → .15 remove), which is the most the
   contract allows. That is a parity fix, not the fix.
3. **`.rline__word` moves onto `--diff-word-add` / `--diff-word-remove`**, defined per theme from
   that theme's own change hue.
4. **Verify, do not assume, the `--syn-string` clash.** The original author's stated worry was that
   a green `+` would clash with green strings. The glyph and the code sit in **separate columns**
   (`.rline__sign` is `width: 14px; flex: 0 0 auto`), so check a string-heavy sample rather than
   pre-emptively desaturating the marker.

### Acceptance criteria (T2)

Asserted **per theme** in a unit test, and confirmed on real composited pixels in an e2e.

- **AC-T2.1 — row parity floor.** In every theme, an added row is **≥ 1.30:1** and a deleted row
  **≥ 1.14:1** against an unchanged (`.rline--context`) row on the same surface.
  *Why these numbers:* they are the strongest values any theme ships today (aero-dark 1.30 add;
  a two-way tie at 1.14 del — Neon today is 1.07) **and** the maximum reachable inside the 15% alpha ceiling — computed
  for Neon's `#06050c` base, `rgba(0,255,150,.15)` lands at 1.32:1 and `rgba(255,45,155,.15)` at
  1.14:1. A higher floor would require blowing the ceiling, which §0 forbids. This criterion says
  "no theme is worse than the others"; it does not claim to be sufficient on its own.
- **AC-T2.2 — the marker carries the signal.** `--diff-sign-add` on an added row and
  `--diff-sign-remove` on a deleted row are each **≥ 4.5:1** against that composited row.
  *Why 4.5:* it is `styles.css:186`'s own published contract for this glyph ("carries add/remove, so
  it must clear 4.5:1"), and the glyph is body-sized text, so WCAG AA normal text is the right bar.
- **AC-T2.3 — the two markers are not confusable.** `--diff-sign-add` and `--diff-sign-remove` are
  **≥ ΔE00 20** apart, in every theme.
  *Why 20:* it is a **backstop**, not a target. AC-T2.4's ≤ 10 bound plus the measured separation
  between each theme's own `--change-added` and `--change-deleted` (**ΔE00 60.5 aero-dark / 58.7 aero
  / 96.7 neon**) already forces ≥ 38.7 in the worst theme; the floor exists so a future theme whose
  change tokens sit closer together still fails the gate. (ΔE00 is the right metric *here* — this is
  a hue-distinctness claim about two foreground glyphs, not a glance-detectability claim about a
  wash.)
- **AC-T2.4 — the marker matches its theme's change hue.** `--diff-sign-add` is **≤ ΔE00 10** from
  that theme's `--change-added`, and `--diff-sign-remove` **≤ ΔE00 10** from `--change-deleted`, so
  the Review list and the editor gutter agree on what "added" looks like.
  *Why 10:* the diagnosis calls ΔE00 1.6-4.6 "indistinguishable to nearly indistinguishable" and
  15.6+ "a different hue family"; 10 is the midpoint — same family, allowing a legibility tweak.
- **AC-T2.5 — word emphasis is theme-derived and no weaker than today.** The `.rline__word` rules
  contain **zero** colour literals; the composited word background is **≤ ΔE00 5** from its theme's
  `--change-added` / `--change-deleted`, and **≥ 1.70:1** against the row it sits on.
  *Why 5:* the top of the diagnosis's "indistinguishable to nearly indistinguishable" band.
  *Why 1.70:* the weakest value measured today (aero del, 1.70), so the fix cannot regress the
  strongest single signal on a Neon diff row.
- **AC-T2.6 — code stays legible.** On a changed row in every theme, `--syn-default` is **≥ 4.5:1**
  and every other `--syn-*` foreground is **≥ 3:1**.
  *Why 3:* `test/unit/theme-tokens.test.ts:154` already holds every `--syn-*` at ≥ 4.5:1 against
  `--code-base` (only `--code-line-number` is excepted, at its signed-off 3.58/3.91/4.72). A row
  wash of at most 1.32:1 divides that by at most 1.32, so ≥ 3:1 is reachable without touching the
  syntax palette — and 3:1 is WCAG's non-text / large-text floor.

```gherkin
Feature: Neon changed rows read at a glance
  Scenario: Deleted row on Neon
    Given the Neon theme is active and a Review card shows a deleted line
    When the composited row background is sampled from the live DOM
    Then it is at least 1.14:1 against a context row in the same card
    And the "−" glyph is at least 4.5:1 against that row
    And the glyph's hue is within ΔE00 10 of --change-deleted
```

### Edge cases (T2)

| Condition | Expected |
|---|---|
| Lowered `codeOpacity` (Neon's shader shows through) | the floors are asserted against the token composite at default opacity; the e2e records the sampled value at default opacity only — see §16 |
| Forced colors | unchanged: `.cdec` already uses borders (`styles.css:9885`); rows fall back to system colours |
| A row that is both add-side and word-emphasised | AC-T2.6 is asserted on the word composite too, at **≥ 2.0:1** for `--syn-*`. *Why 2.0:* it is the exact arithmetic consequence of the two steps stacking — a ≤ 1.32 row wash under a ≥ 1.70 word wash divides a 4.5:1 token by 2.24, landing at 2.01. It is a floor, not a target: the diagnosis measured real code on today's word highlights at **4.54-7.52** (B-3), far above it |
| A future theme | no Paper theme ships today — `webview/themes.ts` declares exactly `aero`, `aero-dark`, `neon`. The unit test iterates `THEMES`, so a new theme fails the gate until its six tokens are declared |
| Highlighted (`hljs`) rows | `.rline__text` takes `--syn-default`; token colours vary, which is why AC-T2.6 asserts the whole `--syn-*` set, not one value |

---

## 4. T3 — the editor's change markers and scroll map   **[FULL]**

### Measured root causes, ranked

**R3.1 — the LCS budget is a *span* cliff, and it is the top cause of "shows nothing."**
`src/review-hunks.ts:137` gates on `(n+1)*(m+1) > maxLcsCells` where `n`/`m` are the core **span**
from the first to the last differing line — not the volume of change. With
`MAX_DECORATION_LCS_CELLS = 250_000` (`webview/change-decorations.ts:11`) the trip point is a span of
exactly 500, and `webview/use-change-markers.ts:166-170` responds by calling `clear()`:

| Fixture | Edits | Span | Markers |
|---|---|---|---|
| `edge499.ts` (800 lines) | lines 10, 508 | 499 | **2** |
| `edge500.ts` (800 lines) | lines 10, 509 | 500 | **0** |
| `far.ts` (1200 lines) | lines 100, 1000 | 901 | **0** |

Two changed lines out of 1200 and the map shows nothing. This is the *normal* shape of an agent edit
(an import at the top, a function at the bottom). Review renders the same file fine on its
`MAX_LCS_CELLS = 4_000_000` budget (`src/review-hunks.ts:90`) — which is exactly what makes it read
as a bug rather than a limit. The banner's wording is false here too: nothing changed much.

**R3.2 — geometry. The mark is a 6×6 px dot and the minimap is not a whole-file overview.**
Monaco's standalone bundle overrides `overviewRulerLanes` to **2**
(`monaco-editor/esm/vs/editor/editor.api2.js:16`), so `OverviewRulerLane.Left` is x 1-6 of a 14 px
ruler; a single changed line floors to **6 device px** tall
(`decorationsOverviewRuler.js:292`, `MIN_DECORATION_HEIGHT`). Sampled canvas pixels confirm: one
colour group, `xFrom 1 xTo 6`, three 6 px runs. On the minimap the mark is
`GUTTER_DECORATION_WIDTH = 2` device px — and `minimapHeightIsEditorHeight: false` means the minimap
**scrolls**: on a 401-line file only **2 of 3** marks were painted, the third off-canvas.

**R3.3 — "shows the entire code" is two different things.**
(a) An untracked file emits one marker `1 → lineCount` (`use-change-markers.ts:139-158`) — measured
as an unbroken 4344 px green stripe down the whole ruler. (b) A whole-file reformat legitimately
yields one file-spanning marker, because `computeFileReview` is called **without**
`ignoreWhitespace` (`use-change-markers.ts:160-165`) even though Review has that toggle.

**R3.4 — the silent empty states.** Any `head.reason` other than `untracked` (notRepo, >2 MB,
timeout, notFound) takes `clear(); setState('none')` (`use-change-markers.ts:132-138`), and
`enabled === false` does the same (`:117-124`). `code-viewer.tsx:691` banners only on `'degraded'`,
so all of these are indistinguishable from "this file has no changes."

### Decisions

1. **Raise the decoration budget to Review's** (`MAX_LCS_CELLS`, 4 000 000) and **prove the
   worst-case recompute fits the 300 ms debounce with a measured number in the run report.** A silent
   `clear()` is never an acceptable answer to a budget overflow (see decision 6).
   **The cliff moves, it does not disappear:** the gate is still `(n+1)*(m+1) > maxLcsCells`
   (`src/review-hunks.ts:137`), so at 4 M it trips at a span of **2000** (2001² = 4 004 001). That is
   4× the useful range and matches Review, so a file where the editor gives up is now a file where
   Review gives up too — the asymmetry that made this read as a bug is gone. Beyond it, decision 6
   applies: announce, never clear silently.
2. **A "scroll map" that does not show the whole file is not a map.** Set `minimap.size: 'fit'`.
3. **Make a change mark legible at a glance on both surfaces.** Recommended mechanism:
   `scrollbar: { verticalScrollbarSize: 20 }` — Monaco derives the overview ruler's width from the
   vertical scrollbar, so a 20 px ruler yields `leftWidth = floor(19/2) = 9`, i.e. a 9 px change lane
   with 10 px left for Monaco's error/warning lane (today: 6 and 7). On the minimap, emit **two**
   decorations per marker — the existing `MinimapPosition.Gutter` rail for position plus a
   `MinimapPosition.Inline` block for legibility. The AC is mechanism-agnostic; whatever is chosen,
   **report the measured pixels**, and if a wider lane would occlude error/warning marks, say so
   with evidence rather than guessing.
4. **Untracked: no baseline, no map.** An untracked file has nothing to locate against, so keep the
   gutter bars (honest — every line *is* new) and paint **no** ruler or minimap marks. No threshold,
   no heuristic.
5. **Whitespace: the editor honours the same `reviewIgnoreWhitespace` setting Review already has.**
   A pure re-indent then correctly shows nothing. *This supersedes the 2026-08-27 spec's §3
   invariant* ("editor markers equal Review's All scope **with ignore-whitespace off**") — the two
   surfaces now share the one setting, which is what the user's mental model already assumed.
6. **The silent states stop being silent.** `goToChange` announces the actual reason for every
   non-live state (`DEGRADED_HINT` at `use-change-markers.ts:49` already models the pattern). **Do
   not** add a persistent banner for the common "not a git repo" case — that is noise, not
   information.

### Acceptance criteria (T3)

- **AC-T3.1 — the span cliff moves out of the useful range.** A 1200-line file with single-line
  changes at line 100 and line 1000 (span 901) renders **2** markers, not 0. `edge500.ts` (span 500)
  renders 2. A 2600-line file with changes at line 10 and line 2590 (span 2581 → 6 666 561 cells,
  **past** the raised budget) renders 0 markers **and announces the reason on navigation** — it must
  not fail silently, and it is the case AC-T3.3's fixture deliberately does not cover.
- **AC-T3.2 — worst-case recompute fits the debounce.** At the raised budget, a recompute whose core
  span is at the budget limit on both sides completes in **< 100 ms**, measured and reported; the
  existing benchmark (2000-line file, 50-line change, **< 16 ms**) still passes.
  *Why 100 ms:* the debounce is 300 ms (`use-change-markers.ts:46`). A recompute must finish inside
  one window with room for the React re-render and Monaco's `.set()`, and a 3× margin means a
  keystroke burst can never queue two recomputes. If the measured worst case exceeds 100 ms, the
  budget is set to the largest value that fits and that number is reported — see §16.
- **AC-T3.3 — the headline geometry test.** A **2000-line file with 3 scattered changed lines
  (10, 1000, 1990)** shows **3 findable marks in the overview ruler and 3 in the minimap**, at the
  default pane height, without scrolling either surface. Each ruler mark is **≥ 9 CSS px wide** and
  **≥ 6 CSS px tall**, at 3 distinct y positions; the 3 minimap marks are present at 3 distinct y
  positions.
  *Why 9 px:* 1.5× today's 6 px, and what a 20 px ruler's left lane yields (`floor((20-1)/2)`), leaving
  10 px for the error/warning lane.
  *Why 6 px tall:* Monaco's own `MIN_DECORATION_HEIGHT` — already satisfied, asserted so a lane
  change cannot silently drop below it.
  *Why no thickness floor on the minimap:* at `size: 'fit'` a 2000-line file's `minimapLineHeight`
  floors to 1 px, so a thickness floor there would be unmeetable. Presence at distinct positions is
  the honest criterion, and the ruler carries legibility. See §16.
  *Headroom note:* this fixture's span is 1981 → 3 928 324 cells, only **1.8% under** the raised
  budget. It tests geometry, not the budget; AC-T3.1's 2600-line case is what tests the other side of
  the new cliff. Do not widen this fixture without re-checking it stays under 4 M.
- **AC-T3.4 — error marks survive.** On a file with both a change marker and a TypeScript error, the
  error's ruler mark remains **≥ 4 CSS px wide** and visible alongside the change mark.
  *Why 4:* the right lane retains 10 px at a 20 px ruler, so 4 px is a wide margin below what the
  chosen mechanism should deliver — it fails only if the change lane has actually eaten the error
  lane, which is the regression this guards (§13 risk 2).
- **AC-T3.5 — untracked paints no map.** An untracked 301-line file shows gutter bars on every line
  and **zero** painted pixels in both the `.decorationsOverviewRuler` and
  `.minimap-decorations-layer` canvases.
- **AC-T3.6 — whitespace.** With `reviewIgnoreWhitespace` on, a 300-line file whose only change is a
  two-space re-indent of every line renders **0** markers; with it off, **1** whole-file marker.
- **AC-T3.7 — nothing is silent.** With `editorChangeMarkers` off, `goToChange` announces "Change
  markers are off". With a `notRepo` / `timeout` / `notFound` / oversize head blob it announces that
  specific reason. **With the raised budget exceeded** it announces `DEGRADED_HINT` (whose wording
  is now true — past a 2000-line span the file really has changed too much to line-match cheaply).
  No persistent banner appears for `notRepo`.
- **AC-T3.8 — mark colour.** `--change-added` / `--change-modified` / `--change-deleted` remain
  **≥ 3:1** against `--code-base` in every theme — the surface the diagnosis actually measured
  (B-4: 5.28-15.22 today). A guard, not a change. *Why 3:* WCAG 1.4.11 non-text contrast, and it is
  the 2026-08-27 spec §11's own published target. Note that with the minimap on, Monaco paints the
  ruler opaque in `--code-base` anyway (`decorationsOverviewRuler.js:36-45`), so this is the ruler
  background in the common case.

```gherkin
Feature: The scroll map locates scattered changes
  Scenario: Three changes in a 2000-line file
    Given a tracked 2000-line file with one changed line at 10, 1000 and 1990
    When the file is opened in the editor
    Then the overview ruler paints exactly 3 marks at 3 distinct heights
    And the minimap paints 3 marks at 3 distinct heights without scrolling
    And each ruler mark is at least 9 CSS px wide
```

### Edge cases (T3)

| Condition | Expected |
|---|---|
| Zero changes | no marks; `goToChange` announces "No changes" (unchanged) |
| One change | one mark; next/prev wraps to itself (unchanged) |
| Very large file (10 000+ lines) at `size: 'fit'` | the whole file maps; each line is sub-pixel and the slider is small — see §13 for the scrubbing check |
| Budget still exceeded at 4 M cells | announce the reason on navigation; never a silent `clear()` |
| `editorMinimap` off | ruler marks unaffected (verified: `minimap-off.json` painted all three at identical geometry) |
| Runtime minimap toggle (`code-viewer.tsx:501`) | **re-check by hand on a real visible window** — a runtime `updateOptions` left the ruler canvas empty 1.2 s later under Playwright while the boot-seeded equivalent painted correctly; probably a hidden-window rAF artifact, but Playwright cannot prove it |
| HEAD moves mid-recompute | unchanged: old collection held until the new one is ready |
| DPR ≠ 1 | the lane math is DPR-linear; CSS-px sizes hold. Not measured above 1 — see §15, assumption 16 |

---

## 5. T4 — the Monaco find widget   **[LITE]**

### Root cause

The find widget is **stock Monaco chrome**. `webview/styles.css` contains **zero** `.find-widget` /
`.monaco-findInput` / `.monaco-inputbox` rules (verified by grep), and `webview/monaco-theme.ts`
supplies only `editorWidget.background` / `foreground` / `border` (`:100-102`) — no `input.*`,
`inputOption.*`, `focusBorder` or `toolbar.hoverBackground`. So the field, its `Aa`/`ab`/`.*`
toggles, the expand chevron and the × all render at Monaco's own metrics inside an app-coloured box.
That is why the × sits off the row's optical centre, the chevron reads wrong, and the focus
treatment paints on Monaco's inner `.monaco-inputbox` instead of the whole field.

### Decisions

1. **The reference is the app's own find bars** — `.term-find` / `.term-find__btn` /
   `.term-find__input` (`styles.css:3510-3559`) and `.searchbox` (`:4361`). Monaco's widget must read
   as the same family: `--raise` surface, `--border-2` hairline, `--r-sm` radius, 22×22 icon buttons.
2. **Focus the BOX, not the inner field.** `.searchbox:focus-within { box-shadow: var(--focus-ring) }`
   (`styles.css:4373`) is the documented convention — *"the whole control lights up at its border"* —
   and it is exactly what the user says is violated. The ring goes on the whole `.monaco-findInput`
   as a full, unbroken perimeter, and Monaco's inner border is suppressed so only one highlight shows.
3. **Fix alignment at the root.** One flex alignment on the row; the buttons centre in it. **No magic
   pixel offsets** to nudge the × into place (CLAUDE.md band-aid rule).
4. **Colour through `monaco-theme.ts` where a Monaco token exists**; CSS only for geometry Monaco has
   no token for. Never `!important`, never a specificity ladder to out-rank Monaco — its own rules are
   low specificity; scope ours under the app's editor container if a tie needs breaking.
5. **Neon must be checked.** Its `--focus-ring` is the **inset** variant (`styles.css:361`) versus the
   outer box-shadow at `:33`, so a ring drawn as an outer shadow is clipped by Monaco's
   `overflow: hidden` on the widget.

### Acceptance criteria (T4)

- **AC-T4.1 — unbroken ring.** With the find field focused, sampling pixels just inside each of the
  four edges of `.monaco-findInput`'s rect returns a non-background colour on **all four** edges, in
  **every theme including Neon**. *Why all four: the reported defect is literally "doesn't fully go
  around", and Neon's inset ring plus Monaco's `overflow: hidden` is the exact trap that produces a
  three-sided ring.*
- **AC-T4.2 — one highlight.** The focused inner `.monaco-inputbox` contributes no visible border or
  shadow of its own (computed `border-style: none` / `box-shadow: none`).
- **AC-T4.3 — the × is centred.** The × button's rect centre-y is within **1 CSS px** of the find
  row's content-box centre-y. *Why 1 px: at DPR 1 that is the tightest assertable tolerance, and
  "aligned" means aligned — a looser bound readmits the reported defect.*
- **AC-T4.4 — family match.** Every icon button in the widget (chevron, `Aa`, `ab`, `.*`, ↑, ↓, ×) is
  **22 × 22 CSS px**, matching `.term-find__btn` (`styles.css:3547-3548`).
- **AC-T4.5 — no band-aids.** The new rules contain **zero** `!important` declarations and no
  selector longer than the app's editor container plus one Monaco class.
- **AC-T4.6 — the replace row and the chevron.** With the widget expanded, the replace row's
  `.monaco-findInput` satisfies AC-T4.1 and AC-T4.2, its buttons satisfy AC-T4.4, and the expand
  chevron's own computed box is **22 × 22 CSS px** with its centre-y within **1 CSS px** of the find
  row's content-box centre-y. *(This is the criterion that covers the user's "the chevron on the
  left side looks off" — it must be measurable, not read as an impression.)*

### Edge cases (T4)

| Condition | Expected |
|---|---|
| Widget in the split diff editor | same styling — it is the same Monaco widget class |
| Long search term (field scrolls) | the ring stays on the box, not on the scrolled content |
| "No results" state | `.find-widget.no-results .matchesCount` uses `--vscode-errorForeground` (`findWidget.css:225-226`), so map Monaco's `errorForeground` onto the app's `--danger` (`styles.css:73`) in `monaco-theme.ts` — not stock red |
| Reduced motion | it **does** animate: `transition: transform 200ms linear` (`findWidget.css:13`), and Monaco has no reduced-motion guard. Add `@media (prefers-reduced-motion: reduce) { transition: none }` |
| Forced colors | the ring falls back to `Highlight`; assert AC-T4.1's four-edge sample still returns a non-background colour under `forced-colors: active` |

---

## 6. T5 — split (side-by-side) diff mode   **[FULL]**

### Root causes (from `webview/components/diff-viewer.tsx`)

1. **`minimap: { enabled: false }` is hard-coded** (`diff-viewer.tsx:71`), ignoring the user's
   `editorMinimap` setting — so half of "the scroll map" **does not exist in split mode at all**.
2. **`renderOverviewRuler` is left at Monaco's default and its colour tokens are unset**, so
   `diffEditorOverview.insertedForeground` / `removedForeground` derive from the faint washes at
   `monaco-theme.ts:88-89`.
3. **Changed-line highlighting in the panes is the faint wash**, with
   `diffEditor.insertedTextBackground` / `removedTextBackground` deliberately transparent
   (`monaco-theme.ts:92-93`) — so the intra-line signal Review gets from `.rline__word` has no
   equivalent here, and there is no `+`/`−` marker to compensate.

### Decisions

1. **Honour `editorMinimap`**, the way `code-viewer.tsx:176-181` does: `renderCharacters: false` (the
   map must be a MAP, not a texture) plus `size: 'fit'` from T3.
2. **Set the diff overview ruler tokens explicitly** to `--change-added` / `--change-deleted`, and
   turn on `renderOverviewRuler`. Whatever T3 does for the single-file editor's ruler is applied here
   — one visual language across the plain editor and the split diff.
3. **The pane wash moves to `--diff-editor-add` / `--diff-editor-remove`** (§0.1), tuned to the floor
   in AC-T5.1 rather than the Review row's 15% ceiling. **They must stay non-opaque** — monaco's own
   contract for `diffEditor.insertedLineBackground` is *"must not be opaque so as not to hide
   underlying decorations"* (`colors/editorColors.js:78`).
4. **The intra-line signal comes back** via `--diff-word-add` / `--diff-word-remove` on
   `insertedTextBackground` / `removedTextBackground`. The 2026-08-27 note that reusing the *line*
   token composited to ~28% and blew the ceiling is exactly why these are a separate token: the word
   wash is sized so the **composite** (line + word) still satisfies AC-T5.2.
5. **The diff gutter** takes `diffEditorGutter.insertedLineBackground` / `removedLineBackground`
   (present in monaco 0.55.1) from the same `--diff-editor-*` pair, so the gutter reads as part of the
   row rather than deriving its own tint.
6. Applies to **both** `renderSideBySide` modes — the inline view is the same editor with the same
   colour keys, and the user's toggle (`settings.diffSideBySide`) flips live (`diff-viewer.tsx:~108`).

### Acceptance criteria (T5)

- **AC-T5.1 — changed lines read at a glance.** In every theme, a changed line in a diff pane is
  **≥ 1.5:1** against an unchanged line in the same pane.
  *Why 1.5:* ~1.15× the strongest step any surface ships today (1.32) and just below the 1.70-2.05
  band the diagnosis measured for `.rline__word` and describes as the strongest readable signal on a
  Neon row. It is verified reachable inside a **non-opaque** alpha on Neon's `#06050c` — the darkest
  base in the repo — at roughly α 0.20 (add) / 0.34 (remove). And it is the **largest line-level
  step** that keeps AC-T5.2 satisfiable without re-tuning the syntax palette (see below). The word
  step in AC-T5.3 stacks on top of it; that composite has its own, lower floor for exactly that
  reason.
- **AC-T5.2 — code stays legible.** On that changed line, `--syn-default` is **≥ 4.5:1** and every
  other `--syn-*` foreground **≥ 3:1**.
  *Why:* `test/unit/theme-tokens.test.ts:154` holds every `--syn-*` at ≥ 4.5:1 against `--code-base`;
  a 1.5:1 wash divides that by at most 1.5, landing exactly at 3:1. AC-T5.1 and AC-T5.2 are the same
  constraint written from both ends — which is what pins 1.5 rather than a rounder number.
- **AC-T5.3 — word emphasis.** Within a changed line, the word-level span is **≥ 1.5:1** against the
  rest of that line, and the line+word composite keeps every `--syn-*` at **≥ 2.0:1**.
  *Why 2.0:* the two steps stack multiplicatively — 4.5 ÷ (1.5 × 1.5) = **2.0**, so 2.0 is the exact
  arithmetic consequence of AC-T5.1 and this criterion's own word step, not a separately chosen
  number. Anything higher would make the three floors mutually unsatisfiable. It is a floor, not a
  target: the diagnosis measured real code on today's word highlights at **4.54-7.52** (B-3).
- **AC-T5.4 — the minimap exists and honours the setting.** With `editorMinimap` on, both panes show
  a minimap with `renderCharacters: false`; with it off, neither does. The AC-T3.3 fixture (2000
  lines, 3 changes) shows **3 marks in the diff overview ruler and 3 in the modified pane's minimap**,
  without scrolling.
- **AC-T5.5 — one visual language.** The diff overview ruler's inserted/removed colours are byte-equal
  to `--change-added` / `--change-deleted` — the same values the plain editor's ruler uses for the
  same file.
- **AC-T5.6 — inline mode parity.** Toggling to inline (`diffSideBySide` off) keeps AC-T5.1, T5.3 and
  T5.5 true.

```gherkin
Feature: Split diff shows where the changes are
  Scenario: A 2000-line file with 3 changes, side by side
    Given the Review card's Split view is open on that file
    When the diff editor has laid out
    Then the diff overview ruler paints 3 marks at 3 distinct heights
    And the modified pane's minimap paints 3 marks without scrolling
    And a changed line is at least 1.5:1 against an unchanged line in the same pane
```

### Edge cases (T5)

| Condition | Expected |
|---|---|
| Binary / oversize diff | the notice renders as today; "Open file" still works (`onOpenFile`) |
| Whole-file rewrite | every line washed — correct here, because a diff editor's job *is* to show both sides; T3's untracked rule does not apply (there is a baseline) |
| No changes | no ruler marks, no minimap marks |
| Live `diffSideBySide` toggle | colours and minimap survive the option update, no re-mount flash |
| A file with a selection or a find match on a changed line | the non-opaque wash lets Monaco's selection/find decoration show through (decision 3) |
| Very large diff | `size: 'fit'` applies per pane; the same §13 scrubbing caveat as T3 |

---

## 7. Data / interface contract

No IPC surface changes. No host changes. No persisted-file format changes. The whole spec is
renderer-side: CSS custom properties, `monaco-theme.ts` colour keys, Monaco construction options,
two module-level constants (`MAX_DECORATION_LCS_CELLS`, and the marker recompute's
`ignoreWhitespace` argument), and `view-state-store.ts`'s `reviewAnchor` entry shape.

**Invariants**

- Editor markers equal Review's **All** scope for the same file **under the same
  `reviewIgnoreWhitespace` setting** (T3 decision 5 — this replaces the 2026-08-27 §3 invariant).
- `--diff-add` / `--diff-remove` are consumed **only** by `.rline--add` / `.rline--del`. Any other
  consumer is a regression; asserted by a grep-style unit test.
- Every ruler and minimap change mark in the app resolves to `--change-added` / `--change-modified` /
  `--change-deleted` — one vocabulary across the plain editor and the diff editor.
- No colour literal appears in any `.rline*` or `.cdec*` rule.
- Review view-state entries live and die with the tab (`markClosing`); nothing reaches disk.

---

## 8. Defaults vs. settings

| Decision | Default | Configurable? | Rationale |
|---|---|---|---|
| Review tab state memory | on | no | it is the absence of a bug, not a feature |
| Review state persists across restart | no | no | the ask is explicit: *while the tab is open* |
| Decoration LCS budget | `MAX_LCS_CELLS` (4 M), or the largest measured value that fits 100 ms | no | §16 |
| `minimap.size` | `'fit'` | no | a map that scrolls is not a map (T3 decision 2) |
| Overview ruler width | 20 px (recommended mechanism) | no | buys a 9 px change lane and keeps 10 px for errors |
| Editor markers honour ignore-whitespace | follows `reviewIgnoreWhitespace` (default off) | via that existing setting | one setting, two surfaces — the user's mental model |
| Split-diff minimap | follows `editorMinimap` (default on) | via that existing setting | stops the hard-coded `false` overriding the user |
| Row wash ceiling (Review) | 15% | no | Specimen token contract |
| Diff-editor wash floor | 1.5:1 | no | paired with AC-T5.2 |
| New settings introduced | **none** | — | every knob above already exists |

---

## 9. Scope slicing

- **MVP:** T1 (in flight) · T3 R3.1 + R3.3 + R3.4 (the "nothing" and "everything" cases and the silent
  states) · T2 tokens + Neon parity.
- **v1:** T3 geometry (ruler lane, `size: 'fit'`, dual minimap decorations) · T5 in full · **T4 last**
  — not because it is large (it is the smallest item) but because the conductor caps concurrent
  app-driving agents at two, and T4 is the one held back (§14).
- **Vision:** a change-density heat strip in place of discrete marks for files with hundreds of hunks;
  a Review "jump to next unreviewed file" that shares the ruler vocabulary.
- **Out of scope:** §1 non-goals; re-tuning `--change-*`; any Specimen-contract change to the 15%
  ceiling (§16).

---

## 10. State catalog (UI) — deltas only

| Component | State | What the user sees | Action |
|---|---|---|---|
| Review tab | restored | scroll, folds, collapse, filter, find bar, cursor as left | — |
| | fresh (reopened / source changed) | default state, no stale card state | — |
| Editor change map | live | ≥ 9 px ruler marks + minimap marks over the whole file | click/scrub, `Alt+F5` |
| | untracked | gutter bars only; **empty** ruler and minimap | — |
| | markers off | nothing; navigation announces "Change markers are off" | — |
| | no repo / timeout / oversize | nothing; navigation announces that reason; **no banner** | — |
| | budget exceeded | nothing; navigation announces `DEGRADED_HINT` | — |
| Find widget | rest / hover / **focused** / expanded | app-family chrome; on focus the **whole box** rings | type, toggles, ↑ ↓ ×, chevron |
| Split diff | changed line | ≥ 1.5:1 wash + word emphasis + gutter tint | — |
| | minimap on / off | present per `editorMinimap` | scrub |

## 11. Interaction inventory (UI) — deltas only

| Component | Pointer | Keyboard | ARIA |
|---|---|---|---|
| Overview ruler mark | click to reveal (Monaco-native) | `Alt+F5` / `Shift+Alt+F5` (unchanged) | live region: "Change N of M", or the specific unavailability reason |
| Minimap | scrub / click | — | Monaco-native |
| Find widget field | click, select | `Mod+F`, Enter, Shift+Enter, Esc (Monaco-native) | Monaco-native; the restyle must not remove `aria-label`s |
| Find widget buttons | click | Tab cycle | `aria-checked` on the toggles — Monaco's own, preserved |
| Review tab restore | — | — | no announcement (restoring a view is not an event) |

**Accessibility & i18n**

- **Colour is never the only signal.** Added = solid bar, modified = dashed, deleted = triangle
  (`styles.css:9868-9884`, unchanged); ruler and minimap marks are redundant with the gutter; in
  Review the `+`/`−` glyph shape carries add/remove independently of its new hue.
- T2's whole point is the **luminance** channel, which is what a red/green-deficient viewer has left.
- Every non-live map state is **announced**, not merely visually absent (T3 decision 6).
- Focus: the find widget's ring is a real focus indicator on the whole control (T4 decision 2).
- Reduced motion and forced colors: no new animation; `.cdec` already uses borders.
- i18n: repo convention — English literals, no layer.

## 12. Design tokens

New, per theme, declared beside the existing `--diff-*` block. **Where that block actually lives:**
`--diff-add` / `--diff-remove` / `--diff-marker` are declared **only** at `:root`
(`styles.css:184-186`) and at `:root[data-theme="neon"]` (`:384-386`) — so `:root` carries **both**
Aero Dark and Aero, and only Neon overrides. (`:291-293` is Aero's `--change-*` block, a different
family.) The six new tokens follow the same shape: declared at `:root`, overridden under Neon.
Aero therefore inherits unless a measurement says it must not — and AC-T2.1-T2.6 iterate `THEMES`
and assert **per theme**, so an inherited value that fails a floor fails the gate.

**Also changing value (not just gaining siblings):** Neon's `--diff-add` `.09 → .15` and
`--diff-remove` `.10 → .15` (§3 decision 2; recorded in §16). The 15% ceiling itself is untouched.

The six:

`--diff-editor-add` · `--diff-editor-remove` · `--diff-word-add` · `--diff-word-remove` ·
`--diff-sign-add` · `--diff-sign-remove`.

Semantic roles, surfaces served and the tokens each surface stops using: **§0.1**. Monaco cannot read
CSS custom properties, so all six resolve through `getComputedStyle` in `monaco-theme.ts`'s existing
`col()` helper and are re-applied on theme change — the same mechanism `--change-*` already uses
(`use-change-markers.ts:53-66`).

---

## 13. Regression risks (called out explicitly)

1. **Raising the LCS budget affects recompute time on a 300 ms keystroke debounce.** 250 k → 4 M is a
   16× larger dense table (~32 MB of number cells at the limit). AC-T3.2 makes this measurable rather
   than hopeful; if the worst case does not fit 100 ms, the budget is the largest value that does, and
   the number goes in the run report. **Mitigation that is *not* acceptable:** keeping the silent
   `clear()` — R3.4 forbids it regardless of the budget.
2. **Changing the overview-ruler lane may occlude error/warning marks.** With
   `overviewRulerLanes: 2`, `OverviewRulerLane.Full` covers x 1-13 and would swallow the error lane
   entirely. AC-T3.4 is the guard. The recommended alternative (widen the ruler to 20 px) trades a
   wider scrollbar on **every** editor for a wider change lane — a visible furniture change, named
   here so it is a decision rather than a side effect.
3. **`minimap.size: 'fit'` changes the minimap for every file, not just changed ones.** On a
   10 000-line file every line becomes sub-pixel and the slider becomes small; scrubbing must still
   work. This is a global editor behaviour change riding on a change-marker fix.
4. **Touching `--diff-marker` would affect every diff surface in the app.** It is deliberately **not**
   re-tuned — §0.1 adds `--diff-sign-add` / `--diff-sign-remove` alongside it. Its one *source*
   consumer today is `styles.css:9834`; the neutral remains correct for context rows. Note that
   Monaco's *inline* diff view renders its own `+`/`−` glyphs which Conduit does not own.
   **This breaks a shipped e2e on purpose:** `test/e2e/review-diff-syntax.e2e.mjs:152-159` asserts
   *"+ marker must use `--diff-marker`"* and the same for `−`. Both assertions must be updated to
   the new sign tokens in the same change — a red suite here is the expected outcome, not a
   regression, and §14 owns the edit.
11. **Neon's `--diff-add`/`--diff-remove` change value** (.09/.10 → .15). The same e2e asserts the
    row tint equals the token, so it follows the token and stays green — but any hard-coded Neon
    expectation elsewhere would not. Grep before assuming.
5. **A stronger `diffEditor.insertedLineBackground` must stay non-opaque** or it hides selection, find
   matches and the current-line highlight (monaco's own documented contract). AC-T5.2 and the
   selection edge case are the guards.
6. **A contrast test can be green and broken.** Custom properties resolve at their **declaring**
   element, and the timed-messages run shipped exactly this failure. `test/unit/theme-tokens.test.ts`
   already models a re-scoped surface (`AERO_TERM`, `:35`) — every new contrast assertion must layer
   the real declaration chain the same way. For T2 that chain is `:root[data-theme=…]` →
   `.rhunk__lines` (`--code-surface` → `--code-base`), **not** `--panel`.
7. **T1's live-Map sharing removes the copy step and with it the safety of a copy.** A source change
   must drop the maps (T1 decision 3); a stale card map under a different changeset is worse than no
   memory at all.
8. **T1's `useLayoutEffect` measurement forces a synchronous layout on every Review mount.** That is
   the price of restoring before first paint; the Review scroller is one element, so it is bounded —
   but it is a new sync read on a hot path.
9. **Neon's `--focus-ring` is the inset variant** (`styles.css:361`) while the default is an outer
   shadow (`:33`). A T4 ring drawn as an outer box-shadow is clipped by Monaco's `overflow: hidden`;
   AC-T4.1 tests all four edges in all themes for exactly this.
10. **Any specificity ladder or `!important` added to out-rank Monaco is a band-aid** (CLAUDE.md).
    AC-T4.5 makes it a failing test rather than a code-review opinion.

---

## 14. Test plan

**Unit** (`test/unit/`, run inside `npm run verify` — never narrow or defer a check to make progress):

| Check | Where |
|---|---|
| AC-T2.1-T2.6, AC-T5.1-T5.3 — the whole contrast/ΔE matrix, per theme, **at the real declaring element** | extend `test/unit/theme-tokens.test.ts` (reuse its `tokensFor` / `contrast` helpers and its re-scoping precedent) |
| No colour literal in any `.rline*` / `.cdec*` rule; `--diff-add`/`--diff-remove` have no consumer outside `.rline--add`/`.rline--del`; zero `!important` in the find-widget rules (AC-T4.5) | new `test/unit/diff-tokens.test.ts` (CSS text assertions, same shape as the drag-region guard) |
| AC-T3.1 — span 499/500/901 produce markers, at the raised budget | extend the existing `change-decorations` unit tests |
| AC-T3.2 — the < 16 ms benchmark, plus the new worst-case timing | same file; the worst-case number is **reported**, not asserted as a hard threshold in CI (machine-dependent) |
| AC-T3.6 — `computeFileReview` with `ignoreWhitespace` yields 0 hunks for a pure re-indent | `src/review-hunks` tests (already parameterised) |

**E2E on the real app** (`test/e2e/<name>.e2e.mjs` on the shared harness — required wherever the
assertion is about **what Monaco actually paints** or about **mount/unmount lifecycle**, neither of
which a unit test can reach). Run hidden (`CONDUIT_E2E=1`), **serially**, one scenario at a time in
the inner loop:

| Scenario | Covers | Why it must be e2e |
|---|---|---|
| `review-tab-state` (new) | AC-T1 all | tab switch = real unmount/remount; the first-committed-frame assertion needs a real paint |
| `change-map-geometry` (new) | AC-T3.3, T3.4, T3.5, T3.8 | canvas pixel sampling of `.decorationsOverviewRuler` and `.minimap-decorations-layer` via `getImageData` — the technique the diagnosis proved out |
| `editor-change-markers` (extend) | AC-T3.1, T3.6, T3.7 | the announcements go through the live region in the real app |
| `split-diff-map` (new) | AC-T5.4, T5.5, T5.6 | the diff editor's ruler is a different canvas from the plain editor's |
| `review-diff-syntax` (**extend**) | AC-T2.1-T2.5 on **composited** pixels, one launch per theme — **and the mandatory update of its `--diff-marker` sign assertions** (`:152-159`, §13 risk 4) | it already samples these exact tokens and rows per theme, so extending it costs no extra Electron launch. A live theme swap does not invalidate a hidden window's compositor tiles — **seed the theme into the profile and launch per theme**, as the diagnosis did |
| `find-widget-style` (new) | AC-T4.1-T4.4, T4.6 | the ring's four edges and the ×'s centre are geometry only the real widget has |

**By hand, on a real visible window** (Playwright cannot settle these):

- The runtime minimap toggle (`code-viewer.tsx:501`) after any T3/T5 change — the diagnosis's one
  unresolved artifact.
- Scrubbing the minimap on a 10 000-line file at `size: 'fit'` (risk 3).
- The green `+` against a string-heavy sample on every theme (T2 decision 4).

**Load discipline:** the e2e suite and a builder driving Electron must not overlap. **No more than
two agents may drive the app at once** — the conductor's standing cap, and the reason T4 is held
back to v1 in §9 despite being the smallest item. If a run shows `.termpane` timeouts, "the shell
echoed what we typed" failures or `STATUS_DLL_INIT_FAILED`, treat it as machine load, not
regression, and re-run that scenario alone before believing it.

---

## 15. Assumptions

Every call made without a human, per the autonomous-mode contract.

1. **Tiers.** T1 LITE (in flight, recorded for the archive), T2 FULL, T3 FULL, T4 LITE (one widget,
   one job, no state machine beyond focus), T5 FULL (one surface but four sub-surfaces plus an editor
   construction-option change affecting every diff tab).
2. **Token names** in §0.1 are chosen here, not handed down. They follow the existing
   `--diff-<role>-<side>` vocabulary. Renaming them is cheap; the *split* is the decision.
3. **`--diff-marker` is not re-tuned**, only narrowed — the neutral stays correct for context rows.
4. **AC-T2.1's 1.30/1.14 are parity floors, not sufficiency claims.** They are the arithmetic maximum
   inside the 15% ceiling; sufficiency comes from AC-T2.2/T2.5 (marker + word). See §16.
5. **AC-T5.1's 1.5:1 and AC-T5.2's 3:1 are one constraint from both ends** — 1.5 is the largest row
   step that keeps every `--syn-*` above WCAG's 3:1 given the existing ≥ 4.5:1 unit-test floor.
6. **AC-T3.3 drops a minimap thickness floor** because `size: 'fit'` makes one unmeetable on a
   2000-line file. Presence at distinct positions is asserted instead; the ruler carries legibility.
7. **The 20 px overview ruler is a recommendation, not a mandate.** The AC is mechanism-agnostic
   ("≥ 9 px wide, errors still visible, report the measured pixels").
8. **Dual minimap decorations** (`Gutter` rail + `Inline` block) are assumed to be the way to a
   legible minimap mark, since `GUTTER_DECORATION_WIDTH` is a Monaco constant. If `Inline` proves
   text-extent-limited (a short line yields a short mark), the Gutter rail still carries position and
   AC-T3.3 still passes.
9. **T3 decision 5 supersedes the 2026-08-27 spec §3 invariant** about ignore-whitespace. Recorded as
   a deliberate replacement, not an oversight.
10. **No new user-facing setting** is introduced by T2-T5; every knob already exists.
11. **T4 restyles Monaco's widget; it does not replace it.** A Conduit-owned find bar for Monaco would
    be a much larger change and was not asked for.
12. **T5 applies to both `renderSideBySide` modes** — same editor, same colour keys.
13. **No i18n layer** (repo convention), ISO-8601 where dates appear.
14. **The Review row surface is `--code-base`**, not `--panel` — sampled pixels in all three themes
    equal `--code-base` exactly, including on Aero where a light card holds a dark ink diff body.
15. **e2e scenario names** in §14 are chosen here; a builder may fold one into an adjacent scenario if
    the harness setup is identical, but the coverage rows are not optional.
16. **Contrast is measured at `devicePixelRatio = 1`**; the lane math is DPR-linear, so CSS-px sizes
    are assumed to hold at 1.25/1.5/2. Not verified above 1.

---

## 16. Queued for the conductor

Not open questions — each has a default taken and the work proceeds. Flagged because the conductor
may want a different call.

- **[high] The row wash cannot answer "needs more contrast" on its own.** Inside the Specimen
  contract's 15% ceiling, Neon's deleted row tops out at **1.14:1** and its added row at **1.32:1** —
  i.e. exactly parity with the other themes, no better. If the user's objection is specifically to the
  *row*, that ceiling has to move, and that is a Specimen-contract decision the conductor owns.
  **Default taken:** hold the ceiling; buy the signal from the marker (AC-T2.2) and the word highlight
  (AC-T2.5), which is what the contract always claimed was happening. Ship, then re-check against the
  user's screenshot.
- **[normal] `minimap.size: 'fit'` cannot deliver *legible* marks and *whole-file* coverage at the
  same time.** At fit, a 2000-line file's `minimapLineHeight` floors to 1 px, so a mark is a hairline.
  The ruling's own test ("3 findable marks in the minimap") is satisfiable as presence at 3 distinct
  positions, but not as legibility. **Default taken:** the ruler carries legibility (AC-T3.3's 9 px),
  the minimap carries whole-file coverage; AC-T3.3 asserts presence there, not thickness. If the
  conductor wants a legible minimap mark, the alternative is dropping `fit` and accepting that marks
  scroll — which is the bug being fixed.
- **[normal] The ruling says "raise the decoration budget to Review's" and separately "prove the
  worst-case recompute fits."** Those can conflict. **Default taken:** 4 M is the target; if the
  measurement misses 100 ms, the budget becomes the largest value that fits and the number is
  reported — a deviation from the letter of the ruling, in service of its stated reason.
- **[normal] Widening the overview ruler to 20 px is visible furniture on every editor**, not only on
  files with changes. **Default taken:** accept it, since AC-T3.3's 9 px lane is otherwise unreachable
  without occluding the error lane. A conductor who prefers the current scrollbar width should expect
  AC-T3.3 to be renegotiated down to ~6-7 px.
- **[normal] Lowered `codeOpacity` was not measured.** Neon is the only theme with `--theatre` lit;
  at default opacity the diff body is opaque and the composite table holds, but at a lowered opacity
  the whole table shifts. **Default taken:** all floors are asserted at default opacity; the shader
  contribution is out of scope.
- **[normal] Neon's `--diff-add`/`--diff-remove` values rise .09/.10 → .15 — a departure from the
  ruling's letter.** `blockers.md` says *"Do not solve this by raising `--diff-add`/`--diff-remove`"*,
  aimed at raising them **past** the 15% ceiling as the solution. What §3 decision 2 does is bring Neon
  **up to** the ceiling the other two themes already sit at, as a parity fix; the ceiling is untouched
  and the actual solution stays the marker + word tokens. **Default taken:** make the parity change and
  flag it here rather than leave Neon at .09/.10 while claiming AC-T2.1 is met — AC-T2.1 (1.30/1.14) is
  otherwise unreachable on Neon. Say the word and it reverts, at the cost of AC-T2.1.
- **[normal] Two Neon added rows sampled `#0c221f` rather than the arithmetic `#051c19`** — something
  adds ~+6 on all channels to some added rows (a current-hunk band, a hover state, or the shader).
  Unidentified. **Default taken:** the floors are asserted against the deterministic token composite,
  which is the lower (worse) value, so the assertion is conservative. Worth identifying during T2.

## 17. Self-audit

Sections 1-16 are filled. §7 (data/interface contract) is deliberately short — the spec changes no
IPC, host or persisted-file surface, and says so rather than leaving the section blank. The UI module
(§10-12) is filled as **deltas only**, because the 2026-08-27 spec's §8-11 already carry the full
catalogs for these surfaces and CLAUDE.md forbids restating a decision that already lives in a spec.
Every item has: the user's words (header), the measured root cause with `file:line` (§2-6), the
decision, executable acceptance criteria with a justified numeric floor, and edge cases — **T1
included** (§2). Regression risks (§13), assumptions (§15) and queued decisions (§16) are all present
and non-empty.

**Reviewed 2026-08-31** by a fresh-eyes pass against `blockers.md`, `goal.md` and ADR 0003. It found
three blocking defects, all fixed here: the §0.1/§3 contradiction over Neon's row-wash values (now
stated as a ceiling-preserving parity change and queued in §16); a shipped e2e this spec invalidates
that no section named (`review-diff-syntax.e2e.mjs:152-159`, now in §13 risk 4 and §14); and a
mutually-unsatisfiable composite-contrast floor (2.5 → **2.0**, derived rather than chosen, in both
AC-T5.3 and §3's edge-case table). Also corrected: six `file:line` citations, every cross-reference
to §15/§16/§7, AC-T3.3's 45% figure, the "two-way tie" at 1.14, AC-T2.3's inverted justification,
AC-T3.8's measured surface, AC-T4.6's and three T4 edge cases' unmeasurable wording, the §12
token-declaration sites (`:root` carries Aero **and** Aero Dark), the residual span-2000 cliff and
its missing announcement AC, T1's absent edge-case table, AC-T1's under-specified state list, the
non-existent "Paper" theme, a duplicate e2e launch, and the two-agent concurrency cap.
