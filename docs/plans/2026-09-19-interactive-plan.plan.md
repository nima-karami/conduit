# Interactive plan documents — implementation plan

**Spec:** `docs/specs/2026-09-19-interactive-plan.md`  **Tier:** FULL

## Goal

A `.md` under `<root>/.conduit/plans/` opens as a fully editable document whose `ts` fences are inline
Monaco, whose `mermaid` flowcharts are a structural node/edge editor, whose every block is
commentable, and whose human edits and comments go back to the agent in one paste.

## Architecture

Host owns the files (read, atomic write, watch, self-echo, comment-patch validation), the same shape
as review notes. Renderer owns the editing session: Milkdown holds the document, a store mirrors the
on-disk markdown, the baseline hashes and the comments. Every rule lives in pure `src/` modules
(blocks and hashing, byte-preserving splice, comment patch and re-anchor, Mermaid flowchart
parse/serialise and reducers, two-level layout, handoff text) so it is node-testable. Routing follows
the HTML-viewer precedent: no new `DocKind`, `DocBody` branches on path.

## Data flow

```
agent (terminal)                  host (electron/)                          renderer (webview/)
writes .conduit/plans/x.md ─fs─▶ PlanWatcher (.conduit/plans, 250 ms, isSelfEcho)
                                  │ plan:doc {origin:'external'}
                                  ▼                                        plan-store ─▶ toast "Agent updated plan x" [Open]
                                                                           PlanView (doc tab kind 'file', isPlanDocPath)
                                                                             Milkdown ─ node views: PlanCodeBlock (Monaco), PlanFlowBlock (xyflow)
                                                                             comments panel · action bar (Send · Source · Next change)
                                                                                    │ transaction → node-identity diff → spliceBody
                                                                                    │ debounce 300 ms
 ◀─fs─ writeAtomic ◀── plan:write ◀────────────────────────────────────────────────┘  (paused while conflict ≠ null)
        recordWrite(contentHash(markdown))  → plan:doc {origin:'write-ack'}
 ◀─fs─ writeAtomic ◀── plan:setComments {patch} (host applies applyPlanCommentPatch, broadcasts plan:doc)
 ◀─paste─ pasteToTerminal(doc.sessionId, buildPlanHandoff(…)) ◀── Send; then plan:setComments {type:'sent'}
```

## Settled decisions — do not re-litigate

- Plain Markdown at `.conduit/plans/<slug>.md` is the source of truth; no custom markup; frontmatter optional.
- Comments live in `.conduit/plans/<slug>.comments.json`, ADR 0002 envelope, kind `plan-comments`.
- Block identity is `{index, hash, snippet}`; no ids in the file.
- Unedited blocks are byte-preserved by splicing on ProseMirror node identity; the whole doc is never re-stringified.
- Diagram positions are never written; layout is computed per render with `computeLayout` from `src/arch-layout.ts`, two-level for subgraphs. elkjs is not added.
- Per-block TS diagnostics via the worker's diagnostic calls and `setModelMarkers`; the global `noSemanticValidation` flags stay as they are.
- Conflict policy: external change while an edit is pending pauses write-through and asks; never merges.
- Baseline: `blockHashes` set on Send; an external write adds the hashes it introduced (`next − prev`) so agent changes are never sent back.
- Handoff is a bracketed paste with no trailing newline into `doc.sessionId`'s terminal; Copy fallback when not live.
- Open-plan notification is a toast with an Open action, not a banner component.
- No new `DocKind`; `PlanView` gets `doc.sessionId` like `ReviewView`.
- `conduit-plan` skill is deprecated in place (description + version), not deleted.
- Edge identity in a flowchart is the array index; comment re-anchor similarity is Dice on bigrams ≥ 0.6.
- Desktop only: no touch targets. English-only strings in components, ISO-8601 UTC timestamps, `Intl.DateTimeFormat` for display.

## Spec staleness

- Spec §2 assumed inline Monaco gets diagnostics from the existing worker. Measured: `webview/monaco-setup.ts:17-24` sets `noSemanticValidation: true, noSyntaxValidation: true` on both defaults. Plan: Task 5.1 attaches per-model diagnostics instead.
- Spec §12 assumed elkjs in a worker. Measured: `src/arch-layout.ts:20-24` already exports a deterministic layered `computeLayout(nodes, edges, {xGap, yGap})` (sources left, sinks right). Plan: Task 2.2 builds on it; no elkjs.
- Spec §12 assumed `@milkdown/react` hosts node views. Measured (GitHub `packages/integrations/react/src`, 2026-09-19): it exports only `Milkdown`, `MilkdownProvider`, `useEditor`, `useInstance`; node views come from `@prosemirror-adapter/react` 0.5.5 (`ProsemirrorAdapterProvider`, `useNodeViewFactory`, `useNodeViewContext`). Plan: Task 4.1 spikes exactly that pairing.

## Global constraints

- Gate: `npm run verify` (`biome check .` → `tsc` on both tsconfigs → `node esbuild.mjs` → `vitest run` → `fallow --skip health` → audit → security). Exit codes captured directly, never through a pipe.
- Node 24.18, React 19.2.8, `@xyflow/react` 12.11, `monaco-editor` 0.55, `mermaid` 11.15. New deps pinned by caret in `package.json` and installed once (Task 4.1): `@milkdown/kit@7.22.1`, `@milkdown/react@7.22.1`, `@prosemirror-adapter/react@0.5.5`, `unified@11`, `remark-parse@11` (already present transitively; listed so `fallow` sees them).
- Tests: `test/unit/<module>.test.ts` (`.ts` only, `vitest.config.ts:5`), node env by default, `// @vitest-environment jsdom` on line 1 for DOM tests. e2e: drop `test/e2e/<name>.e2e.mjs`; run one with `node test/e2e/run-smoke.mjs <name>`; app launches hidden; never fan out.
- Styles: one file, `webview/styles.css`. BEM `block__elem--mod`, one block per component (`plan__…`, `planflow__…`, `plancomment__…`). Any new hover/press/selected treatment goes into the `:where()` role lists at the **foot** of the sheet (`quiet` / `field` / `solid`, `webview/styles.css:11520-11803`), never as a component-local hover rule. Colours only through tokens (`--bg`, `--panel`, `--raise`, `--text`, `--border-2`, `--accent`, `--danger`, `--warn` family as already used in the sheet).
- `.conduit/` is excluded from the fs firehose (`src/watch-filter.ts:42-45`); plan changes reach the renderer only through `plan:doc`.
- Comments explain *why* only (CLAUDE.md). Pure modules never import Electron or DOM. Renderer guards `window.agentDeck` absence via `webview/bridge.ts`.
- Commit per slice on branch `feat/interactive-plan`, message `feat(plan): …` / `test(plan): …`, ending with the attribution line from the session.

## Out of scope

Anything in spec §1 Non-goals and §6 Out of scope. No changes to `markdown-viewer.tsx`, `architecture-view.tsx`, the board, or review notes. No inline prose editing of files outside `.conduit/plans/`. No agent-reply rendering in threads beyond listing agent-authored comments (v1).

## Contracts

