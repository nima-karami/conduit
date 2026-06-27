---
status: active
date: 2026-06-27
---

# Feature Spec: Explorer multi-select (Ctrl/Cmd + Shift range)

**Tier:** FULL   **Feature type:** UI
**One-line request:** "I should be able to use ctrl or shift to multi select and range select on the file explorer"

> **Tier rationale:** multi-surface (a new selection model in `file-tree.ts`, row rendering + pointer handling in `right-pane.tsx`, downstream create-target + context-menu consumers, a11y semantics) and user-facing. Not a one-liner → FULL, UI module non-optional.

> **North star:** mirror VS Code exactly. Every behavioral choice below is "what VS Code does," not an invention. Where VS Code's behavior is itself layered (e.g. additive range with Ctrl+Shift), the deeper layer is sliced to v1, never redesigned.

---

## 1. Problem frame

- **Job:** "When I'm working in the file tree I want to act on several files at once — so let me grab a contiguous block (Shift) or cherry-pick individual rows (Ctrl/Cmd), the same way every file manager and VS Code does."
- **Actors / roles:** the single local user driving the Explorer (Files tab of the right pane). No host/multi-user dimension — selection is pure renderer UI state.
- **Success outcomes (observable):**
  - Ctrl/Cmd-click toggles a single row in/out of the selection without disturbing the rest.
  - Shift-click selects the contiguous run of *visible* rows from the anchor to the clicked row.
  - A plain click collapses to exactly one selected row and re-seats the anchor there.
  - Selection is visible (multiple rows highlighted), and it does not break any existing single-selection consumer (folder-targeted create, reveal highlight, context menu, drag-and-drop).
- **Non-goals (explicitly out of scope):**
  - Bulk *actions* on the selection (delete N, copy N paths, drag N rows, cut/paste N) — selection *mechanics* is the request; bulk operations are a later slice (see §6).
  - Marquee/rubber-band box selection.
  - Selection that spans collapsed (non-visible) descendants.
  - Persisting selection across project switch / app restart.
  - Selecting rows in the **Changes** tab or search-results list (this spec is the **Files tree** only).

---

## 2. Behavior & states

