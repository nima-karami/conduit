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
| `windows-latest` runs the suite hidden: 151/158 PASS once the runner env is fixed (below). Per-scenario remote/local **p50 0.93×, p90 1.03×** (not the assumed 1.3–2×). All 16 shards + probe ran **concurrently** (17 jobs, start ≤ 4 s after dispatch) | Slice 0 runs 36660958887, 36661277673, 36662234121, 36663111099, 36664116614 | Measured |

### Slice 0 results (measured 2026-09-30, `--full` at origin/main 05d9bf3 + spike, 16 shards)

- **Wall:** verdict **579–598 s (≈ 10 min)** after dispatch.
  - Queue: shard start 1–4 s after the run was created (one 35 s outlier).
  - prepare 6–12 s; report 4–10 s.
  - Shard setup median ~70 s (checkout full-depth 6–9, setup-node 12–22, `npm ci` 22–45,
    Electron install 2–3 on a cache hit, build 3–5, Playwright install 2–4); max 151–190 s on the
    shard that installs Go + gopls.
  - Run (the scenarios step): median ~377 s, max 417–481 s per shard.
- **`npm ci` cold vs warm:** 23–41 s on the first run (no npm cache) vs 22–45 s afterwards: the
  setup-node cache barely matters. **Electron:** v43 has no postinstall and downloads on first
  launch; on a miss the download landed inside the first scenario of every shard (run
  36661277673). With an explicit `install.js` step and `actions/cache` on
  `%LOCALAPPDATA%\electron\Cache`, a hit costs 2–3 s.
- **Slowdown** (remote PASS s / local PASS median, 149–151 scenarios per run): p10 0.64–0.66,
  **p50 0.91–0.93, p90 1.03–1.06**, aggregate 0.94–0.98. Outliers > 2.5×: only the scenarios
  that opt out of hidden mode (`terminal-focus` 7–11×, `shortcut-precedence` up to 11×).
  `timings.seed.json` `scale` is set to **0.93**.
- **Workflow behaviour:** `workflow_dispatch` on a `ci/e2e/*` ref ran that ref's workflow file
  (the `main` stub has one echo job) with the dispatched inputs; `run-name` nonce correlation
  worked for every run.
- **Tuning:** at `scale` 0.93 the auto count at `targetSec` 600 is 10 shards, ≈ 11–12 min wall.
  16 shards gave ≈ 10 min. Both are well inside 25 min; keep `targetSec` 600, cap 16.
- **Remote-only failures fixed in the workflow** (each broke many scenarios):

  | Cause | Symptom | Fix |
  |---|---|---|
  | Hosted npm cache is `C:\npm\cache`, not under `LOCALAPPDATA` | `loadPlaywright` found nothing: 158/158 ERROR | `npm install --no-save playwright@1.63.0` into node_modules |
  | Electron downloads lazily on first launch | first scenario per shard timed out | `node node_modules/electron/install.js` step + cache |
  | Hosted `TEMP` is the 8.3 path `C:\Users\RUNNER~1\...`; realpath expands it | ~20 scenarios: "Refusing to … outside the workspace (symlink)", git state keyed by a different path | `TEMP`/`TMP` = `runner.temp` for the scenario step |
  | Depth-1 checkout | `git-history` saw one commit | `fetch-depth: 0` |
  | No Go toolchain | `go-lsp` FAIL; `mf-files` exits 0 but SKIPs its trust phase | `setup-go` + `gopls` on shards holding either |
  | No git identity | (pre-empted) | `git config --global user.name/email` |

