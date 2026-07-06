---
status: active
date: 2026-07-06
tier: FULL
type: UI
slice: B
epic: architecture-node-graph
---

# Architecture node-graph — Navigation & hierarchy (slice B)

**Tier:** FULL   **Feature type:** UI
**One-line request:** Drill arbitrarily deep into components; Escape steps up one level (exits only at root); a clickable breadcrumb of the full path; back/forward across visited levels (mouse + keyboard); per-level pan/zoom/selection memory; render the parent interface (`boundary:in`/`boundary:out`) inside a child.

> **Reads the foundation contract** `docs/specs/2026-07-06-arch-foundation-ports-types.md` (slice F).
> That file owns the data model, the port/interface types, and the **boundary convention**
> (`boundary:in`/`boundary:out` derived nodes, §"Boundary convention"). This slice **renders**
> that convention and owns all navigation between graph levels. It does **not** change the model.
>
> **Cross-slice ownership** (named, not specced here): node visuals / leaf-vs-parent styling / inline
> title edit = **A**; port wiring gesture + typed-edge creation (incl. boundary edges) = **F**; context
> menus = **C**; grouping / encapsulate / explode = **D**; complex-interface authoring UI = **E**.

## 1. Problem frame

- **Job (JTBD):** As the architect drills from a high-level system view into progressively finer
  slices, they need to always know *where they are* in the tree, move up/down/back/forward without
  losing their place, and — inside a nested component — *see the contract their parent exposes* so
  they can wire the internals against it. Today the canvas can drill one level via a chevron and
  shows a breadcrumb, but Escape nukes the whole canvas from any depth, there is no back/forward,
  the view refits from scratch on every hop (losing pan/zoom/selection), and a child graph has no
  representation of its parent's interface.
- **Actors:** the human architect (navigating in Conduit). The coding agent reads the *structure*
  (`.conduit/architecture.json`) but does **not** consume navigation state — navigation is pure UI
  and MUST NOT be written into the agent-facing doc (see §3, invariant NAV-1).
- **Success outcomes (observable):**
  1. From any component the architect can open its child graph (double-click body or drill button),
     recursively, with no depth limit.
  2. Inside a nested graph, Escape returns to the immediate parent; only at the root does Escape
     leave the canvas.
  3. The breadcrumb always shows the full root→current path; clicking any segment jumps to that level.
  4. Back/forward (mouse thumb buttons + keyboard) retrace the exact levels visited, in order.
  5. Re-entering a level restores the pan, zoom, and selection the architect left it at.
  6. A child graph whose parent component declares ports shows read-only `boundary:in`/`boundary:out`
     nodes surfacing those ports, positioned so internal components can be wired to them (wiring = F).
- **Non-goals:** node/edge visual design and inline title editing (A); the wiring gesture and typed-edge
  semantics (F); context menus (C); persisting navigation/view state into `architecture.json` or across
  app restarts (explicitly ephemeral, §5); multi-window sync of canvas navigation.

## 2. Behavior & states

### 2.1 Primary flow (happy path)

1. Canvas opens at `doc.rootGraph` (existing `openArchitecture` / center view `canvas`). Level history
   = `[root]`, current index 0. View fits to content (first visit).
2. Architect double-clicks a component **body** (or its drill chevron) → `ensureChildGraph` yields the
   child graph id → the canvas pushes that level onto the history, saves the parent level's view-state,
   and shows the child. If the parent component has ports, `boundary:in`/`boundary:out` render.
3. Architect drills deeper; each hop pushes a level. Breadcrumb grows root › … › current.
4. Architect presses **Escape** (nothing selected, no inline editor open) → steps up one level to the
   parent, restoring that level's saved pan/zoom/selection.
5. At the **root**, Escape (nothing selected/open) closes the canvas back to the editor view.
6. **Back** (thumb button / keyboard) returns to the previously *visited* level (which may be a sibling
   reached via a breadcrumb jump, not necessarily the parent); **Forward** replays.

### 2.2 State catalog

See §8 for the per-component table. The navigation feature itself moves through these logical states:

