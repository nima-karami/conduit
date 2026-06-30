---
status: active
date: 2026-06-29
---

# Feature Spec: Explorer drag-and-drop & rename polish

**Tier:** FULL   **Feature type:** UI
**One-line request:** Improve the file explorer's behavior for dragging files in from
outside the OS and for moving files between folders inside Conduit (precise drop target,
all edge cases, good UX); plus F2-to-rename and rename selecting only the filename, not
the extension.

> Builds on the existing explorer (`webview/components/right-pane.tsx` `FilesView`,
> `webview/file-tree.ts`, `webview/file-tree-selection.ts`, `src/drop-intent.ts`,
> `src/fs-dnd.ts`, `src/fs-import.ts`). This spec specifies **behavior**; the implementation
> plan owns internal structure.

---

## 1. Problem frame

- **Job:** Manage project files directly in Conduit — bring files in from the OS, reorganize
  them between folders, and rename them — with the precision and keyboard parity of a native
  file explorer (Finder / VS Code), without dropping into a terminal.
- **Actors:** The single local user driving the Explorer (Files tab) with mouse + keyboard.
- **Success outcomes (observable):**
  1. During any drag, **exactly one** drop destination is highlighted — the user can see
     precisely where the item will land before releasing.
  2. Dragging onto a collapsed folder reveals its contents so nested drops are possible.
  3. Pressing **F2** on a selected row starts a rename; the editable text has **only the
     filename stem selected** (extension preserved unless the user extends the selection).
  4. Name collisions are resolved with a clear, consistent **Replace / Keep both / Cancel**
     choice for every drop path (internal move, internal copy, OS import).
  5. Every drag action has a keyboard/menu equivalent (cut / copy / paste, delete, open).
- **Non-goals:**
  - Reordering files within a folder (the tree is sorted dirs-first by the host; manual
    order is out of scope).
  - Dragging files *out* of Conduit to the OS, or cross-window file drag.
  - Introducing an i18n framework or RTL support (the app is English-only inline today; we
    follow that convention — see §10).
  - Changing the destructive-delete confirm/recycle-bin flow (owned by `app.tsx`); we only
    add the keyboard entry point to it.

## 2. Behavior & states

### Primary flows

**A. OS import (drag from Explorer/Finder into the tree)**
1. User drags one or more OS files/folders over the tree.
2. The row under the cursor resolves to a **destination folder** (a folder targets itself; a
   file targets its parent folder; empty space / root area targets the project root).
3. *That one folder row* (or the root container) shows the drop highlight; `dropEffect = copy`.
4. Hovering a **collapsed** folder for ~600 ms auto-expands it (spring-load) so the user can
   drill in. (D-SL)
5. On drop: copy each source into the destination via `fsImport`. On name collision, the
   conflict flow (flow D) runs. Success → toast `Added N items`, tree refreshes, **focus and
   selection move to the imported item(s)**.

**B. Internal move (drag a tree row to another folder, no modifier)**
1. User drags a row (or a multi-selection — flow C) over the tree.
2. Destination folder resolves as in A2; one row highlights; `dropEffect = move`.
3. Invalid targets show **no** highlight and reject the drop: source's own folder (no-op),
   a folder onto itself, or a folder into its own descendant (`dropIntent` already rejects).
4. On drop: `fsMove` each item. Conflicts → flow D. Success → source-parent + destination
   refresh, **selection follows the moved item(s) to their new location**, undo entry pushed.

**C. Internal copy** — identical to B but with **Ctrl** held (`dropIntent` → `copy`,
`dropEffect = copy`, `fsCopy`, copy undo entry).

**C′. Multi-item drag** — when the grabbed row is part of the current multi-selection, the
**entire selection** is dragged; dragging an *unselected* row acts on that row alone (and is
treated as selecting it). Ancestor/descendant pairs in the selection are de-duped to
top-level items so a folder and its own child aren't both moved.

