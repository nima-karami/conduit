---
status: active
date: 2026-06-27
---

# Feature Spec: Review Changes — virtualized card list, monitoring & load testing

**Tier:** FULL   **Feature type:** UI
**One-line request:** "The performance of the Review Changes tab is important. We need to monitor and load test this. Maybe virtualize or do something. This part needs edge cases, rigorous unit testing, etc."

> Scope note: a prior run already fixed the per-arrival render cascade (React.memo per
> card + stable `useCallback` for `onRequestDiff`/`onJumpToHunk`, commit `90af757`). That
> layer is DONE. THIS spec is the next layer: the **outer list of cards is not windowed** —
> with hundreds/thousands of changed files every `ReviewFileCard` mounts at once
> (`files.map(...)` in `webview/components/review-view.tsx`), and the on-mount effect
> requests **every** file's diff (`for (const abs of absPaths) onRequestDiff(abs)`),
> streaming every file's full head/work text into the renderer's `diffs` Map.

---

## 1. Problem frame

- **Job:** When I open Review Changes on a large changeset (a big agent run, a generated
  refactor, a merge), the view should open instantly, scroll smoothly, and not balloon
  renderer memory — so I can actually review thousands of changed files / very large files
  without the tab freezing the app.
- **Actors / roles:** The human reviewing working-tree changes in the singleton Review tab
  (R5.5). No new actor; the host (`window.agentDeck`) is the diff source of truth.
- **Success outcomes (observable):**
  - Opening Review with N changed files mounts only the cards near the viewport, not all N
    (observable: count of `.rcard` DOM nodes ≪ N for large N).
  - Time-to-first-paint and scroll frame cost are flat (independent of N) for the list
    chrome; only on-screen cards do work.
  - Renderer does not eagerly hold N full file diffs in memory for N in the thousands.
  - Scroll position is preserved across diff arrivals and card re-measure (no jump).
- **Non-goals (explicitly out of scope):**
  - Rewriting the diff algorithm (`src/review-hunks.ts` `computeFileReview` stays as-is).
  - Replacing the plain-row renderer with Monaco editors (explicitly rejected — see the
    `review-view.tsx` header comment and `review-hunks.ts` rationale).
  - Editing/staging from Review (still read-only v1).
  - Changing host-side diff computation or git plumbing.
  - Changing the already-fixed per-card memoization layer.

## 2. Behavior & states

**Primary flow (happy path):**
1. User opens the Review tab. Header renders immediately with the file count
   (`N file(s) changed`) — this never waits on diffs.
2. The scroll body renders a **windowed** list: only the cards whose estimated/measured
   vertical span intersects the viewport (plus an overscan margin) are mounted; the rest
   are represented by top/bottom spacer height so the scrollbar reflects the full content.
3. As a card enters the window, the view requests its diff **on demand** (bounded
   concurrency, see §3 and Decision D1). The card shows the existing skeleton
   (`Loading diff…`) until its `FileDiffDTO` lands, then computes its hunk/fold tree
   (`computeFileReview`) and renders.
4. As a card scrolls out of the window, it unmounts; its measured height is **cached** so
   re-entry places it without re-estimating. A diff already in the `diffs` Map is reused
   (no re-request).
5. User scrolls/keyboards through the full changeset; the window slides; mounted-card count
   stays roughly constant regardless of N.

**States / transitions (outer list):**
- **Empty** — no changes → existing `EmptyState` ("Nothing to review"). No windowing.
- **Measuring / estimating** — a card's real height is unknown; it occupies an *estimated*
  height seeded from `change.added + change.removed` (known before the diff lands), replaced
  by the measured height once mounted.
- **Windowed-idle** — list rendered; only visible+overscan cards mounted.
- **Scrolling** — window range recomputed from `scrollTop`/viewport; spacers adjusted.
- **Re-measure** — a mounted card's height changes (diff arrives, fold expanded, image
  loads) → its cached height updates and the layout below it shifts; scroll position is
  anchored so the *currently-focused* card does not jump.

**Per-card states (unchanged, must be preserved by windowing):** loading skeleton, image
diff, binary notice, "No textual changes", populated hunks/folds, expandable folds.

## 3. Data / interface contract

No protocol/IPC message shape changes. The contract is the `ReviewView` props and an
internal windowing module.

**New pure module `webview/review-window.ts` (the unit-testable core):**