- **At root** — breadcrumb has one segment; Escape closes the canvas; Up-affordance disabled.
- **Nested (depth ≥ 1)** — breadcrumb ≥ 2 segments; Escape steps up; boundary nodes present iff the
  parent component declares ports.
- **Can-back / can-forward** — independent booleans derived from the level-history index (mirrors
  `canBack`/`canForward` in `src/nav-history.ts`).
- **Target-level-dead** — a level in history (or the current one) whose graph was removed underneath
  the architect (agent proposal accepted, node deleted). Recovery in §4.
- **Deep-path overflow** — breadcrumb longer than the fit threshold; middle segments collapse (§8).
- **Transient-editor-open** — an inline edge-label editor (existing) or port-rename editor (F) or open
  context menu (C) is capturing input; Escape/back precedence yields to it (§2.3).

### 2.3 Escape & back/forward precedence (the load-bearing rule)

Escape is currently a single unconditional `useEscapeKey(onClose)` on `window` that closes the canvas
from any depth. This slice replaces that with an ordered, canvas-scoped handler. **Focus scoping (same
rule as back/forward):** the canvas Escape ladder runs only while the canvas is the active center view
**and** focus is within the canvas surface — an Escape pressed while the **terminal** (or any non-canvas
focusable surface docked alongside) is focused is not hijacked by the canvas and reaches that surface,
mirroring `test/e2e/shortcut-precedence.e2e.mjs`. **When focus is within the canvas, a keydown of Escape
is resolved in this order; the first match consumes the event (`stopPropagation` + `preventDefault`) so
nothing further up sees it:**

1. **A modal/overlay owns it first.** If a globally-stacked surface is open *over* the canvas — command
   palette, settings, confirm dialog, context menu (C), a native/host dialog — that surface's own
   Escape handling wins and the canvas handler does not run. (These render above the canvas and already
   self-manage Escape; the canvas handler must be registered so it does not pre-empt them.)
2. **An in-canvas inline editor owns it.** An open edge-label input (existing `EdgeLabelInput`, already
   `stopPropagation`s Esc) or a port-rename input (F) cancels its edit and keeps the current level.
3. **A selection is cleared.** If a node or edge is selected (and no editor/overlay is open), Escape
   clears the selection and stays on the level. *(Decision D2 — conventional canvas behavior; means
   leaving a level with something selected takes two Escapes.)*
4. **Step up one level.** If depth ≥ 1 (current graph ≠ root), Escape navigates to the parent graph.
5. **Close the canvas.** At the root with nothing selected/open, Escape closes the canvas
   (`setCenterView('editor')`), the current behavior — but now only at the root.

**Back/forward** (mouse thumb buttons + keyboard, §9) traverse the **level history**, not the parent
chain: Back returns to the *previously visited* level and Forward re-advances. Precedence: while the
canvas is the active center view **and** focus is within the canvas, the canvas consumes a
back/forward gesture if its level-history can move in that direction; if it cannot (e.g. Back at the
oldest visited level), the gesture **falls through** to the app's global center-view nav
(`navBack`/`navForward` in `webview/use-nav-history.ts`) so global Back still works from inside the
canvas. *(Decision D3.)* Back/forward **never close the canvas** — only Escape-at-root does. *(D8.)*
Like the app's terminal-focus rule (`test/e2e/shortcut-precedence.e2e.mjs`), a back/forward key pressed
while the **terminal** is focused is not hijacked by the canvas.

## 3. Data / interface contract

Navigation is UI state held in the canvas component; it is **not** part of `ArchDoc` and MUST NOT be
serialized (invariant NAV-1). The model additions needed by A–F live in slice F; this slice adds only
**pure, read-only navigation helpers** to `src/architecture.ts` (unit-tested, matching the existing
`breadcrumb`/`descendantGraphIds` style):

