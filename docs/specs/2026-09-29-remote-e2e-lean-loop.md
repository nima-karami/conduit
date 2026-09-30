---
status: active
date: 2026-09-29
---

# Feature Spec: Remote e2e on GitHub Actions + a leaner dev loop

**Tier:** FULL   **Feature type:** non-UI (test infrastructure, CI, agent workflow)
**Request:** e2e takes forever, must run one at a time locally and disturbs the machine; make
running the project faster, cheaper and more professional. **Decided in conversation:** e2e runs on
GitHub-hosted runners; the full suite never runs locally; locally at most one e2e instance runs.
Plus: everything else that slows development. **Interim rule (user, 2026-09-29):** no full
`npm run verify` runs until remote e2e is built.

## 1. Problem frame

- **Job:** trustworthy e2e results for a change, fast, without the developer's workstation being the
  test farm — and no ceremony that doesn't find defects.
- **Actors:** developer; build-loop agents (conductor, executor, reviewer, runtime QA); GitHub Actions.
- **Success outcomes:**
  - Full suite ≤ **25 min** from run start to verdict (queue time reported separately).
  - The local machine never runs more than **one** e2e app at a time, never the full suite, and runs
    it at below-normal priority.
  - A remote failure is diagnosable from its artifacts without a local rerun.
  - Local e2e hours per build-loop run drop to near zero (baseline 9.9 h, §2).
- **Non-goals:** making the app run on macOS/Linux (separate spec, §6 Vision); changing what
  `npm run verify` checks (CLAUDE.md forbids narrowing the gate); self-hosted or paid runners;
  rewriting scenario assertions.

## 2. Behavior & states

### Current behavior (measured 2026-09-29)

| Claim | How measured | |
|---|---|---|
| 158 scenarios, strictly sequential, 3 s settle, 210 s cap; filter is a **substring** match | `test/e2e/run-smoke.mjs:29,61-69,93` | Measured |
| Full suite ≈ **107 min** (sum of per-scenario medians 98.6 min + settles); runner comment says "~4 min" | 653 result lines parsed from `.autoloop/evidence/**`, `docs/runs/**`; `run-smoke.mjs:11` | Measured |
| Scenario p50 43.7 s, p90 105.6 s; 15 scenarios median > 90 s (split-editor 172 s, file-integrity 167 s) | same parse | Measured |
| 75 `launchApp(`/`electron.launch(` call sites in 63 files; 64 of 158 scenarios bypass `runScenario` | spec review grep; `harness.mjs:125,750` | Measured |
| Editor-parity run: **653 local scenario runs = 9.9 h**; split-editor alone 38 runs / 1.3 h | evidence parse | Measured |
| `npm run verify` ≈ **114 s** locally (unit tests 74 s of it) | timed per stage on main 05d9bf3 | Measured |
| Harness has no tracing or screenshot-on-failure | grep `harness.mjs` | Measured |
| Runner and harness exit 0 with SKIP on non-win32 | `run-smoke.mjs:56-59`, `harness.mjs:751-754` | Measured |
| e2e never runs in CI; `release.yml` (windows-latest, tag) builds without e2e; `verify.yml` on ubuntu 2 m 24 s | workflow files; run 36657531340 | Measured |
| Local heavy runs serialised by `.autoloop/heavy-lock.mjs` (untracked, mtime-reclaim at 45 min, wait time not logged) | source read; `git ls-files .autoloop` empty | Measured |
| Repo is public → hosted runners free | `gh repo view` | Measured |
| `windows-latest` runs the suite hidden (ConPTY, swiftshader WebGL, clipboard); per-scenario slowdown vs this machine 1.3–2×; ~20 concurrent jobs | not yet run | **ASSUMED** — Slice 0 measures |

### Part A — Remote e2e

1. `npm run e2e:remote -- <selection>` from a committed HEAD. Selection: `--full`, `--affected`
   (default) or exact scenario names.
