# Spec — board-skill-transitions ("the board encodes the pipeline")

Wishlist item **G4**. Status: spec.

## One-line

Let the feature board encode a **pipeline**: configure which Claude Code **skill**
runs on each column transition (Wishlist→Planning, Planning→Building, …), and
**surface** that skill when a card crosses the boundary — so "the board encodes the
pipeline, not just the status."

## Why

Today the board is pure status: a card sits in a column. But moving a card between
columns is, in practice, a *workflow step* — "this idea is ready to be specced",
"this plan is ready to be built". A team (human + agents) repeats the same skill on
the same transition every time. Encoding that mapping on the board turns each
column boundary into a named, repeatable pipeline stage instead of tribal knowledge.

## The honest execution boundary (load-bearing)

**The Electron app CANNOT directly auto-execute a Claude Code skill.** Skills run in
the Claude Code CLI/agent harness, not in the desktop renderer or its Node host.

Therefore this feature does **NOT** execute skills. It does three honest things:

1. **Configures** a per-transition → skill-name mapping (pure, versioned, persisted).
2. **Surfaces** the configured skill when a card moves across a configured boundary —
   a non-blocking toast in the UI ("Moving to Building → run `writing-plans`").
3. **Records** a machine-readable transition event to `.conduit/pipeline-queue.json`
   that an external agent (or the user) can consume and act on.

The queue file is the *hook* an agent acts on; the app never claims to have run the
skill. This boundary is stated in the UI (the Pipeline panel) and in the ADR-adjacent
artifacts, not hidden.

## Storage choice (decided)

Two reasonable homes were considered:

- **(A) A `pipeline` field in the board envelope** (`.conduit/board.json`'s `data`).
- **(B) A standalone `.conduit/pipeline.json` artifact.**

**Decision: (B) — a standalone `.conduit/pipeline.json`**, with its own thin envelope
(`kind: "pipeline"`), mirroring `architecture.json` / `board.json`. Rationale:

- The board is **shared mutable state with the overnight agent**, which direct-writes
  `board.json`. Co-locating pipeline config there risks the agent clobbering it on a
  whole-document board rewrite. A separate file keeps config out of that blast radius.
- It diffs/reviews independently (ADR §1: "one artifact per concern"), and an agent
  consuming the pipeline reads exactly one small file.
- It reuses the existing envelope + atomic-write + bare-payload-tolerant machinery
  verbatim, so it costs almost nothing.

The transition **queue** (`pipeline-queue.json`) is a *separate*, append-style log —
config is human-owned and stable; the queue is an event stream the app appends to and
an agent drains. Keeping them separate keeps config diffs clean.

`.conduit/pipeline-queue.json` is **runtime ephemera, not curated knowledge** — it is
**gitignored** in consuming projects (an agent drains it). For Conduit's own repo we
simply never write a real `.conduit/` (tests use temp dirs), so nothing lands.

## Data model

### Transitions

The canonical pipeline is the existing stage order: `wishlist → planning → building →
done`. A **transition** is an ordered (from, to) stage pair. The **transition key** is
`"${from}->${to}"` (e.g. `"wishlist->planning"`). Only the three **forward adjacent**
transitions are surfaced in the config UI as the canonical pipeline:

- `wishlist->planning`
- `planning->building`
- `building->done`

…but the model accepts an arbitrary `(from,to)` key, so a non-adjacent or backward
move (e.g. dragging building→wishlist) is *representable* (lookup just returns no
skill unless one was configured).

### `PipelineConfig`

```ts
interface PipelineConfig {
  version: 1;
  /** transition key (`from->to`) → skill name (free text, e.g. "writing-plans"). */
  transitions: Record<string, string>;
}
```

- `skillForTransition(config, from, to)` → the configured skill name, or `undefined`.
- A skill name is **free text** (the user types it). Empty / whitespace-only ⇒ treated
  as "no skill for this transition" (not stored). We do not validate that the skill
  exists — the app has no skill registry; that is the agent/CLI's concern.

### Queue record

```ts
interface PipelineQueueEntry {
  id: string;            // unique per event
  cardId: string;
  cardTitle: string;
  from: Stage;
  to: Stage;
  transition: string;    // `from->to`
  skill: string;         // the configured skill name
  at: number;            // epoch ms
}
interface PipelineQueue {
  version: 1;
  entries: PipelineQueueEntry[];
}
```

`buildQueueEntry(...)` is pure; `appendQueueEntry(queue, entry)` returns a new queue.
The host appends to `.conduit/pipeline-queue.json` only when a move **matches a
configured transition** (skill present).

## Behavior

### Configure (Pipeline panel)

- A **"Pipeline" button** in the board header opens a small panel listing the three
  canonical transitions, each with a free-text input for a skill name.
- Editing an input + blur/Enter saves the whole `PipelineConfig` via IPC
  (`updatePipeline`), debounced like the board save.
- The panel states the honesty boundary: "Conduit surfaces the skill on a move and
  records it to `.conduit/pipeline-queue.json` for an agent to run — it does not
  execute skills itself."

### Surface on move

When a card moves (context-menu "Move to X", or drag-to-column) **and** a skill is
configured for that exact `(from,to)`:

1. A non-blocking **toast** appears: ``Moving to Building → run `writing-plans` ``.
2. The host appends a `PipelineQueueEntry` to `.conduit/pipeline-queue.json`.

If no skill is configured for the transition, the move behaves exactly as today
(no toast, no queue write). No move is ever blocked.

### Load / persist

- On board open, the renderer requests the pipeline config (`requestPipeline`); host
  reads `.conduit/pipeline.json` (empty config if absent/invalid — never throws).
- `updatePipeline` writes atomically, errors surfaced (ADR §5), like the board write.
- `queueTransition` appends one entry; a failed append is surfaced as an `error`
  message but never blocks the move (the card already moved; the surface is best-effort).

## Acceptance criteria

1. `skillForTransition` returns the configured skill for a matching key, `undefined`
   otherwise; an empty config returns `undefined` for everything.
2. Transition key derivation is `${from}->${to}` and round-trips.
3. `PipelineConfig` round-trips through `.conduit/pipeline.json` (envelope on disk;
   bare-payload tolerant; absent ⇒ empty config).
4. A whitespace-only skill name is normalized away (not persisted).
5. Moving a card across a **configured** transition produces a queue entry with the
   right card/from/to/skill/at; moving across an **unconfigured** one produces none.
6. The Pipeline panel renders the three canonical transitions and persists edits.
7. `window.agentDeck` absent ⇒ no crash (preview falls back to in-memory mock).
8. Honesty: the UI and queue make clear the skill is *surfaced/queued*, not executed.

## Out of scope

- **Executing** the skill (explicitly — see boundary above).
- Validating that a skill name exists.
- Per-card skill overrides (config is per-transition, board-wide).
- A UI to drain/inspect the queue (an agent or the user consumes the JSON).
