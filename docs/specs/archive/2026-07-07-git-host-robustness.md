---
status: shipped
date: 2026-07-07
tier: FULL
---

# Git host resource discipline — robustness Phase 1

> **Shipped** 2026-07-09 (7 tasks, verify green). Run report:
> `docs/runs/2026-07-09-git-host-robustness/report.md`.

Phase 1 of a robustness effort making the file explorer, multi-repo exploration, and git
review/changes/diff surfaces never hang and stay responsive. This spec is **Phase 1 only** — the git
*host* layer. Phases 2 and 3 (below) get their own specs.

## Problem

An audit of the git surfaces (2026-07-07) found the hang/perf risks are rooted in **missing resource
discipline in the host**, not in the UI:

- **Five separate git runners with inconsistent bounds.** `src/git-info.ts` (1.5 s timeout),
  `src/git-history.ts` (4 s), and `src/git-actions.ts`, `src/project-info.ts`, plus the
  `electron/main.ts` helpers (`git()`, `gitShowBuffer`, `ignoredEntries`/check-ignore,
  `gitBatchCheck`/cat-file, `refExists`) with **no timeout at all**. **None** wire an `AbortSignal`,
  so nothing is cancelled when the user navigates away. A `git index.lock` or a stalled network FS on
  an unbounded runner means **no reply is ever sent** and the surface spins forever.
- **`gitChanges` (the Review "Changes" load) reads every untracked/added file fully and
  *synchronously* via `fs.readFileSync`, with no size cap** (`src/project-info.ts`), on the host
  event loop — and re-runs on every file-watcher change. One big untracked file (a log, a build
  artifact, a DB dump) **freezes the whole host**. This is the single worst offender.
- **Per-file diffs are unbounded** — `readDiff` reads the whole file with no cap and calls `gitShow`
  through the no-timeout `git()`. A timed-out/failed head fetch silently returns `''`, so the file
  renders as a bogus 100 % add (wrong, not just slow).
- **Commit-diff and compare-refs loop `git show` sequentially over an uncapped file set.** A large
  commit/comparison is thousands of serial spawns; the per-spawn timeout gives no *total* budget, so
  wall time is unbounded and the whole (multi-hundred-MB) result ships in one IPC message.

The stress lane already measured the felt cost of the explorer's uncapped `readDir` (~32 s block at
10k files); the git paths above are the same disease on the git side.

## Goals

1. **No git spawn can hang forever** — every git invocation is bounded (timeout + `maxBuffer`) and
   cancellable (`AbortSignal`).
2. **No git surface freezes the host** — the Changes load and per-file reads are asynchronous and
   size-capped; a big file or changeset can never block the event loop or OOM a payload.
3. **Unbounded work degrades to a typed outcome** — timeout / truncation / oversize / count-cap are
   first-class results the renderer can show, never a silently-wrong `''`.

## Non-goals (later phases — see Decomposition)

- Client-side loading / error / retry UI, request-epoch cancellation *wiring*, and virtualizing the
  commit-detail file list → **Phase 2**.
- Explorer + multi-repo performance (async/memoized `detectRepos`, the O(N) row-rebuild memo, the
  `readDir` entry pipeline, symlink-cycle guards, watcher→rescan decoupling) → **Phase 3**.

Phase 1 deliberately builds the *capability* (bounded, cancellable, typed) that Phases 2–3 consume;
it does not itself add new client UI beyond the oversize placeholder.

## Design

### 1. `src/git-exec.ts` — one bounded, cancellable runner

A single module every git call routes through. Pure-ish wrapper over `child_process.execFile`:

```ts
interface GitResult {
  stdout: string;         // '' on failure/timeout — but the flags say why
  stdoutBuffer?: Buffer;  // when a caller needs raw bytes (blob reads)
  code: number | null;    // git exit code (null if killed)
  timedOut: boolean;      // killed by our timeout
  aborted: boolean;       // killed by the caller's AbortSignal
  truncated: boolean;     // hit maxBuffer
}
function runGit(args: string[], opts: {
  cwd: string; timeoutMs?: number; maxBuffer?: number; signal?: AbortSignal;
}): Promise<GitResult>;
```

- **Kills the child on timeout *or* abort** (execFile's `timeout` for the former; a `signal`
  listener that `child.kill()`s for the latter), and always resolves a `GitResult` — it never
  rejects unexpectedly, so callers branch on flags instead of try/catch.