2. The command:
   - pushes HEAD to a **per-invocation ref** `ci/e2e/<sha7>-<nonce>`;
   - dispatches `e2e.yml` on that ref with `run-name` containing the nonce;
   - finds the run by nonce and prints its URL.

   **Dedup lives in the command:** if an in-flight run exists for the same sha and selection, it
   attaches to that run instead of dispatching.
3. `e2e.yml` runs three jobs:
   - **prepare:** resolves the selection to a scenario list and splits it into shards balanced by
     duration.
   - **shards:** `windows-latest`, N jobs. Each runs `npm ci` (cached) and the build, then runs its
     scenarios through `run-smoke.mjs`, one app at a time per runner.
   - **report:** merges the results and uploads the artifacts.
4. The command waits, then:
   - prints `run-smoke`-style `PASS/FAIL (s)` lines and a summary;
   - writes the result JSON to the caller's evidence dir;
   - deletes its own ref;
   - exits.
5. Each failed scenario gets an artifact bundle: log, a screenshot at failure, and a Playwright trace.

**Run states:** `dispatching → queued → preparing → running (k/N shards) → reporting → passed |
flaky-passed | failed | infra-error | cancelled | timed-out`.
- A run is `flaky-passed` when its only non-PASS results are FLAKY.
- `infra-error` is a shard or job failure (runner lost, `npm ci`, ref push); it is never reported as
  a test failure.

**When full runs happen:** nightly on `main` (schedule) and before a release. Integration merges run
`--affected`. There is no `push: main` trigger. At most **one full run in flight** globally
(concurrency group `e2e-full`, queued, never cancelled); later `--full` callers attach to the
in-flight run if it's for the same sha, otherwise they queue.

### Part A′ — Local e2e (single instance)

- `npm run e2e -- <exact-name>` runs exactly one scenario. The name is matched against the file name
  without `.e2e.mjs`, **exactly**, not as a substring.
- **Enforcement lives in `harness.mjs launchApp`,** the one choke point every scenario, `text-fit`
  and `shots` launch goes through. When not on CI (`GITHUB_ACTIONS` unset), `launchApp`:
  - acquires a **machine-wide e2e lock** at `%TEMP%\conduit-e2e.lock`. A waiter prints "waiting
    for <owner pid/scenario>". A lock whose owner PID is dead is reclaimed.
  - sets the launched Electron tree to **BelowNormal** priority.

  So `node test/e2e/x.e2e.mjs` is covered as well.
- `run-smoke.mjs` run locally with no filter, or with a filter matching more than one scenario,
  **refuses** and prints the `e2e:remote` command. `CONDUIT_E2E_LOCAL_FULL=1` is a human-only
  escape hatch: logged, and never set by agents.
- The e2e lock is **separate from** `.autoloop/heavy-lock` (build-loop tooling outside the repo),
  which keeps serialising verify and build.

### Part B — Everything else that slows the loop

- **B1 Rerun volume (largest measured cost).**
  - A fix cycle re-runs the failed scenarios plus `--affected`, remotely.
  - Review and QA rounds don't re-run e2e that already passed at the same SHA; they cite the result
    JSON.
- **B2 Impact selection (`--affected`).**
  - The diff against the merge-base with `main` is mapped to scenarios through a **coverage map**
    (scenario → source files). The nightly full run builds the map from V8 coverage of host and
    renderer, mapped back through esbuild sourcemaps.
  - **Rule:** a changed file absent from the map, or any change to `test/e2e/**`, `electron/main.ts`,
    `electron/preload.ts`, `esbuild.mjs`, `package.json` or the lockfile, selects the full suite.
  - A diff touching only `docs/**` and `*.md` selects none: "no e2e needed", exit 0.
- **B3 Slow scenarios.** The harness logs per-phase timings. Scenarios with a median over 120 s are
  split into files of 120 s or less, assertions unchanged. Order: split-editor, file-integrity,
  new-session-folders, tree-chevrons, attention-signal, middle-click-surfaces.
