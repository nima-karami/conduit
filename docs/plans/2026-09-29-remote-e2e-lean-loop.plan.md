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
| `test/e2e/ci-merge-results.mjs` | new | merge shard results → result JSON; INFRA fill; run status |
| `test/e2e/smoke-select.mjs` | new | runner arg resolution, local refusal, spawn→status classification |
| `test/e2e/local-guard.mjs` | new | machine-wide lock + BelowNormal priority (local only) |
| `test/e2e/failure-artifacts.mjs` | new | CI tracing/screenshot staging and promote-on-failure |
| `test/e2e/harness.mjs` | changed | `launchElectron` choke point; `launchApp` + `closeApp` use it |
| 13 bypassing `*.e2e.mjs` | changed | `_electron.launch(` → `launchElectron(`, one line each; assertions untouched |
| `test/e2e/run-smoke.mjs` | changed | exact names only, local refusal, escape hatch, retry→FLAKY, JSON, logs, header comment fixed |
| `test/e2e/timings.seed.json` | from spike | `scale` = measured |
| `test/e2e/core-smoke.json` | new | core set (below); read by v1 `--affected` |
| `.github/workflows/e2e.yml` | changed | MVP jobs, concurrency, artifacts, result JSON |
| `tools/e2e-remote.mjs` | new | `npm run e2e:remote` CLI (thin `gh`/`git` I/O) |
| `tools/e2e-remote-lib.mjs` | new | pure: args, run-name, dedup match, printing, exit code |
| `package.json` | changed | `"e2e": "node test/e2e/run-smoke.mjs"`, `"e2e:remote": "node tools/e2e-remote.mjs"`; `test:smoke` kept as an alias of `e2e` |
| `test/unit/e2e-{merge-results,smoke-select,local-guard,remote,launch-choke}.test.ts` | new | see steps |
| `CLAUDE.md`, `test/e2e/README.md`, `docs/specs/INDEX.md` | changed | e2e rules → local single / remote; spec status |

### Core smoke set (`test/e2e/core-smoke.json`)
`["session-bootstrap", "cwd", "quit-guard", "auto-save-basics"]`

These are local medians of 5.3 + 16.7 + 17.8 + 65.3 s, which is 105 s, or about 114 s with settles.
That leaves headroom for a 1.5× remote factor inside 3 min. Each one covers one of the spec's four
checks:

| Check (spec §14) | Scenario | What it does |
|---|---|---|
| launch | `session-bootstrap` | cold launch → state without prodding |
| session + shell echo | `cwd` | real PowerShell PTY, `cd` echo; 23/24 PASS in evidence |
| edit + save | `auto-save-basics` | types into the editor, `paletteSaveAll`, reads disk; the cheapest scenario that saves |
| quit guard | `quit-guard` | the quit guard itself |

`paste` and `terminal-drop` were rejected: they are 50% FAIL in the evidence.

### Interfaces
- **`launchElectron(launchOpts): Promise<ElectronApplication>`** (harness): the **only** caller of
  `_electron.launch`. It does three things:
  1. When not on CI (`process.env.GITHUB_ACTIONS !== 'true'`), it awaits `acquireE2eLock()`, then
     `setBelowNormal()`.
  2. It launches.
  3. On CI, it calls `startCapture(app)`.

  `launchApp` (`harness.mjs:131-137`) calls it. `loadPlaywright` stays exported for other uses.
