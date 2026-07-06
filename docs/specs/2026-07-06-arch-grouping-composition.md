---
status: active
date: 2026-07-06
tier: FULL
type: UI
slice: D
epic: architecture-node-graph
---

# Architecture node-graph — Slice D: Grouping & composition

**Tier:** FULL   **Feature type:** UI
**One-line request:** Multi-select + move; make a named visual group; encapsulate a
selection into a real nested (complex) component with ports inferred from the boundary
wires; explode a complex component back inline; insert-space "push apart" gesture.

> Built on the **Foundation** spec `2026-07-06-arch-foundation-ports-types.md` (slice F).
> This slice does **not** redefine ports, types, edges, or the boundary convention —
> it *manipulates* them. Where port shape, `sourcePort`/`targetPort`, the document
> `interfaces` registry, or the `boundary:in`/`boundary:out` derived-boundary contract
> is referenced below, F is authoritative. Neighboring slices are named, not specified:
> node visuals / inline rename / inspector chrome = **A**; drill navigation / breadcrumb /
> boundary rendering = **B**; context menus = **C**; interface authoring UI = **E**.

## 1. Problem frame

- **Job (JTBD):** As a graph grows, the architect needs to *organize* it (cluster related
  components, label a region) and *refactor* it (promote a cluster to a real reusable
  nested component, or inline one that no longer earns its own level) — and to *make room*
  on a dense canvas without hand-dragging every node. These are the Grasshopper-style
  composition gestures that turn a flat sketch into a navigable, agent-readable hierarchy.
- **Actors:** the human architect (authoring in Conduit). The coding agent reads the
  *result* — a complex component's inferred port interface is exactly the machine-readable
  contract F exists to produce — but the agent does not drive these gestures.
- **Success outcomes (observable):**
  1. A marquee or Shift/Ctrl-click builds a multi-node selection; dragging any member moves
     the whole selection together.
  2. A selection becomes a **named group** — a labelled box at the *same level* that has no
     interface and moves its members as a unit.
  3. A selection becomes a **complex component** — a real child graph whose ports are
     inferred from the wires that crossed the selection boundary, with external wiring
     reconnected to those ports and internal wiring joined to `boundary:in`/`boundary:out`.
  4. A complex component **explodes** back into its parent: child nodes inline, boundary
     wires splice through, positions offset to avoid a pile-up.
  5. **Insert-space**: a modifier-drag opens horizontal or vertical room, shifting
     everything past the drag line.
- **Non-goals:** port/type/edge/interface *model* (F). Node card visuals, inline title
  edit, group-box styling polish (A). Drill-in/out navigation and how boundary nodes
  *render* (B). The context-menu component and its open/position/keyboard behavior (C) —
  D only lists the *items* it contributes. Interface-authoring UI (E). Undo/redo
  infrastructure (see §5, Decisions). Auto-layout / tidy. Cross-graph copy-paste.

### The one distinction to keep straight: group vs. complex component

| | **Group** (this slice) | **Complex component** (this slice) |
|---|---|---|
| What it is | A visual/organizational cluster | A real nested component (a node with a child graph) |
| Level | Members stay at the **same** level | Members move **down** one level into a child graph |
| Interface | **None** — no ports, no contract | A **derived port interface** (F ports) inferred from crossing wires |
| Boundary | A labelled box drawn around members | `boundary:in`/`boundary:out` (F) inside the child |
| Agent sees | An organizational hint at most | A first-class component contract to build against |
| Reversible by | Ungroup (removes box, keeps nodes) | **Explode** (inlines child graph, splices wires) |
| Drill-in | No child canvas | Yes — B's drill navigation applies |

A group is *cosmetic clustering*; a complex component is *structural nesting*. Encapsulate
produces the second, never the first.

## 2. Behavior & states

### 2.1 Multi-select & move-together

