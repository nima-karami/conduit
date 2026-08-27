# Run report — review supercharge (2026-08-27)

**Status: IN PROGRESS** — this file is written incrementally so the run survives an interruption.
Machine state: `.autoloop/` (gitignored). Spec: `docs/specs/2026-08-27-review-supercharge.md`.

The ask: *"supercharge the way we can review the changes … in the code editor … see the changed
lines as an indicator on the scroll map on the right-hand side … look at what we have first and
see what features or sub-features are missing and expand on that."* Plus two requests made
mid-run (both shipped, below).

## Shipped

| # | Item | Merge | Gate |
|---|---|---|---|
| 1 | **Explorer → "Open as new session"** (user request) | `6c75e4d` | verify 3072 ✓ · `explorer-open-as-session` e2e ✓ |
| 2 | **New Session: Browse… pinned above the recents** (user request) | `4c058ae` | verify 3075 ✓ · `new-session-browse-pinned` e2e ✓ |
| 3 | **Lane A — editor change markers** | `99c9afb` | verify 3164 ✓ · `editor-change-markers` e2e ✓ · screenshot |
| 4 | **Lane B — Review keymap, durable marks, quick-picks, polish** | `1b0a47c` | verify 3259 ✓ · `review-keymap-persist` e2e ✓ · screenshot |

Baseline at kickoff: 3064 tests. Now: **3259**.

### 1. Explorer → "Open as new session"
Right-click a folder in Files → opens the New Session dialog with that folder as the working
directory. Greyed out (not hidden) on a wider selection, per the repo's selection-aware-menu
spec. Root cause found while building: the dialog only rendered *known repos*, so an arbitrary
subfolder prefill selected nothing visible — fixed in the modal, which is what the e2e asserts.

### 2. New Session: Browse… pinned
`Browse…` was the last row *inside* the scrolling recents list, so it had to be scrolled to once
a few repos accumulated. Now a pinned row above the scroller; the divider lives on the list's own
box so it never scrolls and vanishes when there are no recents. E2E asserts the geometry: the
first recent moves 197 → 164 px while Browse stays at 141 px.

### 3. Lane A — editor change markers
Gutter bars (added solid / modified dashed) and deletion triangles, plus overview-ruler and
minimap marks, against **HEAD**, recomputed live 300 ms after the last edit. `Alt+F5` /
`Shift+Alt+F5` walk changes (wrapping, announced "Change N of M"); rows in Monaco's F1, Conduit's
palette, the editor context menu, and the rebindable shortcut registry. Minimap now **on by
default** (reverses the 2026-06-11 minimap decision — user call). Settings: `editorMinimap`,
`editorChangeMarkers`. Decorations get their own 250k-cell LCS budget so a keystroke-debounced
recompute can't stall the editor; over budget → markers off with one hint.

Independent review returned FIX-THEN-MERGE; all four must-fixes were applied before merge:
palette rows were gated on a non-reactive registry read (usually missing); a `setEditorEpoch`
bump double-fetched the HEAD blob (two `git show` spawns per editor); a rebound Alt+F5 never
reached Monaco until the tab reopened; the theme re-resolve skipped the rAF the repo's three
other CSS-var readers use.

### 4. Lane B — Review workflow
Scoped keymap inside the Review scroller (`j`/`k` hunks, `J`/`K` files, `m` reviewed, `o`/`Enter`
open, `e`/`Shift+E` bulk collapse, `?` help), a current-hunk focus ring, Collapse/Expand all, and
a **sticky file header** — which had never worked: `.rcard { overflow: hidden }` made each card
its own scrollport, so a `position: sticky` header had nothing to stick to. Fixed with
`overflow: clip`.

Reviewed marks now persist in `userData/review-marks.json` (host-owned, atomic write, broadcast to
every window), keyed by `(source, path)` with an FNV-1a content receipt so a file that changed
again is no longer "reviewed". Source picker gained *Last commit*, *Unpushed* and *Since branch
point* (host `git:resolveRange`, hidden when unresolvable). Plus an ignore-whitespace toggle and
the long-dead "Open file" button on the oversize-diff notice.

Independent review returned FIX-THEN-MERGE; all three must-fixes applied before merge:
`Enter` was hijacked from every focusable control in the scroller; a transient read failure of
`review-marks.json` could let the before-quit flush overwrite an intact file with an empty one
(the 0.11.1 durability class — closed with a dirty gate mirroring `sessionsPersistGate`); and the
marks key didn't case-fold a drive-letter root, so one repo could occupy two keys.

## Process findings worth keeping

- **The architecture review paid for itself before any code.** It returned REVISE on the epic
  spec with four blockers, all verified against the tree: a renderer-built patch could never be
  byte-correct (`review-hunks` strips `\r`, `readDiff` LF-normalises, the EOF-newline fact is
  lost); staging a HEAD-baseline hunk into the index fails whenever index ≠ HEAD; the persistence
  file skipped the ADR 0002 envelope; and marks + notes were fused despite different lifecycles,
  with the in-tree write feeding back into the Review that produced it. The spec was revised —
  patches are now built host-side from `git diff -U3` filtered by line range, Lane D moved ahead
  of Lane E, marks went to `userData` and notes stay enveloped in `.conduit/`.
- **Two of two lane reviews found real must-fix defects that green gates missed** — including a
  data-loss hazard and a keyboard regression. Verify was green on both branches beforehand.
- **`multi-repo` e2e wasn't a Lane A regression.** It failed after the merge, and re-ran red twice
  on a quiet machine. Cause: the scenario clicked the Changes row's hover-revealed Stage button
  cold, and Playwright hit-tests the click point *before* moving the mouse, so it resolved to
  `.change__path` underneath and retried to timeout. The product is correct — `pointer-events:
  none` at rest is deliberate — so the fix went in the test's interaction (`c498407`), not the
  assertion. `goto-matrix-firstparty`, `scrollback` and `terminal-drop` were the known
  loaded-machine flakes and pass alone.

## Follow-ups captured
- `docs/wishlist.md`: `readBlob` treats "unreadable" and "absent" identically for every persisted
  state file; each caller now has its own gate, but the shared helper is one gate away from
  repeating the 0.11.1 incident (`8bfef7e`).
- Deferred, recorded in `.autoloop/blockers.md`: the Lane B `hashes` memo is O(loaded bytes) per
  streamed diff arrival (now `WeakMap`-cached, so no longer hot); `aria-pressed` on Collapse all
  reports the last bulk action rather than a live fold.

## Remaining
Lane D (scope All/Staged/Unstaged) in progress; then Lane E (hunk staging + change peek),
Lane C (search), Lane F (notes + agent handoff). Plans for D's successor lanes are committed:
`docs/plans/2026-08-27-review-lane-e-hunk-staging.plan.md`.
