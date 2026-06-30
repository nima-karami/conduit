# Run report — Explorer drag-and-drop & rename polish

**Date:** 2026-06-29
**Spec:** `docs/specs/archive/2026-06-29-explorer-dnd-rename-polish.md` (FULL, reviewer-hardened)
**Released:** v0.17.0
**Branch:** `feat-explorer-dnd-polish` → merged to `main` (no-ff), branch deleted.

## What shipped

Six asks, all built:

1. **Precise single-row drop highlight (the headline bug).** The drop highlight was keyed on the
   *effective drop directory* (`dropDirFor`), so every row sharing that dir — the folder **and all
   its children** — matched and lit up at once ("highlights the entire directory"). Fixed at root:
   the renderer now tracks a single `dropTargetPath` and a row highlights only when
   `node.kind === 'dir' && dropTargetPath === node.path`. Hovering a file targets its parent
   folder; the root container highlights for root-level drops.
2. **Spring-loaded folders.** 600 ms hover over a collapsed folder during a drag expands it; folders
   opened by the drag re-collapse on `dragend` if not dropped into.
3. **Multi-selection drag.** Grabbing a selected row drags the whole selection (`topLevelPaths`
   de-dupes a folder + its own descendant).
4. **Conflict dialog.** New `ConflictDialog` (Replace / Keep both / Cancel + "apply to all
   remaining"). Host `fsMove`/`fsCopy`/`fsImport` gained an `onConflict` policy
   (`error`/`replace`/`rename`) and a discriminable `code:'EEXIST'`; the renderer drives every
   multi-item drop/import as **N single-item ops** with per-item resolution and stop-and-report on a
   non-conflict failure. An in-flight flag blocks double-submit.
5. **F2 + full keyboard nav + cut/copy/paste.** `role="tree"` + roving tabindex; arrows / Home /
   End / Enter / Delete / Esc / F2; Ctrl+X/C/V (in-app path clipboard) + context-menu Cut/Copy/Paste
   — the accessible drag-alternative (WCAG 2.5.7). `aria-live` announces move/copy/rename/skip.
6. **Stem-only rename selection.** `renameSelectionRange` selects the filename stem (extension
   preserved) for files with an extension; whole name for folders/dotfiles.

Plus root-cause fixes surfaced while building: **Windows case-only rename** (`Foo.ts`→`foo.ts`) via a
two-step temp rename in `fs-mutations.rename`, and **reserved/invalid-name validation** extended in
`validateName`.

## Architecture

- Pure, browser-safe logic isolated + unit-tested: `renameSelectionRange`, `nextVisiblePath`,
  `validateName` (extended), `parentDir` (exported) in `webview/file-tree.ts`; `topLevelPaths` in
  `src/drop-intent.ts`; `selectMany` in `webview/file-tree-selection.ts`.
- Host contract change is additive and back-compatible (`onConflict` defaults to `'error'`, which is
  the prior refuse behavior; existing callers/tests unchanged).
- No new dependencies. The drop highlight reuses the existing `.filerow--droptarget` CSS — the fix is
  *which* rows get the class, not the styling.

## Verification

- **Unit:** 1844 → 1861 tests green (added `test/unit/explorer-keys.test.ts` (17) + host policy /
  case-rename cases). `npm run verify` exit 0 on the branch **and on the merged tree**.
- **e2e (real app):** `test/e2e/explorer-dnd-polish.e2e.mjs` PASS (10.9s) — conflict policy
  (EEXIST / replace / keep-both) via `window.agentDeck.fsMove`, case-only rename via `fsMutate`, and
  **F2 stem-selection in the real DOM** (asserts `selectionEnd === 'component'.length`).

## Lessons

- **Teardown, not the test, hung the first two e2e runs.** All five assertions passed but the runner
  TIMED OUT at 210s: the scenario used `launched.cleanup()` (bare `app.close()`), which the harness
  docs say **hangs forever** when a session is running (the quit-guard waits for a `quitDecision`).
  Fix: use `closeApp(app, page)` (answers the in-app confirm). Reinforces [[playwright-cannot-drive-native-dialogs]].
- **Orphaned Electrons from the timed-out runs starved the I/O-bound `file-service` atomic-write
  tests** (5 s timeouts under load). Killing the repo-scoped strays made verify green. Matches
  [[conduit-smoke-env-flakiness]].

## Follow-ups (not built)

- Multi-item *delete* via the Delete key (currently single active row, matching the menu).
- Re-collapse animation under `prefers-reduced-motion` is already a no-op (timer, not animation).
- Add the e2e smoke suite to CI so layout/teardown regressions can't ship uncaught (still true from
  the v0.16.0 run).
