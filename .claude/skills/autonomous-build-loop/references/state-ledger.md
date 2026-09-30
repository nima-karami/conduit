# The state ledger

The plan and progress live on disk, not in the conversation, so the run survives
compaction, interruption, and resumption. After any compaction or restart the conductor
**re-reads this ledger before acting** — it is the single source of truth, above any
recollection. No run in the field has been lost to compaction where this convention was
followed.

Put the machine run-state in `./.autoloop/` at the repo root and **add it to
`.gitignore`** — it's transient run-state, not a committed artifact. Keep entries terse
and machine-greppable. (Human-readable artifacts go under `docs/`, not here — follow the
repo's docs convention if it has one; default: specs → `docs/specs/YYYY-MM-DD-<slug>.md`
(date-prefixed; archived on ship), plans → `docs/plans/YYYY-MM-DD-<slug>.plan.md`, run
artifacts → `docs/runs/YYYY-MM-DD-<name>/`. See `references/composition.md`.)

Keep the ledger lean — the conductor re-reads it every pass, so every file is a
recurring token cost. Six files, no more:

## Files

| File | Holds | Re-read on resume |
|---|---|---|
| `goal.md` | The real, user-visible outcome the wishlist serves (one paragraph) + the Phase 0 gate commands + the **run config** (below). The thing the finished set is checked against. | yes |
| `tasks.yaml` | One entry per item: id, outcome, tier, topology, deps, gates, evidence, verdicts, commit, status, notes. The work queue — and the dependency graph lives here in `deps` (no separate plan file). | yes |
| `evidence/` | Gate logs with their exit codes, run output, screenshots, QA reports — the proof an item passed. | on demand |
| `blockers.md` | Quarantined/infeasible items + queued high-severity decisions + **recorded user waivers with their stated risk**, each with what would unblock it. Surfaced in the final report. | yes |
| `gate-baseline.txt` | Phase 0 snapshot (hashes) of the gate definitions — test/lint/CI config and existing test files — diffed at integration to detect weakened gates. | on demand |
| `learnings.md` | Tagged process bullets appended per item: `[<skill-name>]`, `[<doc path>]`, `[instruction-file]`, `[memory]`, `[none]`. Untagged bullets can't be routed by a retro. Code debt goes to the repo's debt file, not here. | no |