- **`local-guard.mjs`:**
  - `acquireE2eLock({ lockPath = join(tmpdir(), 'conduit-e2e.lock'), scenario, isAlive = pidAlive, pollMs = 1000, log = console.log }): Promise<void>`.
    - Creates the lock with `openSync(lockPath, 'wx')`. The body is
      `{ pid, scenario, cwd, startedAt }`.
    - On `EEXIST` it reads the owner. A dead owner is reclaimed: `process.kill(pid, 0)`, where
      ESRCH means dead and EPERM means alive. An unparsable lock is reclaimed. A lock older than
      60 min is also reclaimed.
    - Otherwise it logs `[e2e-lock] waiting for pid <p> (<scenario>, <cwd>)` once, then every 30 s.
    - **Re-entrant per process** (durability, scrollback and text-fit relaunch).
    - Release is a sync `process.on('exit')` unlink, only when the file's pid is ours.
  - `setBelowNormal(): void`: `os.setPriority(0, PRIORITY_BELOW_NORMAL)` on the **scenario's own
    node process**, before the first launch. On Windows, children of a BelowNormal parent inherit
    BelowNormal, so Electron, GPU, renderers and PTY shells all get it without a per-PID sweep.
    - It is skipped when `CONDUIT_E2E_PRIORITY=normal`.
    - MVP measures whether Chromium re-raises renderer or GPU priority, and falls back to a per-PID
      pass over `app.process().pid`'s tree if it does.
- **`failure-artifacts.mjs`** (CI only, when `E2E_ARTIFACT_DIR` is set). The design works around the
  fact that an exit handler can't do async work, and that the bypassing scenarios close their app in
  `catch` *before* exiting. So capture happens **at app teardown**, and promotion happens **at exit**:
  - `startCapture(app)`: `app.context().tracing.start({ screenshots: true, snapshots: true })`.
    It wraps `app.close` and registers `app` so `closeApp`/`shutdownApp` can call `captureNow`.
  - `captureNow(app): Promise<void>`:
    - screenshots every `app.windows()` page to
      `<stage>/win-<i>.png`, where `<stage> = $RUNNER_TEMP/e2e-stage/<pid>/`;
    - `tracing.stop({ path: <stage>/trace-<k>.zip })`;
    - it's idempotent per app.
  - It is called from `closeApp` (`harness.mjs:338`, first line), `shutdownApp` (`:99`, before the
    graceful race), and the wrapped `app.close`.
  - A `process.on('exit', code)` handler registered in `launchElectron` works synchronously:
    - on `code !== 0` it `renameSync`s the stage to `$E2E_ARTIFACT_DIR/<basename(argv[1], '.e2e.mjs')>/`;
    - otherwise it `rmSync`s the stage.

  One consequence: the screenshot is taken at teardown, a few ms after the throw in every catch path,
  and not at the throw itself.
- **`run-smoke.mjs` CLI:** `node test/e2e/run-smoke.mjs <name…> [--names-file f.json] [--json out.json] [--artifacts dir] [--retry]`.
  - Names are exact stems. The substring path is **removed**.
  - When not on CI:
    - with more than one name, or none, it **refuses** with exit 2 and prints
      `npm run e2e:remote -- <names>|--full`;
    - with `CONDUIT_E2E_LOCAL_FULL=1` it prints a banner and appends a line to
      `%TEMP%\conduit-e2e-escape.log`;
    - on any non-PASS it prints the loaded-machine reminder (spec §4).
  - Status classification (`smoke-select.mjs classify`):
    - `0` → PASS (SKIP if the output matches `\bSKIP\b`);
    - `ETIMEDOUT` or a signal → TIMEOUT;
    - any other code (1, 2, n) → **FAIL**, with `exit n` shown on the line.
  - `--retry`: after a non-PASS/SKIP result it runs the orphan sweep (already there, :126), waits
    `SETTLE_MS`, and runs a new child. If that passes, the result is **FLAKY** with `attempts: 2`.
  - `--artifacts dir` sets `E2E_ARTIFACT_DIR` for the children, and the runner writes
    `dir/<name>/log.txt` (stdout+stderr of every attempt) for any non-PASS, including TIMEOUT.
    TIMEOUT has no exit handler, so it only gets the log.
  - Runner exit codes: `0` all PASS/SKIP/FLAKY; `1` a test failure; `2` usage or refusal.
