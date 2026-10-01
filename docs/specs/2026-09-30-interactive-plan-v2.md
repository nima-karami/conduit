---
status: active
date: 2026-09-30
---

# Feature Spec: Interactive plans v2 — a whiteboard any agent can draw on

**Tier:** FULL   **Feature type:** UI
**One-line request:** "An agent-agnostic equivalent and better version of the Claude artifacts … the
agent gives me a plan in some format any agent can give me, and Conduit lets me modify this
graphically rich interactive plan: type in the code block, change the diagram, comment on specific
parts of the diagram, move the nodes, change the connectors, add nodes, turn the diagram into a
full-screen experience with zoom and all the features we have for diagram viewing … a very smooth
flow so the user and the agent work on the plan together."

Builds on v1 (`docs/specs/archive/2026-09-19-interactive-plan.md`, shipped `1ccde7f`). Everything
there stays unless a section below changes it. Mode: **autonomous** (unattended run); every
would-be question is a locked default in §13.

## 1. Problem frame

- **Job:** the agent sketches, the human reshapes and annotates *in place*, and the agent picks up
  exactly what changed — whichever CLI agent is running in the session.
- **Actors:** the human; any terminal agent in a Conduit session (Claude Code, Codex, Gemini CLI,
  Aider, a plain shell user).
- **Success outcomes:** (1) a node the human moved stays where they put it — across edits, reloads
  and agent rewrites; (2) a comment can point at one node or one connector, and the agent's paste
  says which; (3) any diagram opens full-window with the zoom/pan/export the standalone Mermaid
  viewer already has, and stays editable there; (4) an agent that has never heard of Conduit can be
  asked for a plan and answer comments, with no install; (5) editing one edge changes one line of
  the fence, not the whole fence.
- **Non-goals:** arbitrary HTML/JS "artifacts" in a plan (local HTML already has the
  `conduit-preview:` viewer, ADR 0005); freeform shapes or sticky notes; structural editing of
  sequence/class/state diagrams; multi-user collaboration; syncing a plan to code.

## 2. Behavior & states

### 2.1 Current behavior (the gap this closes)

Measured 2026-09-30 on main `ae46f36`: fresh build, hidden Playwright-Electron probe, real mouse
(`.autoloop/evidence/probe-baseline.md`). Remote e2e `plan-editor`, `plan-blocks`, `plan-handoff`,
`mermaid-export` PASS (run 36807591317).

