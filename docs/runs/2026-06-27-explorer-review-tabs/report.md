# Autonomous run report — 2026-06-27 explorer / review / tabs

**Conductor:** claude-opus-4-8 (in-session). **Subagents:** Opus only (Conduit memory
[[feedback-opus-only-subagents]]). **Mode:** delegated build, serial (all features touch
shared renderer entry files), conductor-owned architecture/taste + independent Phase-5
code review on every feature. **Base:** main @ `6a68a24` (v0.12.5). **Not released** —
merged to main per the run convention; release is the user's call.

## Outcome: 4/4 requested features shipped, verified, merged. 0 blocked. 0 needs-human-smoke.

The four wishlist items became 5 merged units (editor-tabs split into behavior +
persistence to keep diffs reviewable and isolate the durability risk). Every feature
landed with `npm run verify` EXIT 0 on the merged tree **and** a real-app
(Playwright-Electron) runtime proof — not unit-tests-only.

| # | Feature | Tier | Spec | Merge SHA | Runtime proof |
|---|---|---|---|---|---|
| 1 | Review Changes entry point → beside "View commit history" | LITE | review-changes-entry-point | `6b0b054` | `review-entry-point.e2e.mjs` PASS |
| 2 | Review Changes virtualization (windowed card list) | FULL | review-virtualization | `2211209` | `review-virtualize.e2e.mjs` PASS — 350 files → 12 mounted cards |
| 3 | Explorer Ctrl/Cmd + Shift multi/range select | FULL | explorer-multiselect | `041ce83` | `explorer-multiselect.e2e.mjs` PASS — selected-count assertions |
| 4a | VS Code preview/pin editor tabs (behavior) | FULL | editor-tab-behavior | `7c92d02` | `editor-preview-tabs.e2e.mjs` PASS |
| 4b | Editor tab persistence (restore across restart) | FULL | editor-tab-behavior | `7abca3a` | `editor-tabs-persist.e2e.mjs` PASS — real restart |

Final unit-test count: **1752 tests / 140 files** green. Each e2e was confirmed to
**discriminate** (fails when the feature is reverted/disabled), so the green is meaningful.

## What shipped (detail + evidence)

1. **Review entry point** (`6b0b054`). Moved the Review action out of the Changes-tab
   header into the git band beside the history button (`git-indicator-bar.tsx`); always
   visible + clickable, not gated on there being changes; the Review page keeps its
   "Nothing to review" empty state. Removed the old button + its dead `onReviewAll`
   thread + `.changes__review` CSS. Built inline by the conductor (tiny LITE).
   Evidence: `.autoloop/evidence/review-button.md`.

2. **Review virtualization** (`2211209`, feat `1669709` + conductor fix `4f85610`).
   New pure `webview/review-window.ts` `computeWindow` (windowed card list) + a
   ReviewView rewire: only viewport+overscan cards mount; per-path measured-height
   cache; scroll anchoring; fold/"Show remaining" state lifted so reveals survive
   unmount; per-card-on-mount diff fetch with a request-once guard; `MAX_CARD_ROWS`
   giant-file cap; dev/test `window.__conduitReviewPerf`. **Conductor simplified D1**
   (dropped the spec's concurrency-cap manager / priority queue / new error protocol —
   window size already bounds in-flight fetches). **Conductor code-review caught + fixed
   a real defect**: the window memo never recomputed on measurement (stale spacers,
   first-scroll jump) — fixed by computing the window inline.
   Evidence: `.autoloop/evidence/review-virtualize.md`.

3. **Explorer multi-select** (`041ce83`, feat `c551fce`). Pure
   `webview/file-tree-selection.ts` model (selectOne/toggle/selectRange/reconcile)
   replacing `selectedDir` entirely; Ctrl/Cmd toggle + Shift range over the flattened
   visible order; plain click reseats the anchor; modifier-clicks are selection-only;
   `aria-selected`/`aria-multiselectable`; left accent bar (non-color cue). Create-target
   now derives from the active item (file → parent dir, VS Code parity). `advanceReveal`
   no longer clears the selection — reveal stays a separate concept from selection
   (reveal-on-open preserved). MVP mouse-only; keyboard nav / bulk actions / multi-drag
   are v1. Evidence: `.autoloop/evidence/explorer-multiselect.md`.

