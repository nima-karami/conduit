---
name: autonomous-build-loop
description: Use when driving a whole backlog/wishlist of features to completion in one long or unattended run — multiple features that each need specifying, implementing, and verifying with no human to babysit; a run expected to exceed a single context window (compaction will happen) or span sessions; a long-running/overnight agent that must keep rolling on its own without stopping early, dropping subtasks, faking progress, or declaring "done" on its own say-so. Keywords - wishlist, backlog grind, build all of these, autonomous loop, unattended, long-horizon, overnight run, kick off and walk away, agent went lazy / satisficed / premature completion.
allowed-tools: Read, Glob, Grep, Agent, Write, Edit, Bash, Skill
---

# Autonomous Build Loop

Drive a list of features to **verified** completion in one long autonomous run.

> Conduit's fork of the global `autonomous-build-loop` skill (2026-09-30), wired to this repo's
> gates. It shadows the global skill inside this repo; the global copy is unchanged.

## Core principle

You are the **conductor**, not the whole orchestra. This skill starts a run, reads the
wishlist, and keeps it rolling — the work of each stage belongs to a dedicated skill.
Do not reinvent spec-writing, repo hardening, planning, workspace isolation, test-first
building, review, or runtime QA inline. Invoke the stage skill and route its handoff
block.

Two things stay yours as conductor: the **loop** (select → route → build → gate →
integrate → record → repeat until done-or-blocked) and the **state ledger on disk**
that lets the run survive compaction and resume. Everything else delegates.

**The conductor is the model you started on; delegate sideways or down, never up.**
The conductor's judgment is the scarce resource, so don't spend it typing boilerplate.
What is **non-delegable**: the **architecture** (boundaries, where a feature lives,
which abstraction earns its keep) and the **taste** calls (API shape, UX, naming, what
"good" looks like). Executors build to the spec and plan the conductor approved; they
never make an architecture or taste call. An executor that hits a genuine design fork
records it as a queued decision for the conductor; it never resolves it inside its
workspace.

**Honest scope.** A strong model already finishes and self-verifies a small, in-context
build well — there it needs no protocol. This one earns its keep when the run is too
long or too many-featured to hold in one context, where working memory degrades over
hours or sessions. Its value is **composition, resumability, right-sizing, and a
verified stop condition** — not making the model "try harder."

**You must be able to *see* what you built.** Unit tests are necessary and not remotely
sufficient. A loop that can only read green unit output will confidently ship software
it never looked at — the feature "passes" while the app is blank, the button does
nothing, the layout is broken. So the loop is built around **driving the real running
artifact and observing its actual output**. For anything with a UI that means a tool
that renders it and captures what a user would see; for a CLI/service/library it means
invoking it for real and capturing output / exit code / response. Without that
capability there is no honest stop condition — the loop **requires it and refuses to
run without it** (Phase 0).

## When to use

- A backlog/wishlist of several features built in one long or **unattended** run.
- A run expected to exceed a single context window, or to span sessions.
- The run must keep going with no human to answer questions or approve steps.

## When NOT to use

- A single feature, or a small batch that plainly fits one context — build it directly.
  This loop is overhead there.
- A human is actively supervising each step — use the stage skills directly.

## Hard rules

- **Compose, don't reinvent.** Each phase below names the skill to invoke. Calling it
  is mandatory — do not hand-roll a spec, a plan, a build harness, a review, or a
  runtime QA pass you have a skill for. Invoking a skill's name is not following it:
  capture its handoff block and route it, or the composition is fiction.
- **Gate integrity.** Never weaken, narrow, mock out, skip, or defer a gate to get
  green. Gates are development discipline, not production-only. A gamed gate is a
  failed task. The lint / dead-code / duplication / complexity gates run every loop
  precisely to stop an autonomous build from rotting the codebase.
- **Done-claim gate.** No "done", "fixed", "passing", or "wired" without: the gate
  command run in this turn with its exit code captured directly (never through a pipe
  or pager); runtime proof for any user-facing behavior; the change list diffed against
  the plan. A report missing any of these bounces.
- **Never relay an executor's gate claim as your own.** The conductor either re-runs
  the gate itself or reads the exit code captured in the evidence file. A red gate was
  reported green twice because the run was piped through a pager and the pager's exit
  code was read.
- **Gate cadence is not the loop's to waive.** If the user instructs "no gate between
  tasks", record it in the ledger as a *user decision with the risk stated*, and run
  the full gate at integration regardless. An executor never decides to skip a gate.
