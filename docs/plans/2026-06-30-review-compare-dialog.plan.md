# Plan: Review Changes — first-class Compare-refs dialog

Spec: `docs/specs/2026-06-30-review-compare-dialog.md` (FULL). Build to the spec + the
mandatory design-review corrections. Test-first per task.

## Task 1 — Pure ref model: tags + remote branches (`src/git-range.ts`)
- Extend `RefEndpoint`: `branch` gains `remote?: boolean`; add `{ kind: 'tag'; ref: string }`.
- `endpointKey`: add `case 'tag': return 't:${ref}'` (remote branch keeps `b:${ref}` — ref disambiguates `origin/main`).
- `endpointLabel`: `tag → ep.ref`.
- `dotModeFor`: tag/remote are committish (no code change needed; add tests).
- NEW pure `fullyQualifiedRef(ep)`: maps a branch/tag endpoint to its exact ref namespace
  (`refs/heads/` | `refs/remotes/` | `refs/tags/`), defensively returns `null` for a name
  starting with `-` or a non-committish kind. This is the validator's namespace mapper.
- Tests (`test/unit/git-range.test.ts`): tag/remote key/label/dotMode/rangeKey; `fullyQualifiedRef`
  valid tag/remote/local; `-name` → null; commit/working → null.

## Task 2 — Range engine tag case (`src/git-history.ts`)
- `refStr`: tag returns `ep.ref` (remote branch already returns `ep.ref`). No checkout (unchanged).

## Task 3 — Host ref enumeration (`src/git-info.ts`)
- Pure `parseRefList` (order-preserving, dedup) + `parseRemoteList` (drops `*/HEAD`).
- `listRemotes`/`listTags` (capped, newest-first for tags via `--sort=-creatordate`), `listRefs`
  → `{ branches, current, remotes, tags }` (`RefList`).
- Tests (`test/unit/git-info.test.ts`): real scratch repo — `listRefs` returns remotes/tags,
  excludes `origin/HEAD`; pure parse units.

## Task 4 — Host validation + IPC (`electron/main.ts`, `src/protocol.ts`)
- `git:refsResult` += `remotes`, `tags` (additive). `git:refs` handler → `listRefs`.
- `firstInvalidEndpoint`: drop the `branches` param; validate the SPECIFIC picked ref by EXACT
  existence (`git show-ref --verify --quiet <fully-qualified>`) via `fullyQualifiedRef`; commit
  via `validateCommits` (unchanged). Decoupled from the display cap.
- `git:rangeDiff` handler: stop pre-listing branches; call `firstInvalidEndpoint(cwd, [base,head])`.
- No new IPC error channel (renderer-side timeout handles enum failure).

## Task 5 — `IconCompare` (`webview/icons.tsx`)
- lucide `GitCompareArrows`, sized to match siblings (13).

## Task 6 — `CompareDialog` modal (`webview/components/compare-dialog.tsx`, NEW)
- Real focus-trapped modal (Tab/Shift-Tab cycle, Esc/backdrop cancel, focus returns to trigger
  via captured `activeElement`). Reuse `.modal__backdrop`/dialog shell.
- Two async comboboxes (Base, Target) — sectioned Branches · Remotes · Tags · Commits + pasted-SHA;
  ↑/↓ active, aria-activedescendant, Enter pick, clear (×). Target offers the working tree; Base
  does not (D8).
- Swap (disabled when Target = working). Live `base…head` preview + dot-mode hint. Compare enabled
  only when both set and non-identical. Enum loading/error (Retry) via `LOAD_TIMEOUT_MS`.
- All strings in a `STR` const.

## Task 7 — Replace the in-band builder (`commit-picker-menu.tsx`)
- Delete `CompareBuilder`/`SubHeader`/`pickBase`/`pickHead` + the view stack + endpoint sub-picker.
- Keep only the list view; the "Compare…" row calls a new `onOpenCompare` prop.

## Task 8 — Wire entry points (`center-pane.tsx`, `git-indicator-bar.tsx`, `review-source-control.tsx`)
- CenterPane owns `compareOpen`; renders `CompareDialog` (prefilled from the active review doc's
  source). Confirm → `onSetReviewSource`.
- Git band: `IconCompare` button beside History/Review (disabled+tooltip in empty/unborn; bar is
  null in non-git). `ReviewSourceControl`/`CommitPickerMenu` "Compare…" opens the same dialog.

## Task 9 — Styles (`webview/styles.css`)
- `.git-indicator__compare` (join the History/Review rule). `.compare-dialog` shell + fields +
  sectioned dropdown + swap + preview, all on existing tokens. Remove the now-dead in-band
  compare-builder CSS (keep `.commit-picker__compare-entry`).

## Task 10 — Label tests (`test/unit/review-commit.test.ts`)
- `conciseSourceLabel`/`reviewSourceLabel` for tag + remote endpoints.

## Task 11 — e2e (`test/e2e/review-compare.e2e.mjs`, WRITE only)
- Seed repo w/ branch, remote ref, tag, commits. Open dialog from the git-band icon AND the
  "Compare…" row; compare tag↔branch, remote↔local, pasted SHA; assert diff renders and
  `git rev-parse --abbrev-ref HEAD` unchanged; swap; identical→disabled/"No differences";
  unknown ref→error+Retry. DO NOT run.

## Gate
- `npm run verify` EXIT 0 in the worktree. Commit on `feat-review-compare-dialog`.