| Claim about today | How measured | Status |
|---|---|---|
| Dragged node offset is discarded on any graph edit and never written | drag +54,+72, then Add node: node back at computed spot | Measured |
| Nodes can't leave their subgraph; subgraphs can't be dragged | drag attempts, `extent:'parent'` | Measured |
| Edges can't be reconnected; no edge-kind, node-shape, subgraph rename/delete UI | updater handle count 0; menus listed | Measured |
| Comments anchor to the whole fence only | sidecar read back `{index,hash,snippet:"```mermaid"}` | Measured |
| Flowchart block: fixed 340 px, plain wheel zooms the canvas, no full screen, no zoom controls, no export | viewport transforms, DOM | Measured |
| First fit of a 5-node LR graph draws 40×17 px nodes | screenshot | Measured |
| One diagram edit rewrites the whole fence canonically (drops `%%`, splits chains, re-spells edges and shapes) | file diff after one relabel | Measured |
| Bodiless `export function f(): T;` in a `ts` fence shows "Function implementation is missing" | Monaco markers read back | Measured |
| Mod+Shift+Enter sends nothing | paste spy: 0 pastes | Measured |
| The plan format reaches only Claude (skill copied to `.claude/skills`) | `electron/skills-service.ts:19-34` | ASSUMED (source) |
| Send does not flush the armed 300 ms write before pasting | `plan-view.tsx:376-390` | ASSUMED (source) |
| Agent replies (`replyTo`) render flat; nothing produces `replyTo` | `plan-comments-panel.tsx:257` | ASSUMED (source) |
| "Agent updated plan" toast is pushed on every external write, even with the plan open | `plan-store.ts:178` | ASSUMED (source) |
| Whether Codex / Gemini CLI / Aider enable bracketed paste (Send's gate) | not measured | ASSUMED |

### 2.2 Primary flow

1. **Ask.** Palette **Plans: Ask agent for a plan…** (also the empty state of **Plans: Open plan…**)
   asks for a topic in a small input, then pastes a self-contained brief into the active session's
   terminal: where to write, the format rules, how comments work (§3.4). No install, no skill.
2. **Arrive.** The agent writes `.conduit/plans/<slug>.md`. If no tab shows that plan: one toast
   "Plan ready: <title> · Open" (deduped per plan). If it is open, it reloads in place (v1).
3. **Reshape.** The human edits prose and fences (v1) and the diagram: drags nodes (positions
   persist, §3.1), reconnects an edge by dragging its end, changes an edge's style or a node's shape
   from the selection toolbar, renames/deletes subgraphs, adds nodes. Each structural edit changes
   only the fence lines it touches (§3.2).
4. **Annotate.** Selecting a node, edge or subgraph shows a floating **selection toolbar**
   (Rename · Comment · Connect · Style/Shape · Delete — only what applies). **Comment** anchors to
   that element; a count pin sits on it (§3.3).
5. **Go big.** **Expand** (block header button, or `F` while the canvas has focus) opens the
   **diagram workspace**: full-window, same editor, plus zoom, pan, fit, 1:1, minimap, export and a
   comments drawer (§2.4). Non-flowchart / unsupported Mermaid fences Expand into the existing
   `MermaidZoomOverlay` (view-only, as today).
6. **Hand back.** **Send to agent** (button or Mod+Shift+Enter) flushes pending writes, then pastes
   changed blocks + open comments, element comments named (`node api "Payments API"`), headed by a
   two-line reply protocol any agent can follow (§3.4).
7. **Converse.** The agent edits the file and appends replies (`replyTo`) / resolves in the sidecar.
   Replies render threaded under the comment; the human can reply or resolve. Threads are one
   level deep: a reply to a reply attaches to the root. A reply inherits the root's anchor.
   Resolving the root resolves the thread. Unsent human replies go in the next Send under their
   root.

### 2.3 Diagram block (inline)

- **Header row:** "Flowchart · N nodes" · comment-count chip · **Fit** · **Expand**. Language chip
  for code fences ("TypeScript · checking… / ✓ / 2 problems").
- **Height** auto: the height the graph needs at zoom 1 for the pane's width, clamped 220–560 px.
  Fit zoom is clamped to [0.5, 1]; a graph that doesn't fit at 0.5 shows its left/top part, pans,
  and the header shows "Partly shown — Expand". (Target: the probe's 5-node LR graph renders at
  ≥ 0.85.)
- **Wheel** scrolls the document; **Ctrl/⌘+wheel** (including trackpad pinch, which arrives as
  Ctrl+wheel) zooms; empty-pane double-click does nothing. Drag on empty pane pans; **Shift+drag**
  on empty pane box-selects; Shift+click adds to the selection.
- **First paint sequence:** the plan load delivers the layout sidecar with the document (no
  separate wait). Nodes mount hidden at estimated sizes → `useLayoutEffect` reads xyflow's measured
  sizes → layout with measured sizes + pins → fit → reveal. Nothing is visible at an intermediate
  size (CLAUDE.md fit-before-paint gotcha).
- While the workspace is open for this block, the inline canvas is read-only with an "Editing in
  full window" scrim, so there is only one live editor per block.

### 2.4 Diagram workspace (full-window)

A `ModalLayer` surface at the top of the layer stack (`-webkit-app-region: no-drag` over `.topbar`).
- **Top bar:** plan title › "Diagram 2" breadcrumb · zoom − / % / + · Fit · 1:1 · **Tidy layout** ·
  **Export ▾** (Mermaid render as SVG / PNG through the existing `mermaid-export` path — labelled
  as the Mermaid render, since it does not carry the user's arrangement — and **Copy Mermaid
  source**) · **Comments** toggle (count) · Close.
- **Canvas:** `FlowEditor` in a workspace mode, editable, writing to the same block. Zoom is
  **xyflow's own viewport** (`zoomIn`/`zoomOut`/`fitView`/`setViewport`), not
  `use-pan-zoom-stage` — one zoom system. Wheel zooms (pointer-anchored), empty-drag or
  middle-drag pans, Ctrl ± / 0 zoom/fit, minimap bottom-right (toggle `M`, remembered in
  `view-state-store`, default off).
- **Escape ladder:** Esc closes the innermost thing first — context menu → active rename/label
  input → comment composer → selection → workspace. Each inner layer consumes the key; only an
  idle canvas lets the overlay store close the workspace.
- **Comments drawer (right, 320 px, collapsible):** this diagram's comments grouped by element
  (block-level first); clicking one selects and centres its element; composer anchors to the
  current selection or the whole diagram.
- Edits made here appear in the document live; closing returns focus to the block's Expand button.

### 2.5 States

Document states are v1's. New ones: **layout-save-failed** (positions keep working in-session;
bar note "Couldn't save the layout — Retry"), **element-gone** (a comment's node/edge/subgraph no
longer exists → shown on the block with "was on node `api`", never dropped), **workspace-open**.
**Read-only plan** (v1 state): structural actions are disabled with the reason in the toolbar;
dragging still works and persists if the layout sidecar is writable. The workspace mirrors the
document's state (read-only, conflict, not-found → closes; unsupported → read-only render + Edit as
text).