```ts
// The parent node + graph that owns a child graph, or undefined for the root (and for an ORPHAN:
// a child graph whose parent node was deleted but whose graph object still lingers in doc.graphs).
// The caller resolves nodeId against doc.graphs[graphId].nodes to read the parent's inputs/outputs.
function parentOf(doc: ArchDoc, childGraphId: string): { graphId: string; nodeId: string } | undefined;

// Already exists: breadcrumb(doc, graphId) → [{id,title}] root→current (used for the crumb bar
// and to resolve the ancestor chain for recovery). B reuses it; does not change it.
```

Canvas-local navigation state (in-memory, ephemeral):

```ts
interface LevelHistory {           // browser-style, mirrors NavState in src/nav-history.ts
  stack: string[];                 // visited graph ids, in order
  index: number;                   // current position; NAV_STACK_CAP-bounded, dead entries skipped
}
interface LevelViewState {         // remembered per graph id while the canvas is open
  viewport: { x: number; y: number; zoom: number };
  selectedIds: string[];           // last-selected node/edge ids on that level (React Flow allows
                                   // multi-select); restore only ids still present in the graph
}
type ViewStateByGraph = Record<string /* graphId */, LevelViewState>;
```

- **Inputs:** the live `ArchDoc` (from the host, already loaded), the current `graphId`, and pointer/key
  events. Trust boundary: the doc is validated on load by `restoreArchitecture` (F extends it); navigation
  never trusts a `graphId` it holds without re-checking it still resolves (§4).
- **Outputs:** which `graphId` is shown; the derived breadcrumb; enabled/disabled state of
  up/back/forward; the React Flow `viewport`; and, for a child level, the **derived** boundary nodes
  (built at render time by resolving `parentOf(doc, graphId).nodeId` to the parent node and reading its
  `inputs`/`outputs`; never stored — F §"Boundary convention").
- **Invariants:**
  - **NAV-1:** no navigation, history, or view-state field is ever written to `architecture.json`.
    `serializeArchitecture` output is byte-identical whether or not the architect navigated.
  - **NAV-2:** the shown `graphId` always resolves to a graph **reachable from `rootGraph`** (not merely
    present in `doc.graphs`); if it becomes unreachable — deleted or orphaned — recover to the nearest
    live ancestor / root (§4).
  - **NAV-3:** boundary nodes are read-only inside the child (no rename/add/remove/delete/reposition-persist);
    they are a *view* of the parent's ports (single source of truth = the parent node), per F.
  - **NAV-4:** the level-history and view-state maps are bounded (`NAV_STACK_CAP`; view-state pruned to
    graphs still present in the doc) so a deep/long session cannot grow them without bound.

## 4. Edge cases & failure modes

| Condition | Expected behavior / recovery |
|---|---|
| Drill into a node with no `childGraph` | `ensureChildGraph` creates+links an empty child (existing); navigate into it. |
| Arbitrary depth | No depth cap. Breadcrumb collapses overflow (§8); history bounded by `NAV_STACK_CAP`. |
| Current level's graph removed underneath (agent proposal accepted, parent node deleted) | Detect that `graphId` no longer resolves; walk `breadcrumb`/`parentOf` to the nearest **live** ancestor (root if none); announce the jump via live region. Never render a dead/empty dead-end. |
| Current graph is **orphaned** — still present in `doc.graphs` but its parent node was deleted, so `breadcrumb` returns `[]` (no root→current path) | Treat as level-died even though `graphId` resolves: `parentOf` returns `undefined` and the breadcrumb is empty → recover to `rootGraph`, announce via live region. NAV-2 checks *reachability from root*, not mere existence. |
| A history entry points at a since-deleted graph | Back/forward **skip** it and land on the nearest live entry in that direction (inject an `isAlive` predicate into traversal, exactly as `src/nav-history.ts` `step` already does); dead entries stay in the stack, only skipped. |
| Breadcrumb jump to a level not yet in forward history | Truncates forward history and pushes (browser semantics, `record`). |
| Escape with an inline editor / overlay open | Editor/overlay consumes it (precedence §2.3, steps 1–2); level unchanged. |
| Escape with a selection but no editor | Clears selection first (D2); a second Escape steps up/closes. |
| Back at oldest visited level / Forward at newest | Canvas can't move that direction → gesture falls through to global `navBack`/`navForward` (D3); if that also can't move, no-op. |
| Parent component declares **no** ports | No boundary nodes render in the child (nothing to surface) — matches F: boundary shown *iff* the parent has declared ports. |
| Parent declares only inputs (or only outputs) | Only the corresponding boundary node renders (`boundary:in` xor `boundary:out`). |
| Parent declares **many** ports | The boundary node grows with its pins; the per-node pin layout/wrap/scroll treatment is **A's** concern (same as any node's port layout) — this slice only places the two boundary nodes and marks them read-only. |
| Root graph (no parent) | No boundary nodes; Up/Escape-step-up disabled; Escape closes the canvas. |
| Reopen canvas after closing | Resets to root; level history and view-state cleared (D7) — ephemeral by design. |
| Doc reloaded from host (project switch, external file change) | Reset to `rootGraph`, clear history + view-state, clear selection (matches the existing `architecture` message handler). |
| Very deep path + tiny window | Breadcrumb overflow-collapses; back/forward + Escape remain the reliable path up. |
| Reduced-motion preference | fitView / step animations use zero/near-zero duration; navigation still completes (§10). |