```ts
// src/plan-path.ts
export const PLANS_DIR = '.conduit/plans';
export const PLAN_SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
export function isPlanDocPath(path: string): boolean;          // …/.conduit/plans/<slug>.md, '/' or '\' separators, case-insensitive on the dir names
export function planSlugFromPath(path: string): string | null; // null when not a plan path or slug fails PLAN_SLUG_RE
export function planRootFromPath(path: string): string | null; // the project root = everything before `/.conduit/plans/`, original separators kept

// src/plan-blocks.ts
export type PlanBlockKind = 'prose' | 'code' | 'diagram';
export interface PlanBlock { index: number; kind: PlanBlockKind; lang: string | null; start: number; end: number; source: string; hash: string; snippet: string }
export interface PlanSplit { frontmatter: string; body: string; blocks: PlanBlock[] }
export const SNIPPET_CHARS = 60;
export function normalizeBlockSource(s: string): string;        // CRLF→LF, trim
export function splitPlan(markdown: string): PlanSplit;          // unified().use(remarkParse).use(remarkGfm).use(remarkFrontmatter); frontmatter = yaml node bytes + following newline(s); blocks = remaining top-level nodes; kind 'diagram' iff lang === 'mermaid', 'code' iff any other fenced/indented code, else 'prose'; hash = contentHash(normalizeBlockSource(source)); snippet = first non-empty line, ≤ SNIPPET_CHARS
export function composePlan(frontmatter: string, body: string): string;   // frontmatter + body, body ends with exactly one '\n'

// src/plan-splice.ts
export type SpliceItem = { kind: 'keep'; oldIndex: number } | { kind: 'new'; source: string };
export function spliceBody(oldBody: string, oldBlocks: readonly PlanBlock[], items: readonly SpliceItem[]): string;
  // keep → oldBody.slice(start,end); between two keeps whose oldIndex are consecutive → the old gap bytes; every other join → '\n\n'; new sources have trailing newlines trimmed; result ends with one '\n'; empty items → ''
export function keepMap(prev: readonly object[], next: readonly object[]): (number | null)[];   // LCS by reference equality; next[i] → index in prev, or null when new

// src/plan-comments.ts
export interface PlanAnchor { index: number; hash: string; snippet: string }
export interface PlanComment { id: string; author: 'human' | 'agent'; text: string; anchor: PlanAnchor; status: 'open' | 'resolved'; createdAt: string; replyTo?: string; sentAt?: string }
export interface PlanBaseline { at: string; blockHashes: string[] }
export interface PlanCommentsData { version: 1; baseline?: PlanBaseline; comments: PlanComment[] }
export const MAX_COMMENT_TEXT = 4096;
export const MAX_COMMENTS = 2000;
export type PlanCommentPatch =
  | { type: 'add'; comment: PlanComment } | { type: 'edit'; id: string; text: string }
  | { type: 'resolve'; id: string; resolved: boolean } | { type: 'delete'; id: string }
  | { type: 'reattach'; id: string; anchor: PlanAnchor }
  | { type: 'sent'; ids: string[]; baseline: PlanBaseline };
export function newCommentId(now: number): string;                // `c${now.toString(36)}${4 random base36}`
export function isPlanComment(x: unknown): x is PlanComment;
export function applyPlanCommentPatch(d: PlanCommentsData, p: PlanCommentPatch): PlanCommentsData;  // refusal (unknown id, text > MAX, count ≥ MAX_COMMENTS on add, resolve of resolved) returns d itself
export function mergeComments(local: PlanCommentsData, disk: PlanCommentsData): PlanCommentsData;   // union by id; for ids in both, disk's status/text/replyTo/sentAt win; ordering = disk order then local-only; baseline = local.baseline ?? disk.baseline
export interface AnchoredComment { comment: PlanComment; index: number | null }
export function diceSimilarity(a: string, b: string): number;     // bigram Dice on normalizeBlockSource, 0..1; equal strings → 1
export function reanchorComments(comments: readonly PlanComment[], blocks: readonly PlanBlock[]): AnchoredComment[];
  // 1) block with hash === anchor.hash (lowest index) 2) blocks[anchor.index] if dice ≥ 0.6 3) nearest index within ±2 with dice ≥ 0.6, lower wins ties 4) null
export function serializePlanComments(d: PlanCommentsData): string;      // wrap('plan-comments', d, Date.now()) from src/conduit-store.ts, 2-space JSON + '\n'
export function restorePlanComments(text: string | undefined): PlanCommentsData;  // unwrapPayload; invalid/absent → { version: 1, comments: [] }; drops entries failing isPlanComment
export function commentsFingerprint(d: PlanCommentsData): string;        // JSON of { baseline, comments }

// src/plan-baseline.ts
export function advanceBaseline(b: PlanBaseline | undefined, prevDiskHashes: readonly string[], nextDiskHashes: readonly string[], at: string): PlanBaseline;
  // { at, blockHashes: dedupe([...(b?.blockHashes ?? []), ...next.filter(h => !prev.includes(h))]) }
export function humanChanged(blocks: readonly PlanBlock[], b: PlanBaseline | undefined): PlanBlock[];   // b undefined → []; else blocks whose hash ∉ b.blockHashes
export function removedSinceBaseline(blocks: readonly PlanBlock[], b: PlanBaseline | undefined): number; // baseline hashes absent from blocks

// src/mermaid-flow.ts
export type FlowDirection = 'TB' | 'TD' | 'BT' | 'LR' | 'RL';
export type FlowShape = 'rect' | 'round' | 'stadium' | 'subroutine' | 'diamond' | 'circle';   // [ ] ( ) ([ ]) [[ ]] { } (( ))
export type FlowEdgeKind = 'arrow' | 'open' | 'dotted' | 'thick' | 'bidir';                   // --> --- -.-> ==> <-->
export interface FlowNode { id: string; label: string; shape: FlowShape; parent: string | null }
export interface FlowEdge { source: string; target: string; kind: FlowEdgeKind; label: string | null }
export interface FlowSubgraph { id: string; title: string; parent: string | null }
export interface FlowGraph { keyword: 'flowchart' | 'graph'; direction: FlowDirection; nodes: FlowNode[]; edges: FlowEdge[]; subgraphs: FlowSubgraph[]; trailer: string[] }
export type FlowParse = { ok: true; graph: FlowGraph } | { ok: false; reason: string; line: number };
export function parseFlowchart(source: string): FlowParse;
  // accepts: header `flowchart|graph <dir>`; `%%` comments (dropped); `id`, `id[label]`, `id(label)`, `id([label])`, `id[[label]]`, `id{label}`, `id((label))`, quoted labels "…"; chains `a --> b --> c`; edge forms above with `|label|` after the arrow or `-- label -->`; `subgraph id [title]` / `subgraph id` / `subgraph "title"` (id = slug of title) … `end`, nested; trailer lines starting with classDef|class|style|click|linkStyle kept verbatim; `&` fan-out, `:::class`, `~~~`, `-->|a|b` without spaces, and any other line → { ok: false, reason, line }
export function serializeFlowchart(g: FlowGraph): string;
  // `${keyword} ${direction}\n` + subgraphs depth-first (`subgraph id [title]` … members as node lines indented 2 per depth … `end`) + loose nodes + edges (`a -->|label| b`, kinds mapped back) + trailer; node line = `id` when label === id && shape === 'rect', else `id[…]` per shape; labels quoted when they contain any of []{}()"|;
export function addNode(g: FlowGraph, id: string, label: string, shape?: FlowShape, parent?: string | null): FlowGraph;
export function removeNode(g: FlowGraph, id: string): FlowGraph;
export function renameNode(g: FlowGraph, id: string, label: string): FlowGraph;
export function addEdge(g: FlowGraph, source: string, target: string, kind?: FlowEdgeKind): FlowGraph;
export function removeEdge(g: FlowGraph, edgeIndex: number): FlowGraph;
export function relabelEdge(g: FlowGraph, edgeIndex: number, label: string | null): FlowGraph;
export function addSubgraph(g: FlowGraph, id: string, title: string, parent?: string | null): FlowGraph;
export function moveToSubgraph(g: FlowGraph, nodeId: string, subgraphId: string | null): FlowGraph;
export function nextNodeId(g: FlowGraph, base: string): string;   // base, base2, base3… avoiding node and subgraph ids
  // all reducers: invalid input (unknown id, duplicate id, duplicate (source,target), cycle in subgraph parents) returns g unchanged (same reference)
  // invariant: parseFlowchart(serializeFlowchart(g)) deep-equals g for any g produced by parse or reducers

// src/flow-layout.ts
export interface FlowRegion { x: number; y: number; w: number; h: number }
export interface FlowLayout { positions: Record<string, XY>; regions: Record<string, FlowRegion> }
export const FLOW_PAD = 24; export const FLOW_XGAP = 220; export const FLOW_YGAP = 90;
export function layoutFlow(g: FlowGraph, size: (n: FlowNode) => { w: number; h: number }): FlowLayout;
  // bottom-up: for each subgraph, computeLayout over its direct members (nodes + child subgraphs as nodes sized by their own region) with edges restricted to members; region = bbox + FLOW_PAD; top level likewise; then offset children into parents; TB/TD/BT swap x/y of computeLayout output (it lays out left→right); BT/RL mirror the layer axis

// src/plan-handoff.ts
export interface PlanHandoffInput { planPath: string; changed: readonly PlanBlock[]; removed: number; comments: readonly AnchoredComment[]; blocks: readonly PlanBlock[] }
export function buildPlanHandoff(i: PlanHandoffInput): string;
  // exact shape of spec §3: header line, `Changed blocks (n):` with one `- <kind> <snippet>:` line followed by the block source fenced verbatim (code/diagram) or the paragraph text (prose), `Removed blocks: n` when n > 0, `Open comments (m):` with `- <snippet>: "<text>"` (detached → `- (detached) <anchor.snippet>: …`), closing instruction; no trailing newline; only comments with status 'open' and no sentAt

// electron/conduit-fs.ts (additions)
export const PLANS_DIR_NAME = 'plans';
export function planPath(root: string, slug: string): string;              // throws Error('invalid plan slug') on PLAN_SLUG_RE miss
export function planCommentsPath(root: string, slug: string): string;
export const MAX_PLAN_BYTES = 2 * 1024 * 1024;
export async function readPlan(root: string, slug: string): Promise<{ markdown: string | undefined; comments: PlanCommentsData }>;
  // missing file → markdown undefined; size > MAX_PLAN_BYTES or invalid UTF-8 (decode with { fatal: true }) → throws Error('plan unreadable: <reason>') which the host maps to plan:error op 'load'
export async function writePlanFile(root: string, slug: string, markdown: string): Promise<void>;
export async function writePlanCommentsFile(root: string, slug: string, data: PlanCommentsData): Promise<void>;

// electron/conduit-dir-watch.ts (change)
start(projectRoot: string, onEvent: OnDirEvent, onSettle: () => void, opts?: { subdir?: string }): void;   // watches join(conduitDir(root), subdir ?? '')

// electron/plan-watcher.ts
export type OnPlanChange = (slug: string, markdown: string | undefined, comments: PlanCommentsData) => void;
export class PlanWatcher {
  constructor(debounceMs = 250);
  watch(projectRoot: string, onChange: OnPlanChange): void;   // if <root>/.conduit/plans is absent, setInterval 2000 ms until it exists, then arm; replaces any prior watch
  recordWrite(slug: string, file: 'plan' | 'comments', fingerprint: string): void;
  stop(): void;
}
  // settle: for each touched slug (from filename `<slug>.md` | `<slug>.comments.json`; null filename → all slugs present), readPlan; skip when markdown fingerprint (contentHash) and comments fingerprint both equal the recorded self-writes

// src/protocol.ts (additions; re-export PlanComment, PlanCommentPatch, PlanCommentsData)
| { type: 'plan:load'; root: string; slug: string }
| { type: 'plan:write'; root: string; slug: string; markdown: string }
| { type: 'plan:setComments'; root: string; slug: string; patch: PlanCommentPatch }
| { type: 'plan:doc'; root: string; slug: string; markdown: string | null; comments: PlanCommentsData; origin: 'load' | 'external' | 'write-ack' }
| { type: 'plan:error'; root: string; slug: string; op: 'load' | 'write' | 'comments'; message: string }

// webview/plan-store.ts
export interface PlanDocState { root: string; slug: string; status: 'loading' | 'ready' | 'not-found' | 'error'; error?: string; disk: string | null; comments: PlanCommentsData; pendingWrite: boolean; readOnly: boolean; saveError: string | null; commentsError: string | null; conflict: { theirs: string } | null; agentChanged: ReadonlySet<string> }
  // plan:error op 'write' whose message contains EACCES or EPERM → readOnly = true; any other write error → saveError; op 'comments' → commentsError; both cleared by the next write-ack
export function planKey(root: string, slug: string): string;      // `${root}::${slug}`
export function subscribePlans(cb: () => void): () => void;
export function getPlanState(root: string, slug: string): PlanDocState | undefined;
export function loadPlan(root: string, slug: string): void;
export function writePlan(root: string, slug: string, markdown: string): void;
export function patchPlanComments(root: string, slug: string, patch: PlanCommentPatch): void;
export function resolveConflict(root: string, slug: string, choice: 'theirs' | 'mine', mine: string): void;
export function markViewed(root: string, slug: string, hash: string): void;
export function planExternalChanges(): { subscribe: (cb: (root: string, slug: string) => void) => () => void };  // for the toast
  // on plan:doc origin 'external': if state.pendingWrite → conflict = { theirs: markdown }, disk unchanged; else disk = markdown, agentChanged = hashes(new) − hashes(old), comments = mergeComments(local, incoming) with baseline = advanceBaseline(...)

// webview/plan-diagnostics.ts
export function blockModelUri(root: string, slug: string, nonce: string, lang: 'ts' | 'tsx'): monaco.Uri;   // fileUri(`${root}/.conduit/plans/.blocks/${slug}.${nonce}.${lang}`)
export interface WorkerDiagnostic { start?: number; length?: number; messageText: string | { messageText: string }; category: number; code: number }
export function toMarkers(model: monaco.editor.ITextModel, diags: readonly WorkerDiagnostic[]): monaco.editor.IMarkerData[];  // category 1 → Error, 0 → Warning, else Info; offsets → 1-based line/column via model.getPositionAt
export function attachBlockDiagnostics(model: monaco.editor.ITextModel): () => void;
  // on content change, debounced 300 ms: const get = await monaco.languages.typescript.getTypeScriptWorker(); const w = await get(model.uri); [syntactic, semantic] → toMarkers → monaco.editor.setModelMarkers(model, 'plan-ts', markers); returns disposer that clears markers

// webview/plan-menu.ts
export function planBlockMenu(a: { onComment: () => void; onCopy: () => void }): MenuItem[];
export function flowNodeMenu(a: { onRename; onConnect; onMoveTo; onDelete }): MenuItem[];   // order: Rename, Connect to…, Move to subgraph…, Delete (danger)
export function flowEdgeMenu(a: { onRelabel; onDelete }): MenuItem[];
export function flowPaneMenu(a: { onAddNode; onAddSubgraph; onFit; onEditAsText }): MenuItem[];
export function commentMenu(a: { onReply; onResolve; onReattach: (() => void) | null; onDelete }): MenuItem[];

// components (webview/components/)
PlanView          { doc: OpenDoc; root: string; sessionId?: string; sessionLabel?: string }
PlanEditor        { body: string; blocks: readonly PlanBlock[]; readOnly: boolean; onBody(next: string): void; onBlockFocus(index: number | null): void; agentChanged: ReadonlySet<string> }
PlanCodeBlock     node view (Milkdown code_block, lang ≠ 'mermaid'): reads node.attrs.language + textContent; writes via setAttrs/tr.insertText; stopEvent → true for events inside the Monaco DOM; ignoreMutation → true
PlanFlowBlock     node view (code_block, lang === 'mermaid'): parseFlowchart → <FlowEditor> or fallback <MermaidDiagram source> + "Edit as text" (Monaco)
FlowEditor        { graph: FlowGraph; onGraph(g: FlowGraph): void; readOnly: boolean }   // ReactFlow, nodeTypes { flowNode, flowRegion }, edges typed 'flowEdge'; layoutFlow on each graph change; drag = session-only
PlanCommentsPanel { anchored: readonly AnchoredComment[]; blocks: readonly PlanBlock[]; disabled: boolean; onAdd(index, text); onEdit(id, text); onResolve(id, resolved); onDelete(id); onReattach(id, index); onJump(index) }
PlanActionBar     { pending: number; live: boolean; sendBlockedReason: string | null; saveState: 'saved' | 'saving' | 'failed' | 'readonly'; source: boolean; nextCount: number; onSend; onToggleSource; onNextChange; onRetrySave }
                  // sendBlockedReason non-null ("Save failed" / "A comment is unsaved") disables Send with the reason in aria-describedby and the title
```