**Undo.** While focus is in a canvas, Ctrl+Z / Ctrl+Shift+Z walk one **canvas history**, an
ordered log of canvas actions: structural edits (delegating to the document's ProseMirror undo, as
v1) and layout edits (drag, frame drag, Tidy) held by the canvas. A step also restores any comment anchors the edit
moved (reconnect/relabel/restyle). Canvas history lives with the plan view, keyed by diagram, so
an agent reload neither drops it nor applies it to another diagram.
Drop-into-subgraph is one step (fence + pins). Outside the canvas, undo is the document's as v1.

## 3. Data / interface contract

### 3.1 Layout sidecar — `.conduit/plans/<slug>.layout.json`

```ts
{ conduit: 1, kind: 'plan-layout', updatedAt: number, data: {
  version: 1,
  diagrams: Record<string /* diagramKey */, {
    direction: string;                                  // fence direction the pins were made in
    nodes: Record<string /* mermaid node id */, { x: number; y: number }>;  // node top-left
  }>
}}
```
- **Coordinates are absolute** canvas units (top-left of the node, origin = the computed layout's
  origin, which is fixed at 0,0). A pinned node renders exactly at its pin regardless of other
  graph changes. Unpinned nodes take the computed layout and are then **nudged** right/down out
  of any pinned node's rect (+16 px gap). An entry whose stored `direction` differs from
  the fence's is ignored (computed layout) and replaced by the next drag — no write, no undo step
  (design review: an undoable clear-on-render loops).
- `diagramKey` = `"flow-" + ordinal` among the plan's ```` ```mermaid ```` fences whose first
  non-blank, non-`%%` line starts with `flowchart` or `graph` — counted whether or not the fence
  currently parses, so editing one as text doesn't shift the others. Non-flowchart fences have no
  layout. An entry applies only if ≥ 50 % of its stored ids exist in that diagram; otherwise it is
  ignored (reordered diagrams sharing a few ids don't swap pins) and replaced on the next write.
- **Frames** are derived: the bounding box of their members + padding, never stored. Dragging a
  frame's title bar moves (and pins) every nested member.
- **Membership by drop:** hit-testing uses the frames' rects as they were when the drag *started*,
  deepest frame first. Dropping a node inside its own frame changes only its pin. Dropping it on a
  different frame moves it into that subgraph; dropping it outside every frame moves it to the top
  level. Both are structural edits to the fence, and each lands as one canvas step together with
  the pin.
- Ids no longer in the fence are pruned when that diagram's entry is next written.
- **Host protocol:** the layout file is a third watched kind (`plan-watcher` classifies `.md`,
  `.comments.json`, `.layout.json`). `plan:load` replies with `plan:doc` **including** `layout`
  (parsed file or `null`); external changes push `plan:layout {path, layout}`. The renderer writes
  `plan:setLayout {path, diagramKey, entry | null}`, a per-diagram patch the host merges into the
  file on disk and writes atomically. It is acked with `plan:layout`, and failure comes back as
  `plan:error {kind:'layout'}`. Writes are debounced 300 ms after drag end, and self-echo is
  suppressed. The agent never writes this file.

### 3.2 Fence fidelity (minimal-diff serialisation)

This replaces v1's canonical serialiser (a rewrite of `mermaid-flow.ts`'s emit path, not a patch).
The parse keeps the source lines. Every statement records its line, and every node and edge
records the statement that defines it. An edit re-emits only the statements it touches. Every
other line stays **byte-identical**, including `%%` lines, blank lines, indentation, chains
(`a --> b --> c`), edge spelling (`-- x -->`) and shape spelling.

