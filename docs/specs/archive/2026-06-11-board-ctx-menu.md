# Spec — Board context menu (wishlist G1, "board-ctx-menu")

## Summary

Right-clicking a card on the feature board opens an app-styled context menu, built
on the shared `webview/components/context-menu.tsx` component. This is the feature-
board consumer of the shared menu system already used by the file tree, change
list, session list, editor tabs, and the architecture canvas ([F1]). It shares the
menu design with [E5]/[F1].

- **Card menu** (`onCardContextMenu`) — actions scoped to the right-clicked card.
- **Column menu** (`onColumnContextMenu`, optional) — "Add card" to that column's
  stage, anchored to the blank column area at the cursor.

## Scope (LITE)

Wire the menu(s) to **existing** board-model operations in `src/board.ts`
(`duplicateCard`, `removeCard`, `moveCard`, `updateCard`, `addCard`) and to the
card's **existing inline title edit**. No new model reducers, no new persistence,
no new stages. The board's `STAGES` set (`wishlist`/`planning`/`building`/`done`)
is the source of truth for the "Move to" items.

## Behavior

### Card menu (right-click a card)

Anchored at `event.clientX/clientY`. `event.preventDefault()` suppresses the native
browser menu. Items (all wired to existing ops):

| Item | Wired to |
|------|----------|
| Rename… | focuses the card's existing inline title edit (`begin('title')`) |
| Duplicate | `duplicateCard(board, card.id)` — inserts a "(copy)" after the original |
| Move to <stage> | one item per stage **other than** the card's current stage; `moveCard(board, card.id, stage)` (which is `updateCard` setting `stage`). Separator before the first move item. |
| Delete *(danger, separator)* | `removeCard(board, card.id)` |

The "Move to" items are the `STAGES` list filtered to exclude `card.stage`,
labelled `Move to <stage.label>` (e.g. "Move to Planning"). Because the current
stage is omitted there is always ≥1 and at most 3 move items.

### Column menu (right-click blank column area — optional, LITE-fits)

Anchored at `event.clientX/clientY`. One item:

| Item | Wired to |
|------|----------|
| Add card | `addCard(board, stage.id, 'New card')` for that column's stage |

The column already has a visible "Add card" affordance (the inline `AddCard`
button), so the column menu is a convenience, not the primary path. It is included
because it composes cleanly; if it conflicts with the card menu it is dropped
without affecting acceptance.

## States & edge cases

- Only one menu is open at a time (single `menu` state); opening one replaces any
  open menu. `onClose` clears it (`setMenu(null)`) and is idempotent.
- The card handler calls `e.stopPropagation()` so a right-click on a card does not
  also trigger the column handler underneath; the column handler only fires on the
  blank column area.
- The shared menu dismisses on Escape, click-outside, scroll (capture-phase
  global), blur, resize, and item activation. **Known LITE caveat:** the board
  columns are scroll containers — if right-clicking a card causes the list to
  scroll, the menu closes. Accepted for LITE; the menu still opens at the cursor.
- While a card is in inline-edit mode it is non-draggable; the context menu still
  opens (right-click is independent of drag). "Rename…" entering edit mode is the
  expected interaction.
- Menu mutations route through the same `apply(next)` path as drag/inline edits, so
  they debounce-persist via `updateBoard` exactly like every other board edit. The
  in-memory preview board (fake bridge) updates locally with no host round-trip.
- Each `label` is unique within a menu (React key); the move items are unique by
  stage label.

## Accessibility & i18n

- The shared `ContextMenu` provides the a11y surface: `role="menu"`,
  `role="menuitem"`, `aria-activedescendant`, keyboard nav (Up/Down/Home/End/Enter)
  and Escape. This consumer adds no new interactive controls, so no additional a11y
  wiring is required.
- All labels are static English strings consistent with the rest of the board UI
  ("Rename…", "Duplicate", "Delete", "Move to <stage>", "Add card"); the app has no
  i18n layer, so no externalization is needed (matches existing menus).
- Icons reuse existing glyphs (`IconPencil`, `IconDuplicate`, `IconTrash`,
  `IconPlus`, `IconChevron`/`IconBoard` for move) sized 13 to match other menus —
  no new design tokens.

## Acceptance criteria

1. Right-clicking a card opens an app-styled menu (`.ctxmenu`) with card actions.
2. Duplicate adds a "(copy)" card after the original (existing `duplicateCard`).
3. "Move to <stage>" moves the card to that column (existing `moveCard`); the
   card's current stage is not offered.
4. Delete removes the card (existing `removeCard`) and is styled as danger.
5. Rename… focuses the card's inline title editor.
6. The menu visually matches the app's other context menus (same component/CSS).
7. `npm run verify` and `npm run build` pass.

## Non-goals

- New board-model reducers — pure UI wiring of existing ops.
- Moving `board.json` under `.conduit/` (G0).
- Spec linking / per-phase skills / timestamps (G3/G4/G5 — separate items).

## Decisions Needed

- **Column "Add card" menu inclusion** (`normal`): included because it composes
  cleanly on the column's existing blank area; default new-card title is
  "New card". Reversible — drop the column handler if it interferes with the card
  menu. Card menu alone satisfies G1.
- **"Move to" item labelling** (`normal`): flat items ("Move to Planning", …)
  rather than a nested submenu, because the shared `ContextMenu` is flat (no
  submenu support). Conservative, matches component capability.