- **B4 Flakes.**
  - A failed or timed-out scenario is retried **once**, as a new Node child in the same shard job
    after the existing orphan sweep. If the retry passes, the result is **FLAKY** and the run
    passes.
  - The report lists quarantine *candidates*: FLAKY 3+ times in 14 days of nightly history.
  - Quarantine itself is `test/e2e/quarantine.json`, edited by a normal reviewed commit, never by a
    bot. A quarantined scenario still runs and is reported (`QUARANTINED-FAIL`), but doesn't fail
    the run.
- **B5 Right-sized ceremony**, in `~/.claude/skills/autonomous-build-loop` (outside the repo):
  - Tier S (one surface, no host/IPC change): LITE spec, no architecture critic, one review, runtime
    QA only for visible behaviour, `--affected` e2e.
  - Tier M/L: the current pipeline.
  - Review and QA run **in parallel** on the same SHA.
  - Executor briefs carry the worktree junction rule.
- **B6 Local gate.** `npm run verify` is unchanged and is the integration gate.
  `npm run verify:quick` is for the inner loop only: biome on changed files, both
  `tsc --incremental`, `vitest --changed`.
- **B7 Lock observability** (`.autoloop/heavy-lock.mjs`, outside the repo; same caveat as B5): log
  acquire, wait and release with durations.

## 3. Data / interface contract

- **`npm run e2e:remote -- [--full | --affected | <name>…] [--shards N] [--no-wait] [--retry-infra <run-id>]`**
  - Preconditions: a clean committed HEAD (a dirty tree → error naming the files, nothing pushed);
    `gh` authenticated.
  - `--retry-infra` re-dispatches only the `INFRA` scenarios of a run.
  - Exit codes: **0** passed / flaky-passed / no e2e needed; **1** failed; **2** infra-error /
    cancelled / timed-out / preconditions.
- **`e2e.yml`:**
  - Triggers: `workflow_dispatch` (inputs `selection`, `scenarios`, `base`, `shards`, `nonce`) and
    `schedule` (nightly, `main`, `--full`, plus a sweep deleting `ci/e2e/*` refs older than 24 h).
  - `run-name` embeds the nonce.
  - Permissions: `contents: write` (ref sweep), `actions: read` (download the previous nightly's
    artifacts).
  - Must exist on the default branch before it can be dispatched (Slice 0 lands it first).
- **Scenario status:**
  - `PASS`, `SKIP`, `FAIL` (runner exit 1 = assertion, 2 = uncaught exception — both are test
    failures), `TIMEOUT`, `FLAKY`, `QUARANTINED-FAIL`, and `INFRA` (shard died; set by report).
  - Runner `EXIT(n)` maps to `FAIL`.
  - **All-SKIP for a non-empty selection = run `failed`**: guards a vacuous green on a future
    non-Windows OS axis.
- **Result JSON:**
  `{ sha, nonce, selection, shards, queuedAt, startedAt, finishedAt, results: [{ name, status,
  seconds, attempts, shard, artifact? }] }`
- **Nightly state:** a `e2e-state` artifact holding `timings.json` (scenario → median s),
  `coverage-map.json` and `flaky-history.json` (14-day rolling), retained 30 days.
  - Each nightly downloads the previous state, updates it and re-uploads.
  - `prepare` reads the latest successful nightly's state.
  - Fallbacks when there is no state yet: the checked-in `test/e2e/timings.seed.json` (local
    medians, scaled by the Slice 0 slowdown factor); `--affected` → full suite.
- **Failure artifacts:** hooked in `launchApp`. On CI it starts Playwright tracing on the Electron
  context; on scenario failure (non-zero exit) it saves the trace, a screenshot of every open window
  and the log to `$E2E_ARTIFACT_DIR/<scenario>/`. Uploaded only for failures, kept 7 days.
  Screenshot of a hidden (`show:false`) window: **ASSUMED** to work via `page.screenshot` (Slice 0
  checks).