Rules (each one is unit-tested, and so is the property `parse(emit(edit(g))) ≡ edit(g)`, with
untouched lines identical):
- **Invariant:** an edit never changes the label, shape or parent of a node it does not target.
  Before a statement is removed or relocated, a standalone `id[Label]` declaration is emitted in
  its place (same scope and indentation) for every other node whose first or defining mention it
  held.
- **Trailer upkeep:** `linkStyle` indices are renumbered when edge source order changes, and
  `style`/`class`/`click` references to a removed node are dropped (from a multi-id `class` line,
  only that id is removed).
- **A node's defining mention** is its first mention that carries a label or shape. If no mention
  does, it is the first mention of any kind. A rename or shape change rewrites only that mention,
  inside whatever statement holds it, chain included.
- **An edit to one link of a chain** (relabel, restyle, reconnect, delete) splits the chain at that
  link: `a --> b --> c` with `b→c` relabelled becomes `a --> b` / `b -->|x| c`. A node's label stays
  on whichever fragment held its defining mention.
- **Move to subgraph:** a standalone declaration line for the node is removed if there is one, and
  `id[Label]` (or the bare id) is appended at the end of the target scope. Membership follows
  Mermaid's own rule: a node belongs where it is first mentioned. If that first mention sits in an
  edge statement inside the old scope, the edge statement moves out to the top level, and that is
  the one place a line is re-emitted for a membership move.
- **New statements** are appended at the end of their scope (a subgraph body, or the top level
  before the trailer), indented like their siblings.
- **Shapes:** v1's six, plus cylinder `[( )]` and hexagon `{{ }}`. Unknown bracket forms are kept
  verbatim and never re-emitted. The Shape menu offers these eight.
- **Labels:** quoted when they contain any Mermaid syntax character. `"` is written `#quot;`, and
  `#` is written `#35;`, so a literal `#quot;` round-trips. The parser decodes `#quot;` and `#35;`.

**Edge identity:** an edge's comment `part` stores `{source, target, label, ordinal}`. It resolves
in two steps:
1. Exact match on (source, target, label).
2. Otherwise, the `ordinal`-th edge with that source and target.

When the human reconnects, relabels or restyles an edge, the editor rewrites the anchors of the
comments on it in the same step, so they follow the edge. Any other change resolves through the
ladder, or the comment goes element-gone. `addEdge` keeps rejecting an exact duplicate (same
endpoints, kind and label) with the notice "That connection already exists". `<-->` keeps its
as-written direction.

### 3.3 Element comments

```ts
anchor: { index; hash; snippet;
  excerpt?: string;                     // NEW: first 240 chars of the block's normalised content
  part?: | { kind: 'node' | 'subgraph'; id: string; label: string }
         | { kind: 'edge'; source: string; target: string; label: string; ordinal: number } }
```
- Block re-anchoring ladder unchanged except the similarity rung compares `excerpt` (falls back to
  `snippet` for v1 comments without one) — fixes same-language fences scoring 1.0.
- Then the part resolves (node/subgraph by id; edge per §3.2): found → pinned to the element;
  missing → **element-gone** (block-level, "was on node `api` "Payments API"").
- **Replies** (`replyTo` set) may omit `anchor`; they inherit the root's. `isPlanComment` accepts
  that shape, so an agent reply is never dropped.
- Pins: node/subgraph → badge at the top-right corner; edge → badge at the label, or the edge
  midpoint when unlabelled.

### 3.4 Agent-agnostic protocol (text, no install)

