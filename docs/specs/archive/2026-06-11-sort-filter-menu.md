# Spec — Sessions panel sort/filter overflow menu (wishlist D1)

**Tier:** LITE · **Feature type:** UI · **Slug:** `sort-filter-menu`

## Problem frame

**Job-to-be-done:** When I manage many sessions, I want to control how the list is
sorted and grouped without a row of inline controls eating panel width and visual
weight — one tidy affordance I open only when I need it.

**Actor:** Conduit user viewing the sessions (left) panel.

**Today:** The session bar (`webview/components/sidebar.tsx`, `.sessbar`) packs four
inline controls on one row: a free-text filter input, a clear-filter button, a sort
`<select>`, and a group-by-project icon toggle. The `<select>` is off-theme (native
control) and the row is busy.

**Success outcome:** Sort order and project grouping move behind a single three-dot
(overflow) button that opens the app's shared `ContextMenu`, app-styled, with the
current sort + grouping state visibly marked. Every existing capability stays
reachable. The free-text filter input stays inline (it is a search box, not a
discrete control — see Decisions Needed).

**Non-goals:** New sort options; changing sort/group semantics; persisting anything
new; touching the session model, drag/reorder, or grouping render logic.

## Behavior & states

**Affordance:** A three-dot (`⋯`) icon button (`IconMore`) sits at the right end of
the `.sessbar` row, replacing the inline `<select>` and the group-by-project toggle.

**Menu open:** Clicking the button opens the shared `ContextMenu` anchored to the
button. Anchor x/y come from the button's `getBoundingClientRect()`: open below the
button, right-aligned to its right edge (the shared menu clamps to the viewport, so
right-alignment that would overflow left is auto-corrected). Clicking the button
while open, Escape, click-outside, or any scroll dismisses it (shared-menu behavior).

**Menu contents (top → bottom):**
1. A disabled faux-header item `Sort by` (non-interactive section label).
2. One item per `SessionSort` option (`SORT_LABELS`): `Manual order`, `Name (A–Z)`,
   `Recently created`, `Recently active`, `Status`, `Project`. The **active** sort
   carries a check icon (`IconCheck`); the rest have no icon. Mutually exclusive
   (radio-like). Selecting one calls `update({ sessionSort })` and closes the menu.
3. A disabled faux-header item `Group`, with `separatorBefore`.
4. One toggle item `Group by project` that carries a check icon when
   `sessionGroupByProject` is true, none when false. Selecting it flips the boolean
   via `update({ sessionGroupByProject })` and closes the menu.

**Active marking:** The check icon is the active indicator; absence of an icon = not
active. Faux-header items are `disabled` (greyed, non-interactive) and never carry a
check.

**Filter input:** Unchanged — stays inline in `.sessbar` with its clear button.

## Data / interface contract

Pure helper `buildSortFilterMenuItems` (new module `webview/sort-filter-menu.ts`),
React/DOM-free for unit testing. It returns an ordered list of plain specs the
component maps to `MenuItem`s (binding icons + onClick), mirroring the
`editor-menu.ts` pattern.

```ts
interface SortFilterMenuState { sort: SessionSort; groupByProject: boolean; }
type SortFilterAction =
  | { kind: 'sort'; sort: SessionSort }
  | { kind: 'toggleGroup' };
interface SortFilterMenuItemSpec {
  id: string;            // stable id for tests + React keys
  label: string;
  action?: SortFilterAction;   // absent => non-interactive header
  checked?: boolean;     // true => render IconCheck as the item icon
  header?: boolean;      // true => disabled faux-header
  separatorBefore?: boolean;
}
buildSortFilterMenuItems(state: SortFilterMenuState): SortFilterMenuItemSpec[]
```

**Invariants:** exactly one sort item has `checked: true` (the active one); header
items are never checked and never carry an action; the sort items appear in
`SORT_LABELS` order; `Group by project` reflects `groupByProject`.

## Edge cases & failure modes

- **No host bridge / fake shell:** Pure preview — settings still work via the
  settings store, so the menu functions in the browser preview (mock sessions).
