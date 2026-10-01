# Interactive plans v2 — implementation plan

**Spec:** `docs/specs/2026-09-30-interactive-plan-v2.md`  **Tier:** FULL

## Goal

Turn the v1 plan editor into a whiteboard: one diagram edit changes one fence line, positions persist
in a `.layout.json` sidecar, the canvas reshapes/annotates per element, any diagram opens full-window,
and any terminal agent can be asked for a plan and answer comments without an install.

## Architecture

Six items in spec §6 order, each on its own branch (`feat/plan-v2-<n>-<name>`). Each item is reviewed,
runtime-QA'd and merged to `main` before the next starts.

- **The fence text is the only source of structure.** The canvas emits **edit intents**
  (`FlowEdit[]`). A span-preserving parser and text patcher apply them to the fence, and the result is
  one ProseMirror transaction wrapped in `closeHistory`. v1's undo and write-through are unchanged.
- **Layout lives in a host-owned sidecar** on the existing plan protocol, mirrored in `plan-store`.
- **Per-diagram state lives in `plan-view`, keyed by `(plan, diagramKey)`, never in a node view.**
  `@prosemirror-adapter` reuses code_block views by position
  (`@prosemirror-adapter/core/dist/index.js:103`). An external reload replaces the whole document
  (`replaceAll`, `webview/components/plan-editor.tsx:209`). So state held in a node view dies, or moves
  to a different diagram.
- **`plan-view` owns three things:** the open workspace key, one `FlowHistory` per key, and
  `writeDiagram(key, …)`.
- **`writeDiagram` finds the fence by `diagramKey` in the CURRENT PM doc** when it dispatches. It
  never keeps a `getPos` from an earlier render. The inline block and the workspace both write through
  it.
- **Every rule is a pure, node-testable `src/` module:** patching, pins/nudge/frames, fit, nav,
  history, anchors, brief and handoff.

## Data flow

```
FlowEditor (inline | workspace)          plan-view: DiagramHub {openKey, history[key], writeDiagram(key,…)}
 drag/drop ─▶ onLayout ─────────────────▶ setPlanLayout(root,slug,key,entry) ─▶ plan-store (300 ms/key, seq)
 menu/toolbar/reconnect ─▶ onEdits ─────▶ writeDiagram: locate fence by key in CURRENT doc
                                           ─▶ applyFlowEdits(fence, edits) ─▶ dispatch(closeHistory(tr))
 Ctrl+Z ─▶ history[key] step ─▶ PM undo + setPlanLayout(before) + inverse reattach patches
host  plan:setLayout ─▶ per-(root,slug) promise chain { read ▸ validate ▸ merge ▸ writeAtomic }
      ─▶ recordWrite(…,'layout',fp) ─▶ plan:layout{origin:'ack', seq}
      plan:load ─▶ plan:doc{…, layout}           PlanWatcher .layout.json ─▶ plan:layout{origin:'external'}
      plan:ask ─▶ uniqueSlug + mkdir ─▶ plan:asked      plan:list (on demand) ─▶ plan:listed{plans}
renderer  plan:asked ─▶ pasteToTerminal(sessionId, planAskBrief) | clipboard
          Send ─▶ flushPlanWrites() awaits the ack carrying its own writeSeq ─▶ buildPlanHandoff ─▶ paste
```

## Settled decisions — do not re-litigate

- **Spec §13 locked defaults:** sidecar positions, pasted brief, auto-merge deferred, export as the
  Mermaid render, no HTML artifacts, Copy fallback.
- **Structure:** the fence text is the only source of structure. `FlowGraph` is derived from it on
  every render.
- **Untargeted nodes are untouched:** an edit never changes the label, shape or parent of a node it
  does not target (review B2).
- **Pins:** absolute canvas top-left coordinates, with the computed layout's origin at (0,0). Frames
  are derived, never stored.
- **`diagramKey`** is `"flow-" + ordinal`. The ordinal counts mermaid fences whose first non-blank,
  non-`%%` line starts with `flowchart` or `graph`, whether or not the fence parses.
- **When an entry applies:** only if ≥ 50 % of its ids exist **and** its stored direction equals the
  fence's direction.
- **Per-diagram UI state** (workspace open, history) is owned by `plan-view`, keyed by `diagramKey`
  (review B1).
- **Layout writes** are serialised per `(root, slug)` on the host (review B3).
- **Zoom:** the workspace has one zoom system, xyflow's viewport API. It does not use
  `use-pan-zoom-stage`.
- **`.layout.json`:** the agent never writes it. The host validates every layout write the renderer
  sends.
- **Order:** item order and branch-per-item are fixed (spec §6).

## Spec deviations (conductor folds these into the spec)

- **Direction change** (spec §3.1 "clears that diagram's pins, one undoable step"): an entry whose
  stored direction differs from the fence's is **ignored**. No write, no undo step. The next drag
  overwrites the entry.
- **`c` in prose** (§4): prose is contenteditable, so `c` must type a `c` (`plan-view.tsx:652-663`).
  The plan uses **Mod+Alt+M** instead (`planComment`, rebindable). The panel hint at
  `plan-comments-panel.tsx:429` changes to match.
- **Protocol shape** (§3.1): messages use `{root, slug}` and `op: 'layout'`, not `{path}`/`kind`. This
  follows the existing convention in `src/protocol.ts:474-492, 919-921`.
- **Duplicate edges** (§3.2 says "keeps"): v1 refuses any edge with the same endpoints and shows no
  notice (`src/mermaid-flow.ts:388`). The kind+label rule and the notice are new behaviour.
