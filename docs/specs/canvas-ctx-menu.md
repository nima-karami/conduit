# Spec — Canvas context menu (wishlist F1, "canvas-ctx-menu")

## Summary

Right-clicking on the architecture canvas opens an app-styled context menu, built
on the shared `webview/components/context-menu.tsx` component. Two distinct menus:

- **Node menu** (`onNodeContextMenu`) — actions scoped to the right-clicked node.
- **Pane menu** (`onPaneContextMenu`) — canvas-level actions, anchored to the
  blank pane at the cursor.

This is the canvas consumer of the shared menu system already used by the file
tree, change list, session list, and editor tabs. It shares the menu design with
[E5]/[G1].

## Scope (LITE)

Wire the two menus to **existing** doc-model operations in `src/architecture.ts`.
No new model reducers, no new node kinds (that's F4), no new subsystems.

## Behavior

### Node menu (right-click a node card)

Anchored at `event.clientX/clientY`. Items (all wired to existing ops):

| Item | Wired to |
|------|----------|
| Rename… | selects the node + focuses the Inspector title (sets `selectedId`, marks title for focus); falls back to selecting so the user can edit in the Inspector |
| Open / Create nested canvas | `drillInto(node.id)` → `ensureChildGraph` |
| Add connected node | `addNode` (offset from this node) + `addEdge(source=this, target=new)` |
| Duplicate | `addNode` copying title/subtitle/kind, offset position |
| Delete node *(danger, separator)* | `removeNode(graphId, node.id)` |

The drill item's label reflects whether a child graph already exists ("Open
nested canvas" vs "Create nested canvas"), matching the Inspector/drill button.

### Pane menu (right-click blank canvas)

Anchored at `event.clientX/clientY`. The add position is computed from the event
via React Flow's `screenToFlowPosition` so the node lands under the cursor.

| Item | Wired to |
|------|----------|
| Add component here | `addNode` at the cursor flow-position |
| Fit view *(separator)* | `rf.fitView(...)` |

## States & edge cases

- Only one menu is open at a time (single `menu` state); opening one replaces any
  open menu. `onClose` clears it and is idempotent.
- `event.preventDefault()` is called in both handlers so the native browser menu
  never shows.
- The shared menu dismisses on Escape, click-outside, scroll (capture-phase),
  blur, resize, and item activation — acceptable for the canvas (a pan/scroll
  closes it, which is expected).
- Right-clicking a node opens the node menu (React Flow stops the pane handler for
  that case); right-clicking empty canvas opens the pane menu.
- "Add connected node" and "Duplicate" select the newly created node so it's
  immediately visible in the Inspector.

## Acceptance criteria

1. Right-clicking a node opens an app-styled menu (`.ctxmenu`) with node actions.
2. Right-clicking the blank pane opens an app-styled menu with canvas actions.
3. Delete removes the node and its incident edges (existing `removeNode`).
4. "Add component here" adds a node at the cursor position.
5. The menu visually matches the app's other context menus (same component/CSS).
6. `npm run verify` and `npm run build` pass.

## Non-goals

- New node kinds / per-kind icons (F4).
- Persisted-format changes (F0).
- Any new model reducer — pure UI wiring of existing ops.