- **E2E evidence is keyed by commit SHA.** Record every e2e run as `<result path> @ <sha>`;
  a later gate at the same SHA cites that result instead of re-running it. A fix cycle
  re-runs the failed scenarios plus the set the fix affects — `npm run e2e:remote -- <names>`
  or `-- --affected` — not the whole suite. The full suite runs only remotely
  (`npm run e2e:remote -- --full`, which includes the verify job); the scenarios in
  `test/e2e/remote-exclusions.json` run locally, one at a time (`npm run e2e -- <name>`). Never
  hand a subagent a local full-suite loop: it holds the machine for hours, and a loaded machine
  fails like a regression.
- **The mandate is time-or-scope; an emptied self-made queue is not completion.** When
  the queue empties before the mandate is spent, run a deeper discovery pass and refill
  it (Step 6). "Resource-mindful" and "don't break things" are not reasons to defer the
  hard items — deferring requires a named blocker in the ledger.
- **Review and runtime QA are gates, not options.** An item is not integrable until an
  independent review returns APPROVE and, for any user-facing change, runtime QA
  returns a verdict from what it actually observed.
- **"Implemented" is never "done"; "verified" is not "landed."** An item completes only
  when its work is **committed** (the commit SHA is the evidence), merged, and the
  **merged tree** passes the full gate. Never advance the mainline on an unverified
  merge — per-item verification in isolation misses cross-item breakage and bad
  conflict resolutions. A passing build that was never committed is lost work.
- **Over-production is a defect.** Triage before producing. A stage whose artifact
  would restate the previous stage's artifact at lower fidelity is skipped and the skip
  recorded.
- **Settled decisions travel forward and are never re-litigated downstream.** A
  downstream stage that finds a settled decision genuinely broken says so and re-locks
  with the user (or, unattended, records a `Decisions Needed` item); it never silently
  adapts.
- **Model tier rule.** The session holds decisions. Judgment-heavy delegated work runs
  one tier below the session; mechanical work two tiers below, with a floor at the mid
  tier; never delegate upward. The bottom tier never builds against slow or flaky
  suites and never writes a root-cause diagnosis. Concrete names:
  `references/model-tiers.md`. The conductor tier is fixed once at kickoff in the
  ledger and never auto-escalated mid-run.
- **Concurrency hygiene.** Never run the full gate under concurrent subagent load.
  Never share temp or browser-profile directories across sessions. Never kill processes
  by image name. Verify a worktree's base commit before building on it. Never install
  dependencies in a directory you have not verified is the intended one.
- **Script over manual.** When a routine is mechanical and will repeat — the same shape
  of tool call more than a handful of times, or the same setup/teardown twice — write a
  script that takes arguments and run it instead. Durable scripts go in the project's
  scripts directory; one-offs go to the OS temp dir. Agents default to doing everything
  by hand; that costs tokens and wall-clock.
- **Learnings capture.** After each task or slice, append one to three bullets to the
  run's learnings file, each tagged with where its fix belongs: `[<skill-name>]`,
  `[<doc path>]`, `[instruction-file]`, `[memory]`, or `[none]`. Process observations
  only; code debt goes to the repository's debt file. Without the tags the retro cannot
  route them.
- **The ledger on disk is the source of truth.** Never mark the wishlist complete from
  memory or prose. Re-read the ledger after any compaction before acting.
- **No executable gates → no feature work.** Ground the repo first (Phase 0).
- **No way to run and *observe* the real artifact → refuse to run the loop.** Phase 0
  must establish an end-to-end harness that drives the running artifact and captures
  its actual output, not just unit/lint gates. If none exists and none can be stood up,
  **stop and report — do not proceed unit-tests-only.** `needs-human-smoke` is for a
  genuinely undriveable boundary (a physical device, an irreversible paid side effect),
  **never** for "we skipped setting up end-to-end QA."
- **Verify in the real runtime, not a mock.** A check that only exercises a mock /
  preview / in-memory stand-in does not verify anything crossing a host / IO / IPC /
  PTY / network boundary. If the run can't drive the real environment, mark the task
  `needs-human-smoke` — never record mock-only verification as `done`.
- **Fully autonomous: never call interactive question tools mid-run.** Pass every stage
  skill the unattended signal so it uses its non-interactive mode and records
  would-be approvals as assumptions. Queue every decision to the ledger and keep going.
  Never halt on a single blocker — quarantine and continue.

## The loop

Per-phase inputs, outputs and handoff contracts: `references/composition.md`. State
files: `references/state-ledger.md`. Scheduling and unattended detach:
`references/parallel-and-detach.md`. Model tiers: `references/model-tiers.md`.

