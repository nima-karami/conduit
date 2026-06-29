# Autonomous run report — 2026-06-29 review-polish

**Conductor:** claude-opus-4-8 (in-session). **Subagents:** Opus only. **Mode:** delegated
build, serial (all touch `review-view.tsx`), conductor-owned architecture + **taste, reviewed
from screenshots** (the user explicitly flagged taste). **Base:** main @ `f03c342` (v0.14.0).
**Not released** at run end — merged to main; release is the user's call.

## Outcome: 4 Review-Changes polish items shipped as 2 features, verified (+ visual), merged. 0 blocked.

Driven by user taste feedback on the just-shipped commit-review. Two parallel specs (the user
asked for a full spec on the behavior items), two serial builds, each with `npm run verify`
EXIT 0, a real-app e2e, **and a screenshot the conductor read to judge taste**.

| Feature | Items | Tier | Spec | Merge SHA | Proof |
|---|---|---|---|---|---|
| Collapsible cards + bounded large-file portion | 3, 4 | FULL | review-card-collapse | `64f1432` | `review-card-collapse.e2e.mjs` PASS + screenshots |
| Searchable commit picker + icon-only commit-detail button | 1, 2 | FULL | review-commit-picker | `2cb3617` | `review-commit-picker.e2e.mjs` PASS + screenshots |

Final: **1811 tests / 143 files** green (only the pre-existing `.searchbox` warning).

## What shipped

1. **Collapsible Review cards** (`64f1432`). Each file card's header is now a toggle
   button (chevron + kind badge + path + stat); clicking it collapses the card to header-only
   for fast scanning; "Open file" stays a sibling (no nested buttons). `collapsed` lives in the
   per-path `CardUiState` cache (session-only, like folds) so it survives the virtualization
   unmount; the body unmounts on collapse so the existing ResizeObserver re-measures and the
   windowed spacers stay correct. `aria-expanded` + chevron convey state (not color).

2. **Bounded portion for large/added files** (`64f1432`). Lowered the per-card row cap
   `MAX_CARD_ROWS` 2000 → 300, applied uniformly through the existing `planRowCap` (root cause —
   a pure-add file is one all-add hunk and now caps cleanly; no added-file special case). A
   1000-line new file shows 300 rows + a two-way **"Show all 1000 lines" ⇄ "Show less"**.

3. **Icon-only commit-detail "Review changes" button** (`2cb3617`). Dropped the text label;
   it's now an icon-only, right-floated control styled identically to `.git-indicator__review`
   (the way the Review action has always looked) — minimal and clean, per the feedback.

4. **Searchable commit picker** (`2cb3617`). The Review header's source selector is now a real
   dropdown mirroring the branch switcher: a "Search commits…" input, a pinned "Working tree"
   row, recent commits (loaded via `git:history`, cap 150) shown as mono short-sha + subject +
   dim relative time, filter by sha-prefix/subject/author, a pasted-SHA "Review commit <sha>"
   row, a pinned "Current" row when the active commit is off-window, host-error+Retry, full
   keyboard a11y. Concise trigger label ("Working tree" / "<sha7> subject"); the trigger stays
   in the Review header (review-source state belongs to the review view, not the shared git band).

## Process notes — taste verified visually

- **The conductor read every UI screenshot before merge** (not just functional e2e), since the
  user rejected the prior taste. The picker (search input + commit rows mirroring the branch
  switcher) and the icon-only right-floated button both matched "minimal, clean."
- **Independent verify on both builds.** No new lint warnings slipped in this run (the single
  warning is the pre-existing `.searchbox` one, on main). Both e2es confirmed to fail when the
  feature is reverted.
- The `MAX_CARD_ROWS` change is root-cause (the constant via `planRowCap`), not a branch; the
  unmounted-card height estimate stays collapse-/cap-unaware by design — the re-measure corrects
  the transient spacer gap.

## Known follow-ups (queued, not blocking)

- **Collapse-all / expand-all** for the Review list (deferred to v1 — its interaction with
  not-yet-mounted cards' height estimates needs care). Would further help "scan quickly."
- Commit picker **paging / "load more"** beyond the 150-commit window (v1).
- Disk persistence of per-card collapsed state across restart (currently session-only).

## Suggested next steps for the user

1. Smoke the four changes, then **release** when satisfied (the `CHANGELOG.md` `[Unreleased]`
   section is populated; these are features → a `0.15.0` minor).
2. Decide whether collapse-all is worth a v1.
