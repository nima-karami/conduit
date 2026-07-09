# Run report — git host resource discipline (robustness Phase 1) — 2026-07-09

Implemented Phase 1 of the explorer/multi-repo/git-review robustness effort: the git **host layer**
can no longer hang forever or freeze the host on a big file/changeset. Brainstormed → specced
(`docs/specs/2026-07-07-git-host-robustness.md`) → planned
(`docs/plans/2026-07-07-git-host-robustness.plan.md`) → built inline, TDD, verify + commit per task.

## Why

A 2026-07-07 audit of the git surfaces found the hang/perf risks were rooted in missing **host
resource discipline**: five divergent git runners (most with no timeout, none cancellable); the
Review "Changes" load reading every untracked file *synchronously* (`readFileSync`, no cap); per-file
diffs and multi-file commit/range diffs unbounded (sequential `git show` over an uncapped file set).
A stalled git or one big file could pin a surface forever or freeze the whole app.

## What shipped (7 tasks, all committed to main, verify green)

| Task | Commit | What |
|---|---|---|
| T1 | `git-exec` | **One bounded + cancellable runner** — `runGit`/`runGitBin` wrap execFile with timeout tiers (`GIT_TIMEOUT` metadata 2s / diff 10s / history 5s), `maxBuffer`, and `AbortSignal`, returning a typed `GitResult` (never throws) + `mapWithConcurrency`. 11 unit tests using node as a deterministic fake binary. |
| T2 | migrate 5 runners | git-history, git-info (+switchBranch), git-actions (`gitExec`, intentionally un-timed — mutations run long hooks), project-info, and the 5 `main.ts` helpers all route through it. Added `stderr` to `GitResult` for action errors. 2204 unit tests stayed green. |
| T3 | readDiff cap | `FileDiffDTO.oversize`; `readDiff` stats first (never buffers a giant file) + guards the HEAD side. |
| T4 | gitChanges async | `countLinesOfFile` (streamed, byte-capped, NUL→binary, matches `countLines` exactly) replaces the `readFileSync` loop; bounded concurrency. **Kills the #1 Changes-load freeze.** |
| T5 | multi-file caps | `getCommitDiff`/`getRangeDiff` → `{ files, truncated? }`: file-count cap (1000) + bounded concurrency (8) + per-file 2 MB oversize via a shared `buildFileDiff`. Flows through the result DTOs + hooks. |
| T6 | oversize UI | `DiffViewer` oversize placeholder (+ optional Open file); review cards show a "too large to diff" note (existing Open-file button is the escape hatch); "Showing N of M files" truncation banner. |
| T7 | stress scenarios | Four real-app scenarios (below). Adds `launchApp({ env })` + `initGitRepo`/`gitCommitAll` helpers. |

**Decisions during build:** git *actions* (`gitExec`) route through the runner but stay **un-timed** —
a commit's pre-commit hook may run arbitrarily long, so bounding it would be a regression; the
forever-hang risk we fix is the READ surfaces. `MultiFileDiff` left un-exported (internal). The
`.cmd` shim approach for a fake hanging git was abandoned (Windows `execFile` skips `.cmd` and finds
real git); a copy of `node.exe` + `NODE_OPTIONS=--require` that hangs only on git-subcommand main
names is what reliably wedges git without breaking Electron's own `main.js`.

## Verified end-to-end (stress lane, `npm run test:stress`)

All four git scenarios PASS — the numbers below are the felt proof the fixes work:

| Scenario | Result | Proves |
|---|---|---|
| `git-changes-huge` | 3 MB untracked file: **block 619 ms, max stall 204 ms**, oversize shown | the `readFileSync` host-freeze is gone |
| `git-commit-huge` | 1500-file commit: **truncated 1000 of 1500**, returns in ~2.3 s | no minutes-long sequential-`git show` loop |
| `git-diff-huge` | >2 MB working file: **oversize, 0 bytes shipped, 179 ms** | no whole-file read/IPC |
| `git-wedged` | every git call HANGS → commitDiff **returns empty in ~1.2 s, app alive** | the timeout fires; **no forever-hang** |

Plus 11 `git-exec` unit tests (timeout/abort/truncated/stderr/notFound/stdin) and new caps/oversize
unit tests in `git-history`/`file-service`/`project-info`. `npm run verify` green (2200+ unit tests).

## Discovered — pre-existing, NOT caused by this work

`branch-switch.e2e.mjs` fails on this machine: a switch reports `ok=true` and checks out on disk,
but the session's `git.branch` broadcast stays on the old branch (the post-switch refresh doesn't
reflect it within the 5 s window). **Confirmed pre-existing** — it fails identically at the
pre-migration commit (`dadbaff`), and a direct unit diagnosis shows the migrated
`switchBranch` + `interrogateGit` correctly returns the new branch, so the fault is in the app's
post-switch refresh/HEAD-watch path (unchanged by Phase 1), or environmental (git version / a
concurrent session on this shared repo). Flagged for a separate investigation — it's a real
git-surface robustness bug but out of Phase 1's hang/perf scope and not introduced here. (The e2e
suite is not in `verify`/CI, so it went unnoticed.)

## Not in this phase (next specs)

- **Phase 2 — client-side graceful states:** `with-timeout` on git IPC; consistent loading/empty/
  error/retry (the commit loader has no error state today); request epochs that cancel + discard
  stale results on commit/ref/repo switch (wiring the `AbortSignal` this phase exposed); virtualize
  the commit-detail file list.
- **Phase 3 — explorer + multi-repo perf:** async/memoized `detectRepos`; the `readDir` entry
  pipeline + the O(N) per-render row-rebuild memo; symlink-cycle guards; watcher→rescan decoupling.

## Notes for next time

- Pre-commit lint-staged intermittently fails with a git-stash error under rapid commits (memory:
  known flake) — just retry the commit.
- A hidden e2e window throttles rAF; the stress probe's headline metric is main-thread **lag**
  (block/stall), not frame rate — the git scenarios assert `lag.maxMs` bounds, not FPS.