```ts
export interface WindowInput {
  count: number;            // total cards
  scrollTop: number;        // px
  viewportHeight: number;   // px
  overscanPx: number;       // extra px rendered above & below the viewport
  estimate: (index: number) => number;   // estimated height for an unmeasured card
  measured: ReadonlyMap<number, number>; // index -> measured height (cache)
}
export interface WindowResult {
  startIndex: number;   // first mounted card (inclusive)
  endIndex: number;     // last mounted card (inclusive); endIndex < startIndex ⇒ none
  padTop: number;       // spacer height before startIndex
  padBottom: number;    // spacer height after endIndex
  totalHeight: number;  // sum of all heights (drives scrollbar)
}
export function computeWindow(input: WindowInput): WindowResult;
```

- **Inputs (trust boundary):** all numeric, renderer-local (scroll metrics, measured DOM
  heights). No host data crosses here; nothing is persisted. `height(i) = measured.get(i) ?? estimate(i)`.
- **Outputs:** a contiguous mounted range + exact top/bottom spacer px so total scroll
  height equals Σ height(i) (scrollbar fidelity).
- **Invariants:**
  - `padTop + Σ(height[start..end]) + padBottom === totalHeight`.
  - `0 ≤ startIndex ≤ endIndex+1 ≤ count`.
  - Monotonic: increasing `scrollTop` never decreases `startIndex`.
  - Deterministic & pure (no DOM, no time) → fully testable in Node like `review-hunks.ts`.
- **Estimate seed:** `estimate(i)` derives from `files[i].added + files[i].removed`
  (rows of diff + card chrome), clamped to a sane min/max. Known *before* the diff lands,
  so the scrollbar is roughly right on first paint.

**Diff-fetch strategy (the load-bearing change — see Decision D1):** replace the
"request all on mount" effect with **on-demand fetch as a card enters the window + an
overscan prefetch budget**, with **bounded in-flight concurrency** (default cap, see §5)
so a 5,000-file changeset does not fire 5,000 `readDiff` IPC calls at once. A diff already
in `diffs` is never re-requested. The host streaming contract is unchanged: it still
replies `fileDiff` one at a time into the `diffs` Map.

- **Fetch priority within the cap:** when many cards enter the window at once (initial
  paint, fling), requests are ordered by **viewport proximity** — cards on screen first,
  then overscan — so a visible card is never starved behind overscan prefetch.
- **Failure / retry (no current error reply — see below):** the host has no explicit
  `readDiff` error reply today; a fetch that never lands leaves the card in skeleton. The
  feature must treat "requested but absent after a bounded wait, or an explicit failure" as
  a **diff-fetch error** state, NOT a permanent skeleton. The "already requested" guard is a
  set that is **cleared on failure** so re-entry (or a Retry action) re-requests; retries are
  bounded (e.g. ≤2 auto, then manual Retry). Implementation may add a minimal `fileDiffError`
  reply to the protocol OR a renderer-side timeout — pick the smaller change at build time;
  either way the *observable* contract is the error state + retry below.

**Per-card UI state survival across unmount:** windowing unmounts off-screen cards, so any
component-local state would reset on re-entry. Fold-expansion state (which folds are
expanded, top/bottom shown counts) and the "Show remaining" expanded flag must be **lifted
and cached by path** alongside the measured-height cache, so scrolling a card out and back
restores exactly what the user had revealed. (Without this, expanded diffs silently
collapse on scroll — a regression unique to windowing.)

## 4. Edge cases & failure modes