### Primary flow (happy path)
1. User plain-clicks `src/` → selection = `{src/}`, anchor = `src/`, and (because it's a folder) it expands/collapses and becomes the create-target as today.
2. User Ctrl-clicks `README.md` → selection = `{src/, README.md}`, anchor moves to `README.md`. `src/` does **not** collapse.
3. User Ctrl-clicks `README.md` again → it toggles out; selection = `{src/}`. Anchor stays `README.md` (VS Code keeps the anchor on the last Ctrl-clicked row even when toggled off).
4. User Shift-clicks `package.json` → selection becomes the contiguous visible range from anchor (`README.md`) to `package.json`, inclusive, replacing the prior set. Anchor is unchanged (stays `README.md`), so a subsequent Shift-click re-ranges from the same anchor.
5. User plain-clicks `tsconfig.json` → selection collapses to `{tsconfig.json}`, anchor = `tsconfig.json`.
6. User clicks empty space below the tree → selection cleared, anchor cleared (generalizes today's "deselect" at `right-pane.tsx:925`).

### Selection-model operations (pure, over a flattened visible-order list)
The flattened visible order is exactly the `rows` array already built by `walk(roots, 0)` in `FilesView` (`right-pane.tsx:831-838`) — depth-first, only `expanded` dirs contribute children. The model is a pure function family operating on `string[]` (the ordered visible paths) + `Set<string>` (selected) + `string | null` (anchor):

| Gesture (modifier) | Operation | Result |
|---|---|---|
| Plain click | `select(path)` | selection = `{path}`; anchor = `path` |
| Ctrl/Cmd-click | `toggle(path)` | flip `path` in set; anchor = `path` |
| Shift-click | `range(anchor, path, visibleOrder)` | selection = inclusive slice anchor→path in visible order; anchor unchanged. If anchor is `null` or no longer visible, behaves as plain `select(path)` |
| Empty-space click / clear | `clear()` | selection = `{}`; anchor = `null` |

> **Mac note:** the toggle modifier is **Cmd** (`metaKey`) on macOS, **Ctrl** (`ctrlKey`) on Windows/Linux — VS Code's `multiCursorModifier`-style platform split. Shift is Shift on all platforms. A `e.ctrlKey || e.metaKey` test covers toggle cross-platform without per-OS branching.

### Reconciliation when the visible list changes
Selection is keyed by absolute path, not row index. When the tree changes (collapse a dir, refresh/`applyEntries`, rename, delete, drag-move), the model must **prune** any selected path no longer present in the visible order; if the anchor path is pruned, anchor → `null`. Collapsing a folder removes its now-hidden descendants from the visible order → they drop out of the selection (matches VS Code: collapsing deselects hidden children).

### States the feature moves through
See §8 state catalog. Core: *no selection* → *single selection* (today's behavior, preserved) → *multi selection* (new) → back to single/none.

---

## 3. Data / interface contract

Renderer-only; no host round-trip, no `window.agentDeck` call (per CLAUDE.md the renderer holds no source of truth, but transient *UI* selection is legitimately renderer-local, same as today's `selectedDir`/`revealedPath`/`draggedPath`).

New pure module surface (proposed `webview/file-tree-selection.ts`, or added to `file-tree.ts` to sit beside the existing pure tree logic — implementation's call):

```ts
interface SelectionState { selected: ReadonlySet<string>; anchor: string | null; }

const EMPTY_SELECTION: SelectionState;
function selectOne(path: string): SelectionState;            // plain click
function toggle(s: SelectionState, path: string): SelectionState; // ctrl/cmd
function selectRange(s: SelectionState, path: string, visibleOrder: readonly string[]): SelectionState; // shift
function clearSelection(): SelectionState;
function reconcile(s: SelectionState, visibleOrder: readonly string[]): SelectionState; // prune vanished paths + anchor
// Derived: the active/anchor item drives create-target.
function activePath(s: SelectionState): string | null;       // = anchor
```

- **Inputs:** absolute node paths (same string identity as `TreeNode.path`); the visible-order array derived from `roots`. Trust boundary: none — all in-renderer.
- **Outputs:** a new immutable `SelectionState` per operation (pure, like `expandNode`/`collapseNode`).
- **Invariants:**
  - Every path in `selected` is present in the current `visibleOrder` after `reconcile`.
  - `anchor`, when non-null, is a member of `selected` **except** immediately after a Ctrl-toggle-off (VS Code keeps anchor on the toggled-off row). Range and plain-select always leave anchor ∈ selected.
  - Range is contiguous in `visibleOrder` (no skipped rows).
  - Operations never mutate inputs.

---

## 4. Edge cases & failure modes

| Condition | Expected behavior / recovery |
|---|---|
| Shift-click with anchor = null (nothing previously clicked) | Treat as plain `select(target)` (VS Code falls back to single-select). |
| Anchor row collapsed/scrolled away but still in visible order | Range still computed from its index; works. |
| Anchor row no longer visible (its dir collapsed, file deleted/renamed) | `reconcile` set anchor→null; next Shift-click = plain select. |
| Shift-click the anchor itself | Range = just the anchor → single-item selection (no-op-ish, valid). |
| Ctrl-click toggles the **last** selected row off | selection becomes empty `{}`; anchor stays on that path (VS Code parity); next plain/shift click reseats. |
| Click during an active inline draft (create/rename) | Draft commit/cancel rules (`DraftRow`) are unchanged and take precedence; selection gestures apply to committed rows only. Clicking another row while drafting follows existing blur-cancel behavior, then applies the gesture. |
| Folder row plain-clicked | Still expands/collapses **and** becomes the single selection (today a folder click both selects-for-create and toggles expand — preserved). Ctrl/Shift-click on a folder selects **without** toggling expand/collapse (VS Code: modifier-click is selection-only, it does not open/close the folder). |
| File row plain-clicked | Still opens the file (`onOpenFile`) **and** becomes the single selection + anchor. Ctrl/Shift-click on a file selects only — it does **not** open the file (matches VS Code: modifier-click is selection, not activation). |
| Many rows (large tree) | Range is an array slice + Set; O(visible rows). No virtualization change required (tree isn't virtualized today). |
| Drag start on a selected row | Out of scope (multi-drag is v1). MVP: dragging uses the existing single-`draggedPath` flow on the dragged row regardless of selection; the dragged row is not forced into the selection. Documented limitation, not a regression. |
| Right-click | See §9 — right-click on a row **outside** the selection collapses selection to that row; right-click on a row **inside** a multi-selection preserves the selection (forward-compatible with a future bulk menu). MVP menu still operates on the single right-clicked row. |
| Project switch / tab unmount | Selection resets to empty (not cached). `selectedDir` reset points in the project-switch effect (`right-pane.tsx:411-433`) generalize to resetting the whole `SelectionState`. |

---

## 5. Defaults vs. settings

| Decision | Default | Configurable? | Rationale |
|---|---|---|---|
| Toggle modifier | Ctrl (Win/Linux) / Cmd (macOS) | No | VS Code / OS file-manager convention; not a preference. |
| Range modifier | Shift | No | Universal convention. |
| Shift re-ranges from a fixed anchor (not from last range end) | Yes | No | VS Code behavior. |
| Modifier-click on a folder does not expand/collapse | Yes | No | VS Code behavior; avoids surprise toggles while multi-selecting. |
| Selection persistence | None (resets on project switch / restart) | No | Transient UI state; matches `selectedDir`/`revealedPath` today. |
| Create-target under selection | `activePath` (anchor): dir→itself, file→its parent dir, none→project root | No (behavioral) | See Decision D1. VS Code targets the focused item. |

No new user-facing settings. Selection is interaction behavior, not a durable preference.

---

## 6. Scope slicing

- **MVP (must):**
  - Pure selection model (`selectOne`/`toggle`/`selectRange`/`clearSelection`/`reconcile`) with unit tests.
  - Mouse: plain / Ctrl(Cmd) / Shift click in the Files tree, with the folder-expand and file-open interplay above.
  - Multi-row visual highlight (`filerow--selected` applied to every selected row).
  - `aria-selected` per row + `aria-multiselectable="true"` on the tree container.
  - Existing consumers keep working: folder-targeted create derives from `activePath`; reveal highlight (`filerow--revealed`) stays independent; context menu operates on the right-clicked row (with the right-click-preserves-selection rule); empty-space click clears.
- **v1 (should):**
  - Keyboard selection: Up/Down move active row, Shift+Up/Down extend range, Ctrl/Cmd+A select all visible, Space/Enter activate (roving-tabindex `role="tree"`/`treeitem"`).
  - Bulk context-menu actions on N items: Delete selected, Copy paths, Copy relative paths.
  - Multi-row drag-and-drop (move/copy N) with the existing DnD pipeline + the non-drag menu equivalent (WCAG 2.5.7).
  - Ctrl/Cmd+Shift additive-range (add a new contiguous run to the existing selection) — VS Code's deepest layer.
- **Vision (could):** type-ahead with selection, "Select all of type," selection in search results.
- **Out of scope:** marquee box-select; cross-pane (Changes-tab) selection; selection persistence.

---

## 7. Acceptance criteria

### Declarative (baseline)
- Ctrl/Cmd-clicking an unselected row adds it; Ctrl/Cmd-clicking a selected row removes it; no other row changes.
- Shift-clicking selects every visible row between the anchor and the clicked row, inclusive, and nothing outside that range.
- A plain click results in exactly one selected row, which becomes the new anchor.
- Clicking empty tree space clears the selection.
- Collapsing a folder removes its hidden descendants from the selection.
- A folder/file modifier-clicked does **not** expand/collapse / open; a plain-clicked one still does.
- With N>1 rows selected, the create (New file/folder) target is the anchor's directory (anchor dir → itself, anchor file → its parent), and creating still works.
- Every selected row carries `aria-selected="true"`; the tree container exposes `aria-multiselectable="true"`.

### EARS
- **Event:** When the user clicks a row with no selection modifier, the Explorer shall replace the selection with that single row and set it as the anchor.
- **Event:** When the user clicks a row with the platform toggle modifier (Ctrl/Cmd), the Explorer shall flip that row's membership in the selection and set it as the anchor, leaving all other rows unchanged.
- **Event:** When the user clicks a row with Shift held, the Explorer shall set the selection to the inclusive run of visible rows between the current anchor and the clicked row, without moving the anchor.
- **State:** While more than one row is selected, the Explorer shall render the selected highlight on every selected row simultaneously.
- **Unwanted:** If a selected path leaves the visible order (collapse, refresh, delete, rename), then the Explorer shall remove it from the selection, and if it was the anchor shall clear the anchor.
- **Unwanted:** If the user Shift-clicks while no valid anchor exists, then the Explorer shall fall back to selecting only the clicked row.
- **Event:** When the user clicks empty space in the tree, the Explorer shall clear the selection and the anchor.

### Gherkin (key flows)
```gherkin
Feature: Explorer multi-select
  Background:
    Given the Files tab shows: a.ts, b.ts, c.ts, d.ts in visible order

  Scenario: Ctrl toggle is additive and independent
    Given I have clicked "a.ts" (selection is {a.ts}, anchor a.ts)
    When I Ctrl-click "c.ts"
    Then the selection is {a.ts, c.ts}
    And the anchor is "c.ts"
    And "b.ts" remains unselected

  Scenario: Shift selects a contiguous range from the anchor
    Given I have clicked "a.ts" (anchor a.ts)
    When I Shift-click "c.ts"
    Then the selection is {a.ts, b.ts, c.ts}
    And the anchor is still "a.ts"
    When I Shift-click "d.ts"
    Then the selection is {a.ts, b.ts, c.ts, d.ts}

  Scenario: Plain click collapses a multi-selection and reseats the anchor
    Given the selection is {a.ts, b.ts, c.ts}
    When I click "d.ts" with no modifier
    Then the selection is {d.ts}
    And the anchor is "d.ts"

  Scenario: Collapsing a folder prunes hidden descendants
    Given "src/" is expanded showing "src/x.ts"
    And the selection is {src/, src/x.ts}
    When I collapse "src/"
    Then the selection is {src/}
```

### Runtime observation (executable)
- **Unit (primary gate):** the pure model is fully testable with no DOM — add `test/unit/file-tree-selection.test.ts` (mirrors `test/unit/file-tree.test.ts` style) asserting `selectOne`/`toggle`/`selectRange`/`reconcile` over a flat `string[]` for every row in §7 + the edge cases in §4.
- **Runtime smoke (observable):** extend `test/e2e/explorer.e2e.mjs` (or a sibling scenario on the shared harness) to Ctrl-click and Shift-click rows and assert that the count of `.filerow--selected` / `[aria-selected="true"]` elements matches the expected set, and that a plain click drops it back to 1.

---

## 8. State catalog (UI)

| Component | State | What the user sees | Action / CTA |
|---|---|---|---|
| File tree | No selection | No row highlighted (revealed-file tint may still show, independently) | Click any row to select |
| File tree | Single selection | One row with `filerow--selected` background (`var(--panel-2)`, hover `var(--raise)`) | Ctrl/Shift-click to extend |
| File tree | Multi selection | Every selected row carries the same `filerow--selected` highlight; anchor row not visually distinguished in MVP (VS Code only distinguishes focus, which is v1 keyboard) | Plain click to collapse; Ctrl to toggle more |
| File tree | Selected + revealed overlap | A row that is both selected and the revealed/open file shows both classes; selection background composes with the accent tint (verify legibility) | — |
| File tree | Loading / empty / first-run | Unchanged: `EmptyState` "Loading…" / "No files" — no selection possible | — |
| File tree | Inline draft active | Draft row is non-selectable; gestures apply to committed rows only | Enter commits / Esc cancels (unchanged) |

Selection has no loading, error, offline, permission, not-found, or saving states — it is synchronous renderer-local state with no async or host dependency. (Stated to satisfy the catalog rather than left blank.)

---

## 9. Interaction inventory (UI)

| Component | Actions/affordances | Pointer | Keyboard | Touch | Context menu | ARIA role/states |
|---|---|---|---|---|---|---|
| File row (`.filerow`) | select / toggle / range-extend / activate (open or expand) | Plain click = select + activate (open file / toggle folder); Ctrl(Cmd)-click = toggle membership (no activate); Shift-click = range from anchor (no activate); hover highlight unchanged | **MVP:** none beyond today (rows aren't focusable today). **v1:** Up/Down move active, Shift+Up/Down extend, Ctrl/Cmd+A select all, Space/Enter activate, Esc clear | Tap = plain select+activate (no modifier keys on touch; multi-select via long-press is v1, out of MVP scope) | Right-click outside selection → collapse selection to that row then open single-row menu; right-click inside multi-selection → keep selection, open menu (MVP menu still acts on the clicked row) | `role="treeitem"` (v1 for full tree semantics; MVP at minimum sets `aria-selected={true|false}` on each row) |
| Tree container (`.right__scroll--files`) | clear selection; owns multiselect semantics | Click empty space = clear | (v1) Ctrl/Cmd+A | — | Existing root create menu (`openRootMenu`) unchanged | `aria-multiselectable="true"`; `role="tree"` (v1) |

Rules-of-thumb compliance:
- **Every drag action has a non-drag pathway:** multi-drag is v1 and ships *with* its menu-action equivalent (Delete/Copy selected). MVP introduces no drag-only capability.
- **Distinct visual states:** default/hover/selected already exist; focus state arrives with v1 keyboard nav (must be a visible outline, see §10).
- **Color not the only signal:** see §10 (selected rows must carry a non-color cue for the multi-selection case).

---

## 10. Accessibility & i18n (UI)

### Accessibility (WCAG 2.2)
- **`aria-selected`** on every row reflecting membership (MVP). **`aria-multiselectable="true"`** on the container (MVP). This is the screen-reader signal that today's plain `<div>` rows lack.
- **Keyboard operability:** MVP relies on existing pointer + the app's reveal/open paths and does not regress anything; **full keyboard selection (arrows + Shift/Ctrl+A) is v1** and is required for the feature to be fully accessible — flagged as a known MVP gap (Decision D2), not silently dropped.
- **Visible focus:** when v1 keyboard nav lands, the active/focused row needs a visible focus ring that survives forced-colors / high-contrast (do not rely on the `filerow--selected` background alone).
- **Color is not the only signal (Decision D5):** the selected background (`var(--panel-2)`) is a subtle fill. MVP **adds a non-color cue to every selected row** — a left accent bar (`var(--accent)`, e.g. `box-shadow: inset 2px 0 0 var(--accent)` or `border-left`) on `.filerow--selected`. This makes selection legible in forced-colors/high-contrast mode and distinguishes a multi-selection from a single hover, regardless of theme. Paired with `aria-selected` so AT users never rely on the visual at all. (Acceptance: in high-contrast mode a selected row is distinguishable by the accent bar, not only fill.)
- **Announce dynamic results:** selection count changes are conventionally not announced per-row by VS Code; MVP does not add a live region (over-announcing on every click is worse). If v1 adds Ctrl+A, a polite live-region "N items selected" is the right place — flagged, not built in MVP.
- **Reduced motion:** selection has no animation; nothing to gate.
- **Drag-and-drop alternative:** N/A in MVP (no multi-drag); v1 multi-drag ships with menu equivalents.

### Internationalization
- **No new user-facing strings in MVP** (selection is silent; highlight only). The repo has **no i18n framework** — all Explorer copy is hardcoded English (`"New file…"`, `"Delete"`, etc.). MVP introduces no copy, so there is nothing to externalize; this matches the established repo convention (documented, not a defect of this feature).
- Any v1 strings (e.g. "N items selected", bulk-menu labels like "Delete N items") must be **plural-aware** (`item`/`items`) — the existing `changes.length !== 1 ? 's' : ''` pattern (`right-pane.tsx:227`) is the in-repo precedent to follow.
- **RTL:** tree indentation is leading-edge `paddingLeft`; if/when the app supports RTL this would mirror, but no RTL support exists today — no new RTL debt introduced.

---

## 11. Design tokens (UI)

- Reuse existing semantic roles — **no new tokens needed for MVP:**
  - Selected fill: `var(--panel-2)` (hover `var(--raise)`) — already defined for `.filerow--selected`.
  - Revealed/open tint: `var(--accent)` mix — already defined for `.filerow--revealed`, kept independent.
- If a non-color selected cue is added (§10), prefer an existing accent role (e.g. a `var(--accent)` left border) over a new hex — per the repo "use design variables, never raw hex" rule.
- Theme variants: the tokens already resolve per theme (light/dark); high-contrast legibility of the multi-select fill is the one thing to verify (§10).

---

## 12. Assumptions

- The flattened visible order for ranges is the existing `walk(roots)` order (depth-first, expanded-only) — confirmed in `right-pane.tsx:831-838`.
- Selection is renderer-local transient state (no host persistence), consistent with `selectedDir`/`revealedPath`/`draggedPath` today.
- `selectedDir` is **removed** (not kept as a parallel fallback) and **replaced** by the new `SelectionState`: the folder-targeted-create target derives from `activePath(state)` rather than a separate `selectedDir` field, so there's one selection source of truth (avoids two divergent "what's selected" notions). Every current `selectedDir` reader/writer migrates: the `useState` at `right-pane.tsx:392`, the reset points in the project-switch effect (`411-433`), the `toggle()` set/clear (`531`,`537`), the empty-space clear (`926`), `resolveCreateTarget`/`createTarget` (`812`,`861`), the `isSelected` row class (`959`), and the toolbar `New file/folder` title/`aria-label` (`900-917`) all read from `SelectionState`/`activePath`. `resolveCreateTarget(selectedDir, projectPath)` becomes `resolveCreateTarget(activePath, projectPath)` with the D1 file→parent rule folded in.
- The reveal/open highlight (`filerow--revealed`) stays a **separate** concept from selection (VS Code also distinguishes the active editor file from the tree selection).
- Cmd on macOS = toggle modifier via `metaKey`; the app already runs on macOS (build target exists), so the platform split is real and handled with `ctrlKey || metaKey`.
- No virtualization exists in the tree, so range over the full visible array is fine.

---

## 13. Decisions Needed (autonomous mode)

- **[normal] D1 — Create-target when the active item is a *file* (or N items selected).** Default taken: create-target = `activePath`'s directory — active dir → itself, active file → its **parent** dir, empty selection → project root. This is VS Code's "target the focused item" behavior and is also what the existing per-file context-menu "New file…" already does (`startCreate(parentDir, ...)`). Note this is a slight change from today's toolbar behavior, where clicking a *file* sets `selectedDir = null` → create at **root**; the new behavior creates as a sibling of the active file. Reversible (one derivation function). If parity-with-old-toolbar is preferred, fall back to: active file → root.
- **[normal] D2 — Keyboard selection scope.** Default taken: **mouse-only in MVP**; arrow-key navigation, Shift+Arrow extend, and Ctrl/Cmd+A are **v1**. Rationale: the verbatim request is "ctrl or shift to multi select and range select," which is pointer gestures; full keyboard tree nav is a larger change (roving tabindex, `role="tree"`). This leaves a real a11y gap until v1 — surfaced here, not hidden. Reversible/additive.
- **[normal] D3 — Bulk actions on the selection.** Default taken: **out of scope for MVP.** The context menu continues to act on the single right-clicked row; right-clicking inside a multi-selection preserves the set (forward-compatible) but the menu shows single-item actions. Multi-item Delete/Copy/drag are v1. Rationale: keep scope to selection mechanics per the brief; nothing existing breaks. Reversible/additive.
- **[normal] D4 — Plain click on a file still opens it.** Default taken: **yes** — plain click selects + opens (preserves today's `onOpenFile` on click) and sets the anchor; modifier-clicks select only (do not open). Matches VS Code single-click-preview behavior and avoids regressing the current open-on-click UX. Reversible.

- **[normal] D5 — Non-color cue for selection.** Default taken (resolved into MVP, see §10): add a left accent bar (`var(--accent)`) to `.filerow--selected` in addition to the fill, so selection survives high-contrast / forced-colors and a multi-selection is distinguishable from a hover. Reversible (one CSS rule). Alternative if visually too heavy: keep fill-only and rely on `aria-selected` + defer the bar to v1 (weaker a11y).

No `high`-severity decisions: every choice is renderer-local, additive, and reversible; none risks data loss or host state.

---

## 14. Open questions

None blocking (autonomous run — all would-be questions captured as D1–D4 above with conservative defaults).

---

## Self-audit

Core spine §1–§7: complete. UI module §8–§11: filled (state catalog, interaction inventory, a11y incl. `aria-selected`/`aria-multiselectable` + keyboard scope, i18n incl. repo's no-framework reality + plural precedent, design tokens). §12 assumptions, §13 decisions (4, all normal), §14 open questions: complete. Acceptance criteria are executable: a pure unit-testable model + a runtime `.filerow--selected`/`aria-selected` count observation. No section left thin without justification (loading/error/offline states explicitly marked N/A with reason). Reviewer: a fresh-eyes self-audit was performed against the template + both UI checklists in lieu of a dispatched sub-subagent.