- **Result JSON** is exactly as in spec §3. `shard` is a number. `artifact` is a URL. The run-level
  `status` and `url` are added alongside `results`.
- **`mergeResults(plan, shardFiles: {shard, results}[], meta: {sha, nonce, selection, runId, queuedAt, startedAt, finishedAt, artifactUrls: Record<number,string>}): ResultJson`**:
  - a planned name with no result becomes `INFRA`;
  - `runStatus(results)` applies these in order:
    1. empty → `passed`;
    2. any INFRA → `infra-error`;
    3. any FAIL or TIMEOUT → `failed`;
    4. all SKIP → `failed`;
    5. any FLAKY → `flaky-passed`;
    6. otherwise `passed`.
- **`e2e.yml` (MVP):**
  - `concurrency: { group: ${{ inputs.selection == 'full' && 'e2e-full' || format('e2e-{0}', github.run_id) }}, cancel-in-progress: false }`.
  - `permissions: { contents: read, actions: read }`.
  - prepare outputs `matrix` and `plan` (JSON). A shard count of 0 means auto, from the seed
    × `scale`.
  - The shard step: `run-smoke --names-file shard.json --json … --artifacts artifacts --retry`.
  - It uploads `e2e-results-N` (always) and `e2e-fail-N` (`if-no-files-found: ignore`,
    `retention-days: 7`).
  - The report step:
    - reads the artifact ids through `gh api …/runs/$RUN/artifacts` to build per-shard URLs;
    - reads run timestamps from `gh api …/runs/$RUN`;
    - runs `mergeResults`;
    - writes the summary table with artifact links;
    - uploads `e2e-result` (`result.json`, 14 days);
    - **exits 1 unless the status is passed or flaky-passed**, which v1's `workflow_call` needs.
