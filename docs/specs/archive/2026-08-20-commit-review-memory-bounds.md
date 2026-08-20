---
status: shipped
date: 2026-08-20
---

# Commit review memory bounds

## Why

A user clicked a commit-hash link in the terminal on a large monorepo commit. The
Review tab showed "Loading commit changes…", then the renderer OOM'd and Electron
painted a black window. Root cause chain (2026-08-20 diagnosis, verified in code):

1. `commitChangesFromFiles` (webview/review-commit.ts) synchronously runs
   `computeFileReview` over **every file in the commit** — purely to count `+N −N`
   for the card badges — before a single card mounts.
2. `diffLines` (src/review-hunks.ts) allocates a dense `(n+1)×(m+1)` LCS matrix.
   ~20k lines/side ≈ 3 GB; a 1.5 MB lockfile ≈ 13 GB. The 2 MB per-side
   `MAX_FILE_BYTES` host cap is nowhere near sufficient (2 MB ≈ 50k lines).
3. The same unbounded `computeFileReview` runs again per mounted card, and
   `computeReplacementEmphasis` walks full hunks.
4. Review virtualization and `MAX_CARD_ROWS` gate *rendering* only — both sit
   downstream of the eager whole-changeset *parse*, so they never engage.

Secondary defects fixed alongside:
- `useCommitFiles` has no error channel (its range sibling does), so any host-side
  failure — including the session-miss silent `break` in `electron/main.ts`'s
  `git:commitDiff` case — strands "Loading commit changes…" forever.
- `getCommitDiff` runs `diff-tree -M` under the 4 s `DEFAULT_TIMEOUT_MS`; a big
  commit times out and masquerades as "No changes in this commit".

## Contract

1. **`diffLines` never allocates past a cell budget.**
   - First, common **prefix/suffix line trimming** (O(n+m)): the dominant real case
     (huge generated file, few changed lines) reduces to a tiny core that diffs
     exactly. Trimmed lines re-enter the op list as context with correct line
     numbers.
   - If the remaining core still exceeds `MAX_LCS_CELLS = 4_000_000` cells
     (~32 MB — same philosophy as `WORD_DIFF_MAX`), emit a **degenerate
     replacement** for the core (all dels, then all adds; no LCS) and mark the
     result `approx: true` on `FileReview`. Memory is O(n+m) always.
   - `added`/`removed` counts stay truthful under both branches (they count real
     add/del ops).
2. **`approx` is surfaced, not hidden.** A card whose review is approximate shows a
   notice (styled like the existing `oversize` notice): the file changed too much
   to line-match; shown as whole-file replacement. `computeReplacementEmphasis` is
   skipped for approx reviews and for hunks over `EMPHASIS_MAX_LINES = 4000` lines
   (a degenerate core is one giant del-run/add-run; per-pair word-diff over it is
   seconds of main-thread work for zero signal).
3. **Badges come from the host, not a renderer parse.** `getCommitDiff` runs one
   additional bounded `diff-tree -M -r --no-commit-id --numstat -z` and joins by
   path; `FileDiffDTO` gains optional `counts?: { added: number; removed: number }`
   (absent for binary/image sides, which `--numstat` reports as `-`).
   `commitChangesFromFiles` prefers `counts` and only falls back to the (now
   bounded) compute when absent. The commit path therefore does **no**
   whole-changeset parse on arrival.
4. **`useCommitFiles` mirrors `useRangeFiles`'s error channel** — `status: 'error'`,
   `requestId` latest-wins, a `retryCommitDiff`, and an error `EmptyState` with
   Retry in the Review pane. The host replies with `error` on session-miss and on
   `getCommitDiff` failure (`MultiFileDiff` gains `error?: string` on its failure
   paths, distinct from a legitimately empty commit).
5. **`getCommitDiff` runs under `GIT_TIMEOUT.diff` (10 s)**, not the 4 s default.

Out of scope, deliberate: the range path keeps computing badge counts in the
renderer — bounded by (1), correctness unchanged; migrating it to `--numstat` is a
follow-up. Streaming/chunking the commit-diff IPC payload is a follow-up (item 3
caps the practical damage; the payload itself remains file-count-capped only).

## Verification

Unit: budget/trim/approx behavior in review-hunks; numstat parse + join;
counts-preferred badge derivation; error-channel reducer behavior. E2E (real app):
a seeded repo with (a) a ~15k-line generated file with a small mid-file edit —
renders exact hunks fast; (b) two unrelated ~8k-line versions — renders the approx
notice; badges correct from numstat; renderer alive throughout. The pre-fix build
fails the responsiveness leg.
