# Autonomous run report — 2026-06-29 commit-review

**Conductor:** claude-opus-4-8 (in-session). **Subagents:** Opus only
([[feedback-opus-only-subagents]]). **Mode:** delegated build, serial (shared git/review
surfaces), conductor-owned architecture/taste + independent Phase-5 code review on every
feature. **Base:** main @ `1b8e2b2` (v0.13.0). **Not released** — merged to main; release is
the user's call.

## Outcome: 4 requested asks shipped as 3 features, verified, merged. 0 blocked. 0 needs-human-smoke.

The four wishlist items collapsed into three tasks (items 2+4 are one feature — a
commit-scoped Review tab; item 3 is the terminal link into it). Every feature landed with
`npm run verify` EXIT 0 on the merged tree **and** a real-app (Playwright-Electron) runtime
proof, each confirmed to fail when the feature is reverted.

| # | Feature | Tier | Spec | Merge SHA | Runtime proof |
|---|---|---|---|---|---|
| 1 | Commit-detail pane remembers its height | LITE | commit-detail-resize-persistence | `b2be929` | `commit-detail-resize.e2e.mjs` PASS — cross-restart |
| 2 | Review tab can scope to a commit (source selector + commit-detail button) | FULL | review-commit-source | `fb9b6c6` | `review-commit-source.e2e.mjs` PASS |
| 3 | Clickable terminal commit hash → Review | FULL | terminal-commit-link | `c71f5a6` | `terminal-commit-link.e2e.mjs` PASS — real git validation |

Final unit-test count: **1795 tests / 143 files** green (only the pre-existing `.searchbox`
biome warning, which is on main).

## What shipped (detail + evidence)

1. **Commit-detail pane height persists** (`b2be929`). The History tab's resizable
   commit-detail pane (`detailH`) was component-local `useState(300)` and reset on every
   remount. Now persisted durably via `historyDetailHeight` on AppSettings — a faithful clone
   of the existing `leftWidth`/`rightWidth` panel-dimension prefs (seed-on-mount, persist on
   drag-end + keyboard step, survives tab close/reopen and restart). The subagent also added a
   missing render-time `clampDetailH` the spec had assumed existed (root-cause fix, not a
   band-aid). Evidence: `.autoloop/evidence/commit-detail-resize.md`.

2. **Review tab can review a specific commit** (`fb9b6c6`). The singleton Review tab gained a
   switchable **source** (working-tree default | a commit SHA), carried as `reviewSource` on
   the review doc in docState (stable `REVIEW_DOC_ID`, working = canonically absent), set via a
   new `openReview` reducer action. Commit mode reuses the existing `useCommitFiles` loader,
   deriving the card list + diff map (`commitChangesFromFiles`) that feed the **same virtualized
   renderer** built last run — diffs are preloaded so the per-card-on-mount fetch is a no-op. A
   git-breadcrumb source selector at the top of the Review view switches working ⇄ commit; a
   **"Review changes" button on the commit detail** opens the tab scoped to that commit. App-level
   `openReviewForCommit(sha, sessionId?, subject?)` is the shared entry point (also used by #3).
   MVP = working ⇄ current-commit; a recent-commits dropdown + pasted-SHA entry are v1.
   Evidence: `.autoloop/evidence/review-commit-source.md`.

3. **Terminal commit hashes are clickable → Review** (`c71f5a6`). A word-bounded lowercase
   `[0-9a-f]{7,40}` run in terminal output becomes a link that opens that commit in the Review
   tab. Detection is heuristic (regex with lookbehind/lookahead rejecting `#`/`0x`/path
   segments/`.ext`, per-line cap 32); **host validation is the real gate** — the host
   re-asserts the hex class and confirms each candidate is a real commit object via one batched
   `git cat-file --batch-check` with tokens fed on **stdin** (never interpolated into args/shell),
   TTL-cached, scoped to the clicked session's active repo, mirroring the `git:switch`
   validate-against-host pattern. Path links win precedence. Click routes the full 40-char sha
   into `openReviewForCommit`. Evidence: `.autoloop/evidence/terminal-commit-link.md`.

## Decisions made during autonomy

- **Unifying architecture (mine):** ONE Review tab with a switchable source, reused by both the
  commit-detail button and the terminal link — matching the user's "commit hash selector within
  its git breadcrumb" framing and reusing the existing commit-files loader + last run's
  virtualization. No separate review tab per commit.
- **Ratified spec decisions:** resize persistence durable-via-settings; review-commit source
  rides docState (working = absent), MVP working⇄current-commit (dropdown/pasted-SHA = v1),
  source resets on Review close/reopen, bad/empty sha → empty state; terminal detection
  validate-on-detect + host-gate, path-wins precedence, full-sha routing.

## Process notes — independent verification earned its keep again

- On **T3**, the subagent reported a clean verify + passing e2e, but my independent re-run
  caught **two real issues its report missed**: (a) two NEW biome warnings
  (`useLiteralKeys`/`useOptionalChain`) in the e2e file, and (b) the e2e's activation step
  flaked under machine load ("sha not in buffer" — a single non-retrying buffer scan right
  after a poll had confirmed the line present). I fixed both (added a retry that only swallows
  the transient; manual lint fixes), re-verified to the pre-existing-warning baseline, and the
  e2e is now retry-robust (commit `e649076`). The production code was correct and its security
  model is excellent — the defects were entirely in the test.
- **T2** code-review: clean (one minor note — commit line-counts recompute all files once per
  load; acceptable, a `numstat` optimization is a future option).
- **Smoke flakiness** ([[conduit-smoke-env-flakiness]]) recurred: e2es time out / miss when run
  immediately after a full `verify` (loaded machine); each passed when run alone. Don't trust a
  single loaded-machine smoke failure.
- **Shared-worktree discipline:** the conductor and each build subagent share one working tree,
  so all git ops (review/verify/merge) were held until no subagent was running.

## Known follow-ups (queued, not blocking)

- Review source selector: recent-commits **dropdown** + **pasted-SHA** entry (v1; MVP only
  switches working ⇄ the commit set by the button/link).
- Review merge-commit note not surfaced in the Review header (FileDiffDTO carries no parent
  info); the History/CommitView merge note is unaffected.
- `commitChangesFromFiles` recomputes diffs for line counts — a `git numstat` source would
  avoid it for very large commits.

## Suggested next steps for the user

1. Smoke the three features, then **release** when satisfied (the run did not release; the
   `CHANGELOG.md` `[Unreleased]` section is populated for that).
2. Decide whether the recent-commits dropdown / pasted-SHA selector is worth a v1.
