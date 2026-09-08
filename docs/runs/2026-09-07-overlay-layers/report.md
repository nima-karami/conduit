# Run report — 2026-09-07 Overlay layers

**Status: pending integration.** Slices 1–3 are committed on branch `overlay-layers`; Slice 4 and the
docs slice are built, verified and **uncommitted**, blocked by an orphaned `.git/index.lock` the
sandbox refused to remove (see Blocked below). The full gate is green on the working tree, runtime QA
passed in all three themes, and an independent review was run on the pinned range.

The user's ask, verbatim: *"There are pages and pop-ups around our application that don't fully
display the dropdown … what appears gets clipped … I think that's a side effect of us not using our
native or primitive components. Do a search for that class of issue … or a pop-up requires a
confirmation on top but the confirmation renders under the pop-up."* Plus finding F1 from the same
day's re-verification of review-mode.

## What this fixes, and why it was broken

A 2026-09-07 static audit inventoried every overlay-producing surface in the renderer. Nine were
clipped, trapped or mis-stacked, and **every one of them had bypassed `ContextMenu`'s portal**; every
surface that went through it was clean. Two stylesheet rules did nearly all the damage: the panel
`backdrop-filter` on `.right` / `.sidebar` / `.topbar` / `.termwrap` (which makes those elements the
containing block for `position: fixed` descendants) and Neon's `clip-path` chamfer. On top of that,
every modal shared `z-index: 60` with no layer order, so a confirm opened *by* a dialog painted
underneath it whenever it happened to come first in JSX.

| # | Surface | Was | Now |
|---|---|---|---|
| 1 | Explorer name-collision prompt | trapped in the 340px rail, buttons cut off | centred on the window |
| 2 | Compare refs → ref list | clipped by the dialog's Neon chamfer | portaled, viewport-clamped |
| 3 | Timed messages → discard confirm | painted under its own dialog; one Escape opened and closed it | above the dialog, Escape closes only it |
| 4 | Arch inspector type picker | clipped by the inspector's scrollport | portaled, whole |
| 5 | Mermaid expand overlay | covered only the document pane | covers the window |
| 6 | Review discard confirms | scrim covered only the document pane | window-wide scrim |
| 7 | Arch "Delete interface?" | inside `.arch`'s z-40 context, under menus and toasts | body-level |
| 8 | Monaco hover / suggest / parameter hints | clipped to the editor box | body-level overflow host |
| 9 | Native `<select>` ×3 | OS chrome, unthemed | the app's own dropdown |
| F1 | Review header at the 900px window minimum | overflowed 119px; the `…` menu was unreachable and `Stage all` clipped | compacts: scope moves into the `…` menu, source label truncates, bar keeps `Stage all` whole |

## How it was fixed

One mechanism, not a z-index war: **portal to `document.body`**, expressed as two primitives over one
shared stack.

- `src/overlay-stack.ts` — pure ordering: depth among modals, the top entry, and which popovers a new
  modal displaces. Unit-tested with no DOM.
- `webview/overlay-store.ts` — the live stack, the dismiss callbacks, and the app's **single**
  window-capture Escape listener. It dispatches to the top entry and stops the event there, which is
  what makes "Escape closes only the topmost" true; it also commits a push before fanning out
  displaced popovers' callbacks, so a re-entrant dismiss cannot corrupt the stack.
- `webview/components/modal-layer.tsx` and `popover.tsx` — the portal, the stacked z, the anchor,
  the viewport clamp and the dismiss listeners. `ContextMenu` was **rebuilt on `Popover`**: its
  portal, clamp and dismiss code moved rather than being copied, so its 14 consumers were untouched.
- `--layer-*` tokens replaced the four z literals; the modal band is 60–79 with popovers at 80.
- The Settings shortcut recorder became a stack entry, because it had been winning Escape by
  registering in the capture phase — with the store owning capture, it would otherwise have closed
  the whole Settings modal instead of cancelling the recording.

Three pieces of dead CSS went with it: the `.shell > .sidebar/.center/.right` arms (those elements
are not children of `.shell`), all of `.resizer*` (no render site anywhere), and `.modal__select`.

## Commits (branch `overlay-layers` on `main` @ `9c58182`)