## 5. Defaults vs. settings

| Decision | Default | Configurable? | Rationale |
|---|---|---|---|
| Drill gesture | Double-click node **body** OR drill chevron | No | Matches today's affordance; keeps drilling discoverable. A owns whether double-click on the *title* edits instead (D1). |
| Escape at depth | Step up one level | No | The whole point of this slice; a toggle would undercut it. |
| Escape clears selection before stepping up | Yes | No | Conventional canvas behavior; reversible per keystroke (D2). |
| Back/forward binding | Reuse global Alt+Left / Alt+Right + mouse thumb buttons, scoped to canvas focus, falling through when the canvas stack is exhausted | No | Reuses existing muscle memory + the mouse-nav plumbing; avoids a second binding to learn (D3). |
| View-state (pan/zoom/selection) memory | Remembered per level **while the canvas is open**, in memory only | No | Ephemeral UI state; persisting it would pollute the agent-facing doc (NAV-1) or need a new store — out of scope (D4). |
| Boundary node placement | Auto: `boundary:in` at the left edge of content, `boundary:out` at the right; not user-movable in v1 | No | Position isn't stored (F: derived, not in `nodes[]`); auto-placing keeps in→out reading order without a side-channel store (D5). |
| Breadcrumb overflow | Collapse middle segments beyond a threshold into a `…` overflow menu; always keep root + current | No | Keeps the bar legible at depth; reversible via the menu (D6). |
| Reopen state | Reset to root, clear history/view-state | No | Predictable fresh entry; the alternative (resume where you were) is a nicety, not MVP (D7). |

## 6. Scope slicing

- **MVP (this slice):**
  - Drill via double-click body + chevron, arbitrarily deep.
  - Escape precedence ladder (§2.3): overlay → inline editor → clear selection → step up → close at root.
  - Breadcrumb: full path, every segment clickable, `aria-current` on the active one, overflow collapse.
  - Level-history back/forward: mouse thumb buttons + keyboard, dead-entry skipping, canvas-focus scoping
    + fall-through to global nav.
  - Per-level pan/zoom/selection memory (in-memory, restore on entry, save on leave).
  - Baseline `aria-live="polite"` announcement of each level change and of a recovery jump (the
    "level N of M" wording is the v1 refinement; the announcement itself is MVP — acceptance §7 depends
    on it).
  - Render read-only `boundary:in`/`boundary:out` nodes derived from the parent's ports, auto-placed,
    as valid (F-owned) wiring endpoints; render existing boundary edges.
  - `parentOf` pure helper + unit tests; NAV-1 serialization invariant test.
- **v1 (should):** an explicit **Up** button in the canvas header (redundant affordance beside the
  breadcrumb); animated level transitions honoring reduced-motion; live-region "level N of M" announcement.
- **Vision (could):** persist per-level view-state for the session across close/reopen; draggable
  boundary nodes with a non-persisted layout store; minimap that reflects the current depth; "jump to
  any descendant" quick-nav.
