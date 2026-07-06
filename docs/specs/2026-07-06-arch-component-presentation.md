---
status: active
date: 2026-07-06
tier: FULL
type: UI
slice: A
epic: architecture-node-graph
---

# Architecture node-graph — Slice A: Component presentation & inline editing

**Tier:** FULL   **Feature type:** UI
**One-line request:** Make architecture components look good and directly editable —
in-place title edit, a summary + assignable icon per component, a Grasshopper-style
(but Conduit-themed) restyle with named port pins, and distinct visuals for leaf /
complex / empty components.

> **Reads the shared contract, does not redefine it.** The data model (ports,
> `TypeRef`, `doc.interfaces`, the `boundary:in`/`boundary:out` convention) is owned by
> the foundation spec `2026-07-06-arch-foundation-ports-types.md`. This slice owns only
> the **visual presentation** and **inline title/summary/icon editing** of a component,
> plus the **reveal rule** for port widgets. Where a concern belongs to a neighbor it is
> named, not specified:
> - **Drill navigation** (open/create nested canvas, breadcrumb, Escape, rendering the
>   derived boundary nodes) — **slice B**.
> - **Port data & behavior** (add / rename / remove / type / wire a port) — **slice F**.
>   A owns how a pin *looks* and *when the `+`/`−` widgets appear*; F owns what they *do*.
> - **Right-click / context menus** — **slice C**.
> - **Interface / type picker UI** — **slice E**.

## 1. Problem frame

- **Job:** A user architecting a system wants each component on the canvas to (a) be
  legible and pleasant at a glance, (b) be renameable and describable *directly on the
  canvas* without hunting through a side panel, (c) carry a recognizable icon, and (d)
  visually tell them, without clicking, whether a component is a leaf, is a container
  they can drill into, or is a fresh placeholder still needing setup. Today's card is a
  cramped stripe+icon+title row the user described as "not looking that great," and the
  only rename path is the Inspector Title field.
- **Actors:** the human architect (authoring in Conduit). The coding agent reads the
  resulting `title`/`subtitle`/`description`/`icon`/ports from `architecture.json`
  (round-trip owned by F) — this slice does not add agent-facing surface.
- **Success outcomes (observable):**
  1. Double-clicking a component's name turns it into an in-place text field; Enter or
     blur commits, Esc cancels, an empty value reverts to the prior name.
  2. A component shows a name, an optional one-line summary, and an icon, and reads
     cleanly (spacing, contrast, selection state) in every app theme.
  3. Leaf, has-children (complex), and brand-new-empty components are visually distinct
     at a glance without interacting.
  4. Named input/output ports render as labeled pins down the left/right edges; the
     `+`/`−` port widgets appear per the reveal rule (zoom-in / selection) rather than
     cluttering every card at all times.
- **Non-goals:** the port data model and add/rename/wire *actions* (F); drilling and
  boundary-node rendering (B); menus (C); the interface/type editor (E); changing the
  Inspector's role as the full detail editor (it stays — this slice adds a faster inline
  path and a restyle, it does not remove the panel).

## 2. Behavior & states

### Primary flows (happy paths)

- **Inline title edit.** User double-clicks the title text of a component → the title
  becomes a focused, text-selected input in place → user types → **Enter** or **blur**
  commits the trimmed value via `updateNode(...,{title})`; **Esc** cancels and restores
  the pre-edit value; an **empty/whitespace-only** commit is rejected and reverts to the
  previous title (a component must have a name — mirrors the edge-label rule already in
  `architecture-view.tsx`). F2 on a selected/focused component enters the same editor
  (keyboard path).
