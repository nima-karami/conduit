# Composition playbook

Per phase: **what to pass in, what to capture, how to route it, and how to keep it
autonomous.** Every stage emits a machine-parseable handoff block — capture it
**verbatim** into the item's ledger entry and route from the block, not from the
stage's prose. A phase that produced no handoff block did not run.

Stage skills are invoked inside fresh-context subagents wherever they support it, so
heavy reads don't pollute the conductor thread. The conductor holds only the ledger and
the loop.

**Route by tier** (`feature-spec`'s `TIER:`), per item:

- **SKIP** → Phase 3 directly. The request plus its stated assumptions is the task.
- **LITE** → Spec → Phase 3. No plan, no design review.
- **FULL** → Spec → Phase 2 plan → Phase 2b (only when new structure/boundaries) →
  Phase 3.

Phases 4 (review), 5 (runtime QA) and 6 (integrate) run for **every** tier; LITE runs
the lite gates ("Route each item by tier" in SKILL.md). Right-sizing never removes a gate.

**Where artifacts land** (keep them consistent — a long run otherwise sprawls into a
tree that needs manual cleanup). Follow the repo's existing docs convention if it has
one; otherwise default to:

- Machine run-state → `./.autoloop/` at repo root, **gitignored** (transient).
- Specs → `docs/specs/YYYY-MM-DD-<slug>.md`. **Date-prefix, don't sequentially
  number** — parallel agents race on the next number; dates need no central counter.
  On ship, move the spec to `docs/specs/archive/` so the active set stays small.
- Plans → `docs/plans/YYYY-MM-DD-<slug>.plan.md` (a **separate** dir, not interleaved
  with specs).
- Run artifacts (report, evidence, QA reports, learnings, retro) → one folder per run:
  `docs/runs/YYYY-MM-DD-<name>/`.

## Phase 0 · Ground the repo — `solidify-repo`

- **When:** once, at the start, before any feature work.
- **In:** the target repo, plus the unattended signal — `solidify-repo` normally asks
  for per-category approval, so it must run promptless here: record would-be approval
  choices as assumptions in `blockers.md` rather than waiting.
- **Capture:** the resulting gate command(s) (test / lint / typecheck / security /
  runtime harness) into `goal.md`. These commands ARE the executable definition of done.
- **Pin the gate baseline:** snapshot the gate definitions (hash the test/lint/CI config
  and existing test files) into `gate-baseline.txt` now, so every later phase has a
  fixed baseline to diff against when checking that gates weren't weakened.
- **Stand up the end-to-end / observation harness.** `solidify-repo` establishes
  unit/lint/security gates and a verify command — it does **not** by itself give you a
  way to drive and *watch* the running artifact. Ensure one exists: for a UI, a
  browser/UI automation tool that launches the app and captures what renders
  (screenshots, DOM, console, exit state); for a CLI/service/library, invoke it for real
  and capture output / exit code / response / generated files. The concrete tool comes
  from `solidify-repo`'s tooling reference. Wire it into the chain so Phase 5 can produce
  observation evidence.
- **Re-audit, don't assume.** A repo solidified in an earlier run is not solidified now
  — gates rot (checks quietly made non-gating, warnings drifting up, a suite excluded
  from CI). Re-run the audit; record a decision to skip only against evidence, never
  against memory.
- **Gate (hard refusal):** after this phase the repo must have both (a) runnable
  deterministic checks and (b) a way to run and observe the real artifact end-to-end.
  If either is missing and can't be stood up, **stop and report — do not run the loop
  unit-tests-only.**

## Phase 1 · Spec each item — `feature-spec` (autonomous mode)

- **In:** one wishlist item at a time, with an explicit signal that this is an
  unattended pipeline so it runs autonomously and does not ask questions.
- **Out (capture verbatim):**
  ```
  SPEC: <path>
  TIER: SKIP|LITE|FULL
  DECISIONS_NEEDED: <n>
  ```
- **Route:** `SKIP` / `LITE` → Phase 3. `FULL` → Phase 2. Any `high`-severity entry in
  `DECISIONS_NEEDED` → copy into `blockers.md` as a queued decision (do not halt).
- **Scope check the conductor owns:** a spec that scopes a *consumer* without its
  *producer* is the highest-cost spec defect in the field. If the item changes when or
  how something is consumed, confirm the spec says what that does to the producer.

## Phase 2 · Plan — `implementation-plan` (FULL only)

- **When:** FULL items only. A LITE spec is directly implementable; a second planning
  pass restates it at lower fidelity, which is over-production.
- **In:** the spec from Phase 1, plus the locked decisions carried with it.
- **Out (capture verbatim):**
  ```
  PLAN: <path or "inline">
  TIER: SKIP|LITE|FULL
  SLICES: <n>
  GROUPS: <n>
  CLAIMS: <comma-separated exclusive paths>
  SCRIPT_CANDIDATES: <n>
  ```
- **Route:** `GROUPS` and `CLAIMS` decide the topology (see "Right-size the topology" in
  SKILL.md) — one group, or claims naming shared entry files, means **solo**. `PLAN:
  inline` with `TIER: SKIP` means the plan stage self-skipped as over-production; record
  the skip and go to Phase 3 with the spec.
- **Capture** the plan path and the groups/claims lines into the item's entry; the
  scheduling decision is made from them, not from the prose.

## Phase 2b · Design review — `architecture-critic` (FULL + novel structure)

- **When:** **only** FULL items that introduce genuinely new structure, cross-cutting
  boundaries, or non-trivial data/failure modeling. A routine FULL item (a CRUD settings
  page) does not need an adversarial design review — skip it and record the skip. This
  phase is the exception, not the norm.
- **In:** the spec and the plan.
- **Capture:** verdict + blockers. A REVISE verdict with blockers → loop the plan once
  with the feedback before building; if still blocked after one revision, quarantine and
  move on.
- **Big ambiguous bets:** a large new subsystem or a brief that is analogies rather than
  a spec does not auto-land on the mainline. Build it thin and reversible on a
  disposable branch and surface the open product decisions in the report. A throwaway
  branch you can discard beats a polished version of the wrong thing merged.

## Phase 3 · Build — `build-and-verify`

- **In:** FULL → the plan; SKIP/LITE → the spec (or the request plus its assumptions)
  directly. Plus: the pinned gate commands, the topology decision, the concurrency cap,
  the executor tier, and the run's learnings file path.
- **Out (capture verbatim):**
  ```
  BUILD: <branch>@<sha>
  GATE: pass|fail <exit code> <command>
  RUNTIME_PROOF: <path | "none: <reason>">
  E2E_RESULT: <result path> @ <sha> | "none: <reason>"
  DEVIATIONS: <n>
  LEARNINGS: <path>
  ```
- **This phase owns** workspace isolation (isolated worktree vs in-place, with the
  hazard list), parallel dispatch from the plan's groups, red-first tests, the deviation
  rule, the plan-fidelity diff, attribution before blame, the done-claim gate, and the
  commit. **Do not re-specify any of that from the loop** — pass the inputs and read the
  block.
- **Conductor checks on the block, before Phase 4:**
  - `BUILD` carries a real SHA. Uncommitted work is not done.
  - `GATE` carries an exit code the conductor can verify — re-run the gate yourself, or
    read the exit code captured in the evidence file. Never relay the executor's claim.
  - `RUNTIME_PROOF: none` for a user-facing change is a failed handoff, not an item to
    wave through.
  - `DEVIATIONS > 0` → read each one; a deviation that quietly re-litigated a locked
    decision is a defect, not an improvement.
  - `E2E_RESULT` names the e2e run this SHA was judged on. Phases 4 and 5 at the same
    SHA cite it rather than re-running; its `@ <sha>` must equal `BUILD`'s.
- **Route:** a failed gate → the defect goes into the item's `notes` and the item
  retries up to the limit, then quarantines. Otherwise → Phases 4 and 5, dispatched
  together on this SHA.

## Phase 4 · Review — `code-review` (gate, every item)

- **In:** the diff range, the plan, the spec, and the tree. Fresh context, read-only,
  **never the author**, and never shown the author's narration of why the change is
  correct.
- **Out (capture verbatim):**
  ```
  REVIEW: APPROVE|REVISE
  BLOCKERS: <n>
  FINDINGS: <n>
  E2E_RESULT: <result path> @ <sha> | "none"
  ```
- **Route:** `REVISE` → back to Phase 3 with the findings, counting against the retry
  limit. `APPROVE` → wait for Phase 5's verdict on the same SHA. LITE gets one review
  round: its findings are fixed and re-gated, not re-reviewed.
- **Why it is a gate and not an option:** independent per-item review has an unbroken
  field record of finding real defects that green gates missed. It costs one fresh
  subagent; a shipped defect costs a run.

## Phase 5 · Runtime QA — `runtime-qa` (gate, any user-facing change)

- **In:** the build under test (branch@sha), the spec's user-facing acceptance criteria,
  and how to launch the artifact. Point it at the run's evidence dir.
- **Out (capture verbatim):**
  ```
  QA: <report path>
  BUILD_UNDER_TEST: <repo> <branch>@<sha>
  VERDICT: pass|fail|partial
  NOT_COVERED: <list or "none">
  E2E_RESULT: <result path> @ <sha> | "none"
  ```
- **When:** dispatched with Phase 4, not after it. LITE items run it only when
  user-visible behaviour changed.
- **Route:** `fail` → Phase 3 with the observations, against the retry limit. `partial`
  → the uncovered criteria go to the report; if the uncovered part is the item's point,
  it is `needs-human-smoke`, not `done`. A genuinely undriveable boundary (physical
  device, irreversible paid side effect) is `needs-human-smoke`; "we didn't set up the
  harness" never is.
- **`BUILD_UNDER_TEST` must match the `BUILD` SHA from Phase 3.** QA against a stale
  build is not evidence.

## Phase 6 · Integrate — the loop itself (never delegated)

Not a stage skill. An executor cannot be the one to decide the integrated tree is green.

1. **Precondition:** `REVIEW: APPROVE` and a passing runtime verdict for anything
   user-facing, both on the recorded commit SHA.
2. **Merge one branch at a time**, into a tree you control. Resolve conflicts yourself —
   a conflict resolution is a code change nobody reviewed.
3. **Re-run the full gate on the integrated tree**, with no concurrent subagent load,
   exit code captured directly. This is what catches cross-item breakage no item's own
   gate can see.
4. **Advance the mainline only on green.** Never advance on an unverified merge.
5. **Diff the gate definitions against `gate-baseline.txt`.** Any weakened, narrowed,
   deleted or mocked-out existing check fails the item, however green the run was. Newly
   added tests are fine.
6. **Record** the merge SHA, mark the item `done`, unblock its dependents. If the user
   waived the between-task gate, this step still runs — the waiver is a recorded
   decision, not a rule change.
7. On red: revert or quarantine the merge, record the defect, and keep the mainline
   green. A red mainline blocks every remaining item.

## Keeping it autonomous

- Pass every stage skill the context that it is part of an **unattended** pipeline, so
  skills with an autonomous mode use it and do not block on questions.
- Anything a skill would normally ask a human → it records as an assumption / queued
  decision; the conductor copies high-severity ones to `blockers.md` and continues.
- After each item, append the stage's tagged learnings bullets to the run's learnings
  file. Untagged bullets can't be routed by a retro and are wasted.
- The loop never stops for input. It stops only when every item is `done` or `blocked`
  **and** the mandate in `goal.md` is spent — an emptied queue with mandate remaining
  triggers a discovery refill, not a stop.