- **Out of scope:** everything in the cross-slice ownership note (A/C/D/E/F); writing nav state to
  `architecture.json`; cross-window navigation sync.

## 7. Acceptance criteria

### Declarative
- Double-clicking a component body, or clicking its drill chevron, opens that component's child graph;
  this works at any nesting depth.
- Inside a nested graph with nothing selected and no editor open, Escape shows the immediate parent
  graph; at the root, the same Escape closes the canvas.
- The breadcrumb shows the full root→current path; clicking a segment shows that level; the active
  segment is marked and non-navigating.
- Back and Forward (mouse thumb buttons and the keyboard binding) move through the exact sequence of
  levels visited; a level whose graph was deleted is skipped, not shown.
- Leaving a level and returning to it (via up/back/forward/breadcrumb) restores the pan, zoom, and the
  previously selected node/edge if it still exists.
- A child graph whose parent component declares input/output ports shows read-only `boundary:in`/
  `boundary:out` nodes carrying those ports; a parent with no ports shows none.
- Navigating never changes `serializeArchitecture(doc)` output.

### EARS
- **Event:** When the architect double-clicks a component body or activates its drill affordance, the
  canvas shall open that component's child graph, pushing the level onto the history and saving the
  prior level's view-state.
- **Event:** When Escape is pressed in a nested graph with no overlay, inline editor, or selection
  active, the canvas shall navigate to the immediate parent graph.
- **State:** While the current graph is the root and no overlay/editor/selection is active, the canvas
  shall, on Escape, close and return to the editor view.
- **Event:** When a breadcrumb segment is activated, the canvas shall show that level and record it in
  the level history (truncating any forward history).
- **State:** While the canvas is the active center view and focused, the canvas shall route
  back/forward gestures to its level history, falling through to the global center-view navigation only
  when its level history cannot move in the requested direction.
- **Unwanted:** If the currently-shown graph id ceases to resolve to a live graph, then the canvas shall
  navigate to the nearest live ancestor (root if none) and announce the change via a live region.
- **Unwanted:** If a back/forward traversal lands on a history entry whose graph was deleted, then the
  canvas shall skip it and land on the nearest live entry in that direction.
- **Optional:** Where the parent component declares ports, the canvas shall render read-only
  `boundary:in`/`boundary:out` nodes surfacing those ports inside the child graph.
- **Ubiquitous:** The canvas shall never write navigation, history, or view-state into
  `architecture.json`.

### Gherkin (key flows)

```gherkin
Feature: Architecture navigation & hierarchy
  Background:
    Given the architecture canvas is open at the root graph
    And the root component "API" has a child graph

  Scenario: Drill in and step back up with Escape
    When I double-click the body of "API"
    Then the canvas shows API's child graph
    And the breadcrumb reads "System › API"
    When I press Escape with nothing selected and no editor open
    Then the canvas shows the root graph
    And the breadcrumb reads "System"
    When I press Escape again
    Then the canvas closes and the editor view is shown

  Scenario: Escape clears a selection before stepping up
    Given I am inside API's child graph
    And a component in it is selected
    When I press Escape
    Then the selection is cleared and the canvas stays on API's child graph
    When I press Escape again
    Then the canvas shows the root graph

  Scenario: Back skips a deleted level
    Given I visited root, then "API", then "API › Auth"
    And an accepted agent proposal deleted the "Auth" component
    When I press the mouse Back button twice
    Then the canvas skips the deleted "Auth" level
    And lands on the root graph

  Scenario: Per-level view is restored
    Given I panned and zoomed API's child graph and selected a node there
    When I step up to the root and then re-enter API's child graph
    Then the pan, zoom, and that node's selection are restored

  Scenario: Parent interface appears inside the child
    Given "API" declares input port "request" and output port "response"
    When I open API's child graph
    Then a read-only "boundary:in" node exposes "request"
    And a read-only "boundary:out" node exposes "response"
    And I cannot rename or delete them from inside the child
```

## 8. State catalog (UI)