- **Viewport overflow:** Anchored near the panel's top-right; the shared clamp keeps
  it on-screen. No custom clamp.
- **Active sort not in label list:** Can't happen — `SessionSort` is closed and
  `SORT_LABELS` covers all variants (guarded by a test asserting parity).
- **Rapid reopen:** Each open recomputes specs from current settings, so the checks
  always reflect live state.

## Defaults vs. settings

No new settings. Reuses `settings.sessionSort` and `settings.sessionGroupByProject`.
Defaults unchanged (`manual`, grouped = true). Closing on select is the default
behavior (simplest; user reopens for a second change) — rationale: avoids an open
menu lingering over the list.

## Scope slicing

- **MVP = v1 (this):** Three-dot button + menu with sort radio group + group toggle,
  active-state checks, inline filter retained, inline `<select>` and group toggle
  removed. Pure builder + unit test.
- **Out of scope:** Moving the text filter into the menu; multi-select filters;
  new sort keys; persisting menu-open state.

## Acceptance criteria

- The inline sort `<select>` (`.sessbar__sort`) and the inline group-by-project
  `IconFolder` toggle are removed from `.sessbar`.
- A three-dot button is present in `.sessbar`; clicking it opens the shared
  `ContextMenu` anchored below/right of the button.
- The menu lists all six sort options; the one matching `settings.sessionSort`
  shows a check; selecting a different one updates the setting and the list reorders.
- The menu shows `Group by project` with a check iff `settings.sessionGroupByProject`;
  selecting it toggles grouping and the list regroups.
- The free-text filter input still works (filters the list; clear button clears it).
- `buildSortFilterMenuItems` is unit-tested: exactly one sort checked, header items
  non-interactive, group toggle reflects state, ordering matches `SORT_LABELS`.
- `npm run verify` and `npm run build` pass.

## UI module (LITE walk-through)

- **State catalog:** button (rest/hover/focus), menu (open/closed), item
  (default/active-checked/disabled-header/keyboard-highlighted — last two from shared
  menu). No loading/empty/error states (synchronous settings).
- **Interaction inventory:** click button → open; click sort item → set sort + close;
  click group item → toggle + close; Escape/outside/scroll → close; keyboard
  Up/Down/Enter nav (shared menu). Filter input typing unchanged.
- **Accessibility:** the three-dot button needs an accessible name (`title`/aria-label
  `Sort & filter sessions`). The shared `ContextMenu` already provides `role="menu"`,
  `role="menuitem"`, `aria-activedescendant`, `aria-disabled`, and keyboard nav —
  reused as-is. Check state should be conveyed beyond color: the check **icon** is a
  non-color indicator (satisfies "don't rely on color alone").
- **i18n:** All labels are existing English `SORT_LABELS` strings + two new literals
  (`Sort by`, `Group`, `Group by project`). App has no i18n framework today; new
  strings are plain literals consistent with the rest of the codebase. No new i18n
  obligation introduced.
- **Design tokens:** Reuse `.iconbtn`/`.iconbtn--sm` for the button and `.ctxmenu*`
  classes for the menu (no new hardcoded colors). The new `IconMore` follows the
  existing `icons.tsx` 16px/currentColor grid.

## Decisions Needed

- **[normal] Free-text filter stays inline, not in the menu.** The wishlist says
  "pick the filter and the sort order," but the only *discrete* filter control in
  this UI is group-by-project; the other "filter" is a free-text search box, which
  doesn't fit a dropdown item. Conservative, reversible choice: keep the search box
  inline (it consumes little weight and is the primary find affordance), move the
  discrete sort + grouping controls into the menu. If a human wants the search in the
  menu too, that's a trivial follow-up.
- **[normal] Group-by-project is modeled as the "filter" half of the menu.** It is the
  closest discrete filter/view control present. Labeled under a `Group` section
  rather than `Filter` to be accurate.

## Self-audit

All core-spine sections present and sized to LITE. UI checklist walked (state,
interaction, a11y, i18n, tokens). No template items skipped. Two reversible decisions
flagged `normal`; none `high`.