**D. Conflict resolution** — when a destination name already exists, a 3-way dialog
(`ConfirmDialog`, reusing `secondaryLabel`/`onSecondary`):
- **Replace** (primary, danger) → overwrite the destination.
- **Keep both** (secondary) → write to an auto-suffixed `name (1)` / `name (2)` … path.
- **Cancel** → skip this item (a batch continues with the rest).
For a batch with multiple conflicts, the dialog offers **"Apply to all remaining conflicts"**
(checkbox) so the user resolves once (v1; see §6).

**E. Rename (F2 or context-menu "Rename…")**
1. F2 on the focused/active row (or menu) swaps the row for an inline input (`DraftRow`),
   prefilled with the current name.
2. On focus the input **selects only the filename stem** (text before the final dot) for a
   file with an extension; selects **all** for a folder, an extensionless file, or a dotfile
   (`.env`). Caret/extension remain editable.
3. Enter commits (validated via `validateName`), Escape/blur cancels. Success → tree refresh,
   focus returns to the renamed row; open doc tabs for the path update (`onRenamed`).

**F. Keyboard navigation & actions (tree focused)** — see §9.

### State catalog → §8.

## 3. Data / interface contract

This is mostly a renderer-behavior change; the host contract changes only to make conflict
resolution explicit instead of a hard refusal.

**Drag payload (renderer-internal + DataTransfer):**
- In-memory `draggedPaths: string[]` (top-level, de-duped) is the source of truth for internal
  move/copy (survives across rows without serializing).
- `DataTransfer`: `text/plain` = newline-joined source paths; `TERMINAL_PATH_MIME` = the single
  grabbed path (unchanged, so terminal path-drop still works); `effectAllowed = 'copyMove'`.
- `types.includes('Files')` still distinguishes an OS-origin drag from an internal one.

**Host IPC — `fsMove` / `fsCopy` gain an explicit conflict policy:**
```ts
type ConflictPolicy = 'error' | 'replace' | 'rename';
fsMove(from: string, to: string, opts?: { onConflict?: ConflictPolicy }): Promise<DndResult>
fsCopy(from: string, to: string, opts?: { onConflict?: ConflictPolicy }): Promise<DndResult>
// DndResult error variant gains a discriminant so the renderer can tell a *conflict* from a
// generic failure and open the dialog instead of toasting:
type DndResult = { ok: true; path: string } | { ok: false; error: string; code?: 'EEXIST' }
```
- `onConflict` default `'error'` (back-compat; existing callers/tests unchanged).
- `'error'` + existing dest → `{ ok:false, code:'EEXIST', error }` (no disk change).
- `'replace'` → remove dest, then move/copy. Guard: refuse if dest is an ancestor of/equal to
  source (already covered by `dropIntent`, re-asserted host-side).
- `'rename'` → resolve a unique `name (n)` dest (reuse `uniqueDestPath` from `fs-import.ts`),
  move/copy there, return the actual created path.
- `fsImport` keeps auto-rename as its built-in default, **but** also accepts the same policy so
  Replace works for OS import; its current behavior = `'rename'`.
- **Result codes:** `code` is `'EEXIST'` only. The renderer distinguishes *exactly two* outcomes —
  conflict (`code:'EEXIST'` → open dialog) vs. **any other failure** (generic `error` string →
  toast). Per-item failure attribution (which item failed in a batch) comes from the renderer
  driving the batch **one item at a time** (below), not from richer codes — so the type stays small.
- **`'replace'` of a populated folder** recursively removes the existing destination tree before
  writing. This is the highest-blast-radius path: the conflict dialog's message must **name the
  destination and warn it is non-empty** (e.g. "Replace folder "dist" and its N items?") and the
  Replace button is `danger`.

**Batching & concurrency (the contract for multi-item drops):**
- A multi-item drag (flow C′) or OS import resolves to **N independent single-item operations**;
  the renderer loops, calling `fsMove`/`fsCopy`/`fsImport([oneSource], dir, …)` per item so every
  path reduces to a single `{ ok, path }` result and conflicts are handled uniformly. (`fsImport`
  keeps its array signature for back-compat; the renderer simply passes a 1-element array.)
- **Per-item conflict:** call with `onConflict:'error'`; on `EEXIST` open the dialog; re-call the
  *same* item with the chosen policy. **"Apply to all remaining"** stores the chosen policy in the
  loop and skips the dialog for subsequent conflicts — applied across **all** remaining conflicts
  regardless of kind (file/folder); "Replace" on a folder-vs-file still replaces.