**Ask brief** (pasted; ≤ 25 lines; one constant, unit-tested):
```
Please write a plan for: <topic>
Write it as Markdown to .conduit/plans/<slug>.md (create the folder). Conduit renders it as an
editable whiteboard. Use:
- normal Markdown for prose, lists and tables;
- ```ts fences for signatures/interfaces (bodiless declarations are fine);
- ```mermaid flowchart fences for structure (flowchart LR|TD, nodes id[Label], edges -->, -.->,
  ==>, |labels|, subgraph id [Title] … end). Keep node ids stable between revisions.
I will edit it and comment. Comments live in .conduit/plans/<slug>.comments.json, shaped
{"conduit":1,"kind":"plan-comments","updatedAt":<ms>,"data":{"version":1,"comments":[...]}};
each comment has id, author, text, anchor, status. To answer one, append to data.comments
{"id":"<new>","author":"agent","text":"…","replyTo":"<id>","status":"open","createdAt":"<ISO>"}
and set the original's status to "resolved" when you have addressed it. Keep everything else in
that file as it is. Never edit <slug>.layout.json.
```
`<slug>`: the topic lower-cased, non-alphanumerics → `-`, trimmed, ≤ 40 chars (`plan` if empty);
if `.conduit/plans/<slug>.md` exists in the session's home root, `-2`, `-3`, … The brief goes to
the **active session's** terminal (the one the palette was invoked from); Send keeps v1's target,
the **plan tab's own session**.
**Send preamble** (first two lines of every Send paste): `Plan: <path> — I edited it and left
comments (Conduit plan).` / `Revise the file; reply in <slug>.comments.json (append author "agent"
with replyTo; resolve when done).` Element comments render as `- §2 diagram, node api "Payments
API": "…"` / `edge api -> db "writes": "…"` / `subgraph core "Core": "…"`; an unsent human reply
renders indented under its root as `  ↳ reply: "…"` (the root is included for context even if it
was sent before).

The bundled Claude skill stays and is updated to the same rules; it is no longer the only path.

### 3.5 Producers / consumers

| Data / state | Produced by | Consumed by | Both in scope? |
|---|---|---|---|
| `<slug>.md` fence text | flow editor reducers + minimal-diff serialiser; agent | parser (editor), agent | yes |
| `<slug>.layout.json` | flow editor (drag, frame drag, tidy) via host `plan:setLayout` | flow editor + workspace via `plan:doc` / `plan:layout` | yes (agent: never — brief says so) |
| `anchor.part` in comments sidecar | editor (selection Comment); agent may reply only | comments panel, pins, handoff | yes |
| Threaded replies (`replyTo`) | agent (brief), human reply composer | comments panel | yes — v1 had a consumer with no producer |
| Ask brief / Send preamble | plan editor / palette | any terminal agent | yes |
| Send paste built after a flush | plan editor write path (must await the write-ack) | Send | yes — the producer (write-through) gains an awaitable flush |
| Export SVG/PNG | existing `mermaid-export` on current fence | user's disk | consumer only — producer unchanged, already shipped |
| `isPlanComment` validation | sidecar parse (`src/plan-comments.ts`) | panel, handoff, pins | yes — widened for anchorless replies and `part`/`excerpt` |

## 4. Edge cases & failure modes

| Condition | Expected behavior |
|---|---|
| Agent rewrites while human has pending edits | v1 conflict banner, unchanged (auto-merge deferred, §6). |
| Agent renames a node id | Its pin is pruned; node takes computed layout; comments on it → element-gone. |
| Agent adds nodes to a pinned diagram | Unpinned nodes are computed-placed and nudged out of pinned rects (§3.1). |
| Agent reorders diagrams | ≥ 50 % id-overlap rule (§3.1); otherwise computed layout. |
| Two plans with the same slug in two roots | Sidecars live beside each plan; keyed by path, not slug. |
| Layout sidecar malformed / foreign kind | Ignored with computed layout; overwritten on next drag (logged once). |
| Drag ends outside the canvas | Position clamps to last in-canvas point. |
| Reconnect dropped on empty pane | Edge restored to its original endpoint; no write. |
| Reconnect would duplicate an existing edge (same endpoints, kind, label) | Refused: edge snaps back, notice "That connection already exists". |
| Delete a subgraph | Members are lifted to its parent; edges kept; one canvas step. |
| Element comment on an edge whose label is empty | Label falls back to "source → target" text. |
| Send inside the 300 ms debounce | Flush, await the write-ack, then build the paste from the acked bytes. |
| The flush fails | Send aborts; v1 save-failed state with Retry; nothing is pasted. |
| Send pressed twice quickly | Second is a no-op (v1 idempotency) — now also while the flush is in flight. |
| Layout sidecar not writable | layout-save-failed note; pins keep working in-session. |
| Bare-letter shortcut (C, F, E, S, M) while a rename input, composer or Monaco has focus | Typed as text; the canvas shortcuts fire only when the canvas element itself has focus. |
| Workspace open and the agent rewrites | Reload applies in the workspace too; if the diagram became unsupported, the workspace shows the read-only render + Edit as text. |
| Workspace open and the plan file is deleted | Workspace closes; the tab shows v1's not-found state. |
| Ask with no live session terminal | Brief goes to clipboard; toast "Copied — paste it to your agent". |
| Ask topic empty | Submit disabled; helper text. |
| Very large diagram (200+ nodes) | Inline: 0.5 zoom, partly shown, "Partly shown — Expand"; workspace pans/zooms freely. |
| `c` pressed in prose | Opens the composer on the caret's block (v1 advertised it). |