## Producer/consumer map

| Behavior changed | Produced by | Consumed by | Sides this plan touches |
|---|---|---|---|
| `.conduit/plans/<slug>.md` bytes | agent (skill, Task 7.1); `writePlanFile` via `plan:write` (Tasks 3.1, 3.4) | `PlanWatcher` → `plan:doc` (3.3, 3.4); agent next turn | both |
| `.conduit/plans/<slug>.comments.json` | `plan:setComments` host handler (3.4); agent replies (7.1 tells it how) | plan-store (4.2); agent | both |
| `plan:doc` / `plan:error` messages | `electron/main.ts` handlers (3.4) | `webview/plan-store.ts` (4.2) | both |
| Handoff paste | `PlanView` Send (6.3) via `pasteToTerminal` (`webview/terminal-bus.ts:110`, unchanged) | agent through the session terminal | producer only: `pasteToTerminal` is measured unchanged; the consumer is the agent, instructed by the skill (7.1) |
| Open-plan toast | plan-store external event (4.2) | `pushToast` (`webview/toast-store.ts:52`, unchanged) | producer only: toast store API measured unchanged |
| Doc routing | `DocBody` branch (4.3) | `PlanView` | both |
| TS diagnostics on block models | TS worker (unchanged) via `attachBlockDiagnostics` (5.1) | block Monaco markers | consumer only: worker API `getSyntacticDiagnostics`/`getSemanticDiagnostics` is stock `monaco-editor` 0.55 |
| `ConduitDirWatch.start` signature | Task 3.2 | `NotesWatcher` (`electron/notes-watcher.ts:34`), `BoardWatcher` (`electron/board-watcher.ts:31`), `ProposalWatcher` (`electron/proposal-watcher.ts:35`) | both: existing callers pass no `opts`, behaviour unchanged; Task 3.2 runs their tests |
| Skill text | 7.1 | agent | producer only: the agent is the consumer |

