# Run report — architecture node-graph epic (2026-07-06)

Autonomous build loop. Goal: evolve Conduit's bare architecture diagram into a Grasshopper-style
typed node graph whose north star is **an agent reading components with named, typed input/output
ports and writing the implementing code**. Decomposed into 6 slices (F foundation + A–E) built
serially on `main` (all touch the same core files: `src/architecture.ts`,
`webview/components/architecture-view.tsx`, `webview/styles.css`).

Conductor: Opus (this session). Execution: serial, inline (smoke-heavy + shared-file). No release
(per standing instruction — release only on explicit ask).

## Shipped (verified + committed + pushed to main)

| Slice | What | Commits | Evidence |
|---|---|---|---|
| **F** foundation | Typed ports/interfaces model (`Port`, `TypeRef`, `InterfaceDef`, `doc.interfaces`), pure reducers, migration, boundary:in/out convention, document-level undo/redo (`src/arch-history.ts`), JSON schema + `conduit-architecture` SKILL v1.1.0, port-pin UX + typed wiring | `88e10a8`, `b541d56` | 25 unit + e2e |
| **A** presentation | Inline title edit (dblclick/F2), ZUI port reveal (zoom≥0.85 or selected), empty/complex visuals, Inspector icon picker | `213f0b1`, `5de9d3c` | e2e |
| **B** navigation | Escape-steps-up (pure `parentOf`), breadcrumb, read-only boundary interface nodes inside child graphs | `5ea0aed` | e2e |
| **D** composition (core) | `encapsulateSelection` — selection → nested component with port inference from boundary-crossing wires; RF-owned multi-select; Encapsulate toolbar button | `27ccc00` | 4 unit + e2e |
| **E** interface authoring | Document-scoped Interfaces panel (master-detail; create/rename/delete + confirm + live-region announce; field CRUD + optional + reorder), shared `TypePicker` (Untyped*/primitives/nestable List of…/searchable interface list + inline New interface…), port typing via Inspector Ports section, navigable ref chips | `4a0132f` | 6 unit + e2e |
| **C** context menus (core) | Mouse menus for 4 live surfaces (port pin + boundary read-only variant, wire, body, pane) in canonical order (Primary→Create→Edit→Reference→Destructive), sentence-case, danger-last+separated | `8e81a4c` | e2e |

**Verification:** `npm run verify` green at each step (now **2159 tests**, dead-code gate clean).
A single HIDDEN real-app e2e (`test/e2e/arch-node-graph.e2e.mjs`) drives the actual canvas across
all slices — add typed port → undo/redo → rename → drag-wire → drill (boundary surfaces parent
ports) → Escape steps up → define interface + field → assign interface type to a port → open
port/body context menus (asserts lead item + danger-last) → encapsulate. Observed via
`window.__archDoc` snapshot. Runs hidden per standing instruction.

## Deferred followups (documented in `.autoloop/tasks.yaml`, not lost)

**D-followups** (own commits, next up):
- `explodeComponent` — inverse of encapsulate; must NOT use `removeNode` (it cascade-deletes
  descendant child graphs). Unblocks C's "Explode component" body-menu item.
- Named `ArchGroup` boxes (multi-select → make named group). Unblocks C's Group-surface menu.
- Insert-space (Alt/modifier-drag opens horizontal/vertical room between nodes).
- Multi-select-drag in e2e (shift-click flaky in RF+Playwright — multi-node inference is
  unit-tested in `test/unit/arch-encapsulate.test.ts` instead).

**C-followups:**
- Group-surface context menu (depends on D's `ArchGroup` object).
- Shift+F10 keyboard invocation + focus-return (additive a11y capability; spec Decision #9 marks
  it reversible/additive). `ContextMenu` already has in-menu arrow/Home/End/Enter/Esc nav; the gap
  is invocation from a focused surface.
- Paste / clipboard-parity items (depend on D's clipboard model).
- "Set type…" opening the picker inline instead of routing to the Inspector (polish).

**E-followups (v1 polish):** drag-reorder (buttons + keyboard shipped, WCAG-ok), field description
edit, `List<List<>>` chip truncation tooltip, duplicate-name soft warnings.

## Decisions taken during autonomy (no human asked)

- **E stayed a separate slice from F** (F = model + minimal port UX; E = full authoring surface +
  the shared type picker F consumes). Per spec E Decision #1.
- **Field ref clears to `any`** (a field's type is required), **port ref clears to untyped** — the
  cross-slice contract gap E's spec flagged; implemented in F's `removeInterface` + validated on
  restore.
- **Interface fields have no stable id** (F's model): field-row React keys are positional with a
  documented `biome-ignore` (same convention as `breadcrumb-bar`/`command-palette`).
- **C shipped mouse-first**; keyboard Shift+F10 + the Group-surface menu deferred (the latter is
  blocked on D's group object). The user's literal ask — a right-click menu per surface — is met.
- **Title menu == body menu** (right-click anywhere on a card → same builder), per spec C §2.2.3.

## Notes / gotchas for the next iteration

- e2e canvas-open is retried 4× (palette flake on a saturated machine — env, not a product bug);
  kill orphaned electrons (`taskkill /F /IM electron.exe /T`) before running.
- All work is on `main` and pushed. `.autoloop/tasks.yaml` is the resumable source of truth.