- **Partial failure:** a non-conflict failure on item *k* **stops the batch** (stop-and-report):
  items `< k` stay applied and recorded in undo individually; a toast names the failed item; items
  `> k` are skipped. Each successful item is its own undo entry (so a partial batch is fully
  reversible step by step).
- **In-flight guard / no double-submit:** while a batch is committing, the tree disables new
  drag/drop and the cut/paste keys (a single in-flight flag); a second drop is ignored until the
  current one settles. The host ops are **not idempotent** (a second move of an already-moved
  source errors) — the guard, not idempotency, prevents the race.

**Invariants:** both ends path-guard-validated (unchanged); no operation escapes a write-root;
a refused/cancelled op leaves disk untouched; undo stack records the *actual* destination path
(so Keep-both is undoable); a partial batch leaves every already-applied item individually
undoable.

## 4. Edge cases & failure modes

| Condition | Expected behavior / recovery |
|---|---|
| Drop onto a **file** | Resolves to the file's parent folder; that folder's row highlights (not the file, not its siblings). |
| Drop onto **source's own folder** / same dir | `dropIntent` → null → no highlight, drop is a no-op. |
| Drop a folder **into its own descendant** | Rejected (`isAncestorOrEqual`); no highlight. Multi-drag: only the offending item is skipped, others proceed. |
| **Multi-selection contains a folder and its child** | De-dupe to the top-level folder; child not moved separately. |
| **Name collision** (1 item) | Conflict dialog (Replace / Keep both / Cancel). |
| **Name collision** (batch) | Per-item dialog; "Apply to all remaining" resolves the rest in one choice. |
| **Replace a folder with a file** (or vice-versa) of same name | Allowed via Replace (host removes dest first); message names the kind being replaced. |
| **Replace a non-empty folder** | Allowed but the dialog warns it is non-empty + item count; Replace recursively deletes the old tree. Highest blast radius — danger styling + explicit count. |
| **"Apply to all" over mixed conflict kinds** | The stored policy applies to every remaining conflict regardless of file/folder kind. |
| **Concurrency / double-submit** | While a batch commits, drag/drop + cut/paste are disabled (in-flight flag); a second drop is ignored. Ops are not idempotent — guard prevents the race. |
| **Partial batch failure** (item k fails, non-conflict) | Stop-and-report: items `<k` applied + individually undoable; toast names the failed item; `>k` skipped. |
| **EXDEV copy+rm where rm fails** | Copy succeeded but source not removed → a duplicate exists. Host returns the error; toast surfaces it; user can retry/delete. (No silent success.) |
| **"Keep both" name race (TOCTOU)** | `uniqueDestPath` then write may still collide if the name appears meanwhile → host returns `EEXIST`/error for that item; renderer reports it (does not loop forever). |
| Rename **changing only case** (`Foo.ts`→`foo.ts`) on case-insensitive FS | Allowed: `validateName` treats it as self (case-insensitive self-match), host renames via a two-step temp to force the case change on win32. |
| Rename to a **reserved / invalid Windows name** (`CON`, `aux`, trailing dot/space) or path separator | Blocked inline by `validateName` (extended to cover reserved names + invalid chars), red row + reason; never reaches host. |
| Spring-load: cursor **leaves** before delay | Timer cancelled; folder stays collapsed. |
| Spring-load: folder auto-expanded but **drop landed elsewhere** | Folders opened *by this drag* re-collapse on dragend (v1); MVP leaves them expanded. |
| **OS path unresolvable** (`getPathForFile` → '') | Existing toast "Could not read the dropped file paths."; whole drop aborts. |
| Drop **outside any write-root** | Host path-guard refuses; toast with the guard message; no disk change. |
| **EXDEV** (cross-drive move) | Host already falls back to copy+rm on success; see the rm-fails row for the partial case. |
| Rename to an **existing sibling name** | `validateName` blocks inline (red row + reason); never reaches host. |
| Rename: **extensionless file / dotfile / folder** | Whole name selected (no stem/ext split). |
| F2 with **no row focused** | No-op (nothing to rename). |
| F2 / Delete with a **multi-selection** | Rename acts on the active (anchor) row only; Delete acts on the whole selection (confirm names the count). |
| Drag while a **rename draft** is open | Draft cancels (blur) before the drag proceeds. |
| Drop target dir **not yet loaded** | Resolve + refresh on drop (existing `refreshDir`); highlight uses the row's own path regardless of load state. |
| `reduced-motion` | Spring-load still works (timer, not animation); any expand transition is suppressed. |