## File map

| Path | Action | Responsibility |
|---|---|---|
| `src/plan-path.ts` | create | plan path predicate and slug extraction |
| `src/plan-blocks.ts` | create | markdown → frontmatter + top-level blocks with hashes |
| `src/plan-splice.ts` | create | byte-preserving body rebuild from keep/new items |
| `src/plan-comments.ts` | create | comment model, patch, merge, re-anchor, envelope |
| `src/conduit-store.ts` | modify | `'plan-comments'` added to `ConduitKind` |
| `src/plan-baseline.ts` | create | baseline advance and human-changed diff |
| `src/mermaid-flow.ts` | create | flowchart subset parser, serialiser, reducers |
| `src/flow-layout.ts` | create | two-level layout over `computeLayout` |
| `src/plan-handoff.ts` | create | handoff paste text |
| `src/protocol.ts` | modify | five `plan:*` messages + type re-exports |
| `electron/conduit-fs.ts` | modify | plan file paths, read, atomic writes |
| `electron/conduit-dir-watch.ts` | modify | optional `subdir` |
| `electron/plan-watcher.ts` | create | per-project watcher for `.conduit/plans` with self-echo |
| `electron/main.ts` | modify | `plan:load` / `plan:write` / `plan:setComments` handlers, watcher arm/teardown |
| `webview/plan-store.ts` | create | renderer mirror, conflict, baseline, agentChanged, external-event fan-out |
| `webview/plan-diagnostics.ts` | create | per-model TS markers |
| `webview/plan-menu.ts` | create | menu item builders for block, flow node/edge/pane, comment |
| `webview/components/plan-view.tsx` | create | document tab: store binding, editor, panel, bar, conflict/not-found/readonly states, toast wiring |
| `webview/components/plan-editor.tsx` | create | Milkdown mount, node-view factories, identity-diff splice |
| `webview/components/plan-code-block.tsx` | create | Monaco node view |
| `webview/components/plan-flow-block.tsx` | create | flowchart node view + unsupported fallback |
| `webview/components/flow-editor.tsx` | create | xyflow structural editor, menus, keyboard |
| `webview/components/plan-comments-panel.tsx` | create | threads, composer, detached group, re-attach picker |
| `webview/components/plan-action-bar.tsx` | create | Send/Copy, Source, Next change, save state |
| `webview/components/doc-view.tsx` | modify | `isPlanDocPath` branch before markdown |
| `webview/app.tsx` | modify | mount the external-change toast subscription once |
| `webview/styles.css` | modify | `plan__*`, `planflow__*`, `plancomment__*` blocks; role-list entries at the foot |
| `package.json`, `package-lock.json` | modify | new deps |
| `resources/skills/conduit-interactive-plan/SKILL.md` | create | agent instructions |
| `resources/skills/conduit-plan/SKILL.md`, `.claude/skills/conduit-plan/SKILL.md` | modify | deprecation line, version 1.1.0 |
| `CHANGELOG.md` | modify | user-facing entry |
| `docs/specs/INDEX.md`, `docs/specs/archive/2026-09-19-interactive-plan.md` | modify / move | archive on ship |
| `test/unit/skills.test.ts` | modify | bundled-skill and deprecation assertion |
| `test/unit/plan-path.test.ts`, `plan-blocks.test.ts`, `plan-splice.test.ts`, `plan-comments.test.ts`, `plan-baseline.test.ts`, `mermaid-flow.test.ts`, `flow-layout.test.ts`, `plan-handoff.test.ts`, `plan-fs.test.ts`, `plan-watcher.test.ts`, `plan-store.test.ts`, `plan-menu.test.ts`, `plan-diagnostics.test.ts` | create | unit suites |
| `test/e2e/plan-editor.e2e.mjs`, `test/e2e/plan-blocks.e2e.mjs`, `test/e2e/plan-handoff.e2e.mjs` | create | smoke scenarios |
| `test/e2e/fixtures/plan/identity.md` | create | fixture plan with prose, a `ts` fence, a flowchart with one subgraph |

## Scripts

None. No edit repeats across more than two files; fixtures are one hand-written markdown file.

## Slices

### Slice 1: Pure plan seams

**Check:** `npx vitest run test/unit/plan-path.test.ts test/unit/plan-blocks.test.ts test/unit/plan-splice.test.ts test/unit/plan-comments.test.ts test/unit/plan-baseline.test.ts test/unit/plan-handoff.test.ts` green, and `npm run typecheck`.

**Parallel groups:** G1: T1.1, T1.2 · G2: T1.4 · Serial: T1.3 (needs 1.2), T1.5 (needs 1.2 + 1.4), T1.6
**Claims (serial lane):** `package.json`, `package-lock.json` (T1.6 lists `unified`, `remark-parse`; T4.1 adds the rest later)

#### Task 1.1: plan-path

**Files:** Create `src/plan-path.ts`; Test `test/unit/plan-path.test.ts`
**Interfaces:** Produces `PLANS_DIR`, `PLAN_SLUG_RE`, `isPlanDocPath(path: string): boolean`, `planSlugFromPath(path: string): string | null`, `planRootFromPath(path: string): string | null` as in Contracts.
**Steps:**
- [ ] Failing tests: 'accepts posix and win32 plan paths' (`isPlanDocPath('G:\\p\\.conduit\\plans\\a-b.md') === true`), 'rejects .conduit/plan.json and nested dirs' (`isPlanDocPath('/p/.conduit/plans/x/y.md') === false`), 'slug of a bad name is null' (`planSlugFromPath('/p/.conduit/plans/bad slug.md') === null`), 'root keeps the original separators' (`planRootFromPath('G:\\p\\q\\.conduit\\plans\\a.md') === 'G:\\p\\q'`)
- [ ] Run the test — FAIL (module missing) — implement.

#### Task 1.2: plan-blocks

**Files:** Create `src/plan-blocks.ts`; Test `test/unit/plan-blocks.test.ts` (`unified` and `remark-parse` are already installed transitively by `react-markdown`; T1.6 lists them)
**Interfaces:** Produces `PlanBlockKind`, `PlanBlock`, `PlanSplit`, `SNIPPET_CHARS`, `normalizeBlockSource`, `splitPlan`, `composePlan` as in Contracts. Consumes `contentHash(text: string): string` from `src/review-marks.ts:49`.
**Steps:**
- [ ] Failing tests: 'frontmatter is split off verbatim and is not a block' (input starts `---\ntitle: x\n---\n\n# H\n`; `frontmatter === '---\ntitle: x\n---\n\n'`, `blocks[0].kind === 'prose'`), 'fences classify by lang' (`ts` → code with lang 'ts'; `mermaid` → diagram), 'offsets slice back to source' (`body.slice(b.start, b.end) === b.source` for every block), 'hash ignores CRLF and outer whitespace', 'snippet is the first non-empty line capped at 60', 'composePlan ends with exactly one newline'
- [ ] Run — FAIL — implement with `unified().use(remarkParse).use(remarkGfm).use(remarkFrontmatter, ['yaml'])`, reading `node.position.start.offset`/`end.offset`.

#### Task 1.3: plan-splice

**Files:** Create `src/plan-splice.ts`; Test `test/unit/plan-splice.test.ts`
**Interfaces:** Produces `SpliceItem`, `spliceBody(oldBody, oldBlocks, items): string`. Consumes `PlanBlock { start; end; source }` and `splitPlan` from Task 1.2.
**Steps:**
- [ ] Failing tests: 'all-keep reproduces the body byte for byte' (three blocks with a 3-newline gap between blocks 1 and 2), 'replacing the middle block keeps the outer bytes and old gaps' (a paragraph with `*em*` untouched stays `*em*`), 'inserting between kept blocks joins with one blank line', 'deleting a block drops its gap', 'new source with trailing newlines is trimmed', 'empty items yields empty string'
- [ ] Run — FAIL — implement.

#### Task 1.4: plan-comments + plan-baseline

