---
status: active
date: 2026-07-06
tier: FULL
type: UI
slice: E
epic: architecture-node-graph
---

# Architecture node-graph — Slice E: Interface / type authoring

**Tier:** FULL   **Feature type:** UI
**One-line request:** Spec the authoring experience for document-level typed
interfaces — create/rename/delete an interface, add/edit/reorder/remove its fields,
set each field's `TypeRef` (primitive / list-of / ref, incl. inline nested
interfaces), and the type picker that assigns an interface as a port's type.

> **Contract source of truth:** `docs/specs/2026-07-06-arch-foundation-ports-types.md`
> (slice F). F owns the **data model** (`InterfaceDef`, `InterfaceField`, `TypeRef`,
> `doc.interfaces`), the JSON schema, the `conduit-architecture` SKILL, and the pure
> reducers (`setPortType`, interface CRUD). **This slice owns the authoring UI only.**
> Where a rule already lives in F it is referenced, never re-specified. Neighboring
> slices referenced by name: port pins/wiring = **A/F**; drill navigation/breadcrumb =
> **B**; context menus = **C**; grouping/encapsulate = **D**.

## 1. Problem frame

- **Job (JTBD):** A user designing a node graph needs a component's output/input ports
  to carry *structured* meaning — a port isn't just "user data: string", its type is an
  interface `User { name: string; birthYear: number; friends: List<User> }` — so the
  coding **agent can read the contract and generate real types/code**. Today ports can
  at most be untyped or a bare primitive (F); there is no way to *author* the structured
  types that make the graph a machine-readable contract. This slice is that authoring
  surface.