## 5. Defaults vs. settings

| Decision | Default | Configurable? | Rationale |
|---|---|---|---|
| Drag, no modifier | **Move** | No | Matches the existing `dropIntent` contract and VS Code. |
| Ctrl held | **Copy** | No | Existing contract; discoverable via `dropEffect` cursor. |
| Conflict resolution | **Dialog** (Replace / Keep both / Cancel) | No | User-chosen; consistent across move/copy/import. |
| Spring-load delay | **600 ms** | No (constant) | Standard hover-expand feel; a setting is over-production. |
| Spring-opened folders re-collapse | **Yes** on dragend if drop landed elsewhere | No | Keeps the tree as the user left it; v1. |
| Multi-drag | Drags the **whole selection** when grabbing a selected row | No | VS Code parity (user-chosen). |
| Rename selection | **Stem only** for files w/ extension | No | The requested behavior; matches Finder/VS Code. |
| Keyboard nav | **Full** (arrows + F2 + Enter + Delete + Esc + cut/copy/paste) | No | User-chosen; this is the a11y drag-alternative too. |

## 6. Scope slicing

- **MVP (the explicit complaints):**
  - **M1** Precise single-row drop highlight (kills the "whole directory lights up" bug) for
    both OS import and internal move/copy.
  - **M2** F2 starts rename on the focused/active row.
  - **M3** Rename input selects only the filename stem.
- **v1 (the chosen enhancements — all in this build):**
  - **V1** Conflict dialog (Replace / Keep both / Cancel) across move/copy/import, with host
    `onConflict` policy + `EEXIST` discriminant; "Apply to all remaining" for batches.
  - **V2** Multi-selection drag (whole selection, top-level de-dupe).
  - **V3** Spring-loaded folders (600 ms auto-expand; re-collapse drag-opened folders on
    dragend if unused).
  - **V4** Full keyboard: Up/Down/Left/Right navigation, Enter (open/toggle), Delete (delete),
    Escape (cancel draft / clear selection), and Cut/Copy/Paste (Ctrl+X/C/V + context-menu)
    as the non-drag move/copy pathway (WCAG 2.5.7).
  - **V5** `aria-live` announcements for drag/keyboard outcomes ("Moved N items to <folder>").
- **Vision (could, later):** cross-window file drag; drag a file into the editor/terminal as a
  reference; a status-bar progress indicator for large recursive copies.
- **Out of scope:** intra-folder reordering; drag-out to OS; i18n/RTL framework.

## 7. Acceptance criteria

**Declarative:**
- During any drag over the tree, at most one folder row (or the root container) carries the
  drop-highlight class at a time; sibling rows of the target are never highlighted.
- Dropping an OS file onto a nested file copies it into that file's parent folder.
- Hovering a collapsed folder ≥600 ms during a drag expands it; leaving before then does not.
- F2 on a selected file opens the rename input with the stem selected and the extension
  unselected; F2 on a folder selects the whole name.
- A drop whose name collides shows Replace/Keep both/Cancel; Keep both creates `name (1)`;
  Cancel leaves disk unchanged.
- Cut (Ctrl+X) then Paste (Ctrl+V) into a folder moves the item there (keyboard-only move); a
  paste that collides opens the same conflict dialog with focus moved into it.
- Every move/copy is undoable and lands at the path actually written (including a Keep-both
  `name (1)` destination).
- Replacing a non-empty folder warns with its item count before deleting; Cancel preserves it.
- A multi-item drop where one item fails (non-conflict) keeps the already-moved items (each
  individually undoable) and reports the failed one; it does not roll the whole batch back.
