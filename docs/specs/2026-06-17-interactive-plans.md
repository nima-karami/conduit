---
status: active
date: 2026-06-17
---

# Interactive plans — a commentable, round-tripped plan an agent authors

## Problem

When an agent plans, it emits **pages of markdown** the user has to read top-to-bottom in a
terminal or a flat document. There is no structure to navigate, no way to **comment on a
specific step**, no way to **steer** the plan, and no clean path for that feedback to get **back
to the agent**. Conduit's architecture canvas proves that a structured `.conduit/` artifact can
be rendered richly and round-tripped with an agent — but a *plan* is a different shape:
**ordered, multi-step, with nested substeps and per-step status**, not a free-form node graph.

## Goal

A structured **plan artifact** an agent authors (`.conduit/plan.json`), rendered as an
**interactive, commentable plan view** in Conduit. The user reads a navigable outline (not a
wall of markdown), **comments on specific elements**, sets per-step approval, and those comments
**persist to disk so the agent reads them on its next turn** and revises. The plan-authoring
**skill** (content shipped here, installed via the `skill-installer` spec) teaches the agent the
format and the read-comments-each-turn loop.

This **realizes the interactive-planning seam** reserved in the `agent-chat-ui` spec
(`plan_update` / `interactive_prompt`): that view can deep-link into this one.

## Architecture

Builds directly on the existing `.conduit/` artifact infrastructure (ADR 0002): versioned
envelopes (`src/conduit-store.ts`), atomic per-project writes + live watchers
(`electron/conduit-fs.ts`, `ConduitDirWatch`), and the **agent-proposal** flow
(`proposal-watcher.ts`, `acceptProposal`/`rejectProposal`).

### Files & ownership (two-file split)

Ownership is split across two siblings so agent plan rewrites and human comments **never
collide**, and the existing **whole-document** proposal-accept stays clean (it would otherwise
clobber comments):

| File | Owner | Contents |
|------|-------|----------|
| `.conduit/plan.json` | **agent** | plan structure: ordered steps, nested substeps, per-step status + markdown body |
| `.conduit/plan.comments.json` | **shared thread** | anchored comment threads (human + agent), append-style |
| `.conduit/plan.proposed.json` | **agent** (optional) | a proposed structural rewrite → diff → human accept/reject (reuses proposal infra) |

### Plan schema — `src/plan.ts` (pure, unit-tested)

```ts
type PlanStatus = 'pending' | 'active' | 'done' | 'blocked';

interface PlanStep {
  id: string;            // STABLE — survives rewrites; comment anchors reference it
  title: string;
  body?: string;         // markdown (rendered via the existing markdown viewer + mermaid)
  status: PlanStatus;
  steps?: PlanStep[];    // nested substeps (recursive)
}

interface PlanDoc {
  version: 1;
  title: string;
  steps: PlanStep[];
}
```

A new `ConduitKind` `'plan'` with `serializePlanArtifact` / `readPlanArtifact` (envelope wrap /
unwrap, graceful empty default), mirroring the architecture/board kinds. `restorePlan` validates
and is tolerant of unknown fields (forward-compat).

### Comment anchoring — the headline requirement

Every comment is **tied to the specific plan element it is about** (the user's explicit
requirement). Comments live in `plan.comments.json` as anchored threads:

```ts
interface PlanAnchor {
  stepId: string;                 // which step (or substep) — by STABLE id
  field?: 'title' | 'body';       // which part of the step (default: the step as a whole)
  range?: [start: number, end: number]; // optional char span within the body text
}

interface PlanComment {
  id: string;
  anchor: PlanAnchor;
  author: 'human' | 'agent';
  text: string;                   // markdown
  kind?: 'note' | 'request-change' | 'approve'; // per-step steer signal
  status: 'open' | 'resolved';
  createdAt: number;
  replyTo?: string;               // threads
}

interface PlanComments {
  version: 1;
  comments: PlanComment[];
}
```

- **Anchors reference stable step ids**, so a comment stays attached across agent rewrites.
- If a rewrite **removes** an anchored step, its comments become **orphaned** — surfaced in an
  "orphaned comments" list (never silently lost), with the anchor's last-known step title.
