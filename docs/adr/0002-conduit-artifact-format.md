# ADR 0002 — The `.conduit/` artifact format

Date: 2026-06-11
Status: Accepted — proposal mechanism shipped 2026-06-12 (N1; see §3)

## Context

Conduit owns three pieces of project understanding that today live in scattered,
inconsistent homes:

- **The architecture diagram** — a tree of graphs (`ArchDoc` in `src/architecture.ts`),
  persisted per-project as `architecture.json` in the *opened project's* root and
  read/written via the `requestArchitecture` / `updateArchitecture` IPC path.
- **The feature board** — a Kanban of cards (`BoardData` in `src/board.ts`),
  persisted as a single `board.json` at the **Conduit repo root** (resolved
  `__dirname/../board.json`). This file is **shared mutable state with an external
  overnight agent** that advances cards by editing it directly (per `CLAUDE.md`).
- **Feature specs** — today these are loose markdown under `docs/` (or nonexistent);
  there is no machine-discoverable link from a board card to its spec.

We want a single, committed, LLM-legible home for this project knowledge so that an
agent dropped into a repo can read "what is this system and what are we building"
from one well-known place, and so the app and the agent round-trip the *same*
artifacts. This ADR defines that home: **`.conduit/`**.

The north-star features F0 (architecture-canvas persistence) and G0 (feature board →
`.conduit/`) will both build on the foundation this ADR specifies. This ADR also
defines G3 (feature specs referenced by cards).

The genuinely hard question is **ownership**. The diagram and board are *human-edited*
in the app, but an agent also wants to *regenerate / advance* them. Those two forces
pull in opposite directions: blind agent overwrite destroys human intent; human-only
files make the agent inert. The bulk of this ADR is resolving that tension.

## Decision

### 1. Layout — `.conduit/` at the repo root

A project's Conduit knowledge lives in a committed `.conduit/` directory **at the
root of the project being described**, resolved the same way the current
per-project `architecture.json` already resolves: relative to the opened project's
root path (the `m.path` the renderer sends), *not* relative to the Conduit install.

```
<project-root>/.conduit/
  architecture.json   # the canvas graph (tree of graphs): nodes / edges / kinds
  board.json          # the feature board (cards across stages)
  specs/
    <card-id>.md      # a feature spec doc referenced by a board card (G3)
```

Notes on the layout:

- `.conduit/` is **committed**, like the current root `board.json`. It is project
  knowledge, not user runtime config (which stays in Electron's `userData`:
  `agents.json`, `sessions.json`, etc. — unchanged).
- Each artifact is a standalone JSON file so a human or agent can diff, review, and
  edit one without touching the others, and so git conflicts stay local to one
  concern.
- Specs are **markdown, one file per card**, named by the **stable card id**
  (`specs/<card-id>.md`). Spec discovery is **filename-driven**: a card's spec path is
  *derived* from its id, not stored as a link, so a spec can never be orphaned by a
  missing link entry. The card's `links` field is for **external URLs**, not the spec.

### 2. The envelope — every artifact is versioned and wrapped

Each JSON artifact is an **envelope**: a thin, uniform wrapper carrying format
metadata around a typed `data` payload. The payload reuses the *existing* domain
types (`ArchDoc`, `BoardData`) verbatim — `.conduit/` wraps them, it does not
reinvent them.

```jsonc
{
  "conduit": 1,            // envelope format version — bumped only if the *wrapper* shape changes
  "kind": "architecture",  // which artifact this is: "architecture" | "board"
  "updatedAt": 1749600000000, // epoch ms of the last write (provenance, not load-bearing)
  "data": { /* ArchDoc or BoardData, exactly the in-app shape; `data.version` self-versions the payload */ }
}
```

**One envelope version, and the payload self-versions.** The wrapper carries a single
`conduit` version (bumped only if the *wrapper* shape changes). The payload's own
schema version lives where it already does — `data.version` (`ArchDoc.version`,
`BoardData.version`) — so it is **not duplicated** at the envelope level. (An earlier
draft carried a mirrored `schema` field; it was dropped because a copied version
number drifts out of sync with `data.version` and forces a "which wins" rule. If
envelope-level schema routing is ever needed, derive it from `data.version`.)

A reader that doesn't recognize the `conduit` version, or the `data.version`, must
**degrade gracefully** (fall back to the domain `restore*` defaults) rather than
throw — the same posture the existing `restoreBoard` / `restoreArchitecture` take.