- While a drop is committing, a second drag/drop or paste is ignored until it settles.

**EARS:**
- *Ubiquitous:* The Explorer shall highlight exactly one drop destination during a drag.
- *Event:* When the user presses F2 with a row active, the Explorer shall begin an inline
  rename of that row.
- *Event:* When a drop would overwrite an existing entry, the Explorer shall present
  Replace / Keep both / Cancel before any disk write.
- *State:* While a folder has been hovered for ≥600 ms during a drag, the Explorer shall
  expand that folder.
- *Unwanted:* If the user drops a folder into its own descendant, the Explorer shall reject
  the drop and make no disk change.
- *Optional:* Where a screen reader is active, the Explorer shall announce move/copy/rename
  outcomes via a polite live region.

**Gherkin (key scenarios):**
```gherkin
Scenario: Precise highlight when hovering a nested file
  Given folder "src" is expanded with files "a.ts" and "b.ts"
  When I drag "notes.md" from the OS over "a.ts"
  Then only the "src" folder row is highlighted
  And neither "a.ts" nor "b.ts" is highlighted
  When I drop
  Then "notes.md" is copied into "src"

Scenario: Spring-loaded folder
  Given folder "deep" is collapsed
  When I drag a file over "deep" and hold for 600ms
  Then "deep" expands and its children become drop targets

Scenario: Rename selects the stem only
  Given file "component.tsx" is selected
  When I press F2
  Then the rename input shows "component.tsx" with "component" selected
  And ".tsx" is not selected

Scenario: Move conflict, keep both
  Given "dst" already contains "report.pdf"
  When I move "report.pdf" into "dst" and choose "Keep both"
  Then "dst" contains both "report.pdf" and "report (1).pdf"

Scenario: Keyboard move via cut/paste
  Given "a.ts" is selected in "src"
  When I press Ctrl+X, select folder "lib", and press Ctrl+V
  Then "a.ts" is moved into "lib"
  And the selection follows it to "lib/a.ts"

Scenario: Replacing a non-empty folder warns first
  Given folder "dist" exists at the destination and contains 12 items
  When I move another "dist" onto it and the conflict dialog appears
  Then the message names "dist" and warns it contains 12 items
  And choosing Cancel leaves the original "dist" and its 12 items intact

Scenario: Partial batch failure keeps applied items
  Given I drag 3 files into "out" and the 2nd write fails (permission denied)
  When the batch stops
  Then the 1st file is present in "out" and is undoable on its own
  And a toast names the 2nd file as failed
  And the 3rd file was not moved

Scenario: Paste collision opens the dialog
  Given "lib" already contains "a.ts"
  When I cut "a.ts" from "src" and paste into "lib"
  Then the Replace / Keep both / Cancel dialog opens with focus inside it
```

## 8. State catalog (UI)

| Component | State | What the user sees | Action / CTA |
|---|---|---|---|
| File row | Default | Name + icon | Click selects; dbl-click opens permanent |
| File row | Hover | Row bg highlight | — |
| File row | Focus (kbd) | Visible focus ring (roving tabindex) | Arrow keys move focus |
| File row | Selected | Selected bg + `aria-selected` | Acts as multi-select member |
| File row | Dragging (source) | Dimmed source row | — |
| Folder row | Drop target | **Single-row** accent outline + tint (one row only) | Release to drop here |
| Folder row | Spring-loading | Same drop highlight; expands after delay | — |
| Tree container | Root drop target | Existing dashed container outline | Drop into project root |
| Tree container | Empty folder | "No files / This folder is empty." | Right-click → New… |
| Tree container | Loading | "Loading…" (`role=status`) | — |
| Tree container | Dir load failed / vanished | Drop target row no longer resolves → drop is a no-op; on a vanished target a toast says so | Refresh |
| Operation | In-flight | Tree drag/drop + cut/paste disabled until the batch settles (in-flight flag) | — |
| Operation | Partial-batch failure | Toast names the failed item; applied items remain (each undoable); rest skipped | Undo |
| Rename input | Editing | Inline input, stem preselected | Enter commit / Esc cancel |
| Rename input | Invalid | Red border + reason on hover (`title`) — incl. reserved/invalid Windows names | Fix name |
| Conflict dialog | Open | Title + message naming the item (and item-count when replacing a non-empty folder); 3 buttons (+ "apply to all" on batch) | Replace / Keep both / Cancel |
| Conflict dialog | Resolution failed | The chosen action's host write failed → toast with the error; dialog closes (item counted as failed) | Retry via redo of the drop |
| Live region | Announce | (visually hidden) "Moved/Copied/Imported N items to <folder>", "Renamed to <name>", "Skipped <name>", "N items skipped" | — |
| Toast | Error / info | Existing toast | — |

