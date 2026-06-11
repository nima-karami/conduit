# Spec: Editable edge labels (architecture canvas)

- **Tier:** LITE
- **Feature type:** UI
- **Slug:** edge-labels
- **Surface:** `webview/components/architecture-view.tsx` + `src/architecture.ts` (model)

## Problem frame

**Job:** When mapping a system on the architecture canvas, a user wants to annotate
*their own* connections with a word or phrase ("HTTP", "publishes to", "reads") so a
diagram reads as more than anonymous arrows. Today seeded edges may carry a `label`,
but there is **no UI to add or edit a label on an edge** — the field is render-only.

- **Actor:** the person editing an architecture diagram in the renderer.
- **Success:** double-clicking any edge lets them type a label inline; it shows on the
  edge, persists across re-render and reload, and can be edited or cleared later.
- **Non-goals:** rich text / multi-line labels; per-label styling/color; label
  placement controls; labels on nodes (already covered by the inspector); markdown.

## Behavior & states

An edge label is one short single-line string stored on `ArchEdge.label`.

States of the edge-label editor:

- **Idle** — edge renders its current `label` (or nothing if empty/undefined).
- **Editing** — user double-clicked the edge (or its label); an inline text input
  appears at the edge midpoint, pre-filled with the current label, text selected.
- **Commit** — Enter or blur: trimmed text is written to the model. Empty string ⇒
  label cleared (`label` removed/undefined). Re-render shows the result.
- **Cancel** — Escape: editor closes, model unchanged.

Only one edge is editable at a time; opening a new editor (or pane click) cancels any
open one implicitly by virtue of a single `editingEdgeId` state.

## Data / interface contract

New pure model updater in `src/architecture.ts`:

```
setEdgeLabel(doc: ArchDoc, graphId: string, edgeId: string, label: string): ArchDoc
```

- Trims `label`. Non-empty ⇒ sets `edge.label = trimmed`. Empty ⇒ deletes the
  `label` property (so it round-trips as `undefined`, matching `validGraph`).
- Unknown `graphId` or `edgeId` ⇒ returns `doc` unchanged (no throw).
- Immutable: returns a new doc; does not mutate input. Matches existing reducers
  (`addEdge`, `removeEdge`, `updateNode`).

Persistence: the canvas already debounce-saves `doc` via `scheduleSave`/
`updateArchitecture`. Routing the edit through `applyDoc(d => setEdgeLabel(...))`
reuses that path, so labels survive re-render and reload with no new plumbing.

## Edge cases & failure modes

- **Empty / whitespace-only label** ⇒ cleared (property removed), not stored as "".
- **Double-click on edge path vs. on existing label text** ⇒ both open the editor.
- **Very long text** ⇒ input has a max-width; label text already wraps via the
  existing `react-flow__edge-text` style; no truncation logic needed for LITE.
- **Edge deleted while editing** is not reachable (delete needs selection/keypress
  that closes the editor first); no special handling.
- **Re-render mid-edit:** `nodes`/`edges` rebuild from `doc` every render. The editor
  lives in a custom edge component keyed by edge id and reads `editingEdgeId` from
  shared state, so it survives rebuilds.

## Defaults vs. settings

- Interaction = **double-click**, mirroring the existing "double-click a card to
  drill in" affordance and the header hint. No setting. (Rationale: consistent,
  discoverable, no new chrome.)
- Commit on **Enter or blur**, cancel on **Escape** — standard inline-edit
  convention; reuse the same Escape semantics as elsewhere. No setting.

## Scope slicing

- **MVP / this change:** double-click edge → inline input → Enter/blur commits, Esc
  cancels, empty clears; `setEdgeLabel` reducer; persisted via existing save path.
- **Out of scope:** label styling, multi-line, drag-to-reposition label, label on
  hover-only, i18n of label content (user-authored, not app copy).

## Acceptance criteria

- AC1: Double-clicking a previously unlabeled edge opens an inline editor at the edge
  midpoint; typing "calls" and pressing Enter shows "calls" on that edge.
- AC2: The label persists across a canvas re-render (e.g. adding a node) and across
  reload (it is written into `doc` and saved).
- AC3: Double-clicking a labeled edge re-opens the editor pre-filled; changing the
  text and blurring updates the label.
- AC4: Clearing all text and committing removes the label (edge shows no text;
  `edge.label` is `undefined`).
- AC5: Pressing Escape while editing leaves the label unchanged.
- AC6: `setEdgeLabel` is pure (no input mutation), clears on empty/whitespace, and
  no-ops on unknown graph/edge id — covered by unit tests in `test/unit/`.

## Accessibility & i18n (UI checklist)

- The inline editor is a native `<input>` — focusable, typeable, with `autoFocus`
  and text pre-selected; Escape/Enter handled via key events. Native input gives
  caret + screen-reader announcement for free.
- The double-click target is a graphical edge; this augments rather than replaces an
  existing flow, and matches the node drill interaction, so no new keyboard-only path
  is introduced beyond what React Flow already provides for edges. (Flagged below.)
- i18n: label *content* is user-authored, not app copy — nothing to translate. No new
  static strings of note (placeholder text only).
- Design tokens: editor input styled with existing CSS variables (`--accent`,
  `--panel`, `--border`, `--text`), no raw hex — consistent with `.arch__field`.

## Decisions Needed

- (normal) No keyboard-only way to *open* the label editor without a pointer
  double-click, mirroring the existing pointer-only drill-in interaction. Accepted as
  consistent with current canvas UX; a keyboard affordance is a future enhancement,
  out of scope for this LITE change.

## Self-audit

Core spine: problem frame ✓, behavior/states ✓, data/interface contract ✓, edge cases
✓, defaults vs settings ✓, scope slicing ✓, acceptance criteria ✓. UI module: state
catalog ✓, interaction ✓, a11y ✓, i18n ✓, design tokens ✓. No unaddressed items.
