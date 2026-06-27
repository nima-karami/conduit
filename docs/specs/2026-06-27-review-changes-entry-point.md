---
status: active
date: 2026-06-27
---

# Feature Spec: Review Changes entry point — move next to "View commit history"

**Tier:** LITE   **Feature type:** UI
**Request:** "Move the Review Changes button from 'Changes' tab and place it next to
'View commit history' button. It should be always visible and even clickable. But if
there are no changes, the Review Changes page should elegantly say there is no changes
there."

## Problem frame

- **Job:** Reach the whole-changeset Review view from anywhere, not only after switching
  the sidebar to the Changes tab — the same place I already go for commit history.
- **Today:** the Review action (`IconReview` button, prop `onReviewAll`) lives in the
  Changes-tab header (`right-pane.tsx` ~236), so it's only reachable on that tab. "View
  commit history" lives in the git band (`git-indicator-bar.tsx` ~201, `onOpenHistory`),
  rendered in `center-pane.tsx` (152-167).
- **Non-goals:** redesigning the git band; changing what Review shows; adding a setting.

## Behavior

1. A **Review changes** icon button renders in the git band immediately to the right of
   (i.e. next to) the "View commit history" button, inside `GitIndicatorBar`.
2. It is **always visible** whenever the git band shows (it is not gated on there being
   any working-tree changes) and **always clickable** (never disabled).
3. Clicking it opens the singleton Review tab (`openReviewTab`) — same action the old
   Changes-tab button invoked.
4. When the working tree is clean, the Review page shows its existing graceful empty state
   ("Nothing to review", `review-view.tsx` 80-86). No change needed there — just verify it.
5. The old Review button is **removed** from the Changes-tab header (it moved, not copied).

## States

- Git band hidden (no repo / `git.kind === 'none'` / indicator setting off) → no Review
  button (it shares the band's fate, like the history button). Assumption A1.
- Git band shown, tree clean → button visible+clickable; click → Review tab empty state.
- Git band shown, tree dirty → button visible+clickable; click → Review tab with cards.

## Defaults vs settings

No new setting. Button placement is fixed (next to history). The button shares the git
band's existing visibility gate (`showGitBand && indicatorOn`).

## Acceptance criteria

- Review button appears next to "View commit history" in the git band; it is present even
  when there are zero changes, and is not disabled.
- Clicking it opens the Review tab; with a clean tree the Review tab shows the "Nothing to
  review" empty state.
- The Changes-tab header no longer shows its own Review button (moved, not duplicated).
- The whole `npm run verify` gate stays green; existing Changes-list behavior unchanged.
- a11y: the button has an accessible name ("Review changes") + title + visible focus ring,
  matching the adjacent history button's pattern.

## Assumptions

- **A1:** The Review button lives inside `GitIndicatorBar` next to the history button, so it
  inherits the band's visibility gate (hidden when there is no git or the git-indicator
  setting is off). This is faithful to "next to View commit history" (history has the same
  gate). Reversible if a future ask wants Review visible without git.
- Command-palette "Review all changes" entry (`cmd:review`) and the `openReview` shortcut
  are unaffected — they remain alternative entry points.
- Empty state already exists; this feature only relocates the entry point.

## Self-audit

LITE core spine complete; UI surface is a single relocated icon button reusing an existing
action + existing empty state. No persistence, no IPC, no data contract change.
