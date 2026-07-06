# Implementation plan — architecture node-graph epic

Build plan for the epic specced in `docs/specs/2026-07-06-arch-*`. SERIAL on `main` (all slices
touch `architecture-view.tsx` / `architecture.ts` / `styles.css`). Order: **F → A → B → D → E → C**.
Each step: TDD where pure, real-artifact **hidden** e2e for view/host behavior, `npm run verify`
green, commit to `main` (SHA = evidence). Ledger: `.autoloop/tasks.yaml`.

## F — foundation
- **F1 (done, `88e10a8`):** typed model + reducers + undo stack (`src/arch-history.ts`) + validation
  + schema + SKILL v1.1.0. 25 unit tests.
- **F2 — view wiring (this step):**
  1. Route ALL doc mutations in `architecture-view.tsx` through a `History<ArchDoc>` (init from the
     loaded doc; `apply(mutator, tag?)` pushes; persist `history.present` via the existing save).
  2. Render port pins: each node's `inputs` → left `Handle`s (target, `id=portId`), `outputs` →
     right `Handle`s (source, `id=portId`). Legacy portless node keeps its single centered handles.
  3. `onConnect`: when both ends carry a port handle id → `addTypedEdge`; else keep the existing
     whole-node `addEdge`. Build RF edges with `sourceHandle`/`targetHandle` from the port ids.
  4. Minimal `+`/`−` widgets (add input, add output, remove port) calling `addPort`/`removePort`
     (visual polish + ZUI reveal = slice A; here they can be always-visible + unstyled-ish).
  5. Port rename: double-click a pin label → inline input → `renamePort` (A repolishes).
  6. Undo/redo: `Mod+Z` / `Mod+Shift+Z` while the arch view is active and focus isn't in a text
     input; wire via the existing shortcut/precedence path. Coalesce node-drag + rename.
  7. Persist round-trips ports/interfaces (host already writes whatever `serializeArchitecture`
     emits — F1 covers serialize; confirm the view saves `history.present`).
- **F2 verify:** unit (view-model helpers if any) + hidden e2e `arch-node-graph.e2e.mjs`: open canvas,
  add a component, add an output + input port, wire them, `Mod+Z` removes the wire, `Mod+Shift+Z`
  restores, reload persists the ports+edge.

## A — component presentation (spec arch-component-presentation)
Inline title edit (dblclick+F2), summary/description, icon picker (Inspector), Conduit-themed
restyle, leaf/complex/empty visuals, port-pin presentation + ZUI reveal (zoom≥~0.85 or selected).
Reuses F2's pins/rename; adds the visual layer. e2e: rename persists; states visually distinct;
pins reveal on zoom/select.

## B — navigation & hierarchy (spec arch-navigation-hierarchy)
Drill in/out (dblclick body + chevron) arbitrary depth; Escape ladder (overlay→inline editor→clear
selection→step-up→close-at-root, focus-scoped); breadcrumb; back/forward (reuse `src/nav-history.ts`
pattern, separate stack); per-level pan/zoom/selection memory; render read-only `boundary:in/out`
nodes inside a child from the parent's ports. e2e: drill 2 levels, breadcrumb jump, Escape steps up,
boundary nodes show parent ports.

## D — grouping & composition (spec arch-grouping-composition)
Multi-select+move; named groups (`ArchGroup` on `ArchGraph`); encapsulate→complex component (infer
ports from boundary-crossing wires, wire to boundary); explode (NOT via `removeNode`); insert-space
(Alt-drag). All through the undo stack. e2e: encapsulate infers ports; explode round-trips;
insert-space opens room; each undoable.

## E — interface authoring (spec arch-interface-authoring)
Interfaces side panel (create/rename/delete interface — re-add `updateInterface` reducer; add/edit/
reorder fields; nested/recursive TypeRef); shared type picker (E UX, F `setPortType`); usage counts +
confirmed delete. e2e: define `User{name,birthYear}`, assign to a port, delete clears refs.

## C — context menus (spec arch-context-menus)
Right-click menus for all six surfaces in canonical order (context-menu ADR); read-only boundary-pin
variant; Shift+F10 keyboard invocation. Wires up A/B/D/E/F actions. LAST. e2e: each surface menu
opens with correct items, destructive last, keyboard invocation.

## Notes
- Never weaken a gate; dead-code gate means don't export a reducer before a consumer exists
  (add it with its use — F1 lesson: removed `updateInterface`, E re-adds it).
- Kill orphan electrons between e2e: `cmd //c "taskkill /F /IM electron.exe /T"`.
- Report → `docs/runs/2026-07-06-arch-node-graph/report.md` at the end.
