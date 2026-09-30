# Scheduling and unattended detach

The conductor decides **what runs when, and how many at once**. *How* an item is built
inside its slot — workspace isolation, executor briefs, test discipline — belongs to
`build-and-verify`, not here.

## The dependency graph

The spec phase produces a *provisional* graph. Spec-time independence is a hypothesis:
two items that sound unrelated routinely touch the same files.

- **Confirm disjointness against the plans' file maps and `CLAIMS:` lines before fanning
  out.** Only a plan-level file map is evidence; a spec's sense of separateness is not.
- **Dependent items** (one needs another's output, or they share files) run
  **sequentially** in dependency order. An item becomes selectable only when every id in
  its `deps` is `done`.
- **When unsure, serialize.** Mistaken parallelism causes merge corruption and
  hard-to-trace state collisions; the wall-clock saving isn't worth a poisoned run.

## Serialization points

Some paths force serial work no matter how disjoint the feature *logic* is:

- **Shared entry files** — global stylesheet, app/root entry, DI or plugin registry,
  route table, wire-protocol definition. Two items editing one of these are not
  parallel, they are a merge conflict scheduled in advance.
- **Exclusive claims** — the plan's `CLAIMS:` line lists paths only one task may hold.
  Two candidate groups whose claims intersect run in series; the second starts from the
  first's merged result, not from the shared base.
- **Machine-level singletons** — a fixed port, a lockfile, a database or emulator
  instance, a shared temp or profile directory. Items contending for one of these
  serialize even when their files are disjoint; concurrent contenders fabricate failures
  that look like regressions.
- **The full gate itself** never runs under concurrent executor load. Two concurrent
  runs reap each other and produce nonsense that gets mistaken for a regression.

## Choosing the width

- One group, or intersecting claims → **solo**. Delegation re-pays exploration context
  per executor and buys no parallelism here.
- Two or more plan-proven file-disjoint groups with no claim overlap → **delegated**,
  one executor per group, dispatched in a single message, concurrency capped low (four
  is a practical ceiling; lower when the gate is slow or machine-bound).
- Record the chosen topology and its reason in the item's ledger entry. A later resume
  reads the decision instead of re-deriving it.

## Executor brief checklist

Every executor brief carries, beyond `build-and-verify`'s own inputs:

- **The worktree junction rule.** Worktrees live outside the checkout (one inside it breaks
  `biome check .`), with `node_modules` as a directory junction to the main checkout's
  (`cmd /c mklink /J`). Delete
  the junction (as a link, never recursively) before `git worktree remove`, which follows it
  and empties the shared install — recovery is `npm ci` + `node node_modules/electron/install.js`
  in the main checkout. A slice that adds dependencies gets a real install instead.
- **The e2e rule.** `npm run e2e:remote -- <failed + affected names>` or `-- --affected`;
  excluded scenarios via `npm run e2e -- <name>`, one at a time; never a local full-suite loop.
- **The heavy-run rule.** Parallel executors must not overlap local `npm run verify` /
  `npm run build`: serialise them through `node .autoloop/heavy-lock.mjs <cwd> <cmd…>` when
  that (untracked, per-machine) script exists, otherwise run them from one lane only.

## Integration order

Each parallel group lands through review and runtime QA independently; the conductor
merges verified branches **one at a time** and re-runs the full gate on the integrated
tree before advancing the mainline. Merges that touch a shared entry file go through one
serial lane, last. Never advance the mainline on an unverified merge — per-item
verification in isolation misses cross-item breakage and bad conflict resolutions.

## Detached / unattended runs

The in-session conductor is the portable default. To genuinely "kick off and walk away,"
run the loop as a detached long-running task — this part depends on harness features, so
treat it as adaptation, not gospel.

What the detach needs, whatever the harness:

- **A durable driver.** A background or scheduled task that re-enters the loop, reads
  the ledger, advances one pass, and persists. The ledger, not the chat, is what survives
  between wake-ups — this is why state lives on disk.
- **A non-skippable completion gate.** Bind the gate to a stop hook so an item (or the
  run) cannot be declared done while checks fail: the hook runs them and, on failure,
  blocks the stop and feeds the failure back into the loop. This is what removes "done"
  from the model's discretion.
- **A mandate the driver can check.** The stop condition is "every item done or blocked
  **and** the mandate spent", not "the queue is empty" — otherwise a detached run
  finishes its self-made list in the first hours of a long budget and idles.
- **Post-edit checks.** Optionally run formatters/linters on file-change hooks so trivial
  fixes don't burn loop iterations.
- **No interactive prompts anywhere.** Every stage skill must run in its
  autonomous/non-interactive mode; a single blocking question hangs an unattended run
  indefinitely. Decisions go to `blockers.md`, never to a prompt.

If the harness lacks durable background execution or stop hooks, fall back to the
in-session conductor and accept that the run pauses when the session does — resuming
cleanly from the ledger when restarted.

## Resumption after compaction or restart

On any resume, before acting: re-read `goal.md`, `tasks.yaml`, and `blockers.md`. Treat a
stale `in_progress` item as `todo` and re-verify rather than trusting it was finished.
Re-read the mandate and how much of it is spent before deciding the run is over. Never
reconstruct progress from memory.