**Files:** Create `src/plan-comments.ts`, `src/plan-baseline.ts`; Modify `src/conduit-store.ts` (`ConduitKind`, `:27-34`); Test `test/unit/plan-comments.test.ts`, `test/unit/plan-baseline.test.ts`
**Interfaces:** Produces everything under `src/plan-comments.ts` and `src/plan-baseline.ts` in Contracts. Consumes `wrap(kind, data, updatedAt)` and `unwrapPayload(text)` from `src/conduit-store.ts:51,99`, `contentHash` from `src/review-marks.ts:49`, `PlanBlock` and `normalizeBlockSource` from Task 1.2. Add `'plan-comments'` to `ConduitKind` in `src/conduit-store.ts:27-34`.
**Steps:**
- [ ] Failing tests (comments): 'add then resolve then delete round-trips through applyPlanCommentPatch', 'refusals return the same object' (`applyPlanCommentPatch(d, {type:'edit', id:'nope', text:'x'}) === d`; text of 4097 chars refused), 'sent stamps sentAt on the ids and stores the baseline', 'merge keeps local-only ids and takes disk status for shared ids', 'reanchor: exact hash wins over index', 'reanchor: edited block re-anchors by index when dice ≥ 0.6', 'reanchor: rewritten block detaches (index null)', 'restore tolerates a bare payload and drops malformed entries', 'fingerprint ignores envelope updatedAt'
- [ ] Failing tests (baseline): 'advance adds only hashes new on disk', 'humanChanged with no baseline is empty', 'humanChanged lists hashes outside the baseline', 'removedSinceBaseline counts baseline hashes absent now'
- [ ] Run — FAIL — implement.

#### Task 1.5: plan-handoff

**Files:** Create `src/plan-handoff.ts`; Test `test/unit/plan-handoff.test.ts`
**Interfaces:** Produces `PlanHandoffInput`, `buildPlanHandoff(i): string`. Consumes `PlanBlock` (1.2), `AnchoredComment` (1.4), `handoffLabel(pending, live)` from `src/review-handoff.ts:65` (reused as-is for the bar in Slice 6).
**Steps:**
- [ ] Failing tests: 'no trailing newline', 'changed diagram block is fenced verbatim', 'prose block is pasted as text', 'detached comment is labelled (detached)', 'sent and resolved comments are excluded', 'removed count line appears only when > 0'
- [ ] Run — FAIL — implement to the exact §3 shape.

#### Task 1.6: list the markdown deps

**Files:** Modify `package.json` (dependencies: `"unified": "^11.0.0"`, `"remark-parse": "^11.0.0"`), `package-lock.json` (via `npm install`)
**Steps:**
- [ ] Port-style task: `npm run fallow:check` reports no unlisted dependency for `src/plan-blocks.ts` — green is the proof.

### Slice 2: Flowchart seams

**Check:** `npx vitest run test/unit/mermaid-flow.test.ts test/unit/flow-layout.test.ts` green; the round-trip property test passes on the fixture `test/e2e/fixtures/plan/identity.md`'s diagram.

**Parallel groups:** G1: T2.1 · Serial: T2.2 (consumes 2.1)

#### Task 2.1: mermaid-flow

**Files:** Create `src/mermaid-flow.ts`; Test `test/unit/mermaid-flow.test.ts`; Create `test/e2e/fixtures/plan/identity.md` (title frontmatter; a heading and two paragraphs; a `ts` fence `export function createIdentity(input: { email: string }): Promise<{ id: string }>`; a `mermaid` fence `flowchart LR` with `subgraph backend [Backend]` containing `identity[Identity service]` and `txn[Transaction service]`, a loose `web[Web app]`, edges `web --> identity`, `web --> txn`, `txn -->|lookup| identity`)
**Interfaces:** Produces every export of `src/mermaid-flow.ts` in Contracts.
**Steps:**
- [ ] Failing tests: 'parses the fixture diagram into 3 nodes, 1 subgraph, 3 edges with the labelled edge', 'parse → serialize → parse is deep-equal' (fixture plus a nested-subgraph case plus a trailer case), 'serialize is canonical' (exact expected string for the fixture), 'unsupported syntax reports the line' (`a & b --> c` → ok false, line 2), 'removeEdge by index drops exactly that edge', 'removeNode drops incident edges', 'addEdge duplicate is a no-op returning the same reference', 'moveToSubgraph into a descendant is refused', 'nextNodeId skips taken ids', 'labels with brackets are quoted on serialize'
- [ ] Run — FAIL — implement a line-based parser (no mermaid import; pure).

#### Task 2.2: flow-layout

**Files:** Create `src/flow-layout.ts`; Test `test/unit/flow-layout.test.ts`
**Interfaces:** Produces `FlowRegion`, `FlowLayout`, `FLOW_PAD`, `FLOW_XGAP`, `FLOW_YGAP`, `layoutFlow(g, size)`. Consumes `FlowGraph`, `FlowNode` (2.1), `computeLayout(nodes, edges, {xGap, yGap}): Record<string, XY>` and `XY` from `src/arch-layout.ts:20`.
**Steps:**
- [ ] Failing tests: 'every node gets a position and every subgraph a region', 'members lie inside their region with FLOW_PAD margin', 'a nested subgraph lies inside its parent region', 'TB places a source above its sink; LR places it left', 'deterministic for the same graph', 'no two nodes overlap in the fixture'
- [ ] Run — FAIL — implement.

### Slice 3: Host and protocol

**Check:** `npx vitest run test/unit/plan-fs.test.ts test/unit/plan-watcher.test.ts test/unit/notes-watcher.test.ts test/unit/board-watch.test.ts test/unit/proposal-watcher.test.ts` green; `npm run typecheck` green.

**Parallel groups:** G1: T3.1 · G2: T3.2 · Serial: T3.3 (needs 3.1, 3.2), T3.4 (needs 3.3)
**Claims (serial lane):** `src/protocol.ts`, `electron/main.ts`

#### Task 3.1: conduit-fs plan files

**Files:** Modify `electron/conduit-fs.ts` (after the specs section, `:320-375`); Test `test/unit/plan-fs.test.ts`
**Interfaces:** Produces `PLANS_DIR_NAME`, `planPath`, `planCommentsPath`, `readPlan`, `writePlanFile`, `writePlanCommentsFile` as in Contracts. Consumes `writeAtomic(target, text)` (`electron/conduit-fs.ts:226`), `conduitDir(root)` (`:54`), `PLAN_SLUG_RE` (1.1), `serializePlanComments`/`restorePlanComments` (1.4).
**Steps:**
- [ ] Failing tests (temp dir per test, as `test/unit/conduit-fs.test.ts` does): 'planPath rejects a slug with a slash', 'readPlan of a missing plan returns undefined markdown and empty comments', 'writePlanFile creates .conduit/plans and writes atomically (no .tmp left)', 'comments round-trip through the envelope', 'readPlan rejects a file over MAX_PLAN_BYTES and one with invalid UTF-8'
- [ ] Run — FAIL — implement.

#### Task 3.2: dir-watch subdir

**Files:** Modify `electron/conduit-dir-watch.ts` (`start`, `:37-54`); Test: existing `test/unit/notes-watcher.test.ts`, `test/unit/proposal-watcher.test.ts` stay green
**Interfaces:** Produces `start(projectRoot, onEvent, onSettle, opts?: { subdir?: string })`. **Call sites:** `electron/notes-watcher.ts:34`, `electron/board-watcher.ts:31`, `electron/proposal-watcher.ts:35` (none pass `opts`; unchanged).
**Steps:**
- [ ] Port-style task: add the optional parameter, watch `join(conduitDir(root), opts?.subdir ?? '')`; run the three existing watcher suites — green is the proof.

#### Task 3.3: plan-watcher

**Files:** Create `electron/plan-watcher.ts`; Test `test/unit/plan-watcher.test.ts` (copy the promise-with-timeout shape from `test/unit/notes-watcher.test.ts:30`)
**Interfaces:** Produces `OnPlanChange`, `class PlanWatcher { constructor(debounceMs = 250); watch(projectRoot, onChange); recordWrite(slug, file, fingerprint); stop() }`. Consumes `ConduitDirWatch` with `{ subdir: PLANS_DIR_NAME }` (3.2), `readPlan` (3.1), `isSelfEcho(last, current)` from `src/board-watch.ts:26`, `contentHash` (`src/review-marks.ts:49`), `commentsFingerprint` (1.4), `planSlugFromPath` (1.1).
**Steps:**
- [ ] Failing tests: 'an external write to <slug>.md fires onChange with the markdown', 'a write recorded via recordWrite does not fire', 'a comments-file write fires with fresh comments', 'watching before .conduit/plans exists arms once the dir appears' (create dir after `watch`, expect the event within 5 s), 'stop clears the poll interval'
- [ ] Run — FAIL — implement.