- **Default timeout tiers** (overridable per call): metadata (status / refs / rev-parse) ~2 s,
  diff / show / blame ~10 s, history ~5 s. Buffers keep each caller's current cap.
- **All five runners migrate onto it** — single source of truth for bounds + cancellation. Each
  caller's *observable* behavior is unchanged except that it now yields a typed outcome under stress
  instead of hanging or silently emptying. Security discipline (arg arrays, `--`, containment) is
  preserved exactly — this is a resource change, not a surface change.

### 2. Payload caps

Reuse `file-service`'s `MAX_BYTES` (2 MB) as the shared per-file text cap.

- **Per-file text cap** on the diff / changes / blame read paths: a file over the cap returns a typed
  `{ oversize: true, bytes }` marker rather than reading and shipping the whole file.
- **`gitChanges` stops using `readFileSync`** — asynchronous, capped reads (bounded concurrency).
  A big untracked file becomes an oversize marker, **not** a host freeze. Removes the #1 offender.
- **Multi-file diff loops** (commit-diff, compare-refs): a **file-count cap** (default 1000) plus a
  **wall-clock budget**; the per-file `git show`s run with **bounded concurrency** instead of fully
  serial. Beyond the cap/budget the result carries a `truncated: { shown, total }` flag → the
  renderer says "Showing N of M files."

### 3. Oversize UX

An oversized diff renders a **placeholder with an escape hatch** — "This file is too large to diff"
+ an **Open file** action (opens the existing capped 2 MB viewer). Honest and never misleading;
consistent with the plain viewer's existing "Large file — showing the first 2 MB" banner. (This is
the one small piece of new client UI in Phase 1; the richer loading/error/retry states are Phase 2.)

### 4. Error handling

Timeout / truncation / oversize / count-cap are **typed outcomes** carried on the DTOs. A normal
nonzero git exit stays a handled empty result (as today). The runner never throws for
"git failed" — callers read `GitResult` flags.

## Verification

- **Unit tests** for `git-exec`: timeout kills the child and flags `timedOut`; an aborted signal
  kills it and flags `aborted`; a `maxBuffer` overflow flags `truncated`; a nonzero exit surfaces
  `code` without throwing. Cap logic: oversize marker at the boundary; multi-file count-cap +
  `truncated` shape. Existing `git-history` / `project-info` tests updated for the new runner.
- **Stress lane** (extends `test/e2e/stress/`, advisory timings + gating invariants):
  - `git-changes-huge` — repo with a large untracked file → Review Changes loads with the host
    **responsive** (block bounded) and the file **marked oversize** (invariant), not a freeze.
  - `git-commit-huge` — a commit touching thousands of files → result returns **within budget**,
    **file-count-capped** (invariant), no forever-spinner.
  - `git-diff-huge` — a 100k-line single file → diff opens **capped**, host responsive.
  - `git-wedged` — a stub `git` on PATH that sleeps → the runner **times out** and the surface
    degrades to a typed error (invariant: bounded, no forever-hang), proving timeout + cancellation.
- `npm run verify` green; the stress lane is not in the gate (as established).

## Decisions

- **Consolidate all five runners** onto `git-exec` (single source of truth) — chosen over hardening
  each in place, per the "root-cause first" direction. Risk (a broad diff) is mitigated by keeping
  observable behavior identical and leaning on the existing git tests + new runner tests.
- **Oversize → placeholder + escape hatch**, not a truncated diff (a truncated diff can misrepresent
  later changes as absent).
- **Typed outcomes, never silent `''`** — the current silent-empty behavior is itself a bug (renders
  a timed-out diff as a 100 % add).

## Decomposition (the full arc)

- **Phase 1 (this spec):** the git host layer is bounded, cancellable, and capped; the Changes
  `readFileSync` freeze is gone.
- **Phase 2 — client-side graceful states:** apply `src/with-timeout.ts` to git IPC; consistent
  loading / empty / error / retry across the commit loader, per-card diff, and blame; **request
  epochs** that cancel + discard stale results when switching commit / ref / repo (wiring the
  `AbortSignal` Phase 1 exposes); virtualize the commit-detail file list.
- **Phase 3 — explorer + multi-repo performance:** async/memoized `detectRepos`; the `readDir` entry
  pipeline + the O(N) per-render row-list rebuild memo; symlink-cycle guards in the tree + watcher;
  decouple/coalesce the watcher→rescan→full-tree-reread fan-out.
