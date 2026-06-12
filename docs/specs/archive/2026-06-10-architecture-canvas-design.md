# Architecture Canvas — design

**Goal:** A visual, editable, NESTED architecture diagram for Agent Deck. An agent
can generate a high-level component/box diagram; the user edits it on a canvas;
clicking a component drills into a nested sub-canvas for that component. Replaces
flat-markdown reading of architecture — read the high level, then drill into a
slice and add detail there. (Pencil.dev-for-architecture; Grasshopper-like feel.)

## Library decision

**@xyflow/react v12 (React Flow), MIT.** It is the canonical React node-edge editor:
custom nodes are plain React components, built-in pan/zoom/drag/connect/handles,
minimap + controls + dotted background, fully client-side (no server), bundles via
esbuild (CSS import like Monaco's). Considered tldraw (freehand/whiteboard-leaning;
graph UIs are possible but not its sweet spot) and a hand-rolled SVG canvas (would
re-implement pan/zoom/connect for no benefit). The drill-down nesting is a custom
layer regardless, so React Flow's strong base is the best fit.

## Data model — `src/architecture.ts` (pure, unit-tested)

A document is a TREE OF GRAPHS. Each node may own a child graph (its nested canvas).

```ts
type ArchKind = 'service' | 'ui' | 'data' | 'external' | 'group' | 'note';
interface ArchNode { id; title; subtitle?; description?; kind?; x; y; childGraph?; }
interface ArchEdge { id; source; target; label?; }
interface ArchGraph { id; title; nodes: ArchNode[]; edges: ArchEdge[]; }
interface ArchDoc { version: 1; rootGraph: string; graphs: Record<string, ArchGraph>; }
```

Pure helpers (tested): `seedArchitecture()`, `addNode`, `updateNode`, `removeNode`
(also prunes the node's child graph subtree + incident edges), `addEdge`, `removeEdge`,
`ensureChildGraph(doc, nodeId)` (creates+links a child graph, returns its id),
`serializeArchitecture`/`restoreArchitecture` (version-checked, validates shape,
drops unknown keys, repairs dangling refs). Persisted as `architecture.json` in the
ACTIVE PROJECT's root, so each project has its own architecture and an agent working
in that project can generate/maintain the file (shared, like `board.json`).

## Host integration (`electron/main.ts`, `src/protocol.ts`)

- `requestArchitecture { path }` → host reads `<path>/architecture.json`, replies
  `architecture { path, doc | null }` (null ⇒ webview seeds a starter doc).
- `updateArchitecture { path, doc }` → host writes the file (debounced by webview).
- Mock bridge: `requestArchitecture` returns a seeded sample; `updateArchitecture`
  stored in-session, so the browser preview is fully interactive.

## UI (`webview/components/ArchitectureView.tsx` + custom node)

Full-screen overlay (like `BoardView`), opened from a TopBar button, the command
palette, and a shortcut (`Mod+Shift+A`, rebindable via SHORTCUT_ACTIONS).

- **Breadcrumb bar**: `root › Component › Sub` — a navigation stack of graph ids;
  click a crumb to pop back.
- **Canvas**: `<ReactFlow>` with a custom `ArchNodeCard` (title, subtitle, kind
  colour stripe, a "drill in" chevron when it has/【＋】 a child graph), dotted
  `<Background>`, `<Controls>`, `<MiniMap>`. Node drags persist position; dragging
  between handles calls `onConnect` → adds an edge.
- **Drill-down**: double-click a node (or its chevron) → `ensureChildGraph` then push
  its graph onto the stack. Breadcrumb navigates back.
- **Inspector** (right rail, when a node is selected): edit title/subtitle/kind/
  description; "Open nested canvas"; delete.
- **Toolbar**: Add component, Fit view, autosave indicator.
- **Persistence**: debounced `updateArchitecture` on any change; reloads when the
  active project changes.

## Theming
React Flow reads CSS vars; the custom node + edges use the app's `--panel`,
`--border`, `--accent`, kind colours from existing theme vars so it matches the app
and every theme. Surface honours the v2 translucency where practical.

## Scope (this build)
In: model + tests, host file I/O, the canvas with add/edit/connect/delete, nested
drill-down with breadcrumb, inspector, per-project persistence, agent-generatable
JSON, seeded sample, palette/topbar/shortcut entry. Out (future): auto-layout,
edge re-routing styles, multi-select grouping, undo/redo, live agent streaming.