- **Still failing remotely after the fixes** (runs 36662234121, 36663111099, 36664116614):

  | Scenario | Result | Cause |
  |---|---|---|
  | `nav-keybindings-settings` | FAIL 3/3 | Not remote-only: asserts "Code navigation" directly follows "Editor", but split-editor (0.45.0) added an "Editor groups" group between them |
  | `multi-window-restore` | FAIL 3/3 | Runner display is smaller: saved bounds x=1100 are restored as 0,0 |
  | `split-editor-focus-keep` | FAIL 3/3 | Window has no OS focus: xterm's focus-out report `ESC[O` reaches the shell, typed text is lost |
  | `scrollback-mode-neutralize` | FAIL 3/3 | Same focus class: "Replayed focus reporting leaked onto the fresh shell" |
  | `review-mode-pane` | FAIL 3/3 | Hovering a navigator row leaves its actions at opacity 0; cause not isolated |
  | `attention` | FAIL/ERROR 3/3 | Needs a real focusable window (it opts out of hidden mode) |
  | `shortcut-precedence`, `terminal-focus` | flaky (2/3, 1/3 FAIL), 7–11× slow | Also opt out of hidden mode; foreground/focus on the runner |

- **Probe** (`ci-probe` + the three longest launchApp scenarios):
  - `page.screenshot` of a hidden window **works** (`isVisible()` false; 82–216 KB PNG), but
    costs **1.3–7.6 s per window** on the runner (0.19 s locally).
  - Tracing on `electronApp.context()` **works**, with limits:
    - `{screenshots, snapshots}` started before `firstWindow`: launches time out waiting for
      `domcontentloaded` (3/3).
    - The same started once the window is ready: `split-editor` and `file-integrity` hit the
      210 s TIMEOUT; traces 2–4 MB.
    - **Snapshots only** (`screenshots: false`), started once ready: all PASS. Overhead +1–2 %
      (`file-integrity` 175 vs 171 s, `new-session-folders` 172 vs 170 s), +12 % on
      `split-editor` (three launches, each with a ~4 s screenshot). `stop` 9–64 ms; trace 8–317 KB.

### MVP full run (measured 2026-09-30, run 36667732842, `--full` at feat/remote-e2e 80be47d)

- **Wall 15 m 12 s** from dispatch to verdict: queue 3 s, prepare 5 s, 9 auto shards (`scale`
  0.93, `targetSec` 600) finishing 11 m 39 s – 14 m 48 s after start (retries included), report
  11 s, cleanup 3 s. The `verify` job ran alongside in 2 m 27 s. AC 1 (≤ 25 min) holds.
- 150 PASS, 1 FLAKY (`review-multi-repo`), 6 EXCLUDED; 2 FAIL in the no-OS-focus class
  (`review-mode-pane` — CDP focus emulation did not help — and `terminal-exit-focus`, added
  after Slice 0), since excluded. `nav-keybindings-settings` passes with its corrected order.
- A bounded attempt (~30 min) to make the excluded scenarios runner-independent: display-relative
  bounds for `multi-window-restore` (then 1 window restored instead of 2) and CDP focus
  emulation for the focus class; neither held, so the changes were dropped and the reasons are in
  `remote-exclusions.json`.
- Locally, Electron inherits BelowNormal from the scenario process, but Chromium raises the GPU
  process to AboveNormal and the renderer to Normal after launch; the harness lowers every PID the
  app reports (`getAppMetrics`) at the first window and again over 3 s (measured all BelowNormal).

### v1 results (measured 2026-09-30, feat/remote-e2e-v1)