| Data / state | Produced by | Consumed by | Both in scope? |
|---|---|---|---|
| Scenario results | `run-smoke.mjs` in a shard | report job → `e2e:remote` → agent evidence | Yes |
| Shard plan | prepare (selection + timings) | shard jobs | Yes |
| timings / coverage map / flaky history | nightly report (artifact) | prepare, `--affected`, report | Yes |
| Quarantine list | human/agent commit | runner, report | Yes |
| Ephemeral refs | `e2e:remote` (create + delete own) | `e2e.yml` checkout; nightly sweep | Yes |
| e2e lock + priority | `launchApp` | every local launch (scenarios, text-fit, shots) | Yes |
| e2e evidence | `e2e:remote` | build-loop gates (B5, outside repo) | Yes — flagged §14 Q4 |
| Release | `release.yml` | users | **Flagged** — §14 Q2 |

## 4. Edge cases & failure modes

| Condition | Expected behavior |
|---|---|
| Two callers, same sha + selection | Second attaches to the first's run (found by querying in-flight runs' names/inputs); each deletes only its own ref (the attacher created none) |
| Two `--full` for different SHAs | Second queues behind the first (`e2e-full` group, no cancel); the command prints queue position |
| New commit while an older run is in flight | Older run continues (an agent may be gating on it) |
| Selection resolves to zero on a code change | Impossible by the §B2 rule (unmapped → full); docs-only → exit 0 "no e2e needed" |
| Shard runner dies | Its unfinished scenarios → `INFRA`; exit 2; `--retry-infra` re-runs only them |
| Scenario > 210 s | TIMEOUT, orphan sweep, one retry |
| Fails only remotely (clipboard, GPU, DPI) | FAIL with artifacts; Slice 0 records known env differences in this spec |
| Hosted queue > 10 min | Keep waiting and print state every minute; `--no-wait` returns the URL |
| `gh` unauthenticated / offline | Exit 2 with the fix; no local full-suite fallback |
| Local lock owner process dead | Lock reclaimed immediately |
| Local failure under user load | Output reminds: a loaded machine fails PTY scenarios like a regression (CLAUDE.md) — confirm with `e2e:remote -- <name>` before debugging |
| Result JSON written twice (attach + dispatch race) | Keyed by run id; same content; idempotent |
| Pre-existing failure on `main` (today `mf-live-edits`, `goto-index`) | v1: report marks a FAIL "also failing on last nightly" from nightly history; still a failure. MVP: plain FAIL |

## 5. Defaults vs. settings

| Decision | Default | Configurable? | Rationale |
|---|---|---|---|
| Runner OS | `windows-latest` | matrix `os` axis | Suite is Windows-only; axis makes mac/Linux a config change |
| Shards | enough that each is ≤ 10 min at measured CI speed, cap 16 | `--shards` | ≤ 25 min wall incl. setup, under the concurrency limit |
| Default selection | `--affected` | flag | Full is nightly/pre-release |
| Retry | once, recorded FLAKY | no | Hides nothing, and hosted noise doesn't block work |
| Full runs in flight | 1 | no | Protects the ~20-job concurrency pool |
| Local priority | BelowNormal | `CONDUIT_E2E_PRIORITY` (diagnosis) | The machine is also a workstation |
| Local scope | one scenario, exact name | human-only escape hatch | The user's constraint |
| Artifacts | failures, 7 days; nightly state 30 days | workflow | Enough to diagnose and keep history |

## 6. Scope slicing

- **Slice 0 (spike):**
  - Land `e2e.yml` on `main` with a static shard split.
  - Dispatch `--full` at `main`.
  - Record: wall time, per-scenario slowdown factor, remote-only failures and why, whether hidden-window
    screenshots and tracing work.
  - Results are written back into this spec before the rest is built.
- **MVP:**
  - `e2e:remote` (full, names; dedup; ref lifecycle; result JSON);
  - failure artifacts;
  - retry-once + FLAKY;
  - local exact-name single instance with lock + priority in `launchApp`;
  - `run-smoke` local refusal;
  - runner comment corrected;
  - `timings.seed.json`.