| Condition | Expected behavior / recovery |
|---|---|
| **Zero / one / many files** | 0 → EmptyState, no window. 1 → trivially rendered, window = whole list. Thousands → only visible+overscan mounted; mounted count ≈ constant. |
| **One enormous file** (single card with 10k–100k changed lines) | MVP: card still renders its full hunk list (inner lines NOT windowed in MVP) but is **capped** — render at most `MAX_CARD_ROWS` diff rows with a "Show remaining M lines" expander, so one pathological file can't lock the main thread. (Inner-line virtualization = v1, Decision D2.) |
| **Variable card height** | Heights measured via `ResizeObserver` on the mounted card root; cached per file *key* (path), not per index, so the cache survives list reorders. Unmeasured → estimate. |
| **Fold expand / image load grows a card** | Re-measure updates the cached height; layout below shifts; scroll anchored to keep the user's focused card stationary (no jump). |
| **Diff arrives for an off-window card** | Stored in `diffs`; no mount, no layout thrash. Its cached height (if any) updates only when remounted/measured. |
| **Diff fetch fails / never lands** | Card shows a **diff-fetch error** state (inline message + cause + Retry), not a permanent skeleton. The path is cleared from the "requested" set so Retry / re-entry re-requests. Auto-retry bounded (≤2), then manual only. |
| **Card unmounts then re-enters** | Fold-expansion + "Show remaining" state restored from the per-path cache (see §3); the card looks exactly as the user left it. |
| **Changes list itself fails to load** | Page-level: the Review body shows a page-level error/recovery state (this is upstream of windowing — the `changes` array is empty/errored), distinct from a per-card error. |
| **Scroll to bottom while heights are still estimates** | `totalHeight` shifts as estimates resolve to measurements; anchor on the top-most visible card so the content under the viewport stays put (avoid the classic "scrollbar creep"). |
| **Rapid scroll (fling)** | Window recompute is cheap (pure fn over indices); overscan absorbs gaps; transient skeletons acceptable. No per-pixel work beyond `computeWindow`. |
| **Concurrency / fetch storm** | In-flight `readDiff` capped (§5); as cards leave the window before their diff lands, their fetch is de-prioritized but not cancelled (host has no cancel; the reply is just cached). No double-request (guard by "already requested" set + presence in `diffs`). |
| **Active-repo / changes list changes under the view** | `files` recomputed (existing dedup by path); height cache keyed by path survives; cards for removed paths drop; window recomputes. |
| **Container resize / font-scale change** (`--font-scale`) | Viewport height changes → window recomputes; measured heights invalidated on font-scale change (row height is `calc(... * var(--font-scale))`) so stale measurements don't misplace cards. |
| **Window has zero height** (tab hidden / 0×0) | `computeWindow` returns empty range (mount nothing) until a real viewport height is observed; never divide-by-zero. |
| **Browser-preview fallback** (`window.agentDeck` absent) | No diffs ever arrive (fake shell); cards stay in skeleton; windowing still works (chrome + estimates). Must not throw. |

## 5. Defaults vs. settings

| Decision | Default | Configurable? | Rationale |
|---|---|---|---|
| Windowing always on | On for every changeset (single code path) | No | A second "small list" path would be untested; always-on is simpler and verifiable. |
| Overscan margin | ~1 viewport height above & below | No | Smooth fling without mounting the world; tunable constant, not a user setting. |
| In-flight diff fetch cap | 6 concurrent `readDiff` | No (constant) | Bounds host load on huge changesets; reversible constant, not a durable preference. |
| Diff fetch trigger | On-demand as card enters window + overscan prefetch (Decision D1) | No | Avoids streaming N full files into the renderer for N in the thousands. |
| Per-card row cap | `MAX_CARD_ROWS` (~2,000 rendered rows) then "Show remaining" | No | Stops one giant file from freezing the main thread (MVP guard for D2). |
| Height estimate seed | `added + removed` rows + chrome, clamped | No | Best pre-diff guess; refined by measurement. |
| Perf monitoring surface | Dev/test only (see §below); not shipped UI | No | Monitoring is a build/QA concern, not an end-user feature. |

**Monitoring (the "monitor" ask):** a dev-only instrumentation hook, gated (e.g. a
`CONDUIT_E2E`/dev flag, never in production render path), that exposes counters the load
test and a developer can read:
- `mountedCardCount` (live count of mounted `.rcard`),
- `requestedDiffCount` / `inFlightDiffCount` / `failedDiffCount`,
- last `computeWindow` range + `totalHeight`.
Exposed via a small `window.__conduitReviewPerf` debug object (guarded), readable from the
e2e harness. No always-on overlay; no telemetry leaves the machine.

## 6. Scope slicing

- **MVP (must):**
  - `webview/review-window.ts` pure `computeWindow` + estimate, with exhaustive unit tests.
  - `ReviewView` rewired to render a windowed card list (top/bottom spacers, measured-height
    cache keyed by path, `ResizeObserver` measure, scroll-anchored re-measure).
  - On-demand diff fetch with bounded concurrency replacing fetch-all (Decision D1).
  - Per-card row cap (`MAX_CARD_ROWS`) with "Show remaining" expander.
  - Dev/test perf counters (`window.__conduitReviewPerf`).
  - A load-test fixture + an e2e smoke scenario asserting mounted-card count ≪ N for large N.
- **v1 (should):**
  - Inner-line (hunk-row) virtualization for a single very large file (Decision D2).
  - Keyboard navigation between cards (jump next/prev changed file) that drives the window
    (scroll-into-view a card by index).
