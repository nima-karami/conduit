---
status: active
date: 2026-06-29
---

# Feature Spec: Review tab — collapsible file cards + large/added-file portioning

**Tier:** FULL   **Feature type:** UI
**One-line request (verbatim):**
> (3) "If I'm adding a new file, it gives me a big window of the entirety of that file. That's not ideal. If you add a new file as a new change and there are a thousand lines in that file, I shouldn't see all of those. I should see a portion of that with the ability to expand and collapse."
> (4) "When I'm looking at different changes across different files, I should be able to click on the header of each change file in a way that it either collapses or expands so I can go through all the changes very quickly and I can see things."

Two related asks against the Review changes tab (`webview/components/review-view.tsx`):
- **Item 4 — collapsible cards:** each file card's header is a clickable toggle that collapses/expands the card body, so the user can scan many files quickly.
- **Item 3 — large/added-file portioning:** a large or newly-added file shows only a bounded *portion* of its content by default, with expand/collapse — never the whole 1000-line file.

---

## 1. Problem frame

- **Job (JTBD):**
  - *Item 4:* "When I'm reviewing a changeset spanning many files, help me skim the file list and drill into only the ones I care about — without scrolling past every diff."
  - *Item 3:* "When a file is huge (especially a brand-new file that is all additions), show me enough to get the gist, not the entire file, and let me pull in more only if I want it."
- **Actors / roles:** A single local user reviewing changes in the Review tab — either the working tree or a specific commit (same card renderer for both; see `effectiveChanges`/`effectiveDiffs` in `review-view.tsx`).
- **Success outcomes (observable):**
  1. Clicking a card's header collapses the card to just its header row (path + stat); clicking again restores it. Collapsing N cards lets the user see N+ file headers in one viewport.
  2. Opening a Review with a newly-added 1000-line file shows a bounded portion (a few hundred rows), with a clear "Show all" affordance — not all 1000 lines.
  3. Expanding a portioned card to full, then collapsing back to the portion, both work and re-flow the list correctly (no scroll jump, no orphaned spacers).
  4. Collapse/portion state survives a card scrolling out of the virtualization window and back.
- **Non-goals:**
  - Persisting collapse state to disk across app restart (session-only; see §5).
  - Editing/staging from the Review card (it stays read-only, as today).
  - Changing the diff/hunk/fold algorithm (`src/review-hunks.ts`) or the windowing math (`webview/review-window.ts computeWindow`).
  - A per-hunk collapse (folds already exist via `FoldRow`); this spec is whole-card collapse + a whole-card row cap.

---

## 2. Behavior & states

### 2.1 The two interacting axes
A card has **two independent, orthogonal pieces of UI state**, both already (or newly) cached per-path in `CardUiState` so they survive the windowing unmount:

| Axis | Field | Meaning | Default |
|---|---|---|---|
| Collapse (item 4) | `collapsed: boolean` (NEW) | Body hidden; only `.rcard__head` rendered | `false` (expanded) |
| Portion cap (item 3) | `showRemaining: boolean` (EXISTS) | When the card's rendered rows exceed the cap, `false` shows the bounded portion + "Show all", `true` shows every row | `false` (capped) |

The user-visible **state machine** is the product of the two axes:

```
                       ┌──────────────────────────────────────┐
            collapse   │ COLLAPSED                             │
        ┌────────────▶ │  header only; body hidden.           │
        │              │  underlying cap state preserved.     │
        │   expand     └──────────────────────────────────────┘
        │  ◀────────────────────┐
┌───────┴──────────┐   show all │      ┌───────────────────────┐
│ EXPANDED-CAPPED  │ ───────────┼────▶ │ EXPANDED-FULL         │
│ portion of rows  │            │      │ every row rendered    │
│ + "Show all N"   │ ◀──────────┘      │ + "Show less"         │
└──────────────────┘  show less        └───────────────────────┘
        ▲ (only reachable when total rendered rows > cap;
          otherwise the card is simply EXPANDED with no cap control)
```

