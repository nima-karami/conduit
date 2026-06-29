# Autonomous run report — 2026-06-29 review-changes-polish-2

**Conductor:** claude-opus-4-8 (in-session). **Subagents:** none needed (built inline — the four
items are deeply intertwined in shared files: `review-view.tsx`, `center-pane.tsx`, the picker,
`styles.css`, `app.tsx`). **Mode:** in-session conductor, single serial lane. **Base:** main @
`749613d` (v0.15.0). **Branch:** `feat-review-polish`. **Not released** — merged to main; release
is the user's call.

## Outcome: 4 items shipped, verified (+ visual), 0 blocked. One real pre-existing bug fixed.

Built from the ratified, reviewer-hardened spec `docs/specs/2026-06-29-review-changes-polish.md`
(FULL; a fresh-eyes reviewer pass folded in before any code). Every task: `npm run verify` EXIT 0,
a real-app e2e on the shared harness, and — for the UI items — a SCREENSHOT the conductor read to
judge taste (the user is taste-sensitive on this feature).

| Item | What | Tier | Commit | Proof |
|---|---|---|---|---|
| 2 | Always-wrap diff lines (no h-scrollbar) | LITE | `2efaa28` | `review-card-collapse.e2e` (scrollWidth≤clientWidth) + screenshot |
| 3 | Compact ~40-row large-file portion | LITE | `2efaa28` | same e2e (40 rows + "Show all 1000 lines") + screenshot |
| 1 | Source picker → onto the git band | FULL | `e1ad37c` | `review-commit-picker` / `review-commit-source` / `terminal-commit-link` e2e + screenshot |
| 4 | Compare two refs (commit/branch/working) | FULL | `835b7a4` | `review-compare.e2e` + `git-range` unit tests + screenshot |

Final: `npm run verify` EXIT 0 on the merged tree (only the pre-existing `.searchbox` warning).

## What shipped

1. **Always-wrap diff lines** (item 2). `.rline__text` wraps (`pre-wrap` + `overflow-wrap:anywhere`);
   the gutter/sign pin to the first visual line. No per-line horizontal scrollbar; no toggle (the
   user's choice). CSS-only.

2. **Compact portion** (item 3). `MAX_CARD_ROWS` 300 → 40 via the existing `planRowCap`; a big/added
   file shows ~40 rows + a two-way "Show all N lines" ⇄ "Show less".

3. **Source picker on the git band** (item 1, reverses review-commit-picker D2). A new
   `ReviewSourceControl` renders in `center-gitband`, grouped with the folder/branch pickers (the
   History/Review icons stay pinned right), shown only while Review is the active tab; removed from
   the Review header. The band now renders for Review even with the indicator off (§A2).

4. **Compare two refs** (item 4). A new `range` Review source `{base, head}` where each endpoint is
   a commit/branch (and the target may be the working tree). New host `git:rangeDiff` IPC computes
   three-dot `A...B` for committish pairs (two-dot fallback with no merge-base), and a two-dot
   `ref ↔ working tree` for a working target; it validates both endpoints against the host's own
   ref set (enumerated local branches + `cat-file`) before diffing. `useRangeFiles` reuses the
   commit-mode "preloaded diffs" renderer path; the picker gained a push/pop **Compare builder**
   (Base/Target endpoint sub-pickers). Pure logic lives in `src/git-range.ts` (unit-tested).

## Bug found + fixed (pre-existing, from v0.15.0)

While writing the item-1 e2e, a real-click (not `force:true`) revealed the icon-only commit-detail
"Review changes" button (shipped v0.15.0) was positioned **under** the absolutely-positioned
`.gh__detail-close` button, which intercepted its clicks — opening Review from a commit's detail was
effectively dead. e2e isn't in CI verify, so it went uncaught. Fixed at the root by reserving the
close-button gutter on `.gh__detail-head` (commit `e1ad37c`).

## Process notes

- **Spec hardened before building:** a fresh-eyes reviewer subagent reviewed the FULL spec; its
  findings (empty-vs-error contract, working-tree as a target-only endpoint, required `requestId`
  with cache-hit re-stamping, local-branch list, sub-picker focus/Esc layering, empty-repo/binary
  edges, Retry) were folded in.
- **Taste verified visually:** the conductor read a screenshot of each UI change (wrap+portion, the
  band picker, the Compare builder) before merge.
- **Built inline, single lane:** the four items share `review-view.tsx`/`center-pane.tsx`/the
  picker/`styles.css`, so no fan-out; each committed separately with its own verify+e2e.

## Known follow-ups (not built)

- Two-/three-dot toggle + swap-endpoints button in the Compare builder (v1).
- Working tree as the **base** endpoint (needs patch inversion; target-only for now — D8).
- Untracked files in a ref↔working comparison (excluded for now — D8).
- Lazy per-file range diff for very large comparisons (preloads all files today, like commit mode).
- e2e is not gated in CI — consider adding the smoke suite to CI so a layout regression like the
  close-button overlap can't ship uncaught.

## Suggested next steps for the user

1. Smoke the four changes; **release** when satisfied — the `CHANGELOG.md` `[Unreleased]` section is
   populated (features → a `0.16.0` minor). Archive the spec (`git mv` to `docs/specs/archive/`) at
   release per ADR 0003.
2. Decide whether the Compare-builder v1 niceties (dot-mode toggle, swap, untracked) are worth it.