- **Vision (could):**
  - Sticky file header while scrolling within a tall card.
  - "Jump to file" mini-index / outline for the changeset.
- **Out of scope:** editing/staging, Monaco-per-file, host diff changes, persistence.

## 7. Acceptance criteria

### Measurable targets (the load test gates on these — tune during build)
- For a 2,000-file changeset, mounted `.rcard` count ≤ **K** (starting target ≤ ~40:
  viewport + overscan), independent of N.
- Time-to-first-paint of the Review chrome + first cards is **flat** vs N (does not grow
  with file count) — measured open-to-first-card under the load fixture.
- Steady-state scroll does not exceed a frame budget (target < ~16 ms per `computeWindow`
  + commit on the load fixture).
- Renderer does not retain all N `FileDiffDTO`s for large N (on-demand fetch ⇒ resident
  diff count bounded by what was scrolled through, not N).

### Declarative (baseline)
- Given a changeset of N files, the Review scroll body mounts only cards intersecting the
  viewport plus overscan; for large N the mounted `.rcard` count is bounded and ≪ N.
- The scrollbar's range reflects the full estimated content height; scrolling to the bottom
  reaches the last file.
- A diff is requested at most once per file and never re-requested once present in `diffs`.
- Expanding a fold or an image load does not make the currently-focused card jump.
- Empty changeset shows the existing EmptyState; single-file changeset renders normally.
- In the browser preview (no host) the view renders chrome + skeletons without throwing.

### EARS (behavioral/state)
- *Ubiquitous:* The Review view shall render the file-count header without waiting on any
  diff to arrive.
- *State-driven:* While a card is outside the window, the Review view shall not mount it and
  shall reserve its (estimated or cached-measured) height as spacer.
- *Event-driven:* When a card enters the window, the Review view shall request its diff only
  if it is not already present or in flight.
- *Event-driven:* When a mounted card's measured height changes, the Review view shall update
  its cached height and preserve the scroll position of the top-most visible card.
- *Unwanted:* If the number of in-flight diff requests reaches the concurrency cap, then the
  Review view shall defer further requests until one resolves.
- *Unwanted:* If a single file's diff exceeds `MAX_CARD_ROWS` rendered rows, then the card
  shall render the cap and offer a "Show remaining" expander instead of rendering all rows.
- *Unwanted:* If the viewport height is zero, then `computeWindow` shall return an empty
  mounted range and request no diffs.
- *Unwanted:* If a card's diff fetch fails or does not arrive within the bounded wait, then
  the card shall show a diff-fetch error with a Retry action and shall clear that path from
  the requested set so a retry re-requests it.
- *Event-driven:* When the requested diffs exceed the concurrency cap, the view shall issue
  them in viewport-proximity order (visible before overscan).

### Gherkin (key flows)
```gherkin
Feature: Virtualized Review Changes list

  Background:
    Given the Review tab is open

  Scenario: Large changeset mounts only visible cards
    Given a working tree with 2000 changed files
    When the Review view renders at the top of the list
    Then the number of mounted file cards is far fewer than 2000
    And the scrollable height corresponds to all 2000 files
    And only the visible (plus overscan) files have had their diff requested

  Scenario: Diff is fetched on demand and reused
    Given file "src/z.ts" is below the initial viewport
    When the user scrolls until "src/z.ts" enters the window
    Then its diff is requested exactly once
    And scrolling it out and back in does not request it again

  Scenario: Expanding content does not jump the view
    Given a card with a collapsed fold is visible
    When the user expands the fold and the card grows
    Then the file the user was looking at stays under the viewport
```

### Unit-test obligations (`test/unit/review-window.test.ts`)
- `computeWindow` zero/one/many; empty (count 0 → empty range, padTop=padBottom=totalHeight=0).
- Spacer invariant `padTop + visibleSum + padBottom === totalHeight` across random inputs.
- Mixed measured/estimated heights resolve to correct range and spacers.
- Monotonicity: increasing `scrollTop` never decreases `startIndex`.
- Overscan widens the range symmetrically and clamps at list ends.
- viewportHeight = 0 → empty range. scrollTop beyond content → last card(s) only.

---

## 8. State catalog (UI)