- **Unknown bracket forms** (§3.2): v1 fails the whole fence on them. Item 1 adds them as verbatim.
- **Membership, re-locked in the item 1 review** (§3.2 "a node belongs where it is first
  mentioned"): replaced by mermaid's own flowDb rule. A subgraph lists every id its own body
  mentions, edge endpoints included, and the earliest-closed subgraph that lists an id owns it.
  Top-level mentions confer nothing. `FlowNode.first` stays a span but no longer decides
  membership. A move relocates to the top level only the statements in subgraphs that close
  before the target. Pinned against mermaid's parser in `test/unit/mermaid-flow-membership.test.ts`.
- **Labels** (§3.2 "defining mention"): a node's label and shape are its last labelled mention,
  because mermaid's `addVertex` overwrites. `def` is still the first labelled mention. A rename
  rewrites every labelled mention, and a relocated statement is re-emitted bare.
- **Root guard** (review R2): `applyFlowEdits` re-parses its own output and refuses with
  `unsupported` unless every node, subgraph and edge equals the intended state.
- **`writeDiagram(view, key, edits, basis)`** (review S1): the 4th parameter is the fence text the
  edits were computed against. A fence that has moved on returns `gone`.
  `writeFenceTextAt(view, pos, text)` is the text path for keyless mermaid fences.
- **Toast** (§2.1): pushed in `webview/app.tsx:2471-2498`, not in `plan-store.ts`.
- **Export** (§2.4): the `mermaid-export` helpers take an SVG string, but the canvas is HTML. Item 3
  extracts `renderMermaidSvg` from `mermaid-diagram.tsx:75-81`.
- **§2.1 ASSUMED rows, re-measured, all confirmed:** Send doesn't flush (`plan-view.tsx:376-418`);
  `replyTo` is never rendered and never produced; Skills install to `.claude/skills` only.
- **§12 xyflow capabilities, verified in 12.11.2:** `onReconnect`/`edgesReconnectable`
  (`dist/esm/types/component-props.d.ts:85,379`); `MiniMap`, `NodeToolbar`, `useNodesInitialized`
  and `onViewportChange`; Viewport helpers (`types/general.d.ts:84-146`); `dragHandle`,
  `nodesFocusable` and `disableKeyboardA11y` (`component-props.d.ts:355,570`); Ctrl+wheel-only zoom
  works with `zoomOnScroll={false}` and `preventScrolling={false}`
  (`@xyflow/system/dist/esm/index.js:2768,2840`).

## Global constraints

- **Gate:** `npm run verify`. For the inner loop, use `verify:quick`. Read exit codes directly, never
  piped.
- **e2e runs remotely:** `npm run e2e:remote -- <names…>`. Locally, run at most ONE scenario, by exact
  name.
  - Scenarios use `runScenario`/`launchApp`/`finishScenario` (`test/e2e/harness.mjs`).
  - Every drag, click and wheel uses real `page.mouse`.
  - Paste spy: copy `plan-handoff.e2e.mjs:50-55,200-216`.
  - Relaunch: `launchApp({ userDataDir })`.
  - Export: use the blob intercept from `mermaid-export.e2e.mjs`.
- **Versions:** Node 24, React 19.2, `@xyflow/react` 12.11.2, `mermaid` 11.15. **No new
  dependencies.**
- **Tests:** `test/unit/<module>.test.ts`. DOM tests put the jsdom pragma on line 1. Watch every named
  test fail before implementing.
- **Comments:** explain *why* only, and link the spec instead of restating it.
- **Styles:** `webview/styles.css` only. BEM per component (`planflow__`, `planws__`,
  `plancomment__`), tokens only; Hover, press and selected states go in the `:where()` role lists at
  the foot of the sheet; Floating chrome over xyflow uses `--layer-*`-derived z-index; A surface
  over `.topbar` declares `-webkit-app-region: no-drag` and is added to
  `test/unit/drag-region.test.ts`.
- **Painting:** fit before paint (`useLayoutEffect`). No React `onWheel`.
- **Strings:** centralised per component module. Counts go through `src/plural.ts`.
- **Exports:** export only what another module or a test imports. `fallow` fails on unused exports.
- **Commits:** `feat(plan): …` / `test(plan): …`, plus one CHANGELOG `[Unreleased]` entry per item.

## Out of scope

- Spec §1 non-goals.
- Spec §6 v1 and Vision items: auto-merge, image resolution, sequence editing, arranged-canvas export,
  AGENTS.md/GEMINI.md, the architecture canvas, the board.

## Producer/consumer map

| Behavior changed | Produced by | Consumed by | Sides touched |
|---|---|---|---|
| Fence text from diagram edits | `applyFlowEdits` via `writeDiagram` | parser, agent, splice/write-through | both (1) |
| `FlowGraph` shape (spans, verbatim, no `trailer`, source-ordered edges) | `parseFlowchart` | `flow-editor.tsx`, `flow-layout.ts`, `plan-flow-block.tsx`, tests (the only importers, by grep) | all (1) |
| Fence wrapper / EOL on write | `getMarkdown` → `spliceBody` | disk, agent | both (1, Task 1.3.3) |
| `.layout.json` | `setPlanLayout` → `plan:setLayout` chain | store → editor; watcher | both (2) |
| `plan:doc.layout`, `plan:layout`, `op 'layout'` | `electron/main.ts` | `plan-store.ts` `onDoc`/`onLayout`/`onError` | both (2) |
| `OnPlanChange` payload | `plan-watcher.ts` | `main.ts:2105-2111`, `plan-watcher.test.ts` | both (2) |
| Per-diagram workspace/history | `plan-view` DiagramHub | `PlanFlowBlock`, `DiagramWorkspace` | both (2, 3) |
| `anchor.part` / `excerpt` | toolbar/drawer Comment; agent replies only | reanchor, panel, drawer, pins, handoff | both (4) |
| Reply normalisation / thread resolve | `restorePlanComments` / `applyPlanCommentPatch` (host + renderer) | panel, handoff | both (5) |
| Write flush before Send | `plan-view` timers + `writePlan` (ack matched by `writeSeq`) | `onSend` | both (5) |
| Ask brief / slug | host `plan:ask` + `planAskBrief` | terminal agent | both (5) |
| Plan list | host `plan:list` on demand | Open plan… palette | both (5) |
| "Plan ready" toast | `app.tsx`, title via `planTitle(markdown)` from `plan:doc external` | toast store, unchanged | producer only |
| Export SVG/PNG | `renderMermaidSvg` (extracted) | `mermaid-export` helpers, unchanged | producer; `MermaidDiagram` switched in the same task |

## File map

| Path | Action | Responsibility | Item |
|---|---|---|---|
| `src/mermaid-flow.ts` | modify (rewrite) | span-preserving parse → `FlowDoc`; types; label decode | 1 |
| `src/mermaid-flow-edit.ts` | create | `FlowEdit` intents → minimal text patch; label encode; `nextNodeId` | 1 |
| `src/flow-layout.ts` | modify | consume new `FlowGraph`; gap constants (item 2) | 1, 2 |
| `webview/components/flow-editor.tsx` | modify | emits `FlowEdit[]`; canvas features | 1–4, 6 |
| `webview/components/plan-flow-block.tsx` | modify | inline block: header, scrim, wires hub by key; no state that must survive reload | 1–4, 6 |
| `src/flow-diagram-key.ts` | create | `flowDiagramKeys` | 1 |
| `webview/plan-diagram-write.ts` | create | locate fence by key in the current doc; `closeHistory` dispatch | 1 |
| `src/plan-splice.ts` | modify | `replaces` + fence rewrap + EOL (only if 1.3.3's red tests fail) | 1 |
| `webview/plan-diagram-hub.tsx` | create | per-(plan,key) history, workspace open key, Expand refs | 2–4 |
| `webview/components/plan-editor.tsx` | modify | `onView` | 2 |
| `electron/plan-layout-writer.ts` | create | per-(root,slug) serialised layout writes | 2 |
| `src/plan-layout.ts` | create | sidecar envelope, validation, merge, ≥50 %/direction rule, prune | 2 |
| `src/flow-placement.ts` | create | pins + nudge, derived frames, frame hit-test | 2 |
| `src/flow-fit.ts` | create | inline height/zoom/partial | 2 |
| `src/flow-nav.ts` | create | nearest node in a direction | 2 |
| `src/flow-history.ts` | create | canvas undo/redo log (+ comment patches, item 4) | 2, 4 |
| `webview/use-flow-canvas-layout.ts` | create | measure → layout → place → fit → ready | 2 |
| `webview/components/flow-selection-toolbar.tsx` | create | floating per-selection actions | 2 |
| `webview/plan-menu.ts` | modify | Style ▸, Shape ▸, subgraph menu, Change target…, Move to top level, Comment | 2, 4 |
| `electron/conduit-fs.ts` | modify | `readPlanLayout`/`writePlanLayoutFile`; `listPlans`; `prepareAskSlug` | 2, 5 |
| `electron/plan-watcher.ts` | modify | third kind `layout`; discriminated change payload | 2 |
| `electron/main.ts` | modify | `plan:setLayout` via writer, load carries layout; `plan:ask`, `plan:list`, write `seq` | 2, 5 |
| `src/protocol.ts` | modify | message unions | 2, 5 |
| `webview/plan-store.ts` | modify | layout overlay + seq; `writePlan` promise by seq; `listPlansFor` | 2, 5 |
| `webview/mermaid-render.ts` | create | `renderMermaidSvg` extracted from `mermaid-diagram.tsx` | 3 |
| `webview/components/mermaid-diagram.tsx` | modify | call `renderMermaidSvg` | 3 |
| `webview/components/diagram-workspace.tsx` | create | full-window surface rendered by plan-view; chrome, Escape chain, drawer slot | 3 |
| `webview/components/diagram-comments-drawer.tsx` | create | per-diagram comments drawer | 3, 4 |
| `webview/view-state-store.ts` | modify | `{kind:'diagramMinimap'}` + `DIAGRAM_MINIMAP_VIEW_STATE_ID` | 3 |
| `src/plan-comments.ts` | modify | `part`/`excerpt`, normalisation, thread resolve, excerpt rung | 4, 5 |
| `src/plan-element-anchor.ts` | create | resolve `part` against a `FlowGraph`; edge ladder; labels | 4 |
| `src/plan-handoff.ts` | modify | element lines (4); preamble + thread lines (5) | 4, 5 |
| `webview/components/plan-comments-panel.tsx` | modify | element-gone label (4); threads, Reply, counter (5, 6) | 4–6 |
| `webview/components/plan-view.tsx` | modify | splice `replaces` (1); hub provider (2); workspace host (3); flush/Send/shortcuts (5) | 1–3, 5 |
| `src/plan-brief.ts` | create | `slugifyTopic`, `uniqueSlug`, `planAskBrief`, `planTitle` | 5 |
| `webview/components/plan-ask-modal.tsx` | create | topic input modal | 5 |
| `webview/app.tsx` | modify | palette Plans commands, Ask modal, toast dedupe | 5 |
| `webview/shortcuts.ts` | modify | `planSend`, `planComment` actions | 5 |
| `resources/skills/conduit-interactive-plan/SKILL.md` | modify | brief's rules, v1.1.0 | 5 |
| `webview/plan-diagnostics.ts` | modify | suppress 2389/2390/2391 | 6 |
| `webview/components/plan-code-block.tsx` | modify | language/checking chip | 6 |
| `webview/components/plan-action-bar.tsx` | modify | `aria-disabled` + visible reason | 6 |
| `webview/styles.css` | modify | per-item rules | 1–6 |
| `test/e2e/fixtures/plan/fidelity.md`, `fidelity-crlf.md`, `canvas.md`, `five-lr.md` | create | e2e fixtures | 1, 2 |
| `test/e2e/plan-diagram-canvas.e2e.mjs` | create | item 2 ACs | 2 |
| `test/e2e/plan-diagram-workspace.e2e.mjs` | create | item 3 (+4) ACs | 3, 4 |
| `test/e2e/plan-element-comments.e2e.mjs` | create | item 4 ACs | 4 |
| `test/e2e/plan-agent-loop.e2e.mjs` | create | item 5 ACs + Gherkin 1 | 5 |
| `test/e2e/plan-blocks.e2e.mjs`, `plan-handoff.e2e.mjs` | modify | fidelity (1), polish (6), handoff format (4, 5) | 1, 4–6 |

## Scripts

None. No routine repeats across enough files; fixture corpora live inside the unit tests.

---

## Item 1 — Fence fidelity (`feat/plan-v2-1-fence-fidelity`)

### Contracts

```ts
// src/mermaid-flow.ts
export type FlowDirection = 'TB' | 'TD' | 'BT' | 'LR' | 'RL';
export type FlowShape = 'rect'|'round'|'stadium'|'subroutine'|'diamond'|'circle'|'cylinder'|'hexagon';
export type FlowEdgeKind = 'arrow' | 'open' | 'dotted' | 'thick' | 'bidir';
export interface FlowSpan { line: number; start: number; end: number } // 0-based fence line; char offsets
export interface FlowNode {
  id: string; label: string; parent: string | null;
  shape: FlowShape | 'verbatim';          // 'verbatim' = >x] [/x/] [\x\] [/x\] [\x/]; never re-emitted
  def: FlowSpan;                          // defining mention: first with label/shape, else first mention
  first: FlowSpan;                        // first mention (decides membership, spec §3.2)
}
export interface FlowEdge {
  source: string; target: string; kind: FlowEdgeKind; label: string | null;
  stmt: number; link: number;             // statement index; link index inside a chain
}
export interface FlowSubgraph { id: string; title: string; parent: string | null; open: number; close: number }
export type FlowStatementKind = 'header'|'blank'|'comment'|'chain'|'subgraph'|'end'|'trailer';
export interface FlowStatement {
  kind: FlowStatementKind; line: number; indent: string; scope: string | null;
  refs: FlowSpan[]; links: FlowSpan[];    // chain only: refs.length === links.length + 1
}
export interface FlowGraph { keyword: 'flowchart'|'graph'; direction: FlowDirection;
  nodes: FlowNode[]; edges: FlowEdge[]; subgraphs: FlowSubgraph[] }   // edges in source order
export interface FlowDoc { lines: string[]; eol: '\n' | '\r\n'; statements: FlowStatement[]; graph: FlowGraph }
export type FlowParse = { ok: true; doc: FlowDoc } | { ok: false; reason: string; line: number };
export function parseFlowchart(source: string): FlowParse;   // decodes #quot; / #35; (module-private)

// src/mermaid-flow-edit.ts
export type FlowEdit =
  | { op: 'addNode'; id: string; label: string; shape: FlowShape; parent: string | null }
  | { op: 'removeNode'; id: string }
  | { op: 'renameNode'; id: string; label: string }
  | { op: 'setShape'; id: string; shape: FlowShape }
  | { op: 'addEdge'; source: string; target: string; kind: FlowEdgeKind; label: string | null }
  | { op: 'removeEdge'; edge: number }
  | { op: 'relabelEdge'; edge: number; label: string | null }
  | { op: 'setEdgeKind'; edge: number; kind: FlowEdgeKind }
  | { op: 'reconnectEdge'; edge: number; source: string; target: string }
  | { op: 'addSubgraph'; id: string; title: string; parent: string | null }
  | { op: 'renameSubgraph'; id: string; title: string }
  | { op: 'removeSubgraph'; id: string }                       // lifts members to its parent
  | { op: 'moveToSubgraph'; id: string; subgraph: string | null };
export type FlowEditRefusal =
  'unsupported' | 'duplicate-edge' | 'unknown-id' | 'invalid-id' | 'id-taken' | 'cycle' | 'conflict';
export type FlowEditResult =
  | { ok: true; source: string; doc: FlowDoc }
  | { ok: false; refusal: FlowEditRefusal; at: number };      // at = index into edits
export function applyFlowEdits(source: string, edits: readonly FlowEdit[]): FlowEditResult;
export function encodeLabel(label: string): string;   // quote if /["[\]{}()|#<>]/; " → #quot;, # → #35;
export function nextNodeId(g: FlowGraph, base: string): string;   // moved from mermaid-flow.ts

// src/flow-diagram-key.ts
export function flowDiagramKeys(fences: readonly { language: string; text: string }[]): (string | null)[];

// webview/plan-diagram-write.ts — the ONLY fence writer for diagrams (review B1)
export function locateDiagram(doc: ProseNode, key: string): { pos: number; node: ProseNode } | null;
export function writeDiagram(view: EditorView, key: string, edits: readonly FlowEdit[]): FlowEditRefusal | 'gone' | null;
export function writeDiagramText(view: EditorView, key: string, text: string): 'gone' | null;
  // both locate in view.state.doc AT CALL TIME and dispatch closeHistory(tr) (`@milkdown/kit/prose/history`)
```

**Invariants (each unit-tested):**
- **Batch addressing (should-fix 5).** Every intent's edge index and node/subgraph id addresses the
  batch's **input** doc. All intents are resolved to statement spans before any is applied. The
  exception is an id created by an earlier `addNode`/`addSubgraph` in the same batch, which later
  intents may reference.
- **Shared statements.** A statement touched by several intents is re-emitted once with all of them
  applied. Contradictory intents on one element (relabel plus remove of the same edge) give
  `conflict`. A batch is all-or-nothing.
- **Untargeted nodes (B2).** An edit never changes the label, shape or parent of a node it does not
  target. Before a statement is removed or relocated, a standalone `id[Label]` (or bare `id`) line is
  emitted in its place, at the same scope and indentation, for every other node whose `first` or
  `def` it held.
- **Byte fidelity.** Untouched lines stay byte-identical. The output keeps `doc.eol`, and no trailing
  newline is added or removed.
- **Duplicates.** `duplicate-edge` means same source, target, kind **and** label. A no-op edit
  returns `ok` with the source unchanged.
- **Trailer (should-fix 8):** When edge source order changes (edge removed, or a chain split moves
  link order), `linkStyle` indices are renumbered; When a node is removed, `style <id>` and `click
  <id>` lines are dropped. On `class a,b x` lines, only that id is removed, and the line goes when
  no id is left; `classDef` lines are untouched.
- **Removed from `mermaid-flow.ts`:** `serializeFlowchart`, the graph ops (`addNode`…`moveToSubgraph`),
  `FlowGraph.trailer` and the `canonical()` ordering.

`FlowEditorProps` after item 1:
```ts
export interface FlowEditorProps {
  graph: FlowGraph;
  onEdits(edits: readonly FlowEdit[]): FlowEditRefusal | 'gone' | null;   // null = applied
  readOnly: boolean; onEditAsText?: () => void; onLeave?: () => void;
}
```

### Slice 1.1: Span-preserving parser

**Check:** `npx vitest run test/unit/mermaid-flow.test.ts test/unit/flow-diagram-key.test.ts`
**Parallel groups:** G1: 1.1.1 · G2: 1.1.2

- **1.1.1** `src/mermaid-flow.ts`, test rewritten. Red tests: 'records statement line, indent, eol';
  'chain refs/links spans' (`a --> b -- x --> c`: 3 refs, 2 links, edge[1].label `'x'`); '%% and
  blank lines are statements'; 'def is the first mention with a label' (`a --> b` then `b[Bee]` →
  `def.line===2`, `first.line===1`); 'cylinder/hexagon parse'; 'verbatim bracket forms parse'
  (`n>Flag]`); 'decodes #quot; and #35;'; 'trailer lines are statements'; 'CRLF source parses with
  eol \r\n'; v1's failure reasons and line numbers are kept.
- **1.1.2** `src/flow-diagram-key.ts`. Red tests: 'counts unparsable flowcharts'; 'skips sequence
  diagrams and `%%`-led non-flowcharts'; 'non-mermaid fences → null'.

### Slice 1.2: Minimal-diff editing

**Check:** `npx vitest run test/unit/mermaid-flow-edit.test.ts test/unit/flow-layout.test.ts`

**Test oracle (should-fix 4).** Cases are a table `{ name, source, edits, expected: GraphShape,
changedLines: number[] }`.
- `GraphShape` is a test-local projection of `FlowGraph` (ids, labels, shapes, parents, edges as
  `[src, kind, label, tgt]`) with no spans.
- `expected` is written out by hand per case. Nothing derives it from code.
- The property assertion: `parse(result).doc.graph` projects to `expected`, and every line index
  outside `changedLines` is identical to the input.
- The corpus is the `fidelity.md` fence inlined: `%%` lines, 4-space indent, a 3-link chain,
  `-- batch -->`, `db[(Store)]`, a subgraph, `classDef`, `class`, `linkStyle 1`.

- **1.2.1** Node/edge edits in `src/mermaid-flow-edit.ts`. Red tests:
  - 'relabel one edge changes exactly one line'.
  - 'relabel a chain link splits only that chain' (`a --> b --> c`, b→c → `a --> b` / `b -->|x| c`).
  - 'rename rewrites only the def mention, inside a chain'.
  - 'setShape cylinder → `db[(Store)]`'.
  - 'setShape on verbatim replaces the brackets'.
  - 'addEdge appends at top-level end before trailer, sibling indent'.
  - 'duplicate refused only on same kind+label'.
  - 'reconnect keeps label and kind'.
  - '<--> keeps written direction'.
  - 'encodeLabel round-trips literal `#quot;`'.
  - 'batch indices address the input doc' (remove edges 1 and 2 in one batch).
  - 'contradictory intents → conflict'.
  - **B2:** 'removeEdge whose statement held `b[Bee]` leaves `b[Bee]` standalone'; 'reconnect away
    from a node defined in that edge keeps its label'; 'chain split keeps the label on its defining
    fragment'; 'removeNode keeps neighbours' labels and parents'.
  - **Trailer:** 'linkStyle renumbered after removing an earlier edge'; 'removeNode drops `style n`,
    trims `class a,n x` to `class a x`'.
- **1.2.2** Subgraph edits. Red tests: 'moveToSubgraph removes standalone decl and appends
  `id[Label]` at target end'; 'move whose first mention is an edge in the old scope moves that edge
  to top level'; **B2:** 'membership move of an edge statement re-declares the other endpoint in the
  old scope when the edge was its first mention'; 'renameSubgraph rewrites only its header';
  'removeSubgraph lifts members, keeps edges, drops header/end'; 'subgraph into its descendant →
  cycle'.
- **1.2.3** `src/flow-layout.ts` reads `parseFlowchart(...).doc.graph`. This is a port: the existing 7
  cases stay green.

### Slice 1.3: Write path

**Check:** `npm run verify`; `npm run e2e:remote -- plan-blocks plan-editor plan-handoff`.

**Claims (serial lane):** `webview/styles.css`

- **1.3.1** Create `webview/plan-diagram-write.ts` + `test/unit/plan-diagram-write.test.ts`. The test
  uses a real Milkdown schema in jsdom, as `plan-editor-parity.test.ts` does. Red tests:
  - 'writes the fence found by key after an earlier block was inserted' (the doc mutated after the
    lookup, nothing captured).
  - 'returns gone when the key no longer exists'.
  - 'one call = one history event' (`undoDepth` +1 per call).
- **1.3.2** Rewire the editor to intents: `flow-editor.tsx`: `apply` (:378-397) batches `FlowEdit[]`
  in `pendingRef`; The `apply(g => op(g…))` call sites become intents: :429, :440, :566, :596, :608,
  :639, :644, :665-677, :724, :745; `plan-flow-block.tsx`: compute the block's `diagramKey` from
  `view.state.doc` at render. The `onEdits` closure calls `writeDiagram(view, key, edits)`, and the
  textarea calls `writeDiagramText`. Delete `writeText`/`writeGraph` (:59-79): they read a captured
  `node`/`getPos` across the microtask and the 150 ms debounce; `styles.css`: `.planflow__notice`
  (`role=status`, cleared on the next edit); Red jsdom test `test/unit/flow-editor-intents.test.ts`:
  'a refused duplicate shows "That connection already exists" and calls onEdits once'.
- **1.3.3** Fidelity over the whole write path (should-fix 7). `src/plan-splice.ts` +
  `test/unit/plan-splice.test.ts` / `plan-editor-parity.test.ts`. Red tests:
  - 'editing a ~~~ fence with info string `mermaid title="x"` keeps its opener/closer'.
  - 'a CRLF plan stays CRLF after one diagram edit (joins and new block)'.

  If they fail, fix at the source:
  - `SpliceItem` becomes `{ kind: 'new'; source: string; replaces?: number }`. `replaces` is set by
    the caller (`plan-view.tsx` handleBody) when `keepMap` leaves exactly one unmatched old block
    between the same keeps.
  - For fence→fence, the module-private `rewrapFence(old, next)` keeps the old opener/closer lines
    and EOL and replaces only the content.
  - Joins and new sources take the old body's dominant EOL.
  - Call sites of `spliceBody`/`SpliceItem`: `plan-view.tsx` (handleBody), `test/unit/plan-splice.test.ts`.
- **1.3.4** e2e. Add `test/e2e/fixtures/plan/fidelity.md` and `fidelity-crlf.md` (CRLF, `~~~mermaid`
  fence), and a new "fidelity" phase in `plan-blocks.e2e.mjs`:
  - Real `dblclick` on the `batch` edge label, select all, type `load`, Enter.
  - The file diff is exactly that statement's line(s), and the `%%` lines are present.
  - Pane-menu Add node gives exactly one appended line.
  - For the CRLF/`~~~` fixture, the same relabel leaves every other byte identical (CRLF kept,
    `~~~` kept).

---

## Item 2 — Canvas (`feat/plan-v2-2-canvas`)

### Contracts

```ts
// src/plan-layout.ts
export interface PlanLayoutEntry { direction: string; nodes: Record<string, { x: number; y: number }> }
export interface PlanLayoutData { version: 1; diagrams: Record<string, PlanLayoutEntry> }
export const DIAGRAM_KEY_RE = /^flow-\d{1,4}$/;
export const MAX_LAYOUT_NODES = 2000;                          // per entry; host refuses above
export function restorePlanLayout(text: string | undefined): PlanLayoutData | null; // absent/malformed/foreign → null
export function serializePlanLayout(d: PlanLayoutData, now: number): string;     // {conduit:1,kind:'plan-layout',updatedAt,data}
export function layoutFingerprint(d: PlanLayoutData | null): string;
export function isPlanLayoutEntry(x: unknown): x is PlanLayoutEntry;   // finite coords, ids /^[A-Za-z0-9_][A-Za-z0-9_-]*$/
export function mergeLayoutEntry(d: PlanLayoutData | null, key: string, entry: PlanLayoutEntry | null): PlanLayoutData;
export function pinsFor(entry: PlanLayoutEntry | undefined, g: FlowGraph): Record<string, XY>;
  // {} when direction ≠ g.direction (ignored, no write — spec deviation) or < 50 % of stored ids present
export function pruneEntry(entry: PlanLayoutEntry, g: FlowGraph): PlanLayoutEntry;

// electron/plan-layout-writer.ts — serialises read-merge-write per (root, slug) (review B3)
export interface LayoutIo { read(root: string, slug: string): PlanLayoutData | null;
  write(root: string, slug: string, d: PlanLayoutData): void; record(root: string, slug: string, fp: string): void }
export function createLayoutWriter(io: LayoutIo):
  (root: string, slug: string, key: string, entry: PlanLayoutEntry | null) => Promise<PlanLayoutData>;
  // one promise chain per `${root}::${slug}`; read + merge + record + write run inside the chain; a
  // rejection fails only its own call and the chain continues

// src/flow-placement.ts
export interface Rect { x: number; y: number; w: number; h: number }
export interface Frame extends Rect { id: string; depth: number; title: string }
export function placeNodes(computed: Record<string, XY>, sizes: Record<string, Size>, pins: Record<string, XY>): Record<string, XY>;
  // pinned → exactly at pin; unpinned nudged right/down out of every pinned rect, gap 16
export function deriveFrames(g: FlowGraph, pos: Record<string, XY>, sizes: Record<string, Size>, fallback: Record<string, Rect>): Frame[];
  // bbox of descendants + pad 24 + title 28; empty subgraph uses fallback (layoutFlow region); deepest first
export function frameAt(frames: readonly Frame[], p: XY): string | null;   // deepest containing p

// src/flow-fit.ts
export const INLINE_MIN_H = 220; export const INLINE_MAX_H = 560;
export function inlineFit(bounds: Rect, paneWidth: number): { zoom: number; height: number; partial: boolean; x: number; y: number };
  // zoom clamped [0.5, 1], pad 16

// src/flow-nav.ts
export type NavDir = 'left' | 'right' | 'up' | 'down';
export function nearestInDirection(rects: Record<string, Rect>, from: string, dir: NavDir): string | null;

// src/flow-history.ts
export interface FlowStep { doc: boolean; layout: { before: PlanLayoutEntry | null; after: PlanLayoutEntry | null } | null }
export interface FlowHistory { past: readonly FlowStep[]; future: readonly FlowStep[] }
export const EMPTY_FLOW_HISTORY: FlowHistory;
export function recordStep(h: FlowHistory, s: FlowStep): FlowHistory;          // clears future, cap 200
export function takeUndo(h: FlowHistory): { history: FlowHistory; step: FlowStep } | null;
export function takeRedo(h: FlowHistory): { history: FlowHistory; step: FlowStep } | null;

// src/protocol.ts
// host → renderer
| { type: 'plan:doc'; root; slug; markdown: string | null; origin: 'load'|'external'|'write-ack'; layout?: PlanLayoutData | null } // layout iff 'load'
| { type: 'plan:layout'; root: string; slug: string; layout: PlanLayoutData | null; origin: 'external' | 'ack'; key?: string; seq?: number } // key+seq iff 'ack'
| { type: 'plan:error'; root; slug; op: 'load' | 'write' | 'comments' | 'layout'; message: string; key?: string; seq?: number }
// renderer → host
| { type: 'plan:setLayout'; root: string; slug: string; diagramKey: string; entry: PlanLayoutEntry | null; seq: number }

// electron/plan-watcher.ts
export type PlanChange =
  | { file: 'plan'; markdown: string | undefined }
  | { file: 'comments'; comments: PlanCommentsData }
  | { file: 'layout'; layout: PlanLayoutData | null };
export type OnPlanChange = (root: string, slug: string, change: PlanChange) => void;
recordWrite(root: string, slug: string, file: 'plan' | 'comments' | 'layout', fingerprint: string): void;

// electron/conduit-fs.ts
export function readPlanLayout(root: string, slug: string): PlanLayoutData | null;   // <root>/.conduit/plans/<slug>.layout.json
export function writePlanLayoutFile(root: string, slug: string, d: PlanLayoutData): void; // writeAtomic

// webview/plan-store.ts
PlanDocState += { layout: PlanLayoutData | null; layoutError: string | null };
export function setPlanLayout(root: string, slug: string, key: string, entry: PlanLayoutEntry | null): void;
export function retryPlanLayout(root: string, slug: string): void;
  // optimistic overlay per key; posts 300 ms after the last call per (plan,key) with seq = ++counter.
  // The overlay for a key stays until the ack carrying that key's LATEST posted seq (should-fix 10);
  // older acks and 'external' replace the disk copy but never the overlaid key, so pins never snap back.

// webview/plan-diagram-hub.tsx — provided by plan-view (review B1)
export interface DiagramHub {
  write(key: string, edits: readonly FlowEdit[], layout?: { before: PlanLayoutEntry | null; after: PlanLayoutEntry | null }): FlowEditRefusal | 'gone' | null;
  layout(key: string, before: PlanLayoutEntry | null, after: PlanLayoutEntry | null): void; // layout-only step
  undo(key: string): void; redo(key: string): void;
  openKey: string | null; open(key: string): void; close(): void;   // item 3 consumes open/close
}
export const DiagramHubContext: React.Context<DiagramHub | null>;
export function useDiagramHub(root: string, slug: string, view: EditorView | null): DiagramHub;
  // history Map<key, FlowHistory> in a ref, cleared when plan-store reports an external reload;
  // write = writeDiagram(view, key, edits) then recordStep({doc:true, layout}); each step is one PM
  // history event because writeDiagram dispatches closeHistory(tr) (should-fix 2)
// webview/components/plan-editor.tsx: PlanEditorProps += onView(view: EditorView | null): void
```
**Host validation at `plan:setLayout`:** Checks: slug matches `PLAN_SLUG_RE`, key matches
`DIAGRAM_KEY_RE`, `isPlanLayoutEntry`, and ≤ `MAX_LAYOUT_NODES`; A refusal is answered with
`plan:error op 'layout'`, message `invalid layout entry`, plus the request's key and seq; fs errors
are answered the same way, with the message from `planErrorText`.

`FlowEditorProps` += `pins: Record<string, XY>; onLayout(after: PlanLayoutEntry | null, withEdits?: readonly FlowEdit[]): void;
onUndo(): void; onRedo(): void; mode: 'inline' | 'workspace'; onViewportChange?(zoom: number): void`.

### Slice 2.1: Sidecar host + store

**Check:** `npx vitest run test/unit/plan-layout.test.ts test/unit/plan-layout-writer.test.ts test/unit/plan-watcher.test.ts test/unit/plan-fs.test.ts test/unit/plan-store.test.ts`
**Parallel groups:** G1: 2.1.1 · Serial: 2.1.2, 2.1.3   **Claims:** `src/protocol.ts`, `electron/main.ts`

- **2.1.1** `src/plan-layout.ts`. Red tests: 'foreign kind → null'; 'merge replaces one key only';
  'pinsFor: 2 of 5 ids → {}'; 'pinsFor: direction differs → {}'; 'prune drops gone ids'.
- **2.1.2** Host side: **Files:** `electron/plan-layout-writer.ts` (create),
  `electron/conduit-fs.ts`, `electron/plan-watcher.ts`, `src/protocol.ts`, `electron/main.ts`;
  **Watcher:** classify `.layout.json` before the `.md` fallthrough. The fingerprint is
  `layoutFingerprint`; **main.ts:** The watcher callback at :2105-2111 switches on `change.file`;
  `plan:load` (:3141) adds `layout`; The `plan:setLayout` handler goes beside `plan:setComments`
  (:3207) and awaits the writer; **Call sites of `OnPlanChange`:** `main.ts:2105` and
  `plan-watcher.test.ts`; **Red tests:** writer: 'two concurrent patches to different keys both
  survive'; writer: 'a failed write rejects only its call'; watcher: 'layout classified, self-echo
  skipped'; plan-fs: 'layout round trip'.
- **2.1.3** `webview/plan-store.ts`. Red tests: 'load carries layout'; 'burst posts once after 300
  ms'; 'ack of an older seq keeps the overlay'; 'ack of latest seq drops it'; 'error op layout sets
  layoutError; retry re-posts'.

### Slice 2.2: Pure geometry

**Check:** `npx vitest run test/unit/flow-placement.test.ts test/unit/flow-fit.test.ts test/unit/flow-nav.test.ts test/unit/flow-history.test.ts`
**Parallel groups:** G2: 2.2.1 · G3: 2.2.2 · G4: 2.2.3. They are file-disjoint and may run beside G1.

- **2.2.1** `src/flow-placement.ts`. Red tests: 'pinned node at its pin exactly'; 'unpinned
  overlapping a pin nudged by +16'; 'frame = members bbox + pad + title'; 'nested frames contain
  children'; 'frameAt returns deepest'.
- **2.2.2** `src/flow-fit.ts` + the `src/flow-layout.ts` gaps. Red tests: 'tall graph → 560 and
  partial when width needs < 0.5'; 'empty bounds → 220'; 'five-lr fixture at paneWidth 720 with
  estimateSize → zoom ≥ 0.85'. The fixture is `a[Web app] --> b[Gateway] --> c[Identity] -->
  d[Accounts]` plus `b --> e[Audit log]`.

  If that last test fails at `FLOW_XGAP 220`/`FLOW_YGAP 90`, set `96`/`48` and keep `flow-layout`
  'no overlaps' green.
- **2.2.3** `src/flow-nav.ts`, `src/flow-history.ts`. Red tests: 'right picks nearest, null at
  edge'; 'record clears future'; 'cap 200'; 'undo then redo returns the same step'.

### Slice 2.3: Canvas behaviour

**Check:** `npm run verify`; `npm run e2e:remote -- plan-diagram-canvas plan-blocks plan-editor
plan-handoff`.

**Claims (serial lane):** `webview/styles.css`, `webview/plan-menu.ts`

Serial tasks; all of them touch `flow-editor.tsx`:
- **2.3.1 Hub.** **Files:** `webview/plan-diagram-hub.tsx` (create), `plan-editor.tsx` (`onView`),
  `plan-view.tsx` (provides `DiagramHubContext`), `plan-flow-block.tsx`; The block reads
  `useContext(DiagramHubContext)` and passes `hub.write(key, …)` / `hub.undo(key)` into
  `FlowEditor`. The textarea still uses `writeDiagramText`; Red jsdom
  `test/unit/plan-diagram-hub.test.ts`: 'history survives an external reload that reuses the node
  view for another diagram'. Two diagrams; an agent inserts a fence above; undo on `flow-2` undoes
  `flow-2`'s step; 'cleared on reload'.
- **2.3.2 Paint, fit, wheel.**
  - **Files:** `webview/use-flow-canvas-layout.ts` (create), `flow-editor.tsx`.
  - Drop `parentId`/`extent:'parent'` (:458-502) and the explicit `width/height` (:479). Nodes size
    by CSS.
  - In `useLayoutEffect`: `useNodesInitialized` → `getInternalNode(id).measured` →
    `layoutFlow(graph, measured)` → `placeNodes` → `deriveFrames` → `setViewport(inlineFit…)`.
  - The wrapper's `data-ready` gates `visibility`.
  - Before reveal, the block reserves `max(INLINE_MIN_H, inlineFit(estimated bounds).height)`, so the
    document doesn't jump (should-fix 11).
  - The ResizeObserver `fitView` workaround (:688-704) becomes `refit()` on width change, until the
    user pans.
  - **Inline props:** `zoomOnScroll={false} preventScrolling={false} zoomOnDoubleClick={false}
    selectionKeyCode="Shift" multiSelectionKeyCode="Shift" minZoom={0.5}`.
  - **Workspace props:** defaults + `minZoom={0.1}`. `onViewportChange` reports the zoom.
  - **Header:** "Flowchart · N nodes" · Fit · "Partly shown — Expand" when `partial`.
  - Red jsdom: 'canvas hidden until ready, container already at reserved height'.
- **2.3.3 Drag, frames, drop membership, pins.**
  - Regions become non-parent `flowRegion` nodes, `zIndex -1`, `dragHandle: '.planflow__frame-title'`.
  - `onNodeDragStart` snapshots the frames. `onNodeDrag` on a region moves its members by the delta.
  - `onNodeDragStop` takes the last in-pane position, then compares `frameAt(snapshot, centre)` with
    `node.parent`:
    - Different frame, writable plan: `onLayout(after, [moveToSubgraph])`.
    - Different frame, read-only plan: refused. The node snaps back and the notice reads "Plan file
      is read-only" (should-fix 13).
    - Same frame: `onLayout(after)`. The pin persists even when the plan is read-only.
  - The hub records one step per call. `pruneEntry` runs on every write.
  - The layout-save-failed bar note reads "Couldn't save the layout — Retry" → `retryPlanLayout`.
- **2.3.4 Reconnect, style, shape, subgraph menus.** `edgesReconnectable={!readOnly}`. `onReconnect`
  emits a `reconnectEdge` intent. A drop on the empty pane makes no call, and the edge stays;
  `plan-menu.ts`: Edge: `Style ▸` (5 kinds), `Change target…` (IdPicker `kind:'retarget'`); Node:
  `Shape ▸` (8), `Move to top level`; New subgraph menu: Rename, Add node here, Delete (keep
  members); `flowRegion` routes to the subgraph menu; Red `plan-menu.test.ts`: 'shape menu lists
  eight'; 'read-only subgraph menu has no structural items'.
- **2.3.5 Selection toolbar + keyboard.**
  - **`webview/components/flow-selection-toolbar.tsx`:** Props: `{ selection: { nodes: string[];
    edge: number | null; frame: string | null }; readOnly: boolean; on:
    Record<'rename'|'connect'|'style'|'shape'|'delete', () => void> }`; `role=toolbar`, roving
    tabindex. The Comment slot arrives in item 4; Rendered in `NodeToolbar`, or at the edge label
    via `EdgeLabelRenderer`; Read-only: structural buttons are `aria-disabled`, with "Plan file is
    read-only"; Multi-selection: Delete only.
  - **Focus:** `nodesFocusable={false} edgesFocusable={false} disableKeyboardA11y`. The root has
    `tabIndex=0 role=group` and a roving `aria-activedescendant`.
  - **Keys:** Arrows → `nearestInDirection`. Shift+arrows → pin +16; Enter/F2 rename, Shift+C
    connect, S style, E/Tab edges; Del removes; focus moves to the nearest remaining node; Ctrl+Z /
    Ctrl+Shift+Z → `onUndo`/`onRedo`.
  - Bare letters fire only when `document.activeElement` is the root or a node/edge element.
    Today's check is `root.contains` (:778-854).
  - Live region: "Moved svc", "Reconnected …".
  - Red jsdom: 'S does nothing while the rename input is focused'.
- **2.3.6 Tidy.** Pane menu and the header's "Tidy layout": `onLayout(null)`, as one step.
- **2.3.7 e2e** `test/e2e/plan-diagram-canvas.e2e.mjs`. Fixtures: `canvas.md` (api, svc, db in
  subgraph `core`, edge `api -->|writes| db`) and `five-lr.md`. Real mouse throughout. Phases:
  - **(a)** Drag `svc` by +80,+60 (`steps:10`). `.layout.json` gets `flow-1.nodes.svc`. Then Add node;
    `svc` stays within ±2 px.
  - **(b)** The agent relabels, keeping `svc`. `svc` stays at its pin.
  - **(c)** Drag `svc` out of `core`. The fence shows `svc` at top level, and the box sits at the drop
    point ±2 px.
  - **(d)** Drag `.react-flow__edgeupdater-target` of `api→db` onto `svc`. The fence reads
    `api -->|writes| svc`.
  - **(e)** Wheel over the canvas: `.plan__body` scrollTop changes and the transform does not.
    Ctrl+wheel changes the scale.
  - **(f)** The `five-lr` scale is ≥ 0.85.
  - **(g)** Ctrl+Z after a drag restores the box.
  - **(h)** An agent inserts a fence above, then Ctrl+Z on the canvas still undoes that canvas's own
    last step.
  - **(i)** Relaunch: `svc` is still at its pin.
  - **(j)** Make the plan file read-only, then drag across frames. The node snaps back and the notice
    shows.
  - **AC map:** EARS 1, 3, 7, 11, 12.

---

## Item 3 — Workspace (`feat/plan-v2-3-workspace`)

### Contracts

```ts
// webview/mermaid-render.ts
export function renderMermaidSvg(id: string, source: string): Promise<string>; // initialize(buildMermaidConfig) + render; removes orphan `d${id}` on error
// webview/components/diagram-workspace.tsx — rendered by plan-view when hub.openKey !== null (review B1)
export interface DiagramWorkspaceProps {
  title: string; diagramKey: string;           // breadcrumb "Diagram <ordinal from key>"
  source: string; parse: FlowParse;            // unsupported → read-only MermaidDiagram + Edit as text
  editor: Omit<FlowEditorProps, 'mode'>;       // wired to hub.write/undo/redo for this key
  commentCount: number; drawer: ReactNode;     // item 3: shell; item 4: grouped
  onClose(): void;
}
// webview/components/flow-editor.tsx
export interface FlowEditorHandle { escape(): boolean; zoomIn(): void; zoomOut(): void; fit(): void; oneToOne(): void }
// escape(): true when it consumed the key (picker → rename input → selection); zoom % arrives via onViewportChange
// webview/components/diagram-comments-drawer.tsx
export interface DiagramCommentsDrawerHandle { escape(): boolean }   // true when it closed its composer
// webview/plan-diagram-hub.tsx: DiagramHub += registerExpand(key: string, el: HTMLButtonElement | null): void
// webview/view-state-store.ts
ViewState |= { kind: 'diagramMinimap'; on: boolean };
export const DIAGRAM_MINIMAP_VIEW_STATE_ID = 'diagram-minimap';
```
**Ownership (review B1):** `plan-view` renders the workspace when `hub.openKey` is set. It reads
`source` from `locateDiagram(view.state.doc, openKey)` on every doc version: plan-view bumps a
`docVersion` state in `handleBody`; A missing key closes the workspace: the diagram was deleted, or
the plan went not-found; If the diagram stops parsing, the workspace shows the read-only render plus
Edit as text. The textarea writes through `writeDiagramText(view, key, …)`; The inline block shows
the scrim when `hub.openKey === key`; `hub.close()` focuses the element registered through
`registerExpand(key)`. That reference is still correct after a reload, because the block
re-registers on every render.

**Escape chain (should-fix 9):** `ModalLayer`'s overlay-store listener runs on window **capture**
and preempts every inner keydown; So `onDismiss={() => editorRef.current?.escape() ||
drawerRef.current?.escape() || hub.close()}`; Context menus are popovers above the workspace and
close first on their own.

### Slice 3.1: Render extraction

**Check:** `npx vitest run test/unit/mermaid-block.test.ts test/unit/mermaid-export.test.ts`; `npm
run e2e:remote -- mermaid-export`.

- **3.1.1** Create `webview/mermaid-render.ts` and switch `mermaid-diagram.tsx:75-90` to it. This is a
  port task: the existing suites stay green. New test: 'renderMermaidSvg removes the orphan node on
  reject'.

### Slice 3.2: Workspace surface

**Check:** `npm run verify`; `npm run e2e:remote -- plan-diagram-workspace plan-diagram-canvas
plan-blocks`.

**Claims (serial lane):** `webview/styles.css`, `webview/view-state-store.ts`, `test/unit/drag-region.test.ts`

- **3.2.1** `diagram-workspace.tsx`: Shell: `ModalLayer backdropClass="planws__backdrop"`. The
  backdrop is no-drag and is added to `drag-region.test.ts`; `role=dialog aria-modal`, with the
  focus trap from `mermaid-zoom-overlay.tsx:194-202`; **Top bar:** Title › Diagram N; − / % / +,
  where % is `aria-live=polite` and fed by `onViewportChange`; Fit · 1:1 · Tidy; Export ▾: "Mermaid
  render (SVG)" and "(PNG)" via `renderMermaidSvg` → `svgToBlob` / `svgToPngBlob` → `download`.
  "Copy Mermaid source" uses the clipboard; Comments (count) · Close; `MiniMap` sits bottom-right
  when on. `M` toggles it and writes view-state; Ctrl+= / Ctrl+- / Ctrl+0 are handled in the
  dialog's own capture listener; Reduced motion → `duration: 0`.
- **3.2.2** Wiring: **Files:** `plan-view.tsx` (renders the workspace from the hub),
  `plan-diagram-hub.tsx` (`open`/`close`/`registerExpand`), `plan-flow-block.tsx`; The block gets a
  header Expand button. `F` on canvas focus also expands; While open, the inline editor is
  `readOnly` and shows the scrim "Editing in full window"; `FlowEditorHandle` uses
  `forwardRef`/`useImperativeHandle`; Red jsdom test in `plan-diagram-hub.test.ts`: 'workspace stays
  on its diagram when an external reload inserts a fence above'. The workspace's next edit lands in
  the same fence, found by key.
- **3.2.3** `diagram-comments-drawer.tsx` shell: 320 px wide, on the right, collapsible; Empty
  state: "No comments on this diagram"; The composer anchors to the whole diagram. `escape()` closes
  the composer.
- **3.2.4** e2e `test/e2e/plan-diagram-workspace.e2e.mjs`: Click Expand. The dialog shows `Zoom in`,
  `Zoom out`, `Fit`, `1:1` and a %. Clicking + makes the % rise; `M` shows `.react-flow__minimap`;
  The intercepted Export SVG starts with `<svg`; A real drag in the workspace updates
  `.layout.json`. The inline block shows the scrim; The agent writes a new fence above while the
  workspace is open. A rename in the workspace still lands in the original diagram; Dblclick a node,
  then Escape: the rename input is gone and the dialog stays; Escape again: the dialog closes and
  `activeElement` is that block's Expand button; **AC:** EARS 6, 13; Gherkin 2 (without the
  comment).

---

## Item 4 — Element comments (`feat/plan-v2-4-element-comments`)

### Contracts

```ts
// src/plan-comments.ts
export type PlanAnchorPart =
  | { kind: 'node' | 'subgraph'; id: string; label: string }
  | { kind: 'edge'; source: string; target: string; label: string; ordinal: number };
export interface PlanAnchor { index: number; hash: string; snippet: string; excerpt?: string; part?: PlanAnchorPart }
export function blockExcerpt(b: PlanBlock): string;   // first 240 chars of normalizeBlockSource
// locate(): similarity rung compares excerpt (falls back to snippet when the anchor has none)
// src/plan-element-anchor.ts
export type PartResolution = { kind: 'found'; element: { node: string } | { edge: number } | { subgraph: string } } | { kind: 'gone' };
export function resolvePart(part: PlanAnchorPart, g: FlowGraph): PartResolution;  // edge: exact (src,tgt,label) else ordinal-th (src,tgt)
export function partFor(g: FlowGraph, el: { node: string } | { edge: number } | { subgraph: string }): PlanAnchorPart; // empty edge label → "src → tgt"
export function edgeOrdinal(g: FlowGraph, edge: number): number;
export function partText(p: PlanAnchorPart): string;  // node api "Payments API" | edge api -> db "writes" | subgraph core "Core"
export function goneText(p: PlanAnchorPart): string;  // was on node `api` "Payments API"
// src/flow-history.ts (should-fix 3)
FlowStep += { comments: { undo: PlanCommentPatch[]; redo: PlanCommentPatch[] } | null };
// DiagramHub.write(key, edits, layout?, comments?) — same optional trailing argument
```
- `isPlanComment` accepts `part`/`excerpt`. A malformed `part` rejects the comment, as today.
- On reconnect, relabel or restyle, the hub's `write` builds `reattach` patches to
  `partFor(newGraph, {edge})` for every comment resolved to that edge. It applies them via
  `patchPlanComments`.
- The step also records the inverse patches (reattach to the old anchor). Undo applies `undo`, and
  redo applies `redo`.

### Slice 4.1: Anchors

**Check:** `npx vitest run test/unit/plan-comments.test.ts test/unit/plan-element-anchor.test.ts test/unit/plan-handoff.test.ts test/unit/flow-history.test.ts`

- **4.1.1** Red tests: 'excerpt rung separates two ts fences sharing a first line'; 'v1 anchor
  without excerpt re-anchors by snippet'; 'isPlanComment accepts an edge part, rejects a part
  without id'.
- **4.1.2** Red tests: 'edge resolves exact then ordinal'; 'relabelled edge resolves by ordinal';
  'missing node → gone'; 'empty edge label → "api → db"'.
- **4.1.3** `plan-handoff.ts`: line `- §<n> diagram, <partText>: "<text>"`. A gone comment uses
  `goneText`. Red: 'node comment line names node and label'.
- **4.1.4** `flow-history.ts`. Red: 'undo of a step returns its comment undo patches'.

### Slice 4.2: Canvas + drawer + panel

**Check:** `npm run verify`; `npm run e2e:remote -- plan-element-comments plan-diagram-workspace
plan-handoff`.

**Claims (serial lane):** `webview/styles.css`

- **4.2.1** Comment on the canvas: The toolbar `Comment` (and `C`) opens a composer anchored with
  `part`; Pins: the node/subgraph badge sits top-right (a `button`, "n comments on <label>"). The
  edge badge sits at the label or the midpoint; The header gets a comment chip; Pins come from
  `resolvePart` over `reanchorComments`; Hub red jsdom test: 'undo of a reconnect restores the
  comment's old anchor'.
- **4.2.2** Drawer: Grouping: block-level first, then per element, then "Removed elements"; Clicking
  one selects the element and runs `setCenter` on it; "All resolved (n)".
- **4.2.3** Panel: `goneText` / `partText` after `§n`.
- **4.2.4** e2e `test/e2e/plan-element-comments.e2e.mjs` (fixture `canvas.md`): Click `svc` →
  Comment → Save. `anchor.part` is the node, and the pin shows `1`; Comment on the edge `api→db`.
  Reconnect it by mouse: `part.target` updates. Ctrl+Z on the canvas: `part.target` goes back; Send
  with the paste spy: the text contains `node svc "`; The agent drops `svc`: the panel shows `was on
  node \`svc\``; In `plan-diagram-workspace.e2e.mjs`, the drawer lists the svc comment (Gherkin 2);
  The `plan-handoff.e2e.mjs` block-level line is unchanged; **AC:** EARS 4, 5.

---

## Item 5 — Agent loop (`feat/plan-v2-5-agent-loop`)

### Contracts

```ts
// src/plan-brief.ts
export const ASK_SLUG_MAX = 40;
export function slugifyTopic(topic: string): string;                 // lower, [^a-z0-9]+→'-', trim '-', ≤40, '' → 'plan'
export function uniqueSlug(base: string, exists: (slug: string) => boolean): string; // base, base-2, base-3…
export function planAskBrief(topic: string, slug: string): string;  // spec §3.4 text verbatim, ≤ 25 lines
export function planTitle(markdown: string, slug: string): string;  // frontmatter title → first '# ' → slug
// src/protocol.ts
// renderer → host
| { type: 'plan:ask'; sessionId: string; root: string; topic: string }
| { type: 'plan:list'; root: string }
// host → renderer
| { type: 'plan:asked'; sessionId: string; root: string; topic: string; slug: string }
| { type: 'plan:listed'; root: string; plans: { slug: string; title: string }[] }   // reply to plan:list only
// plan:write gains seq: number; plan:doc 'write-ack' and plan:error op 'write' echo it (should-fix 6)
| plan:error op += 'ask'
// electron/conduit-fs.ts
export function listPlans(root: string): { slug: string; title: string }[];    // sorted by title
export function prepareAskSlug(root: string, topic: string): string;          // mkdir plans dir; uniqueSlug on disk
// webview/plan-store.ts
export function writePlan(root: string, slug: string, markdown: string): Promise<'acked' | 'failed' | 'skipped'>;
  // resolves on the write-ack / error echoing ITS seq — never merely the next ack
export function listPlansFor(root: string): Promise<readonly { slug: string; title: string }[]>; // plan:list → plan:listed
// src/plan-comments.ts
export function threadRoot(comments: readonly PlanComment[], id: string): PlanComment | null;
// restorePlanComments: anchorless reply inherits its root's anchor; reply-to-reply → replyTo = root;
// orphan anchorless reply → anchor {index:0, hash:'', snippet:''} (shows detached, never dropped)
// applyPlanCommentPatch 'resolve' on a root sets every reply's status too
// src/plan-handoff.ts
export function sendPreamble(planPath: string, slug: string): [string, string]; // spec §3.4 two lines
// PlanHandoffInput += { replies: readonly PlanComment[] }   // unsent human replies; rendered "  ↳ reply: \"…\"" under root
// webview/shortcuts.ts
{ id: 'planSend', description: 'Send plan to agent', group: 'Plans', defaultCombo: 'Mod+Shift+Enter' }
{ id: 'planComment', description: 'Comment on the current plan block', group: 'Plans', defaultCombo: 'Mod+Alt+M' }
```
The handoff's v1 closing line is dropped: the preamble now carries that ask (Decisions #3).
`planSend`/`planComment` have no runner in `app.tsx` `actionMap` (`Record<string, …>`, :1279), so the
app dispatcher skips them; `plan-view.tsx` owns a **capture-phase** window listener scoped to its
root (Monaco binds Ctrl+Shift+Enter and would `preventDefault` before the bubble dispatcher).

### Slice 5.1: Pure text + threads

**Check:** `npx vitest run test/unit/plan-brief.test.ts test/unit/plan-comments.test.ts test/unit/plan-handoff.test.ts`
- **5.1.1** `src/plan-brief.ts`. Red: 'brief ≤ 25 lines, contains slug path and topic'; 'slug of
  "Auth: v2 / SSO!" is "auth-v2-sso"'; 'uniqueSlug → -2, -3'; 'empty → plan'; 'planTitle prefers frontmatter'.
- **5.1.2** `plan-comments.ts`. Red: 'anchorless agent reply accepted and inherits root anchor';
  'reply to reply attaches to root'; 'resolving root resolves replies'.
- **5.1.3** `plan-handoff.ts`. Red: 'first two lines are the preamble'; 'unsent reply indented under
  its already-sent root'; 'no closing line'. Update `plan-handoff.e2e.mjs` header assertion.

### Slice 5.2: Host ask/list + store

**Check:** `npx vitest run test/unit/plan-fs.test.ts test/unit/plan-store.test.ts test/unit/plan-watcher.test.ts`
**Claims:** `src/protocol.ts`, `electron/main.ts`
- **5.2.1** `conduit-fs.ts` `listPlans`/`prepareAskSlug`; `main.ts` handlers (`plan:ask`, `plan:list`
  on demand; `plan:write` echoes `seq`). Red plan-fs: 'prepareAskSlug creates the dir and skips existing'.
- **5.2.2** `plan-store.ts`: `writePlan` posts `seq`, resolves `'acked'` on the write-ack echoing it,
  `'failed'` on `plan:error op write` echoing it, `'skipped'` under conflict/readOnly. Call sites of
  `writePlan`: `plan-view.tsx` (rich save :251-259, source save :146-157) — they ignore the result
  except Send. Red: 'an earlier write's ack does not resolve a later writePlan'; 'listPlansFor resolves on plan:listed'.

### Slice 5.3: UI

**Check:** `npm run verify`; `npm run e2e:remote -- plan-agent-loop plan-handoff plan-editor plan-element-comments`
**Claims (serial lane):** `webview/app.tsx`, `webview/shortcuts.ts`, `webview/styles.css`
- **5.3.1** `plan-view.tsx` Send: `sendingRef` guard; `flushPlanWrites()` cancels both 300 ms timers
  (rich `timerRef` :262-272, source :146-157), writes now, awaits `writePlan`; `'failed'` → abort, v1
  save-failed + Retry, nothing pasted; then build from `getPlanState().disk`. Mod+Shift+Enter and
  Mod+Alt+M (composer on caret's block via `focusIndex`/selection block index) listeners. Panel
  empty-state hint (`plan-comments-panel.tsx:429`) becomes `Press <kbd>{comboLabel('planComment')}</kbd>
  to comment on the current block.`
- **5.3.2** Panel threads: replies nested under root (Agent badge), Reply composer → `add` with
  `replyTo: root.id`, `anchor: root.anchor`; Resolve on root resolves thread.
- **5.3.3** `app.tsx`: commands `Plans: Ask agent for a plan…` (opens `PlanAskModal`, submit disabled
  on empty topic with helper text; on submit posts `plan:ask` with `activeIdRef.current` and that
  session's home root) and `Plans: Open plan…` (awaits `listPlansFor(root)` for each open project root, then reopens palette at
  `'>Plans: Open '`, precedent `app.tsx:3982`); per-plan entries `Plans: Open <title>`; none →
  `Plans: No plans yet — Ask agent for a plan…`. On `plan:asked`: `pasteToTerminal(sessionId,
  planAskBrief)` else clipboard + toast "Copied — paste it to your agent". Toast (:2471-2498):
  skip when any open doc's path is the plan; otherwise "Plan ready: <title>" (`planTitle(getPlanState(root, slug).disk, slug)` — renderer-side, no index) with Open, one live
  toast per plan key (keep the toast id; skip while it is in `getToastsSnapshot()`).
- **5.3.4** `SKILL.md` → brief's rules (anchorless replies, `replyTo`, never edit `.layout.json`,
  new shapes, `%%` fine), version 1.1.0.
- **5.3.5** e2e `test/e2e/plan-agent-loop.e2e.mjs`: no `.conduit/plans` dir at start; bracketed
  paste on; palette → `Plans: Open plan…` shows "No plans yet"; Ask → type "Auth service" → Enter →
  spy text contains `.conduit/plans/auth-service.md` and `Please write a plan for: Auth service`;
  fs-write the plan (with the Background fence) → exactly one "Plan ready: …" toast, Open; agent
  appends a `replyTo` reply → nested within 1 s; type in prose and press Ctrl+Shift+Enter within
  100 ms → spy text contains the typed text and the preamble. Gherkin 1 end to end: drag `svc`,
  reconnect `api→db` onto `svc`, select `svc` → Comment "split this into two services" →
  Ctrl+Shift+Enter → spy names `node svc` and contains the edited fence; relaunch → `svc` at pin.
  AC: EARS 8, 9, 10; Gherkin 1.

---

## Item 6 — Polish (`feat/plan-v2-6-polish`)

**Check:** `npm run verify`; `npm run e2e:remote -- plan-blocks plan-handoff`; then the full
`npm run e2e:remote -- --full` once (end of run).
**Claims (serial lane):** `webview/styles.css`

- **6.1** `webview/plan-diagnostics.ts`: module-private `PLAN_SUPPRESSED_CODES = [2389, 2390, 2391]`;
  `export function visibleDiagnostics(d: readonly WorkerDiagnostic[]): WorkerDiagnostic[]`, applied in
  `attachBlockDiagnostics`. Red `plan-diagnostics.test.ts`: 'bodiless function declaration yields no marker'.
- **6.2** `plan-code-block.tsx` chip: "TypeScript · checking…" until the first diagnostics pass,
  then "✓" or `plural(n,'problem')`; other languages show the language only.
- **6.3** Empty flowchart (0 nodes): dashed canvas, "Empty diagram", Add node button.
- **6.4** a11y: `plan-action-bar.tsx` Send uses `aria-disabled` + visible reason text (no `disabled`),
  click while blocked announces the reason; composer counter `aria-live` only at ≥ 90 % and at the
  limit (`plan-comments-panel.tsx:127-130`); `.plan__gutter` `-webkit-app-region: no-drag` (add to
  `drag-region.test.ts`).
- **6.5** e2e: `plan-blocks.e2e.mjs` — a `ts` fence `export function f(): T;` has no
  "implementation is missing" marker and the chip reads ✓ or a problem count; `plan-handoff.e2e.mjs`
  — blocked Send has `aria-disabled="true"` and reason text.
- **6.6** Spec close-out: `git mv` spec to `docs/specs/archive/`, update `docs/specs/INDEX.md`.

## Verification

Per task: the named red test fails, then `npx vitest run <file>` passes. Per slice: its Check.
Per item before merge: `npm run verify` green (exit code read directly) → code review → runtime QA on
a built app with real mouse → `npm run e2e:remote -- <item scenarios> plan-editor plan-blocks
plan-handoff` → merge to `main`. End of run: `npm run e2e:remote -- --full` once.

## Deviation rule

If a task's assumption turns out wrong — the piece it builds on is misaligned, a locked signature
doesn't fit reality — that task **stops** and fixing the misaligned piece becomes the work. Never a
shim, second copy, special case, widened type, fallback, or an override patched in place of its
semantic source. Report leads with the fix that keeps the locked decision.

## Decisions Needed

- [high] #1 ACCEPTED by conductor: spec §4 "`c` in prose" → **Mod+Alt+M** (`planComment`, rebindable);
  bare `c` keeps v1 behaviour on non-text block focus; panel hint updated (Task 5.3.1).
- [normal] #2 Minimap toggle is remembered in `view-state-store` (renderer memory): survives tab
  switches and reopen, not an app relaunch.
- [normal] #3 The v1 handoff closing line is dropped; the §3.4 preamble carries that ask.
- [normal] #4 Inline fit ≥ 0.85 is measured on a stated 5-node LR fixture (the probe's graph wasn't
  saved); gap constants change only if that test fails (Task 2.2.2).
- [normal] #5 Canvas undo delegates doc steps to ProseMirror history (one `closeHistory` event per
  step), so a canvas Ctrl+Z after interleaved prose typing undoes the newest doc change (v1
  semantics). Per-key history is cleared on an external reload.
- [normal] #6 Anchorless / reply-to-reply comments are normalised on read (host and renderer) so
  `PlanComment.anchor` stays required; the agent's file gains the inherited anchor on the next host write.
- [normal] #7 Ask mkdirs `.conduit/plans/` on submit so the watcher is armed before the agent writes;
  the host decides the slug against disk.
- [normal] #8 Remote e2e can't exercise the `.topbar` app-region mask; `drag-region.test.ts` is the guard.
- [normal] #9 Direction-change pins are ignored rather than cleared (conductor ruling; spec to be
  updated — see Spec deviations).