- **Actors:** the human architect (defines/reuses interfaces while wiring); the coding
  agent (reads `doc.interfaces` + port types to generate code — F's contract).
- **Success outcomes (observable):**
  - A user can create a named interface, give it fields, and type each field as a
    primitive, a list-of, or a ref to another interface (including a *new* one made
    inline), all without leaving the architecture view.
  - The same interface is defined **once** and reused across many ports; editing it
    updates every consumer.
  - Deleting an interface that ports/fields reference degrades safely (refs clear per
    F invariant 3) and the UI *tells the user* what was cleared.
  - Recursive/cyclic references are authorable and shown as a navigable chip, never an
    infinite expansion.
- **Non-goals (out of scope here):**
  - The `InterfaceDef`/`TypeRef` data model, JSON schema, and SKILL — **F owns these**;
    this spec does not re-define the schema.
  - Port pins, the add/remove-port affordances, and port-to-port wiring/mismatch — **A/F**.
  - Code generation itself (agent turning `doc.interfaces` into `.ts`) — the agent's job,
    per F's SKILL. §12 only notes the consumption contract.
  - A general in-app localization framework (the app currently ships hardcoded English;
    see §10 / Decision 7).

## 2. Behavior & states

**Where the authoring UI lives — decision + justification.** The authoring surface is a
**dedicated, document-scoped side panel ("Interfaces")** — a peer of the existing
component `Inspector` (`arch__inspector`, `architecture-view.tsx`), rendered as a right-
hand `<aside>`. It is **master-detail**: a list of all `doc.interfaces` (master) and, for
the selected interface, its field editor (detail). Rejected alternatives:

- **Modal** — interfaces are consulted *while wiring ports*; a modal blocks the canvas and
  breaks the "pick a type for this port, glance at the graph" loop. Rejected.
- **"Drill into" a type like a component** (its own canvas, slice B mechanics) — an
  interface is a *field list* (a form), not a spatial node graph; forcing it into the
  canvas/breadcrumb model is a category error and collides with B's node-drill semantics.
  We *borrow* the navigational feel — clicking a ref chip **navigates** the panel to that
  interface with a back affordance — but the surface stays a panel, not a canvas.
- **Per-node inspector section** — interfaces are **document-global**, reused across many
  nodes/graphs; nesting their editor inside one node's inspector wrongly implies ownership
  by that node. Rejected. (The node Inspector instead gets a read-only "Ports" summary in
  A/F; type *assignment* happens through the shared picker, §2.5.)

The panel is reached from three entry points: (a) an **"Interfaces" affordance in the arch
header** (`arch__head`), showing a count badge; (b) the **type picker's** "Edit interface…"
/ "New interface…" actions (§2.5); (c) a port/field **ref chip's** "open definition" action.

**Layout / responsive:** the panel is a fixed-min-width right-hand `<aside>` (min-width
sized to hold a type chip + field controls without wrapping, matching `arch__inspector`).
When it and the component Inspector would both be open, the **Interfaces panel takes
precedence** (interfaces are the document-scoped surface); the two do not stack. On a narrow
viewport the panel overlays the canvas edge (canvas stays visible/pannable behind) rather
than shrinking below its min-width. Resizability is deferred (v1 polish), matching the
Inspector which is not resizable today.

### 2.1 Primary flow (happy path)

1. User opens the **Interfaces** panel → sees the list (or blank slate if none).
2. Clicks **+ New interface** → an empty `InterfaceDef` is created (default name
   `Interface{n}`), selected, and its (empty) field editor opens.
3. Renames it inline to `User`.
4. **+ Add field** → a field appears (default name `field1`, default type primitive
   `string` — Decision 3). User renames it `name`.
5. Adds `birthYear`, opens its **type picker**, chooses primitive `number`.
6. Adds `friends`, type picker → **List of ▸ Interface ▸ User** → the field chip reads
   `List<User>` (self/cyclic ref — rendered as a chip, never expanded; F invariant 4).
7. Adds `address`, type picker → **Interface ▸ New interface…** → an empty `Address`
   interface is created inline, the ref assigned, and the panel navigates to `Address`
   for immediate authoring; a **back** affordance returns to `User`.
8. On a component's **output port** (pin owned by A/F), user opens the same type picker →
   **Interface ▸ User** → the port is now typed `User` (F's `setPortType`). The agent can
   now read the contract.

### 2.2 Interface lifecycle states

`no interfaces (blank slate)` · `interface list (populated)` · `interface selected /
detail open` · `interface with zero fields (empty detail)` · `renaming interface
(inline edit)` · `delete-confirm pending` · `deleted → references cleared (advisory)`.

### 2.3 Field lifecycle states

`field row (default)` · `renaming field name (inline edit)` · `type-picker open` ·
`optional toggled` · `editing description` · `reordering (dragging / keyboard-moving)` ·
`field with ref to a live interface (navigable chip)` · `field with ref to a deleted
interface (fell back to \`any\`, advisory)` — see Decision 2.

### 2.4 Type picker states

`closed` · `open (root menu: Untyped* / primitives / List of… / Interface ▸)` ·
`interface submenu — empty registry (only "New interface…")` · `interface submenu —
searchable list of doc.interfaces + New interface…` · `search with no match ("No interface
'Foo' — Create 'Foo'")` · `composing list-of (nested picker, chip builds \`List<…>\`)` ·
`committed`. *Untyped is offered for **ports** only; interface **fields** require a type
(F: `InterfaceField.type` is non-optional) so the field picker omits Untyped and defaults
to `string`.* **UX note:** because a field can never be untyped, "removing" a field's type
means picking `any` — the field picker surfaces `any` as the explicit "no specific type"
choice (users looking for a "clear type" action land there).

**Inline-create naming rule:** creating from **"New interface…"** (blank) uses default name
`Interface{n}`; creating from the no-match CTA **"Create 'Foo'"** names the new interface
`Foo` (the typed search string). Either way the ref is assigned immediately and the panel
opens the new interface for authoring.

### 2.5 The shared type picker (E owns the UX; F owns the writes)

One picker component serves **both** a field's type and a **port's** type. The seam:

- E renders the picker and computes the chosen `TypeRef`.
- For a **field**, E calls F's interface-field reducer to persist `field.type`.
- For a **port**, E calls **F's `setPortType(doc, graphId, nodeId, portId, typeRef)`** —
  F owns the port data model; E only supplies the pick UX (this is the "pick" F's spec
  defers to E). The picker may also be launched from a port's **context menu** (slice C).

Picker option tree:

```
Untyped            (ports only)
─ primitives ─     string · number · boolean · date · json · any
List of…       →   (recurse: element is itself a full TypeRef → List<inner> chip)
Interface  ▸   →   [ searchable list of doc.interfaces ]
                   New interface…   (creates empty InterfaceDef, assigns ref, opens it)
```

## 3. Data / interface contract

**No new persisted shape is defined here — the model is F's** (`InterfaceDef { id, name,
description?, fields: InterfaceField[] }`, `InterfaceField { name, type: TypeRef, optional?,
description? }`, `TypeRef = primitive | list | ref(interfaceId)`, registry `doc.interfaces:
Record<id, InterfaceDef>`). This slice consumes F's pure reducers. Expected reducer surface
(names indicative; **F owns final signatures**, all pure, ref-based like `addNode`):

| UI action | Reducer (F) | Notes |
|---|---|---|
| Create interface | `addInterface(doc, {name?})` → `{doc, id}` | default name `Interface{n}`, empty fields |
| Rename interface | `renameInterface(doc, id, name)` | empty name → no-op (revert) |
| Delete interface | `removeInterface(doc, id)` | clears all refs to it (F invariant 3); see Decision 2 |
| Add field | `addInterfaceField(doc, id, {name?, type?})` | default `field{n}`, type primitive `string` |
| Rename / edit field | `updateInterfaceField(doc, id, index, patch)` | name/type/optional/description |
| Reorder field | `moveInterfaceField(doc, id, from, to)` | pure array move |
| Remove field | `removeInterfaceField(doc, id, index)` | immediate; no per-field confirm |
| Set field type | via `updateInterfaceField(... {type})` | `TypeRef` from picker |
| Set **port** type | `setPortType(doc, graphId, nodeId, portId, type?)` | **port model = F**; picker = E |

The "default name / default type" values above are **call-site arguments E passes** (its
authoring defaults, §5), not behavior E dictates inside F's reducers — if F bakes different
defaults in, E simply stops passing them. E owns none of the reducer internals.

**UI-derived (not persisted) values this slice computes for display:**

- **Usage count** per interface = number of ports (`inputs`/`outputs` across all graphs)
  **and** interface fields whose `TypeRef` resolves (transitively) to `ref: id`. Computed
  by a guarded walk (visited-set — F invariant 4) so a cyclic registry can't hang the count.
  This is an O(ports + fields) sweep; **memoize it against `doc` identity** (recompute only
  when `doc` changes, not per keystroke/render) so a large graph doesn't re-walk on every
  edit.
- **Type chip label** — a display string composed from a `TypeRef`: `string`, `List<User>`,
  `List<List<number>>`, `User`, `Untyped`. Composed via a formatter, **never sentence
  concatenation** (§10).

**Invariants (surfaced, owned by F):**

1. Interface `id`s are stable; `name` is display-only. Renaming never breaks refs
   (F: refs are by `id`).
2. A `ref` to a missing/deleted interface clears (F invariant 3). For a **port** → untyped.
   For a **field** (which must carry a type) → `any` (Decision 2, needs F confirmation).
3. Cyclic/self references are legal data; the UI resolves them with a visited-set and shows
   a **ref chip**, never an expanded tree (F invariant 4).

## 4. Edge cases & failure modes

| Condition | Expected behavior / recovery |
|---|---|
| **Concurrency / double edit** | Edits go through the existing synchronous `applyDoc` (ref-based, last-write-wins) + debounced save (`useDebouncedFlush`). Two quick renames → last commit wins; no partial state. |
| **Agent proposal accepted while panel open** | The arch proposal banner can replace `doc`. If the accepted doc drops the selected interface, the detail closes to the list with a message; if it drops a referenced interface, affected chips re-render as cleared. Panel re-reads from the new `doc`, never from stale local state. |
| **Zero / one / many interfaces** | Zero → blank slate (§8). Many → scrollable list + filter box. |
| **Zero / many fields** | Zero fields → empty-detail state ("No fields yet — add one to describe this type"). Many → scroll; no hard cap. |
| **Many references to one interface** | Usage count badge (e.g. "Used by 12"); delete confirm states the count. |
| **Delete a referenced interface** | Confirm dialog names the blast radius; on confirm, refs clear (ports→untyped, fields→`any`), a **polite live-region** announces "Interface User deleted — N references cleared." Ports/fields are **not** cascade-deleted. |
| **Deep / cyclic ref nesting** | Self-ref (`User.friends: List<User>`) and mutual cycles are allowed; count + chip use a visited-set (no infinite loop). Chip truncates very deep `List<List<…>>` with a tooltip showing the full type. |
| **Empty interface / field name on commit** | Reverts to the previous name (a name is required), mirroring F's port-rename rule. |
| **Duplicate interface or field names** | Allowed (ids/positions disambiguate) but soft-warned inline — the agent contract prefers unique names (mirrors F's port-name stance). Never blocked. |
| **"List of…" picked but element not chosen** | Element defaults to primitive `string`; user can re-open to change. Cancelling the picker leaves the prior type untouched. |
| **"New interface…" then user cancels naming** | The interface persists with its default name `Interface{n}` (creation is committed on selection, not on naming) — reversible via rename/delete. Rationale: avoids a half-created dangling ref. |
| **No-op reorder** | Dropping a field on its own position, or a keyboard-move at the first/last boundary, is a no-op (`from === to`) — no doc write, no announcement. |
| **Persistence failure** | Save goes through the existing host-owned `updateArchitecture` path (shared with all arch edits). If the host reports a save failure, the panel surfaces the **existing arch save-error affordance** (same as component edits) — this slice does not invent a private one, but it must **not** silently swallow the failure; edits stay in the in-memory `doc` so a retry/next-edit re-attempts. (The save mechanism itself is F/host-owned and unchanged.) |
| **Stale detail (interface deleted elsewhere)** | Open detail for a now-missing interface closes to the list with "This interface no longer exists." |

## 5. Defaults vs. settings

| Decision | Default | Configurable? | Rationale |
|---|---|---|---|
| Authoring surface | Right-side document-scoped **Interfaces panel** (master-detail) | No (v1) | Matches existing Inspector pattern; non-blocking while wiring. Reversible. |
| New interface name | `Interface{n}` | No — rename inline | No central counter; matches F's `in{n}`/`out{n}` port naming. |
| New field name | `field{n}` | No — rename inline | Same. |
| New field type | primitive `string` | No | Fields require a type (F); `string` is the most common structured-field type. |
| Field `optional` | `false` | Per field | Required-by-default matches how most typed fields read. |
| Deleting an interface | **Confirm dialog** (in-app `ConfirmDialog`) | No | High blast radius (many consumers). Uses the renderer dialog, not a native one (native dialogs are invisible to the smoke harness). |
| Removing a field | Immediate, no confirm | No | Low blast radius, easily re-added; the app has no global undo, so a confirm on every field row would be noise. |
| Ref cleared on delete | ports→untyped, fields→`any` | No | Matches F invariant 3; never cascade-delete. |
| Duplicate names | Allowed + soft warning | No enforced-uniqueness setting (v1) | Frictionless authoring; agent contract merely *prefers* unique. |

## 6. Scope slicing

- **MVP (must):** Interfaces panel (list + blank slate + count badge); create / rename /
  delete interface (with confirm + reference-clear announcement); add / rename / remove
  field; the **shared type picker** (Untyped* / primitives / List of… / Interface ▸) wired
  to F's field + `setPortType` reducers; mark field optional; navigable ref chips (no
  infinite expansion); usage count; full keyboard operability + a11y baseline (§9–10).
- **v1 (should):** field **reorder** (drag handle **and** move-up/down buttons **and**
  keyboard); **"New interface…" inline** from the picker (nested creation) + panel
  navigation/back; field `description`; search/filter in both the panel list and the
  interface submenu; duplicate-name soft warnings; `List<List<…>>` composer polish + chip
  truncation/tooltip.
- **Vision (could):** import/derive interfaces from existing code (reverse of generation);
  unions/generics; per-field validation constraints; "go to generated code" from an
  interface; drag a port's ref chip onto another port to copy its type.
- **Out of scope:** the data model/schema/SKILL (F); port pins & wiring (A/F); code
  generation (agent); a localization framework (Decision 7).

## 7. Acceptance criteria

### Declarative

- Creating an interface adds one `InterfaceDef` to `doc.interfaces` with a stable id and a
  default name, selects it, and opens an empty field editor.
- Adding a field appends an `InterfaceField` with a default name and a **valid `TypeRef`**
  (never an undefined type); the field is immediately editable.
- Choosing **Interface ▸ User** for a field or a port persists `{kind:'ref', interfaceId}`
  and renders a `User` chip; choosing **List of ▸ User** renders `List<User>`.
- A field referencing its own interface (`List<User>` on `User`) renders as a chip and the
  panel/usage-count never hangs.
- Deleting an interface used by N ports/fields shows a confirm naming N, clears those refs
  (ports→untyped, fields→`any`) without deleting the ports/fields, and announces the clear.
- Every action above is reachable by keyboard alone; deleting is confirmable/cancelable by
  keyboard.
- All user-facing copy is centralized (no literals inlined in JSX) and no type label is
  built by concatenating translatable sentence fragments.

### EARS

- **Event:** *When* the user selects an interface in the type picker for a port, the system
  *shall* set that port's type to a `ref` and render the interface's name as a type chip.
- **Event:** *When* the user confirms deletion of an interface, the system *shall* remove it
  from the registry, clear every reference to it, and announce the number cleared via a
  polite live region.
- **State:** *While* an interface's detail is open, the system *shall* reflect external
  changes to `doc` (e.g. an accepted agent proposal) without losing or corrupting the panel.
- **Unwanted:** *If* the user commits an empty interface or field name, *then* the system
  *shall* revert to the previous name.
- **Unwanted:** *If* a field's `ref` targets a deleted interface, *then* the system *shall*
  fall back to `any` and mark the field as cleared, never showing a broken/empty type.
- **Optional:** *Where* an interface field references another interface, the system *shall*
  render a navigable chip (with a visited-set guard) rather than expanding the nested type
  inline.

### Gherkin

```gherkin
Feature: Interface / type authoring

  Background:
    Given the architecture view is open with an empty interface registry

  Scenario: Author a nested, self-referential interface
    Given I open the Interfaces panel and create an interface named "User"
    When I add a field "name" of type string
    And I add a field "friends" and choose "List of" then "Interface" then "User"
    Then the "friends" field shows the type chip "List<User>"
    And the panel does not hang resolving the self-reference

  Scenario: Assign an interface to an output port
    Given an interface "User" exists
    When I open the type picker on a component's output port and choose "User"
    Then the port's type is a ref to "User" and shows a "User" chip

  Scenario: Delete an interface that ports and fields reference
    Given "User" is referenced by 2 ports and 1 interface field
    When I delete "User" and confirm
    Then the 2 ports become untyped and the field's type becomes "any"
    And a polite announcement states that 3 references were cleared
    And no port or field is removed
```

## 8. State catalog (UI)

| Component | State | What the user sees | Action / CTA |
|---|---|---|---|
| Interfaces panel | Blank slate | "No interfaces yet. Create one to give ports a structured type." | **+ New interface** |
| Interfaces panel | Populated | Scrollable list, each row: name + field count + "Used by N" | select / **+ New interface** / filter |
| Interfaces panel | Filtering, no match | "No interface matches 'X'." | clear filter / **Create 'X'** |
| Interface detail | Selected, has fields | Header (editable name, description, "Used by N", delete) + field rows | edit fields |
| Interface detail | Selected, zero fields | "No fields yet — add one to describe this type." | **+ Add field** |
| Interface detail | Renaming | Inline text input on the name | Enter commit / Esc revert |
| Interface detail | Not-found (deleted elsewhere) | "This interface no longer exists." | back to list |
| Field row | Default | name · type chip · optional badge · drag handle · remove | edit any part |
| Field row | Editing name | Inline textbox | Enter/blur commit, Esc cancel |
| Field row | Type picker open | Popover menu (§2.5) | pick / Esc close |
| Field row | Ref → live interface | Clickable chip `User` / `List<User>` | open definition (navigate) |
| Field row | Ref → deleted interface | Chip `any` + "was <name>" advisory | re-pick type |
| Field row | Reordering | Row lifts (drag) or shows move affordance (keyboard) | drop / arrow-move |
| Type picker | List-of composing | Breadcrumb chip building `List<…>` | choose element / back |
| Delete confirm | Pending | `ConfirmDialog`: "Delete User? N references will be cleared." | Confirm (danger) / Cancel |
| Live region | After clear | (visually silent) polite text: "Interface User deleted — N references cleared." | — |
| Save error | Host reports save failed | Shared arch save-error affordance (not a private one); edits retained in-memory | retry / next edit re-attempts |
| Limit | Many interfaces/fields | No hard cap — list/detail scroll; no limit warning by design | — |

Loading / offline / permission / partial / first-run-vs-empty-after-action states:
**not applicable** — all data is the already-loaded in-memory `doc` (no async fetch; the
registry has no "cleared after action" distinct from the blank slate, and no permission
scoping). Persistence is the existing debounced save; its failure surface (row above) is
host-owned and shared. Stated per the checklist rather than silently dropped.

## 9. Interaction inventory (UI)

| Component | Actions | Pointer | Keyboard | Touch | Context menu | ARIA role/states |
|---|---|---|---|---|---|---|
| Interfaces panel | open/close, filter | click header badge; type in filter | focusable header control (Enter/Space); `/` focuses filter | tap | — | `region`, `aria-label="Interfaces"` |
| Interface list | select, create | click row / **+ New** | roving focus, ↑/↓ move, Enter select | tap | (C) "New interface" | `listbox`/`option`, `aria-selected` |
| Interface name | rename | click → input | F2/Enter edit, Enter commit, Esc revert | tap | — | labelled `textbox` |
| Interface delete | delete | click trash | focusable, Enter/Space | tap | (C) "Delete interface" | `button`, opens `alertdialog` |
| Add field | add | click **+ Add field** | focusable, Enter/Space | tap | — | `button` |
| Field name | rename | click → input | F2/Enter edit, Enter/Esc | tap | — | labelled `textbox` |
| Field type chip | open picker | click chip | Enter/Space opens picker | tap | (C) "Set type" | `button`, `aria-haspopup="menu"` |
| Type picker | choose type | click item / submenu | ↑/↓ items, →/Enter into submenu, ←/Esc back/close | tap | — | `menu`/`menuitem`, `aria-expanded` |
| Interface submenu search | filter interfaces | type in filter field | filter field is a real textbox at the submenu top (not menu typeahead); ↑/↓ move the roving focus through *filtered* results, Enter selects, Esc clears/closes | tap | — | `combobox`-style: textbox + `listbox` of options, `aria-activedescendant` |
| Optional toggle | mark optional | click | Space toggles | tap | — | `switch`/`checkbox`, `aria-checked` |
| Description | edit prose | click → textarea | Tab in, Esc out | tap | — | labelled `textbox` |
| Field reorder | reorder | drag handle | select handle → ↑/↓ moves → Enter/Esc drop/cancel; **plus** move-up/down buttons | long-press drag | (C) "Move up/down" | handle `button`, `aria-label`; announce moves |
| Ref chip (navigate) | open definition | click | Enter/Space | tap | — | `button`, `aria-label="type User, open definition"` |
| Remove field | remove | click trash | focusable, Enter/Space | tap | (C) "Remove field" | `button` |
| Port type assign | set port type | open picker from pin | pin focus → Enter opens picker (A/F pin) | tap | (C) "Set type" | picker as above; writes via F `setPortType` |

Rules honored: **every drag action (field reorder) has a non-drag pathway** — move-up/down
buttons + keyboard pickup/move/drop. Distinct default/hover/focus/selected/disabled/dragging
styles; selection and optional/mismatch never rely on color alone (paired text/icon).
Destructive interface delete is confirmed; field remove is cheap + immediate (Decision 4).

## 10. Accessibility & i18n (UI)

**Accessibility (WCAG 2.2):**

- **Keyboard operability** for the whole flow — create/rename/delete interface, add/rename/
  reorder/remove field, open the type picker and traverse its submenus, toggle optional,
  navigate ref chips — all without a pointer (§9).
- **Visible focus** on every control (panel rows, chips, picker items, dialog buttons);
  must survive forced-colors / high-contrast (do not paint state with color only — pair
  with text/icon; e.g. optional shows an "optional" label, not just a tint).
- **Accessible names** — icon-only controls (drag handle, trash, chevron/back) get
  `aria-label`; every input has a `<label>`; ref chip `aria-label` names the type and the
  action ("type List of User, open definition").
- **Announce dynamic outcomes** via `aria-live="polite"`: reference-clear on delete
  ("N references cleared"), reorder ("Moved field birthYear to position 2"), inline-create
  ("Created interface Address").
- **Drag alternative** — field reorder has keyboard pickup/move/drop + buttons (WCAG 2.5.7).
- **Type-mismatch** state on ports (A/F) is exposed via text + `aria-invalid`, never color
  alone — this slice's chips follow the same rule.
- **Reduced motion** — panel navigation (master→detail, back) must not depend on animation
  to be understood; honor `prefers-reduced-motion`.
- **Focus management** — the delete `ConfirmDialog` traps focus and (destructive) defaults
  to Cancel (`focusCancel`, matching the existing dialog); after deleting an interface,
  focus lands on the list. After inline-create, focus lands in the new interface's name
  field. Opening the picker moves focus into the menu; closing returns it to the chip.

**Internationalization:**

- **Externalize all copy** — "New interface", "Add field", "Used by {n}", "Delete {name}?",
  primitive labels' surrounding text, blank-slate strings — through the app's centralized
  string path; **no literals hardcoded in JSX** (matches F's directive). *Note (Decision 7):*
  the app currently ships hardcoded English with no i18n framework; this slice keeps strings
  centralized and interpolated so a future framework is a drop-in, and does **not** build the
  framework here.
- **No sentence concatenation** — the type-chip label (`List<User>`) is built by a formatter
  with placeholders, not by gluing translated words.
- **Pluralization** — **every** count-bearing string is plural-aware, not just one: "Used by
  {n} ports", the delete announcement "{n} references cleared", and the reorder announcement
  "Moved field {name} to position {n}" all use plural-aware formatting (so `n === 1` never
  reads "1 references").
- **Primitive/type identifier names** (`string`, `number`, `List`, interface names) are
  **not localized** — they map to code identifiers the agent generates (Decision 7).
- **Text expansion** — the panel and chips tolerate ~30%+ longer labels (interface/field
  names are user-supplied and unbounded already); chips truncate with a tooltip, list rows
  wrap/scroll rather than clip.
- **RTL** — the panel mirrors; the `List<…>`/`User` chip keeps its type expression LTR
  (a code expression) even in an RTL layout (decide-and-flag candidate, low risk).

## 11. Design tokens (UI)

Reuse the existing palette (`webview/styles.css`) — **no new palette**:

- Panel chrome: `--raise` (surface), `--border-2` (dividers), `--text` / `--text-dim` /
  `--text-faint` (name / secondary / optional badge), matching `arch__inspector`.
- **Type chip**: one semantic role, mapped to an existing accent (`--accent-2` or
  `--violet`) so a typed port/field reads at a glance; the **untyped/`any` fallback** chip
  uses `--text-faint` (muted, signalling "no real type").
- **Mismatch/warn** (ports, A/F): reuse F's single `--port-warn` token (= `--amber`); this
  slice adds **no** new token.
- Selection/focus: existing focus-ring token; selected list row uses the same treatment as
  `archnode--sel` (border/tint + not color-only).
- Theme variants: inherit light/dark/high-contrast from the shared tokens; verify chip
  contrast ≥ 4.5:1 and that the muted `any` chip stays distinguishable in high-contrast
  (pair with the literal text "any", never tint alone).

## 12. How the agent consumes these definitions (reference only)

Per **F's SKILL + schema** (not re-specified here): the coding agent reads `doc.interfaces`
plus each port's `type` from `.conduit/architecture.json` and generates real types/code — an
`InterfaceDef` becomes a named type/interface/struct; a field's `TypeRef` maps `primitive →`
language primitive, `list → array/collection`, `ref → the named type`; `optional` →
nullable/`?`. A port typed `ref: User` tells the agent the exact shape flowing across that
wire. This authoring UI's whole purpose is to make that registry expressible by a human; the
mapping and round-trip are F's contract.

## 13. Assumptions

- The panel reuses the existing `ConfirmDialog` (renderer, not native) for interface
  deletion — consistent with the app and smoke-testable (native dialogs hang the harness).
- F exposes pure interface-CRUD + `setPortType` reducers (§3); this slice calls them and owns
  no persisted shape. If a signature differs, only the call sites here change.
- Usage-count/reference resolution uses a visited-set guard (F invariant 4).
- Persistence uses the existing `applyDoc` + `useDebouncedFlush` path unchanged.

## 14. Decisions Needed (autonomous — no human was asked)

- **[high] Merge into F, or stay a separate slice?** — **Recommendation: stay separate.**
  F owns the *model* (schema, SKILL, reducers) and the *minimal* port UX (add/rename/remove
  port, wire, and a stub "pick a type"); **E owns the full authoring surface** (Interfaces
  panel, field CRUD, reorder, inline nested creation, the reference-safety UI) **and the
  shared type-picker component**, which F *consumes* for its port "pick". Sequence **E after
  F** (E depends on F's model + `setPortType` landing). Merging would bloat F's spec (it is
  explicitly "the model only") and couple two independently shippable UI surfaces. Default
  taken: **separate**, with the type picker as the named seam (E-owned, F-consumed).
- **[high] What does "ref clears to untyped" mean for an interface *field*?** — F invariant 3
  says a dangling `ref` "clears to untyped", but `InterfaceField.type` is **required** (can't
  be `undefined`). Default taken: a field's cleared ref falls back to **primitive `any`**
  (the untyped-equivalent that keeps a valid `TypeRef`); ports (whose `type` is optional)
  clear to genuinely untyped. **F should confirm** this in the model/validator so UI and data
  agree. Reversible, but a cross-slice correctness gap — flagged high.
- **[normal] New field default type = primitive `string`.** — Fields require a type; `string`
  is the most common. Default taken: `string` (per-field reversible via the picker).
- **[normal] Field removal is immediate (no per-field confirm); only interface delete
  confirms.** — No global undo exists; a confirm per field row would be noise, while an
  interface delete has wide blast radius. Default taken: immediate field remove + confirmed
  interface delete.
- **[normal] Authoring surface = right-side document-scoped panel** (not modal, not a canvas
  drill). Justified in §2; reversible. Default taken: side panel.
- **[normal] Duplicate interface/field names allowed with a soft warning** (mirrors F's
  port-name stance); no enforced-uniqueness setting in v1. Default taken: allow + warn.
- **[normal] No localization framework is built here; type identifiers are not localized.**
  — The app currently hardcodes English; this slice only keeps strings centralized and
  avoids sentence concatenation. Default taken: centralize-but-don't-frameworkify.

## Self-audit

Core spine: problem ✓ · behavior/states ✓ · data/interface contract ✓ (defers persisted
shape to F, specifies the UI-derived values + reducer surface it consumes) · edge cases ✓ ·
defaults/settings ✓ · scope slicing ✓ · acceptance (declarative + EARS + Gherkin) ✓. UI
module: state catalog ✓ (inapplicable async/loading states stated, not dropped) · interaction
inventory ✓ (every drag has a non-drag + keyboard path) · accessibility & i18n ✓ · design
tokens ✓ (no new palette). Cross-slice ownership stated (A/F pins, B nav, C menus, F model).
Merge-vs-separate explicitly flagged (Decision 1). No empty sections; no placeholders.
