# Plan: Remote e2e on GitHub Actions + a leaner dev loop

Spec: [`docs/specs/2026-09-29-remote-e2e-lean-loop.md`](../specs/2026-09-29-remote-e2e-lean-loop.md).
The rationale is in the spec; this plan covers files, interfaces, order and verification.
Interim rule: **no local `npm run verify`, no local suite, no builds or installs** until
Slice 0's remote run exists. Local checks are limited to targeted `npx vitest run <file>`, `npx biome check <files>`,
and **one** local scenario at a time, run through `.autoloop/heavy-lock.mjs`.

## Facts this plan rests on (checked 2026-09-29)

| Fact | Evidence |
|---|---|
| **159** scenarios; **60** files don't use `runScenario` | `ls test/e2e/*.e2e.mjs`; `grep -L runScenario` |
| **13 scenarios bypass `launchApp` too**: they call `loadPlaywright()._electron.launch` directly (durability, scrollback ×2 launches, scrollback-restore, scrollback-mode-neutralize, sidebar-dnd, commit-detail-resize, editor-tabs-persist, multi-window-restore, recent-folders-prune, review-keymap-persist, session-restore-toggle, timed-messages, timed-messages-concurrency) | `grep -c "_electron.launch" test/e2e/*.e2e.mjs` |
| `text-fit`, `shots`, stress harness go through `launchApp` | `visual/text-fit-sweep.mjs:467`, `visual/shoot.mjs:523`, `stress/harness-stress.mjs:71` |
| Playwright is not a dependency; `loadPlaywright` takes the first hit in node_modules or the npx cache. The local cache holds 1.60–1.63, so which version loads isn't deterministic | `harness.mjs:46-62` |
| Timing seed: 870 evidence files, 2 661 result lines, PASS-only medians for **all 159**, Σ medians **99.9 min** | parse of `.autoloop/**` + `docs/runs/**`, regex `^\s+(name) \.\.\. \S+ (STATUS) \(([\d.]+)s\)` |
| `.gitattributes` is `* text=auto eol=lf`, so CRLF checkout is not a risk on windows-latest | file read |
| Local `main` is **ahead 8** (73879a6…57bfbf1), not 3. The spec itself exists only in unpushed 57bfbf1 | `git log origin/main..main` |
| Fallow entries include `test/e2e/*.mjs` and `tools/*.mjs`, but not `test/e2e/<subdir>/` | `.fallowrc` |
| `verify.yml` triggers only on `push: main` and `pull_request`, so pushing `ci/e2e/*` refs runs nothing else | workflow file |

## Slice 0 — spike

**Mechanics (decided): land a stub `e2e.yml` on `origin/main`, then iterate on `ci/e2e/*` refs.**
A `workflow_dispatch` runs the workflow file **from the dispatched ref**. Only its *existence* on the
default branch is required. So `main` is written to once, with a stub, and the real workflow and
runner changes are exercised from a branch ref. This beats a temporary `push: ci/e2e/**` trigger in
two ways:
- the spike exercises the real dispatch path and `run-name` correlation, which MVP depends on;
- there's no trigger to remove afterwards.

The spike ref is based on `origin/main` (05d9bf3, released 0.45.0), so the app under test is exactly
`main`'s. That stands in for the spec's "dispatch at main" (§6).

### File map (Slice 0)
| File | Where | Purpose |
|---|---|---|
| `.github/workflows/e2e.yml` (stub) | commit on `origin/main` | `workflow_dispatch` with the final input names, one no-op job; makes dispatch possible |
| `.github/workflows/e2e.yml` (real) | spike ref | prepare/shards/report, static split, Windows caches, a probe step |
| `test/e2e/ci-shard-plan.mjs` | spike ref → MVP | pure LPT split |
| `test/e2e/timings.seed.json` | spike ref → MVP | local medians + `scale` |
| `test/e2e/run-smoke.mjs` | spike ref → MVP | adds `--exact <names…>` and `--json <path>` only |
| `test/e2e/ci-probe.e2e.mjs` | **spike ref only, never merged** | hidden-window `page.screenshot`, `app.context().tracing` start/stop, and their cost |
| `test/unit/e2e-shard-plan.test.ts` | spike ref → MVP | split invariants |

### Interfaces
- `e2e.yml` dispatch inputs are final from day one, so the stub and the real file agree:
  `selection: 'full'|'names'|'affected'`, `scenarios: string` (space-separated exact names),
  `base: string` (sha, affected only), `shards: string` (`'0'` = auto), `nonce: string`.
  `run-name: e2e ${{ inputs.selection }} ${{ inputs.nonce }}`.
- `planShards(names: string[], timings: Record<string, number>, opts: { shards?: number; targetSec?: number /*600*/; cap?: number /*16*/; scale?: number; setupSec?: number }): { shards: { index: number; names: string[]; estSec: number }[] }`.
  - Greedy LPT: sort by estimate descending, assign each to the least-loaded shard.
  - A name missing from timings gets the median of the known ones.
  - Auto count: `ceil(Σ·scale / targetSec)`, clamped to `[1, min(cap, names.length)]`.