- Collapse hides the body **regardless** of the cap state; expanding restores whichever cap state was in effect.
- A card whose total rendered rows are `≤ cap` has no cap control at all — it is just EXPANDED (full) with no "Show all"/"Show less".

### 2.2 Primary flows
- **Skim flow (item 4):** user clicks header → card collapses to one row → repeats down the list → clicks a collapsed header → it expands in place; the list re-flows (spacers + scroll anchor stay correct).
- **Big-add flow (item 3):** user opens a Review whose first file is a new 1000-line file → card mounts EXPANDED-CAPPED showing ~the first portion of rows + "Show all 1000 lines" → click → EXPANDED-FULL → "Show less" → back to portion.

### 2.3 Per-state rendering (see §8 for the full catalog)
- **COLLAPSED:** `.rcard` renders only `.rcard__head` (kind badge, path, +/- stat, the collapse chevron, and the "Open file" button). Body (`HunkList` / image / binary / loading / "No textual changes") is unmounted.
- **EXPANDED-CAPPED:** body renders `planRowCap`-limited rows + the (relabelled) `.rcard__showrest` control.
- **EXPANDED-FULL:** body renders all rows + a "Show less" control (NEW — today `showRemaining` is one-way).

---

## 3. Data / interface contract

This is a renderer-only feature; no host/IPC/protocol change. The contract is the in-memory `CardUiState` and the pure `planRowCap`.

### 3.1 `CardUiState` (extend, `review-view.tsx`)
```ts
interface CardUiState {
  folds: Map<number, FoldShown>;
  showRemaining: boolean;   // existing — now a TOGGLE (was effectively one-way)
  collapsed: boolean;       // NEW — whole-card collapse (item 4)
}
// emptyUi(): { folds: new Map(), showRemaining: false, collapsed: false }
```
- Cached per **path** in `uiCacheRef` (same Map that already holds folds/showRemaining), so collapse + cap survive the card unmounting when scrolled out of the window. Trust boundary: purely renderer-local; no validation needed.

### 3.2 Row cap (`webview/review-window.ts planRowCap`)
- **No signature change.** `planRowCap(lineCounts, cap, expanded)` already returns `{ shown, remaining }` and already correctly handles a single pure-add hunk: an added file is `computeFileReview('', work)` → one hunk whose `lines` are all `add` (no folds), so `lineCounts === [N]`, and `planRowCap([N], cap, false)` caps it to `[cap]` with `remaining = N - cap` when `N > cap`. **The reason the user still sees the whole file is the cap VALUE, not a missing code path.**
- **The cap counts HUNK rows only** (`lineCounts = hunks.map(h => h.lines.length)`); fold bars and revealed fold context are separate rows not counted. So "300" is exact for the pure-add target case (one all-add hunk) but a heavily-modified file with several hunks + revealed folds can render somewhat more than 300 DOM rows. Read "portion ≈ 300 diff rows", not "≤ 300 DOM rows".
- **Root-cause change:** lower the cap constant `MAX_CARD_ROWS` in `review-view.tsx` from `2000` to a portion value (proposed **300**; see §5 / Decision D1). This portions any large card — a pure-add file (one big hunk) and a huge modified file alike — through the *existing* code path. **Do not** add an added-file-only branch.
- Invariant preserved: `Σ shown + remaining === Σ lineCounts`; when `expanded === true` OR `total ≤ cap`, `remaining === 0` and all rows show.

### 3.3 Collapse + measurement contract
- Collapse is the only new render path that changes a card's height. Height re-measurement is **already wired**: the `ReviewFileCard` `ResizeObserver` on `rootRef` fires on any `offsetHeight` change → `onMeasure(path, height)` → updates `measuredRef` → `setMeasureTick` → `computeWindow` re-runs with the new (header-only) height. **No new measurement plumbing is required** — collapsing/expanding must simply mount/unmount the body so `offsetHeight` actually changes.

---