| SHA | Slice | What |
|---|---|---|
| `c3925a6` | docs | spec + index row |
| `dbe5dc6` | docs | spec and plan revised after the spec review and the architecture critique |
| `0c90dd5` | 1 | overlay stack, store, `useOverlayEntry`, `Popover`, `ModalLayer`, `ContextMenu` on `Popover`, layer tokens |
| `1eabb90` | 2 | nine modal sites + the mermaid viewer on `ModalLayer`; Escape owned by the stack; dead CSS removed |
| `b5b5b0f` | 3 | compare combobox and arch type picker on `Popover`; Monaco overflow host; `SelectField` ×3 |
| *(uncommitted)* | 4 + 5 | Review compact header, scope in the `…` menu, bar menu above; changelog, spec archived |

## Gates and evidence (`.autoloop/evidence/2026-09-07-overlay-layers/`)

- Baseline `npm run verify` at `c3925a6`: exit 0, with the gate definitions hashed (`baseline.md`).
- **Definitive `npm run verify` on the full working tree** (Slice 4 included), run on a quiet machine:
  **exit 0**, 258/258 test files, 3935 passed / 2 skipped (`verify-final-tree.log`). Re-run after the
  review fixes: **exit 0**, 258/258, 3942 passed / 2 skipped (`verify-post-review.log`) — the seven
  extra tests are the new guards.
- Integrity scan over `9c58182..b5b5b0f`: clean. The six dirty files were byte-checked individually —
  no NUL, no BOM, no CR (`integrity-scan.txt`).
- **AC-0 baselines captured before each fix**, by reverting only the product files to the base commit,
  rebuilding, and running the new scenario: `baseline-overlay-modals-final.log` (the timed-message
  confirm both opened and self-closed on one Escape at base), `baseline-overlay-popovers.log` (the ref
  list's parent was `cmp-combo`, the type picker's `typechip__wrap`), `baseline-review-compact.log`
  (header `scrollWidth` 376 against `clientWidth` 250), `baseline-monaco-hover.md` (the suggest widget
  crossed `.termwrap`'s bottom edge).
- **Runtime QA (Opus, three themes)**: pass. 38 criteria per theme, 20/20 smoke, one reported failure
  disproved as a driver defect by the agent's own follow-up probe. Report and 69 screenshots in
  `qa.md` and `qa/`.
- Load attribution: several mid-run gate failures were reproduced as external load (another session
  driving ~40 Chrome processes and Playwright suites; the installed Conduit polling this repo's git,
  nine concurrent `git diff` at one point) and every one passed alone or on the quiet re-run.
  `load-attribution.md` records the process snapshots and the resolution.

## Independent review — REVISE, 2 blockers, both fixed

An Opus reviewer with no part in the build read the pinned range plus the uncommitted work against
the plan and the spec. Verdict **REVISE**, 2 blockers and 12 lesser findings. Both blockers were
reproduced at their anchors before anything was changed:

1. **Three menus lost their positioning.** Slice 1 deleted `position: fixed; z-index: 80` from
   `.ctxmenu` because `ContextMenu` now gets both from `.popover`. But `BranchSwitcherMenu`,
   `CommitPickerMenu` (the Review source picker) and `RepoPickerMenu` portal *themselves* and carry
   `.ctxmenu` **without** `.popover`, positioning with inline `left`/`top`. With `position: static`
   those coordinates are inert and all three would have laid out in body flow, below the fold.
   Reproduced by grep: no rule in the stylesheet declared `position` or `z-index` for that class any
   more. Every click-based e2e stayed green over it because Playwright scrolls a target into view
   before clicking — which is exactly why this needed a human-grade reviewer and a non-click guard.
   Fixed by restoring the two declarations on `.ctxmenu` (identical to `.popover`'s, so
   `ContextMenu` is unaffected), and guarded twice: a static assertion that both classes declare a
   positioning scheme, mutation-verified red-then-green, and a runtime assertion in
   `overlay-popovers` that measures the commit picker's box against its trigger.
2. **The compact handoff button rendered empty.** Its only child was the label span, which the
   ≤480px rule makes screen-reader-only — leaving a blank pill where the action bar's primary
   control should be, at exactly the width this slice targets. Fixed by rendering an icon beside
   the label (a sparkle when a terminal can take the paste, a copy glyph otherwise) and asserting
   in `review-compact-header` that the button draws an icon, keeps a non-degenerate width, remains
   hit-testable, and keeps an accessible name.

The same pass also caught that swapping `.ctxmenu` for `.popover` in the drag-region opt-out had
silently dropped those three menus from Electron's drag mask — a defect class the project's own
notes record as uncatchable by any e2e. Both they and the new Monaco overflow host are now in the
`no-drag` group and in the unit guard's overlay list.

Both fixes were mutation-verified: deleting the restored `.ctxmenu` declarations turns the new
static guard red and restoring turns it green; removing the handoff icon fails
`review-compact-header` with exactly the assertion written for it. The Tab-trap guard asserts its own
precondition (the list open with options rendered) before asserting that none of them appear in the
dialog's focusable enumeration, so it cannot pass vacuously — a first attempt using a real Shift+Tab
was discarded precisely because blurring the input closes the list before focus lands.

Eight of the should-fixes were taken in the same pass: the dead `.modal__select` block deleted, a
write-only `confirmRef` removed, the disabled scope rows given the segment's explanatory tooltip,
`TypeChip`'s measurement moved out of a `setState` updater (it was a render-phase update waiting to
happen), `ModalLayer`'s style prop merged rather than overwritten, the accepted Tab-trap consequence
given a regression guard, and the plan's file map corrected to name the two test files the portal
forced open. The reviewer's verified-clean list is worth keeping: the Escape routing and listener
lifecycle match the contract byte for byte, all ten migrated dismiss paths match the spec's table,
and the dead-CSS deletions were genuinely dead.