- A pure `resolveAnchors(plan, comments)` maps comments → live elements + an orphan set.

### Round-trip loop

1. Agent writes `plan.json` (taught by the skill) → the plan view renders it live (watcher).
2. Human **comments on an element** (select a step/substep, or a text span in its body) and/or
   marks a step **approve / request-change** → Conduit **appends** to `plan.comments.json`
   (serialized atomic append, reusing the `appendPipelineQueueEntry` chain pattern so rapid
   comments never drop).
3. On its next turn the agent **reads `plan.comments.json`**, addresses open comments (replies,
   marks `resolved`, and revises the plan), then either rewrites `plan.json` directly or — for a
   larger restructure — writes `plan.proposed.json`.
4. A `plan.proposed.json` shows the existing **proposal banner + diff**; the human
   **accepts** (replace `plan.json`; comments untouched in their own file, re-anchored by id,
   orphans flagged) or **rejects**. `ProposalKind` is extended to include `'plan'`.

The agent reads comments because the **skill instructs it to** (and because Conduit can also
note "N open plan comments" via the chat/attention surface). Comments are not auto-injected into
the agent's context by Conduit — the file is the contract.

### Watching

Extend the `.conduit/` watching to the plan trio: `plan.json` + `plan.comments.json` live-refresh
the plan view; `plan.proposed.json` drives the proposal banner (extend `ProposalWatcher`'s
`KIND_FOR_FILE` / `PROPOSAL_FILE_NAMES`). Reuses `ConduitDirWatch` debounce plumbing.

### The plan view (renderer) — `centerView === 'plan'`

A new center-pane view, sibling to `BoardView` / `ArchitectureView`, registered the same way
(`centerView` state + a `cmd:plan` command-palette entry + a view-switcher entry):

- **Outline:** ordered, collapsible steps with nested substeps; each shows a **status chip**
  (pending/active/done/blocked) and its markdown **body** (reuse `markdown-viewer.tsx` incl. W4
  mermaid/images).
- **Commenting:** clicking a step/substep — or selecting text within a body — opens an **add
  comment** affordance anchored to that element; existing threads render **against their
  anchor** (margin/inline) with a per-element **comment count**. Resolve / reply inline.
- **Steer:** per-step **Approve / Request changes** (stored as a `kind` comment), so the agent
  gets an explicit signal, not just prose.
- **Proposal:** when `plan.proposed.json` exists, the proposal banner + diff (reuse the existing
  proposal UI) lets the human accept/reject the agent's restructure.
- **Orphaned comments:** a small section listing comments whose anchored step is gone.
- **Empty state:** no `plan.json` → "No plan yet — install the **conduit-plan** skill
  (Skills panel) and ask your agent to draft a plan."
- Guard `window.agentDeck` absent (mock preview): render a sample/empty plan, no writes.

### Editability scope (v1)

The **agent owns plan structure**; the human **steers via comments + approvals**, not by
directly rewriting steps. v1 human edits = add/resolve/reply comments and set per-step
approve/request-change. Full human WYSIWYG editing of steps is **out of scope** (YAGNI; the
proposal flow + comments are the steering channel).

### The plan-authoring skill (shipped here, installed via `skill-installer`)

A bundled skill `conduit-plan` (a `SKILL.md`) instructs the agent to:

1. Write/maintain the plan at `.conduit/plan.json` in the schema above, with **stable step ids**.
2. **Each turn, read `.conduit/plan.comments.json`**: address every `open` comment — reply,
   mark `resolved`, and revise the plan accordingly.
3. For a large restructure, write `.conduit/plan.proposed.json` instead of editing `plan.json`
   directly, so the human can review a diff.

The skill is **agent-agnostic in spirit** (the file format is not Claude-specific), but only the
**Claude Code** skill ships in v1 (installed via the `skill-installer` spec, which targets
Claude Code first).

## Decisions

- **Anchored comments are first-class** (user requirement): every comment names the exact
  element (`stepId` + optional `field`/`range`), survives rewrites via stable ids, and orphans
  are surfaced, never lost.
- **Two-file ownership split** (`plan.json` agent / `plan.comments.json` shared) — keeps the
  whole-document proposal-accept clean and prevents agent/human write collisions. (Chosen over
  a single combined file precisely because proposal-accept replaces the whole canonical doc.)