4a. **Editor preview/pin tabs** (`7c92d02`, feat `41e2c02`). Generalized the existing
    commit-diff preview machinery to file docs: single-click = one reusable italic
    preview tab (replace-in-place, ≤1/session); double-click in explorer / double-click
    the tab / edit (dirty) / drag promotes to permanent; opening an already-pinned file
    focuses it (never downgrades); "Keep Open" tab-menu item (keyboard pin pathway);
    "(preview)" ARIA cue. Evidence: `.autoloop/evidence/editor-tabs-behavior.md`.

4b. **Editor tab persistence** (`7abca3a`, feat `6148be1` + conductor doc `1d03e52`).
    Net-new restore-across-restart: a sibling `docs.json` (isolated from sessions.json),
    written via the existing atomic-write helper **and** sync-flushed in the before-quit
    `flushStateSync` (durability parity, [[conduit-update-durability]]); one-shot
    `restoreDocs` consumed after sessions land; file-only; preview restored as preview;
    gated on `restoreSessions`. A startup guard prevents the empty initial docState from
    clobbering `docs.json` before restore seeds it. Proven with a **real restart** e2e
    (two launches sharing one user-data dir). Evidence:
    `.autoloop/evidence/editor-tabs-persist.md`.

## Decisions made during autonomy (the user could not be asked)

- **Scope:** persistence was treated as in-scope (the request said "behavior AND its
  persistence"). Deferred to a later slice: the enable-preview *setting* (default-on
  ships now), `diff`-doc preview, cross-kind preview unification, hot-exit dirty-buffer
  restore, explorer keyboard selection + bulk/multi-drag actions.
- **Ratified spec decisions:** review-virtualization D1 (simplified, see above) /D2/D3/D4;
  explorer D1 (create-target = active item) /D2/D3 (mouse-only MVP, bulk deferred) /D5
  (accent bar); editor-tabs D1–D7 (edit-promotes, restore-preview-as-preview, sibling
  docs.json, file-only restore, one-shot restoreDocs, one-preview-per-kind, OS-open =
  permanent). Full rationale in `.autoloop/blockers.md`.

## Known limitation (queued follow-up, NOT a blocker)

- **Multi-window tab restore:** persistence uses one global payload + one `docs.json`;
  each window's renderer sends only its own session docs, so with multiple windows the
  last `persistDocs` wins and only one window's tabs restore on restart. **Not a
  data-safety issue** — sessions.json is untouched and restore drops docs whose session a
  window doesn't own (no cross-contamination); single-window restore is perfect.
  Documented at the code site (`electron/main.ts` `lastDocs`). Fix = key `docs.json`
  per window. Found by the conductor's Phase-5 code review.

## Process notes

- **Independent Phase-5 verification mattered.** The conductor re-ran verify + e2e for
  every feature and read every diff. This caught a real memo-staleness defect in
  virtualization (fixed) and surfaced the multi-window persistence limitation (documented).
- **Baseline flakiness:** the initial baseline verify failed only because it ran
  concurrently with 3 git-hammering spec subagents; isolated re-run was 24/24 green
  ([[conduit-smoke-env-flakiness]]). Lesson applied: never run full verify under subagent
  load.
- **Transient `index.lock`** recurred once at merge time (explorer-multiselect); cleared
  with `git merge --abort` + retry. No content conflict (main was unmoved).
- **Docs:** 4 specs under `docs/specs/2026-06-27-*` (+ INDEX rows). Per ADR 0003 these
  are eligible to move to `docs/specs/archive/` now that they've shipped to main.

## Suggested next steps for the user

1. Smoke the four features in a normal session, then **release** when satisfied (the run
   did not release — `CHANGELOG.md` [Unreleased] should be updated as part of that).
2. Decide whether multi-window tab restore is worth the per-window-keyed `docs.json`
   follow-up.
3. Optional v1 polish: explorer keyboard selection + bulk actions; the enable-preview
   setting; `diff`-doc preview.