## 5. Defaults vs. settings

| Decision | Default | Configurable? | Rationale |
|---|---|---|---|
| Positions persisted | yes, layout sidecar | no | The user asked for it; the fence stays plain Mermaid. |
| Inline wheel | scrolls doc; Ctrl+wheel zooms | no | Document first; matches editor convention. |
| Workspace wheel | zooms | no | It is a canvas; matches the Mermaid viewer. |
| Minimap (workspace) | off; `M` toggles, remembered | yes (toggle) | Clutter vs. orientation. |
| Export | Mermaid render SVG/PNG + Copy source | no | Reuses the shipped export; arranged-layout export is Vision. |
| Send shortcut | Mod+Shift+Enter | via existing Shortcuts settings | v1 spec'd it; it was never bound. |
| Ask brief | built-in constant | no | One reviewed text; agents differ, the format doesn't. |

## 6. Scope slicing

- **MVP (must)** — build order:
  1. **Fence fidelity**: span-preserving parse, minimal-diff emit, shapes, label escaping, edge
     anchor resolution.
  2. **Canvas**: layout sidecar + host protocol, absolute pins + nudge, derived frames + frame drag,
     membership by drop, measured sizes + paint sequence, auto height + inline fit, wheel/dblclick,
     reconnect, edge style, node shape, subgraph rename/delete, selection toolbar, box/shift
     select, roving keyboard nav + Shift+arrows move, Tidy layout, canvas history (undo).
  3. **Workspace**: full-window editor, xyflow zoom/pan/fit/1:1, minimap, export, Escape ladder,
     inline read-only scrim, comments drawer shell.
  4. **Element comments**: `anchor.part`/`excerpt`, pins, toolbar Comment, drawer grouping, handoff
     lines, element-gone.
  5. **Agent loop**: Ask brief + slug, Open plan… quick-pick with empty state, Send preamble + awaited
     flush + Mod+Shift+Enter, threads (anchorless replies, human reply, resolve thread), toast
     dedupe, `c` in prose, skill updated to the brief's rules.
  6. **Polish**: ts bodiless-declaration diagnostics suppressed (2391/2390/2389, plan blocks only —
     the brief invites bodiless signatures), language/checking chip, dashed empty canvas, a11y debt
     on touched surfaces (Send blocked reason announced, composer counter at thresholds, gutter
     `no-drag`).
- **v1 (should):** disjoint-block auto-merge of agent rewrites (needs a 3-way base; v1's banner
  covers the short write-through window today); images resolved relative to the plan; structural
  sequence diagrams.
- **Vision:** export of the arranged canvas; `path:` links from blocks to files; "Agreed" freeze.
- **Out of scope:** §1 non-goals; changing the architecture canvas or board.

## 7. Acceptance criteria

**EARS**
- When the user drags a node and releases it, the editor shall persist its position, and the node
  shall render at that position after any other graph edit, a tab reopen, an app relaunch, and an
  agent rewrite that keeps its id.
- When the user edits one edge label, the plan file shall differ from before in exactly that line
  (or the split chain it belonged to), with `%%` lines and all other statements byte-identical.
