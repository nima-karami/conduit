---
status: active
date: 2026-07-06
tier: FULL
type: UI
slice: F (foundation)
epic: architecture-node-graph
---

# Architecture node-graph — Foundation: ports, wiring & the typed-interface model

> **This is the shared contract for the architecture-node-graph epic.** Slices A–E
> (`2026-07-06-arch-*`) build on the data model, boundary convention, and agent contract defined
> here. If a downstream slice needs the model changed, that change lands here first. Conductor owns
> this file; sub-agents reference it, they don't edit it.

## Problem frame

**JTBD:** A user designs software as a node graph — components with named inputs/outputs wired
together — so that an **agent can read the graph and generate the implementing code**. Today an
`ArchNode` has a single implicit input and output handle and edges are node→node, so the diagram
can't express *what* a component consumes or produces. Without named, typed ports there is no
machine-readable contract for an agent to build against — the North Star of the whole feature.

**Actors:** the human architect (authoring in Conduit); the coding agent (reading
`.conduit/architecture.json` / proposing changes).

**Success:** a component declares multiple named input and output ports; ports may carry a type
that is a primitive **or** a structured interface; edges connect a specific output port to a
specific input port; a complex (nested) component exposes its declared ports read-only inside its
child graph so internal wiring is expressible; and all of this round-trips through the agent-facing
JSON + skill.

**Non-goals (owned by other slices, listed so this file stays the model only):**
- Node visuals / inline title edit / icons — **slice A**.
- Drill navigation / breadcrumb / Escape / rendering boundary nodes — **slice B**.
- Context menus — **slice C**.
- Grouping, encapsulate/explode, insert-space — **slice D**.
- The authoring UI for complex interfaces — **slice E** (this file defines the *data model* for
  interfaces; E defines how you *edit* them).

## Data / interface contract (the core of this slice)

Extends `src/architecture.ts`. All additions are **optional** so existing docs load unchanged
(see Migration).

```ts
type PortDirection = 'in' | 'out';

interface Port {
  id: string;            // STABLE, unique within its node+direction; edges + the agent reference it
  name: string;          // the export/import label the agent reads ("userId", "profile")
  type?: TypeRef;        // undefined = untyped
  description?: string;  // optional prose about this port
}

type TypeRef =
  | { kind: 'primitive'; name: PrimitiveName }   // string | number | boolean | date | json | any
  | { kind: 'list'; of: TypeRef }                // an ordered collection of `of`
  | { kind: 'ref'; interfaceId: string };        // → doc.interfaces[interfaceId]

interface InterfaceDef {                          // a named structured type in the doc registry
  id: string;                                     // STABLE
  name: string;                                   // "User"
  description?: string;
  fields: InterfaceField[];
}
interface InterfaceField {
  name: string;                                   // "birthYear"
  type: TypeRef;                                  // primitive | list | ref (recursive → nesting)
  optional?: boolean;
  description?: string;
}

interface ArchNode {
  // ...existing: id, title, subtitle?, description?, kind, x, y, childGraph?
  inputs?: Port[];       // NEW — ordered input ports (top→bottom on the left)
  outputs?: Port[];      // NEW — ordered output ports (top→bottom on the right)
  icon?: string;         // NEW — reserved here, authored in slice A
}

interface ArchEdge {
  // ...existing: id, source, target, label?
  sourcePort?: string;   // NEW — output Port.id on the source node (undefined = whole-node, legacy)
  targetPort?: string;   // NEW — input Port.id on the target node
}

interface ArchDoc {
  // ...existing: version, rootGraph, graphs
  interfaces?: Record<string, InterfaceDef>;  // NEW — document-level type registry, keyed by id
}
```

### Invariants (validated on load, mirroring `restoreArchitecture`)

1. Port ids are **unique within a node** (across both directions). A duplicate id drops the later
   port (logged), never crashes.
