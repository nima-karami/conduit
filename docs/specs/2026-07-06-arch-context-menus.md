---
status: active
date: 2026-07-06
tier: FULL
type: UI
slice: C
epic: architecture-node-graph
---

# Architecture node-graph — Context menus for every canvas surface

**Tier:** FULL   **Feature type:** UI
**One-line request:** "each of these needs to be thought through — the right-click menu for a port
pin, the component body, the component name/title, the empty canvas, a wire between two ports, and a
group."

> **Slice C of the `architecture-node-graph` epic.** This slice owns *only* the context-menu
> **inventory, ordering, grouping, and cross-surface consistency**. The *actions* themselves are
> defined by other slices and are only **referenced** here, never redesigned:
> A (rename / edit description / set icon), B (drill in / go up), Foundation F
> (`2026-07-06-arch-foundation-ports-types.md` — add/remove/rename port, set port type, delete edge,
> boundary read-only rule), D (make group / rename group / encapsulate / explode / insert space),
> E (edit interface / assign type). The menu **component** (`webview/components/context-menu.tsx`,
> `MenuItem`/`MenuState`) is also unchanged except for the one additive keyboard-invocation capability
> called out in §9/§10. All menus MUST conform to the canonical ordering rule established in
> `docs/specs/archive/2026-06-23-context-menu-consistency.md`.

## 1. Problem frame

- **Job:** When a user right-clicks *anything* on the architecture canvas, the menu should be
  predictable — the same kind of action lives in the same place on every surface, the primary action
  is on top, and the destructive one is alone at the bottom — so authoring a typed node graph feels
  like one coherent tool rather than six unrelated menus.
- **Actors:** the human architect (mouse + keyboard), authoring `.conduit/architecture.json` via the
  canvas. (The coding agent never uses menus; it reads/writes JSON — out of scope here.)
- **Success outcomes (observable):**
  - Each of the six surfaces has an enumerated menu whose items follow the canonical group order
    (Primary → Create → Edit → Reference → Destructive), sentence-cased, deduped.
  - Every destructive item is last in its menu, `danger`, and preceded by a separator.
  - The same logical action (rename, delete, copy name, set type) sits in the same group on every
    surface it appears on.
  - Every menu is invocable and operable by keyboard (Shift+F10 / context-menu key), and focus
    returns to the invoking surface on close.
- **Non-goals:**
  - **No new action *functionality*.** The chosen scope permits adding a *missing parallel* item so
    surfaces match (e.g. exposing an already-defined action on a surface that lacked a menu), but not
    net-new behavior. Rename/type-pick/drill/group/etc. are built by A/B/D/E/F.
  - No change to `ContextMenu`'s visual style, positioning math, dismiss logic, or `MenuItem` shape,
    **except** the additive keyboard-invocation/focus-return capability in §9–§10.
  - No node/edge *visual* redesign (slice A), no navigation model (slice B), no interface authoring UI
    (slice E).

## 2. Behavior & states

### 2.1 The canonical convention (inherited, not re-invented)

This slice adopts verbatim the object-menu taxonomy from the shipped context-menu-consistency spec.
Groups top→bottom, each separated by a divider; the first *rendered* item never carries a leading
separator; destructive group is always last and `separatorBefore`.

| # | Group | Meaning on the canvas |
|---|---|---|
| 1 | **Primary / open** | the default "open/navigate" action for this surface (Open nested canvas, Go up to parent, Edit interface…). May be **empty** when a surface has no natural open action (port/edge/group/pane) — that is allowed. |
| 2 | **Create** | make a new child/sibling/container object (Add connected node, Add input/output port, Add component here, Group selection, Encapsulate selection into component, Paste, Insert space…). |
| 3 | **Edit / transform** | mutate the existing object non-destructively (Rename…, Edit description…, Set icon…, Set type…, Edit label…, Duplicate, Explode component, Ungroup, Rename group…). |
| 4 | **Reference** | read-only "get a handle to it" (Copy name, Copy port name, Copy label, Select contents) and, on the pane, **View** (Fit view). |
| 5 | **Destructive** | remove/disconnect (Delete component, Remove port, Disconnect wires, Delete edge, Delete group and contents) — `danger`, **always last, always `separatorBefore`**; within the group, less-lossy → most-lossy. |