## 9. Interaction inventory (UI)

| Component | Actions | Pointer | Keyboard / shortcuts | Touch | Context menu | ARIA role/states |
|---|---|---|---|---|---|---|
| Tree | Navigate / select | Click, Shift/Ctrl-click | ↑/↓ move, ←/→ collapse-or-parent / expand-or-child, Home/End | n/a (desktop) | empty-space → New file/folder | `role=tree`, `aria-multiselectable` |
| File/Folder row | Open / toggle / rename / delete / move / copy | Click, dbl-click, drag, Ctrl-drag, right-click | Enter (open/toggle), **F2** (rename), Delete (delete), Ctrl+X/C (cut/copy), Ctrl+V (paste into active folder), Esc (clear/cancel) | n/a | Open / Rename / Cut / Copy / Paste / Delete / Copy path / Reveal | `role=treeitem`, `aria-selected`, `aria-expanded` (dirs), `aria-level`, roving `tabindex` |
| Drop target (folder) | Receive drop | Drag-over highlights one row; 600 ms spring-load | Paste = keyboard equivalent | n/a | — | one highlighted target; SR feedback via cut/paste + live region (not `aria-dropeffect`) |
| Conflict dialog | Resolve collision | Click a button | Enter = primary (unless Cancel focused), Esc = cancel | n/a | — | `role=alertdialog`, focus-trapped |
| Rename input | Edit name | Click/drag to reselect | Enter/Esc; default stem-only selection | n/a | — | labeled text input |

Rules honored: every drag action has a **non-drag pathway** (Cut/Copy/Paste in menu +
keyboard); selection/drop-target never color-only (outline + tint + text announce); focus is
visible and managed (lands on moved/renamed item).

## 10. Accessibility & i18n (UI)

**Accessibility (WCAG 2.2):**
- **Keyboard operability:** full nav + F2/Enter/Delete/Esc + Cut/Copy/Paste; drag is never the
  only way to move/copy (2.5.7).
- **Visible focus:** roving-tabindex focus ring on rows; must survive forced-colors.
- **Accessible names:** existing icon buttons keep `aria-label`; rows expose name as text.
- **Announce dynamic results:** `aria-live="polite"` region announces "Moved/Copied/Imported N
  items to <folder>", "Renamed to <name>", and conflict outcomes including the skip/cancel side
  ("Skipped <name>", "N items skipped") and partial-batch failure — things only visible sighted
  users get from toasts/tree movement.
- **Conflict dialog keyboard:** opening it (from drop OR from a keyboard paste that collides) moves
  focus into the dialog (`role=alertdialog`, focus-trapped); Esc = Cancel, Enter = primary unless
  Cancel is focused (existing `ConfirmDialog` behavior); on close focus returns to the tree.
- The deprecated ARIA drag attributes (`aria-dropeffect`/`aria-grabbed`) are **not** relied on for
  screen-reader drag feedback — the real accessible path is cut/copy/paste + the live region.
- **Color not sole signal:** drop target = outline + tint (not color alone); git-status dots
  unchanged.
- **Reduced motion:** spring-load is timer-based; suppress any expand animation under
  `prefers-reduced-motion`.
- **Focus management:** after move/paste, focus + selection move to the item in its new
  location; after rename, focus returns to the row; after delete, focus moves to the next
  sibling (or parent).