| Phase | What happens | Invoke | Applies to |
|---|---|---|---|
| **0 · Ground** | Deterministic gates, a one-command verify, a security gate, **and an end-to-end harness that drives and observes the real artifact**. Pin the gate baseline. | `solidify-repo` + stand up the runtime harness | **once per run** |
| **1 · Spec** | Turn each item into a right-sized, buildable spec. Capture `SPEC / TIER / DECISIONS_NEEDED`. | `feature-spec` | every item |
| **2 · Plan** | Turn the spec into slices, a file map, real signatures, parallel groups and exclusive claims. Capture `PLAN / TIER / SLICES / GROUPS / CLAIMS / SCRIPT_CANDIDATES`. | `implementation-plan` | **FULL only** |
| **2b · Design review** | Fresh-eyes architecture check before code. | `architecture-critic` | **FULL items that introduce new structure or boundaries** — otherwise skip |
| **3 · Build** | Workspace isolation, parallel dispatch from the plan's groups, red-first tests, deviation handling, plan-fidelity diff, the done-claim gate, commit. Capture `BUILD / GATE / RUNTIME_PROOF / DEVIATIONS / LEARNINGS`. | `build-and-verify` | every item |
| **4 · Review** | Independent read-only review of the diff against plan and spec, by an agent that is not the author. Capture `REVIEW / BLOCKERS / FINDINGS`. **Dispatched together with Phase 5, on the same build SHA.** | `code-review` | every item — **gate, not option** |
| **5 · Runtime QA** | Drive the real artifact through the spec's user-facing acceptance criteria; report only what was observed, plus what wasn't covered. Capture `QA / BUILD_UNDER_TEST / VERDICT / NOT_COVERED`. **Runs in parallel with Phase 4 on the same SHA; both must pass before Phase 6.** | `runtime-qa` | every item touching user-facing behavior |
| **6 · Integrate** | **Yours, not delegated.** Merge one branch at a time, re-run the full gate on the integrated tree, advance the mainline only on green. Record the SHA. | the loop itself | every item |

Phase 3 owns everything about *how* an item gets built — isolation, executor briefs,
test-first discipline, the done-claim gate. Do not re-specify that here. Phase 6 is
never delegated: an executor cannot be the one to decide the integrated tree is green.

### Route each item by tier

The tier comes from `feature-spec`'s `TIER:` line. Route per item, not per run.

| TIER | Route | Rationale |
|---|---|---|
| **SKIP** | → Phase 3 directly (the request plus its 1–3 stated assumptions is the task) | a spec and a plan would both restate a one-line change |
| **LITE** | Spec → Phase 3 → lite gates | the spec is directly implementable; a second planning pass duplicates it |
| **FULL** | Spec → **Phase 2 plan** → Phase 2b (only if new structure/boundaries) → Phase 3 | slices, signatures and parallel groups are what make delegation safe |

A small tier (one surface, no cross-process or boundary change) routes LITE; anything
larger routes FULL. Phases 4, 5 and 6 run for **every** tier; LITE runs them lighter —
no design review, **one** review round, runtime QA only when user-visible behaviour
changed, and impact-selected e2e (`npm run e2e:remote -- --affected`). Right-sizing shrinks the front and the depth of the gates, never their
existence.

### Right-size the topology per item

Delegated execution is not the default. Choose from the plan's `GROUPS:` and `CLAIMS:`
lines, and record the choice plus its reason in the item's ledger entry.

| Signal | Topology |
|---|---|
| One group, or the claims list holds shared entry files two tasks would both edit | **solo** — one executor (or the conductor inline for a small item), slices in series |
| ≥2 groups the plan proves file-disjoint, with no overlapping claim | **delegated** — one executor per group, dispatched together, concurrency capped |
| No plan (SKIP/LITE) | **solo**, unless two or more items are independently confirmed file-disjoint |

Delegation re-pays exploration context per executor; on a single group that cost buys
nothing. Shared entry files (global stylesheet, app/root entry, DI or plugin registry,
route table) are near-universal collision points even when feature *logic* is disjoint
— they force solo, or a single serial lane.

## What you do between phases

1. **Kick off.** Write `goal.md`: the user-visible outcome, the Phase 0 gate commands,
   the **mandate** (a time budget, a scope budget, or both), the conductor tier, and
   any user waivers with their risk. Never re-ask these mid-run.
2. **Plan the order.** Build the dependency graph from the specs; write it to the
   ledger. Spec-time independence is **provisional** — confirm disjointness against the
   plans' file maps and claims before fanning out. When unsure, serialize.
3. **Select** every item whose deps are `done`, route it by tier, pick its topology,
   dispatch. Once a build SHA exists, dispatch review and runtime QA **together** against
   that SHA; the item integrates only when both pass. A fix makes a new SHA, which is
   gated again.
4. **Record** each phase's handoff block verbatim into the item's entry — spec path,
   plan path, groups/claims, build SHA, gate exit code, runtime proof path, review
   verdict, QA verdict, deviations.