| Component | State | What the user sees | Action / CTA |
|---|---|---|---|
| Review scroll body | Empty | EmptyState "Nothing to review" | — |
| Review scroll body | Populated/windowed | Cards near viewport; spacers elsewhere; full-length scrollbar | Scroll |
| Review header | Always | "N file(s) changed" (renders before diffs) | — |
| File card | Loading | Existing `Loading diff…` skeleton | wait |
| File card | Populated | Hunks + expandable folds | Open file / jump to hunk / expand fold |
| File card | Binary | "Binary file — no diff preview." | Open file |
| File card | Image | `ImageDiff` | Open file |
| File card | No textual changes | "No textual changes." | Open file |
| File card | Capped (huge file) | First `MAX_CARD_ROWS` rows + "Show remaining M lines" | Expand remaining |
| File card | Diff-fetch error (component-level) | Inline "Couldn't load this diff" + cause + Retry | Retry |
| Review body | Changes load error (page-level) | Page-level error + recovery path (upstream of windowing) | Retry / reopen |
| Off-window card | Not mounted | Reserved space only (no content); restores expanded state on re-entry | scroll into view |

## 9. Interaction inventory (UI)

| Component | Actions | Pointer | Keyboard | Touch | Context menu | ARIA role/states |
|---|---|---|---|---|---|---|
| Scroll body | Scroll/window | Wheel/drag scrollbar | Arrow/PageUp/PageDown/Home/End scroll the container; Esc closes Review (existing `useEscapeKey`) | Swipe scroll | — | scroll region; `aria-busy` while diffs in flight |
| File card | Open file | Click "Open file" | Tab to it, Enter/Space | Tap | (existing) | `section` with `aria-label="Changes in <path>"` (unchanged) |
| Hunk jump | Jump to hunk | Click "@ line N" | Tab + Enter | Tap | — | button (unchanged) |
| Fold expander | Show above/below/all | Click chevrons / count | Tab + Enter/Space | Tap | — | buttons with existing `aria-label` (unchanged) |
| "Show remaining" (new) | Reveal capped rows | Click | Tab + Enter/Space | Tap | — | button, accessible name "Show remaining M lines" |
| Retry (new, error card) | Re-request failed diff | Click | Tab + Enter/Space | Tap | — | button, accessible name "Retry loading diff"; error announced via `aria-live` |

Rules honored: every action has a keyboard path (no drag in this feature); focus visible;
no color-only signal (diff add/del already pair sign `+/-` with color).

## 10. Accessibility & i18n (UI)

**Accessibility (WCAG 2.2):**
- **Windowing must not break keyboarding / SR reading order:** unmounted cards are invisible
  to AT, which is acceptable *only if* keyboard navigation can bring any card into the window
  (the v1 "next/prev changed file" jump, and native container scroll keys, satisfy this).
  Flag: SR users can't Tab through unmounted cards — mitigated by scroll-into-view nav, but
  this is a real trade-off (Decision D3).
- **Announce dynamic outcome:** the scroll region carries `aria-busy="true"` while diffs are
  in flight and an `aria-live="polite"` status announces e.g. "Showing files X–Y of N" on
  large window jumps so SR users aren't lost. (Microcopy externalized.)
- **Visible focus** preserved on all existing controls; the "Show remaining" button must have
  a visible focus ring that survives forced-colors mode.
- **Focus management on re-measure:** when a fold expands, focus must remain on the expander
  (don't let re-layout/unmount steal focus). A card must never unmount *while it contains the
  focused element* — pin a card in the window as long as it holds focus (Decision D3 detail).
- **Reduced motion:** windowing must not introduce scroll animations that defeat
  `prefers-reduced-motion`; spacer height changes are instantaneous, not animated.
- **Color never the only signal:** unchanged (already true via `+/-` signs).

**Internationalization:**
- Externalize all new strings: "Show remaining {count} lines", "Showing files {start}–{end}
  of {total}". No hardcoded copy in the component (match repo convention — note: the codebase
  currently inlines English; follow the *existing* pattern but keep new strings centralized
  enough to localize, and **plural-aware** for counts).
- **Pluralization:** "file(s)", "line(s)", "Show remaining N line(s)" use plural-aware form
  (the existing header already branches on `=== 1`).
- **Number formatting:** large file/line counts formatted locale-aware.
- **RTL:** the diff gutter/sign layout is inherently LTR for code; the card chrome and
  status text should mirror under RTL, but diff line content stays LTR. (Decision-free: code
  is LTR by nature; only chrome mirrors.)
- **Text expansion:** "Showing files X–Y of N" and "Show remaining" must tolerate ~30%+
  longer translations without clipping the card header.

## 11. Design tokens (UI)