#### Task 3.4: protocol + main handlers

**Files:** Modify `src/protocol.ts` (renderer→host union near `:710-714`; host→renderer union near `:402`; re-exports near `:208`), `electron/main.ts` (a `planWatcher` instance beside `notesWatcher` `:1823`; handlers beside `review:loadNotes` `:2396`; teardown beside `:3480`)
**Interfaces:** Produces the five `plan:*` messages as in Contracts. Consumes `PlanWatcher` (3.3), `readPlan`/`writePlanFile`/`writePlanCommentsFile` (3.1), `applyPlanCommentPatch`, `commentsFingerprint` (1.4), `contentHash`.
**Handler rules:** `plan:load` → arm `planWatcher.watch(root, …)` if not armed for this root (one root at a time, as notes) → `readPlan` → `plan:doc {origin:'load', markdown ?? null}`. `plan:write` → `writePlanFile` → `recordWrite(slug,'plan',contentHash(markdown))` → `plan:doc {origin:'write-ack'}`; on throw → `plan:error {op:'write'}`. `plan:setComments` → read current → `applyPlanCommentPatch` → broadcast `plan:doc {origin:'write-ack'}` unconditionally → persist + `recordWrite(slug,'comments',fp)` only when the fingerprint changed. Watcher callback → `plan:doc {origin:'external'}` for the slug.
**Steps:**
- [ ] Typecheck-driven: add the messages, implement handlers, run `npm run typecheck` (both tsconfigs) — green is the proof; the behaviours are covered end to end by the Slice 4 e2e.

### Slice 4: Editor shell — open, edit prose, write through, reload, conflict

**Check:** `node test/e2e/run-smoke.mjs plan-editor` passes: fixture copied to `<tmp project>/.conduit/plans/identity.md` after launch → toast "Agent updated plan identity" appears → Open → `.plan__editor` renders the heading → type into the first paragraph → within 1 s the file on disk differs only in that paragraph (assert the `ts` fence and the diagram fence are byte-identical) → rewrite the file externally while idle → the new text renders and `.plan__changed` marks exactly the changed block → rewrite externally while a keystroke is pending → `.plan__conflict` shows and the file is not overwritten until "Load theirs" is clicked.

**Parallel groups:** Serial: T4.1 → T4.2 → T4.3 → T4.4 → T4.5 (each builds on the previous)
**Claims (serial lane):** `package.json`, `package-lock.json`, `webview/components/doc-view.tsx`, `webview/app.tsx`, `webview/styles.css`

#### Task 4.1: Milkdown spike, kept only if it passes

