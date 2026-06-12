# ADR 0003 — Documentation layout and lifecycle

Date: 2026-06-12
Status: Accepted

## Context

Conduit's docs were built largely by autonomous build-loops over several nights,
and the tree drifted into two problems:

1. **Two parallel spec systems with different conventions.** `docs/specs/` held 68
   flat, slug-only files with no dates and `*.plan.md` siblings interleaved, while
   `docs/superpowers/specs/` + `docs/superpowers/plans/` held a second set using a
   clean `YYYY-MM-DD-<slug>` convention. Neither namespace was canonical.
2. **No lifecycle distinction.** A spec for a shipped feature is a write-once
   historical record, but it sat in the same flat folder as anything active, with
   terse names (`close-all-others.md`) giving no signal of age or status. Run
   artifacts (audits, build reports, retrospectives) were scattered across three
   single-file type-folders (`docs/audits/`, `docs/builds/`, `docs/retrospectives/`).

The folder also keeps growing — two nights produced ~93 spec/plan files. Three
read-only research passes (industry doc conventions; AI-agent context hygiene;
spec lifecycle/archiving) converged on a clear answer, summarised in the decision
below. The load-bearing finding: a growing spec corpus does **not** automatically
pollute an agent's context (Claude Code reads on demand, and unreferenced docs are
read in <10% of sessions), but it becomes a real liability the moment a broad glob,
a "read the specs" instruction, or RAG pulls it in — and near-duplicate/superseded
specs are the worst-case distractors (Chroma "Context Rot"; Liu et al. "Lost in the
Middle"; the ETH Zurich AGENTS.md study). Archiving shipped specs out of the default
path neutralises that risk for near-zero cost.

## Decision

A single documentation layout, enforced by a short "Docs layout" section in
`CLAUDE.md`:

```
docs/
  adr/        NNNN-slug.md         durable decisions (low volume; sequential number is a stable ID)
  specs/      YYYY-MM-DD-slug.md   feature design docs, currently active
    INDEX.md                       the canonical manifest (active + archived)
    archive/                       implemented/superseded specs (kept, out of the default path)
  plans/      YYYY-MM-DD-slug.plan.md   implementation/backlog plans (time-bound)
  runs/       YYYY-MM-DD-<name>/   one folder per build run: report.md, audit.md, retro.md together
CHANGELOG.md                       user-facing changes (Keep a Changelog), at the repo root
```

Conventions:

- **Specs and plans are date-prefixed**, not sequentially numbered. The repo is
  built by *parallel* agents; a global spec counter would force serialization and
  race on the next number. Dates need no central counter and answer "which run".
- **ADRs keep sequential `NNNN` numbering** — they are low-volume, single-author,
  and the stable `ADR-0003` identity is worth more than a date in cross-references.
- **Specs vs ADRs vs plans are kept separate** — they answer different questions
  (*what/how* we build vs *why* we decided vs *the steps*), with different lifetimes
  and mutability. `*.plan.md` files no longer live among specs.
- **New specs carry frontmatter** (`status: active|implemented|superseded`, `date:`,
  optional `supersedes:`) and a row in `docs/specs/INDEX.md`. Status lives in
  frontmatter, never the filename.
- **On ship, a spec moves to `docs/specs/archive/`** (via `git mv`, preserving
  history) and its INDEX row moves to the Archived table. The active `docs/specs/`
  root stays small.
- **`CLAUDE.md` points at the index; it never inlines "read all the specs"** — that
  would recreate the context-sprawl failure the research warns about.

The existing ~93 historical specs/plans were migrated in one pass: slug-only specs
were date-prefixed from their git add-date and moved to `archive/`; `*.plan.md`
files moved to `docs/plans/`; the `docs/superpowers/` subtree was folded into the
canonical namespace; and the three run-artifact folders collapsed into `docs/runs/`.
Historical archived specs were **not** retro-fitted with body frontmatter (low value,
high churn — they are out of the default path); the INDEX and dated filename carry
their metadata. The convention applies to active and future specs.

## Consequences

- One canonical place and naming for each doc type; the active spec set is small and
  legible, and history is preserved in `archive/` and git.
- A growing spec history no longer risks polluting agent context, because archived
  specs sit outside the default discovery path and nothing references them wholesale.
- The build-loop gains a fixed contract: write a dated, frontmatter'd spec in
  `docs/specs/`, add an INDEX row, and `git mv` it to `archive/` on ship.
- Cost: a one-time large rename commit (history-preserving), and the loop must be
  taught the new paths. Some inbound references to old paths were updated; any missed
  ones resolve via git history.