- **Nightly path** (dispatch `mode=nightly`; a `schedule` only runs main's file): the `state` job
  uploaded `e2e-state` from a run whose report failed (forced `cwd` FAIL, run 36682639505); the next
  run's `prepare` found it by name and planned from its timings (36683062930). The sweep deleted a
  hand-pushed `ci/e2e/*` ref on a 4-day-old commit with no run, and kept the in-flight one.
- **Coverage map:** Playwright's `page.coverage` and `NODE_V8_COVERAGE` record *block* coverage,
  which slowed the app enough that `change-map-geometry` and `nav-keybindings-settings` failed in
  the first coverage nightly (36683998318) and passed without it (36685668969); `split-editor` went
  157 → 198 s. Function-level precise coverage over CDP (renderer, and the host through an
  in-process inspector session) left both passing and `split-editor` at 170 s (36686481573).
  Files are attributed by the function that **defines** the executed code, because esbuild hoists
  every module's top level into one bundle scope that runs at load. Result: 146 of 151 run
  scenarios mapped (the rest ended through `closeApp`, since fixed), 449 of 492 `src`/`webview`/
  `electron` `.ts(x)` files mapped, **13/13 (100 %)** of the code files touched by main's last 20
  commits mapped. Selectivity is bimodal: per file, p25 5 / p50 101 / p90 144 scenarios — leaf
  components select a handful, shell files most of the suite.
- **`--affected`** (runs 36687342106/-252/-297, base = parent commit): one mapped webview file →
  its 3 scenarios + core + 11 not-yet-mapped; a new file → its importer's scenario via the metafile
  (`npm ci --ignore-scripts` + build ≈ 25 s, only when a new file needs the graph); a
  `test/e2e/**` change → full. A docs + unit-test-only commit → "no e2e needed", exit 0, nothing
  pushed. A scenario absent from the map (new or split since the last nightly) is always selected.
- **Quarantine:** a quarantined forced failure → `QUARANTINED-FAIL`, run `passed` (36683062930).
- **Splits (§B3):** split-editor, file-integrity, new-session-folders, tree-chevrons,
  attention-signal and middle-click-surfaces → 19 files, **31.7–74.6 s remotely** (36691871954);
  assert counts identical per original (83/49/41/27/19/43).
- **Release gating:** a throwaway caller on a non-`ci/e2e` ref: e2e passed → the dependent job ran;
  e2e failed → it was skipped; `cleanup` skipped both times (36684631261, 36684642621).
- **`verify:quick`:** Biome 0.2 s, each `tsc --incremental` 2.3 s warm (3.9 s cold; TS 7.0.2
  accepts `--incremental` with `--noEmit`), `vitest --changed` 27 s for two widely imported `src`
  files vs 74 s for the full unit suite; a branch that touches `package.json` runs every test.

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
   - exits.

   The ref is deleted by the run itself: a final always-run job of `e2e.yml` removes its own
   `ci/e2e/*` ref, so a cancelled run or a killed client still cleans up.
5. Each failed scenario gets an artifact bundle: log, a screenshot at failure, and a Playwright trace.

**Run states:** `dispatching → queued → preparing → running (k/N shards) → reporting → passed |
flaky-passed | failed | infra-error | cancelled | timed-out`.
- A run is `flaky-passed` when its only non-PASS results are FLAKY.
- `infra-error` is a shard or job failure (runner lost, `npm ci`, ref push) with **no** FAIL or
  TIMEOUT in the run; it is never reported as a test failure. A real failure beats INFRA: a run with
  both is `failed`, and the INFRA names are listed with the command that re-runs them.

**When full runs happen:** nightly on `main` (schedule) and before a release. Integration merges run
`--affected`. There is no `push: main` trigger and **no workflow concurrency group** (GitHub keeps
one pending run per group and cancels the older one). Instead, `e2e:remote --full` attaches to an
in-flight full run at the same sha, and otherwise waits for any in-flight full run to finish before
dispatching, saying so. This is best-effort; nightly and release runs don't coordinate with it, and
an overlap only queues jobs, it never cancels a run.

### Part A′ — Local e2e (single instance)

- `npm run e2e -- <exact-name>` runs exactly one scenario. The name is matched against the file name
  without `.e2e.mjs`, **exactly**, not as a substring.
- **Enforcement lives in `harness.mjs launchElectron`,** the one choke point every scenario,
  `text-fit` and `shots` launch goes through (`launchApp` and the scenarios that launched Electron
  directly both call it). When not on CI (`GITHUB_ACTIONS` unset), it:
  - acquires a **machine-wide e2e lock**: the named pipe `\\.\pipe\conduit-e2e`. Listening on it is
    holding it; `EADDRINUSE` means it is held; the OS releases it when the owner dies, so there is
    no stale-lock reclaim. The owner serves `{pid, scenario, cwd}`, and a waiter prints
    "waiting for <pid> (<scenario>, <cwd>)".
  - sets the launched Electron tree to **BelowNormal** priority.

  So `node test/e2e/x.e2e.mjs` is covered as well.
- `run-smoke.mjs` run locally with no filter, or with a filter matching more than one scenario,
  **refuses** and prints the `e2e:remote` command. `CONDUIT_E2E_LOCAL_FULL=1` is a human-only
  escape hatch: it prints a banner, and agents never set it.
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
  - **Rule, in order:**
    1. Strip the e2e-irrelevant set: `test/unit/**`, `docs/**`, `*.md`, `designs/**`,
       `.conduit/**`, and `.github/**` except `.github/workflows/e2e.yml`. If nothing is left, the
       selection is none: "no e2e needed", exit 0.
    2. Any change to `test/e2e/**`, `electron/main.ts`, `electron/preload.ts`, `esbuild.mjs`,
       `package.json`, the lockfile or `e2e.yml` selects the full suite.
    3. A mapped file selects its scenarios. A **new** file selects the scenarios of the files that
       import it (esbuild metafile importers, walked up to the nearest mapped file); only if none is
       mapped does it select the full suite. An existing file absent from the map selects the full
       suite.
    4. The core smoke set is always added.
  - The diff base is the merge-base with `main`; the workflow checks out with full history to
    compute it.
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

- **`npm run e2e:remote -- [--full | --affected | <name>…] [--shards N] [--no-wait] [--timeout <min>]`**
  - Preconditions: a clean committed HEAD (a dirty tree → error naming the files, nothing pushed);
    `gh` authenticated.
  - When a run has `INFRA` scenarios, the command prints the line that re-runs only them:
    `npm run e2e:remote -- <INFRA names>` (with the run's sha). There is no retry flag.
  - `--timeout` counts from the run's start; queue time is reported separately.
  - Exit codes: **0** passed / flaky-passed / no e2e needed; **1** failed (including a run that
    also has INFRA scenarios); **2** infra-error (INFRA and no FAIL/TIMEOUT) / cancelled /
    timed-out / preconditions; **3** dispatched with `--no-wait`, not awaited.
  - The command never deletes a ref.
- **`e2e.yml`:**
  - Triggers: `workflow_dispatch` (inputs `selection`, `scenarios`, `base`, `shards`, `nonce`) and
    `schedule` (nightly, `main`, `--full`, plus a backstop sweep deleting `ci/e2e/*` refs older than
    24 h, for refs whose run never started).
  - `run-name` embeds the nonce. No workflow-level `concurrency`.
  - Permissions: `contents: read`, `actions: read` (download the previous nightly's state). Only
    the final `cleanup` job (`if: always()`, deletes `github.ref` when it starts with
    `refs/heads/ci/e2e/`) and the sweep job get `contents: write`.
  - Must exist on the default branch before it can be dispatched (Slice 0 lands it first).
  - A `verify` job calls `verify.yml` (`workflow_call`; input `verify`, default true) and is part of
    the verdict: a failed verify makes the run `failed` (exit 1) and the summary says so. It is the
    remote integration gate while local `npm run verify` is paused.
  - `test/e2e/remote-exclusions.json` (`{ "<name>": "<reason>" }`) lists scenarios the hosted
    runner can't run. `prepare` drops them from the plan and the result lists each as `EXCLUDED`
    with its reason (never silently); EXCLUDED is neutral to the verdict, but a selection with
    nothing left to run is `failed`, like all-SKIP.
- **Scenario status:**
  - `PASS`, `SKIP`, `FAIL` (runner exit 1 = assertion, 2 = uncaught exception — both are test
    failures), `TIMEOUT` (the harness watchdog's exit 124, or the runner's 210 s kill), `FLAKY`,
    `QUARANTINED-FAIL`, and `INFRA` (no result for a planned scenario; set by report).
  - Runner `EXIT(n)` maps to `FAIL`. Shards are classified from their result JSON only, never from
    a job's exit code.
  - **Run status, first match wins:** any FAIL/TIMEOUT → `failed`; any INFRA → `infra-error`;
    all SKIP → `failed`; any FLAKY → `flaky-passed`; else `passed`. A run whose conclusion is
    cancelled is reported `cancelled`, whatever its result JSON says.
  - **All-SKIP for a non-empty selection = run `failed`**: guards a vacuous green on a future
    non-Windows OS axis.
- **Result JSON:**
  `{ sha, nonce, selection, shards, queuedAt, startedAt, finishedAt, results: [{ name, status,
  seconds, attempts, shard, artifact? }] }`
- **Nightly state:** a `e2e-state` artifact holding `timings.json` (scenario → median s),
  `coverage-map.json` and `flaky-history.json` (14-day rolling), retained 30 days.
  - Each nightly's separate `state` job downloads the previous state, updates it and re-uploads,
    **whatever the test verdict** (a red nightly still records timings and flakes).
  - `prepare` and `state` find the newest non-expired `e2e-state` artifact by name
    (`actions/artifacts?name=e2e-state`), never by run conclusion.
  - Fallbacks when there is no state yet: the checked-in `test/e2e/timings.seed.json` (local
    medians, scaled by the Slice 0 slowdown factor); `--affected` → full suite.
- **Failure artifacts:** hooked in the harness's `launchElectron`. On CI it starts Playwright
  tracing on the Electron context. The harness owns the exit path: scenarios exit only through
  `finishScenario(code)`, which on a non-zero code saves the trace and a screenshot of every open
  window before exiting, and a watchdog (`E2E_DEADLINE_MS`, 200 s, set by the runner) does the same
  and exits TIMEOUT before the runner's 210 s kill. Files go to
  `$E2E_ARTIFACT_DIR/<scenario>/attempt-<n>/`, with the runner's log beside them; a passing attempt's
  dir is removed. Uploaded only for failures, kept 7 days. Screenshot of a hidden (`show:false`)
  window works via `page.screenshot` (**Measured**, Slice 0) at 1.3–7.6 s per window, so it is
  taken only on failure, time-capped. Tracing is **snapshots-only, started once the first window is
  ready** (Slice 0 results, §2). Every app is traced and its trace saved at teardown; screenshots
  come from the apps still open on the failure path (`finishScenario`, `runScenario` and the
  auto-save helpers capture before their own teardown). A scenario that closes its app itself
  before exiting non-zero leaves its trace and log, not a screenshot.

| Data / state | Produced by | Consumed by | Both in scope? |
|---|---|---|---|
| Scenario results | `run-smoke.mjs` in a shard | report job → `e2e:remote` → agent evidence | Yes |
| Shard plan | prepare (selection + timings) | shard jobs | Yes |
| timings / coverage map / flaky history | nightly report (artifact) | prepare, `--affected`, report | Yes |
| Quarantine list | human/agent commit | runner, report | Yes |
| Ephemeral refs | `e2e:remote` (create) | `e2e.yml` checkout; the run's own `cleanup` job deletes it; nightly sweep as backstop | Yes |
| e2e lock + priority | `launchElectron` | every local launch (scenarios, text-fit, shots) | Yes |
| e2e evidence | `e2e:remote` | build-loop gates (B5, outside repo) | Yes — flagged §14 Q4 |
| Release | `release.yml` | users | **Flagged** — §14 Q2 |

## 4. Edge cases & failure modes

| Condition | Expected behavior |
|---|---|
| Two callers, same sha + selection | Second attaches to the first's run (found by querying in-flight runs' names/inputs) and pushes no ref; the run's `cleanup` job deletes the one ref |
| Two `--full` for different SHAs | Second waits client-side for the first to finish, printing "waiting for full run <url>", then dispatches. Best-effort: nightly/release don't coordinate, and an overlap only queues jobs |
| New commit while an older run is in flight | Older run continues (an agent may be gating on it) |
| Selection resolves to zero on a code change | Impossible by the §B2 rule (unmapped → full); docs-only → exit 0 "no e2e needed" |
| Shard runner dies | Its unfinished scenarios → `INFRA`. Any FAIL/TIMEOUT elsewhere → run `failed`, exit 1; otherwise `infra-error`, exit 2. Either way the command prints `e2e:remote -- <INFRA names>` |
| Run cancelled | `cancelled`, exit 2, even though report wrote INFRA rows; `cleanup` still deletes the ref |
| Scenario hangs | Harness watchdog at 200 s captures screenshot + trace and exits TIMEOUT; the runner's 210 s kill is the backstop (log only); orphan sweep, one retry |
| Scenario exits with its app still open (a direct-exit scenario's assertion path) | `finishScenario` captures that app before exiting; bare `process.exit` in a scenario fails a unit guard |
| Fails only remotely | FAIL with artifacts. Known env differences (Slice 0, §2): runner display smaller than saved window bounds; the window has no OS focus (xterm focus reports, focus-dependent and non-hidden scenarios); hover reveal in `review-mode-pane`. Fixed in the workflow: 8.3 `TEMP`, lazy Electron download, depth-1 clone, no Go, npx cache location. Those that still fail after a bounded attempt to make them runner-independent are in `test/e2e/remote-exclusions.json`: skipped remotely, listed EXCLUDED with the reason, still runnable locally one at a time |
| Hosted queue > 10 min | Keep waiting and print state every minute (queue time doesn't count toward `--timeout`); `--no-wait` returns the URL, exit 3 |
| Client killed (Ctrl-C) mid-wait | Run continues; its `cleanup` job deletes the ref |
| `gh` unauthenticated / offline | Exit 2 with the fix; no local full-suite fallback |
| Local lock owner process dead | The OS closes its pipe; the next waiter's `listen` succeeds immediately |
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
| Full runs in flight | 1 per `e2e:remote` caller (client-side wait); no workflow group | no | Protects the ~20-job pool without GitHub's cancel-older-pending behaviour; nightly/release overlap only queues jobs |
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
  - `e2e:remote` (full, names; dedup; client-side full-run wait; result JSON);
  - workflow-owned ref cleanup;
  - failure artifacts, with the harness owning the exit path (`finishScenario`, watchdog);
  - retry-once + FLAKY;
  - local exact-name single instance with lock + priority in `launchElectron`;
  - `run-smoke` local refusal;
  - runner comment corrected;
  - `timings.seed.json`;
  - the `verify` job in the verdict and `remote-exclusions.json` (Slice 0 conductor decisions).
- **v1:**
  - nightly + `e2e-state`;
  - `--affected` + coverage map + the core smoke set (`core-smoke.json`);
  - quarantine list and candidates;
  - split the >120 s scenarios;
  - release gating (per §14 Q2), after quarantine has landed;
  - `verify:quick`;
  - B5 and B7 outside the repo.
  - *Built on feat/remote-e2e-v1 (all but B5/B7), measured in §2 "v1 results".* The nightly
    `schedule` itself first fires once `e2e.yml` is on main; until then its path is exercised by
    dispatching `mode=nightly`.
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
- While not on CI, `launchElectron` shall allow at most one e2e app on the machine, at BelowNormal
  priority.
- If `run-smoke.mjs` runs locally with no filter or a filter matching more than one scenario, then
  it shall refuse and print the `e2e:remote` equivalent.
- When a scenario fails remotely, the system shall publish its log, window screenshots and trace,
  and link them in the summary.
- If a scenario fails and then passes on retry, then the run shall pass with that scenario FLAKY.
- If a shard job fails, then its unfinished scenarios shall be `INFRA`, and the command shall print
  the `e2e:remote` line that re-runs them and exit 2 only if no scenario FAILed or timed out
  (otherwise the run is `failed`, exit 1).
- If a scenario hangs past its deadline, then the harness shall save its window screenshots and
  trace and exit TIMEOUT before the runner kills it.
- If every scenario in a non-empty selection is SKIP, then the run shall be `failed`.
- When a run on a `ci/e2e/*` ref reaches a terminal state, including cancelled, the workflow shall
  delete that ref.

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

- **Measured (Slice 0):** `windows-latest` runs the suite hidden at p50 0.93× / p90 1.03× local
  speed, with 17 jobs running concurrently; 151/158 PASS after the env fixes in §2.
- **Measured (Slice 0):** `page.screenshot` works on a `show:false` Electron window (1.3–7.6 s
  each), and Playwright tracing works on `electronApp.context()` when snapshots-only and started
  after the window is ready.
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