#### 2a. `.conduit/architecture.json` (kind `architecture`)

Payload is `ArchDoc` (unchanged): a `rootGraph` id plus a `graphs` map, each graph a
`{ id, title, nodes[], edges[] }`. Nodes carry an `ArchKind`, a position, optional
`subtitle` / `description` (the LLM-readable prose), and an optional `childGraph` for
drill-down. Example:

```jsonc
{
  "conduit": 1,
  "kind": "architecture",
  "updatedAt": 1749600000000,
  "data": {
    "version": 1,
    "rootGraph": "graph-root",
    "graphs": {
      "graph-root": {
        "id": "graph-root",
        "title": "Conduit",
        "nodes": [
          {
            "id": "n-ui",
            "title": "UI / Renderer",
            "subtitle": "React webview",
            "description": "Monaco + xterm; holds no source of truth.",
            "kind": "frontend",
            "x": 80, "y": 80
          },
          {
            "id": "n-core",
            "title": "Core / Host",
            "subtitle": "Electron main",
            "kind": "service",
            "x": 380, "y": 80
          }
        ],
        "edges": [
          { "id": "e1", "source": "n-ui", "target": "n-core", "label": "IPC" }
        ]
      }
    }
  }
}
```

Stable ids (`n-ui`, `e1`, graph ids) are the contract: an agent references a node by
id to propose an edit, and ids must survive a round-trip. `description` is the field
an agent writes prose into.

#### 2b. `.conduit/board.json` (kind `board`)

Payload is `BoardData` (unchanged): a flat `cards[]`, each `{ id, title, notes,
stage, links?, createdAt?, updatedAt? }`. The `notes` field is the free-text an agent
or human writes; `links` holds **external URLs**. A card's spec is *not* a link — it
is `specs/<card-id>.md`, derived from the card id (see §2c). Example:

```jsonc
{
  "conduit": 1,
  "kind": "board",
  "updatedAt": 1749600000000,
  "data": {
    "version": 1,
    "cards": [
      {
        "id": "card-abc",
        "title": "Project-wide go-to-definition",
        "notes": "Needs the Monaco TS language worker.",
        "stage": "wishlist",
        "links": ["https://example.com/issue/42"],
        "createdAt": 1749500000000,
        "updatedAt": 1749500000000
      }
    ]
  }
}
```

#### 2c. `.conduit/specs/<card-id>.md` (G3)

Plain markdown, one file per card, named by the card's stable id. No envelope —
markdown is its own format and humans/agents both read it natively. The link from card
to spec is **the filename**: card `card-abc` ⇒ `specs/card-abc.md`. No stored link is
needed (or used) to find it. A missing spec file = the card simply has no spec yet
(not an error).

### 3. Source of truth & ownership — **human-owned, agent-proposes**

This is the load-bearing decision.

**`.conduit/` is human-owned source of truth that the agent CONFORMS to. The agent
does NOT blindly overwrite it.** The committed files are the canonical artifacts; the
human edits them through the Conduit app (or by hand), and that is the truth.

An agent that wants to change the architecture or board does **not** rewrite the file
out from under the human. Instead it goes through an **explicit suggest → human
accepts** flow. The human editing in-app writes the canonical file directly (they *are*
the owner); the agent only proposes.

**The concrete proposal mechanism shipped in N1 (2026-06-12).** The candidate this ADR
floated is now the implemented design: the agent writes its proposed change to a sibling
`*.proposed.json` envelope (`.conduit/board.proposed.json`,
`.conduit/architecture.proposed.json`) — a *normal* canonical envelope, just under a
proposal filename, so no new `kind` was added to the persistence layer (the foundation's
deliberate openness paid off). The app detects it via the existing `.conduit/` watcher
(now also watching the `*.proposed.json` siblings), surfaces it as a **diff against the
canonical doc** (a banner on both the board view and the architecture canvas), and lets
the human **accept** (apply the proposed whole document → write canonical atomically,
delete the proposal) or **reject** (delete the proposal). Acceptance is the only path that
writes the canonical file from agent intent. Apply is **whole-document + id-stable**
(§4): the proposed `data` replaces the canonical `data` verbatim — no merge — so a clean
diff is purely a function of stable ids surviving the round-trip.

Concretely, N1 added:
- `src/conduit-proposal.ts` — the **pure, unit-tested** board + architecture diffs
  (added / removed / moved / edited cards; added / removed / edited nodes & edges).