2. An edge's `sourcePort` must name an **output** port on its `source` node and `targetPort` an
   **input** port on its `target` node; an edge naming a missing port is **dropped** (same policy
   as today's missing-node edges). An edge with neither port set is a legacy whole-node edge and is
   kept.
3. A `TypeRef` of `kind:'ref'` whose `interfaceId` is absent from `doc.interfaces` is **cleared**
   (drift-safe, like dangling `childGraph`). Clearing differs by site because `Port.type` is
   optional but `InterfaceField.type` is required: a dangling ref on a **port** clears to
   *untyped* (`type` becomes `undefined`); a dangling ref inside an **interface field** clears to
   the primitive `any` (`{ kind:'primitive', name:'any' }`), never dropping the field. (Resolves
   the slice-E cross-check: deleting an interface that a field references leaves the field typed
   `any`, not invalid.)
4. Interface fields may reference other interfaces recursively; a **reference cycle is allowed** in
   data (a tree that points back), but the validator must not infinite-loop resolving it (guard
   with a visited-set) — cycles render as a ref chip, not an expanded tree.
5. Fan-in and fan-out are allowed: multiple edges may target the same input port and multiple may
   leave the same output port.

### Boundary convention (how a parent's interface appears inside its child graph)

This is the contract slice B renders and slice D's encapsulate/explode manipulates.

- A child graph reserves two **boundary node ids**: `boundary:in` and `boundary:out`.
- These boundary nodes are **derived at render time from the parent node's ports** — they are *not*
  stored in the child graph's `nodes[]` (single source of truth = the parent node's `inputs`/
  `outputs`, so they cannot drift). `boundary:in` surfaces each parent **input** as an **output pin**
  (inside, an input is a source); `boundary:out` surfaces each parent **output** as an **input pin**.
- Internal wiring to/from the interface **is** persisted: a child-graph `ArchEdge` may use
  `source:'boundary:in'` with `sourcePort` = a parent input port id, or `target:'boundary:out'` with
  `targetPort` = a parent output port id. These edges validate against the parent node's ports.
- Boundary ports are **read-only inside** the child (rename/add/remove happens on the component in
  its home graph). Renaming/removing a parent port re-keys/cleans incident boundary edges.

### Agent contract (this slice owns the schema + skill updates)

- Extend `resources/skills/conduit-architecture/architecture.schema.json` for `inputs`/`outputs`/
  `type`/`interfaces` and port-referencing edges, keeping all additions optional.
- Extend `resources/skills/conduit-architecture/SKILL.md`: how to declare ports, reference an
  interface from the registry, wire port-to-port, and the `boundary:in`/`boundary:out` convention
  for complex components — so an agent can both **read** a component's contract and **author** one
  via `.conduit/architecture.proposed.json`.
- `restoreArchitecture` / `serializeArchitecture` round-trip every new field; the reducer helpers
  (`addPort`, `renamePort`, `removePort`, `setPortType`, `addTypedEdge`, interface CRUD) are pure
  and unit-tested, matching the existing `addNode`/`addEdge` style.

## Behavior & states (core port UX this slice ships)

The minimum interaction to make the model usable; richer surfaces are A–E.

- **Add/remove a port:** a component reveals `+` (add input, add output) and per-port `−` affordances
  (the Grasshopper "zoom-in reveals the widget" ZUI — precise reveal rule is slice A's visual call;
  the *action* is F's). Add appends a port with a generated id and a default name (`in1`, `out1`, …).
- **Rename a port in place:** click/enter a port's name → text input → Enter/blur commits, Esc
  cancels; empty name reverts to the previous name (a port must have a name).
- **Set a port's type:** choose untyped, a primitive, a list, or an existing interface (full
  interface authoring is slice E; F provides the pick + the model).
- **Wire port-to-port:** drag from an output pin to an input pin creates a typed edge
  (`sourcePort`/`targetPort` set). Dragging to an incompatible type is **allowed** but the edge and
  pins render a soft "type mismatch" warning (advisory, never blocked, v1).
- **Delete a port:** removes it and cleans incident edges (including boundary edges in a child
  graph).

### States

`untyped port` · `typed port (primitive/list/ref)` · `mismatched-but-connected edge (warn)` ·
`unconnected input` · `unconnected output` · `dangling ref cleared` · `legacy node (no ports → one
implicit in + one implicit out, today's behavior)`.

## Edge cases & failure modes

- **Legacy nodes/edges:** absent `inputs`/`outputs` → the node renders the current single implicit
  in/out handles; absent `sourcePort`/`targetPort` → whole-node edge. No eager rewrite; the next
  edit that adds a port migrates that node forward only.
- **Removing a port with wires:** incident edges (including boundary edges) are removed with it.
- **Renaming a parent port referenced by boundary edges:** the id is stable, so boundary edges
  survive a rename; only a **removed** port cleans its boundary edges.
- **Deleting an interface still referenced by a port/field:** those `ref`s clear to untyped
  (invariant 3); do not cascade-delete ports.
- **Cyclic interface references:** guarded resolution (invariant 4).
- **Duplicate port names (not ids):** allowed but discouraged; the agent-facing contract prefers
  unique names — surface a soft warning, don't block.
- **Many ports:** no hard cap; layout/wrap is slice A's concern.

## Defaults vs. settings

- New port default name `in{n}`/`out{n}`; **untyped** by default (rationale: typing is opt-in; an
  untyped named port is already a useful contract). No user setting — reversible per port.