- **Structured JSON, not markdown** — interactivity (navigation, per-element comments, status)
  needs structure; the body field still carries rich markdown.
- **Dedicated center-pane view** now; the chat-UI inline render is the designed seam (deep-link),
  not a v1 dependency — and the chat UI isn't built yet.
- **Reuse `.conduit/` + watcher + proposal infra** — `plan` is a new artifact kind alongside
  board/architecture/pipeline; `'plan'` joins `ProposalKind`.
- **Agent owns structure; human steers** — bounded editability keeps the loop simple.

## Testing

- **Unit (vitest, pure):** `src/plan.ts` restore/serialize/migrate (incl. unknown-field
  tolerance, nested substeps); `resolveAnchors` (live mapping + orphan detection across a
  rewrite that drops/renames a step); comment append round-trip (serialized, no drops);
  proposal-accept preserves `plan.comments.json` and re-anchors by id.
- **Real-app smoke (W1 harness):** write a `plan.json` fixture into a temp project's `.conduit/`
  → the plan view renders steps/substeps/status; add an **anchored** comment in the view →
  `plan.comments.json` gains a correctly-anchored entry; write a `plan.proposed.json` → the diff
  banner appears → **accept** replaces `plan.json` while comments survive (orphans flagged for a
  dropped step).

## Acceptance criteria

- [ ] An agent-written `.conduit/plan.json` renders as a navigable, collapsible outline with
      nested substeps, per-step status, and markdown bodies.
- [ ] The user can attach a comment to a **specific** step/substep (and a body text span); it
      renders against that element and persists to `.conduit/plan.comments.json`.
- [ ] Per-step **Approve / Request changes** is recorded as a comment the agent can read.
- [ ] Comments survive an agent plan rewrite (re-anchored by stable id); comments whose step
      was removed are shown as **orphaned**, not lost.
- [ ] A `.conduit/plan.proposed.json` shows a diff and can be accepted/rejected; accepting never
      drops comments.
- [ ] The bundled `conduit-plan` skill exists and is installable via the Skills panel.
- [ ] Pure plan/anchor/comment modules are unit-tested; the smoke scenario passes against a temp
      project (no real `~/.claude` or repo writes).
- [ ] `npm run verify` exits 0 and `node esbuild.mjs` is green.

## Out of scope

- **Full human structural editing** of the plan (add/remove/reorder steps in the UI) — steering
  is via comments + the proposal flow.
- **Chat-UI inline rendering** of the plan — designed seam (`agent-chat-ui`), deep-link only.
- **Codex** plan skill packaging — the format is agent-agnostic, but only the Claude Code skill
  ships (per `skill-installer` v1).
- Real-time multi-user collaboration, plan templates/export, and a standalone external web UI
  (the "separate web UI" idea is satisfied by the in-app view for now).

## References

- ADR 0002 (`docs/adr/0002-conduit-artifact-format.md`) — envelope, proposals, ownership.
- `src/conduit-store.ts` — add the `'plan'` kind (`serializePlanArtifact`/`readPlanArtifact`).
- `src/plan.ts` (new) — `PlanDoc`/`PlanStep`/`PlanComment`/`PlanAnchor` + `restorePlan`,
  `resolveAnchors`.
- `electron/conduit-fs.ts` — `plan.json` / `plan.comments.json` read/write (atomic), serialized
  comment append (`appendPipelineQueueEntry` pattern), `'plan'` added to `ProposalKind` +
  `PROPOSAL_FILE_FOR`.
- `electron/proposal-watcher.ts` — extend `KIND_FOR_FILE` / `PROPOSAL_FILE_NAMES` for `plan`.
- `webview/app.tsx` — `centerView === 'plan'`, `cmd:plan` (mirrors `cmd:board`/`cmd:canvas`).
- `webview/components/board-view.tsx` / `architecture-view.tsx` — the center-pane view pattern;
  `markdown-viewer.tsx` for step bodies.
- `agent-chat-ui` spec — the `plan_update` / `interactive_prompt` seam this view realizes.
- `skill-installer` spec — installs the `conduit-plan` skill shipped by this spec.