- `electron/conduit-fs.ts` — `proposalPath`, `readBoardProposal` / `readArchitectureProposal`,
  and `acceptProposal` / `rejectProposal` (accept reuses the atomic `writeAtomic` helper +
  surfaces errors; reject just deletes the sibling).
- `electron/proposal-watcher.ts` — a live watch on the `*.proposed.json` siblings, sharing
  the debounce/`fs.watch` plumbing with the board watcher via `electron/conduit-dir-watch.ts`.
- IPC (`src/protocol.ts`): `requestProposal` / `acceptProposal` / `rejectProposal` →
  `proposal` replies; banner UI in `board-view.tsx` + `architecture-view.tsx`.

What this ADR Accepted — the *ownership principle* (human-owned,
agent-proposes-never-overwrites) — is unchanged; N1 lands the *plumbing*.

**Trade-off considered and rejected — "agent overwrites, file is a snapshot."** The
simpler model is: the agent regenerates `architecture.json` from the code on each run
and the file is just a cache of the agent's latest view. We reject it because:

- The diagram's **layout** (node `x`/`y`, which slices are grouped, drill-down
  structure) and the board's **human curation** (what's a wishlist vs. building, the
  notes) are *human judgment the agent cannot reconstruct*. Blind regeneration
  destroys it on every run.
- It makes the artifact adversarial to edit: any human change is one agent run away
  from being clobbered, so humans stop trusting / editing it, and it rots.

The cost of "human-owned, agent-proposes" is a **review step** (proposals don't
auto-apply) and a little extra plumbing (the proposal envelope + a UI affordance).
That cost is acceptable: it's exactly the cost that keeps human intent authoritative.

**Coexistence with the existing shared root `board.json`.** The current root
`board.json` is shared mutable state with the external overnight agent, which edits
it *directly* (no proposal flow) — it does not know about `.conduit/`. We therefore
**do not migrate or delete the root `board.json` in this foundation work.** The two
coexist:

- The root `board.json` (Conduit's *own* repo) stays the overnight agent's
  direct-write surface, exactly as today. Untouched by this ADR.
- `.conduit/board.json` is the **per-opened-project** board for *other* repos Conduit
  describes, under the human-owned/agent-proposes contract.
- G0 will decide whether/how to converge Conduit's *own* board onto `.conduit/`.
  That migration is **explicitly deferred**: it must reconcile the overnight agent's
  direct-write expectation with the proposal flow, which is a behavior change, not a
  file move. Options to weigh in G0: (a) teach the overnight agent the proposal flow;
  (b) exempt Conduit's own repo and keep root `board.json` as the agent surface; (c)
  symlink/dual-write during a transition. This ADR only ensures the *format* and
  *persistence layer* are ready; it does not force the migration.

### 4. Agent read/write contract

How an agent uses `.conduit/` (concrete, but a proposal F0/G0 can refine):

**Read.** To understand the system, an agent reads `.conduit/architecture.json`,
parses the envelope, and walks `data.rootGraph` → `data.graphs`. Node `title` +
`subtitle` + `description` and edge `label`s are the natural-language layer it reasons
over; `kind` gives the architectural category. It reads `.conduit/board.json` for the
work backlog and follows a card's `links` into `.conduit/specs/<id>.md` for detail.
If a file is absent or unparsable, the agent treats it as "no diagram / empty board
yet," never as an error.

**Write (propose).** The agent never writes the canonical file. It:
1. Reads the canonical artifact (to base its change on the current truth).
2. Produces a full, valid envelope payload with its change applied, **preserving
   every id it didn't intend to change** (ids are the diff anchor) and **preserving
   node positions** it isn't deliberately moving.
3. Writes it to the sibling `*.proposed.json`.
4. Stops. The human reviews & accepts/rejects in-app.

The contract is deliberately *whole-document* (propose the full next state), not a
patch language: it reuses the existing pure ops in `src/architecture.ts` /
`src/board.ts`, keeps validation in one place (`restore*`), and sidesteps a bespoke
patch format. Id stability is what makes a whole-document proposal diff cleanly.

### 5. Persistence foundation (this task)

Pure, testable schema/migration logic lives in `src/conduit-store.ts`; host FS wiring
lives in `electron/conduit-fs.ts`. The split mirrors the existing
`src/board.ts` (pure) ↔ `electron/main.ts` (FS) seam, so it's unit-testable without
Electron.

`src/conduit-store.ts` (pure):
- `wrap(kind, data)` / `serializeArtifact(kind, data)` — build + stringify an
  envelope around an `ArchDoc` or `BoardData`.
- `readArchitectureArtifact(blob)` / `readBoardArtifact(blob)` — parse an envelope
  blob and return the validated payload, with **`.conduit/`-appropriate** defaults
  when the blob is missing/invalid/unrecognized-version:
  - architecture: absent returns `null` (like `restoreArchitecture`) — the caller
    seeds if it wants to.
  - board: absent returns an **empty board** `{ version, cards: [] }` — **not**
    `seedBoard()`. `seedBoard()` hard-codes Conduit's *own* F1–F9 backlog and is
    valid only for Conduit's install-relative root `board.json`; auto-seeding it into
    an arbitrary opened project's `.conduit/board.json` would inject Conduit's
    features into a foreign repo's board. `seedBoard()` stays bound to the root board.
- Tolerates a **bare (un-enveloped) payload** — if the blob is a raw `ArchDoc` /
  `BoardData` (no `conduit` wrapper), it still restores it. This is the back-compat
  bridge from today's bare `architecture.json` / `board.json` to the enveloped form.

`electron/conduit-fs.ts` (host FS):
- `conduitDir(projectRoot)` / `conduitPath(projectRoot, ...parts)` — resolve
  `<projectRoot>/.conduit/...`.
- `readArtifact(projectRoot, kind)` — read + parse, graceful default if absent.
- `writeArtifact(projectRoot, kind, data)` — **mkdir -p** `.conduit/`, then **write
  atomically** (write to a temp file in the same dir, then `rename` over the target)
  so a crash mid-write never leaves a truncated artifact that the next read (and the
  committing human) sees. **Write errors must be surfaced, not swallowed** — the
  function rejects on `EACCES` / `ENOSPC` / `EROFS` etc. so a failed save cannot be
  silently mistaken for success. (This is a deliberate departure from the existing
  `fs.writeFile(boardFile(), …, () => {})` in `electron/main.ts`, whose empty callback
  discards every write error; for a *committed, reviewed* artifact "thinks it saved and
  didn't" is the realistic failure, so F0/G0's IPC consumers must propagate the
  rejection, not re-swallow it.)

This task wires **none** of the UI. F0/G0 consume this API.

### 6. Resolution path

`.conduit/` resolves at the **opened project's root** — the `projectRoot` the
renderer already sends for architecture (`m.path`) — joined with `.conduit`. This is
the same resolution the current per-project `architecture.json` uses, just one
directory deeper. It is **not** `__dirname/../.conduit` (that would pin every
project's knowledge to the Conduit install dir, which is wrong); only Conduit's *own*
legacy root `board.json` uses the install-relative path, and that stays as-is.

## Consequences

- **One well-known home** for project knowledge: an agent reads `.conduit/` and knows
  the architecture, the backlog, and the specs without bespoke discovery.
- **Human intent is authoritative.** Layout, curation, and notes survive agent runs
  because the agent proposes rather than overwrites. The cost is a human review step
  and a proposal envelope — accepted deliberately.
- **The existing shared root `board.json` is untouched.** The overnight agent's
  direct-write workflow keeps working; convergence is G0's explicit, deferred call.
- **Single envelope version + self-versioning payload** keep the wrapper and the
  domain schemas evolvable without a duplicated, drift-prone version field; unknown
  versions degrade to defaults rather than throwing.
- **Bare-payload tolerance** gives a zero-friction migration from today's
  un-enveloped `architecture.json` to the enveloped `.conduit/architecture.json`.
- **Atomic writes that surface errors** mean a committed `.conduit/` artifact is never
  a half-written file *and* a failed save is never silently mistaken for success —
  both matter precisely because the artifact is committed and reviewed.
- **The board never auto-seeds Conduit's own backlog** into a foreign project; absent
  `.conduit/board.json` is an empty board, so the layer is safe to point at any repo.
- **Shipped in N1 (2026-06-12):** the proposal mechanism itself — the `*.proposed.json`
  sibling, its watch/read/accept/reject path, the pure diffs, and the accept/reject review
  banner on both surfaces (§3). The foundation's canonical-envelope openness meant N1 added
  **no new envelope `kind`**: a proposal is a normal envelope under a proposal filename.
- **Still deferred / for G0:** the Conduit-own-board convergence (whether the overnight
  agent's direct-write root `board.json` adopts the proposal flow, stays exempt, or
  dual-writes during a transition). N1 does not touch the root `board.json`.