- **`tools/e2e-remote.mjs`:** `npm run e2e:remote -- (--full | <name…>) [--shards N] [--no-wait] [--retry-infra <run-id>] [--out <dir>] [--timeout <min=60>]`.
  1. **Preconditions** (exit 2):
     - `gh auth status` succeeds;
     - `git status --porcelain` is empty, otherwise list the files;
     - every name exists as `test/e2e/<name>.e2e.mjs`;
     - no selection → error "pass --full or names (--affected lands in v1)".
  2. **Key.** `sha = git rev-parse HEAD`; `selKey = 'full' | 'n-' + sha256(sorted names).slice(0,8)`;
     `nonce = <selKey>.<8 hex>`, so the run title carries the dedup key.
  3. **Dedup.**
     - `gh run list -w e2e.yml --json databaseId,displayTitle,status,headSha,url -L 50`, filtered to
       status ∈ {queued, in_progress, waiting, pending, requested}.
     - A run with the same `headSha` and the same `selKey` prefix in its title → **attach** (no push).
     - For `--full` with a different sha in flight or pending, print the queue position. If a run
       is already **pending** in `e2e-full`, **wait client-side** until it starts before
       dispatching (see risk R4).
  4. **Push.** `git push origin HEAD:refs/heads/ci/e2e/<sha7>-<rand>`. This publishes any unpushed
     ancestors; that is accepted per spec §14 Q1.
  5. **Dispatch.** `gh workflow run e2e.yml --ref <ref> -f selection=… -f scenarios=… -f shards=… -f nonce=<nonce>`.
  6. **Locate.** Poll `gh run list -w e2e.yml -b <ref>` every 3 s, for up to 90 s, for a title that
     contains the nonce, then print the URL. Not found → infra, exit 2.
  7. **Wait.** Poll `gh run view <id> --json status,conclusion,jobs` every 20 s and print a state
     change, or a heartbeat every 60 s. The states are:
     - `queued` / `preparing` / `running k/N` (completed shard jobs) / `reporting`.
     - Hitting `--timeout` gives `timed-out`, exit 2; the run is left alone.
     - `--no-wait` prints the URL and exits 0 without deleting the ref; the nightly sweep takes it
       (v1).
  8. **Result.**
     - `gh run download <id> -n e2e-result -D <tmp>`, then print the lines
       `  name ... ✓ PASS (12.3s) [s3]` plus a summary and artifact links.
     - Write `<out>/e2e-<runId>.json`, where `<out>` is `--out`, else `$E2E_EVIDENCE_DIR`, else
       `%TEMP%\conduit-e2e\`. Keying by run id makes the write idempotent.
     - A cancelled run → `cancelled`. A missing `e2e-result` → `infra-error`.
  9. **Cleanup.** In a `finally`, but only after the run is terminal, or after a timeout:
     `git push origin --delete <ref>`, only for a ref this invocation created. On SIGINT it prints
     the URL and leaves the ref, because deleting it under a queued run would break its checkout.
  10. **Exit.** 0 for passed / flaky-passed; 1 for failed; 2 for anything else.
  11. **`--retry-infra <id>`.** Download that run's `result.json`, take the `INFRA` names and its
      `sha`, then push `<sha>:refs/heads/ci/e2e/…` (the sha must exist locally) and continue from
      step 5 with a `names` selection.

  Pure pieces in `e2e-remote-lib.mjs`: `parseArgs`, `selectionKey`, `makeNonce`, `matchInFlight`,
  `runState(runView)`, `formatResults`, `exitCodeFor(status)`.

### Steps
1. Pure modules and tests: `ci-merge-results`, `smoke-select`, `e2e-remote-lib`.
   - *Verify:*
     `npx vitest run test/unit/e2e-merge-results.test.ts test/unit/e2e-smoke-select.test.ts test/unit/e2e-remote.test.ts`.
   - Cases include:
     - a missing name becomes INFRA;
     - all-SKIP is failed;
     - FLAKY-only is flaky-passed;
     - INFRA takes precedence over FAIL;
     - exit 2 is FAIL;
     - a local call with 2 names refuses;
     - the escape hatch;
     - a dedup match on the same sha and a different nonce;
     - no match on a different sha;
     - the state mapping from a canned `gh run view` JSON.
2. Add `local-guard.mjs` and its test, using a temp `lockPath` and an injected `isAlive`.
   - *Verify:* `npx vitest run test/unit/e2e-local-guard.test.ts`. Cases:
     - acquire/release;
     - a waiter blocks until release;
     - a dead pid is reclaimed at once;
     - re-entrant within the same process;
     - a garbage file is reclaimed.
3. Harness:
   - add `launchElectron` and `failure-artifacts.mjs`;
   - rewire `launchApp`;
   - add a `captureNow` call at `closeApp:338` and `shutdownApp:99`;
   - migrate the 13 files;
   - add a guard test: `test/unit/e2e-launch-choke.test.ts` reads `test/e2e/**/*.mjs` and fails on
     `_electron.launch` or `electron.launch(` anywhere outside `harness.mjs`, following the
     `drag-region.test.ts` pattern.
   - *Verify:*
     - the unit guard;
     - `npx biome check test/e2e`;
     - `npx tsc -p tsconfig.json --noEmit` is **not** required (these are `.mjs` files);
     - **one** local scenario through heavy-lock:
       `npm run e2e -- durability`, which is a migrated relaunch scenario;
     - the lock, checked by running `npm run e2e -- session-bootstrap` from a second shell. The
       second shell prints "waiting for …" and launches after the first finishes (spec Gherkin 2);
     - while the first run is going,
       `Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | % { (Get-Process -Id $_.ProcessId).PriorityClass }`
       shows BelowNormal for all of them.
4. `run-smoke.mjs` changes, and fix the header comment (`:1-19`: the ~4 min claim, substring
   filter).
   - *Verify:*
     - `npm run e2e` with no args refuses (exit 2, no app launched);
     - `npm run e2e -- a b` refuses;
     - `npm run e2e -- nope` exits 1;
     - one real scenario passes.
5. `e2e.yml` MVP on a `ci/e2e/*` ref.
   - *Verify, remote only:*
     - `node tools/e2e-remote.mjs <the core set>` first. This uses the step-6 CLI, so build them
       together and sanity-check with `--no-wait` first.
     - A deliberate-failure check: on a **scratch branch never merged**, commit a one-line
       `assert(false)` into `session-bootstrap`, then run `e2e:remote -- session-bootstrap`. Expect:
       - exit 1;
       - `e2e-fail-N` holds `session-bootstrap/{log.txt, win-0.png, trace-0.zip}`;
       - the summary links it;
       - with `--retry`, attempts = 2.
     - A flake check: same scratch approach, but fail only when `E2E_ATTEMPT=1`. The runner exports
       the attempt number, and a FLAKY result is expected.
6. `tools/e2e-remote.mjs`.
   - *Verify:*
     - two shells run `e2e:remote -- cwd` at the same sha → the second prints "attaching to run …"
       and pushes no ref;
     - after both finish, `git ls-remote origin 'refs/heads/ci/e2e/*'` is empty;
     - a dirty tree → exit 2 with the file list;
     - `gh auth logout` isn't tested; `exitCodeFor` is unit-covered instead.
7. One `--full` at the MVP HEAD.
   - *Verify:* a status for all 159 within 25 min of the run starting; queue time reported
     separately (spec AC 1). Record it in the spec.
8. Docs:
   - `CLAUDE.md`: replace the "Host/PTY/IPC-boundary items use `npm run test:smoke`… full suite is
     the pre-integration regression check" bullet, and the "A loaded machine…" advice, with local
     single / `e2e:remote`.
   - `test/e2e/README.md`.
   - `docs/specs/INDEX.md`.

## v1

### File map
| File | New/changed | Purpose |
|---|---|---|
| `.github/workflows/e2e.yml` | changed | `schedule` (nightly `--full` on `main`, plus the ref sweep job); `workflow_call` (inputs `selection`, `shards`); `e2e-state` download/upload |
| `test/e2e/ci-state.mjs` | new | update `timings.json` (rolling median of the last 7 nightlies), `flaky-history.json` (14-day prune), `last-nightly.json` |
| `test/e2e/ci-coverage-map.mjs` | new | V8 coverage (host `NODE_V8_COVERAGE`, renderer `page.coverage`) → sources via `out/*.js.map` → `coverage-map.json` |
| `test/e2e/ci-affected.mjs` | new | `selectAffected(changed, map, all, core) → { kind: 'none'|'full'|'names', names }` |
| `test/e2e/failure-artifacts.mjs` | changed | coverage capture when `E2E_COVERAGE_DIR` is set (nightly only) |
| `test/e2e/quarantine.json` | new | `{ "scenarios": { "<name>": { "reason": string, "since": "YYYY-MM-DD" } } }` |
| `test/e2e/run-smoke.mjs` | changed | `--quarantine`: a quarantined FAIL becomes `QUARANTINED-FAIL` |
| `test/e2e/ci-merge-results.mjs` | changed | quarantine status; `alsoFailingOnNightly`; `quarantineCandidates` (FLAKY ≥3 in 14 d) |
| `tools/e2e-remote-lib.mjs` / `.mjs` | changed | `--affected` (default); docs-only short-circuit done client-side; `selKey = 'a-' + base7` |
| `.github/workflows/release.yml` | changed | `e2e: uses: ./.github/workflows/e2e.yml with: { selection: full }`; `build-and-publish.needs: [gate, e2e]`; add `actions: read` |
| `tools/verify-quick.mjs`, `package.json` | new/changed | `verify:quick` |
| `test/e2e/harness.mjs` | changed | `phase(label)` timing log; the launch phase is logged automatically |
| split scenarios | new/changed | split-editor, file-integrity, new-session-folders, tree-chevrons, attention-signal, middle-click-surfaces → files of ≤120 s, assertions moved verbatim |

### Interfaces
- **`selectAffected`**, rules in order (spec §B2):
  1. The diff is `git diff --name-only <merge-base main>...HEAD`.
  2. If every file is `docs/**` or `*.md` → `none`.
  3. Any of `test/e2e/**`, `electron/main.ts`, `electron/preload.ts`, `esbuild.mjs`, `package.json`,
     `package-lock.json`, or a file absent from the map → `full`.
  4. Otherwise, the union of the mapped scenarios plus `core-smoke.json`.

  The client applies only rule 2, because it has no map. `prepare` applies them all, using the latest
  successful scheduled run's `e2e-state`, found via
  `gh run list -w e2e.yml -e schedule -s success -L 1`. With no state it selects `full`.
- **`coverage-map.json`:** `{ "builtFrom": sha, "scenarios": { "<name>": ["webview/foo.tsx", …] } }`.
  - Fallback if sourcemap mapping fails (spec §12): esbuild `metafile` inputs per entry, which is
    coarser.
- **`verify:quick`:**
  - changed files are the diff vs merge-base plus untracked files;
  - `biome check --no-errors-on-unmatched <files>`;
  - both `tsc -p … --noEmit --incremental --tsBuildInfoFile node_modules/.cache/<cfg>.tsbuildinfo`;
  - `vitest run --changed <merge-base>`;
  - documented as inner loop only. `verify` is unchanged.

### Steps (each verified by targeted vitest and then a remote dispatch)
1. `ci-affected` and `ci-state`, with unit tests (rule order; docs-only; unmapped → full; 14-day
   prune; candidates ≥3).
2. Nightly and the sweep.
   - This needs MVP's `e2e.yml` on `origin/main`, because `schedule` runs the default branch.
   - *Verify:* `gh workflow run` with a `selection=full` dispatch on `main` plus a manual
     `sweep` job; `e2e-state` is uploaded. After the first real nightly, a second nightly reads it.
3. Coverage map on the nightly.
   - *Verify:* the map covers ≥95% of the `webview/**`/`src/**`/`electron/**` files touched by the
     last 20 commits. If it doesn't, switch to the metafile fallback.
4. `--affected` end to end.
   - *Verify:* a docs-only commit gives exit 0 "no e2e needed" and pushes nothing; a one-file
     webview change runs mapped + core; a `test/e2e` change runs full.
5. Quarantine and candidates.
   - *Verify:* unit tests, plus one scratch-ref run with a quarantined forced failure → run passed,
     `QUARANTINED-FAIL` listed.
6. Scenario splits, one per commit.
   - *Verify:* `e2e:remote -- <new names>` shows each ≤120 s remotely and the same assertion count,
     checked by grepping `assert(` counts before and after.
7. Release gating.
   - *Verify:* a `workflow_call` dry run through a throwaway workflow on a `ci/e2e` ref. Don't tag.
8. `verify:quick`.
   - *Verify:* run it on a two-file change.
   - Measure it against the 114 s `verify`, once the interim rule lifts.
   - Confirm TS 7.0.2 accepts `--incremental` with `--noEmit`; if it doesn't, drop that flag and
     note it.

## Slice X — out-of-repo edits (B5, B7)

Not committed anywhere; the user reviews the diffs. Paths:

**`C:\Users\karam\.claude\skills\autonomous-build-loop\` (B5).** This is a *general* skill, so the
text is project-neutral ("the project's remote e2e command if it has one"):
- **`SKILL.md` §"Route each item by tier":** map spec Tier S → `LITE`, and M/L → `FULL`.
  - LITE: no design review, **one** review round, runtime QA only for user-visible behaviour.
  - e2e: impact-selected (`--affected`) where the project supports it.
- **`SKILL.md` phase table rows 4–5 and "What you do between phases":** Review and Runtime QA are
  **dispatched together on the same build SHA**, and both must pass before Phase 6.
- **`SKILL.md` (new rule under the gates):**
  - e2e evidence is keyed by SHA. A later gate at the same SHA cites the result JSON and does not
    re-run.
  - A fix cycle re-runs the failed scenarios plus the affected set, **remotely** when available.
  - Never hand a subagent a local full-suite loop.
- **`references/parallel-and-detach.md` (executor brief checklist):** add the worktree junction rule
  (`rmdir` the `node_modules` junction before `git worktree remove`; memory
  `worktree-junction-hazard.md`).
- **`references/composition.md`:** Phase 3/4/5 handoffs gain `E2E_RESULT: <path to e2e-<runId>.json> @ <sha>`.

**`G:\awby\projects\conduit\.autoloop\heavy-lock.mjs` (B7; untracked):**
- On acquire, append JSONL to `.autoloop/heavy-lock.log`:
  `{ ts, event: 'acquire', pid, cwd, cmd, waitedMs, reclaimedStale }`.
- On release, append `{ ts, event: 'release', pid, heldMs, exit }`.
- While waiting, print `[heavy-lock] waiting for <owner.txt contents>` once, then every 60 s.
- Replace the 45-min mtime reclaim with an owner-pid-dead check, the same as the e2e lock, and keep
  mtime as a backstop.
- *Verify:* two `node heavy-lock.mjs . node -e "setTimeout(()=>{},5000)"` in parallel → the second
  logs `waitedMs ≈ 5000`.

**Memory (optional; the user decides):** update `feedback-test-cadence-relevant-only.md` and
`feedback-e2e-serial-cpu.md` to point at `e2e:remote`.

## Risks and measurements that would change the plan

| # | Risk | Measurement (slice) | If it goes wrong |
|---|---|---|---|
| R1 | Hidden (`show:false`) windows don't paint, so screenshots come out blank | Slice 0 probe | CI launches shown. This needs a `CONDUIT_E2E_SHOW=1` read in `main.ts:963`, a host change, so it goes to the user |
| R2 | Stopping the trace at every CI teardown is slow or large (snapshots on 170 s scenarios) | Slice 0 probe: stop time and zip size | Use `snapshots:false`, keep screenshots, or start tracing only on the retry attempt |
| R3 | Remote factor is above 2× or concurrency is below 16, which blows the 25 min | Slice 0 | Raise the shard cap, and do B3 splits before MVP rather than in v1 |
| R4 | GitHub keeps only **one pending** run per concurrency group; a newer pending run cancels the older one | known platform behaviour; confirm in MVP step 7 with 3 quick `--full` dispatches | The client-side wait in `e2e:remote` step 3. The nightly/release can still cancel a pending client run → reported `cancelled`, exit 2 |
| R5 | `attention` needs a focusable window; `cwd` needs PowerShell; clipboard scenarios on a service desktop | Slice 0 remote-only list | Record them in spec §4. Don't quarantine inside Slice 0 |
| R6 | BelowNormal is not inherited, or Chromium re-raises it | MVP step 3 process check | A per-PID pass over the tree after launch |
| R7 | Playwright version drift, local (npx cache has 1.60–1.63) vs CI (pinned 1.63) | first MVP remote failure that won't reproduce locally | Pin locally too, by making `loadPlaywright` prefer the pinned version. Out of scope unless it bites |
| R8 | `workflow_dispatch` input validation uses the default branch's file rather than the ref's | Slice 0 step 1 vs 6 | The stub already declares the final inputs; keep the stub and the real file's inputs identical |
| R9 | V8 → sourcemap mapping is lossy for the renderer bundle | v1 step 3 coverage check | Metafile fallback (spec §12) |
| R10 | Seed medians are skewed by duplicated evidence files and n=1 entries (`peek-tree-layout`, `terminal-exit-focus`) | the first nightly replaces them | none needed; the seed is only a fallback |
