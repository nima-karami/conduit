# Spec — Architecture canvas minimap (wishlist F2)

TIER: LITE · TYPE: UI (canvas overlay) · STATUS: ready-to-build

## Problem frame

**Job:** When working on the architecture canvas (`webview/components/architecture-view.tsx`,
React Flow v12), a user who has panned/zoomed away from origin needs a quick spatial
overview — where the nodes are and where the current viewport sits within them — so they
can re-orient and navigate without fully zooming out.

**Today:** The bottom-right `<MiniMap>` renders an empty/near-empty box: it does not show
node silhouettes that mirror the real layout, and it does not show a viewport rectangle
that tracks pan/zoom. So the affordance occupies space but does its job for nobody.

**Actors:** Single local user editing one architecture graph.

**Success outcomes:**
- The minimap shows one filled rectangle per visible canvas node, positioned/scaled to
  mirror the real node layout (silhouette map).
- Node silhouettes are colored by node `kind` (reuse the canvas kind→color mapping) so the
  minimap reads as a miniature of the canvas, not a gray blob.
- A viewport rectangle (the unmasked region) reflects the current view and **moves/scales
  as the user pans and zooms**.
- Drilling into a nested graph re-renders the minimap for that graph's nodes.

**Non-goals:** No new minimap interactions beyond React Flow's built-in pan/zoom-on-minimap
(already enabled via `pannable zoomable`). No persistence, no settings, no new node shapes.

## Behavior & states

- **Empty graph (0 nodes):** minimap shows just the viewport rect over an empty field. No crash.
- **1+ nodes:** one silhouette rect per non-hidden node; bounds auto-fit to node extents +
  current viewport (React Flow default behavior once node rects are non-zero).
- **Pan:** viewport rect translates opposite to pan direction; silhouettes stay put.
- **Zoom:** viewport rect grows (zoom out) / shrinks (zoom in).
- **Drill in/out / graph switch:** minimap recomputes for the new node set.
- **Selected node:** may render with a distinct (selected) color but this is optional polish.

## Interface contract

Inputs the minimap depends on (all already present in the component):
- React Flow node `measured` dimensions (custom `arch` node — `ArchNodeCard`). The MiniMap's
  `NodeComponentWrapper` skips any node where `nodeHasDimensions(node)` is false, so nodes
  **must** report a measured width/height. Root-cause check #1.
- A `nodeColor` (and optionally `nodeStrokeColor`) accessor mapping a node → CSS color, so
  silhouettes are visible against the dark minimap background. Without it React Flow falls
  back to the theme default var which, depending on whether the `.dark` class is on an
  ancestor, can blend into the background. Root-cause check #2.
- Correct minimap element sizing: React Flow computes its SVG viewBox from the `style.width/
  height` passed to `<MiniMap>` (defaults 200×150). The current code sizes the minimap purely
  via CSS and additionally forces `.react-flow__minimap-svg { width:100%; height:100% }`,
  which can desync React Flow's internal sizing math from the rendered box. Root-cause check #3.

## Edge cases & failure modes

- Node with zero measured size (not yet measured on first paint) → silently dropped by
  React Flow; acceptable transiently, must self-heal once `useNodesInitialized` fires.
- Node positioned far off-screen → still appears in minimap (bounds expand to include it).
- Many nodes → unchanged; React Flow handles scaling.
- Color accessor returning `undefined` for an unknown kind → fall back to a sensible default
  color, never transparent.

## Defaults vs settings

- Node silhouette color = node `kind` color (resolved to a concrete color via the existing
  `KIND_VAR` design-variable mapping). Rationale: makes the minimap a faithful, legible
  miniature; matches canvas. No setting exposed (reversible, not a durable preference).
- Mask color: keep current dark translucent mask so the viewport rect is the lit region.

## Scope slicing

- **MVP:** Minimap renders kind-colored node silhouettes mirroring layout + a viewport rect
  that tracks pan/zoom. (This is the whole ask.)
- **Out of scope:** selected-node highlight in minimap (nice-to-have), minimap toggle/resize,
  per-user minimap settings.

## Acceptance criteria (declarative)

1. With ≥1 node on the canvas, the minimap renders exactly one silhouette per non-hidden node.
2. Each silhouette's relative position/size mirrors the corresponding canvas node.
3. Silhouettes are colored by node kind and are clearly visible against the minimap background.
4. A viewport rectangle is visible and its position/size **changes** when the user pans or zooms.
5. Drilling into a nested graph updates the minimap to that graph's nodes.
6. Empty graph renders the minimap without error.
7. `npm run verify` and `npm run build` pass; Biome style preserved.

## Decisions Needed

none