**Label rules (inherited):** object-menu items are **sentence case** ("Add input port", "Delete
component", not Title Case). Items that open a further input surface (dialog, inline editor, picker)
carry an **ellipsis** (`Rename…`, `Set type…`, `Edit label…`, `Insert space…`); items that act
immediately do not (`Duplicate`, `Fit view`, `Delete component`, `Add input port`). **Dedup:** a
logical action appears once per menu; right-clicking different parts of the *same object* yields the
*same* menu (see the title surface, §2.2.3).

### 2.2 The six surfaces

Legend: **P** = primary (group 1), **⌫** = destructive (`danger`, last group, `separatorBefore`),
*(cond …)* = item shown only when the condition holds, → = the slice that owns the action.

#### 2.2.1 Port pin (input or output) — `Handle` on a component

Right-clicking a pin first **selects its component** (parity with node right-click) and targets that
one port. A port has no "open" of its own **except** when it is typed as an interface reference, in
which case "Edit interface…" is its primary (the analog of "Open nested canvas" — open the thing this
points at).

| Group | Item | Marks | Owner |
|---|---|---|---|
| Primary | **Edit interface…** | P, *(cond: port type is `kind:'ref'`)* | E |
| Edit | **Rename port…** | — | F |
| Edit | **Set type…** | — | F / E |
| Reference | **Copy port name** | — | C (parallel of Copy name) |
| Destructive | **Disconnect wires** | ⌫ (sep), `danger`, *(disabled when the port has no incident edges)* | F (delete edge, bulk) |
| Destructive | **Remove port** | ⌫ (last), `danger` | F |

- **Primary:** Edit interface… (only when ref-typed; otherwise group 1 is empty and the menu opens on
  Edit).
- **Destructive:** Disconnect wires (keeps the port, removes its edges) then **Remove port** last
  (removes the port *and* its incident edges, incl. boundary edges per Foundation invariant/edge-cases).
- **Add input/output port is intentionally NOT on the pin menu** — a pin menu is about *this* port;
  adding a sibling port lives on the component body/title menu (dedup; see Decisions Needed #2).

**Boundary pins (`boundary:in` / `boundary:out`, rendered inside a child graph — Foundation §Boundary):**
the port **contract** is read-only inside the child, but Foundation is explicit that the child's
**internal wiring** to/from the boundary *is* editable. So the boundary-pin menu is the reduced variant
that blocks contract edits but still allows internal-wire edits:

| Group | Item | Marks | Owner |
|---|---|---|---|
| Primary | **Edit interface…** | P, *(cond: ref-typed)* | E |
| Reference | **Copy port name** | — | C |
| Destructive | **Disconnect wires** | ⌫ (last), `danger`, *(disabled when no incident internal edge)* | F |

- **Rename port / Set type / Remove port are absent** (not merely disabled) — those mutate the parent
  contract, which Foundation forbids from inside the child.
- **Disconnect wires is kept** because it removes only the *child-graph* edges incident to the boundary
  pin (legitimate internal wiring), not the parent contract.
- **Edit interface…** is kept for a ref-typed boundary pin: it opens the shared `doc.interfaces`
  definition (a document-level registry edit), which is *not* the boundary port's contract — so it does
  not violate the read-only rule. It edits the type everyone references, exactly as on a normal pin.
- A **boundary edge** (a child-graph edge with `source:'boundary:in'` or `target:'boundary:out'`) is a
  normal edge and uses the wire menu (§2.2.5) unchanged.

#### 2.2.2 Component body

Extends the existing node menu (`architecture-view.tsx` `onNodeContextMenu`) with ports + grouping.
Right-click selects the component.

| Group | Item | Marks | Owner |
|---|---|---|---|
| Primary | **Open nested canvas** / **Create nested canvas** | P (label depends on `childGraph` presence) | B |
| Create | **Add connected node** | — | existing |
| Create | **Add input port** | — | F |
| Create | **Add output port** | — | F |
| Create | **Group selection** | *(cond: ≥2 nodes selected)* | D |
| Create | **Encapsulate selection into component** | *(cond: ≥2 nodes selected)* | D |
| Edit | **Rename…** | — | A |
| Edit | **Edit description…** | — | A |
| Edit | **Set icon…** | — | A |
| Edit | **Duplicate** | — | existing |
| Edit | **Explode component** | *(cond: has `childGraph`)* | D |
| Reference | **Copy name** | — | existing/C |
| Destructive | **Delete component** | ⌫ (last), `danger` | existing (relabel from "Delete node") |

- **Primary:** Open/Create nested canvas.
- **Destructive:** Delete component (last, separated). The existing label "Delete node" is
  standardized to "Delete component" for cross-surface wording consistency (the app already calls
  these "Component"; see Decisions Needed #7).

#### 2.2.3 Component name / title

The title is a sub-region of the component body, not a distinct object. **Its context menu is
identical to the component body menu** (§2.2.2) — right-clicking anywhere on a component gives the
component menu, which is exactly what the canonical "same object → same menu" rule requires. The
title's *special* affordance is the **inline rename gesture** (double-click / F2, owned by slice A),
**not** a different menu. Rename therefore stays in the Edit group here too (never promoted to
Primary), preserving the "rename lives in Edit everywhere" invariant.

> Default chosen: identical-to-body. A rename-first focused subset was considered and rejected as a
> consistency violation (see Decisions Needed #1).

#### 2.2.4 Empty canvas background (the pane)

Extends the existing pane menu (`onPaneContextMenu`: Add component here, Fit view). The pane's
"open/navigate" action is going up a level.

| Group | Item | Marks | Owner |
|---|---|---|---|
| Primary | **Go up to parent** | P, *(cond: current graph is not the root)* | B |
| Create | **Add component here** | — | existing |
| Create | **Paste** | *(cond: a component/selection was copied or cut)* | C (parallel; may defer — Decisions Needed #8) |
| Create | **Insert space…** | — | D |
| Reference / View | **Select all** | *(cond: ≥1 node in the graph)* | C (parallel) |
| Reference / View | **Fit view** | — | existing |
| Destructive | *(none)* | — | — |

- **Primary:** Go up to parent (only inside a child graph). No destructive action on the pane (there
  is no single object to remove; "clear canvas" is deliberately out of scope).
- "Select all" sits in the **Reference/View** group, alongside "Select contents" on the group menu, so
  the "select" action is one group everywhere (matches §2.3).
- **Positional actions and where they land:** "Add component here" / "Insert space…" / "Paste" act at
  the right-click point's flow-space position (existing `screenToFlowPosition`). When the pane menu is
  **invoked by keyboard** (Shift+F10, no cursor), these land at the **current viewport center** in
  flow-space (the same fallback `addComponent` already uses), so the keyboard path is never left with
  an undefined position.

#### 2.2.5 Wire / edge (between two ports)

Edges currently have no context menu (only double-click-to-edit-label + React-Flow removal). This
slice gives them one. Right-click selects the edge.

| Group | Item | Marks | Owner |
|---|---|---|---|
| Primary | *(none)* | — | — |
| Edit | **Edit label…** | — | existing (inline label editor) |
| Reference | **Copy label** | *(cond: edge has a label)* | C (parallel) |
| Destructive | **Delete edge** | ⌫ (last), `danger` | F |

- **Primary:** none (an edge has nothing to open); the menu opens on Edit.
- **Destructive:** Delete edge (last, separated). This replaces the discoverability gap where edge
  deletion was keyboard/selection-only.
- The Foundation "type-mismatch (advisory)" state is a *rendering* concern (soft warning on the wire),
  **not** a menu item — no "fix mismatch" action is invented here.

#### 2.2.6 Group (slice D)

A group is a container box around nodes (no `childGraph`, so nothing to "drill into" — that is what
Encapsulate produces). Right-click selects the group.

| Group | Item | Marks | Owner |
|---|---|---|---|
| Primary | *(none)* | — | — |
| Create | **Add component here** | *(adds a node inside the group's bounds)* | existing/D |
| Edit | **Rename group…** | — | D |
| Edit | **Encapsulate into component** | *(turns the group + contents into a nested component)* | D |
| Edit | **Ungroup** | *(dissolves the box, keeps the nodes — non-lossy)* | D |
| Reference | **Select contents** | *(selects the grouped nodes)* | C (parallel) |
| Destructive | **Delete group and contents** | ⌫ (last), `danger` | D |

- **Primary:** none.
- **Ungroup vs. Delete:** Ungroup is **non-lossy** (nodes survive) and is classified as **Edit**,
  mirroring "Explode component" in the body menu — the two are the exact parallel (dissolve a
  container, promote its children). Only **Delete group and contents** (lossy — removes the nodes too)
  is Destructive. See Decisions Needed #3.

### 2.3 Cross-surface consistency matrix (the heart of the slice)

Verifies that the same logical action lands in the same group everywhere it appears:

| Logical action | Port | Body/Title | Pane | Edge | Group | Group placement |
|---|---|---|---|---|---|---|
| Open / navigate | Edit interface… (cond) | Open nested canvas | Go up to parent (cond) | — | — | **Primary** |
| Add child/sibling | — | Add …port / connected node | Add component here | — | Add component here | **Create** |
| Make container from selection | — | Group / Encapsulate (cond) | — | — | Encapsulate into component | **Create / Edit** ¹ |
| Rename | Rename port… | Rename… | — | Edit label… | Rename group… | **Edit** |
| Set/assign type | Set type… | — | — | — | — | **Edit** |
| Duplicate | — | Duplicate | — | — | — | **Edit** |
| Dissolve container (non-lossy) | — | Explode component (cond) | — | — | Ungroup | **Edit** |
| Copy identifier | Copy port name | Copy name | — | Copy label (cond) | — | **Reference** |
| Select | — | — | Select all (cond) | — | Select contents | **Reference** |
| View | — | — | Fit view | — | — | **Reference/View** |
| Remove edges | Disconnect wires | — | — | Delete edge | — | **Destructive** |
| Remove object | Remove port | Delete component | — | — | Delete group and contents | **Destructive (last)** |

¹ Making a new *group* is Create (draw a box). Making a *component* from a selection (Encapsulate) is a
transform of existing nodes into a new nested component; classified Create on the body menu (it
produces a new container) and left in the group menu's Edit section as the group's own conversion.
This one asymmetry is flagged (Decisions Needed #4) with a conservative default.

## 3. Data / interface contract

No data-model change. This slice only *arranges* `MenuItem[]` and decides which item carries
`separatorBefore` / `danger`. `MenuItem` (`label`, `icon`, `onClick`, `danger?`, `separatorBefore?`,
`disabled?`) and `MenuState` (`x`, `y`, `items`) are unchanged.

**One additive capability** (see §9/§10) is required for keyboard invocation: the menu must be
openable from an anchor rectangle (a focused surface element), not only from a mouse `clientX/clientY`.
This is expressed either by computing an `{x,y}` from the focused element's `getBoundingClientRect()`
before setting `MenuState`, or by an optional `anchor?: DOMRect` on the open call. Either is additive
and does not change existing mouse behavior. **Invariant:** the builder for each surface produces items
already in canonical order, so the render order == the spec order (no post-sort at render time).

## 4. Edge cases & failure modes

| Condition | Expected behavior |
|---|---|
| Conditional Primary absent (port not ref-typed; pane at root; edge always) | Group 1 empty → the first *rendered* item must not carry a leading separator (existing `ContextMenu` renders `separatorBefore` per item; the builder must not set it on the now-first item). |
| Port has no wires | "Disconnect wires" is **disabled** (stays discoverable), not hidden. |
| Empty graph, pane menu | "Select all" hidden (cond ≥1 node); "Add component here" / "Fit view" still shown. |
| Right-click with a multi-selection, on one selected node | Selection-scoped items (Group selection, Encapsulate, Delete) act on the **whole selection**; single-only items (Rename, Set icon, Open nested canvas) act on the **clicked node**. Right-clicking a *non-selected* node collapses the selection to that node first. (Decisions Needed #5.) |
| Mixed multi-selection (nodes + edges + groups) | **Group selection / Encapsulate** operate on the selected **nodes only** (edges between them are pulled in automatically; loose edges/groups are ignored, not blocked). A selection-scoped **Delete** removes every selected object of any type (its own slice confirms). Copy/rename/type single-only items are disabled while >1 object is selected. |
| Empty group (no contained nodes) | "Select contents" is **disabled**; "Ungroup" and "Delete group and contents" behave as a no-content dissolve/remove. |
| Boundary pin inside a child graph | Read-only menu only (Copy port name [+ Edit interface… if ref]); no add/rename/remove — Foundation forbids editing the contract from inside. |
| Legacy node with no ports (implicit single in/out handles) | Right-clicking an implicit handle: since implicit handles are not real `Port`s, treat as a body right-click (no port menu) — the first "Add …port" migrates the node forward. |
| Explode component on a component with no `childGraph` | Item hidden (cond). |
| Delete edge on a legacy whole-node edge (no `sourcePort`/`targetPort`) | Works identically — deletes the edge by id. |
| Menu open, then the underlying doc changes (agent proposal applied) | Existing `ContextMenu` dismisses on blur/scroll/resize/outside-click; additionally the menu closes if its target object no longer exists (stale action would no-op). Builders read the live `graph` at open time. |
| Keyboard invoke (Shift+F10) with nothing focused on the canvas | No menu (there is no target). Focus must be on a surface element first. |
| Very long menu (all conditionals present) | `ContextMenu` already clamps to viewport and self-scrolls — unchanged. |

## 5. Defaults vs. settings

| Decision | Default | Configurable? | Rationale |
|---|---|---|---|
| Group order (Primary→Create→Edit→Reference→Destructive) | Canonical order | No | Consistency *is* the feature; a setting defeats it (inherited rule). |
| Label casing | Sentence case | No | Convention, not preference. |
| Title menu contents | Identical to body menu | No | "Same object → same menu"; predictability. |
| Right-click selects target first | Yes | No | Parity with existing node menu; the action needs a target. |
| Type-mismatch surfaced in menu | No (render-only) | No | Foundation keeps mismatch advisory/visual; a menu action would over-reach. |

## 6. Scope slicing

- **MVP (this slice):** the six menu inventories above, in canonical order, wired to the actions
  A/B/D/E/F expose; destructive-last + separator + sentence case + dedup enforced; edge and port pins
  gain a menu where they had none; boundary-pin read-only variant. Keyboard invocation (Shift+F10 /
  context-menu key) + focus-return (§9/§10).
- **v1:** Paste / Select all / Copy label / Copy port name / Select contents (the clipboard- and
  selection-parity items) once slice D's clipboard model exists; multi-select scoping polish.
- **Vision:** a tiny pure `orderMenuItems(groups)` helper so any future canvas surface declares
  *groups* and inherits separators/order for free (the same optional idea flagged in the
  context-menu-consistency spec) — decide at build time, likely over-engineering for six menus.
- **Out of scope:** the actions' own behavior/dialogs (other slices), `ContextMenu` restyle,
  submenus/nested menus, a canvas-wide "clear" action, agent-facing changes.

## 7. Acceptance criteria

**Declarative:**

- Each of the six surfaces opens a context menu on right-click and on Shift+F10 when that surface's
  element is focused.
- In every menu, items render in canonical group order; the destructive item (if any) is last,
  `danger`, and separated; the first rendered item never has a leading separator.
- The same logical action occupies the same group across all surfaces it appears on (per §2.3).
- On the title surface, the menu equals the body menu item-for-item.
- Closing a menu (Esc / select / outside-click) returns focus to the surface element that opened it.

**EARS:**

- *Ubiquitous:* The canvas shall render every object menu in the order Primary → Create → Edit →
  Reference → Destructive.
- *Event:* When the user presses Shift+F10 (or the context-menu key) while a canvas surface element is
  focused, the system shall open that surface's menu anchored to the element and move focus into the
  menu.
- *Event:* When a context menu closes, the system shall return focus to the element that opened it.
- *State:* While a port has no incident edges, the system shall render "Disconnect wires" as disabled.
- *Unwanted:* If a surface has no primary action, then the system shall omit group 1 and shall not
  render a leading separator on the first visible item.
- *Unwanted:* If the right-clicked object no longer exists when an item is activated, then the system
  shall no-op and dismiss the menu.
- *Optional:* Where a port is typed as an interface reference, the system shall show "Edit interface…"
  as that port's primary item.
- *Optional:* Where a boundary pin is right-clicked inside a child graph, the system shall show only
  the read-only items (Copy port name [+ Edit interface…]).

**Gherkin:**

```gherkin
Feature: Canvas context menus
  Background:
    Given the architecture canvas is open with a typed component

  Scenario: Destructive action is last and separated on every surface
    When I right-click a component body
    Then "Delete component" is the last item, is danger-styled, and is preceded by a separator

  Scenario: Port pin menu on a ref-typed port
    Given an input port typed as a reference to interface "User"
    When I right-click that port pin
    Then "Edit interface…" is the first item
    And "Remove port" is the last, danger item
    And there is no "Add input port" item

  Scenario: Boundary pin is read-only inside a child graph
    Given I have drilled into a component's child graph
    When I right-click the boundary:in pin for input "userId"
    Then I see "Copy port name"
    And I do not see "Rename port…", "Set type…", or "Remove port"

  Scenario: Title menu equals body menu
    When I right-click the component title
    Then the menu items are identical to the component body menu

  Scenario: Keyboard invocation and focus return
    Given a wire is focused
    When I press Shift+F10
    Then the wire menu opens anchored to the wire and focus is inside the menu
    When I press Escape
    Then the menu closes and focus returns to the wire

  Scenario: Empty pane menu inside a child graph
    Given I have drilled one level into a child graph
    When I right-click empty canvas
    Then "Go up to parent" is the first item
    And there is no danger item
```

**Verification (per CLAUDE.md — host/IPC/canvas surfaces use `test/e2e`):** a real-app e2e scenario
opens each of the six menus (drive right-click on a pin, body, title, pane, edge, group) and asserts
the visible `.ctxmenu__item` text order, which item carries `--danger`, and separator positions; plus
a cross-surface invariant test: "every `danger` item is last in its menu", "no first item has
`separatorBefore`", and "a logical action's group index is identical across the surfaces that show it"
(a table-driven check against §2.3). A keyboard test asserts Shift+F10 opens the focused surface's
menu and Esc returns focus. `npm run verify` green.

## 8. State catalog (UI)

The menu's own open/hover/active/disabled/dismiss states live in `ContextMenu` and are **unchanged**.
The states this slice introduces are *which items appear/enable* per surface context:

| Surface | State | What the user sees |
|---|---|---|
| Port pin | untyped / typed / **ref-typed** | ref-typed adds "Edit interface…" as primary |
| Port pin | has wires / no wires | "Disconnect wires" enabled / disabled |
| Port pin | **boundary (inside child)** | read-only reduced menu |
| Component body | root vs. nested / has childGraph | "Open" vs "Create nested canvas"; "Explode component" shown only with a childGraph |
| Component body | single vs. **multi-selection** | "Group selection" / "Encapsulate selection into component" appear |
| Pane | root graph vs. child graph | "Go up to parent" shown only in a child graph |
| Pane | empty vs. populated | "Select all" shown only with ≥1 node |
| Edge | labeled vs. unlabeled | "Copy label" shown only when labeled |
| Group | populated | "Select contents"/"Ungroup" always; "Delete group and contents" last |
| Any | **stale target** (object removed while menu open) | menu dismisses; action no-ops |

There is no loading/offline/permission/not-found state for a local synchronous canvas menu — noted as
N/A rather than omitted (the doc is already in memory; the pending-proposal banner is slice-independent
and does not gate menus).

## 9. Interaction inventory (UI)

| Component | Actions/affordances | Pointer | Keyboard | Touch | Context menu | ARIA role/states |
|---|---|---|---|---|---|---|
| Port pin | open menu; each item | right-click opens menu; hover highlights | focus pin → **Shift+F10 / ContextMenu key** opens menu; ↑↓/Home/End navigate; Enter activates; Esc closes → focus returns to pin | long-press = right-click (React-Flow default) | this menu | pin is focusable with `aria-label` (from F); menu `role="menu"`, items `role="menuitem"` |
| Component body/title | open menu; items | right-click | focus card → Shift+F10; nav as above | long-press | body + title share one menu | card focusable; menu roles as above |
| Pane | open menu; items | right-click on empty canvas | focus canvas pane → Shift+F10 (menu anchored to pane center or last focus) | long-press | pane menu | pane is a focusable region; menu roles |
| Edge/wire | open menu; edit label; delete | right-click; double-click still edits label | focus edge → Shift+F10; Enter on "Edit label…" opens inline input | long-press | edge menu | edge focusable with `aria-label` = "wire {source}→{target}"; menu roles |
| Group | open menu; items | right-click on group box | focus group → Shift+F10 | long-press | group menu | group focusable with `aria-label`; menu roles |

Rules honored: **every action has a non-pointer pathway** (Shift+F10 + arrow nav + Enter). Right-click
selects the target first (so keyboard follow-up acts on the same object). Destructive items are
`danger`-styled and, where they lose data (Delete component/group, Remove port), the action's own
confirm/undo is the owning slice's responsibility — this slice guarantees only the *placement and
separation* that make an accidental click unlikely.

## 10. Accessibility & i18n (UI)

**Accessibility:**

- **Keyboard operability — the one real gap.** `ContextMenu` already handles in-menu nav (↑↓/Home/End/
  Enter/Esc, `role=menu/menuitem`, `aria-activedescendant`). What is missing today is **invocation**:
  the menu only opens from mouse `onContextMenu`. Slice C requires each surface element to be
  **focusable** (roving `tabindex` within the canvas) and to open its menu on **Shift+F10 / the
  context-menu key**, anchored to the element's bounding rect (not the mouse). This is the single
  additive capability in §3.
- **Focus management:** on open, focus moves into the menu (existing behavior once opened via keyboard;
  the highlight starts at the first enabled item for keyboard invocation vs. `-1`/pointer mode for
  mouse). On close, focus **returns to the invoking surface element** — new requirement, verified in
  e2e.
- **Visible focus:** surface focus rings must survive forced-colors/high-contrast (reuse the app focus
  token; do not remove outlines).
- **Accessible names:** every surface that can open a menu needs an accessible name (pins/edges from F;
  add `aria-label` to the group box and, for the pane, an accessible region label).
- **Color not the only signal:** `danger` items pair the red with the trash icon + wording ("Delete…",
  "Remove…") — never color alone. Disabled "Disconnect wires" uses `aria-disabled`, not color only.
- **Announce:** destructive results are announced by the owning action (A/D/F) via the app's live
  region; this slice adds no async result of its own.
- **Reduced motion:** the menu has no comprehension-critical animation; unchanged.

**i18n:**

- **Externalize all labels.** The app currently hardcodes English menu strings; this slice keeps that
  reality but routes every new/relabeled literal through the same string path the rest of the app uses
  (no concatenation): "Add input port", "Add output port", "Rename port…", "Set type…", "Edit
  interface…", "Copy port name", "Copy name", "Disconnect wires", "Remove port", "Edit description…",
  "Delete component", "Group selection", "Encapsulate selection into component", "Explode component",
  "Go up to parent", "Insert space…", "Select all", "Paste", "Copy label", "Edit label…", "Delete
  edge", "Rename group…", "Encapsulate into component", "Ungroup", "Select contents", "Delete group and
  contents". ("Add component here" and "Fit view" are pre-existing pane-menu strings; the rest are
  new/relabeled by C.) No i18n framework exists yet (N/A), but centralizing aids future extraction.
- **Text expansion:** menu width already grows to content and clamps to viewport (`clampMenuPosition`);
  ~30% longer translations are tolerated.
- **RTL:** the menu positions from an anchor; in RTL it should open to the left of the anchor — noted
  for the (absent) RTL pass, not built now (no RTL support in the app today).

## 11. Design tokens (UI)

None added. Reuse the existing `--danger` (destructive items) and the menu separator token
(`.ctxmenu__sep`), and the app focus-ring token for surface focus. Foundation's `--port-warn`
(mismatch) is render-only and not used by any menu item. Theme variants (light/dark) inherit from the
existing `ContextMenu` styles unchanged.

## 12. Assumptions

- The six surfaces are all focusable canvas elements by the time this ships (pins/edges gain focus +
  `aria-label` in Foundation/A; the group box comes from D). If a surface is not yet focusable, its
  Shift+F10 pathway lands with that surface's slice; the menu *inventory* here is still correct.
- Slice D provides the group object, clipboard (for Paste/Select), and insert-space/encapsulate/explode
  actions; slice E provides the interface editor for "Edit interface…"; A provides rename/description/
  icon. Menu items referencing not-yet-built actions are wired as the owning slice lands them; C ships
  the ordering/placement contract regardless.
- Editor-command Title Case (VS Code parity) does not apply here — every canvas item is an object-menu
  item and is sentence-cased.
- `ContextMenu` keeps its current positioning/dismiss behavior; only invocation + focus-return are
  added.

## 13. Decisions Needed (autonomous mode)

- **[normal] #1 — Title menu = body menu (identical) vs. a rename-first focused subset.** Default:
  **identical to body** (obeys "same object → same menu"; the title's uniqueness is the inline-edit
  gesture from A, not a different menu). Reversible.
- **[normal] #2 — Add input/output port on the port-pin menu, or only on the component body/title.**
  Default: **only on the body/title** (a pin menu is about *this* port; avoids duplication). Reversible.
- **[normal] #3 — Classify "Ungroup" / "Explode component" as Edit (non-lossy) vs. Destructive.**
  Default: **Edit** — they promote children rather than delete them; only the lossy "Delete group and
  contents" is Destructive. Reversible.
- **[normal] #4 — "Group selection" / "Encapsulate selection into component" in Create vs. Edit.**
  Default: **Create** on the body menu (both produce a new container object). The group menu's own
  "Encapsulate into component" is left in Edit as a conversion of the existing group — a small,
  flagged asymmetry. **This is the one surviving cross-surface group contradiction** in the slice; if
  zero exceptions are wanted, put both in Create (or both in Edit). Reversible.
- **[normal] #5 — Multi-select right-click scope (incl. mixed node/edge/group selections).** Default:
  selection-scoped items act on the whole selection; Group/Encapsulate use the selected **nodes only**
  (auto-including edges between them); a selection Delete removes all selected objects; single-only
  items act on the clicked node and are disabled while >1 object is selected; right-clicking a
  non-selected node collapses to it first. Reversible.
- **[normal] #6 — "Disconnect wires" placement.** Default: **Destructive** (it removes edges),
  disabled when the port has none — rather than treating it as a neutral Edit. Reversible.
- **[normal] #7 — Relabel the existing "Delete node" → "Delete component".** Default: **relabel** for
  cross-surface wording consistency (the app already says "Component"). Trivially reversible.
- **[normal] #8 — Ship Paste / Select all / Copy label / Copy port name / Select contents in this
  slice or defer to v1 (they depend on slice D's clipboard/selection model).** Default: **defer the
  clipboard/selection-parity items to v1**; ship the structure so they slot into the right group when D
  lands. The always-available items (types, rename, delete, drill, group ops) ship now. Reversible.
- **[normal] #9 — Keyboard invocation (Shift+F10 + focus-return + focusable surfaces): build into the
  shared `ContextMenu` open path now, or per-surface later.** Default: **add the anchor-based open +
  focus-return once** (shared, additive to `ContextMenu`) so all six surfaces inherit it — a11y is
  non-negotiable for a menu feature. Reversible (additive).

No `high`-severity decisions: every choice above is additive and reversible, and none changes the data
model (Foundation owns that).

## 14. Self-audit

Core spine: problem ✓ · behavior/states ✓ (canonical convention + six surfaces + consistency matrix) ·
data/interface contract ✓ (menu is arrangement-only; the one additive open-anchor capability named) ·
edge cases ✓ · defaults/settings ✓ · scope slicing ✓ · acceptance (declarative + EARS + Gherkin) ✓.
UI module: state catalog ✓ · interaction inventory ✓ · a11y + i18n ✓ (keyboard-invocation gap named as
the one real accessibility requirement; every label enumerated for externalization) · design tokens ✓
(none added, reuse). All six requested surfaces enumerated with primary + destructive marked and
keyboard/focus behavior stated; boundary-pin read-only variant added for Foundation-consistency. Every
action is *referenced* to its owning slice (A/B/D/E/F/existing), none redesigned. No empty sections;
N/A states justified inline. Nine `normal` decisions flagged, zero `high`.