No new visual language — reuse existing Review tokens. Semantic roles only (no hex):
- Spacers are transparent/zero-chrome (pure height); they use **no** background so they're
  invisible — must not paint over `var(--panel)` cards.
- "Show remaining" expander reuses the fold-bar role (`--text-dim` label on `--panel`,
  border `--border`) — same affordance language as `.rfold__count`.
- `aria-live` status text uses `--text-dim` (advisory), matching `.review__sub`.
- Respect `--font-scale` (row heights are scale-derived → measurement cache invalidates on
  scale change).
- Theme variants: inherits existing light/dark/high-contrast tokens; nothing new to theme.

---

## 12. Assumptions

- The renderer already holds the full `changes` list (file count) cheaply; only *diffs* are
  heavy. So windowing targets diff fetch + card mount, not the file list itself. (Confirmed
  in `review-view.tsx` / `app.tsx`.)
- Heights are cached by **path** (stable key), not list index, so re-scan/reorder of
  `changes` doesn't corrupt the cache. (`files` dedups by path already.)
- The host has **no diff-cancel** message; an out-of-window in-flight request simply
  resolves into the `diffs` cache. We do not add a cancel to the protocol (avoids a
  cross-cutting IPC change).
- No virtualization dependency will be added — `package.json` has none suitable; a small
  pure `computeWindow` matches the repo's minimal-deps posture (ADR 0001 dependency posture).
- Monitoring is dev/test-only via a guarded `window.__conduitReviewPerf`; not a shipped
  surface. (Matches "monitor and load test" as a QA concern.)
- Load testing is done via a generated large-changeset fixture driven through the e2e smoke
  harness (`test/e2e/`, `CONDUIT_E2E=1` hidden launch) plus pure unit tests for the math.
- `MAX_CARD_ROWS`, overscan px, and concurrency cap are tunable constants chosen during
  implementation against the load test; the values in §5 are starting points.

## 13. Decisions Needed (autonomous mode)

- **[high] D1 — Diff fetch: on-demand vs keep prefetch-all.** Default taken:
  **on-demand as cards enter the window + overscan prefetch, bounded concurrency (cap 6)**,
  replacing the current fetch-all-on-mount. Rationale: prefetch-all streams N full file
  texts into the renderer and fires N `readDiff` IPC for N in the thousands — exactly the
  load the request flags. Reversible (revert to fetch-all is trivial) but it changes
  host IPC/load behavior and the streaming feel (cards below the fold now fetch lazily), so
  flagged high for a human to confirm the UX trade-off (slight scroll-then-load vs. eager).
- **[high] D2 — Inner-line virtualization scope.** Default taken: **MVP windows the card
  list only**; a single very large file is guarded by a `MAX_CARD_ROWS` cap + "Show
  remaining", with true hunk-row virtualization deferred to v1. Rationale: card-list
  windowing covers the "thousands of files" case; one-giant-file is rarer and the cap
  prevents a freeze. Flagged high because a changeset that is *one* 100k-line file is still
  a real edge the cap only blunts, not solves.
- **[normal] D3 — Accessibility trade-off of unmounting cards.** Default taken: unmounted
  cards are not in the AT tree; mitigated by (a) never unmounting a card that contains the
  focused element, (b) `aria-live` "Showing files X–Y of N", and (c) v1 keyboard
  next/prev-file jump. A fully AT-complete alternative (render-all for SR) is rejected as it
  defeats the perf goal. Flagged normal — acceptable but worth a human nod.
- **[normal] D4 — Always-on vs threshold windowing.** Default taken: **always on** (single
  code path). A threshold (`virtualize only if N > k`) would create an untested small-list
  path. Reversible.

## 14. Open questions

(Interactive only — none pending in autonomous mode; the above are flagged in §13.)

---

## Self-audit

All template sections addressed. UI module (§8–§11) fully filled, not skipped. Core spine
(§1–§7) complete with EARS + Gherkin + explicit unit-test obligations (FULL tier). Edge
cases cover zero/one/many, the single-huge-file pathological case, concurrency/fetch storm,
re-measure scroll anchoring, font-scale invalidation, zero-viewport, and the no-host
preview. Decisions Needed isolates the two high-impact calls (D1 prefetch strategy, D2
inner-line scope). No section left thin without justification.

**Reviewer subagent:** dispatched a fresh general-purpose reviewer with read-only tools
against the template/checklist (see final handoff). Revisions from that pass folded in
before finalizing.