5. **On a failure**, append the defect to the item's notes and retry up to a fixed
   limit (default 2 retries, 3 attempts). Past the limit, **quarantine to the blockers
   ledger and move on** — never loop forever, never halt the run. A genuinely
   infeasible item is recorded as blocked with the reason, never faked or stubbed.
6. **When the queue empties, check the mandate before stopping.** If time or scope
   remains, do **not** declare completion: run a deeper discovery pass — per subsystem,
   against real flows, not one shallow sweep — refill the queue with what it finds, and
   log the refill (what was swept, what was added) in the ledger. A queue you wrote
   yourself emptying is evidence about the queue, not about the codebase. Only when the
   mandate is spent, or a refill pass genuinely finds nothing, does the run stop.
7. **Stop only when every item is verified-done or quarantined and the mandate is
   spent.** Then write the final report to `docs/runs/<date>-<name>/report.md` (follow
   the repo's docs convention if it has one; not just the chat, which vanishes after an
   unattended run): shipped (evidence + commit SHAs), blocked (with reasons),
   `needs-human-smoke` items, decisions queued during autonomy, the tagged learnings,
   and every discovery refill.

For a **large new subsystem or a genuinely ambiguous brief** (analogies, not a spec),
don't auto-land it on the mainline: build it thin and reversible on a disposable
branch, keep it off the mainline, and surface 2–3 explicit product decisions plus your
pick in the report so the user can course-correct cheaply.

## Modes

- **In-session (default).** You conduct in this session, dispatching stage skills into
  fresh-context subagents wherever they support it. Portable.
- **Detached / unattended.** To run as a background or scheduled long-running task with
  a non-skippable completion gate, see `references/parallel-and-detach.md`.

## Common mistakes

- **Reinventing a phase you have a skill for.** Hand-writing a spec, a plan, a build
  protocol, or a review instead of invoking the stage skill is the primary failure of
  this skill.
- **Naming a skill without following it.** A phase that "used" a skill but produced no
  handoff block did not run.
- **Applying FULL machinery to a LITE item.** A separate plan, design review and
  per-phase executors on a one-surface change burn tokens for nothing.
- **Defaulting to delegated.** Fanning out one group re-pays exploration context for no
  parallelism; on shared entry files it also manufactures merge corruption.
- **Treating an emptied queue as a finished mandate.** The commonest way this loop
  underdelivers: a tidy documented batch, hours of mandate left, hard items deferred as
  "resource-mindful."
- **Skipping Phase 0.** Looping against gates that don't exist proves nothing.
- **Self-certifying, or relaying an executor's claim.** "I implemented it" is not done,
  and neither is "the executor said the gate was green."
- **Advancing the mainline on an unverified merge.** Per-item verification in isolation
  doesn't prove the merged tree is green.
- **Treating green unit tests as a working app.** Unit tests assert on internals; they
  say nothing about whether the thing renders, responds, or runs. Three lanes once
  shipped stylesheet changes that passed lint, typecheck and ~2500 tests and did
  nothing on screen.
- **Calling mock verification "done."** Mark those `needs-human-smoke`.
- **Leaving verified work uncommitted.** A passing build that was never committed is
  lost the moment the executor is cut off.
- **Holding plan/progress in the chat.** Compaction evicts it; the run then forgets
  finished work, repeats dead ends, or hallucinates completion.
- **Halting on the first blocker.** Defeats the unattended purpose — quarantine and
  continue.
- **Letting a stage skill ask questions.** In a detached run a blocking prompt hangs
  everything.

## Gotchas

- **The ledger is the contract, not your memory.** Re-read it on every resume; treat a
  stale `in_progress` item as `todo` and re-verify rather than trust it.
- **A gamed gate is worse than a red one** — it hides a defect and poisons every later
  "done." Diff the gate definitions against the Phase 0 baseline; any narrowing,
  deletion, or mock-out of an existing check fails the item. Newly added tests are fine.
- **A user waiver is a recorded decision, not a rule change.** The loop logs it with
  its risk and still gates at integration.
- **Parallel only for confirmed-disjoint work.** Mistaken parallelism causes merge
  corruption and hard-to-trace state collisions; the wall-clock saving isn't worth a
  poisoned run.
- **Quarantine is success, not failure.** An honest "blocked: <reason>" beats a fake
  "done"; the point is a run that can't lie about what it finished.

## Reference files

- `references/composition.md` — per-phase in/out/capture contracts and artifact paths.
- `references/state-ledger.md` — the on-disk files, `tasks.yaml` shape, status semantics.
- `references/parallel-and-detach.md` — scheduling, serialization points, detached runs.
- `references/model-tiers.md` — concrete model names per tier and the field evidence.