- When the user drags an edge endpoint onto another node, the fence shall show the edge with the
  new endpoint and the same label and style.
- When the user comments on a selected node, the sidecar anchor shall carry `part {kind:'node',id}`,
  the node shall show a count pin, and Send shall include `node <id> "<label>"`.
- If a commented node disappears from the fence, then the comment shall remain visible on the
  block, marked with the node's last label.
- When the user activates Expand, the diagram shall open full-window with zoom ±, %, Fit, 1:1,
  minimap, SVG/PNG export and the comments drawer, and edits there shall reach the file.
- While the pointer is over an inline diagram, a plain wheel shall scroll the document.
- When the user runs Ask agent for a plan, the active session's terminal shall receive the brief
  with the slug and topic filled in.
- When an agent appends a reply with `replyTo`, the comments panel shall render it nested under
  its parent within 1 s.
- When the user presses Send within 300 ms of typing, the paste shall contain the typed text.
- The inline fit of the probe's 5-node LR flowchart shall render at ≥ 0.85 zoom.
- When the user drops a node outside every subgraph frame, the fence shall show the node at the
  top level and the node shall stay where it was dropped.
- While a rename input has focus inside the workspace, Escape shall cancel the rename and leave
  the workspace open.

**Gherkin**
```gherkin
Feature: Reshape and annotate a diagram the agent drew
  Background: an agent wrote .conduit/plans/auth.md with a flowchart (api, svc, db) and the plan is open
  Scenario: Move, rewire, comment, send
    When I drag "svc" to a new spot and drag the end of edge api->db onto svc
    And I select "svc", choose Comment, and type "split this into two services"
    And I press Mod+Shift+Enter
    Then the terminal receives a paste naming node svc and containing the edited fence
    And after relaunching Conduit "svc" is at the spot I dropped it
  Scenario: Full-window review
    When I press Expand on the diagram
    Then the workspace shows zoom controls, a minimap and the comment drawer with my comment on svc
    When I press Escape
    Then focus returns to the diagram's Expand button
```

## 8. State catalog (UI)

