# F7 — Configurable dockable layout (flagship)

## Goal
Let the user rearrange the workbench: drag the Sessions and Explorer panels into
different positions around the central Terminal/Docs area, resize each, and collapse
the sidebar — all persisted. This replaces the fixed sidebar|center|right grid.

## Model
The workbench is an **ordered list of three regions**: `sessions`, `center`,
`explorer` (a permutation). `center` (Terminal/Docs) is always the flexible 1fr
column; the two side panels have their own widths. Reachable arrangements include:
- `sessions | center | explorer` (default)
- `explorer | center | sessions` (swapped sides)
- `sessions explorer | center` (both panels left)
- `center | sessions explorer` (both panels right), etc.

### Settings
- `layout: string` = comma-joined order, e.g. `"sessions,center,explorer"`.
  Validated to be exactly a permutation of the three; else default.
- Keep `leftWidth` = Sessions panel width, `rightWidth` = Explorer panel width
  (apply regardless of position).

## Layout engine
Switch `.shell` from CSS grid to **flex column**: TopBar (fixed) then a
`.workbench` flex row that renders the three regions **in `layout` order**.
- `center` → flex: 1; side panels → their width var.
- Collapsed sidebar → omit the `sessions` region from the row.

## Docking (drag to rearrange)
- Each side panel has a **grip** in its header (draggable).
- Dragging a panel highlights drop targets on the other regions; dropping the
  dragged panel P **before** target region T reorders via `moveBefore(order, P, T)`
  (reusing src/reorder.ts). Drop on the far edge appends.
- Order persists to settings on drop.

## Resize (per current arrangement)
Replace the fixed left/right `PanelResizers` with a resize handle on each side
panel's **center-facing edge** (right edge if the panel sits left of center, left
edge if it sits right of center). Drag reads the panel's own rect to compute the new
width; persists on release. Works for both single-side and both-on-one-side layouts.

## Components
- `PanelFrame`: wraps a side panel; renders the draggable grip + a title + the
  resize handle on the correct edge; hosts the panel content (Sessions / Explorer).
- App computes `order` from settings.layout, renders the workbench, wires docking +
  resize + collapse.
- Sidebar/RightPane lose their own outer width/grid assumptions (PanelFrame owns
  width + edge); Sidebar keeps its internal header/content.

## Acceptance criteria
1. Default layout matches today (Sessions left, Terminal center, Explorer right).
2. Dragging the Explorer grip to the left of Sessions reorders them; persists across reload.
3. Swapping sides works; both-panels-on-one-side works; center always keeps the flex space.
4. Resize handle on each side panel resizes the correct panel in every arrangement; persists.
5. Collapse still hides the Sessions panel; the rest reflow.
6. Terminal refits after any layout change (ResizeObserver).
7. typecheck + build + tests green; layout validation unit-tested.