- **Marquee:** hold the marquee modifier (default **Shift**) and drag on empty canvas → a
  rubber-band rectangle; on release, every node **intersecting** the rectangle becomes
  selected (replacing the prior selection). Plain drag on empty canvas still **pans**
  (preserves today's behavior).
- **Additive click:** Shift-click or Ctrl/Cmd-click a node **toggles** it in/out of the
  selection. Plain click = single-select (today's behavior). Click on empty canvas clears.
- **Move together:** dragging any selected node moves **all** selected nodes by the same
  delta; positions commit through the existing `onNodesChange`→`updateNode` path (one
  transaction). Members of a group in the selection move too (a group moves as a unit —
  §2.2).
- Selection is a **set**, replacing today's single `selectedId`. When exactly one node is
  selected, A's Inspector shows the single-component form (today's behavior). When ≥2 are
  selected, the Inspector shows the **multi-select** form: a count and the composition
  actions (Group, Encapsulate) — visual design owned by A; the *actions* are D's.

### 2.2 Named group

- **Create:** with ≥1 node selected, invoke **Group selection** (multi-select inspector
  button, C's context-menu item, or keyboard shortcut). Creates an `ArchGroup` on the
  current graph whose `memberIds` = the selected node ids, with a generated label
  (`Group 1`, `Group 2`, …). The group box is **derived** from member positions (a padded
  bounding box) — it is not a stored rectangle, so it can never drift from its members
  (mirrors F's derived-boundary principle).
- **Rename:** the group label is editable in place (double-click the label → text input →
  Enter/blur commit, Esc cancel; empty reverts to previous). A group must have a label.
- **Move:** dragging the group's label/chrome (empty box area, not a member card) moves all
  members by the drag delta. Dragging a single member moves only that member (the box
  re-derives to still contain it). A member dragged out of the visual box stays a member
  until explicitly removed — membership is by id, not by geometry.
- **Add/remove members:** with a group selected, **Add selection to group** / drag-in;
  **Remove from group** on a member. A node belongs to **at most one** group (joining a new
  group leaves the old). *(Nested groups are out of scope v1 — see Decisions.)*
- **Ungroup:** removes the group box; members remain untouched in the graph.
- **Auto-remove:** a group whose `memberIds` drops to empty (all members deleted or removed)
  is deleted. Deleting a group never deletes members; deleting a member prunes it from the
  group.

### 2.3 Encapsulate → complex component

Invoked as **Encapsulate selection** (multi-select inspector button, C menu item, shortcut)
with ≥1 node selected in graph *G*.

**Effect (single transaction):**

1. Partition *G*'s edges relative to the selection set *S* (`boundary:in`/`boundary:out`
   nodes, when *G* is itself a child graph, are treated as **external** — never members):
   - **internal:** `source ∈ S && target ∈ S`
   - **crossing-in:** `source ∉ S && target ∈ S` (external feeds the selection)
   - **crossing-out:** `source ∈ S && target ∉ S` (selection feeds external)
   - **external:** neither endpoint in *S* — untouched.
2. Create a child graph *C* (via F/`ensureChildGraph`-style creation). Compute the
   selection's top-left origin `(ox, oy)`; move each member into *C* at
   `(x − ox + PAD, y − oy + PAD)` (normalized to child-local space) and remove it from *G*.
   A member that owns its own `childGraph` keeps it — the reference travels with the node
   (graphs are stored flat by id; `descendantGraphIds` still resolves). A group **wholly**
   contained in *S* moves into *C*; a group only **partially** in *S* has its departed
   members pruned from `memberIds` (the group stays in *G* with its remaining members).
3. Create the new complex-component node *K* in *G* at `(ox, oy)`, `childGraph = C`, default
   kind `service`, default title generated (`Component 1`, …) then handed to A's inline
   rename (focused so the user can name it immediately).
4. **Infer input ports** (see §2.5 for the precise rule): one input port per distinct
   internal attachment point `(target, targetPort)` among crossing-in edges. Rewire each
   crossing-in edge: **external side** → an edge in *G* from the original external source
   (keeping its `sourcePort`) to *K*'s new input port; **internal side** → an edge in *C*
   from `boundary:in` (`sourcePort` = the new port id) to the original internal target
   (keeping its `targetPort`). Fan-in is preserved (N external sources → one port → one
   internal attachment).
5. **Infer output ports** symmetrically: one output port per distinct internal source
   `(source, sourcePort)` among crossing-out edges. External side → edge in *G* from *K*'s
   output port to the original external target; internal side → edge in *C* from the
   internal source to `boundary:out` (`targetPort` = the new port id). Fan-out preserved.
6. **Internal edges** move into *C* unchanged.
7. `K.inputs` / `K.outputs` are ordered by first-seen internal attachment (top-to-bottom by
   internal node `y`, then `x`) so pin order reads spatially.
8. Selection becomes `{K}`; the view stays on *G* (no auto-drill; B owns drilling).

### 2.4 Explode a complex component

Invoked as **Explode component** (C menu item / inspector button) on a node *K* in *G* that
has a `childGraph` *C*. If *K* has no child graph, the action is absent/disabled.

**Effect (single transaction), the inverse of encapsulate:**

1. Move each node of *C* into *G* at `(K.x + n.x − PAD, K.y + n.y − PAD)` — subtracting the
   same `PAD` encapsulate added, so an encapsulate→explode round-trip lands positions back at
   the original coordinates (no per-cycle drift). On the rare id collision with an existing
   *G* node, remint the moved node's id and remap its incident internal edges. Each moved node
   keeps its own `childGraph`.
2. **Splice boundary wires** so external neighbors reconnect straight to the internals:
   - For each input port *P* of *K*: `ExtIn(P)` = external endpoints of *G*-edges targeting
     `K.P`; `IntIn(P)` = internal targets of *C*-edges from `boundary:in` with
     `sourcePort = P`. Emit, for every `ext × int` pair, a **freshly-minted-id** *G*-edge
     from `ext.source` (keeping `sourcePort`) to `int.target` (keeping `targetPort`),
     carrying the external edge's label (§2.5). The cartesian product preserves fan-in/out
     semantics; F's `addTypedEdge` dedup drops any pair that would duplicate an existing
     endpoint+port edge.
   - Symmetric for each output port *Q*: `ExtOut(Q)` (external targets of edges from `K.Q`)
     × `IntOut(Q)` (internal sources into `boundary:out` with `targetPort = Q`).
3. Non-boundary internal edges of *C* move into *G* unchanged.
4. Remove *K* and its ports from *G*, and delete **only** *C* — **not** the descendant
   graphs of the inlined nodes. ⚠️ This means explode must **not** call `removeNode` (which
   recursively deletes `descendantGraphIds`); it deletes the single child graph *C* by id
   while leaving the moved nodes' own child graphs intact.
5. **Overlap offset:** the inlined nodes occupy roughly *K*'s footprint expanded to the
   child's bounding box. Reuse the insert-space push-apart primitive (§2.6) to shift
   existing *G* siblings that lie past the inlined bounding box along its larger axis, so the
   inline doesn't pile on top of neighbors.
6. If *K* was a member of a group, the inlined node ids replace *K* in that group's
   `memberIds`.
7. Selection becomes the set of inlined node ids.

**Confirm:** explode discards the wrapper node and its child-canvas layout (the internals
survive, but the component boundary and any notes on *K* do not). Show a confirm dialog
(in-app renderer dialog per the repo's smoke-testability rule) stating what is inlined and
that the component boundary is removed. Encapsulate does **not** confirm (it is
non-destructive and directly reversible by explode).

### 2.5 Port inference & naming rules (the precise contract)

Grouping key — **inputs** group crossing-in edges by their *internal* endpoint
`(target, targetPort ?? '∅')`; **outputs** group crossing-out edges by their internal
endpoint `(source, sourcePort ?? '∅')`. Rationale: a component port represents *its own*
attachment point, so two external sources feeding the same internal input are one input
port (fan-in), not two.

Per derived port:

- **id:** freshly generated, stable (F port id rules).
- **name:** if the internal endpoint names a real F port, **inherit that port's name**; else
  derive from the internal node's title (slugified, e.g. `authService`); on collision within
  the component's inputs (or outputs), append `-2`, `-3`, …; final fallback `in{n}` / `out{n}`.
- **type:** inherit the internal port's `TypeRef` when the endpoint is a typed port; else
  **untyped**. A `ref` type inherited this way keeps pointing at the same `doc.interfaces`
  entry (the registry is document-level per F — no copy needed).
- **Legacy (port-less) internal endpoint:** the internal boundary edge is written with the
  boundary `sourcePort`/`targetPort` set and the internal side's port left unset — a
  whole-node attachment on the internal node, which F permits (a half-typed edge is valid;
  only an edge naming a *missing* port is dropped). The next port added to that internal node
  (F's forward-migration) does not retroactively rewrite it.

- **Edge labels across the boundary:** a crossing edge's `label` (F `ArchEdge.label`) is a
  property of the connection, so on split it rides the **external** edge (the one the user
  still sees at this level); the internal `boundary` edge is created label-less. On
  **explode**, each cartesian-spliced edge inherits the label of the **external** edge in the
  pair (the internal boundary edges were label-less). Internal-only edges keep their labels
  verbatim through both ops.

### 2.6 Insert-space (push apart)

The Grasshopper "make room" gesture — open (or tighten) a band of space without dragging
each node.

- **Trigger:** hold the insert-space modifier (default **Alt/Option**) and press-drag
  starting on the **empty pane** (not on a node/group box/pin). Releasing on a node aborts
  as a no-op.
- **Guide line & anchor:** the guide is anchored at the **drag-start point** in flow space.
  As soon as the drag exceeds a **6px** threshold, the axis **locks** to the dominant
  direction: `|dx| > |dy|` → **horizontal** axis (a **vertical** guide line at
  `origin.x`); otherwise **vertical** axis (a horizontal guide line at `origin.y`). The line
  renders live and axis stays locked for the rest of the drag.
- **What moves — the test coordinate is the node's position `(x, y)` (its top-left origin,
  the stored `ArchNode.x/y`), not its center or bounding box.** Horizontal axis: every node
  with `x ≥ origin.x` shifts by the live `dx`; nodes with `x < origin.x` stay put. Vertical
  axis: every node with `y ≥ origin.y` shifts by `dy`. Edges follow their endpoints
  automatically (nothing edge-specific to move).
- **Groups:** insert-space operates on **nodes**, never on group membership. A member on the
  far side shifts; a member on the near side does not — so a group straddling the guide line
  **stretches**, and its derived box grows to still contain all members (intended: the
  gesture makes room *inside* a region too). Group boxes are not independently moved; they
  re-derive from their members' new positions.
- **Sign / clamp:** the shift is signed. `dx > 0` (or `dy > 0`) **opens** space (push the far
  side away). A negative drag **tightens**: the far side moves back toward the line, but each
  affected node is **clamped** so its coordinate never crosses `origin` into the near cluster
  (a node can reach the line, not pass it).
- **Commit / abort:** the shift previews live and commits as **one** transaction on release;
  **Esc** aborts and restores original positions.
- **Non-pointer path:** an "Insert space…" command (pane context menu C / keyboard) prompts
  for **axis** + a signed **amount**, applying the same rule about the current viewport
  center; a screen-reader user hears the delta announced (§10). This satisfies the WCAG 2.5.7
  drag alternative.

## 3. Data / interface contract

D adds one optional collection and otherwise **only reuses F's model**. All additions are
optional so existing docs load unchanged.

```ts
interface ArchGroup {
  id: string;              // STABLE
  label: string;          // "Group 1" — organizational only, never an interface
  memberIds: string[];    // node ids in THIS graph; box is derived from their positions
  color?: string;         // optional tint token name (A owns palette); default = --text-faint
}

interface ArchGraph {
  // ...existing: id, title, nodes, edges
  groups?: ArchGroup[];   // NEW — same-level visual clusters; absent = none
}
```

- **Complex components introduce no new type** — a complex component *is* an `ArchNode`
  with `childGraph` + F `inputs`/`outputs`. Encapsulate/explode are pure reducers over the
  F model (new helpers `encapsulate(doc, graphId, memberIds)` and
  `explode(doc, graphId, nodeId)`, plus group CRUD `addGroup`, `renameGroup`, `addToGroup`,
  `removeFromGroup`, `ungroup`), unit-tested in the existing `addNode`/`addEdge` style.
- **Persistence:** D extends `validGraph` / `serializeArchitecture` / `restoreArchitecture`
  to round-trip `groups`. `validGraph` invariants for groups: drop non-string/empty labels
  (default `Group`); filter `memberIds` to ids that exist in the graph; drop a group whose
  filtered `memberIds` is empty; a node id appearing in two groups keeps the **first** group
  and is dropped from later ones (enforces one-group-per-node). These mirror F's
  drop-don't-crash policy.
- **Agent contract:** groups are organizational and optional — D adds them to
  `architecture.schema.json` and notes in `conduit-architecture/SKILL.md` that a group is a
  read-only clustering hint with **no interface** (so an agent never mistakes a group for a
  component contract). The complex-component interface an agent reads is entirely F's
  ports/boundary contract; encapsulate simply produces a well-formed instance of it.

### Invariants

1. Encapsulate is **wire-preserving**: every pre-existing connection between an internal and
   external node still exists as a path (external→port→boundary→internal or the reverse)
   after the op; no signal is silently dropped.
2. Explode is the **inverse up to layout**: exploding a freshly encapsulated component
   restores the original connectivity graph (node adjacency), though node positions may
   differ (offset applied) and port-mediated edges collapse back to direct edges.
3. Group `memberIds` are always a subset of the graph's node ids (validated on load and
   maintained on every node delete).
4. A node is in ≤1 group.
5. `boundary:in`/`boundary:out` are never selectable, never group members, and always count
   as *external* to an encapsulated selection.

## 4. Edge cases & failure modes

| Condition | Expected behavior / recovery |
|---|---|
| Encapsulate/group with **0** nodes | Action disabled/absent (nothing to compose). |
| Encapsulate/group with **1** node | Allowed (wrap/label a single node); a 1-node group is legal but advisory-discouraged in copy. |
| Selection spans a **partial group** | On encapsulate, departed members are pruned from the group (group stays in *G*); on group-create, a node leaves its old group. |
| Selection includes a **group box** | The group's fully-contained members are what's operated on; the box itself is not a node. Wholly-contained group → moves into child on encapsulate; partially → pruned. |
| Member owns a **child graph** | Rides along; its `childGraph` reference stays valid (flat graph store). Not recursively exploded/encapsulated. |
| Encapsulating inside a **child graph** (selection borders parent boundary) | `boundary:in`/`boundary:out` treated as external → crossing wires to/from them become the new component's ports, whose external edges reconnect back to `boundary:*` with the same parent port. Fully composable. |
| **Fan-in / fan-out** across the boundary | Preserved: many externals → one inferred input port → one internal attachment (and the mirror). Explode restores via cartesian splice. |
| **Duplicate** external→internal edge would result | Reuse F's typed-edge dedup (`addTypedEdge`); a redundant identical port-to-port edge is not added twice. |
| Explode on node with **no child graph** | Action absent/disabled. |
| Explode **id collision** with existing sibling | Remint the moved node's id, remap its internal edges; its own child-graph reference is unaffected. |
| Explode must not **cascade-delete** inlined nodes' child graphs | Delete only the immediate child graph by id — never `removeNode` (see §2.4-4). |
| **Inferred port type mismatch** after wiring | Not possible to *worsen*: inherited types match the internal endpoint; any cross-boundary mismatch was already advisory per F and is carried through, never blocked. |
| Move-together with a node partly off-canvas | No clamping; canvas is infinite (React Flow). Fit-view remains available. |
| Insert-space that would move a node **onto** another | Allowed — insert-space *opens* space; it does not resolve collisions. Overlap is a visual, not a data, issue. |
| Insert-space **negative** (pull) drag | Symmetric: far-side nodes shift by the signed delta, **clamped** so no affected node crosses the guide line into the near cluster. |
| Group label **empty** on commit | Reverts to the previous label (a group must be named). |
| Concurrent agent **proposal** applied mid-gesture | The proposal banner path replaces `doc` wholesale (existing behavior); an in-flight marquee/insert-space drag is abandoned on doc replacement — selection resets, no partial write. |
| Deleting a node that is a **group member** and a **boundary target** | Prune from group; F cleans incident (incl. boundary) edges; if group empties, it auto-removes. |

## 5. Defaults vs. settings

| Decision | Default | Configurable? | Rationale |
|---|---|---|---|
| Marquee gesture | **Shift + drag** on empty pane | No (v1) | Preserves plain-drag **pan** (today's behavior); Shift is the conventional marquee modifier. |
| Additive selection | Shift-click **and** Ctrl/Cmd-click toggle | No | Cross-platform parity; both are muscle-memory for "add to selection". |
| Insert-space modifier | **Alt/Option + drag** on empty pane | No (v1) | Free of the pan (plain drag) and marquee (Shift) gestures; matches "make room" being a deliberate modified gesture. |
| Insert-space axis | Dominant drag direction, locked after a 6px threshold | No | One gesture serves both axes without a mode switch. |
| Insert-space sign | Symmetric (open on +, clamp-close on −) | No | Lets the same gesture both open and tighten. |
| New complex-component kind | `service` | Yes (Inspector, A) | Neutral default; user re-kinds in one click. |
| New complex-component title | Generated `Component N`, then inline rename focused | Yes | Immediately nameable; never leaves an unnamed node. |
| Group label | Generated `Group N` | Yes (rename) | Same. |
| Port inference grouping | By **internal** endpoint | No | A port is the component's own attachment; groups fan-in correctly. |
| Explode confirm | On (destroys the wrapper) | No (v1) | Destructive to the boundary; encapsulate is the safe inverse and is unconfirmed. |
| Group nesting | Flat only, one group per node | No (v1) | Keeps membership/geometry simple; revisit if asked. |

## 6. Scope slicing

- **MVP (this slice):** multi-select (marquee + additive click) & move-together; named group
  create/rename/move/ungroup/add-remove-member with derived box + persistence; encapsulate
  with the port-inference rule and boundary wiring; explode with splice + overlap offset +
  confirm; insert-space (both axes, pointer + keyboard fallback). Pure reducers unit-tested;
  schema + SKILL note for `groups`; `npm run verify` green; a host/IPC-touching path
  (persist + reload a doc with groups and an encapsulated component) covered by a
  `test/e2e/*.e2e.mjs` smoke scenario.
- **v1 (should):** smarter overlap resolution on explode (tidy the inlined cluster);
  drag-into-group by geometry; multi-select drag-to-reorder pins is out (E). Group color
  picker.
- **Vision (could):** nested groups; select-similar/select-connected; convert a group ⇄ a
  complex component in one action; auto-name inferred ports from the agent's read of the
  code.
- **Out of scope:** the port/type/interface model (F); interface authoring (E); node & group
  *visual* design and inline-rename widget (A); drill navigation and boundary rendering (B);
  the context-menu component (C); **undo/redo infrastructure** (none exists in the arch view
  today — see Decisions D-1); auto-layout.

## 7. Acceptance criteria

### Declarative
- A Shift-drag rectangle selects every intersecting node; Shift/Ctrl-click toggles a node;
  dragging one selected node moves the whole selection by the same delta, persisted.
- Grouping ≥1 selected nodes creates a labelled box that moves its members as a unit,
  renames in place, ungroups without deleting members, and round-trips through save/reload.
- Encapsulating a selection creates a complex component whose inputs mirror every distinct
  internal attachment fed from outside and whose outputs mirror every distinct internal
  source feeding outside; external wires reconnect to the ports; internal wires join
  `boundary:in`/`boundary:out`; internal-only wires move into the child graph.
- Exploding that component restores the original node adjacency, deletes only the immediate
  child graph (inlined nodes keep their own child graphs), offsets positions to avoid a
  pile-up, and asks for confirmation first.
- Alt-drag opens space along the dominant axis, shifting every node past the guide line by
  the drag delta; a keyboard fallback performs the same without a pointer.

### EARS
- **Event:** When the user releases a Shift-drag marquee, the system shall select all nodes
  intersecting the rectangle and announce the count via a live region.
- **Event:** When the user encapsulates a selection, the system shall create a child graph,
  move the members into it, infer input and output ports from the crossing wires, reconnect
  the external and internal edges accordingly, and select the new component — as one
  undoable/reversible transaction.
- **Event:** When the user confirms exploding a component, the system shall inline the child
  graph, splice each boundary wire through to the internals, delete only that child graph,
  and select the inlined nodes.
- **State:** While an insert-space drag is active, the system shall render an axis-locked
  guide line and live-shift only the nodes on the far side of it.
- **Unwanted:** If a group's members are all deleted, then the system shall remove the empty
  group.
- **Unwanted:** If explode would collide moved node ids with existing sibling ids, then the
  system shall remint the moved ids and preserve every edge.
- **Unwanted:** If a group label is committed empty, then the system shall revert to the
  previous label.
- **State:** While ≥2 nodes are selected, the system shall present the Group and Encapsulate
  actions and suppress the single-component Inspector.

### Gherkin (high-risk flows)

```gherkin
Feature: Encapsulate a selection into a complex component
  Background:
    Given a graph with nodes A, B, C, D
    And an edge A -> B, an edge B -> C, and an edge C -> D
    And B and C are selected

  Scenario: Ports are inferred from the boundary wires
    When the user encapsulates the selection
    Then a new component K replaces B and C in the graph
    And K has one input port fed by A
    And K has one output port feeding D
    And inside K's child graph, boundary:in connects to B and C connects to boundary:out
    And the edge B -> C now lives inside K's child graph
    And A -> K and K -> D exist in the parent graph

  Scenario: Fan-in collapses to a single input port
    Given an additional edge A2 -> B where A2 is not selected
    When the user encapsulates B and C
    Then K has exactly one input port for B's attachment
    And both A -> K and A2 -> K target that one input port

Feature: Explode is the inverse
  Scenario: Adjacency is restored
    Given a component K produced by encapsulating B and C
    When the user confirms exploding K
    Then B and C are back in the parent graph
    And A -> B, B -> C, and C -> D all exist again
    And K's child graph is deleted
    And any child graph owned by B or C still exists

Feature: Insert-space opens room
  Scenario: Horizontal push
    Given nodes at x = 0, 100, and 300
    When the user Alt-drags rightward 80px starting at x = 150
    Then the nodes at x = 0 and 100 stay put
    And the node at x = 300 moves to x = 380
```

## 8. State catalog (UI)

| Component | State | What the user sees | Action / CTA |
|---|---|---|---|
| Canvas selection | Empty | No selection chrome; Inspector hidden | Click/marquee to select |
| Canvas selection | Single | One node highlighted; A's single Inspector | Edit / drill / delete |
| Canvas selection | Multi (≥2) | Multiple highlights + selection count; multi-select Inspector | **Group**, **Encapsulate** |
| Marquee | Dragging | Rubber-band rectangle following the pointer | Release to commit |
| Group box | Idle | Labelled boundary box around members | Select / rename / move |
| Group box | Label editing | Inline text input in the label slot | Enter commit / Esc cancel |
| Group box | Selected | Box emphasized; member set highlighted | Ungroup / add / remove |
| Group box | Empty (transient) | — (auto-removed; never persists empty) | n/a |
| Complex component | Idle | A node card with in/out pins (A visual) + drill affordance (B) | Drill / **Explode** |
| Encapsulate | In-progress | One atomic apply; selection jumps to new component in rename mode | Name it |
| Explode | Confirm | In-app dialog: "Inline N components? The component boundary is removed." | Confirm / Cancel |
| Insert-space | Dragging | Axis-locked guide line + live shift of far-side nodes | Release commit / Esc abort |
| Insert-space | Keyboard | Command prompt for axis + amount (or focus-line + arrow nudge) | Apply / Esc |
| Live region | After any op | "Selected 4", "Grouped 3", "Encapsulated 2 into Component 1", "Exploded", "Opened 80px" | — |
| Error (op no-op) | Guarded | Action simply disabled/absent (no destructive partial state) | — |
| Loading / offline / not-found | N/A | Inherited from the arch view host (doc already in memory); D adds no fetch. State stated so it isn't silently dropped. | — |

*Blank-slate / first-run:* an empty graph has nothing to select — the compose actions are
absent until ≥1 node exists (no special empty state beyond A's existing "Add component").

## 9. Interaction inventory (UI)

| Component | Actions | Pointer | Keyboard | Touch | Context menu (C) | ARIA |
|---|---|---|---|---|---|---|
| Node (in selection) | select / add / move | click; Shift/Ctrl-click toggle; drag moves selection | Tab to focus; Space/Enter toggle in selection; arrows nudge | tap; long-press → menu | Group, Encapsulate, Explode (if child) | `role=button`, `aria-selected`, `aria-label` = title |
| Empty pane | marquee / pan / insert-space | Shift+drag marquee; plain drag pan; Alt+drag insert-space | focus canvas → "Select all" / "Insert space…" commands | two-finger pan; long-press → menu incl. "Insert space…" (prompted axis+amount) | Add component; Insert space… | `role=application` region label |
| Group box | select / move / rename / ungroup | click select; drag box moves members; dbl-click label edits | Enter edits label; Delete ungroups (keeps members) | tap; long-press menu | Rename, Ungroup, Add/Remove members | `role=group`, `aria-label` = label |
| Multi-select Inspector | group / encapsulate | click buttons | Tab + Enter | tap | — | labelled buttons; count announced |
| Explode confirm | confirm / cancel | click | Enter confirm / Esc cancel; focus trapped | tap | — | `role=dialog`, focus-managed |
| Insert-space guide | open room | Alt+drag | command + axis/amount, or arrow-nudge | long-press pane → "Insert space…" (prompted) | Insert space… | announces axis + delta |

**Rules honored:** every drag has a non-drag path — marquee ↔ "Select all"/additive
keyboard; move ↔ arrow-nudge; group/encapsulate/explode ↔ menu + inspector buttons;
insert-space ↔ command/keyboard. Distinct default/hover/focus/selected/dragging visuals are
A's, but selection must not rely on color alone (add a selected outline + the count text).
Explode (destructive to the boundary) confirms; encapsulate is reversible so it doesn't.

## 10. Accessibility & i18n (UI)

**Accessibility (WCAG 2.2):**
- **Keyboard operability:** select-all, additive toggle (Space/Enter on a focused node),
  arrow-nudge move, Group/Encapsulate/Explode via focusable buttons + the menu, and an
  insert-space keyboard path (a "Insert space…" command taking axis + amount, or a focused
  guide line moved by arrows) — no gesture is pointer-only (WCAG 2.5.7 drag alternative).
- **Visible focus:** focused node/group/button keeps a visible ring; verify it survives
  forced-colors / high-contrast (don't signal selection by fill color alone — pair with an
  outline and the selection-count text).
- **Accessible names:** the group box `aria-label` = its label; the multi-select actions and
  the explode dialog buttons have text labels; the guide line's live announcement carries
  axis + delta.
- **Announce dynamic results:** an `aria-live="polite"` region announces selection count,
  "Grouped N", "Encapsulated N into {name}", "Exploded {name}", and "Opened {n}px
  {horizontally|vertically}" — outcomes a sighted user reads off the canvas.
- **Focus management:** after encapsulate, focus lands on the new component's rename input;
  after explode, on the first inlined node; after ungroup, on the first former member; after
  an aborted (Esc) drag, back on the canvas.
- **Reduced motion:** the marquee/insert-space live-shift and any settle animation respect
  `prefers-reduced-motion` — comprehension never depends on motion; the guide line and final
  positions are the source of truth.
- **Color:** group tint and selection are never the sole signal — always paired with the box
  outline / label / count text; contrast ≥ 4.5:1 for the label.

**i18n:**
- All literals — "Group", "Ungroup", "Encapsulate", "Explode", "Group N"/"Component N"
  generators, the explode-confirm sentence, and the live-region strings — go through the
  app's string path; **no concatenated sentences** (e.g. "Encapsulated {count} into {name}"
  is one parameterized message, count-aware for pluralization).
- **Pluralization:** "Selected {n}", "Inline {n} component(s)?" use plural-aware formatting.
- **Numbers/locale:** the insert-space delta and any pixel readout format via the locale
  number path.
- **Text expansion:** the multi-select Inspector buttons and group label tolerate ~30%+
  longer translations without truncating (labels wrap/ellipsize with a title, never clip
  meaning).
- **RTL:** in RTL the "far side" of a horizontal insert-space mirrors (the axis rule keys off
  the guide line, not a hardcoded left→right); marquee and move deltas are direction-neutral.
- **Sorting/collation:** n/a (D sorts nothing user-visible; generated names are numeric).

## 11. Design tokens (UI)

- No new palette. Selection reuses the existing `--accent` selected treatment (A owns the
  card visual). The group box reuses `--text-faint` (matching the existing `group` kind's
  minimap color) for its border/label by default, with `ArchGroup.color` naming an existing
  kind var when the user tints it (v1). The insert-space guide line reuses `--border-2`
  (the canvas grid token) at higher emphasis. Complex-component pins/wires are F's tokens
  (`--accent` + the `--port-warn` mismatch token) — D introduces none.
- **Theme variants:** all reused tokens already resolve in light/dark/high-contrast; the
  minimap-color gotcha (SVG `fill` doesn't resolve CSS custom props — see
  `archNodeColor`) applies to any group silhouette drawn on the minimap, so a group box
  rendered there must use a computed color, not a bare `var(...)`.

## 12. Assumptions

- The arch view's selection state is refactored from `selectedId: string | null` to a
  selection **set**; A's single-component Inspector renders when the set has exactly one
  member (no behavior regression for existing single-select flows).
- React Flow's built-in multi-selection / marquee / node-drag primitives back these gestures
  (implementation detail, not specified); D's contribution is the *reducers* and the
  *compose semantics*, which stay pure and framework-agnostic in `src/architecture.ts`.
- Groups persist to `.conduit/architecture.json` alongside the graph (per the arch view's
  existing save path); the board/other artifacts are untouched.
- Encapsulate/explode and group ops each go through the existing single `applyDoc`
  transaction, so each is one debounced save and (if/when undo exists) one undo step.

## 13. Decisions Needed (autonomous mode)

- **[high] D-1 — No undo/redo exists in the arch view; encapsulate/explode are destructive
  compound mutations.** Default taken: ship without new undo infra, relying on
  encapsulate↔explode being exact inverses plus a confirm on explode (the destructive
  direction); encapsulate stays unconfirmed and directly reversible. This bounds data-loss
  risk but does not eliminate it if port inference is imperfect on an exotic graph. If the
  team wants a safety net before shipping, add a lightweight doc-snapshot undo for these two
  ops. Continuing on the default.
- **[normal] D-2 — Group data model = a derived-box `ArchGroup` collection on `ArchGraph`**
  (chosen) **vs. React Flow native parent nodes with re-parented coordinates.** Default:
  derived-box collection (single source of truth = member positions; no coordinate rebasing;
  matches F's derived-boundary philosophy). Reversible — the persisted shape is small.
- **[normal] D-3 — Port inference groups by the internal endpoint** `(node, port)` (chosen)
  **vs. by external source.** Default: internal endpoint, so fan-in collapses to one port.
  Reversible (inference rule only affects newly created components).
- **[normal] D-4 — Gesture modifiers:** marquee = **Shift+drag**, additive = Shift/Ctrl/Cmd
  click, insert-space = **Alt/Option+drag** — chosen to preserve today's plain-drag **pan**.
  Default as stated; a future "selection tool" toggle could replace the modifier if users
  find Shift+drag unintuitive.
- **[normal] D-5 — Nested groups & multi-group membership** are out of scope v1 (flat groups,
  one group per node). Default: flat. Reversible additively later.
- **[normal] D-6 — New complex component default kind `service` + generated title, then
  inline-rename focused.** Default as stated (neutral, immediately nameable).
- **[normal] D-7 — Explode overlap strategy = reuse the insert-space push-apart primitive to
  shift far-side siblings past the inlined bounding box.** Default: simple single-axis push;
  a tidier layout is v1.

## 14. Open questions

None for autonomous handoff — all would-be questions are recorded above as severity-tagged
Decisions with conservative, reversible defaults.

## Self-audit

Core spine: problem ✓ · behavior/states ✓ · data contract ✓ · edge cases ✓ ·
defaults/settings ✓ · scope slicing ✓ · acceptance (declarative + EARS + Gherkin) ✓. UI
module: state catalog ✓ · interaction inventory ✓ · accessibility & i18n ✓ · design tokens ✓.
Group-vs-complex-component distinction stated up front and reinforced in the data model.
Port inference + naming rules given precisely. Cross-slice ownership (A/B/C/E/F) referenced,
not re-specified. The explode-must-not-`removeNode` recursion gotcha and the RF minimap
computed-color gotcha are both flagged. No empty/placeholder sections. Decisions carry
severities; one `high` (D-1, undo) with a bounded default and no halt.