## Process

Spec (FULL) → independent spec review (4 blockers, all folded in: a self-contradictory Escape
routing rule, a wrong claim about which dialogs bind Escape on `window`, an acceptance criterion that
would not have failed if finding 7 stayed broken, and a missed drag-region hazard) → plan (FULL, 5
slices) → **architecture critique before any code** (3 must-fix: the capture-phase collision with the
Settings recorder, a dependency-less layout effect that would thrash on every menu hover, and
`useSyncExternalStore` subscribing after paint) → Sonnet executors per slice → conductor gate per
slice → independent code review → runtime QA.

Two executors were cut off mid-slice by session rate limits. Both left usable trees; the conductor
inspected them, finished the remaining work inline, and recorded what was found — including two
defects an executor had left: a stylesheet rule that still positioned the now-portaled type picker
(`position: absolute` overriding the primitive, invisible to an e2e that only checked parentage), and
a unit test that queried the mount host of a dialog that had just become a portal.

## Blocked

**A stale `.git/index.lock`** (0 bytes, 09:49, no `git.exe` alive) has blocked every write to the git
index since. The sandbox classifier refused to remove it from both Bash and PowerShell, and the
repository's own convention is never to delete it, so it was handed back to the user. Everything is
finished and verified **on disk**; what remains is purely the commit. The spec was moved into
`docs/specs/archive/` with a plain `mv` rather than `git mv` so the tree stays self-consistent — git
will record it as a rename when the index is writable again.

Once the lock clears, the whole remainder is:

```
git add -A && git commit    # Slice 4 + the review fixes + docs, one commit
git checkout main && git merge --ff-only overlay-layers
```

## Follow-ups (not blocking)

- The Monaco **hover** widget attaches to the new overflow host and is themed, but its TS quick-info
  never resolves inside the e2e harness (~20 s, reproduced against a scratch file and a tracked repo
  file). Pre-existing and unrelated; the suggest widget, on the identical mechanism, is what proved
  finding 8.
- `test/e2e/overlay-modals.e2e.mjs`'s finding-7 step originally substituted an explorer-menu
  displacement check because component delete has no confirm; the arch **interface** delete does, and
  the step now drives that. Worth remembering that "delete a component" is unconfirmed in the product.
- The `.review__actionbar` disappears when a review has no files, which makes `.review__barmore`
  unreachable — the compact-header scenario has to restore the scope to All before it finishes.