| Component | State | What the user sees | Action |
|---|---|---|---|
| Diagram block | populated | header, canvas at auto height, pins | edit / Expand |
| | empty (0 nodes) | dashed canvas, "Empty diagram" + **Add node** | Add node |
| | partly shown (doesn't fit at 0.5) | header "Partly shown — Expand" | Expand |
| | inline while workspace open | read-only scrim "Editing in full window" | — |
| | layout-save-failed | bar note + Retry | Retry |
| | unsupported syntax | v1 read-only render + Edit as text | Edit as text |
| Selection toolbar | node / edge / subgraph / multi / read-only plan | relevant actions only; multi = Delete only; read-only = structural actions disabled with "Plan file is read-only" | per action |
| Workspace | open | full-window chrome | Esc closes |
| | reloaded by agent | v1 changed markers on the block; canvas re-lays out, pins kept | — |
| | plan became unsupported / read-only / deleted | read-only render + Edit as text / disabled structure / closes | — |
| Comments drawer | none / all resolved / element-gone group | "No comments on this diagram" / "All resolved (n)" / "Removed elements" group | Re-attach / Resolve |
| Comment thread | with replies | parent, nested replies (Agent badge), Reply + Resolve | Reply |
| Open plan… quick-pick | no plans | "No plans yet" + **Ask agent for a plan…** item | Ask |
| Ask input | empty / no terminal | disabled submit / clipboard toast | — |

## 9. Interaction inventory (UI)

| Component | Actions | Pointer | Keyboard | Context menu | ARIA |
|---|---|---|---|---|---|
| Node | select, move, rename, comment, shape, connect, delete | click, drag, dbl-click label | Tab into canvas (one stop) → arrows move selection to the nearest node in that direction; Shift+arrows move the node 16 px (Alt+arrows is global Back/Forward); Enter/F2 rename; C comment; Shift+C connect; Del | Rename, Comment, Connect to…, Shape ▸, Move to subgraph…, Delete | `role=group` canvas, nodes `role=button` + `aria-label="Node <label>, n comments"`, `aria-selected` |
| Edge | select, relabel, reconnect, style, comment, delete | click, drag endpoint, dbl-click label | Tab cycles edges after nodes (or `E`); Enter relabel; S style; C; Del | Edit label, Style ▸, Change target…, Comment, Delete | `aria-label="Edge <src> to <dst>, <label>"` |
| Subgraph frame | select, move members, rename, delete | drag title bar, dbl-click title | Enter rename; C comment; Del (lifts members) | Rename, Comment, Add node here, Delete (keep members) | `role=group` + label |
| Selection toolbar | actions above selection | click | reachable by Tab after the selection; Esc dismisses | — | `role=toolbar`, roving tabindex |
| Workspace chrome | zoom, fit, 1:1, tidy, export, comments, close | click | Ctrl +/−/0, Esc, M minimap | — | modal dialog, focus trap, zoom % `aria-live=polite` |
| Comment pin | open thread | click | via node's `C` / drawer | — | button "n comments on <label>" |

Every drag has a non-drag path: move (Shift+arrows), reconnect (edge menu **Change target…**
picker), membership (Move to subgraph… / Move to top level), multi-select (Shift+click). Touch:
N/A — Conduit is a desktop app; pointer rules cover pen/trackpad.

## 10. Accessibility & i18n (UI)

- Keyboard: all §9 actions keyboard-reachable; one Tab stop into the canvas (roving), not one per
  node (closes v1 follow-up). Focus returns sensibly: after delete → nearest node; after workspace
  close → Expand button.
- Visible focus on nodes/edges/pins via the shared focus ring, verified under forced colours.
- Live region announces: node moved ("Moved svc"), reconnected, comment added, zoom %, Send
  result. The composer counter announces only at 90% and at the limit.
- Pins and changed markers carry text/icon, not colour alone; contrast ≥ 4.5:1 in all three themes.
- Reduced motion: no animated fit/zoom transitions.
- Send's blocked reason is announced (rendered `aria-disabled` + reason text, not `disabled`).
- i18n: Conduit has no i18n layer (v1 §10 decision stands): strings centralised per component
  module, counts through the existing plural helper, ISO-8601 UTC timestamps, layouts tolerate +30%
  text, toolbar labels never truncate meaning (icon + tooltip when narrow). RTL: not supported
  app-wide; diagram direction comes from the fence regardless.

## 11. Design tokens (UI)

Reuse existing tokens; no raw hex. Roles: canvas surface/grid, node surface/border/selected,
edge stroke/selected, frame surface, pin (accent-on-surface), changed-marker, workspace scrim,
toolbar (the floating-chrome family over Monaco/xyflow — must clear xyflow/Monaco stacking via
`--layer-*`). Verified in Neon, Aero and the third theme, plus forced colours.

## 12. Assumptions

- Diagram key by flowchart ordinal + the 50 % id-overlap guard is good enough; reorders degrade to
  computed layout.
- `ModalLayer`, `mermaid-export`, and xyflow 12's own viewport API, `onReconnect`, `MiniMap` and
  `NodeToolbar` cover the workspace and toolbar without new dependencies (planner verifies).
- The ask brief and Send preamble are enough for Codex/Gemini/Aider to follow; Send's
  bracketed-paste gate and Copy fallback are unchanged.

## 13. Decisions Needed (locked defaults, unattended run)

- [high] **Positions are persisted** (v1 deliberately never stored them). Default: a separate
  `.layout.json` sidecar so the fence stays plain Mermaid any agent can write. Reversible: delete
  the sidecar.
- [normal] Agent-agnostic onboarding by **pasted brief**, not by writing AGENTS.md/GEMINI.md into
  the user's repo. Default: paste; files in the user's repo stay untouched.
- [normal] Disjoint-block auto-merge deferred to v1 (should): write-through makes the conflict
  window ~300 ms and v1's banner covers it.
- [normal] Export stays the Mermaid render (not the user's arrangement); labelled as such.
- [normal] Arbitrary HTML artifacts are out of scope (security surface; ADR 0005 covers .html files).
- [normal] Whether Codex/Gemini/Aider enable bracketed paste is unmeasured — Copy fallback covers it.
- [normal] `ASSUMED` source rows in §2.1 are re-measured by the builder before the slice that fixes
  them.

## 14. Open questions

None blocking — all resolved as §13 defaults.