| Component | State | What the user sees | Action / CTA |
|---|---|---|---|
| Breadcrumb bar | Root only | Single non-navigating segment (project name), `aria-current` | — |
| Breadcrumb bar | Nested | root › … › current; each ancestor is a button; current is marked, non-navigating | Click a segment → jump to that level |
| Breadcrumb bar | Overflow (deep path) | root › `…` (overflow button) › parent › current | Activate `…` → menu of collapsed levels |
| Breadcrumb segment | Hover / focus | Segment shows hover/focus affordance (not color-only) | Enter/Space activates |
| Up affordance (v1) | At root | Disabled/hidden | — |
| Up affordance (v1) | Nested | Enabled | Activate → step up one level (same as Escape step-up) |
| Back / Forward controls | Can move | Enabled; reflect thumb-button/keyboard availability | Activate → traverse level history |
| Back / Forward controls | Cannot move (that direction) | Disabled for the canvas; gesture may fall through to global nav | — |
| Canvas body | First visit to a level | Content fit to view (existing `fitView`) | Pan/zoom/select |
| Canvas body | Revisited level | Restored pan/zoom + restored selection (if target still exists) | — |
| Canvas body | Recovered (level died) | Nearest live ancestor shown; live-region announces the jump | — |
| Boundary node (`boundary:in`) | Parent has inputs | Read-only node at the left edge; each parent input shown as an outgoing pin | Wire from a pin → internal input (gesture = F) |
| Boundary node (`boundary:out`) | Parent has outputs | Read-only node at the right edge; each parent output shown as an incoming pin | Wire internal output → a pin (gesture = F) |
| Boundary node | Attempted edit inside child | Rename/add/remove/delete disabled; tooltip "Edit ports on <parent> in <parent graph>" | Follow the breadcrumb up to edit |
| Boundary node | Parent has no ports | Not rendered | — |

## 9. Interaction inventory (UI)

| Component | Actions/affordances | Pointer | Keyboard / shortcuts | Touch | Context menu | ARIA role/states |
|---|---|---|---|---|---|---|
| Component card | Drill into child | Double-click **body**; click drill chevron | Chevron is a focusable button (Enter/Space); Enter on a focused card drills (matches double-click) | Double-tap body; tap chevron | Existing "Open/Create nested canvas" (C owns the menu) | Chevron `button` with `aria-label` "Open nested canvas: <title>" |
| Breadcrumb segment | Jump to level | Click | Tab to focus; Enter/Space activate | Tap | — | `button` inside a `nav` landmark (`aria-label` "Architecture hierarchy"); active segment `aria-current="page"` |
| Breadcrumb overflow `…` | Reveal collapsed levels | Click | Enter/Space opens; arrows move within; Esc closes | Tap | — | `button` `aria-haspopup="menu"`, `aria-expanded`; menu items are `menuitem` |
| Up (v1) | Step up one level | Click | Enter/Space; also Escape (§2.3) | Tap | — | `button` `aria-label` "Up to parent" + `disabled` at root |
| Back / Forward | Traverse level history | **Mouse thumb buttons** (back/forward); on Windows delivered as host `app-command`, on other platforms as DOM buttons 3/4 — reuse the mouse-nav path from the mouse-nav slice; click header controls if present | Keyboard nav binding (Alt+Left / Alt+Right by default), canvas-focus-scoped with fall-through (D3) | — (no standard touch gesture; use breadcrumb/Up) | `button` `aria-label` "Back"/"Forward" + `disabled` when neither canvas nor global can move |
| Canvas (Escape) | Step up / close | — | Escape (precedence ladder §2.3) | — | — | Escape handler scoped to the canvas center view |
| Boundary node | Wire endpoint (read-only otherwise) | Drag from/to its pins (gesture = F) | Keyboard wiring fallback = F; the node itself is focusable and announces read-only | — | May expose "Go to <parent> to edit" (C) | `group`/node with `aria-label` "Read-only interface of <parent>: <name>"; edit controls `aria-disabled` |