- `timings.seed.json`: `{ "source": "local PASS medians, .autoloop/evidence + docs/runs, 2026-09-29", "scale": 1.5, "medians": { "<name>": seconds } }`.
  Generated **once** by a scratch parse script in `%TEMP%\claude-scratch\`, never committed. The regex
  is in the facts table.
- `run-smoke.mjs --exact a b c --json out.json`: exact file-stem match. An unknown name exits 1. The
  JSON is rewritten after **each** scenario (`[{ name, status, seconds }]`), so a dying shard keeps
  what it finished.

### Steps
1. Branch `ci/e2e-stub` from `origin/main`.
   - Add the stub `e2e.yml`: inputs as above, one job `echo`, `permissions: contents: read`.
   - Push it as a **fast-forward of `origin/main`**: `git push origin ci/e2e-stub:main`. Never push
     local `main`.
   - Afterwards, local `main` has diverged by one commit. Integrate it with `git merge origin/main` at
     the user's say-so; don't rebase, because local history holds merge commits.
   - *Verify:* `gh workflow list` shows `e2e`; `gh workflow run e2e.yml --ref main -f selection=full -f nonce=stub1` produces a run titled `e2e full stub1`.
2. On the spike branch `ci/e2e/spike-<nonce>` (from `origin/main`), add `ci-shard-plan.mjs` and its
   unit test.
   - *Verify:* `npx vitest run test/unit/e2e-shard-plan.test.ts`. Cases:
     - every name is placed exactly once;
     - max shard ≤ ideal + largest item;
     - `cap` is respected;
     - an unknown name gets the median.
3. Generate `timings.seed.json` from the scratch parse and set `scale` to 1.5, the midpoint of the
   ASSUMED 1.3–2× range.
   - *Verify:* `npx biome check test/e2e/timings.seed.json`; the key set equals the 159 scenario
     stems.
4. `run-smoke.mjs`: add `--exact` and `--json`; the substring path stays for now.
   - *Verify:* one local scenario,
     `node .autoloop/heavy-lock.mjs . node test/e2e/run-smoke.mjs --exact session-bootstrap --json %TEMP%\claude-scratch\r.json`.
5. Write the real `e2e.yml` on the spike ref.
   - **prepare** (ubuntu-latest):
     - `node -e` runs `planShards` over all stems with `shards: 16`;
     - outputs `matrix = {"include":[{"shard":1,"names":"a b …"},…]}`.
   - **shard** (windows-latest, `fail-fast: false`, `timeout-minutes: 45`):
     - Checkout v5.
     - `setup-node@v5` (node 22, `cache: npm`).
     - `actions/cache@v4` on `~\AppData\Local\electron\Cache`, key `electron-${{ runner.os }}-${{ hashFiles('package-lock.json') }}`.
     - `HUSKY=0 npm ci`, then `npm run build`.
     - `npx -y playwright@1.63.0 --version`, which populates the npx cache that `loadPlaywright` reads.
       Pin via `env.PLAYWRIGHT_VERSION`.
     - `git config --global user.name/user.email` (the hosted runner has no identity; a dev machine
       does).
     - Run `run-smoke --exact $names --json results/shard-N.json`.
     - A `pwsh` wrapper treats exit ≤ 1 as a completed shard and anything else as infra.
     - Upload `e2e-results-N` with `if: always()`.
     - Print step timings.
   - **report** (ubuntu-latest, `if: always()`): downloads, concatenates, and writes a markdown table
     to `$GITHUB_STEP_SUMMARY`.
   - **probe** job (spike only; windows-latest): runs `ci-probe.e2e.mjs`, which launches hidden and
     does all of the following:
     - `page.screenshot`;
     - `app.context().tracing.start({screenshots:true,snapshots:true})` → `stop({path})`, timing each;
     - uploads the outputs.
   - *Verify:* the dispatch itself.
6. Dispatch: `gh workflow run e2e.yml --ref ci/e2e/spike-<nonce> -f selection=full -f shards=16 -f nonce=<nonce>`. Find the run by title.
   - If fewer than about 3 remote-only failures show up, run it a second time to separate flakes.
7. Delete the spike ref once its results are recorded. Keep the branch locally as MVP's starting
   point.

### Record back into the spec (update the §2 row, §4 and §12, then flip them from ASSUMED to Measured)
- **Timing:** wall time split into queue / setup / run / report. Setup: `npm ci` warm vs cold,
  electron cache hit vs miss, build time.
- **Slowdown:** the per-scenario factor (remote/local median; report p50 and p90) plus outliers
  above 2.5×. **Replace `scale` in the seed with the measured p50.**
- **Concurrency:** how many of the 16 shards ran at once.
- **Remote-only failures:** each with its cause (clipboard, GPU/swiftshader, DPI, focus for
  `attention`, git identity, PowerShell availability for `cwd`).
- **Probe results:** whether hidden-window `page.screenshot` works, whether tracing works on
  `electronApp.context()`, trace stop time and size on the 3 longest scenarios.
- **Workflow behaviour:** whether `workflow_dispatch` honoured the ref's inputs.
- **Tuning:** the resulting default for shard count/target.

## MVP

### File map
| File | New/changed | Purpose |
|---|---|---|
| `test/e2e/ci-shard-plan.mjs` | from spike | shard split |
| `test/e2e/ci-merge-results.mjs` | new | merge shard JSON → result JSON; INFRA fill; run status; INFRA re-run line |
| `test/e2e/smoke-select.mjs` | new | runner arg resolution, local refusal, exit→status classification |
| `test/e2e/local-guard.mjs` | new | named-pipe machine lock + BelowNormal (local only) |
| `test/e2e/failure-artifacts.mjs` | new | CI tracing, screenshots, per-attempt artifact dir |
| `test/e2e/harness.mjs` | changed | `launchElectron` choke point, `finishScenario` exit path, deadline watchdog |
| 13 bypassing `*.e2e.mjs` | changed | `_electron.launch(` → `launchElectron(` |
| 65 `*.e2e.mjs` calling `process.exit` | changed | `process.exit(n)` → `finishScenario(n)`; assertions untouched |
| `test/e2e/run-smoke.mjs` | changed | exact names only, local refusal, escape hatch, retry→FLAKY, JSON, logs, child env, header comment fixed |
| `test/e2e/timings.seed.json` | from spike | `scale` = measured |
| `.github/workflows/e2e.yml` | changed | MVP jobs, artifacts, result JSON, ref cleanup job |
| `tools/e2e-remote.mjs` | new | `npm run e2e:remote` CLI (thin `gh`/`git` I/O) |
| `tools/e2e-remote-lib.mjs` | new | pure: args, run-name, in-flight match, printing, exit code |
| `package.json` | changed | `"e2e": "node test/e2e/run-smoke.mjs"`, `"e2e:remote": "node tools/e2e-remote.mjs"`; `test:smoke` kept as an alias of `e2e` |
| `test/unit/e2e-{merge-results,smoke-select,local-guard,remote,harness-guards}.test.ts` | new | see steps |
| `CLAUDE.md`, `test/e2e/README.md`, `docs/specs/INDEX.md` | changed | e2e rules → local single / remote; spec status |

### Interfaces
- **Runner → scenario env** (the interface; nothing reads `argv[1]`): `CONDUIT_E2E=1`,
  `E2E_SCENARIO=<stem>`, `E2E_ATTEMPT=<1|2>`, `E2E_DEADLINE_MS=200000` (runner kill stays 210 s),
  and on CI `E2E_ARTIFACT_DIR=<abs dir>`.
- **`launchElectron(launchOpts): Promise<ElectronApplication>`** (harness): the **only** caller of
  `_electron.launch`.
  1. Not on CI (`process.env.GITHUB_ACTIONS !== 'true'`): `await acquireE2eLock({ scenario })`, then
     `setBelowNormal()`.
  2. Launch, then add the app to the module's live set (removed when it closes).
  3. On CI: `startCapture(app)`. The first call per process also arms the watchdog and routes
     `uncaughtException`/`unhandledRejection` to `finishScenario(2)`.

  `launchApp` (`harness.mjs:131-137`) calls it. `loadPlaywright` stays exported for other uses.
- **`finishScenario(code: number): Promise<never>`** (harness): the **only** exit path for a
  scenario. First call wins; later calls (watchdog firing mid-exit, a second `catch`) return the same
  promise.
  - With an artifact dir and `code !== 0`: `captureNow` every live app, then `app.close()` it, all
    inside `CAPTURE_BUDGET_MS = 8000` (`Promise.race`; the runner's orphan sweep stays the backstop).
  - With an artifact dir and `code === 0`: `rmSync(attemptDir, { recursive: true, force: true })`.
  - Then `process.exit(code)`. Locally it goes straight to `process.exit`.
  - `runScenario`'s two `process.exit` calls (`harness.mjs:753,782`) become `finishScenario`.
- **Watchdog** (armed by `launchElectron`, only when `E2E_DEADLINE_MS` is set):
  `setTimeout(fire, E2E_DEADLINE_MS - process.uptime() * 1000).unref()`. `fire` logs
  `[harness] WATCHDOG <ms>` and calls `finishScenario(EXIT_WATCHDOG = 124)`. 200 s + 8 s budget
  lands before the runner's 210 s kill.
- **`local-guard.mjs`:**
  - `acquireE2eLock({ pipePath = '\\\\.\\pipe\\conduit-e2e', scenario, pollMs = 1000, log = console.log }): Promise<void>`.
    - Holding the lock = listening on the pipe: `net.createServer(s => s.end(JSON.stringify({ pid, scenario, cwd })))`,
      `server.unref()`. The OS releases it when the process dies, so there is no stale-lock,
      PID-probe or age logic.
    - `EADDRINUSE` = held: connect, read the owner JSON (unreadable → `unknown`), log
      `[e2e-lock] waiting for pid <p> (<scenario>, <cwd>)` once and then every 30 s, retry `listen`
      every `pollMs`.
    - **Re-entrant per process** (module flag; durability, scrollback and text-fit relaunch).
    - `releaseE2eLock()` (closes the server) is exported for tests; real release is process exit.
  - `setBelowNormal(): void`: `os.setPriority(0, PRIORITY_BELOW_NORMAL)` on the **scenario's own
    node process**, before the first launch. Windows children inherit BelowNormal, so Electron, GPU,
    renderers and PTY shells get it without a per-PID sweep.
    - Skipped when `CONDUIT_E2E_PRIORITY=normal`.
    - MVP measures whether Chromium re-raises renderer or GPU priority (R6).
- **`failure-artifacts.mjs`** (CI only). `attemptDir()` =
  `$E2E_ARTIFACT_DIR/<E2E_SCENARIO>/attempt-<E2E_ATTEMPT>/`, or `null` unless all three are set.
  Everything is written there **in place**; there is no staging dir and no rename.
  - `startCapture(app)`: `app.context().tracing.start({ screenshots: true, snapshots: true })`;
    wraps `app.close` so it captures first.
  - `captureNow(app): Promise<void>`: screenshots every `app.windows()` page to `win-<i>.png`,
    `tracing.stop({ path: 'trace-<k>.zip' })`; idempotent per app.
  - Called from `closeApp` (`harness.mjs:338`, first line), `shutdownApp` (`:99`, before the
    graceful race), the wrapped `app.close`, and `finishScenario`. Teardown capture covers the
    bypassing scenarios that close their app in `catch` before exiting; `finishScenario` covers the
    ones that exit with the app still open (durability's assertion path, `:143-146`).
- **`run-smoke.mjs` CLI:** `node test/e2e/run-smoke.mjs <name…> [--names-file f.json] [--json out.json] [--artifacts dir] [--retry]`.
  - Names are exact stems. The substring path is **removed**.
  - Not on CI:
    - more than one name, or none → **refuse**, exit 2, print `npm run e2e:remote -- <names>|--full`;
    - `CONDUIT_E2E_LOCAL_FULL=1` → a banner, nothing else;
    - any non-PASS → the loaded-machine reminder (spec §4).
  - Classification (`smoke-select.mjs classify`):
    - `0` → PASS (SKIP if the output matches `\bSKIP\b`);
    - `124` → TIMEOUT (watchdog; artifacts captured);
    - `ETIMEDOUT` or a signal → TIMEOUT (runner kill; log only);
    - any other code → **FAIL**, with `exit n` on the line.
  - `--retry`: after a non-PASS/SKIP result, the orphan sweep (:126), `SETTLE_MS`, a new child with
    `E2E_ATTEMPT=2`. A pass → **FLAKY**, `attempts: 2`.
  - `--artifacts dir` sets `E2E_ARTIFACT_DIR`; the runner writes `dir/<name>/attempt-<n>/log.txt`
    (that attempt's stdout+stderr) for every non-PASS attempt.
  - The JSON is rewritten after each scenario. Exit: `0` all PASS/SKIP/FLAKY; `1` a failure; `2`
    usage or refusal.
- **Result JSON** is exactly as in spec §3. `shard` is a number, `artifact` a URL; the run-level
  `status` and `url` sit alongside `results`.
- **`mergeResults(plan, shardFiles: {shard, results}[], meta: {sha, nonce, selection, runId, queuedAt, startedAt, finishedAt, artifactUrls: Record<number,string>}): ResultJson`**:
  - a planned name with no result becomes `INFRA`;
  - `runStatus(results)`, first match wins:
    1. empty → `passed`;
    2. any FAIL or TIMEOUT → `failed` (INFRA names still listed);
    3. any INFRA → `infra-error`;
    4. all SKIP → `failed`;
    5. any FLAKY → `flaky-passed`;
    6. otherwise `passed`.
  - `infraRerunLine(results): string | null` → `npm run e2e:remote -- <INFRA names>`.
- **`e2e.yml` (MVP):**
  - **No `concurrency` block.** `permissions: { contents: read, actions: read }`; only `cleanup`
    gets `contents: write`.
  - Inputs and matrix values reach scripts only through `env:` (`E2E_NAMES: ${{ matrix.names }}`),
    never `${{ }}` inside `run:`.
  - **prepare** outputs `matrix`, `plan` and `count`. Shard count 0 = auto (seed × `scale`).
  - **shard** (`if: needs.prepare.outputs.count != '0'`, since an empty `include` fails the run):
    - `run-smoke --names-file shard.json --json results/shard-N.json --artifacts artifacts --retry`;
      its exit code fails the job when any scenario failed. The Slice 0 pwsh "exit ≤ 1 = completed"
      wrapper is dropped: **the report classifies from the JSON only**.
    - Uploads `e2e-results-N` and `e2e-fail-N`, both `if: always()`; the latter
      `if-no-files-found: ignore`, `retention-days: 7`.
  - **report** (`needs: [prepare, shard]`, `if: always()`):
    - builds per-shard artifact URLs from `gh api …/runs/$RUN/artifacts` and timestamps from
      `gh api …/runs/$RUN`;
    - runs `mergeResults`, writes the summary table with artifact links and the INFRA re-run line;
    - uploads `e2e-result` (`result.json`, 14 days);
    - **exits 1 unless passed or flaky-passed** (v1's `workflow_call` gate).
  - **cleanup** (`needs: [prepare, shard, report]`,
    `if: always() && startsWith(github.ref, 'refs/heads/ci/e2e/')`, `permissions: contents: write`):
    `gh api -X DELETE "repos/$GITHUB_REPOSITORY/git/refs/heads/${GITHUB_REF#refs/heads/}"`. A 422
    "Reference does not exist" counts as done; any other error fails the job. The workflow owns
    its ref, so a cancelled run or a killed client still cleans up.
- **`tools/e2e-remote.mjs`:** `npm run e2e:remote -- (--full | <name…>) [--shards N] [--no-wait] [--out <dir>] [--timeout <min=60>]`.
  1. **Preconditions** (exit 2): `gh auth status`; `git status --porcelain` empty (else list the
     files); every name is a `test/e2e/<name>.e2e.mjs`; no selection → "pass --full or names
     (--affected lands in v1)".
  2. **Key.** `sha = git rev-parse HEAD`; `selKey = 'full' | 'n-' + sha256(sorted names).slice(0,8)`;
     `nonce = <selKey>.<8 hex>`, so the title carries the key.
  3. **In-flight check** (`gh run list -w e2e.yml --json databaseId,displayTitle,status,headSha,url -L 50`,
     status ∈ {queued, in_progress, waiting, pending, requested}), via `matchInFlight`:
     - same `headSha` and `selKey` → **attach**, push nothing;
     - `--full` and another full run in flight → print
       `waiting for full run <url> (<sha7>) to finish before dispatching`, poll every 30 s until it
       is terminal, then repeat step 3. Best-effort: two waiters can both dispatch, and nightly and
       release don't coordinate with it (R4).
  4. **Push.** `git push origin HEAD:refs/heads/ci/e2e/<sha7>-<rand>`; publishing unpushed ancestors
     is accepted (spec §14 Q1).
  5. **Dispatch.** `gh workflow run e2e.yml --ref <ref> -f selection=… -f scenarios=… -f shards=… -f nonce=<nonce>`.
  6. **Locate.** Poll `gh run list -w e2e.yml -b <ref>` every 3 s, up to 90 s, for the nonce; print
     the URL. Not found → infra, exit 2 (the ref is left for the v1 sweep).
  7. **Wait.** Poll `gh run view <id> --json status,conclusion,jobs,startedAt` every 20 s; print
     state changes (`queued` / `preparing` / `running k/N` / `reporting`) and a 60 s heartbeat.
     - `--timeout` counts from the run's `startedAt`; queue time is printed separately. Hitting it →
       `timed-out`, exit 2, run left alone.
     - `--no-wait` prints the URL and exits **3**.
  8. **Result.**
     - Conclusion `cancelled` → `cancelled`, whatever `result.json` says (report still writes INFRA
       rows for a cancelled run). A missing `e2e-result` → `infra-error`.
     - Otherwise `gh run download <id> -n e2e-result`; print `  name ... ✓ PASS (12.3s) [s3]`
       lines, the summary, artifact links, and the INFRA re-run line (with the run's sha7, which may
       differ from HEAD).
     - Write `<out>/e2e-<runId>.json` (`--out`, else `$E2E_EVIDENCE_DIR`, else
       `%TEMP%\conduit-e2e\`); keyed by run id, so idempotent.
  9. **Exit.** `0` passed / flaky-passed; `1` failed; `2` infra-error, cancelled, timed-out,
     preconditions; `3` dispatched, not awaited. The client never deletes a ref and has no SIGINT
     handling: Ctrl-C just exits.

  Pure pieces in `e2e-remote-lib.mjs`: `parseArgs`, `selectionKey`, `makeNonce`,
  `matchInFlight → { attach } | { waitFor } | { dispatch }`, `runState(runView)`, `formatResults`,
  `exitCodeFor(status)`.

### Steps
1. Pure modules and tests: `ci-merge-results`, `smoke-select`, `e2e-remote-lib`.
   - *Verify:*
     `npx vitest run test/unit/e2e-merge-results.test.ts test/unit/e2e-smoke-select.test.ts test/unit/e2e-remote.test.ts`.
   - Cases: a missing name → INFRA; FAIL + INFRA → `failed` with the INFRA re-run line; INFRA only →
     `infra-error`; all-SKIP → failed; FLAKY-only → flaky-passed; exit 124 → TIMEOUT; exit 2 → FAIL;
     a local call with 2 names refuses; the escape-hatch banner; same sha + selKey → attach; `--full`
     with a full run at another sha → waitFor; different sha for names → dispatch; the state mapping
     from a canned `gh run view`; a cancelled conclusion beats `result.json`; `--no-wait` → 3.
2. `local-guard.mjs` and its test. CI runs units on ubuntu, so the test passes
   `pipePath = join(tmpdir(), 'e2e-lock-<rand>.sock')` off win32.
   - *Verify:* `npx vitest run test/unit/e2e-local-guard.test.ts`. Cases: acquire; a second acquirer
     (child process) waits and logs the owner's `{pid, scenario, cwd}`; SIGKILL on the owner child
     frees the lock at once; re-entrant in one process.
3. Harness: `launchElectron`, `finishScenario`, watchdog, `failure-artifacts.mjs`; rewire
   `launchApp`, `runScenario`, `closeApp:338`, `shutdownApp:99`; migrate the 13 launches.
   - **Exit-path migration**: every `process.exit(n)` in `test/e2e/*.e2e.mjs` →
     `await finishScenario(n)` (bare `finishScenario(n)` inside a sync callback; it never returns).
     `grep -l "process.exit" test/e2e/*.e2e.mjs` lists 65 files on 2026-09-29: all 60 files that
     bypass `runScenario` except auto-save, auto-save-basics and file-integrity (durability, cwd,
     attention, dnd, paste, reveal, git-history, logging, open-with, session-restore-toggle,
     editor-tabs-persist, commit-detail-resize, …), plus 8 `runScenario` files with early exits
     (html-viewer, md-file-links, nav-keybindings-settings, new-session-folders, overlay-popovers,
     preview-transport, recent-folders-prune, search-selection). Re-grep before migrating.
   - Guard test `test/unit/e2e-harness-guards.test.ts` (the `drag-region.test.ts` pattern): fails on
     `_electron.launch`/`electron.launch(` outside `harness.mjs`, and on `process.exit(` in any
     `test/e2e/*.e2e.mjs`.
   - *Verify:*
     - the guard test; `npx biome check test/e2e`;
     - **one** local scenario through heavy-lock: `npm run e2e -- durability` (migrated relaunch);
     - the lock: `npm run e2e -- session-bootstrap` from a second shell prints "waiting for …" and
       launches after the first finishes (spec Gherkin 2);
     - meanwhile
       `Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | % { (Get-Process -Id $_.ProcessId).PriorityClass }`
       shows BelowNormal for all.
4. `run-smoke.mjs` changes; fix the header comment (`:1-19`: the ~4 min claim, substring filter).
   - *Verify:* no args refuses (exit 2, no app); `a b` refuses; `nope` exits 1; one real scenario
     passes.
5. `e2e.yml` MVP on a `ci/e2e/*` ref, built together with step 6's CLI.
   - *Verify, remote only* (each on a scratch branch never merged):
     - `e2e:remote -- session-bootstrap cwd quit-guard auto-save-basics --no-wait` → exit 3, then the
       same awaited → passed.
     - **Forced failure in a migrated non-`runScenario` file:** `assert(false)` after launch in
       `cwd` → exit 1; `e2e-fail-N` holds `cwd/attempt-1/` and `cwd/attempt-2/`, each with
       `log.txt`, `win-0.png`, `trace-0.zip`; the summary links it.
     - **Forced hang:** `await new Promise(() => {})` after launch in `session-bootstrap` → TIMEOUT
       via exit 124 (the log shows `WATCHDOG`, not the runner kill), with `win-0.png` and a trace
       per attempt.
     - **Flake:** fail only when `E2E_ATTEMPT === '1'` → FLAKY; `attempt-1/` kept, no `attempt-2/`.
     - After each run, `git ls-remote origin 'refs/heads/ci/e2e/*'` no longer lists its ref.
6. `tools/e2e-remote.mjs`.
   - *Verify:* two shells run `e2e:remote -- cwd` at the same sha → the second prints "attaching to
     run …" and pushes no ref; two `--full` at different SHAs → the second prints "waiting for full
     run …" and dispatches after the first ends; a dirty tree → exit 2 with the file list.
7. One `--full` at the MVP HEAD.
   - *Verify:* a status for all 159 within 25 min of run start, queue time separate (spec AC 1).
     Record it in the spec.
8. Docs: `CLAUDE.md` (replace the "Host/PTY/IPC-boundary items use `npm run test:smoke`…" bullet and
   the "A loaded machine…" advice with local single / `e2e:remote`), `test/e2e/README.md`,
   `docs/specs/INDEX.md`.

## v1

### File map
| File | New/changed | Purpose |
|---|---|---|
| `.github/workflows/e2e.yml` | changed | `schedule` (nightly `--full` on `main`; ref sweep as backstop); `workflow_call` (inputs `selection`, `shards`); `state` job |
| `test/e2e/ci-state.mjs` | new | update `timings.json` (rolling median of the last 7 nightlies), `flaky-history.json` (14-day prune), `last-nightly.json` |
| `test/e2e/coverage-capture.mjs` | new | own module: host `NODE_V8_COVERAGE`, renderer `page.coverage`, only when `E2E_COVERAGE_DIR` is set (nightly); hooked from `launchElectron`/`finishScenario` |
| `test/e2e/ci-coverage-map.mjs` | new | coverage → sources via `out/*.js.map` → `coverage-map.json` |
| `esbuild.mjs` | changed | `--metafile <path>`: merged metafile of the main/preload/webview bundles |
| `test/e2e/ci-affected.mjs` | new | `selectAffected` (below) |
| `test/e2e/core-smoke.json` | new | core set (below) |
| `test/e2e/quarantine.json` | new | `{ "scenarios": { "<name>": { "reason": string, "since": "YYYY-MM-DD" } } }` |
| `test/e2e/run-smoke.mjs` | changed | `--quarantine`: a quarantined FAIL becomes `QUARANTINED-FAIL` |
| `test/e2e/ci-merge-results.mjs` | changed | quarantine status; `alsoFailingOnNightly`; `quarantineCandidates` (FLAKY ≥3 in 14 d) |
| `tools/e2e-remote-lib.mjs` / `.mjs` | changed | `--affected` (default); irrelevant-set short-circuit client-side; `selKey = 'a-' + base7` |
| `.github/workflows/release.yml` | changed | `e2e: uses: ./.github/workflows/e2e.yml with: { selection: full }`; `build-and-publish.needs: [gate, e2e]`; add `actions: read` |
| `tools/verify-quick.mjs`, `package.json` | new/changed | `verify:quick` |
| `test/e2e/harness.mjs` | changed | `phase(label)` timing log; the launch phase is logged automatically |
| split scenarios | new/changed | split-editor, file-integrity, new-session-folders, tree-chevrons, attention-signal, middle-click-surfaces → files of ≤120 s, assertions moved verbatim |

### Core smoke set (`test/e2e/core-smoke.json`)
`["session-bootstrap", "cwd", "quit-guard", "auto-save-basics"]`: local medians 5.3 + 16.7 + 17.8 +
65.3 s ≈ 114 s with settles, headroom for a 1.5× remote factor inside 3 min. One per spec §14 check:
launch (`session-bootstrap`), session + shell echo (`cwd`, real PowerShell PTY, 23/24 PASS), edit +
save (`auto-save-basics`, the cheapest scenario that saves), quit guard (`quit-guard`). `paste` and
`terminal-drop` were rejected: 50% FAIL in the evidence.

### Interfaces
- **`selectAffected(changed: { path: string; status: 'A'|'M'|'D'|'R' }[], ctx: { map: CoverageMap; importers: Record<string, string[]>; all: string[]; core: string[] }): { kind: 'none'|'full'|'names'; names: string[]; reasons: string[] }`**,
  rules in order (spec §B2):
  1. `changed` = `git diff --name-status <base>...HEAD`, `base` = merge-base with `origin/main`
     (the client computes it and passes the `base` input; prepare checks out with `fetch-depth: 0`).
  2. Drop `E2E_IRRELEVANT`: `test/unit/**`, `docs/**`, `**/*.md`, `designs/**`, `.conduit/**`,
     `.github/**` except `.github/workflows/e2e.yml` (`.autoloop` is never tracked). Nothing left →
     `none`.
  3. Any of `test/e2e/**`, `electron/main.ts`, `electron/preload.ts`, `esbuild.mjs`, `package.json`,
     `package-lock.json`, `.github/workflows/e2e.yml` → `full`.
  4. Per remaining file: mapped → its scenarios. **New (`A`) and unmapped** → walk `importers`
     upward (BFS) to the nearest mapped files and take their scenarios; none found → `full`.
     Modified but unmapped → `full`. Deleted → its mapped scenarios, else nothing (its importers are
     in the diff too).
  5. Union plus `core-smoke.json`.

  The client applies rule 2 only. `prepare` applies all of them: for `affected` it runs
  `npm ci --ignore-scripts` and `node esbuild.mjs --metafile meta.json`, inverts
  `inputs[*].imports` into `importers`, and reads the latest `e2e-state`. No state → `full`.
- **Nightly state.** A separate **`state`** job (`needs: [shard]`,
  `if: always() && github.event_name == 'schedule'`) downloads the previous state, runs `ci-state`
  over the shard JSON (PASS timings only) and coverage outputs, and uploads `e2e-state` (30 d)
  **regardless of the test verdict**. The report job still exits 1 on a red run, for the
  `workflow_call` gate.
  - Lookup (prepare and state): `gh api "repos/$GITHUB_REPOSITORY/actions/artifacts?name=e2e-state&per_page=10"`
    → the newest non-expired by `created_at` → `archive_download_url`. Never by run conclusion.
- **`coverage-map.json`:** `{ "builtFrom": sha, "scenarios": { "<name>": ["webview/foo.tsx", …] } }`.
  Fallback if sourcemap mapping fails (spec §12): metafile inputs per entry, coarser.
- **`verify:quick`:** changed files = diff vs merge-base plus untracked;
  `biome check --no-errors-on-unmatched <files>`; both
  `tsc -p … --noEmit --incremental --tsBuildInfoFile node_modules/.cache/<cfg>.tsbuildinfo`;
  `vitest run --changed <merge-base>`. Inner loop only; `verify` is unchanged.

### Steps (each verified by targeted vitest and then a remote dispatch)
1. `ci-affected` and `ci-state`, with unit tests: rule order; irrelevant-only → none;
   `.github/workflows/e2e.yml` → full; a new file imported by a mapped file → that file's
   scenarios; a new file with no mapped importer → full; modified unmapped → full; 14-day prune;
   candidates ≥3.
2. Nightly, `state` job and the sweep. Needs MVP's `e2e.yml` on `origin/main` (`schedule` runs the
   default branch).
   - *Verify:* a `selection=full` dispatch on `main` with a forced failure still uploads
     `e2e-state`; the next run's lookup finds it; the sweep deletes a hand-pushed `ci/e2e/*` ref
     older than 24 h.
3. `coverage-capture.mjs` + coverage map on the nightly.
   - *Verify:* the map covers ≥95% of the `webview/**`/`src/**`/`electron/**` files touched by the
     last 20 commits; otherwise switch to the metafile fallback.
4. `--affected` end to end.
   - *Verify:* a docs+unit-test-only commit → exit 0 "no e2e needed", nothing pushed; a one-file
     webview change → mapped + core; a new webview file → its importers' scenarios + core; a
     `test/e2e` change → full.
5. Quarantine and candidates.
   - *Verify:* unit tests, plus one scratch-ref run with a quarantined forced failure → run passed,
     `QUARANTINED-FAIL` listed.
6. Scenario splits, one per commit.
   - *Verify:* `e2e:remote -- <new names>` shows each ≤120 s remotely and the same `assert(` count
     before and after.
7. Release gating, **only after step 5 is on `main`** (a quarantined known failure must not block a
   release).
   - *Verify:* a `workflow_call` dry run through a throwaway workflow on a `ci/e2e` ref (its
     `cleanup` job must skip: `github.ref` is the caller's). Don't tag.
8. `verify:quick`.
   - *Verify:* run it on a two-file change; measure against the 114 s `verify` once the interim
     rule lifts; confirm TS 7.0.2 accepts `--incremental` with `--noEmit`, else drop the flag and
     note it.

## Slice X — out-of-repo edits (B5, B7)

Not committed anywhere; the user reviews the diffs. Paths:

**`C:\Users\karam\.claude\skills\autonomous-build-loop\` (B5).** A *general* skill, so the text is
project-neutral ("the project's remote e2e command if it has one"):
- **`SKILL.md` §"Route each item by tier":** spec Tier S → `LITE`, M/L → `FULL`. LITE: no design
  review, **one** review round, runtime QA only for user-visible behaviour, impact-selected e2e
  (`--affected`) where supported.
- **`SKILL.md` phase table rows 4–5 and "What you do between phases":** Review and Runtime QA are
  **dispatched together on the same build SHA**; both must pass before Phase 6.
- **`SKILL.md` (new rule under the gates):** e2e evidence is keyed by SHA — a later gate at the same
  SHA cites the result JSON and does not re-run; a fix cycle re-runs the failed scenarios plus the
  affected set, **remotely** when available; never hand a subagent a local full-suite loop.
- **`references/parallel-and-detach.md` (executor brief checklist):** the worktree junction rule
  (`rmdir` the `node_modules` junction before `git worktree remove`; memory
  `worktree-junction-hazard.md`).
- **`references/composition.md`:** Phase 3/4/5 handoffs gain `E2E_RESULT: <path to e2e-<runId>.json> @ <sha>`.

**`G:\awby\projects\conduit\.autoloop\heavy-lock.mjs` (B7; untracked):**
- On acquire, append JSONL to `.autoloop/heavy-lock.log`:
  `{ ts, event: 'acquire', pid, cwd, cmd, waitedMs }`; on release `{ ts, event: 'release', pid, heldMs, exit }`.
- Replace the file lock and its 45-min mtime reclaim with the e2e lock's mechanism: a named pipe
  (`\\.\pipe\conduit-heavy-lock`) whose owner serves `{ pid, cwd, cmd }` and which the OS releases
  on death.
- While waiting, print `[heavy-lock] waiting for <owner>` once, then every 60 s.
- *Verify:* two `node heavy-lock.mjs . node -e "setTimeout(()=>{},5000)"` in parallel → the second
  logs `waitedMs ≈ 5000`; killing the first frees the second at once.

**Memory (optional; the user decides):** update `feedback-test-cadence-relevant-only.md` and
`feedback-e2e-serial-cpu.md` to point at `e2e:remote`.

## Risks and measurements that would change the plan

| # | Risk | Measurement (slice) | If it goes wrong |
|---|---|---|---|
| R1 | Hidden (`show:false`) windows don't paint, so screenshots come out blank | Slice 0 probe | CI launches shown. This needs a `CONDUIT_E2E_SHOW=1` read in `main.ts:963`, a host change, so it goes to the user |
| R2 | Stopping the trace at every CI teardown is slow or large (snapshots on 170 s scenarios) | Slice 0 probe: stop time and zip size | Use `snapshots:false`, keep screenshots, or start tracing only on attempt 2 |
| R3 | Remote factor is above 2× or concurrency is below 16, which blows the 25 min | Slice 0 | Raise the shard cap, and do B3 splits before MVP rather than in v1 |
| R4 | With no workflow concurrency group, full runs from nightly, release and racing clients can overlap and share the ~20-job pool | MVP step 7 queue time; nightly queue time in v1 | Overlap only queues jobs, it never cancels. If it bites, move the nightly to a quiet hour. A concurrency group is not the fix: GitHub keeps one pending run per group and cancels the older one |
| R5 | `attention` needs a focusable window; `cwd` needs PowerShell; clipboard scenarios on a service desktop | Slice 0 remote-only list | Record them in spec §4. Don't quarantine inside Slice 0 |
| R6 | BelowNormal is not inherited, or Chromium re-raises it | MVP step 3 process check | A per-PID pass over `app.process().pid`'s tree after launch |
| R7 | Playwright version drift, local (npx cache has 1.60–1.63) vs CI (pinned 1.63) | first MVP remote failure that won't reproduce locally | Make `loadPlaywright` prefer the pinned version. Out of scope unless it bites |
| R8 | `workflow_dispatch` input validation uses the default branch's file rather than the ref's | Slice 0 step 1 vs 6 | Keep the stub's and the real file's inputs identical |
| R9 | V8 → sourcemap mapping is lossy for the renderer bundle | v1 step 3 coverage check | Metafile fallback (spec §12) |
| R10 | Seed medians are skewed by duplicated evidence files and n=1 entries (`peek-tree-layout`, `terminal-exit-focus`) | the first nightly replaces them | none needed; the seed is only a fallback |
| R11 | The watchdog's capture runs past the 8 s budget, so the runner's 210 s kill wins and only the log survives | MVP step 5 forced hang | Lower `E2E_DEADLINE_MS`, or drop snapshots on the watchdog path |