- **v1:**
  - nightly + `e2e-state`;
  - `--affected` + coverage map;
  - quarantine list and candidates;
  - split the >120 s scenarios;
  - release gating (per §14 Q2);
  - `verify:quick`;
  - B5 and B7 outside the repo.
- **Vision:**
  - make the app run on macOS/Linux (own spec);
  - populate the `os` axis with a portable scenario subset.
- **Out of scope:** self-hosted/paid runners; changing `verify`; the stress suite.

## 7. Acceptance criteria

**EARS**
- When `e2e:remote --full` runs on a clean committed HEAD, the system shall report a status for
  every scenario within 25 min of the run starting, and report queue time separately.
- When a second caller requests the same sha and selection while a run is in flight, the system
  shall attach to that run and not dispatch another.
- While not on CI, `launchApp` shall allow at most one e2e app on the machine, at BelowNormal
  priority.
- If `run-smoke.mjs` runs locally with no filter or a filter matching more than one scenario, then
  it shall refuse and print the `e2e:remote` equivalent.
- When a scenario fails remotely, the system shall publish its log, window screenshots and trace,
  and link them in the summary.
- If a scenario fails and then passes on retry, then the run shall pass with that scenario FLAKY.
- If a shard job fails, then its unfinished scenarios shall be `INFRA` and the command shall exit 2.
- If every scenario in a non-empty selection is SKIP, then the run shall be `failed`.
- When the command finishes, the system shall have deleted the ref it created.

**Gherkin**
```gherkin
Feature: Remote e2e
  Scenario: Agent verifies a fix remotely
    Given a worktree at a committed SHA that changes webview code covered by split-editor scenarios
    When the agent runs "npm run e2e:remote -- --affected"
    Then only scenarios mapped to the changed files run, across balanced shards
    And one PASS/FAIL line per scenario and a summary are printed
    And the result JSON is written to the agent's evidence directory
    And a process snapshot taken during the run shows no harness-launched electron.exe locally

  Scenario: Local runs are single-instance
    Given "npm run e2e -- auto-save" is running in one worktree
    When "npm run e2e -- split-editor" starts in another
    Then it prints that it is waiting for the auto-save run
    And it launches only after that app has exited
```

## 12. Assumptions

(Interactive spec: open decisions are in §14; there is no §13.)

- `windows-latest` runs the suite hidden, with the 1.3–2× slowdown and ~20-job concurrency
  (Slice 0 measures all three).
- `page.screenshot` works on a `show:false` Electron window, and Playwright tracing works on
  `electronApp.context()` (Slice 0).
- The GitHub dispatch API's run-id response is not relied on; correlation is by `run-name` nonce.
- BelowNormal priority set on the Electron root process is inherited by its children on Windows.
  MVP measures this; if it isn't, the harness sets it per PID in the tree.
- V8 coverage maps back to source through esbuild sourcemaps (v1). If it doesn't, the map is built
  from esbuild's metafile import graph per entry, which is coarser but still conservative.
- `gh` is installed and authenticated wherever agents run.

## 14. Decisions (user, 2026-09-29)

1. **Ephemeral WIP refs on the public repo: yes**: `ci/e2e/<sha7>-<nonce>`, deleted after the run,
   swept at 24 h.
2. **Releases are gated on the full suite.** `release.yml` calls `e2e.yml` as a reusable workflow
   (`--full` at the tag's SHA) and its build job `needs` it. Passed or flaky-passed proceeds;
   `QUARANTINED-FAIL` doesn't block. Merges stay on `--affected` plus the core smoke set (below).
   The standard split is: a fast, impact-selected gate on every merge, and the full suite nightly and
   at release.
3. **Retry once, mark FLAKY.**
4. **B5/B7 are in this effort**, even though they live outside the repo.

**Core smoke set** (added with Q2): a short list in `test/e2e/core-smoke.json` (launch, open a
session and see the shell echo, open/edit/save a file, quit guard) is always added to an
`--affected` selection, so a merge never runs zero app scenarios on a code change. Target: under
3 min total. The initial list is chosen from measured durations in the plan.
