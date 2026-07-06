---
name: Conduit Architecture
description: Read and update a project's architecture diagram — the .conduit/architecture.json Conduit renders as a drill-down canvas. Propose changes via .conduit/architecture.proposed.json so the human reviews a diff and accepts.
version: 1.0.0
---

# Conduit Architecture skill

This skill teaches you to read and evolve Conduit's **architecture diagram** for a project.
The diagram is a structured JSON document, `.conduit/architecture.json`, that Conduit renders as
a navigable canvas of components (nodes) and relationships (edges), with **drill-down**: any node
can own a nested graph. It is the shared, round-trippable answer to "what is this system?" that
both the human (in the app) and you (from the terminal) read and write.

## Ownership: the human owns it, you PROPOSE

`.conduit/architecture.json` is **human-owned source of truth**. You do **not** overwrite it.
When you want to change the diagram, write your proposed *next* whole document to the sibling
**`.conduit/architecture.proposed.json`**. Conduit detects it, shows the human a **diff** against
the canonical file, and on **accept** replaces `architecture.json` with your proposal atomically
(on **reject** it's discarded). See ADR 0002 §3.

- **Read** `.conduit/architecture.json` to understand the current diagram.
- **Write** `.conduit/architecture.proposed.json` to suggest changes — never edit the canonical
  file directly.
- It's a **whole-document** proposal, not a patch: emit the complete `ArchDoc`, not a delta.
- If `.conduit/architecture.json` is absent, the project has no diagram yet — propose one from
  scratch (a single root graph is a fine start).

## The envelope

Both files use the same versioned envelope. The diagram lives under `data`:

```jsonc
{
  "conduit": 1,
  "kind": "architecture",
  "updatedAt": 1750000000000,   // Date.now() at write time
  "data": { /* an ArchDoc — see below */ }
}
```

A full JSON Schema for this format ships beside this skill as
[`architecture.schema.json`](./architecture.schema.json) — validate your proposal against it
before writing.

## `data` — the ArchDoc (a tree of graphs)

An `ArchDoc` is **not** a flat node list. It's a map of graphs; one is the root, and any node can
drill into another graph via `childGraph`:

```jsonc
{
  "version": 1,
  "rootGraph": "graph-root",          // MUST be a key in `graphs`
  "graphs": {
    "graph-root": {
      "id": "graph-root",
      "title": "System",
      "nodes": [
        {
          "id": "n-ui",               // STABLE id — keep it across rewrites
          "title": "UI / Renderer",
          "subtitle": "React webview",  // optional
          "description": "Free prose goes here.", // optional — your narrative field
          "kind": "frontend",
          "x": 0, "y": 0,
          "childGraph": "graph-ui"    // optional: this node drills into another graph
        },
        { "id": "n-api", "title": "API", "kind": "gateway", "x": 240, "y": 0 },
        { "id": "n-db", "title": "Postgres", "kind": "database", "x": 480, "y": 0 }
      ],
      "edges": [
        { "id": "e1", "source": "n-ui", "target": "n-api", "label": "HTTP" },
        { "id": "e2", "source": "n-api", "target": "n-db" }
      ]
    },
    "graph-ui": {                       // the nested canvas behind n-ui
      "id": "graph-ui",
      "title": "UI / Renderer",
      "nodes": [ { "id": "n-router", "title": "Router", "kind": "library", "x": 0, "y": 0 } ],
      "edges": []
    }
  }
}
```

### Node `kind` — pick from this fixed set

Each kind has its own color + icon. **Any other value silently becomes `service`**, so use one of:

`service`, `gateway`, `frontend`, `database`, `cache`, `queue`, `worker`, `storage`, `library`,
`external`, `group`.

(`group` is a boundary/container label; `external` is a third-party system you don't own.)

## Rules the app enforces (get these wrong and content is dropped)

These are validated when Conduit loads your proposal. Violations don't error loudly — they're
silently sanitized, so the diagram won't look like what you wrote:

1. **`rootGraph` must be a key in `graphs`.** If it isn't, the **entire document is rejected** and
   the app falls back to a seed. Double-check this one.
2. **Node `id`s are STABLE and the contract.** Edges reference nodes by id, and the review diff
   anchors to ids. Reuse the same id when you rename or move a node; only assign a new id for a
   genuinely new node. Ids must be unique within a graph.
3. **Every edge's `source` and `target` must be node ids in the SAME graph.** An edge pointing at
   a missing id (or a node in another graph) is **dropped**. Cross-graph links aren't a thing —
   use `childGraph` for nesting instead.
4. **`childGraph` must be a key in `graphs`.** A dangling reference is **cleared** (the drill-in
   affordance disappears), so add the target graph in the same proposal.
5. **`x`/`y` are required numbers.** Lay components out so they don't overlap — space them ~200px
   apart; a rough left-to-right or layered flow reads best. Don't pile everything at (0,0).
6. Keep `version: 1` and the envelope's `conduit: 1`.

## Workflow

1. **Read** `.conduit/architecture.json` (unwrap `data`). If absent, you're starting fresh.
2. **Build the next full `ArchDoc`** in memory: reuse existing ids, add/remove nodes and edges,
   write prose into `description`, keep `rootGraph` valid.
3. **Validate** against `architecture.schema.json` and re-check the five rules above.
4. **Write** the whole envelope to `.conduit/architecture.proposed.json`.
5. Tell the human you've proposed a diagram change; they accept/reject the diff in Conduit. Don't
   also touch `architecture.json` in the same turn.

## When to use

Use this whenever you're asked to map, document, or update a project's architecture, or when a
change you're making alters the system's shape (a new service, a new dependency, a split module).
Keep the diagram a faithful, high-level model — structure the human can navigate, with detail
pushed into nested graphs and `description` prose, not a sprawling single canvas.