Rules honored: every drag path (wiring to boundary pins) has a non-drag pathway (F's keyboard wiring
fallback); drill has pointer **and** keyboard paths; back/forward has mouse, keyboard, and the
breadcrumb/Up alternatives; destructive actions aren't introduced by this slice (navigation is
non-destructive); focus and selection states are visible and not color-only.

## 10. Accessibility & i18n (UI)

**Accessibility (WCAG 2.2):**
- **Keyboard operability:** drill (Enter on card / chevron button), step up (Escape / Up), jump
  (breadcrumb buttons + overflow menu), back/forward (keyboard binding). No navigation action is
  pointer-only. Boundary-node wiring keyboard fallback is F's, but the boundary node is focusable here.
- **Escape semantics** must not trap: the precedence ladder guarantees Escape always does *something*
  predictable (dismiss overlay/editor → clear selection → up → close) and never dead-ends.
- **Visible focus** on every breadcrumb segment, the overflow menu, up/back/forward controls, and the
  drill chevron; must survive forced-colors / high-contrast (don't signal the active crumb by color
  alone — pair `aria-current` with a non-color marker).
- **Accessible names:** all icon-only controls (chevron, back/forward, up, overflow) carry `aria-label`
  built from a localized string + the level/component title.
- **Announce navigation:** a `aria-live="polite"` region announces level changes a sighted user sees
  from the breadcrumb but a screen-reader user would miss — e.g. "Entered <title>" / "Returned to
  <title>" / recovery "That view was removed; showing <ancestor>". (v1: include "level N of M".)
- **Breadcrumb as landmark:** wrap in a `nav` with an accessible name so it's reachable via landmark
  navigation; use an ordered list of segments.
- **Color is never the only signal:** boundary nodes' read-only state is conveyed by label/icon +
  `aria-disabled`, not color; the active crumb by `aria-current` + marker.
- **Reduced motion:** `prefers-reduced-motion` collapses fitView/step animation durations to ~0;
  comprehension never depends on the transition.
- **Focus management:** after stepping up/back/forward, focus lands on a sensible target (the canvas or
  the newly-active breadcrumb segment), not lost to `<body>`. After a **breadcrumb-segment** activation
  focus stays on the now-active segment; after choosing a level from the **overflow `…` menu** (which
  closes the menu) focus moves to the newly-active breadcrumb segment, never orphaned on the collapsed
  trigger.

**Internationalization:**
- **Externalize all strings** via the app's string path: "Open nested canvas", "Up to parent", "Back",
  "Forward", "Architecture hierarchy", the overflow "Show N more levels", boundary read-only tooltip
  "Edit ports on {parent}", and every live-region announcement. No concatenated sentence fragments —
  use parameterized templates (`{title}`, `{parent}`).
- **Pluralization:** the overflow count and any "level N of M" use plural-aware formatting.
- **Text expansion:** breadcrumb segments and boundary labels tolerate ~30%+ longer strings; segments
  truncate with an accessible full title (tooltip/`title`), never dropping meaning; the bar wraps or
  scrolls rather than overflowing the header.
- **RTL:** the breadcrumb separator direction, the left/right placement of `boundary:in`/`boundary:out`,
  and the meaning of Back/Forward vs thumb buttons mirror under RTL — inputs (in) lead, outputs (out)
  trail, matching reading order. *(Directional flow reversal under RTL is a genuine flag — D-rtl.)*
- **Collation:** not applicable (the breadcrumb reflects tree order, not a sorted list).

## 11. Design tokens (UI)

- **Reuse existing semantic tokens** — `--accent` / kind color vars for live nodes and pins,
  `--border-2` for the canvas background grid, existing breadcrumb classes (`arch__crumb*`).
- **Boundary / read-only treatment:** a single muted, "derived/read-only" semantic role — reuse
  `--text-faint` / `--text-dim` (as the current `group`/`library` kinds already do) plus a dashed or
  ghosted border to read as "not editable here". No new palette; the exact visual is A's call — this
  slice needs only a *distinct, muted, non-editable* role, in both light and dark themes and legible
  under forced-colors.
- **Active vs inactive breadcrumb / disabled nav controls:** reuse existing active/disabled token
  treatments (as `arch__crumbbtn--active` already does); disabled back/forward/up use the standard
  disabled affordance, not opacity-only that fails contrast.