**Files:** Modify `package.json` (add `@milkdown/kit@^7.22.1`, `@milkdown/react@^7.22.1`, `@prosemirror-adapter/react@^0.5.5`; `npm install`); Create `webview/components/plan-editor.tsx` (minimal: mounts Milkdown with commonmark + gfm + listener + history presets inside `MilkdownProvider` and `ProsemirrorAdapterProvider`, and one `useNodeViewFactory` node view for `code_block` that renders a `<textarea>` placeholder)
**Interfaces:** Produces `PlanEditor { body: string; blocks: readonly PlanBlock[]; readOnly: boolean; onBody(next: string): void; onBlockFocus(index: number | null): void; agentChanged: ReadonlySet<string> }` (props accepted; only `body` used yet).
**Steps:**
- [ ] `npm run build` and `npm run typecheck` green with the packages imported (esbuild bundles ProseMirror; no CSS import beyond Milkdown's none).
- [ ] Manual proof (recorded in the commit message): the editor renders the fixture under React 19 in the running app via a temporary route flag, and the `code_block` node view mounts. If either fails, **stop: deviation rule** — report; the fallback decision (Tiptap or a Monaco-only source editor) is the user's, not the executor's.

#### Task 4.2: plan-store

**Files:** Create `webview/plan-store.ts`; Test `test/unit/plan-store.test.ts` (node env; stub `post`/`subscribe` from `webview/bridge.ts` the way `test/unit/review-notes-store.test.ts` does)
**Interfaces:** Produces everything under `webview/plan-store.ts` in Contracts. Consumes `splitPlan` (1.2), `mergeComments`, `applyPlanCommentPatch`, `PlanCommentsData`, `PlanCommentPatch` (1.4), `advanceBaseline` (1.4), the `plan:*` messages (3.4), `post`/`subscribe` from `webview/bridge.ts`.
**Steps:**
- [ ] Failing tests: 'load posts plan:load once per key', 'plan:doc load fills disk and comments', 'external while clean replaces disk and sets agentChanged to the new hashes', 'external while pendingWrite sets conflict and leaves disk', 'resolveConflict theirs adopts theirs and clears conflict; mine posts plan:write with mine', 'write-ack clears pendingWrite', 'patchPlanComments applies optimistically and posts', 'external comments merge by id and advance the baseline', 'planExternalChanges notifies root+slug on external', 'plan:error write with EPERM sets readOnly; other write errors set saveError; write-ack clears both', 'plan:error comments sets commentsError'
- [ ] Run — FAIL — implement.

#### Task 4.3: PlanView routing and states

**Files:** Create `webview/components/plan-view.tsx`; Modify `webview/components/doc-view.tsx` (`DocBody`, new branch before `file.language === 'markdown'` at `:132`: `const planRoot = planRootFromPath(doc.path); if (planRoot !== null) return <PlanView doc={doc} root={planRoot} sessionId={doc.sessionId} sessionLabel={sessionLabel} />;` where `sessionLabel` is threaded into `DocBody` from `DocView` the way `webview/components/center-pane.tsx:334-335` supplies it to ReviewView), `webview/app.tsx` (subscribe once to `planExternalChanges()` → `pushToast({ message: \`Agent updated plan ${slug}\`, variant: 'info', durationMs: 0, action: { label: 'Open', onClick: () => dispatchDocs({ type:'open', kind:'file', path, sessionId: effectiveSessionId }) } })`, following the open call at `webview/app.tsx:1428`), `webview/styles.css` (`.plan`, `.plan__editor`, `.plan__state`, `.plan__conflict`, `.plan__changed`)
**Interfaces:** Produces `PlanView { doc: OpenDoc; root: string; sessionId?: string; sessionLabel?: string }`. Consumes plan-store (4.2), `PlanEditor` (4.1), `planRootFromPath`/`planSlugFromPath` (1.1), `pushToast` (`webview/toast-store.ts:52`), `dispatchDocs` (`webview/app.tsx:1428`).
**States rendered (spec §8):** loading (skeleton), not-found ("This plan was deleted" + Recreate empty + Close), error/load-failed (reason + Open as text → opens the same path with `mode` forcing CodeViewer), readonly bar, conflict banner (`role="alertdialog"`, Load theirs / Keep mine), populated.
**Steps:**
- [ ] Proof is the Slice 4 e2e steps 1–3 (toast → open → renders). Implement, then run `node test/e2e/run-smoke.mjs plan-editor` — expect FAIL at the "type into paragraph" step (write-through not wired yet).

#### Task 4.4: identity-diff splice and write-through

**Files:** Modify `webview/components/plan-editor.tsx` (listener `updated(ctx, doc, prevDoc)`: compare `doc.child(i)` to `prevDoc.child(j)` by reference with an LCS over the two child arrays → `SpliceItem[]` (`keep oldIndex` for shared nodes, `new source` = `getMarkdown({from,to})` for others) → `onBody(spliceBody(oldBody, blocks, items))`; `replaceAll(body, true)` when `body` prop changes externally and the editor is not focused; the `code_block` node view keeps the 4.1 placeholder), `webview/components/plan-view.tsx` (300 ms debounce → `writePlan`; pause while `conflict`; `saveState`)
**Interfaces:** Consumes `spliceBody` (1.3), `splitPlan` (1.2), `getMarkdown`/`replaceAll` from `@milkdown/kit/utils`, `listenerCtx` from `@milkdown/kit/plugin/listener`, `writePlan` (4.2).
**Steps:**
- [ ] Failing test `test/unit/plan-splice.test.ts` case 'LCS keep map for a middle edit' — add `export function keepMap(prev: readonly object[], next: readonly object[]): (number | null)[]` to `src/plan-splice.ts` (pure LCS by reference) with tests 'middle edit keeps 0 and 2', 'insertion maps kept indices', 'deletion drops the index'. Run — FAIL — implement.
- [ ] Run `node test/e2e/run-smoke.mjs plan-editor` — expect PASS through the "file differs only in that paragraph" step.

#### Task 4.5: external reload and conflict UI

**Files:** Modify `webview/components/plan-view.tsx`, `webview/components/plan-editor.tsx` (`agentChanged` → `data-changed` on the node's DOM via a ProseMirror decoration plugin keyed by block hash), `webview/styles.css` (`.plan__changed` marker: icon + text, colour paired), `test/e2e/plan-editor.e2e.mjs`
**Interfaces:** Consumes `resolveConflict`, `markViewed` (4.2).
**Steps:**
- [ ] Extend the e2e with the reload and conflict steps from the slice check; run — expect FAIL — implement; run — PASS.

### Slice 5: Live blocks

**Check:** `node test/e2e/run-smoke.mjs plan-blocks` passes: open the fixture → the `ts` fence renders `.monaco-editor` inside `.plan__code` → append a parameter in the editor → within 1 s the fence on disk contains it and nothing else changed → the diagram renders `.react-flow` with 3 `.planflow__node` and 1 `.planflow__region` → right-click the `txn --> identity` edge → Delete → the fence on disk no longer contains that line and the other two edges remain → right-click the pane → Add node → a node `n1` appears and the fence gains its line → focus the `web` node and press `Shift+F10` → Connect to… → choose `n1` → the fence gains `web --> n1`. Plus `npx vitest run test/unit/plan-menu.test.ts test/unit/plan-diagnostics.test.ts` green.

**Parallel groups:** G1: T5.1, T5.2 · G2: T5.3, T5.4 · Serial: T5.5
**Claims (serial lane):** `webview/components/plan-editor.tsx`, `webview/styles.css`

#### Task 5.1: per-block diagnostics

**Files:** Create `webview/plan-diagnostics.ts`; Test `test/unit/plan-diagnostics.test.ts` (`// @vitest-environment jsdom`; mock `monaco-editor` the way `test/unit/md-math.test.ts` mocks its heavy import; assert the marker mapping function `toMarkers(diags: ts.Diagnostic-like[]): monaco.editor.IMarkerData[]` which is exported for the test)
**Interfaces:** Produces `blockModelUri`, `attachBlockDiagnostics`, `toMarkers`. Consumes `fileUri(path)` from `webview/project-index.ts:35`.
**Steps:**
- [ ] Failing tests: 'toMarkers maps start/length to 1-based line/column and severity', 'blockModelUri lands under the project root with the lang extension'
- [ ] Run — FAIL — implement.

#### Task 5.2: PlanCodeBlock

**Files:** Create `webview/components/plan-code-block.tsx`
**Interfaces:** Node view for `code_block` with `language !== 'mermaid'`: reads `node.attrs.language` and `node.textContent` from `useNodeViewContext()`; creates a Monaco model at `blockModelUri(root, slug, nonce, lang)` (lang `ts`|`tsx` → attach diagnostics; else syntax only), `monaco.editor.create` with the same option set as `webview/components/code-viewer.tsx:171-202` minus `automaticLayout` (height follows content: `contentHeight` listener), `contextmenu: false`; on model change writes back with `view.dispatch(view.state.tr.replaceWith(pos+1, pos+node.nodeSize-1, schema.text(value)))` debounced 150 ms; disposes editor and model on unmount; theme via `ensureTheme` as `code-viewer.tsx:603-611`. Node-view options: `as: 'div'`, `stopEvent: () => true`, `ignoreMutation: () => true`.
**Steps:**
- [ ] No unit test (DOM + Monaco); proven by the Slice 5 e2e signature step. Implement; keep `webview/components/plan-editor.tsx` untouched (5.5 wires it).

#### Task 5.3: FlowEditor

**Files:** Create `webview/components/flow-editor.tsx`, `webview/plan-menu.ts`; Test `test/unit/plan-menu.test.ts`; Modify `webview/styles.css` is NOT allowed here (5.5 owns it) — use class names only.
**Interfaces:** Produces `FlowEditor { graph: FlowGraph; onGraph(g): void; readOnly: boolean }` and the `webview/plan-menu.ts` builders (Contracts). Consumes `layoutFlow` (2.2), reducers from `src/mermaid-flow.ts` (2.1), `ContextMenu`/`MenuItem`/`MenuState` from `webview/components/context-menu.tsx:9-59`, `Popover` (`webview/components/popover.tsx:38`) for the Connect to… / Move to… pickers, `ConfirmDialog` is not used (deletes are undoable via the document stack).
**Behaviour:** ReactFlow with `nodeTypes { flowNode, flowRegion }`, `edgeTypes { flowEdge }`, `nodesDraggable`, positions from `layoutFlow` recomputed on `graph` change (drag moves are local state only), `onConnect` → `addEdge`, `onNodesChange` `remove` → `removeNode`, `onEdgesChange` `remove` → `removeEdge(index)`, double-click node → inline rename (`renameNode`), double-click edge → relabel, pane/node/edge context menus from `plan-menu.ts`, Shift+F10 on a focused `.react-flow__node[data-id]` opens the node menu (copy the capture-phase listener shape from `webview/components/architecture-view.tsx:2502-2531`), `Shift+C` opens the Connect to… picker (list of node ids, arrow-navigable, Enter connects), `Shift+G` opens Move to subgraph…, `aria-roledescription` "node"/"edge", one `aria-live="polite"` region announcing "Connected A to B", "Removed edge A to B", "Renamed A", "Added node N".
**Steps:**
- [ ] Failing tests (plan-menu): 'node menu order is Rename, Connect to…, Move to subgraph…, Delete with Delete danger', 'pane menu has Add node first', 'comment menu omits Re-attach when null'
- [ ] Run — FAIL — implement `plan-menu.ts`; then implement `flow-editor.tsx` (proof is the Slice 5 e2e edge-delete and connect steps).

#### Task 5.4: PlanFlowBlock

**Files:** Create `webview/components/plan-flow-block.tsx`
**Interfaces:** Node view for `code_block` with `language === 'mermaid'`: `parseFlowchart(node.textContent)`; ok → `<FlowEditor graph onGraph={g => write serializeFlowchart(g) into the node}>`; not ok → `<MermaidDiagram source>` (`webview/components/mermaid-diagram.tsx`, props `{ source }`) with a `.planflow__unsupported` line "This diagram uses syntax the editor can't round-trip: <reason>" and an **Edit as text** button that swaps in a Monaco model (lang `markdown` is wrong; use plain text `mermaid` with no diagnostics) writing back like 5.2. Same node-view options as 5.2.
**Steps:**
- [ ] Implement; proof is the Slice 5 e2e diagram steps plus a manual check that a `sequenceDiagram` fence in a scratch plan renders the fallback.

#### Task 5.5: wire node views

**Files:** Modify `webview/components/plan-editor.tsx` (replace the 4.1 placeholder: one `useNodeViewFactory({ component: CodeBlockSwitch, as: 'div', stopEvent: () => true, ignoreMutation: () => true })` where `CodeBlockSwitch` picks `PlanFlowBlock` when `node.attrs.language === 'mermaid'` else `PlanCodeBlock`; register with `$view(codeBlockSchema.node, () => factory)` from `@milkdown/kit/utils`), `webview/styles.css` (`.plan__code`, `.planflow`, `.planflow__node`, `.planflow__node--selected`, `.planflow__region`, `.planflow__edge`, `.planflow__toolbar`, `.planflow__unsupported`; add `.planflow__node` and the toolbar buttons to the `quiet` role list at the foot), `test/e2e/plan-blocks.e2e.mjs`
**Steps:**
- [ ] Write the e2e from the slice check; run — expect FAIL before wiring — wire; run — PASS.
- [ ] Undo check by hand: Ctrl+Z inside a Monaco block undoes Monaco's edit; Ctrl+Z with focus in prose undoes the last document transaction including a diagram rewire (Milkdown history plugin).

### Slice 6: Comments, Send, Next change

**Check:** `node test/e2e/run-smoke.mjs plan-handoff` passes: open the fixture in a session with a live shell terminal → hover the diagram block → click the comment gutter → type "txn must not call identity" → Mod+Enter → `<root>/.conduit/plans/identity.comments.json` contains one open comment anchored to the diagram block's hash → delete the `txn --> identity` edge → the action bar reads "Send to agent (2)" → click → `window.__conduitPasteSpy[0]` contains the plan path, the new diagram fence, and the comment text → the sidecar's baseline lists the current hashes and the comment has `sentAt` → bar reads "Nothing to send". Plus resolve-all shows "All 1 resolved".

**Parallel groups:** G1: T6.1 · G2: T6.2 · Serial: T6.3
**Claims (serial lane):** `webview/components/plan-view.tsx`, `webview/styles.css`

#### Task 6.1: PlanCommentsPanel

**Files:** Create `webview/components/plan-comments-panel.tsx`
**Interfaces:** Produces `PlanCommentsPanel { anchored; blocks; disabled; onAdd(index, text); onEdit(id, text); onResolve(id, resolved); onDelete(id); onReattach(id, index); onJump(index) }`. Consumes `NoteComposer { label; initialBody?; refused?; onSave(body); onCancel(dirty); onDirtyChange? }` from `webview/components/note-thread.tsx:92` (reused for the composer; enforce `MAX_COMMENT_TEXT` with a counter that turns into "4 KB limit" text and disables Save), `commentMenu` (5.3), `Popover` for the Re-attach to… block picker (arrow-navigable list of `blocks[i].snippet`).
**States:** never-commented ("No comments yet" + the `c` hint), all-resolved ("All N resolved"), detached group at top, unsaved marker with Retry (driven by a `plan:error op:'comments'`), delete confirms (inline "Delete this comment?" Yes/No, no modal). Rows are `listitem` in a `list` labelled "Comments"; `r` resolves, Enter opens reply, Delete opens the confirm.
**Steps:**
- [ ] Implement; proof is the Slice 6 e2e (comment add → sidecar) and a manual keyboard pass recorded in the commit message.

#### Task 6.2: PlanActionBar

**Files:** Create `webview/components/plan-action-bar.tsx`
**Interfaces:** Produces `PlanActionBar { pending; live; sendBlockedReason: string | null; saveState: 'saved' | 'saving' | 'failed' | 'readonly'; source; nextCount; onSend; onToggleSource; onNextChange; onRetrySave }`. Consumes `handoffLabel(pending, live)` (`src/review-handoff.ts:65`; "Nothing to send" is rendered when `pending === 0 && live`, overriding the label), `useSyncExternalStore(subscribeTerminalBus, …)` + `hasLiveTerminal(sessionId)` from `webview/terminal-bus.ts` as `review-view.tsx:882-883` does (the view passes `live`).
**Steps:**
- [ ] Implement as a presentational component: `.plan__actionbar`, `.plan__save`, `.plan__send`, `.plan__source`, `.plan__next`; disabled reasons in `aria-describedby`.

#### Task 6.3: wire comments, Send, Next change, source view

**Files:** Modify `webview/components/plan-view.tsx` (gutter button on block hover via the editor's `onBlockFocus` and a `.plan__gutter` overlay; `c` on a focused block opens the composer; Send → `buildPlanHandoff({ planPath: \`.conduit/plans/${slug}.md\`, changed: humanChanged(blocks, baseline), removed: removedSinceBaseline(...), comments: reanchorComments(open unsent), blocks })` → `pasteToTerminal(sessionId, text)` else clipboard → `patchPlanComments({ type:'sent', ids, baseline: { at: new Date().toISOString(), blockHashes: blocks.map(b => b.hash) } })`; Next change scrolls to the next block whose hash ∈ `agentChanged` and calls `markViewed`; Source toggle swaps the editor for a Monaco model of the whole file (a plain `monaco.editor.create` on a `markdown` model whose changes go through `writePlan` directly; `CodeViewer` is not reused) and persists the toggle under its own key: `setViewState(\`plan-source:${doc.id}\`, { kind: 'scroll', top: source ? 1 : 0 })`, read back with `getViewState` on mount; `sendBlockedReason` = 'Save failed' when `saveState === 'failed'`, 'A comment is unsaved' when `commentsError !== null`, else null), `webview/styles.css` (`.plan__gutter`, `.plancomment`, `.plancomment__row`, `.plancomment__row--detached`, `.plancomment__row--unsaved`, `.plan__actionbar*`; role-list entries for gutter/row buttons at the foot), `test/e2e/plan-handoff.e2e.mjs`
**Interfaces:** Consumes `buildPlanHandoff` (1.5), `humanChanged`/`removedSinceBaseline` (1.4), `reanchorComments` (1.4), `pasteToTerminal(sessionId, text): boolean` (`webview/terminal-bus.ts:110`), `patchPlanComments`/`markViewed` (4.2), `getViewState`/`setViewState` (`webview/view-state-store.ts:94,99`), `PlanCommentsPanel` (6.1), `PlanActionBar` (6.2).
**Steps:**
- [ ] Write the e2e from the slice check (set `window.__conduitPasteSpy = []` as `test/e2e/review-notes-handoff.e2e.mjs:89` does); run — FAIL — wire; run — PASS.
- [ ] Live region: one `aria-live="polite"` in PlanView announcing saved / save failed / sent / "N blocks changed by the agent".

### Slice 7: Skill, docs, ship

**Check:** `npm run verify` green on the merged tree, then `node test/e2e/run-smoke.mjs plan-editor`, `plan-blocks`, `plan-handoff` each green **run one at a time**, then the full `npm run test:smoke` once as the regression check.

**Parallel groups:** G1: T7.1 · G2: T7.2 · Serial: T7.3

#### Task 7.1: the skill and the deprecation

**Files:** Create `resources/skills/conduit-interactive-plan/SKILL.md` (frontmatter `name: Conduit Interactive Plan`, `description: Write feature plans as plain Markdown to .conduit/plans/<slug>.md; Conduit renders them as an editable document with live ts and mermaid blocks. Read .conduit/plans/<slug>.comments.json each turn and address the human's comments.`, `version: 1.0.0`); Modify `resources/skills/conduit-plan/SKILL.md` and `.claude/skills/conduit-plan/SKILL.md` (description prefixed `Deprecated — superseded by Conduit Interactive Plan. `, `version: 1.1.0`, body unchanged)
**Content of the new skill (sections, in order):** where the file lives and the slug rule; the three block conventions with one example each (`ts` fence = a signature, no bodies; `mermaid` = `flowchart` only, the supported subset listed verbatim from Contracts, "never write positions or classDef unless you mean them"); keep prose tight, one idea per paragraph, headings per section; on every turn read the sidecar, address each `open` comment by editing the plan, append a reply `{author:'agent', replyTo}` and set the original to `resolved`; never edit `baseline`; the handoff paste the human sends and what "Changed blocks" means; do not rewrite blocks you were not asked to change (the human's diff is the feedback).
**Steps:**
- [ ] Failing test in `test/unit/skills.test.ts`: 'bundled skills include conduit-interactive-plan and conduit-plan is marked deprecated' (parse both frontmatters). Run — FAIL — write the files — PASS.

#### Task 7.2: CHANGELOG and a11y/i18n pass

**Files:** Modify `CHANGELOG.md` (Unreleased: "Interactive plan documents: …" three lines); walk spec §10 against the built UI: every icon-only control has `aria-label`, focus ring visible in all three themes (`data-theme` aero/neon/default) and under `forced-colors`, `prefers-reduced-motion` disables the changed-marker pulse and layout transitions, timestamps via `Intl.DateTimeFormat`.
**Steps:**
- [ ] Record the pass as a checklist in the commit message; fix anything missing in the owning component file.

#### Task 7.3: ship

**Files:** `git mv docs/specs/2026-09-19-interactive-plan.md docs/specs/archive/`; Modify `docs/specs/INDEX.md` (move the row to Archived); update the spec's `status:` to `shipped`
**Steps:**
- [ ] Run the Slice 7 check in full; `git status` shows only intended files; commit; merge `feat/interactive-plan` to `main` with `--no-ff`.

## Verification

Per task: the task's own test file via `npx vitest run <file>`, plus `npm run typecheck` whenever `src/protocol.ts` or a component changed. Per slice: the slice **Check** verbatim. Merged tree: `npm run verify` (never piped, never truncated), then the three plan e2es one at a time on a quiet machine, then `npm run test:smoke`. A red PTY e2e is re-run alone before it is believed (CLAUDE.md).

## Deviation rule

If a task's assumption turns out wrong — the piece it builds on is misaligned, a locked signature doesn't fit reality, Milkdown does not mount under React 19, ProseMirror does not preserve node identity for untouched siblings — that task **stops** and fixing the misaligned piece becomes the work. Never a shim, second copy, special case, widened type, fallback, or an override patched in place of its semantic source. Report leads with the fix that keeps the locked decision.