**Internationalization:** The app has **no i18n framework and is English-only inline** today;
this feature follows that established convention rather than introducing one (an i18n
framework is explicitly out of scope, §1). Concretely: new user-facing strings ("Replace",
"Keep both", "Moved N items…") are inline English consistent with the rest of the app;
**count-dependent strings use the existing manual pluralization idiom** (`item${n===1?'':'s'}`,
as in the current import toast); paths render verbatim (no locale formatting needed). RTL is
not supported app-wide and is out of scope. *(Flagged so this is a conscious convention-match,
not a silent a11y/i18n drop.)*

## 11. Design tokens (UI)

- Reuse existing semantic tokens — `--accent` (drop-target outline/tint via `color-mix`, as
  `.filerow--droptarget` already does), `--red` (danger/replace), `--text`, `--surface`/`--bg`.
- No new colors. The single-row highlight reuses the current `.filerow--droptarget` rule; the
  fix is **which** rows receive the class, not the styling.
- Themes: inherits light/dark/high-contrast from existing tokens; verify the outline is visible
  in high-contrast (outline, not just background tint).

## 12. Assumptions

- The drop highlight's *look* is fine; only its **scope** (one row) is wrong — reuse existing
  CSS, change the matching logic. (Confirmed by reading `.filerow--droptarget`.)
- Keep-both suffixing reuses `uniqueDestPath` from `fs-import.ts` (already unit-tested).
- The conflict dialog reuses `ConfirmDialog`'s existing 3-button shape
  (`secondaryLabel`/`onSecondary`); "Apply to all" is the only net-new dialog affordance.
- Keyboard nav uses a roving-tabindex over `visibleOrder(roots)`; the active/anchor path from
  `file-tree-selection.ts` drives which row is focusable. No virtualization exists to fight.
- Cut/Copy/Paste is in-app only (an internal clipboard of paths), not the OS clipboard, to
  avoid surprising the system clipboard; paste targets the active folder (or active file's
  parent), mirroring `resolveCreateTarget`.
- Spring-load and multi-drag are renderer-only; no host changes beyond the `onConflict` policy.
- `validateName` is extended to also reject reserved Windows device names (`CON`, `PRN`, `AUX`,
  `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9`), trailing dot/space, and the remaining invalid chars
  (`<>:"|?*`) — purely additive to its current empty/dot/separator/collision checks.
- A case-only rename on win32 (case-insensitive FS) is done host-side via a two-step temp rename
  (`Foo.ts`→`Foo.ts.tmp`→`foo.ts`) so the case change actually lands; other platforms rename
  directly. `validateName`'s case-insensitive self-match already permits it on the renderer side.
- Multi-item batches are driven as N single-item host calls from the renderer (one settled result
  + one undo entry each); `fsImport` is called with a 1-element source array per item for uniform
  conflict handling — no new batch IPC.

## 13. Decisions Needed (autonomous mode)

None — the four material forks were resolved with the user before this spec:
Conflict = **dialog**; Spring-load = **yes**; Multi-drag = **whole selection**; Keyboard =
**full navigation**.

## 14. Open questions

- "Apply to all remaining conflicts" in a batch: include in v1 (assumed yes). If batch drops
  are rare, it could slip to Vision — non-blocking; default is to build it.

---

### Self-audit
All template sections filled. UI module (§8–11) complete: state catalog, interaction
inventory, a11y (keyboard, focus, live region, reduced motion, color), and tokens — none
skipped. i18n addressed as a deliberate convention-match (no framework), flagged in §10/§12.
Edge cases cover zero/one/many (multi-drag, batch conflicts), descendant-drop, kind-mismatch
replace, EXDEV, unresolvable OS paths, reduced-motion. Host contract change (`onConflict` +
`EEXIST`) specified with back-compat default.

**Reviewer-hardened (fresh-eyes pass):** added the batch IPC threading model (N single-item
calls + "apply to all" policy), the non-empty-folder Replace blast-radius warning, partial-batch
failure (state + result semantics + acceptance + per-item undo), in-flight/double-submit guard
(ops not idempotent), Windows case-only rename (two-step) + reserved/invalid-name validation,
conflict-dialog failure/focus states, EXDEV-partial and Keep-both TOCTOU rows, and live-region
wording for skip/cancel. Dropped reliance on deprecated `aria-dropeffect`.