- Theme variants: all of the above must hold in light, dark, and high-contrast (the canvas already
  resolves kind colors off the live document for the minimap — §`archNodeColor` — so keep boundary
  colors resolvable the same way, never a bare `var()` in SVG fill).

## 12. Assumptions

- Navigation/view state is **UI-only and ephemeral**; the agent contract (`architecture.json`) is
  untouched (NAV-1). Persisting it is explicitly deferred (D4/D7).
- The level-history model reuses the shape and dead-entry-skipping of `src/nav-history.ts` rather than
  inventing a parallel mechanism; the doc/session nav-history stays separate (a distinct stack).
- `ensureChildGraph`, `breadcrumb`, and `descendantGraphIds` (existing) are the drill/recovery
  primitives; this slice adds only the read-only `parentOf` helper.
- Boundary nodes derive from the parent component's ports as defined by F; if F's port fields are absent
  (legacy doc), the child simply shows no boundary nodes — no error.
- The mouse thumb-button plumbing already exists (mouse-nav slice, `isWindows` app-command path in
  `webview/shortcuts.ts`); this slice hooks the canvas into it rather than re-implementing it.

## 13. Decisions Needed (autonomous mode — conservative defaults taken, all reversible)

- **[normal] D1 — Drill vs inline-title-edit gesture (shared with A).** Default: double-click on the
  node **body** drills; A may claim double-click on the **title text** for inline rename. If A instead
  wants double-click-anywhere to edit, drilling falls back to the chevron + Enter-on-card only. Taken:
  body-drills, chevron-drills; title-edit deferred to A's call.
- **[normal] D2 — Escape clears selection before stepping up.** Default: yes (conventional; costs a
  second Escape to leave a level with a selection). Alternative: step up immediately, ignoring selection.
- **[normal] D3 — Back/forward binding.** Default: reuse the app's `navBack`/`navForward` keyboard
  binding + mouse thumb buttons, scoped to canvas focus, falling through to global center-view nav when
  the canvas level-history is exhausted. Alternative: a canvas-only binding to avoid overloading.
- **[normal] D4 — View-state persistence.** Default: in-memory only, lost on canvas close and app
  restart. Alternative: persist per-session in a webview-local store (vision).
- **[normal] D5 — Boundary node movability.** Default: auto-placed (in→left, out→right), not movable
  (position isn't stored per F). Alternative: allow drag with a non-persisted layout side-channel.
- **[normal] D6 — Breadcrumb overflow threshold.** Default: collapse middle segments beyond a small
  threshold (keep root + current), reveal via a `…` menu. The exact threshold is a visual tuning knob.
- **[normal] D7 — Reopen resets to root.** Default: closing then reopening the canvas starts at root
  with cleared history/view-state. Alternative: resume the last level (vision).
- **[normal] D8 — Back never exits the canvas.** Default: only Escape-at-root closes; Back at the oldest
  level falls through to global nav or no-ops but does not close the canvas.
- **[normal] D-rtl — RTL directional flow.** Default: under RTL, inputs/`boundary:in` lead and
  outputs/`boundary:out` trail (mirrors reading order). Flagged because reversing a directional
  workflow is a legitimate design choice, not an obvious one.

## 14. Open questions

None blocking — all ambiguities are captured as reversible defaults in §13. No `high`-severity flags:
every decision is a per-keystroke/per-render UI choice that can be changed without a data migration
(navigation state is never persisted, NAV-1).

## Self-audit

Core spine: problem ✓ · behavior/states + precedence ✓ · data/interface contract (helpers + invariants,
UI-state shapes) ✓ · edge cases ✓ · defaults/settings ✓ · scope slicing ✓ · acceptance (declarative +
EARS + Gherkin) ✓. UI module: state catalog ✓ · interaction inventory ✓ · a11y/i18n ✓ · design tokens ✓.
Cross-slice ownership stated so B doesn't re-spec A/C/D/E/F. Decisions Needed severity-tagged; none
`high`. No empty sections.