## 4. Edge cases & failure modes

| Condition | Expected behavior / recovery |
|---|---|
| Collapse a card that holds keyboard focus | Focus lives on the header **toggle button**, which is *not* unmounted by collapse (only the body is). `focusedPath` keeps the card pinned in the window (`view` memo). Focus stays visible on the toggle; `aria-expanded` flips. No focus loss. |
| Collapse while the diff is mid-load (`Loading diff…`) | Collapse hides the loading notice too; the in-flight `onRequestOnce` is unaffected. On expand, whatever state the diff is now in renders. |
| Binary / image card | Collapse works (hides the image/binary notice). Portioning is **N/A** (no `lineCounts`); no "Show all"/"Show less" control appears. |
| "No textual changes" card (hunks empty) | Collapse works; portioning N/A. |
| Card with total rows `≤ cap` | EXPANDED-FULL with no cap control; collapse still works. |
| Pure-add (new file) | One big add-hunk → capped to the portion via existing `planRowCap`; "Show all N lines". |
| Pure-del (deleted file) | One big del-hunk → same capping path. |
| Huge modified file | Hunk rows summed across hunks; capped at the portion (folds for unchanged runs are unaffected — they are separate `FoldRow`s, not counted in `lineCounts`). |
| Collapse → scroll away → scroll back | `collapsed` read from `uiCacheRef` per path; card re-mounts collapsed. Same for `showRemaining`. |
| Many cards collapsed at once | Each is header-height (~1 row), so the window holds many more cards → more diffs may be requested on mount. Bounded by viewport size; acceptable (see Decision D4). |
| Font-scale change while collapsed | Existing MutationObserver clears `measuredRef`; collapsed cards re-measure to the new header height on next mount. |
| Working-tree source vs commit source | Identical behavior — both feed the same `ReviewFileCard`. |
| Source switch (working ⇄ commit) | Existing reset zeroes scroll/focus; `uiCacheRef` is path-keyed and harmlessly carries across (different files won't collide; a same-path file keeps its collapse state, which is acceptable). |
| Toggle re-measure correctness | Every collapse/expand/show-all/show-less changes `offsetHeight` → `onMeasure` → re-window + scroll-anchor (the same path a fold expand already exercises). Acceptance test asserts spacers/scrollTop stay correct. |
| "Show less" on a card partially scrolled past | `onMeasure`'s scroll-anchor only compensates for cards ABOVE the top-visible card (`idx < topVisible`). Collapsing/show-less the card the user is currently inside shrinks content *under* the viewport, so rows below shift up — this is expected reflow, not a bug; the "no jump" guarantee applies to the toggled-card's own top edge and to cards above it, not to content below a card being shrunk in place. |

---

## 5. Defaults vs. settings

| Decision | Default | Configurable? | Rationale |
|---|---|---|---|
| Initial collapse state | Expanded | No | Preserves today's behavior; collapse is an opt-in scan tool. Auto-collapsing would hide diffs the user came to read. |
| Per-card row cap (portion size) | **300 rendered rows** (was 2000) | No (constant; tunable in code) | 2000 lets a 1000-line add through whole — the exact complaint. ~300 is a few screens: enough to gauge a file, small enough to be "a portion." Reversible single constant (Decision D1). |
| Cap applies to | All cards uniformly (added, deleted, modified) | No | Root-cause fix via the existing `planRowCap` path; an added-file-only branch is a band-aid (CLAUDE.md). |
| Collapse / cap persistence | Session-only (in-memory `uiCacheRef`), like folds + `showRemaining` today | No | Matches the existing per-path UI cache; persisting to disk is scope creep and a new settings surface. Cleared on app restart (Decision D2). |
| Cap control direction | Two-way: "Show all" ⇄ "Show less" | No | Item 3 explicitly asks for "expand **and** collapse"; today's `showRemaining` is one-way. |
| Collapse-all / expand-all bulk control | **Not in MVP** (v1) | n/a | Helps "go through all changes quickly" but per-card collapse satisfies the literal ask; bulk toggle interacts with not-yet-mounted cards' height estimates (Decision D3). |

---

## 6. Scope slicing

- **MVP (must):**
  1. `collapsed` added to `CardUiState` + `emptyUi()`.
  2. Header becomes a toggle: a single toggle button wrapping the chevron + kind badge + path + stat; the "Open file" button stays a **separate sibling** (no nested buttons). Click/Enter/Space toggles; `aria-expanded` + `aria-controls`. Chevron rotates by state (not color-only).
  3. Collapsed card renders header only (body unmounted); re-measures via the existing ResizeObserver.
  4. Lower `MAX_CARD_ROWS` 2000 → 300 (the portion).
  5. Cap control becomes two-way: "Show all N lines" (capped) ⇄ "Show less" (full), driven by toggling `showRemaining`.
- **v1 (should):**
  - Collapse-all / expand-all control in `.review__head` (Decision D3).
  - Defer diff fetch while a card is collapsed (don't `onRequestOnce` for collapsed cards), to make a fully-collapsed scan cheap (Decision D4).
- **Vision (could):**
  - Remember collapse state per path across restart (would need a persisted settings surface — out of scope now).
  - Keyboard shortcut to collapse/expand the focused card without reaching the header.
- **Out of scope:** diff algorithm changes; per-hunk collapse beyond existing folds; editing/staging; windowing-math changes.

---

## 7. Acceptance criteria

### Declarative
- Clicking a card header toggles the card between expanded and collapsed; a collapsed card shows only its header (path + stat + chevron + Open file).
- Clicking the "Open file" button opens the file and does **not** toggle collapse (the two click targets are distinct).
- Opening a Review with a newly-added file of >300 lines shows at most ~300 rows plus a "Show all 1000 lines" control — not the whole file.
- "Show all" reveals every row and swaps to "Show less"; "Show less" returns to the portion.
- Collapsing, expanding, showing-all, and showing-less each re-flow the windowed list so the scroll position and spacers stay correct (no jump, no overlap).
- Collapse and cap state survive scrolling the card out of the window and back.
- Collapse works on binary/image/"no textual changes" cards; those have no cap control.

### EARS
- **Event:** When the user activates a card's header toggle, the Review view shall hide/show that card's body, flip the toggle's `aria-expanded`, and re-measure the card so the windowed spacers and scroll anchor update.
- **State:** While a card is collapsed, the Review view shall render only that card's header and shall preserve the card's underlying cap state for restoration on expand.
- **Event:** When a card's total rendered diff rows exceed the per-card cap, the Review view shall render only the capped portion and a "Show all N lines" control.
- **Event:** When the user activates "Show all", the Review view shall render every row and present a "Show less" control; when the user activates "Show less", it shall return to the capped portion.
- **Unwanted:** If the user activates the "Open file" control on a card header, then the Review view shall open the file and shall **not** toggle that card's collapse state.
- **Unwanted:** If a card holds keyboard focus when it is collapsed, then the Review view shall keep that card mounted and focus visible on its header toggle.
- **Ubiquitous:** The Review view shall keep `Σ shown rows + remaining === total rows` for every card.

### Gherkin (key flows)
```gherkin
Feature: Review card collapse and large-file portioning

  Background:
    Given the Review tab is open on a changeset

  Scenario: Collapse a file card to scan quickly
    Given a file card is expanded
    When I activate its header toggle
    Then only the card's header is shown
    And the cards below shift up so more file headers fit in the viewport
    And the list scroll position does not jump

  Scenario: A newly-added large file is portioned
    Given the changeset adds a new file with 1000 lines
    When the file's card mounts
    Then at most about 300 lines are rendered
    And a "Show all 1000 lines" control is shown
    When I activate "Show all"
    Then all 1000 lines render
    And a "Show less" control is shown
    When I activate "Show less"
    Then the card returns to the portioned view

  Scenario: Open file does not toggle collapse
    Given a file card is expanded
    When I activate the card's "Open file" control
    Then the file opens in the editor
    And the card remains expanded

  Scenario: Collapse survives virtualization unmount
    Given I collapsed a file card
    When I scroll it out of view and back
    Then the card is still collapsed
```

---

## 8. State catalog (UI)

| Component | State | What the user sees | Action / CTA |
|---|---|---|---|
| Card header (`.rcard__head` toggle) | Expanded | Chevron pointing down/open, kind badge, path, +/- stat, "Open file" | Click/Enter/Space → collapse |
| Card header toggle | Collapsed | Chevron pointing right/closed, badge, path, stat, "Open file"; no body below | Click/Enter/Space → expand |
| Card header toggle | Hover / focus | Existing header bg + visible focus ring on the toggle | — |
| Card body | Expanded-capped | Portioned hunk rows + "Show all N lines" | "Show all" |
| Card body | Expanded-full | All hunk rows + "Show less" | "Show less" |
| Card body | Loading | "Loading diff…" (only when expanded) | — |
| Card body | Binary | "Binary file — no diff preview." (collapsible; no cap control) | — |
| Card body | Image | `ImageDiff` (collapsible; no cap control) | — |
| Card body | No textual changes | "No textual changes." (collapsible; no cap control) | — |
| Card body | Empty cap-control case (rows ≤ cap) | All rows, no cap control | — |
| Review list | Populated / empty / commit-loading | Unchanged from today (`EmptyState` variants) | — |

First-run / offline / permission-denied / not-found / saving states: **N/A** — this is a local, read-only, in-memory view with no network, auth, or persistence; the only "load" state is the existing per-card "Loading diff…".

---

## 9. Interaction inventory (UI)

| Component | Actions | Pointer | Keyboard | Touch | Context menu | ARIA role/states |
|---|---|---|---|---|---|---|
| Header collapse toggle | Collapse/expand the card | Click anywhere on the toggle region (chevron + badge + path + stat) | Tab to focus; Enter/Space activate | Tap | None (MVP) | `<button>`; `aria-expanded={!collapsed}`; `aria-controls={bodyId}`; accessible name e.g. "Collapse `<path>`" / "Expand `<path>`" |
| Chevron | Visual affordance for collapse state | Part of the toggle | — | — | — | Decorative (`aria-hidden`); state conveyed by `aria-expanded`, not the icon alone |
| "Open file" button | Open file in editor at first hunk | Click | Tab/Enter/Space | Tap | None | `<button>`, existing; sits **outside** the toggle button so it never triggers collapse |
| "Show all N lines" | Reveal all rows | Click | Tab/Enter/Space | Tap | None | `<button>`; plural-aware label |
| "Show less" | Return to portion | Click | Tab/Enter/Space | Tap | None | `<button>` |
| Card body | — | — | — | — | — | When EXPANDED, has an `id` and the toggle sets `aria-controls`→that id; when COLLAPSED the body is unmounted, so the toggle MUST drop `aria-controls` (don't dangle it at a missing id — see §10). |

Click-target precision (Decision D5): the header is laid out as `[ toggle button: chevron + badge + path + stat ][ Open file button ]`. The toggle button is the header's clickable background for collapse; the "Open file" button is a sibling, so a click on it never bubbles into a collapse. This avoids invalid nested `<button>`s and keeps both affordances reachable by keyboard in a natural tab order. Note the toggle adds a second tab stop per card (toggle → Open file); acceptable for MVP, and the Vision focused-card shortcut (§6) reduces the reliance on tabbing through long lists.

---

## 10. Accessibility & i18n (UI)

**Accessibility**
- **Keyboard:** header toggle is a real `<button>` — Tab reaches it, Enter/Space activate. "Open file", "Show all", "Show less" are buttons already. Tab order within the header: toggle → Open file.
- **Visible focus:** reuse the existing focus-ring treatment; verify it shows on the new toggle in forced-colors/high-contrast (don't strip the outline).
- **Accessible names:** toggle has a dynamic `aria-label` ("Collapse `<path>`" / "Expand `<path>`"); chevron is `aria-hidden`.
- **Announce dynamic results:** collapse/expand is conveyed by `aria-expanded` on the toggle (a SR announces the state on activation) — no extra live region needed for it. The existing `.sr-only` window-range live region is unchanged.
- **`aria-controls` lifecycle (reviewer should-fix):** because a collapsed card unmounts its body, `aria-controls` would point at a non-existent id. Resolve by either (a) setting `aria-controls` only while expanded and omitting it while collapsed, or (b) keeping the body in the DOM with the `hidden` attribute. `aria-expanded` alone is valid and sufficient; do NOT ship a dangling `aria-controls`.
- **Color is never the only signal:** collapse state is shown by the chevron orientation + `aria-expanded`, not color. Add/del stats keep their existing text signs (+/-).
- **Reduced motion:** chevron rotation must be instant (or honor `prefers-reduced-motion`); comprehension never depends on the rotation animation.
- **Focus management:** collapsing keeps focus on the toggle (body unmounts, header doesn't); the card stays pinned via `focusedPath`.

**i18n**
- Externalize all new strings; none hardcoded inline beyond the existing pattern in this file (codebase currently inlines English copy — match that, but keep strings plural-aware).
- **Pluralization:** "Show all {N} line/lines", "Show less", "{N} unchanged line/lines" (exists). The header count "{N} files changed" already pluralizes.
- **Text expansion:** "Collapse"/"Expand" + path can grow ~30%; the header already ellipsizes `.rcard__dir`; ensure the toggle doesn't clip the "Open file" button (it stays `margin-left:auto`-anchored at the row end).
- **RTL:** chevron direction must mirror in RTL (down/right semantics flip); reuse the shared `IconChevron` which other RTL-aware surfaces use.
- Locale formatting / sorting: N/A (no dates/user-text sorting introduced).

---

## 11. Design tokens (UI)

- **Reuse** existing card tokens: `.rcard`, `.rcard__head` (`--panel-2`, `--border`, `position:sticky`), `.rcard__path`/`__dir`/`__file`/`__stat`, `.rcard__open`, `.rcard__showrest`.
- **Chevron:** reuse the existing `IconChevron` and the `.rfold__chev` rotation pattern (`--chev` / transform). The collapse chevron should reuse the same chevron token/treatment so it reads as the same affordance family as the fold chevrons.
- **Toggle button:** must look like the header background, not a raised button — transparent background, no border, inherits `.rcard__head` styling; only the focus ring distinguishes it. No new color tokens needed.
- **"Show less":** reuse `.rcard__showrest` styling (it already reads as a full-width footer control); the label text is the only change.
- Theme variants: all derived from existing CSS variables, so light/dark/high-contrast follow automatically.

---

## 12. Assumptions

- The renderer already lifts per-card UI state into `CardUiState` cached per-path (`uiCacheRef`); `collapsed` follows that exact pattern (confirmed in `review-view.tsx`). 
- `planRowCap` already handles a single pure-add hunk correctly; only the cap **value** needs lowering (confirmed by reading `review-window.ts` + `computeFileReview` for `head=''`).
- The existing `ResizeObserver` on the card root already drives re-measurement on any height change, so collapse/expand needs no new measurement code — it only needs to actually mount/unmount the body.
- Initial state is expanded + capped (no auto-collapse), preserving today's default behavior.
- Collapse/cap state is session-only (in-memory), matching how folds + `showRemaining` already behave; no disk persistence, no new settings surface.
- English copy is inlined in this component today; matching that convention (with plural-aware strings) rather than introducing an i18n framework, which would be out of scope.
- Lowering the cap can only reduce rendered rows, so it does not regress the virtualization load-test e2e (which asserts mounted-card counts/window, not row totals).

---

## 13. Decisions Needed (autonomous mode)

- **[normal] D1 — Portion (cap) size.** Default taken: **300 rendered rows** (lowered from 2000). A larger value (e.g. 500) shows more before "Show all"; smaller (e.g. 150) is a tighter portion. Single constant, reversible.
- **[normal] D2 — Collapse/cap persistence scope.** Default taken: **session-only** (in-memory `uiCacheRef`), cleared on restart. Persisting per-path across restart would need a new settings surface (deferred to Vision).
- **[normal] D3 — Collapse-all / expand-all bulk control.** Default taken: **v1, not MVP.** Per-card collapse satisfies the literal ask; bulk toggle interacts with not-yet-mounted cards' height estimates and is better designed once per-card lands.
- **[normal] D4 — Defer diff fetch while collapsed.** Default taken: **v1; MVP keeps current fetch-on-mount.** A fully-collapsed scan currently still fetches windowed diffs; deferring is an optimization, not correctness.
- **[normal] D5 — Header click-target split.** Default taken: **toggle button wraps chevron+badge+path+stat; "Open file" is a separate sibling button.** Avoids nested `<button>`s and keeps "click the header collapses, click Open file opens" unambiguous.
- **[normal] D6 — Cap scope (all cards vs added-only).** Default taken: **all cards uniformly** via the existing `planRowCap` path (root-cause), not an added-file-only branch.

No `high`-severity decisions: every choice above is a renderer-local, reversible default that does not change data or the host contract.

---

## 14. Open questions

None blocking — autonomous mode; all materially-build-changing ambiguities are captured as Decisions Needed (§13) with conservative defaults.

---

## 15. Verification notes (for the builder)

- **Unit-testable pure pieces (Node, no DOM):**
  - `planRowCap([N], 300, false)` for a pure-add file of N rows → `shown=[300], remaining=N-300` when N>300; `remaining=0` when N≤300; and `expanded=true` → all rows. Add a regression test pinning the new default behaves for the "1000-line new file" case.
  - `emptyUi()` includes `collapsed:false`; collapse flag round-trips through the per-path cache (extract the cache read/write if it eases testing).
- **Runtime observation needs the REAL built app (e2e, not the mock preview):** collapse height, ResizeObserver re-measure, spacer/scroll-anchor correctness, and the windowed mounted-card list are all DOM/measurement behaviors. Add/extend a `test/e2e/*.e2e.mjs` scenario on the shared harness (`CONDUIT_E2E=1` hidden launch): seed a changeset with a large added file; assert (a) the added card renders a bounded portion + "Show all", (b) clicking the header collapses to header-only and `window.__conduitReviewPerf` window stays consistent, (c) clicking "Open file" does not collapse, (d) collapse survives scroll-out/in. The existing `__conduitReviewPerf` seam is the observation hook.
- `npm run verify` is the gate (typecheck across both tsconfigs, lint, tests, etc.).
- **Update stale code comments** when changing the cap: `MAX_CARD_ROWS` (review-view.tsx ~L44-45) and the `planRowCap` header (review-window.ts ~L84-87) cite "Decision D1/D2" from the *original* virtualization spec (`2026-06-27-review-virtualization.md`). After the value change, either keep those references pointing at the original spec or re-point them to this one — don't leave a comment whose "D2" silently means a different doc's decision.

---

## Self-audit

All template sections addressed. Core spine (§1–7) complete. UI module (§8–11) filled — state catalog, interaction inventory with the explicit click-target split, full a11y + i18n walk, design tokens (reuse-first). Edge cases (§4) cover focus-during-collapse, mid-load, binary/image, pure-add/del, huge modified, scroll-unmount, collapse-all estimate gap, source switch. Defaults (§5) each carry a rationale; decisions (§13) are all `normal` (none `high`). Right-sizing: this is genuinely FULL (multi-state card behavior × windowing interaction × a11y) — not padded; non-applicable state-catalog rows (offline/auth/not-found) are explicitly marked N/A with a one-line reason rather than invented.
