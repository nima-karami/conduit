---
name: Conduit Plan
description: Author and maintain a structured, commentable plan in .conduit/plan.json that Conduit renders as an interactive plan view. Read .conduit/plan.comments.json each turn and address the human's comments.
version: 1.0.0
---

# Conduit Plan skill

This skill teaches you to drive Conduit's **interactive plan** view. Instead of dumping pages
of markdown into the terminal, you write a **structured plan** to `.conduit/plan.json`. Conduit
renders it as a navigable outline of steps and substeps, with per-step status, markdown bodies,
and the ability for the human to **comment on a specific step** and set **approve / request
changes**. Those comments persist to `.conduit/plan.comments.json` so you read them on your next
turn and revise.

## The two files (ownership split)

- **`.conduit/plan.json`** — YOURS. The plan structure. You write and rewrite it.
- **`.conduit/plan.comments.json`** — SHARED, append-only. The human (and you) leave anchored
  comments here. **Never delete or rewrite comments wholesale**; only append (e.g. a reply, or
  flip a comment's `status` to `resolved` when you've addressed it).
- **`.conduit/plan.proposed.json`** — optional. For a large restructure, write your proposed
  next `plan.json` here instead of editing `plan.json` directly, so the human reviews a diff and
  accepts/rejects it.

## `plan.json` schema

A versioned envelope wrapping a `PlanDoc`:

```jsonc
{
  "conduit": 1,
  "kind": "plan",
  "updatedAt": 1750000000000,
  "data": {
    "version": 1,
    "title": "Add interactive plans",
    "steps": [
      {
        "id": "s-design",          // STABLE id — never change it across rewrites
        "title": "Design the data model",
        "body": "Markdown. Supports **rich** text, code, and ```mermaid``` diagrams.",
        "status": "done",          // pending | active | done | blocked
        "steps": [                  // nested substeps (recursive, optional)
          { "id": "s-design-ids", "title": "Stable step ids", "status": "done" }
        ]
      },
      { "id": "s-host", "title": "Host wiring", "status": "active" },
      { "id": "s-ui", "title": "Render the plan view", "status": "pending" }
    ]
  }
}
```

Rules:

1. **Step `id`s are STABLE.** A comment anchors to a step by its id, so reusing the same id
   across a rewrite keeps the comment attached. If you rename a step, keep its `id`. If you
   genuinely remove a step, its comments become **orphans** (surfaced in the view, not lost).
2. `status` is one of `pending`, `active`, `done`, `blocked`. Keep it current as work moves.
3. `body` is markdown (Conduit renders it, including mermaid). Keep it tight — the value of this
   view is structure, not a wall of prose.

## Each turn: read the comments

At the start of every turn, **read `.conduit/plan.comments.json`** and address every comment
whose `status` is `"open"`:

```jsonc
{
  "conduit": 1,
  "kind": "plan-comments",
  "data": {
    "version": 1,
    "comments": [
      {
        "id": "c-1",
        "anchor": { "stepId": "s-ui" },     // which step this is about
        "author": "human",
        "text": "Can we split the renderer step into outline + commenting?",
        "kind": "request-change",            // note | request-change | approve
        "status": "open",
        "createdAt": 1750000100000
      }
    ]
  }
}
```

For each open comment:

- **Revise the plan** in `plan.json` to address it (split a step, reword, change status, etc.).
- **Reply** by appending a new comment with `"author": "agent"`, `"replyTo": "<the comment id>"`,
  and the same `anchor`.
- **Mark it resolved**: append a short agent comment noting it's done, or set the original
  comment's `status` to `"resolved"` (append-only edit — keep the comment, just flip status).
- A `kind: "approve"` comment is a green light; a `kind: "request-change"` is a must-fix.

## Large restructures

When you want to reorder, add, or remove several steps at once, write the full proposed
`plan.json` to `.conduit/plan.proposed.json` (same envelope, `kind: "plan"`). Conduit shows the
human a diff banner; on **accept**, Conduit replaces `plan.json` with your proposal and the
comments survive (re-anchored by stable id). Do not also edit `plan.json` directly in that turn.

## When to use

Use this whenever you would otherwise emit a long, multi-step plan in chat. Author it as
`.conduit/plan.json`, keep statuses current, and read `.conduit/plan.comments.json` every turn to
stay in lockstep with the human's steering.