No `plan.md` (the graph is `tasks.yaml`'s `deps`), no `changelog.md` (version-control
history records what changed), no `defects.md` (a failed gate goes in that item's `notes`).

## Run config (recorded once in `goal.md`, never re-asked)

Fix these at kickoff so the loop is deterministic across compaction and resume — the
conductor reads them, it does not re-prompt mid-run:

- **`mandate`** — the run's real stop condition: a time budget, a scope budget, or both
  (e.g. *"until 08:00, or until the review backlog is empty, whichever is later"*). The
  loop checks the mandate before it stops. **An emptied self-made queue is not
  completion** — with mandate remaining, run a discovery refill (SKILL.md Step 6) and
  log it here.
- **`conductor_tier`** — the tier the run was started on. The loop stays on it; it never
  auto-escalates to a "strongest available" tier. Executors run at or below it, never
  above. See `references/model-tiers.md`.
- **`waivers`** — anything the user instructed that relaxes normal cadence (e.g. "no gate
  between tasks"), each with the risk it carries. A waiver is a recorded decision, not a
  rule change: the integration gate runs regardless, and no executor may invoke a waiver
  to skip a check.
- **`refills`** — an appended log of each discovery pass run after the queue emptied:
  what was swept, what it added. Empty at kickoff.

`execution_mode` is **not** run config. Topology is chosen per item from the plan's
`GROUPS:` and `CLAIMS:` lines and recorded in that item's entry — defaulting a whole run
to delegated was overridden by hand in four field runs because it re-pays exploration
context per executor for no parallelism.

## `tasks.yaml` shape

```yaml
- id: slugify
  outcome: "Exported slugify(str) producing URL-safe slugs per spec"
  tier: LITE                     # SKIP | LITE | FULL, from feature-spec; gates the front of the pipeline
  topology: solo                 # solo | delegated, chosen from the plan's GROUPS/CLAIMS
  topology_reason: "no plan (LITE); single surface"
  deps: []                       # ids that must be done first; [] = independent
  status: todo                   # todo | in_progress | done | blocked | needs-human-smoke
  gates:                         # executable; each must pass, exit code captured directly
    - "<unit test command for this item>"
    - "<lint command>"
  evidence:
    - ".autoloop/evidence/slugify-test.log"    # includes the captured exit code
  review: ""                     # APPROVE | REVISE + blocker count, from Phase 4
  qa: ""                         # pass | fail | partial + report path, from Phase 5
  commit: ""                     # set at Phase 6; the SHA is proof the work is committed
  notes: ""                      # last defect on a failed attempt; retry context

- id: api
  outcome: "Move endpoint persists ordering and enforces auth"
  tier: FULL
  topology: delegated            # plan showed 3 file-disjoint groups, no claim overlap
  topology_reason: "GROUPS: 3; CLAIMS: none intersecting"
  plan: "docs/plans/2026-09-02-move-endpoint.plan.md"
  deps: [schema]                 # runs only after schema is done -> sequential
  status: todo
  gates:
    - "<integration test command>"
    - "runtime: move an item in the running app; order persists after reload"
  evidence:
    - ".autoloop/evidence/api-test.log"
    - ".autoloop/evidence/api-runtime.txt"
  review: "APPROVE (0 blockers)"
  qa: "pass docs/runs/2026-09-02-backlog/qa/api.md"
  commit: "a1b2c3d"
  notes: ""
```

## Status semantics

- `todo` → ready when every id in `deps` is `done`.
- `in_progress` → an executor is working it (or was, pre-compaction; on resume, treat a
  stale `in_progress` as todo and re-verify rather than trust it).
- `done` → gate green with a captured exit code, **review APPROVE**, a runtime verdict
  for anything user-facing, the listed evidence files exist, and a `commit` SHA is
  recorded on a merged tree that passed the integration gate. Verified-but-uncommitted
  is not done; merged-but-not-re-gated is not done.
- `needs-human-smoke` → verified only against a mock/preview, or a genuinely undriveable
  boundary (physical device, irreversible paid side effect). **Not** `done` — surfaced in
  the report. Never used for "we skipped setting up end-to-end QA."
- `blocked` → quarantined after the retry limit, or genuinely infeasible. Has an entry in
  `blockers.md` **naming the blocker**. "Resource-mindful" and "didn't want to break
  things" are not blockers; a deferral without a named blocker is satisficing.

The `notes` field carries the last failure's defect so a retry (fresh executor) has the
context without a separate defects file.

## Gate kinds (layer them)

A single passing unit test is weak proof. Where the item warrants it, combine:

- **Executable check** — a command that exits non-zero on failure, with **the exit code
  captured directly into the evidence file, never through a pipe or pager**. A red gate
  was reported green twice because the pager's exit code was read instead.
- **Regression check** — the pre-existing suite stays green (catches collateral
  breakage), run without concurrent executor load.
- **Runtime proof (required, not optional)** — drive the **real running artifact** and
  record what it actually did: a UI change captures rendered state / console; a
  CLI/service captures real output / exit code / response. Unit tests passing without
  this is the exact gap that ships blank screens and dead buttons that "pass."
- **Independent review** — a read-only pass over the diff by an agent that did not write
  it and is not shown the author's reasoning. Not substitutable by the author's own
  confidence.
- **Anti-gaming check** — diff the current gate definitions against `gate-baseline.txt`;
  a weakened, narrowed, deleted, or mocked-out existing gate fails the item. Newly added
  tests are fine. Byte-level corruption (a stray NUL, a BOM, mixed line endings) passes
  every ordinary gate — it is the reviewer's job, not the suite's.