- Type mismatch is **advisory** by default; no "enforce types" setting in v1 (revisit if users ask).
- Boundary nodes are **always shown** inside a child that has declared ports (no toggle) — they're
  the whole point of nesting.

## Scope slicing

- **MVP (this slice):** the data model + validation + pure reducers; port add/remove/rename/type-pick;
  port-to-port wiring with advisory mismatch; boundary edge model (data + validation); schema + skill
  update. Enough that A–E have a stable contract and a user can build a typed graph one level deep.
- **v1:** list/`json` primitives polish; mismatch heuristics for `ref` vs `primitive`.
- **Out of scope (other slices):** all visuals, navigation, menus, grouping, interface authoring UI.

## Acceptance criteria

Declarative (this slice is mostly model/logic; UI acceptance lives in A/B):

1. A component can hold ≥1 input and ≥1 output port, each with a stable id + editable name, and the
   doc round-trips through `serialize`/`restore` with every field intact.
2. An edge created output-port→input-port persists `sourcePort`/`targetPort`; loading a doc whose
   edge names a missing port drops that edge; a legacy port-less edge is kept.
3. A port typed as a `ref` to interface `User` resolves to `doc.interfaces[user]`; deleting `User`
   clears the ref to untyped without dropping the port; a cyclic interface resolves without hanging.
4. Inside a child graph, an edge `source:'boundary:in'`+`sourcePort:<parentInputId>` validates and
   round-trips; removing that parent input removes the boundary edge.
5. `architecture.schema.json` accepts the new shape and the `conduit-architecture` SKILL documents
   ports/types/wiring/boundary; a hand-written `.proposed.json` using ports validates on accept.
6. New pure reducers are unit-tested (add/rename/remove port, set type, typed edge, interface CRUD,
   migration of a legacy doc); `npm run verify` green.

## UI module (minimal for this slice; A owns the polish)

- **Interaction inventory:** add-port (`+`), remove-port (`−`), rename (click/F2 → input), type-pick
  (menu), wire (drag pin→pin), delete-port. All reachable by keyboard (add/rename/delete via the
  component's roving focus; wiring has a keyboard fallback: focus an output pin → Enter → focus an
  input pin → Enter).
- **Accessibility:** each pin is a focusable control with an `aria-label` = `"{in|out} port {name}
  ({type})"`; the rename input is a labelled textbox; mismatch state exposed via `aria-invalid` +
  text, never color alone.
- **i18n:** all literals ("Add input", "Add output", "type mismatch", default names) go through the
  app's string path; no concatenated sentences.
- **Design tokens:** pins/wires use existing `--accent`/kind vars + a single new `--port-warn` token
  (reuse `--amber`) for mismatch — no new palette.

## Self-audit

Template spine: problem ✓ · behavior/states ✓ · data contract ✓ (the bulk) · edge cases ✓ ·
defaults/settings ✓ · scope slicing ✓ · acceptance ✓. UI module ✓ (kept minimal — A owns visual
polish, deliberately, not omitted). No open placeholders. Cross-slice ownership stated so no slice
re-decides the model.

## Decisions taken (would-be questions, resolved as conductor)

- **Interface-inside = derived boundary nodes** (not stored, not editable inside) — single source of
  truth, drift-free, matches "you don't control the contract from within." `normal`.
- **Types advisory, never enforced** in v1 — keeps wiring frictionless while still machine-readable.
  `normal`.
- **Type registry is document-level** (`doc.interfaces`), shared across all graphs/components, so
  the same `User` interface is one definition reused everywhere. `normal`.
- **Slice E (interface authoring) stays a separate spec, not merged into F.** F owns the *data
  model + schema + skill + `setPortType` writes*; E owns the *authoring UX* and the shared type
  picker (E-owned, F-consumed). Clean seam; no reason to fold 90-odd lines of authoring UX into the
  contract. `normal` (conductor call).

## Epic-level open decision (for the user)

- **Undo/redo for the architecture canvas** — surfaced by slice D (D-1, `high`). The canvas has **no
  undo stack today**; slice D's destructive composition ops (encapsulate / explode / insert-space),
  plus F's port/edge deletes and E's interface deletes, are all irreversible without one. Options:
  (a) ship the epic with **bounded safety only** — encapsulate↔explode are exact inverses + a
  confirm on explode + interface-delete confirm (D's fallback), no general undo; (b) build a
  **document-level undo/redo stack** for the whole arch doc (the model is already pure/immutable —
  `ArchDoc` reducers return new docs — so a snapshot-per-edit stack is cheap and would cover every
  slice's mutations uniformly). Recommendation: **(b)** — the immutable reducer design makes it low-
  cost and it removes the risk from *every* destructive action at once, not just composition. This
  is the one decision the user should make before the build sequencing is finalized.
