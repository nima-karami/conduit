# Drag-dock bidirectional (R5)

## The bug

> "When you drag a panel from the left side to replace a panel on the right side
> of it, it doesn't work. It only works the other way around (right to left)."

The workbench (F7 dockable layout) is an ordered permutation of three regions —
`sessions`, `center`, `explorer` — persisted as `settings.layout`
(`src/layout.ts`). A side panel's slim top bar is the drag surface
(`webview/components/panel-frame.tsx`); dropping it onto another region reorders
the array and re-persists.

## Root cause

`webview/app.tsx` `dockHandlers().onDrop` computed the new order with
`moveBefore(order, source, target)` (`src/reorder.ts`). `moveBefore`
**unconditionally inserts the dragged id immediately _before_ the target** — by
design (the F7 spec literally says "dropping the dragged panel P **before**
target region T"). That is only the behaviour a user expects when dragging
**leftward**.

Walk the default order `[sessions, center, explorer]`:

- Right -> left: drag `explorer` onto `sessions` ->
  `moveBefore -> [explorer, sessions, center]`. `explorer` lands on the target's
  left, which is where the user dropped it. **Looks correct.**
- Left -> right: drag `sessions` onto `explorer` ->
  `moveBefore -> [center, sessions, explorer]`. `sessions` is inserted _before_
  `explorer`, so it lands to the target's **left** and never crosses to the
  right side the user dragged toward. **"Doesn't work."**

So re-docking was asymmetric: insertion side was fixed ("before") instead of
following the drag direction. There was no `target > source` guard, no off-by-one
on a post-removal index, and no left-only drop zone — the drop target is the whole
panel (`.panel--droptarget` / `.center--droptarget` is a full-panel outline, so it
carries no left/right bias). The asymmetry lived entirely in the placement math.

## The model

`order: Region[]` (a 3-permutation). Source = the dragged region, target = the
region dropped on. Width vars and the center-facing resize edge are derived from
this order and are unaffected by the fix.

## The fix

Extract the placement decision into a pure, generic, unit-tested function
`webview/dock-reorder.ts`:

```
reorderDock(order, sourceId, targetId):
  drag rightward (source index < target index) -> insert AFTER target
  drag leftward  (source index > target index) -> insert BEFORE target
  drop on self / unknown id -> no-op (same array reference)
```

This makes adjacent swaps and multi-panel moves symmetric: dragging A onto B and
dragging B onto A produce the same swap, and a left panel dropped on a right panel
now lands on the target's right (and vice-versa).

`app.tsx` `onDrop` now calls `reorderDock(order, d, region)` instead of
`moveBefore`. `moveBefore` is untouched (still used for doc-tab reordering via its
own callers) — only the import in `app.tsx` changed. The full-panel drop indicator
is unchanged and remains correct for both directions.

## Tests

`test/unit/dock-reorder.test.ts`: both directions for the real region order,
adjacent swaps (with a same-result-either-way assertion), end-to-end moves, middle
targets, drop-on-self and absent-id no-ops (same-reference), and 2- and 3+-panel
configs.