- **Inline summary edit.** The one-line summary is the existing `subtitle` ("role /
  tech"). Double-clicking the summary line (or the placeholder when empty) enters an
  inline editor with the same commit/cancel semantics; an empty commit here **clears**
  `subtitle` (unlike title, a summary is optional). Also editable in the Inspector as
  today.
- **Description.** The existing longer-prose `description` field stays edited in the
  Inspector "Notes" textarea (unchanged). On the canvas it surfaces as the card's
  **hover tooltip / title attribute** and (when present) a small "has notes" glyph — it
  is not inline-edited on the card (see Decisions Needed #3).
- **Assign an icon.** With a component selected, the Inspector shows an **icon picker**:
  the component's current glyph plus a grid of choices drawn from the app's existing icon
  registry (the `KIND_ICON` set + a curated general set). Picking one sets the new
  optional `icon` field (a stable glyph key string, per the foundation model) via
  `updateNode`. "Reset to kind default" clears `icon`. When `icon` is unset the card
  falls back to the kind's default glyph (today's behavior), so nothing breaks.
- **Create.** A newly added component (`addNode`, default title "New component", no
  subtitle/description/icon/ports/childGraph) renders in the **empty/unconfigured** style
  and **auto-enters inline title edit** so the user names it immediately (see Decisions
  Needed #6).
- **Port pins.** When a component has declared `inputs`/`outputs` (F's data), each port
  renders as a labeled pin on the correct edge (inputs left, outputs right, ordered
  top→bottom). A legacy component with no declared ports keeps today's single centered
  handle on each side. The `+` (add input / add output) and per-pin `−` widgets are
  revealed per the reveal rule; their behavior is F.

### State catalog

See §8 for the full UI state catalog (this is a UI feature). The load-bearing component
states this slice introduces/visualizes:

`default` · `hover` · `selected` · `title-editing` · `summary-editing` ·
`empty / unconfigured (brand-new)` · `leaf (no child graph)` ·
`has-children / complex (drillable container)` · `has-ports (labeled pins shown)` ·
`ports-collapsed (zoomed out — pins as dots, labels hidden, widgets hidden)` ·
`ports-expanded (zoomed in or selected — labels + `+`/`−` widgets shown)` ·
`has-notes (description present)` · `commit-rejected (empty title revert)`.

## 3. Data / interface contract

This slice authors **no new persisted model** — it reads/writes fields the foundation
spec already reserves:

- Writes: `title` (required, non-empty), `subtitle?` (optional summary), `description?`
  (edited in Inspector), `icon?` (new optional glyph-key string; unset → kind default).
  All via the existing pure `updateNode(doc, graphId, nodeId, patch)` reducer — no new
  reducer needed for A.
- Reads (presentation only, does not mutate): `kind`, `childGraph` (→ has-children),
  `inputs`/`outputs` (→ pins), and live canvas **zoom** (from React Flow) for the reveal
  rule.
- **`icon` value space:** a key into the app's icon registry (e.g. `"database"`,
  `"queue"`, `"sparkle"`). An unknown/removed key falls back to the kind default at the
  render boundary (same defensive pattern as `migrateKind` — never render blank). No new
  validation in `restoreArchitecture` is required for A; the field is a free string per
  F's schema and A tolerates unknown values.

No error shapes (client-only, in-memory edits persisted by the existing debounced save).

## 4. Edge cases & failure modes

| Condition | Expected behavior / recovery |
|---|---|
| Empty / whitespace-only title commit | Rejected; revert to previous title; stay/exit edit gracefully (no empty node names). |
| Empty summary commit | Allowed; clears `subtitle` (optional). |
| Very long title / summary | Card has a max-width; text truncates with ellipsis; full value in tooltip. Inline editor is single-line and scrolls. Tolerate ~30%+ text expansion (i18n). |
| Double-click ambiguity (edit vs. drill) | Double-click **on the title/summary text** enters inline edit and stops propagation; double-click elsewhere on the card is drill (B). See Decisions Needed #1. |
| Editing, then node dragged/canvas panned | Commit-on-blur fires; editor closes. Editor carries `nodrag nopan` (as the edge-label input already does) so typing/selecting doesn't pan the canvas. |
| Editing, then selection lost / node deleted | Pending edit is dropped (no write to a removed node); no crash. |
| `icon` set to a key later removed from the registry | Falls back to kind default glyph; picker shows the fallback as current. |
| Component has many ports (long pin lists) | Pins stack; card grows vertically to fit; no hard cap (F's concern for count). Labels hidden when zoomed out (reveal rule) to bound clutter. |
| Zoom exactly at threshold | Threshold comparison is inclusive-expanded (≥ threshold → expanded) so there is one deterministic state, no flicker band. |
| Legacy node (no ports) | Single centered handle per side, exactly as today; no pins, no `+` widget until F adds a port. |
| Brand-new empty node, user clicks away without naming | Keeps default title "New component" in empty/unconfigured style; still fully usable and re-nameable later. |
| Reduced-motion users | The layered "complex" affordance and edit transitions are static (no motion needed to read state). |

## 5. Defaults vs. settings

| Decision | Default | Configurable? | Rationale |
|---|---|---|---|
| Rename entry point | Double-click title text **and** F2 on selection | No | Two discoverable paths (pointer + keyboard); matches VS Code F2 and the app's existing edge-label double-click. |
| Empty-title commit | Reject + revert | No | A node must have a name; mirrors edge-label behavior. |
| New component | Auto-enter title edit in empty style | No (reversible per node) | Removes the "New component / open Inspector / retype" chore for the top user ask. |
| Icon source | Curated glyph keys from the app's own icon set | No (v1) | Keeps node visuals consistent with the rest of Conduit (SVG glyphs, theme-aware) instead of mixed emoji rendering. |
| Icon when unset | Kind default glyph | Per node | Zero-config components still read correctly; matches today. |
| Description on card | Tooltip + "has notes" glyph, not inline | No (v1) | Keeps the card compact; long prose belongs in the Inspector. |
| Port widget reveal | Zoom ≥ ~0.85 **or** component selected | No (v1; threshold is a constant, tunable in code) | The Grasshopper ZUI: keep zoomed-out canvas clean, reveal editing affordances when the user leans in or focuses a node; selection always reveals so keyboard users are never gated by zoom. |
| Pin labels | Shown when expanded; dots-only when collapsed | No | Legibility at overview zoom vs. detail zoom. |

No new user-facing settings are introduced; every default above is reversible by a
direct edit and none is a durable preference worth a settings toggle in v1.

## 6. Scope slicing

- **MVP (this slice):**
  - Inline **title** edit (double-click + F2, Enter/blur commit, Esc cancel, empty
    reverts).
  - Card **restyle**: name bar, summary line, icon, clear selection/hover/focus states,
    legible spacing/contrast in all themes.
  - Distinct visuals for **leaf**, **has-children (complex)**, and **brand-new empty**.
  - **Icon picker** in the Inspector writing `icon` (with kind-default fallback + reset).
  - **Port pin presentation** (labeled pins on both edges when `inputs`/`outputs` exist;
    legacy single-handle fallback) and the **reveal rule** for the `+`/`−` widgets
    (widgets are placed/shown by A; their actions are wired by F).
  - Auto-enter title edit on component creation.
- **v1 (should):**
  - Inline **summary** edit on the card.
  - "Has notes" glyph + richer hover tooltip surfacing `description`.
  - Density/zoom polish of pin labels (truncation, wrap) beyond the collapse rule.
- **Vision (could):**
  - Inline description popover on the card.
  - Custom/user-supplied icons or emoji (revisit Decisions Needed #2).
  - Per-kind default port templates.
- **Out of scope:** all of F/B/C/E as listed in the header; agent schema/skill changes
  (F); minimap styling; edge visuals.

## 7. Acceptance criteria

### Declarative

- Double-clicking a component's name shows an in-place, text-selected input; Enter or
  blur saves the trimmed name; Esc restores the pre-edit name; an empty commit reverts.
- A component renders name + optional summary + an icon, legibly, with visible hover,
  focus, and selection states in both light and dark themes.
- Leaf, complex (has child graph), and brand-new-empty components are each visually
  distinguishable without interacting.
- With a component selected, an icon can be chosen from a picker and the chosen glyph
  appears on the card; "reset" returns to the kind default; a component with no `icon`
  still shows its kind glyph.
- A component with declared input/output ports shows labeled pins on the correct edges;
  a component with none shows the legacy single handle per side.
- At overview zoom the `+`/`−` port widgets are hidden and pin labels collapse to dots;
  zooming in past the threshold **or** selecting the component reveals labels and widgets.

### EARS

- **Event:** When the user double-clicks a component's title text, the system shall
  replace the title with a focused, pre-selected single-line editor and stop the event
  from triggering drill-in.
- **Event:** When the user presses Enter or the title editor loses focus with a
  non-empty trimmed value, the system shall persist the new title and exit edit mode.
- **Unwanted:** If the title editor is committed empty or whitespace-only, then the
  system shall discard the change and restore the previous title.
- **Event:** When the user presses Esc while editing a title or summary, the system
  shall cancel the edit and restore the prior value.
- **Event:** When a new component is created, the system shall render it in the
  unconfigured style and enter title edit mode.
- **State:** While a component owns a child graph, the system shall render the complex
  (drillable-container) visual and an active drill affordance.
- **State:** While the canvas zoom is below the reveal threshold and the component is
  not selected, the system shall hide the `+`/`−` port widgets and render pins without
  labels.
- **Event:** When the user selects an icon in the picker, the system shall set the
  component's `icon` and render that glyph; when the user resets it, the system shall
  clear `icon` and render the kind default glyph.
- **Optional:** Where a component has no declared ports, the system shall render the
  legacy single input/output handles unchanged.

### Gherkin (key flows)

```gherkin
Feature: Inline component title editing
  Background:
    Given the architecture canvas is open with a component named "Core / Host"

  Scenario: Rename via double-click and commit
    When I double-click the component's title text
    Then the title becomes a focused text field with the text selected
    When I type "API Gateway" and press Enter
    Then the component's name is "API Gateway"
    And the field is no longer editable

  Scenario: Cancel with Escape
    When I double-click the title text and type "scratch"
    And I press Escape
    Then the component's name is still "Core / Host"

  Scenario: Empty name reverts
    When I double-click the title text and clear it
    And I blur the field
    Then the component's name is still "Core / Host"

Feature: Component state visuals
  Scenario: Distinguish leaf, complex, and empty
    Given a leaf component, a component with a child graph, and a just-created component
    Then each renders a visually distinct style
    And the component with a child graph shows an active drill-in affordance
    And the just-created component shows the unconfigured style and is in title edit

Feature: Port pin reveal (ZUI)
  Scenario: Widgets reveal on zoom-in
    Given a component with two input ports and one output port
    And the canvas is zoomed out below the reveal threshold
    Then the pins render as dots without labels and no add/remove widgets are shown
    When I zoom in past the threshold
    Then each pin shows its label and the add/remove port widgets appear

  Scenario: Selection reveals regardless of zoom
    Given the canvas is zoomed out below the reveal threshold
    When I select the component
    Then its pin labels and add/remove widgets are shown
```

## 8. State catalog (UI)

| Component | State | What the user sees | Action / CTA |
|---|---|---|---|
| Component card | Default | Icon chip, name bar, optional summary line, kind stripe, subtle border/shadow | Click to select; dbl-click title to edit; dbl-click body to drill (B) |
| Component card | Hover | Elevated border/shadow, drill affordance surfaces | — |
| Component card | Focus (keyboard) | Visible focus ring distinct from selection, survives high-contrast | F2 to rename; Enter to drill (B) |
| Component card | Selected | Accent ring (existing `--accent` ring); pins expand (labels + widgets) | Inspector shows detail incl. icon picker |
| Title | Editing | In-place single-line input, text pre-selected, `nodrag nopan` | Enter/blur commit · Esc cancel · empty reverts |
| Summary (`subtitle`) | Empty | Muted placeholder "Add a summary…" (v1 inline) | Dbl-click or Inspector to edit |
| Summary | Editing (v1) | In-place input | Enter/blur commit (empty clears) · Esc cancel |
| Card | Brand-new / empty (unconfigured) | Dashed accent border, muted "New component" name, ghost icon, hint | Auto in title edit; name it |
| Card | Leaf (no child graph) | Standard card; drill affordance in "create nested" (inactive/muted) state | Dbl-click body to create+drill (B) |
| Card | Has-children / complex | Layered "stacked" edge/shadow signalling depth; drill affordance in active accent state | Dbl-click body / drill button to open (B) |
| Card | Has-notes | Small "notes" glyph; `description` in hover tooltip | Open Inspector to edit notes |
| Ports | Collapsed (zoom < threshold, unselected) | Pins as bare dots, no labels, no `+`/`−` | Zoom in or select to expand |
| Ports | Expanded (zoom ≥ threshold or selected) | Labeled pins both edges; `+` add / per-pin `−` widgets visible | Add/remove/wire (F) |
| Ports | Legacy (no declared ports) | Single centered handle each side (today's look) | Wire whole-node (existing) |
| Icon picker (Inspector) | Ideal | Current glyph + grid of choices + "Reset to kind default" | Pick / reset |
| Icon picker | (no loading/error/empty states — static local set) | — | — |

Non-applicable UI-stack states (stated so they aren't silently dropped): **loading /
skeleton, partial, offline, permission-denied, not-found, page-level error** do not
apply — the canvas edits an in-memory document with a local static icon set; there is no
async fetch, no auth, and no remote resource behind these surfaces. **Component-level
error** does not apply as a distinct visible state — the only failure A can hit is an
unknown/removed `icon` key, which is handled by silent fallback to the kind default at
the render boundary (never a broken card; §3 + §4), not an error surface.
**Limit-reached** does not apply — A imposes no limits (port count is explicitly
uncapped and owned by F). **Failed-save** is handled globally by the existing
debounced-save + flush-on-unmount path (`useDebouncedFlush`), not per-component here.

## 9. Interaction inventory (UI)

| Component | Actions/affordances | Pointer | Keyboard | Touch | Context menu | ARIA role/states |
|---|---|---|---|---|---|---|
| Component card | select, drill, rename, context | click select · dbl-click title=edit · dbl-click body=drill (B) · right-click=menu (C) | Tab to focus · F2 rename · Enter drill (B) · Esc deselect (existing) | tap select · double-tap title edit · long-press menu (C) | owned by C | `role=group`/button-like; `aria-selected`; name from title |
| Title editor | edit text | type; blur commits | Enter commit · Esc cancel | on-screen kbd | — | labelled textbox (`aria-label` "Component name"); single-line |
| Summary editor (v1) | edit text | type; blur commits/clears | Enter commit · Esc cancel | — | — | labelled textbox "Component summary" |
| Drill affordance | open/create nested | click | Enter/Space when focused | tap | — | button; `aria-label` open/create nested (B owns behavior/label wording) |
| Port pin | present / focus / wire (F) | hover shows label · drag to wire (F) | focus + Enter to start wire (F) | tap (F) | — | button/handle; `aria-label` "{in\|out} port {name}" (F) |
| `+` add-port widget | add input/output (F) | click (F) | focus + Enter (F) | tap (F) | — | button; `aria-label` "Add input/output" (F) |
| `−` remove-port widget | remove port (F) | click (F) | focus + Enter (F) | tap (F) | — | button; `aria-label` "Remove port {name}" (F) |
| Icon picker | choose / reset icon | click swatch · click reset | arrow-navigate grid · Enter select · Esc close | tap | — | `role=listbox`/radiogroup of options; each option `aria-label` = glyph name; current is `aria-checked`/selected |

**Rules honored:** every drag path (wiring pins, F) has a non-drag keyboard pathway (F);
default/hover/focus/selected/editing states are visually distinct; selection uses the
accent ring **plus** the pin-expand change (not color alone). Node
**drag-to-reposition** is pre-existing React Flow canvas behavior that A restyles but
does not own or alter; its keyboard-move pathway is a canvas concern, not introduced by
this slice. The destructive `−`
(remove port) is F's and carries F's confirm/undo policy. Global canvas controls
(add component, fit view) remain on the surface header/menus (C), not on the card.

## 10. Accessibility & i18n (UI)

**Accessibility (WCAG 2.2):**
- **Keyboard operability:** rename via F2 on a focused/selected component; commit Enter,
  cancel Esc. Icon picker is arrow-navigable with Enter to select, Esc to close. Drill
  and port actions have keyboard paths (B / F). No action is pointer-only.
- **Visible focus:** the card's keyboard focus ring is distinct from the selection ring
  and must survive forced-colors / high-contrast (don't signal via shadow alone). Editors
  keep a visible focus outline.
- **Accessible names:** the inline title/summary editors are labelled textboxes; the
  icon-only drill and `+`/`−` widgets have `aria-label`s (widget labels owned by B/F);
  each icon-picker option has a text name (never glyph-only).
- **Announce dynamic results:** renames and icon changes are reflected in the visible
  accessible name of the card, so a screen reader reads the new name on next focus; no
  separate toast needed. (If needed, a polite live region announces "Renamed to X" —
  advisory, not required for MVP.)
- **Color is never the only signal:** leaf vs. complex is carried by the layered shape +
  the drill affordance state, not color; the "has-notes" state pairs a glyph with the
  tooltip; empty/unconfigured pairs the dashed border with muted placeholder text.
- **Contrast:** name text ≥ 4.5:1 on the card background in every theme; the summary
  (`--text-dim`) and placeholders must still clear 4.5:1 (the user's "not looking great"
  complaint is partly legibility — verify against light theme where `--text-dim` is
  weakest).
- **Reduced motion:** state comprehension never depends on animation; the complex
  "stack" and edit transitions read when static.
- **Focus management:** after committing a rename, focus returns to the component card
  (not lost to the canvas); after creating a component, focus is in its title editor.

**i18n:**
- Externalize every literal through the app's string path: default title
  `"New component"`, placeholder `"Add a summary…"`, tooltips ("Double-click to rename"),
  icon-picker option names, "Reset to kind default", and any "has notes" label. No
  concatenated sentences.
- **Text expansion:** name bar and summary tolerate ~30%+ longer strings (truncate with
  ellipsis + full value in tooltip, never truncate the editable value itself).
- **RTL:** the card mirrors — inputs pins move to the right edge, outputs to the left,
  the icon chip and stripe flip — matching the app's global direction. Wiring direction
  itself is not reversed (data semantics unchanged); only layout mirrors. (Flagged as a
  low-risk assumption; see Decisions Needed #5.)
- **Sorting/collation:** not applicable — components are positioned, not sorted.

## 11. Design tokens (UI)

Reuse the existing palette — **no new palette, ideally no new token.** The restyle works
within current variables:

- **Surface / border / radius:** `--panel-2` (card bg), `--border` / `--border-2`
  (resting/hover borders), `--r` / `--r-sm` (radii), existing card box-shadow.
- **Kind color:** the existing `KIND_VAR` mapping (`--accent`, `--accent-2`, `--blue`,
  `--green`, `--amber`, `--violet`, `--red`, `--text-dim`, `--text-faint`) for the
  stripe, icon chip tint, and pins.
- **Selection / accent:** `--accent` (selection ring, as today), `--raise` (hover fills).
- **Text:** `--text` (name), `--text-dim` (summary), `--text-faint` (muted/placeholder).
- **Empty / unconfigured:** dashed border in `--accent` at reduced opacity via
  `color-mix` (no new token); muted `--text-faint` name.
- **Complex / has-children:** layered shadow/offset using the existing card shadow +
  `--border-2` — a "second card behind" silhouette; the drill affordance stays
  `--accent` (existing `.archnode__drill--has`).
- **Port pins:** reuse the kind color / `--accent`; the mismatch-warn state is F's single
  `--port-warn` token (reuse of `--amber`, defined in F) — A does not add its own.
- **Theme variants:** verify all three states in light, dark, and high-contrast; the
  known weak spot is light-theme `--text-dim` legibility (address the "not looking great"
  report there specifically).

If a token proves unavoidable (e.g. a dedicated empty-state border), introduce **one**
semantic token derived from `--accent`; do not add per-kind or hex values (matches the
repo's "reuse existing kinds/colors/design tokens" rule).

## 12. Assumptions

- Inline editing reuses the existing edge-label editor pattern already in
  `architecture-view.tsx` (`nodrag nopan`, autofocus + select, Enter/blur/Esc) — same
  UX, applied to the title/summary. Documented rather than asked because it's the
  established convention in this exact file.
- The Inspector remains the home for full detail editing (kind, notes, delete) and gains
  the icon picker; this slice adds a faster inline path, it does not remove the panel.
- `subtitle` is the "short summary" surfaced on the card; `description` is the longer
  prose kept in the Inspector + tooltip. (The foundation model has both; the task's
  "description / short summary" maps onto these two existing fields.)
- The reveal threshold is a code constant (~0.85 zoom); selection always overrides it.
  Chosen conservatively so keyboard/low-vision users who select a node are never gated by
  zoom.
- Presentation reads `inputs`/`outputs` but never writes them (F owns mutation), so A can
  ship its visuals against F's model without duplicating reducers.

## 13. Decisions Needed (autonomous mode)

- **[normal] #1 — Double-click semantics (edit vs. drill).** Today `onNodeDoubleClick`
  drills. Default taken: **double-click on the title/summary text enters inline edit
  (stops propagation); double-click elsewhere on the card drills (B)**. Reversible; if B
  prefers a different drill gesture (e.g. drill only via the chevron), the title-edit
  gesture is unaffected. Coordinated with slice B.
- **[normal] #2 — Icon source: curated glyph set vs. emoji/custom.** Default taken:
  **a curated set of the app's existing SVG glyph keys**, stored in `icon` as a key,
  kind-default fallback. Emoji/custom icons deferred to Vision. Reversible (the field is
  a free string; a future picker can widen the value space).
- **[normal] #3 — Where `description` shows on the card.** Default taken: **not inline on
  the card — hover tooltip + a "has notes" glyph**, full editing in the Inspector. Keeps
  the card compact; an inline description popover is Vision. Reversible.
- **[normal] #4 — Port widget reveal threshold + trigger.** Default taken: **reveal when
  zoom ≥ ~0.85 OR the component is selected; pin labels collapse to dots below
  threshold.** Threshold is a tunable constant. Reversible.
- **[normal] #5 — RTL port-side mirroring.** Default taken: **layout mirrors (inputs to
  the right, outputs to the left) while wire/data semantics are unchanged.** Low risk;
  revisit if a directional-workflow concern surfaces. Reversible.
- **[normal] #6 — Auto-enter title edit on component creation.** Default taken: **yes —
  a new component spawns in the empty style already in title edit.** Reversible per node
  (user can click away to keep the default name).

No `high`-severity decisions: every choice above is client-side, reversible, and reuses
existing model fields and tokens.

## 14. Open questions

None blocking — all would-be questions are captured as reversible defaults in §13
(autonomous mode).

## Self-audit

Core spine: problem ✓ · behavior/states ✓ · data/interface contract ✓ (reads F's model,
writes existing fields — no new persistence, stated) · edge cases ✓ · defaults/settings ✓
· scope slicing ✓ · acceptance (declarative + EARS + Gherkin) ✓. UI module: state catalog
✓ (incl. explicit N/A states with reasons) · interaction inventory ✓ · accessibility ✓ ·
i18n ✓ · design tokens ✓ (no new palette). Cross-slice ownership named, not re-specified
(B/C/E/F). Decisions Needed severity-tagged; none `high`. No empty sections. Right-sized:
FULL is warranted — multi-surface (card, inline editors, icon picker, pins), user-facing,
and the visual restyle is novel.
