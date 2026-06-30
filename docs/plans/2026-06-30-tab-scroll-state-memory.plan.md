# Plan: Per-tab scroll & view-state memory

Spec: docs/specs/2026-06-30-tab-scroll-state-memory.md (MVP scope).
Anti-duplication: no existing view-state/scroll-memory store. Only adjacent
seam is Review's per-instance `measuredRef` + `sourceKey` scroll-reset, and
`project-index.ts` reveal seam (reuse, don't duplicate).

## Architecture
- New renderer module `webview/view-state-store.ts`: module singleton
  `Map<docId, ViewState>` mirroring `dirty-store.ts`. `getViewState/setViewState/
  deleteViewState` + pure `clampScrollTop`. `ViewState` = discriminated union
  (`scroll` | `monaco` | `reviewAnchor`).
- Pure review-anchor math in `webview/review-window.ts`:
  `computeReviewAnchor` (scrollTop+heights → {topPath, offset}) and
  `resolveReviewAnchor` (anchor+heights → scrollTop). DOM-free, unit-testable.
- Reveal-wins: add `hasReveal(path)` peek to `project-index.ts` (no consume) so a
  viewer can skip restore when a reveal is staged.
- Eviction in `app.tsx`: `deleteViewState(doc.id)` beside every `clearDirty`
  (close paths) + per-session sweep in the closeSession effect.
- Capture cadence (D5): debounced ~120ms via existing `makeDebouncedFlush`
  (`use-debounced-flush.ts`) + synchronous direct capture in each viewer's unmount
  cleanup.

## Steps (test-first)

1. **Store + clamp** — `view-state-store.ts`. Unit: get/set/delete, overwrite,
   delete-missing no-op, clampScrollTop bounds. (`test/unit/view-state-store.test.ts`)
2. **Review anchor math** — add `computeReviewAnchor`/`resolveReviewAnchor` to
   `review-window.ts`. Unit: top-path+offset compute, fallback-to-top when path
   gone, offset clamp. (extend `test/unit/review-window.test.ts`)
3. **project-index `hasReveal`** — peek without consume. Unit: extend an existing
   project-index test if present, else cover via store/anchor (logic trivial).
4. **Monaco code editor** (`code-viewer.tsx`): after editor.create, if no reveal
   consumed → `restoreViewState(getViewState)`; capture debounced on
   `onDidScrollChange`/cursor + sync on unmount via `saveViewState`. Reveal path
   unchanged (already calls takeReveal first).
5. **Markdown** (`markdown-viewer.tsx`): `useLayoutEffect` restore of `.markdown`
   scrollTop unless `hasReveal(doc.path)`; debounced capture on scroll + unmount.
6. **Diff** (`diff-viewer.tsx`): capture/restore modified editor scrollTop
   (`onDidScrollChange`/`setScrollTop`), keyed `diff:${doc.path}`.
7. **Git-history** (`git-history-view.tsx`): restore `.gh__list` scrollTop once on
   ready phase; debounced capture in existing onScroll + unmount.
8. **Review** (`review-view.tsx`): capture anchor (debounced) on scroll; one-shot
   restore on ready gate (files+viewport known); delete saved on sourceKey change.
9. **Eviction wiring** (`app.tsx`).
10. **e2e** `test/e2e/tab-scroll-state.e2e.mjs` (write only).
11. `npm run verify` → EXIT 0; commit.

## Out of scope (deferred v1 → NOTES): image, pdf, commit-diff scroll,
PersistedDoc.scrollTop restart-persist. Reason: each carries extra reset/async
wiring (retarget reset, scale-first anchor, protocol+host docs.json) that does not
fall out cleanly; MVP ships the 5 required kinds solidly.
