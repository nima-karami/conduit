# Run report — selection-aware context menus

**Date:** 2026-08-16 **Branch:** `feat/selection-aware-context-menus` → `main`
**Spec:** `docs/specs/archive/2026-08-16-selection-aware-context-menus.md`

## The request

> Selecting multiple things and right-clicking on them only affects the target of the right click.
> Make sure that behavior is correct across all the features that we have in this app.

## What the survey found

The request implies the bug is everywhere. It isn't — because **most surfaces have no
multi-selection to begin with**. Two independent read-only sweeps of every `onContextMenu` in
`webview/`, cross-referenced against every selection set, found exactly **two** surfaces with both:

| Surface | Multi-select | Menu scope before | Collapse-on-outside-right-click before |
|---|---|---|---|
| Explorer tree | yes (ctrl / shift click) | Cut + Copy honoured it; **Delete, Copy path, Copy relative path, Open, Rename did not** | yes |
| Architecture canvas | yes (marquee only — see below) | Group + Encapsulate honoured it; **Delete component did not** | **no** |

Surveyed and **correctly single-target** — they have no selection model, so there was nothing to fix:
editor/doc tabs (one `activeId`; close-others/left/right are positional), sessions sidebar (one
`activeId`), feature board cards (no selection state at all), the git change list (per-file items
plus repo-wide bulk ops), git history commits (one `selectedSha`, and no context menu at all),
terminal / Monaco / markdown (text selection, content menus), panel frame / top bar / center pane
(chrome menus).

That framing is the main finding: the fix is narrow and deep, not broad.

## Shipped

| # | Change | Commit |
|---|---|---|
| 1 | Spec | `a0444c3` |
| 2 | `nanoid` 3.3.18 — clears a pre-existing red audit gate | `5eac96e` |
| 3 | **Lane 1** — Explorer: shared rule, menu scoping, bulk delete, keyboard Delete | `d239933` |
| 4 | **Lane 2** — Architecture canvas: collapse, selection-scoped delete, disabled single-only items, **and the Ctrl+click fix** | `f50cea1` |

### The invariant, now in one place

`src/menu-selection.ts` — `resolveMenuTargets(selected, target)` returns the targets plus a
`collapse` obligation for the caller. Right-click inside the selection preserves it and acts on all
of it; right-click outside collapses onto that item first. Both surfaces call it; a third inherits it
for free. `countLabel` / `countNoun` keep the count-bearing labels honest.

Every item is now explicitly **selection-scoped** or **single-only**, and single-only items are
`disabled` while N > 1 rather than silently narrowing. That was the conductor's call (blockers.md
D1): an enabled "Rename…" that renames 1 of 5 selected files *is* the confusion being reported.

### Bug found while verifying, fixed at the source

**Ctrl+click could never extend a selection on the architecture canvas.** React Flow reports
click-selection as `select` changes; `onNodesChange` dropped them, and because the canvas controls
`selected` from `selectedIds`, the next render overwrote React Flow's update. Only the Shift+drag
marquee worked — it mutates React Flow's store directly instead of going through changes. Without
this, Lane 2's whole multi-select menu was reachable only by rubber-banding.

This was **not** in the spec. It was found by the e2e refusing to pass, then isolated with a
diagnostic run that measured ctrl-click (1 selected) against marquee (4 selected) on the same build.

## Evidence

`npm run verify` green on the final tree: **197 files, 2752 tests** (baseline 2684 → **+68**).

Real-app end-to-end, both run against the built Electron app and re-run on the final merged tree:

| Scenario | Result | What it actually proves |
|---|---|---|
| `explorer-multiselect-delete` | **PASS (28.0s)** | Selects 3 of 5 files; asserts the selection survives under the open menu; asserts the last row reads `Delete 3 items` with `danger` + `separatorBefore` and `Rename…` disabled; asserts the confirm counts + lists names and opens with **Cancel** focused; then asserts on the **real filesystem** that exactly a/b/c are gone and d/e remain, and that `shell.trashItem` was called exactly 3 times with those paths. A collapse leg proves right-clicking outside the selection deletes only that row. |
| `arch-multiselect-delete` | **PASS (20.4s)** | Ctrl-clicks two components; asserts the menu reads `Delete 2 components` with the single-only items disabled and `Group selection` enabled; asserts against the **live document** that both are gone, and that **one** Ctrl+Z restores both (i.e. one history entry). |

The arch collapse leg was run **against the pre-Lane-2 build** and **failed** there — right-clicking
node B while A was selected left the selection on A. That is the reported bug, reproduced and then
fixed, rather than asserted from reading the code.

## Deliberately not done

| # | Gap | Why |
|---|---|---|
| P1 ✅ DONE 2026-08-17 | Explorer has **no keyboard multi-select** (no Ctrl+A, no Shift+Arrow — every arrow key collapses to one row via `focusRow` → `selectOne`). A keyboard-only user cannot build a multi-selection, so the fixed menu is unreachable for them. | Adds selection *capability*; the request was about menu *scope*. Real gap — recommend it next. **Built 2026-08-17**: spec `docs/specs/archive/2026-08-17-explorer-keyboard-multiselect.md`, commit `f70bcdc`. |
| P2 | Right-clicking a tab or session card does not make it active. | VS Code behaves the same, and every item in those menus is already scoped to the right-clicked object, so nothing acts on the wrong target. Looks like the same class of bug; isn't. |
| P3 | Board cards and the git change list have no selection model. | Greenfield feature (new state, gestures, a11y), explicitly a non-goal. |
| P4 | A selected *edge* on the canvas that is incident to nothing being deleted survives a multi-delete. | `selectedIds` tracks nodes only; carrying edges needs a mixed-noun label and a wider change. Spec Decisions Needed #10. |

## Process notes worth keeping

- **`verify` was already red on `main`** at the audit gate (`nanoid`). I twice reported it as green:
  once because I piped the run through `tail` (which returns *tail's* exit code) and once because it
  died earlier on a load-induced test flake. Both are now memory notes. Never pipe the gate.
- **Concurrency manufactured a failure.** Three overlapping `verify` processes made
  `conduit-proposal-fs.test.ts` blow its 5000 ms timeout; it passes in 68 ms alone. The user then
  asked for CPU restraint explicitly, and the rest of the run was strictly serial — one lane, one
  gate, one e2e scenario at a time.
- **The spec had a real bug the build caught.** §4.1's snippet de-duped nested targets *before* the
  membership test, which would have collapsed the selection when right-clicking a selected file
  inside a selected folder. Fixed in `resolveExplorerTargets` and pinned by a test.
- **Unit-green would have shipped a dead feature.** Lane 2's menu-array unit tests all passed while
  the gesture that reaches that menu was broken. Only driving the real app found it.
