# Plan: Multi-repo tracking that follows the work

Spec: [2026-10-16-multi-repo-tracking.md](../specs/2026-10-16-multi-repo-tracking.md) (FULL).

**Tier: FULL** — host engine plus renderer contract change (new seam, new IPC messages,
multi-module, parallel executors). Planned unattended: every would-be question is in
`## Decisions Needed` with the default taken.

## Goal

Make git work scale with **repos that changed**, not with repos in every visible session. A
host-wide tracker refreshes each dirty repo once, pushes snapshots to every session containing
it, and watches worktree git-dirs so ticket sessions see commits. Non-git roots get a
gitignore-aware union file index with a search scope chip. A stress lane measures before and
after.

## Architecture

The tracker is a **pure core with injected I/O** in `src/` (path→repo classification,
per-repo refresh scheduler, tracker state), plus one **electron shell**
(`electron/repo-tracker-host.ts`) that binds it to real git, `watchDirWhilePresent`, the
session manager, visibility and the windows. `electron/main.ts` only constructs the shell and
routes IPC to it.

Missed events are always recovered by one of three paths, so no repo can stay stale forever:
- **explicit loss signals:** a no-filename event, or a vanished, failed or recovered watch, on
  either watch kind;
- **liveness-based coverage:** a live watch, not a requested one;
- **a focus sweep:** never-interrogated repos, plus repos refreshed more than 30 s ago.
Both legacy git paths are deleted, and nothing is kept as a fallback:
- the Changes pull path: `refreshProject` → `buildRepoChanges`, plus the git leg of
  `getProjectInfo`;
- the branch-chip path: `createGitRefresher`, `syncHeadWatches` and `HEAD_WATCH_CAP`.

The renderer stops pulling changes and stores pushed snapshots for its visible sessions. It
adapts them into the existing `RepoChanges[]` currency, so most consumers keep their props.

No sketches were made. Every new seam copies a sibling shape that already exists:
- the scheduler follows `createRepoScanScheduler` (`src/repo-scan-scheduler.ts`);
- the tracker DI follows `createGitRefresher` (`src/repo-git-refresh.ts`);
- the host shell follows `SessionFolderRuntime` (`electron/session-folder-runtime.ts`).

## Data flow

```
 ProjectWatcher (armed folders, recursive)                     watchDirWhilePresent(<commonDir>, recursive)
   onPath(absKey)  per non-ignored named event                  [tracker-owned; ONLY for a commonDir under no live
   onLost(folders) no-filename event / watch gone / open failed  ProjectWatcher root; self-re-arms; filter = shouldIgnore-
   onLive(roots)   whenever the set of LIVE watch roots changes   WatchPath('.git/'+rel)]  onPath | null filename → lost
        │                                                         │
        ▼                                                         ▼
 RepoTracker.onWatchedPath(absKey) ─► RepoPathMap.classify → [{key, kind:'tree'|'meta'}]  (O(path depth); holds keys, never paths)
 RepoTracker.lostFolders(folders)  ─► every repo under them: tree+meta          onDirty(key|null) ─► RepoFileIndex invalidation
 RepoTracker.setLiveRoots(roots)   ─► coverage (uncovered→covered: tree) + open/close own commonDir watches
 RepoTracker.windowFocused()       ─► visible repos: never-interrogated → meta+tree; lastRefresh > 30 s → tree (low priority)
        ▼
 RefreshScheduler.mark(key, kind)  ── settle 300 ms, cooldown 800 ms from last start, trailing run guaranteed,
        │                             single-flight per key, host-wide cap 4, eligible(key) = some VISIBLE session contains key
        ▼  run(key, {meta, tree})
 RepoTracker job:  meta → interrogateGit(root, {skipDirty:true})  (gitDir/commonDir/branch → re-arm git-dir watch, refresh path map)
                   always → readRepoChanges(root, {lines: wantsLines(any session containing key)})   (ONE status per run)
        ▼  publish(TrackerUpdate{key, root, snapshot, git, sessions})
 RepoTrackerHost:  mgr.mergeRepoGit(patches)  ──► existing `state` broadcast (branch chip, Session.repoGit)
                   for each window w, each session s ∋ key with gitDemand.isVisibleInWindow(w,s):
                       w.send({type:'repoDelta', sessionId:s, full:false, repos:{[root]: snapshot}})
                   (cache keeps snapshots for ALL sessions; EVERY `visible` message → full repoDelta for EVERY id
                    from cache, no git — idempotent, so a reloaded renderer re-hydrates)
        ▼
 renderer app.tsx: snapshots[sessionId][root] ──repoChangesOf()──► RepoChanges[] ──► changesModel / Review / Explorer dots / hunk host
                   (delta handler reads visibleIdsRef/activeRef — the subscribe is registered once)
                   changes:subscribe {sessionIds} (Changes tab shown or Review open) ──► host wantsLines()
```

State ownership:
- **Host tracker:** repo registry (key → root, gitDir, commonDir, branch, sessions), snapshot
  cache, scheduler state and git-dir watches.
- **SessionManager:** `repoGit`, unchanged as a channel.
- **Renderer:** snapshots for the sessions visible in that window only.

## Settled decisions — do not re-litigate

- **Engine first.** The tracked set, its threshold/banner/Pause/Track/persistence, the union-rule
  "paused" UI and the hot/warm tiers are **parked** (spec §6). With no tracked set, **every repo
  in a session is tracked**. The union rule reduces to: a repo runs git iff some visible session
  contains it.
- `REPO_SCAN_CAP = 200` and `MAX_REPO_SCAN_DEPTH = 4` stay (`src/repo-scan.ts:21-22`).
- Per-repo cooldown is 800 ms (spec §13; was 1 s) with a guaranteed trailing refresh. The host-wide git cap is 4.
- `changesView` stays a pure view filter (spec §3).
- `fsmonitor`, autofetch, nested-in-repo detection and a custom watcher are out of scope.
- The watcher change reverses L12 S4 ("folders never paths") in bounded form. Events are mapped
  to repo keys on arrival and never stored as paths (spec §13, default taken).
- Search default in a non-git root is **Tracked repos** (= all repos, no tracked set).
  Worktrees inside another session's home show as normal repos (spec MVP).
- Host and renderer ship in one build. `project.repoChanges` → `repoDelta` needs no wire
  migration (spec §3).

## Spec staleness

| Spec claim | Measured | How the plan proceeds |
|---|---|---|
| §3 "`repoChanges` becomes incremental" — implies a `repoChanges` message | No such message. `repoChanges?: RepoChanges[]` is a field of the `project` **reply**. The renderer pulls it with `requestProject` after every `fsChanged` (`src/protocol.ts:404-411`, `webview/app.tsx:1909-1914`, `electron/main.ts:2522-2579`) | Pull becomes host push (`repoDelta`). `project` keeps only `files` and `customizations` |
| §2/§3 branch chip gets its own snapshot stream | GitInfo rides the `state` broadcast via `Session.repoGit` (`src/session-manager.ts:322`, `electron/main.ts:1428-1440`) | Tracker writes GitInfo through a new batched `mgr.mergeRepoGit`. No new message |
| §3 `changes` present only with demand. Consumers listed: changes-view, review-navigator, review-view, center-pane, right-pane, app | Missed consumers need **per-file kinds always**: Explorer row dots `buildRowChangeMap` (`webview/file-tree.ts:385-402`), the hunk-action host (`webview/app.tsx:2004-2047`), bulk/discard menus `changesOfRepo` (`webview/app.tsx:3216`) | The change **list** (status-derived path/kind/staged) is always present, at 1 git process. Only **line counts** are demand-gated. That is exactly what EARS AC 2 constrains ("shall not line-count") |
| §3 `RepoSnapshot = {tracking, tier, state, counts, changes?, refreshedAt}` | `tracking` and `tier` are parked. `counts` is derivable from the always-present list | Snapshot is `{changes, lines, refreshedAt, error?}` (Contracts) |
| §3 `changes:subscribe {sessionId, detail}` | The sibling `visible` message is window-set-replace (`src/protocol.ts:988`, `electron/main.ts:3560`). Per-session add/remove leaks a ref when a window closes mid-flight | `changes:subscribe {sessionIds}` replaces the window's set. `dropWindow` clears it. Two windows = two refs, as spec'd |
| §2 "host-wide RepoTracker keyed by repo realpath" | Scan emits `path.resolve(dir)`, not the realpath (`src/repo-scan.ts:68`). Every consumer keys by `folderKey(RepoInfo.root)` | Key = `folderKey(root)`. Realpath dedupe belongs to the parked persistence (its edge-case row is about choices). Recorded in Decisions |
| Invoker brief: `src/messages*.ts` | Does not exist. All messages are in `src/protocol.ts` (`HostToWebview` L388, `WebviewToHost` L810) | `src/protocol.ts` is the claimed protocol file |
| §2 "Each repo's per-worktree HEAD is watched (cap 16)" | True (`src/repo-git-refresh.ts:6`, `electron/main.ts:1371-1441`) | Deleted, replaced by one `watchDir` per common git dir |
| §2 split session may be unwatched | Code-read true: `SessionFolderRuntime.arm()` unions `projectsByWindow` only (`electron/session-folder-runtime.ts:119-127`) | `arm()` also unions the folders of visible sessions (Slice 2, T2.1) |
| Not in spec: `getProjectInfo` runs `gitChanges(changesRoot)` on every `requestProject`, **in addition** to `buildRepoChanges` (`src/project-info.ts:380-401`) | Measured by code-read | Its git leg is removed. The tracker is the only producer of change lists |

## Global constraints

- Gate is `npm run verify`, which is also the pre-commit hook. The inner loop is
  `npm run verify:quick`. To run one unit file: `npx vitest run test/unit/<name>.test.ts`.
- Never narrow, skip or disable a check.
- Comments explain **why** only, as a one-line pointer when the why lives in the spec, e.g.
  `// see docs/specs/2026-10-16-multi-repo-tracking.md §2`. No comment restates code.
- No band-aids: no `as any`, `@ts-ignore`, swallowed errors, `!important` or magic offsets.
- Git is spawned only through `runGit`/`runGitBin` (`src/git-exec.ts`).
- Directories are watched only through `watchDir` (`electron/watch-dir.ts`). Never watch a
  file with bare `fs.watch` (the old HEAD watch did).
- Paths in keys always go through `folderKey` (`src/folder-key.ts`). Ancestry uses
  `isAncestorOf` (`src/owning-session.ts:82`).
- Unit tests run on ubuntu CI. Use forward-slash fixture paths, no `process.platform`
  branches, and no drive-letter assumptions.
- Naming:
  - files are kebab-case and sit next to their siblings;
  - pure cores go in `src/`, electron shells in `electron/`;
  - functions are `camelCase`, factories are `createX`, constants are `SCREAMING_SNAKE`;
  - types and interfaces are `PascalCase`;
  - tests are `test/unit/<module>.test.ts`.
- User strings go in the component's local `STR` table. Counts use `countNoun`
  (`src/menu-selection.ts:27`).
- `confirm`, `alert` and `prompt` are lint-banned. Never name state after a DOM global
  (`name`, `status`, `open`, `event`).
- E2E:
  - a scenario is a `test/e2e/<name>.e2e.mjs` using `runScenario`, launched only via the
    harness and ending only via its `finishScenario`;
  - locally run one scenario by exact name: `npm run e2e -- <name>`;
  - run the gated suite remotely: `npm run e2e:remote` (any `electron/main.ts` edit triggers
    `--full`);
  - run e2e serially, never in parallel;
  - executors never run stress or e2e loops; the orchestrator runs them.
- The stress lane is `npm run test:stress -- multi-repo`: local, win32, sequential. Fixtures go
  in OS temp only.
- User-facing changes go in `CHANGELOG.md`. That edit is the final task.

## Out of scope

- Everything parked in spec §6: tracked set, threshold, banner, picker sheet, Pause/Track,
  `repo-tracking.json`, Settings → Git, hot/warm tiers and `repo:attention`.
- The §8 rows: paused, activity dot, scanning line, refreshing progress and missing.
- Vision items (ticket grouping, named repo sets).
- Repo-scan cost per burst (`SessionFolderRuntime.fired` → `scheduleRepoScan`). It is
  unchanged, and S0 records it in main-thread lag.
- Explorer `fsChanged` re-read. It is unchanged (spec §3 table).
- Persisting the search scope across restart (see Decisions).

## Contracts

### `src/git-exec.ts` (additive)

```ts
export type GitFailure = 'timeout' | 'not-found' | 'failed';
/** undefined when r.ok. */
export function gitFailureOf(r: GitResult): GitFailure | undefined;
// timedOut → 'timeout'; notFound → 'not-found'; any other !ok → 'failed'
```

### `src/project-info.ts`

```ts
export type RepoRead =
  | { ok: true; changes: ChangeDTO[]; trackedDirty: boolean }
  | { ok: false; reason: GitFailure };

/** One `status --porcelain -z --untracked-files=all`. With lines:false that is the ONLY git
 *  process; added/removed are 0. With lines:true, today's numstat / HEAD-deletion / untracked
 *  line-count blocks run as now. */
export async function readRepoChanges(cwd: string, opts: { lines: boolean }): Promise<RepoRead>;
```

- A **status** failure returns `{ok:false, reason: gitFailureOf(r)}`. Today it silently became
  `[]`.
- Numstat or line-count failures keep today's tolerant 0 counts.
- `trackedDirty` = some status entry whose XY is not `??`. It equals today's `GitInfo.dirty`,
  which is non-empty porcelain with `--untracked-files=no` (`src/git-info.ts:240-249`).
- `gitChanges(cwd)` is **deleted** in T2.6. In Slice 1 it delegates to
  `readRepoChanges(cwd,{lines:true})`, mapping `ok:false` to `[]` (today's behaviour), so the
  existing callers stay green.
- `getProjectInfo(cwd: string): Promise<{ files: FileNodeDTO[]; customizations: CustomizationCount[] }>`
  loses `changesRoot` and `changes` in T2.6.

### `src/git-info.ts` (additive)

```ts
export interface GitInterrogation {
  info: GitInfo;
  headPath?: string;
  /** Absolute, forward-slashed. Present when rev-parse answered. */
  gitDir?: string;
  commonDir?: string;
}
interface GitInfoOptions { timeoutMs?; gitBin?; log?; /** omit the dirty `status` call; info.dirty stays undefined */ skipDirty?: boolean }
```

`gitDir` and `commonDir` are already resolved at `src/git-info.ts:166-199`. They are now
returned, normalised with `/`.

### `src/repo-path-map.ts` (new, pure)

```ts
export type DirtyKind = 'tree' | 'meta';
export interface RepoPaths {
  key: string;          // folderKey(root)
  root: string;         // as in RepoInfo.root
  gitDir?: string;      // folderKey'd; undefined until first interrogation
  commonDir?: string;   // folderKey'd
  branch?: string;      // GitInfo.branch when kind==='branch'
}
export interface PathHit { key: string; kind: DirtyKind }
export class RepoPathMap {
  constructor(repos: readonly RepoPaths[]);
  /** absKey is folderKey'd. [] = loose path (under no repo, not git metadata). */
  classify(absKey: string): PathHit[];
  /** True when absKey is inside some repo's git dir (so a [] result is NOT a loose file). */
  isGitMetadata(absKey: string): boolean;
}
export const META_FILES: ReadonlySet<string>; // 'HEAD','MERGE_HEAD','CHERRY_PICK_HEAD','REVERT_HEAD','BISECT_LOG','ORIG_HEAD' + dirs 'rebase-merge','rebase-apply'
```

Rules, applied in this order:
1. `<gitDir>/index` → `{that repo, 'tree'}`. Agents' `git status`/`git add` rewrite the index
   constantly, and a list refresh is all an index change needs. `meta` would add about 3
   `rev-parse` runs per write.
2. A path under some repo's `gitDir` whose first segment ∈ `META_FILES` → `{that repo, 'meta'}`.
3. `<commonDir>/refs/heads/<b…>` → `'meta'` for every repo with that `commonDir` and
   `branch === b` (`b` may contain `/`).
4. `<commonDir>/packed-refs` → `'meta'` for every repo of that `commonDir`.
5. Any other path inside a git dir → `[]`, and `isGitMetadata` is true.
6. Otherwise, the longest repo root that `isAncestorOf` the path → `{key, 'tree'}`.
7. Otherwise `[]`. The path is loose.

`classify` assumes its input has already been filtered: callers drop object, log and `*.lock`
churn before calling it (see the host's filter).

Lookups walk the path's ancestors through a `Map` (O(depth)), never a scan over repos.

### `src/repo-refresh-scheduler.ts` (new, pure; injected clock)

```ts
export const REFRESH_SETTLE_MS = 300;
export const REFRESH_COOLDOWN_MS = 800;
export const REFRESH_CONCURRENCY = 4;
export interface PendingKinds { meta: boolean; tree: boolean }
export interface RefreshSchedulerDeps {
  run(key: string, kinds: PendingKinds): Promise<void>;
  /** Some visible session contains this repo (union rule). */
  eligible(key: string): boolean;
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}
export interface MarkOptions {
  /** Skip settle+cooldown (explicit action, line-demand upgrade, first fill). */
  immediate?: boolean;
  /** Lower runs first among ready jobs; default 0. First fill passes its rank. */
  priority?: number;
}
export interface RefreshScheduler {
  mark(key: string, kind: DirtyKind, opts?: MarkOptions): void;
  /** Eligibility may have changed; parked-dirty keys that are now eligible get armed. */
  reconsider(): void;
  forget(key: string): void;
  stop(): void;
}
export function createRefreshScheduler(deps: RefreshSchedulerDeps): RefreshScheduler;
```

Semantics, each pinned by a unit test:
- A mark ORs into pending kinds.
- With no timer and no run in flight, arm at `max(now+SETTLE, lastStart+COOLDOWN)` (0 if
  `immediate`).
- When the timer fires: if `!eligible(key)`, keep pending and **park** (no git). Otherwise
  enqueue.
- The queue drains up to `REFRESH_CONCURRENCY` at once, ordered by `(priority, enqueue order)`.
- At most one run per key in flight.
- A mark during a run sets pending. On completion the next run is armed at
  `max(now+SETTLE, lastStart+COOLDOWN)` (the trailing refresh).
- A `run` rejection is logged by the caller. The scheduler continues.
- `forget` drops pending and the timer. A late completion is ignored.

### `src/repo-tracker.ts` (new, pure core; all I/O injected)

```ts
export interface RepoSnapshot {
  changes: ChangeDTO[];      // status-derived, always present once read
  lines: boolean;            // added/removed populated
  refreshedAt: number;       // host Date.now() when the run's status completed
  error?: GitFailure;        // last run failed; `changes` are the last good ones
  /** Set only on snapshots sent from cache while the repo has pending (parked or queued) dirt:
   *  the renderer renders "as of <refreshedAt>" instead of presenting it as current (spec §3). */
  stale?: true;
}
export const FOCUS_STALE_MS = 30_000;
export const FOCUS_PRIORITY = 1000;   // behind first fill and live edits
export interface TrackerUpdate {
  key: string;
  root: string;
  sessions: readonly string[];       // every session containing the repo, visible or not
  snapshot?: RepoSnapshot;           // present when the run produced one
  git?: GitInfo;                     // present when info changed (meta run, or dirty flipped)
}
export interface RepoTrackerDeps {
  readChanges(root: string, opts: { lines: boolean }): Promise<RepoRead>;
  interrogate(root: string): Promise<GitInterrogation>;   // host passes {skipDirty:true}
  isSessionVisible(sessionId: string): boolean;
  wantsLines(sessionId: string): boolean;
  /** Watch a common git dir recursively; it self-re-arms (watchDirWhilePresent). onPath gets
   *  folderKey'd, already-filtered abs paths; onLost fires on any no-filename event (overflow, or
   *  recovery after a missing phase). */
  watchGitDir(commonDir: string, onPath: (absKey: string) => void, onLost: () => void): { close(): void };
  indexMtime(root: string): Promise<number>;              // first-fill rank; 0 on failure
  publish(update: TrackerUpdate): void;
  removed(key: string, root: string, sessions: readonly string[]): void;
  log(level: 'debug' | 'warn', msg: string, data?: Record<string, unknown>): void;
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}
export interface RepoTracker {
  setSessionRepos(sessionId: string, repos: readonly RepoInfo[]): void;
  dropSession(sessionId: string): void;
  onWatchedPath(absKey: string): void;
  /** A working-tree watch reported possible event loss for these folders. */
  lostFolders(folders: readonly string[]): void;
  /** Roots of the ProjectWatcher's LIVE recursive watches (not the requested set). */
  setLiveRoots(roots: readonly string[]): void;
  visibilityChanged(): void;
  linesDemandChanged(): void;
  /** Window focus: the recovery sweep for anything the watches missed (rules below). */
  windowFocused(): void;
  /** Explicit Retry (repo:refresh). Root must already be registered (else no-op). Marks meta+tree immediate. */
  refreshNow(root: string): void;
  snapshotsFor(sessionId: string): Record<string, RepoSnapshot>;   // keyed by RepoInfo.root; stale set per rule
  stop(): void;
}
export function createRepoTracker(deps: RepoTrackerDeps): RepoTracker;
```

Rules:
- **Registration.** `setSessionRepos` registers new keys. On first registration it marks
  `meta`+`tree` with `{immediate:true, priority}`. Priority rank: `home`/`attached` tag 0, then
  `nested` by descending `indexMtime`, then name. That is the progressive fill.
- **Removal.** A key no session contains any more is removed: forget it, close its common-dir
  watch when no other repo shares it, then call `removed`.
- **Coverage.** A repo is covered when some **live** root `isAncestorOf` its root.
  - An uncovered→covered transition marks it `tree`. Edits made while nothing watched it are
    caught up once, which keeps "only repos dirtied since" honest.
  - A covered→uncovered transition marks it `tree`+`meta`. The window in which nothing watched
    it may have lost events.
- **Loss.** `lostFolders(folders)` marks every registered repo whose root is under one of the
  folders, or whose `commonDir` is, with `tree`+`meta`. An own git-dir watch's `onLost` marks
  every repo of that `commonDir` with `tree`+`meta`. Loss is rare (overflow, vanished or failed
  watch), so one interrogation per affected repo is the price of never staying stale.
- **Own git-dir watches.** For each distinct known `commonDir` (ref-counted over registered
  repos), the tracker holds `watchGitDir(commonDir)` **only while no live root `isAncestorOf`
  the `commonDir`**. A covered common dir's events already arrive through the working-tree watch
  as `onWatchedPath`. This avoids up to 200 duplicate recursive handles when the parent is
  visible. `setLiveRoots` and every meta run reconcile the open set: open the newly uncovered
  ones, close the newly covered ones.
- **Meta run.** It interrogates, updates the repo's `gitDir`, `commonDir` and `branch`, rebuilds
  the `RepoPathMap`, and reconciles own watches. This is how a repo whose `commonDir` was unknown
  or has moved gets watched.
- **Focus (`windowFocused`).** For every repo contained by a visible session:
  - `commonDir` still unknown (never interrogated successfully) → `meta`+`tree`, immediate;
  - otherwise, `now − lastRefreshAt > FOCUS_STALE_MS` → `tree` with `{priority: FOCUS_PRIORITY}`.

  This is the backstop for an event lost without any loss signal. It replaces today's
  focus-driven `refreshAllGit` and the renderer's focus `refreshChanges(true)` git leg
  (`webview/app.tsx:1884-1897`).
- **Stale flag.** `snapshotsFor` sets `stale: true` on a repo with pending kinds, whether parked
  or queued. A `publish` from a completed run never carries it.
- **Dirty hook.** `onDirty(listener: (key: string | null) => void): () => void` is added in
  T3.1, with its first caller. It fires per `tree` hit and per loose path (`null`).
- **Every run.** `readChanges(root, {lines: some session containing key wantsLines})`.
  - Success → new snapshot. `git.dirty = trackedDirty`. Publish `git` only when the GitInfo
    fingerprint (`repoGitFingerprint`, `src/repo-git.ts`) changed.
  - Failure → keep the last snapshot with `error` set and `refreshedAt` unchanged. Publish it.
    There is no retry timer; the next fire retries (spec §3).
- **Line demand.** When it rises, mark `tree` `{immediate:true}` for each repo of a demanding
  session whose snapshot has `lines:false`.
- **Invariants.** At most one in-flight `readChanges` per key, enforced by the scheduler. No
  git for a key with no visible containing session. `counts`/`changes` come from one run by
  construction.

### `src/protocol.ts` (claimed)

```ts
// RepoChanges gains (renderer currency; built by repoChangesOf):
export interface RepoChanges { root; name; tag; sub?; changes: ChangeDTO[]; lines: boolean; refreshedAt: number; stale?: true; error?: GitFailure }

// HostToWebview
| { type: 'repoDelta'; sessionId: string; full: boolean;
    /** keyed by RepoInfo.root; full:true replaces the session's whole map */
    repos: Record<string, RepoSnapshot | { removed: true }> }
// `project` loses `changes` and `repoChanges` (T2.6).

// WebviewToHost
| { type: 'changes:subscribe'; sessionIds: string[] }   // this window's line-demand set, replaces
| { type: 'repo:refresh'; sessionId: string; root: string }   // explicit Retry; root validated ∈ session.repos
// `requestProject` loses `changesRoot` (T2.6).

// Slice 4 (T4.3)
export type IndexScope = 'tracked' | 'everything';
// `searchFiles` and `contentSearch` gain `scope?: IndexScope` (absent = 'tracked').
```

Trust boundary: `repo:refresh.root` and every `changes:subscribe` id are validated host-side.
- `repo:refresh.root` must satisfy
  `mgr.get(sessionId)?.repos?.some(r => folderKey(r.root) === folderKey(root))`, the same
  guard as `repo:pin` at `electron/main.ts:3510`.
- Unknown session ids are dropped.

### `electron/repo-tracker-host.ts` (new, electron shell)

```ts
export interface RepoTrackerHostDeps {
  mgr: Pick<SessionManager, 'get' | 'list' | 'mergeRepoGit'>;
  demand: Pick<SessionResourceDemand, 'isVisible' | 'isVisibleInWindow'>;  // the existing gitDemand
  windows: () => Iterable<{ id: number; send(msg: HostToWebview): void }>;
  log: Logger;
}
export interface RepoTrackerHost {
  readonly tracker: RepoTracker;
  /** ProjectWatcher sinks (wired as its onPath / onLost / onLive). */
  onWatchedPath(absKey: string): void;
  lostFolders(folders: readonly string[]): void;
  setLiveRoots(roots: readonly string[]): void;
  /** On EVERY `visible` message: full repoDelta from cache for EVERY id (idempotent; a reloaded
   *  renderer in the same window re-posts the same ids), then tracker.visibilityChanged(). */
  windowShown(windowId: number, ids: readonly string[]): void;
  setLinesDemand(windowId: number, sessionIds: readonly string[]): void;
  dropWindow(windowId: number): void;
  windowFocused(): void;
  refresh(sessionId: string, root: string): void;  // validated → tracker.refreshNow(root)
  stop(): void;
}
export function createRepoTrackerHost(deps: RepoTrackerHostDeps): RepoTrackerHost;
```

`SessionResourceDemand` is the return type of `createSessionResourceDemand`. Export it as
`export type SessionResourceDemand = ReturnType<typeof createSessionResourceDemand>` from
`src/session-resource-demand.ts` (T2.3).

Real deps:
- `readRepoChanges`;
- `interrogateGit(root, {skipDirty:true})`;
- `watchGitDir` is `watchDirWhilePresent(commonDir, {recursive:true, log}, (_e, f) => …)`
  (`electron/watch-dir.ts:91`). It polls and re-arms by itself, and emits a `null` filename
  after a missing phase.
  - `f === null` → `onLost()`.
  - Otherwise, drop the event when `shouldIgnoreWatchPath('.git/' + rel)` is true, where `rel`
    is `f` with `/` separators. The prefix is **required**: `src/watch-filter.ts` drops
    `objects/`, `logs/` and `*.lock` only when the path has a `.git` segment, and a path
    relative to the common dir has none.
  - Then `onPath(folderKey(commonDir + '/' + rel))`.
  - The working-tree watch needs no prefix, because its relative paths contain `.git`
    (`electron/project-watcher.ts` `onEvent`).
- `indexMtime` = stat `<root>/.git/index`, or for a `.git` file, read `gitdir:` and stat
  `<gitdir>/index`.

`publish` does two things:
1. It calls `mgr.mergeRepoGit` for `update.sessions`.
2. For each window and each `s ∈ update.sessions` where `demand.isVisibleInWindow(w.id, s)`,
   it sends `{type:'repoDelta', sessionId:s, full:false, repos:{[update.root]: snapshot}}`.

`mergeRepoGit` runs before the delta sends. The `state` broadcast can still land a coalescing
tick after the delta, so after a checkout the branch chip may lag the list by one
`postState`. That brief disagreement is accepted and documented, not fixed. GitInfo stays on
`state` because its consumers (branch chip, review groups, git history, background sessions'
cards) all read `Session.repoGit`. Folding it into `repoDelta` would give it a second channel
for one tick of consistency.

There is no `touch` after in-app git writes, and no scattered call sites. Every in-app write
(stage, commit, switch, hunk apply) changes `index`, `HEAD` or `refs`. A live working-tree
watch or an own git-dir watch sees that change, and the focus sweep is the backstop. Explicit
Retry is the only imperative refresh.

### `src/session-manager.ts` (additive)

```ts
/** One emit for the whole batch; skips unchanged entries (sameRepoGit per root). */
mergeRepoGit(patches: ReadonlyArray<{ sessionId: string; root: string; info: GitInfo }>): void;
```

### `electron/project-watcher.ts` / `electron/session-folder-runtime.ts`

```ts
// ProjectWatcher constructor opts gain:
onPath?: (absKey: string) => void;              // synchronously, per NON-ignored named event, after shouldIgnoreWatchPath; never buffered
onLost?: (folders: readonly string[]) => void;  // same three sites as onSuspect: no-filename event, watch gone/error, open() threw
onLive?: (roots: readonly string[]) => void;    // the keys of `this.watches` (successfully opened, not yet gone), after every change
// SessionFolderRuntimeDeps gain:
visibleSessionIds: () => readonly string[];
// SessionFolderRuntime gains:
visibilityChanged(): void;   // re-arm
```

`onLost` is a separate sink from `onSuspect`, because `onSuspect` drives folder health checks
(`SessionFolderRuntime.suspect`) and that meaning must not change. main.ts wires all three new
sinks in its `createWatcher` dep (`electron/main.ts:2230`).

`arm()` unions `watchFoldersFor(p, session)` over `projectsByWindow` (unchanged) **and**
`watchFoldersFor(s.home, s)` for each `visibleSessionIds()` session. That covers split panes.

### Renderer pure helpers (`src/changes-view-model.ts`)

```ts
export type SessionSnapshots = Readonly<Record<string, Readonly<Record<string, RepoSnapshot>>>>;
export function applyRepoDelta(prev: SessionSnapshots, msg: Extract<HostToWebview,{type:'repoDelta'}>,
                               visibleIds: readonly string[]): SessionSnapshots;   // drops sessions not in visibleIds
/** undefined while repos undefined (detecting); otherwise one entry per repo that has a snapshot (missing = loading). */
export function repoChangesOf(repos: readonly RepoInfo[] | undefined,
                              snaps: Readonly<Record<string, RepoSnapshot>> | undefined): RepoChanges[] | undefined;
// ChangesModel 'ready' gains: linesPending: boolean   (some loaded head has lines:false)
// RepoHeadModel gains: lines: boolean; refreshedAt?: number; stale?: true; error?: GitFailure
```

`acceptRepoChanges` is deleted. `createProjectReplyOrder` stays, because `project` replies still
order the file tree.

### Search (Slices 3–4)

```ts
// src/file-search.ts
export async function walkFilesAsync(root: string, cap = DEFAULT_CAP, prune?: (absDir: string) => boolean): Promise<SearchHit[]>;
// src/repo-file-index.ts (new, pure)
export const LOOSE_FILE_CAP = 20000;
export interface RepoFileIndexDeps {
  listRepo(root: string): Promise<string[]>;                  // gitListedFiles
  walkLoose(root: string, prune: (absDir: string) => boolean, cap: number): Promise<SearchHit[]>;
}
export interface RepoFileIndex {
  /** Union of each repo's listing (re-listed only after invalidateRepo) + loose files outside repos (re-walked only after invalidateLoose). */
  build(root: string, repos: readonly { key: string; root: string }[]): Promise<IndexedFile[]>;
  invalidateRepo(key: string): void;
  invalidateLoose(): void;    // every root's loose part
}
export function createRepoFileIndex(deps: RepoFileIndexDeps): RepoFileIndex;
// src/repo-tracker.ts additions (T3.1)
onDirty(listener: (key: string | null) => void): () => void;   // key = repo with a tree hit; null = loose path
reposUnder(rootKey: string): Array<{ key: string; root: string }>;
// main.ts wiring (T3.3): tracker.onDirty((k) => k === null ? repoFileIndex.invalidateLoose() : repoFileIndex.invalidateRepo(k))
// src/search-scope.ts (new, pure, renderer)
export type SearchScope = 'tracked' | 'repo' | 'everything';
export function scopeChipFolders(session: Pick<Session,'home'|'roots'|'repos'|'missingRoots'|'homeMissing'>): string[]; // present folders under no repo
export function searchTargets(folders: readonly string[], scope: SearchScope, activeRepoRoot: string | undefined,
                              chipFolders: readonly string[]): Array<{ root: string; scope: 'tracked' | 'everything' }>;
```

`searchTargets` rules:
- `'repo'` → `[{root: activeRepoRoot, scope:'tracked'}]`, or `[]` when there is none.
- `'everything'` → each folder, with `scope:'everything'` for chip folders and `'tracked'` for
  the rest.
- `'tracked'` → each folder with `'tracked'`.

## Producer/consumer map

| Behavior changed | Produced by | Consumed by | Sides touched |
|---|---|---|---|
| fs event → dirty repo | `ProjectWatcher.onPath` (`electron/project-watcher.ts`), tracker git-dir watches | `RepoTracker.onWatchedPath` → `RepoPathMap` | both |
| event loss / watch liveness | `ProjectWatcher.onLost`/`onLive` (same sites as `onSuspect`: `electron/project-watcher.ts` `onEvent` no-filename branch, `open` onGone/catch); `watchDirWhilePresent` null filename | `RepoTracker.lostFolders` / `setLiveRoots` | both. `onSuspect` → `SessionFolderRuntime.suspect` is left unchanged |
| focus recovery | `onWindowFocus` (`electron/main.ts:2277-2280`) | `RepoTracker.windowFocused` (replaces `refreshAllGit`) | both. The renderer's focus `refreshChanges(true)` (`webview/app.tsx:1884-1897`) still re-requests the file tree and has no git leg after T2.6 |
| `fsChanged` folders broadcast | `SessionFolderRuntime.fired` | Explorer, `rereadOpenDiffs`, TS index top-up (`webview/app.tsx:1909, 2244`) | producer unchanged; arming now includes visible sessions. Consumers are unaffected beyond the split pane gaining events it lacked |
| change lists | `RepoTracker` (sole producer; `buildRepoChanges` and `getProjectInfo` git leg deleted) | `repoDelta` → `applyRepoDelta` → `repoChangesOf` → `changesModel`, `reviewRepoChangesFor`, `buildRowChangeMap`, hunk host, `changesOfRepo`, review-navigator, review-view | both |
| line counts | `readRepoChanges({lines})` | changes-view rows + `HeaderSummary`, review-view stats | both |
| line demand | renderer `changes:subscribe` (`paneTab==='changes' && !explorerCollapsed` or `reviewDocOpen`) | `RepoTrackerHost.setLinesDemand` → `tracker.wantsLines` | both |
| GitInfo / branch chip | `RepoTracker` meta runs → `mgr.mergeRepoGit` (replaces `gitRefresher`) | `state` broadcast → `Session.repoGit` → branch-chip, review groups, git-history | producer only. Consumer reads the same `Session.repoGit` shape, so it is unaffected |
| visibility | renderer `visible` (unchanged) | `gitDemand` (unchanged) + `repoTrackerHost.windowShown` + `folders.visibilityChanged` | host consumer side only. The renderer message is unchanged |
| `project` reply | `sendProject` (`electron/main.ts:2543`) | `webview/app.tsx:648-656`, `projectData` (L1957) | both (fields removed) |
| `requestProject.changesRoot` | renderer (`webview/app.tsx:1721, 1758, 1828, 2194`) | host `refreshProject` | both (field removed) |
| in-app git writes | `git-action`, `git:switch` and hunk handlers in `electron/main.ts` | git-dir events (`index`/`HEAD`/`refs`) via the watches | neither side is edited. The old `scheduleGitRefresh` after `git:switch` (L3497) is deleted, and the watch covers it (`worktree-commit-seen` asserts the checkout case) |
| renderer reload | `render-process-gone` → `w.webContents.reload()` (`electron/main.ts:1088-1101`); the window keeps its id | `visible` re-post on mount → `windowShown` full deltas for every id | host side only. The renderer already re-posts `visible` from its `[activeId, splitId]` effect (`webview/app.tsx:1517-1520`) |
| non-git file index | `projectFileIndexMeta` (`electron/main.ts:479`) | `searchFiles` (quick-open), `contentSearch`, `queueProjectIndex` (TS) | both |
| fake shell | `webview/bridge.ts:902-928` | renderer without host | both (fake emits `repoDelta`) |
| e2e/stress readers of `project.repoChanges` | — | `test/e2e/**` | T2.8 greps `repoChanges\|type === 'project'` across `test/e2e` and updates every reader |

## File map

| Path | Action | Responsibility |
|---|---|---|
| `test/e2e/git-probe.mjs` | create | Test-only main-process `execFile` counter (precedent `test/e2e/nested-repo-resources.e2e.mjs:13-60`) |
| `test/e2e/stress/multi-repo-harness.mjs` | create | Topology fixture builder, scripted writers, renderer change observer |
| `test/e2e/stress/multi-repo-tickets.stress.mjs` | create | 20 repos + 4×4 worktrees, 4 writers, commit-seen check |
| `test/e2e/stress/multi-repo-cap.stress.mjs` | create | 200 repos at cap, 4 writers, first-fill time |
| `docs/runs/2026-10-16-multi-repo-tracking/report.md` | create | S0 baseline + S-final numbers |
| `src/git-exec.ts` | modify | `GitFailure`, `gitFailureOf` |
| `src/project-info.ts` | modify | `readRepoChanges`; later drop `gitChanges` and the git leg of `getProjectInfo` |
| `src/git-info.ts` | modify | Return `gitDir`/`commonDir`; `skipDirty` |
| `src/repo-path-map.ts` | create | Event path → repo key + dirty kind |
| `src/repo-refresh-scheduler.ts` | create | Settle/cooldown/trailing, single-flight, host cap, eligibility parking |
| `src/repo-tracker.ts` | create | Registry, coverage, first-fill rank, jobs, snapshot cache, git-dir watch ref-counts |
| `src/session-resource-demand.ts` | modify | Export `SessionResourceDemand` type |
| `src/session-manager.ts` | modify | `mergeRepoGit` |
| `electron/project-watcher.ts` | modify | `onPath` sink |
| `electron/session-folder-runtime.ts` | modify | Arm visible sessions; `visibilityChanged` |
| `electron/repo-tracker-host.ts` | create | Real deps, fan-out, line-demand sets, validation |
| `src/protocol.ts` | modify | `repoDelta`, `changes:subscribe`, `repo:refresh`, `RepoChanges.lines/error`; `project`/`requestProject` trims; `IndexScope` |
| `src/changes-view-model.ts` | modify | `applyRepoDelta`, `repoChangesOf`, `linesPending`; delete `acceptRepoChanges` |
| `webview/review-repos.ts` | modify | `reviewRepoChangesFor` drops the `project.changes` fallback |
| `webview/file-tree.ts` | modify | `buildRowChangeMap` input loses `changes`/`changesRoot` |
| `electron/main.ts` | modify | Construct tracker host; route IPC; delete gitRefresher/HEAD watches/git leg; composite index; scope |
| `src/repo-changes.ts` | delete | Superseded by tracker |
| `src/repo-git-refresh.ts` | delete | Superseded by tracker |
| `webview/app.tsx` | modify | Snapshot state, `changes:subscribe`, drop pull of changes, diff re-read on delta, scope state |
| `webview/bridge.ts` | modify | Fake `repoDelta` |
| `webview/components/changes-view.tsx` | modify | Line-count skeleton; inline error + Retry |
| `webview/components/review-view.tsx` | modify | Line-count skeleton where per-file `added/removed` render |
| `src/file-search.ts` | modify | `prune` on `walkFilesAsync` |
| `src/repo-file-index.ts` | create | Composite non-git index |
| `src/search-scope.ts` | create | Chip folder set + search targets |
| `webview/components/search-scope-chip.tsx` | create | Chip + radio menu (template `webview/components/review-repo-chip.tsx`) |
| `webview/components/search-pane.tsx` | modify | Render chip; post per-target `contentSearch` with `scope` |
| `webview/components/files-view.tsx` | modify | Thread scope props to `SearchPane` (L677) |
| `webview/components/right-pane.tsx` | modify | Thread scope props to `FilesView` |
| `test/unit/repo-path-map.test.ts` | create | |
| `test/unit/repo-refresh-scheduler.test.ts` | create | |
| `test/unit/repo-tracker.test.ts` | create | |
| `test/unit/repo-tracker-host.test.ts` | create | |
| `test/unit/repo-file-index.test.ts` | create | |
| `test/unit/search-scope.test.ts` | create | |
| `test/unit/project-info-untracked.test.ts` | modify | T1.1 new cases; T2.6 moves it to `readRepoChanges` |
| `test/unit/project-info-resources.test.ts`, `test/unit/git-porcelain-z.test.ts` | modify | Move to `readRepoChanges` (T2.6, when `gitChanges` dies) |
| `test/unit/session-manager.test.ts`, `test/unit/session-resource-demand.test.ts` | modify | `mergeRepoGit`, `visibleIds` cases |
| `test/unit/git-info.test.ts`, `project-watcher.test.ts`, `session-folder-runtime.test.ts`, `changes-view-model.test.ts`, `review-repos.test.ts`, `file-tree.test.ts`, `file-search.test.ts`, `git-exec.test.ts` | modify | New behaviour cases |
| `test/unit/repo-changes.test.ts`, `test/unit/repo-git-refresh.test.ts` | delete | Modules deleted |
| `test/e2e/repo-tracker-fanout.e2e.mjs` | create | One status per burst; background session renders from cache |
| `test/e2e/worktree-commit-seen.e2e.mjs` | create | Commit/checkout in a worktree whose main repo is outside home |
| `test/e2e/changes-line-demand.e2e.mjs` | create | No numstat while Changes hidden; lines arrive on show |
| `test/e2e/nonrepo-index.e2e.mjs` | create | Non-git root: quick-open/TS index honour `.gitignore`, no 20k walk |
| `test/e2e/search-scope.e2e.mjs` | create | AC fixture: `dist/` hit only under Everything |
| `CHANGELOG.md` | modify | User-facing entry (last) |

### File map amendments (as built)

Engine review round 1 (B3) found the map behind the code. Rows below record what Slices 2/2b and
the r1 fix actually touched beyond the table above. The spec edit bundled into `050156c0` stays
where it is; history is not rewritten.

**Slices 2 / 2b**

| Path | Action | Responsibility |
|---|---|---|
| `webview/styles.css` | modify | `.diffstat--pending` placeholder (incl. forced-colors), `.repo-head__error`, `.repo-head__asof` |
| `src/repo-git.ts` | modify | `repoGitFingerprint` also covers `unborn`, `isWorktree`, `worktreeName` |
| `webview/components/lines-pending.tsx` | create | Shared "Counting lines…" placeholder (2b) |
| `webview/components/review-navigator.tsx`, `webview/components/review-file-nav.tsx` | modify | Placeholder while a repo is `lines:false` (2b) |
| `test/e2e/stress/harness-stress.mjs`, `test/e2e/stress/run-stress.mjs` | modify | App closed before exit; ENOBUFS reported distinctly |
| `test/e2e/stress/multi-repo-harness.mjs` | modify | Observer reads `repoDelta` and merged per-repo state |
| `test/e2e/background-resources.e2e.mjs` | modify | Counts the tracker's git-dir watches |
| `test/e2e/changes-multi-repo.e2e.mjs`, `multi-folder-model.e2e.mjs`, `multi-repo.e2e.mjs`, `nested-repo-resources.e2e.mjs`, `repo-rescan.e2e.mjs`, `review-multi-repo.e2e.mjs`, `short-path-root.e2e.mjs` | modify | Read `repoDelta` instead of the `project` reply's change lists |
| `test/unit/repo-git.test.ts` | modify | Fingerprint widening |
| `test/unit/review-navigator-lines-pending.test.ts` | create | 2b placeholder |
| `test/unit/change-highlight.test.ts`, `change-row-drag.test.ts`, `changes-view-collapse.test.ts`, `tree-chevron.test.ts`, `right-pane-review-kebab.test.ts` | modify | Fixture-only: `RepoChanges` gained `lines`/`refreshedAt` |
| `webview/components/right-pane.tsx` | untouched | Planned for T2.7 to thread `onRetryRepo`, but `ChangesView` is rendered from `app.tsx` directly, so there was nothing to thread. Its Slice 4 row (scope props) stands |

**Engine review r1 fix**

| Path | Action | Responsibility |
|---|---|---|
| `src/git-info.ts` | modify | `GitInterrogation.failure` (git never answered vs "not a repo"); `headPath` removed (no consumer) |
| `src/repo-tracker.ts` | modify | Failed interrogation keeps last good dirs/branch/info/watch, owed meta retried on next mark; failed lines read re-marked once; `RepoSnapshot` moved out |
| `src/protocol.ts` | modify | Owns `RepoSnapshot`; `project` reply, `FileNodeDTO`, `CustomizationCount` and `requestProject.requestId` removed |
| `src/repo-path-map.ts` | modify | `<commonDir>/reftable/**` → meta for every repo of the common dir |
| `src/session-resource-demand.ts` | modify | `isShownInWindow`, `shownIn` (a minimized window's own set) |
| `electron/repo-tracker-host.ts` | modify | Deltas gated on the window's own set; `windowRestored` full re-send; ownership + payload shape checks |
| `electron/session-folder-runtime.ts` | modify | Arms every open session holding registered repos; `reposChanged` |
| `electron/project-watcher.ts` | modify | Marks lost only on the transition to lost |
| `electron/main.ts` | modify | `owns`, restore → `windowRestored`, `reposChanged` on repo set change / dispose; `requestProject` no longer replies |
| `src/project-info.ts` | modify | `getProjectInfo` / file tree / customization counts removed |
| `src/coalesced-refresh.ts`, `test/unit/coalesced-refresh.test.ts` | delete | Only served the `project` reply |
| `src/changes-view-model.ts` | modify | `createProjectReplyOrder` removed |
| `webview/app.tsx`, `webview/bridge.ts`, `webview/mock.ts`, `webview/view-model.ts` | modify | Reply ordering, fake `project` reply and its mock data/types removed |
| `test/e2e/repo-tracker-fanout.e2e.mjs` | modify | parent → ticket → parent: 0 catch-up status, no "as of", no own git-dir watch while hidden |
| `test/unit/repo-tracker.test.ts`, `repo-tracker-host.test.ts`, `repo-path-map.test.ts`, `project-watcher.test.ts`, `session-folder-runtime.test.ts`, `session-resource-demand.test.ts`, `git-info.test.ts`, `changes-view-model.test.ts`, `project-info-resources.test.ts` | modify | r1 cases; removed cases for deleted code |
| `CHANGELOG.md` | modify | Restore and switch-back fixes |

**Engine review r2 + runtime QA fix**

| Path | Action | Responsibility |
|---|---|---|
| `src/git-exec.ts` | modify | ENOENT with a missing cwd is `cwdMissing`, not `notFound` (the git-missing latch) |
| `src/git-info.ts` | modify | Missing cwd → not a repo (no failure); `--show-toplevel` / `--short` that never answered → failure |
| `electron/repo-tracker-host.ts` | modify | `ownedIds`; deltas also gated on `owns` |
| `electron/main.ts` | modify | `visible` ids filtered through `ownedIds` before `gitDemand` / `windowShown` |
| `electron/session-folder-runtime.ts` | modify | `foldersChanged` / health re-arm whenever the session holds repos |
| `electron/project-watcher.ts` | modify | `lostKeys` pruned when a root leaves the set |
| `src/branch-chip.ts`, `webview/components/branch-chip.tsx`, `webview/app.tsx` | modify | Worktree segment dropped when it equals the head name (`headName` prop) |
| `webview/components/changes-view.tsx` | modify | Stale row "Updating…" (+ "last read …" from 60 s), `renderChip(repo, headName)`, header total via `HeaderDiffstat` |
| `webview/components/lines-pending.tsx`, `webview/components/review-navigator.tsx` | modify | Header shows the placeholder alone while any repo in scope is counting |
| `webview/styles.css` | modify | Repo name keeps its width, chip shrinks first and clips; `.repo-head__asof` → `.repo-head__stale` |
| `src/protocol.ts` | modify | `stale` doc comment |
| `test/unit/git-exec.test.ts`, `git-info.test.ts`, `repo-tracker-host.test.ts`, `session-folder-runtime.test.ts`, `project-watcher.test.ts`, `branch-chip.test.ts`, `review-navigator-lines-pending.test.ts` | modify | r2 + QA cases |
| `test/unit/changes-header-stat.test.ts` | create | Header total and stale-row copy |
| `test/e2e/worktree-commit-seen.e2e.mjs` | modify | `git worktree remove` of a registered worktree, then the remaining one still updates |
| `test/e2e/repo-rescan.e2e.mjs` | modify | Rebased on a session with no registered repos; `requestId` dropped |
| `test/e2e/repo-tracker-fanout.e2e.mjs` | modify | Stale-row class rename |
| `test/e2e/git-indicator.e2e.mjs` | modify | AC11: no worktree segment beside a head of the same name; accessible name still says worktree |
| `CHANGELOG.md` | modify | Worktree-remove freeze, stale copy, name priority, partial total |

**Engine review r3 fix**

| Path | Action | Responsibility |
|---|---|---|
| `webview/components/repo-head.tsx` | modify | First row wrapped in `.repo-head__line` (never wraps); sub-path its own row |
| `webview/components/branch-chip.tsx` | modify | `ChipLabel`: zero-min-content label around an ellipsizing `.branch-chip__text` |
| `webview/styles.css` | modify | `.repo-head` column of two rows; chip floored at its glyphs (`min-width: min-content`); worktree segment keeps its glyph; tag container query and `.iconbtn` rule follow the line |
| `src/git-exec.ts` | modify | `gitFailureText` ("folder not found" / "git not found"); an empty cwd is never `cwdMissing` |
| `src/git-actions.ts`, `src/git-info.ts` | modify | Failure copy via `gitFailureText` |
| `src/changes-view-model.ts` | modify | Header pending only over repos with changes |
| `src/branch-chip.ts` | modify | Worktree segment vs head name compared case-blind |
| `test/e2e/repo-head-fit.e2e.mjs` | create | Long-name worktree head at 220 / 330 / 480 px: one line above the sub-path, labels go before the name, glyphs keep their room |
| `test/e2e/tree-chevrons-helpers.mjs` | modify | `chevronClear` also checks the line's children |
| `test/e2e/repo-rescan.e2e.mjs` | modify | No-repo premise asserted right before the refresh; open-scan wait dropped |
| `test/unit/git-exec.test.ts`, `git-actions-integration.test.ts`, `git-info.test.ts`, `changes-view-model.test.ts`, `branch-chip.test.ts`, `tree-chevron.test.ts` | modify | r3 cases; RepoHead's chevron now leads the line |
| `CHANGELOG.md` | modify | Name-priority line covers narrow panes and case; "folder not found" line |

**Engine review r4 fix**

| Path | Action | Responsibility |
|---|---|---|
| `webview/components/branch-chip.tsx` | modify | All chip text (op badge, separator, tag word) through `ChipLabel`; `.branch-chip__fit` (one-line box) holds the main row and the tag word; `.branch-chip__ref-label` names the branch/SHA label |
| `webview/styles.css` | modify | Text spacing as padding inside the text so the floor is glyphs + dot + caret; tag word wraps away first (clipped one-line box, not a container query); repo-head tag threshold 200 → 252px from measurement; no-op `min-width: 0` on `.repo-head__line` dropped |
| `src/git-actions.ts` | modify | `runHunkPlan` diff failure via `gitFailureText` |
| `test/unit/git-actions-integration.test.ts` | modify | Hunk op in a removed folder says "folder not found" |
| `test/e2e/repo-head-fit.e2e.mjs` | modify | Detached + REBASING long-name worktree at 220 / 330 (+400 / 460 / 560); head reaches its target ±2 px; no horizontal overflow; tag word first; floor = glyphs + dot + caret; tag pill never leaves the name under 80px |
| `test/e2e/branch-switch.e2e.mjs`, `test/e2e/git-indicator.e2e.mjs` | modify | Branch label read via `.branch-chip__ref-label` (no longer a direct child of the chip) |

**Engine review r5 fix**

| Path | Action | Responsibility |
|---|---|---|
| `webview/styles.css` | modify | `.branch-chip__shrink` clips (`overflow: clip`, min-content stays 0) so squeezed text padding never paints over a glyph; repo-head tag threshold 252px → `calc(220px + 3.4em)`, from the widest pill ("Attached", 52.4px at scale 1) with its text in container em so it tracks font scale |
| `test/e2e/repo-head-fit.e2e.mjs` | modify | Attached long-name worktree (colliding name, so the chip keeps its worktree segment) at 220 / 262–268 / 272 / 330; at the floor every `.branch-chip__text` lies inside its track or paints nothing |

**Slices 3 / 4**

| Path | Action | Responsibility |
|---|---|---|
| `src/repo-tracker.ts` | modify | `onDirty` also fires `null` on `lostFolders` and when a root turns live, and a key for each repo a live root newly covers (a dropped or unwatched event may have been a loose file's) |
| `src/repo-file-index.ts` | create | Also re-walks the loose part when the repo set under the root changes; an empty listing is never cached; a root that is itself a repo has no loose part |
| `electron/main.ts` | modify | `walkLoose: (root, prune, cap) => walkFilesAsync(root, cap, prune)` (the contract's two orders differ); `trackedReposUnder` module hook set by the app-ready closure, like `onWindowFocus` |
| `src/search-scope.ts` | create | `scopeChipFolders` is empty before the first scan and while the session has no repo at all (search stays as before) |
| `webview/components/search-pane.tsx` | modify | Exports `SearchScopeModel` (one prop threaded through right-pane → files-view); chip row shown while a query is typed in the Files tab; "This repo" with no active repo searches as All repos |
| `webview/styles.css` | modify | `.search__scope` row and `.search__scopechip` (shrinks and ellipsizes inside the pane) |
| `CHANGELOG.md` | modify | Search entry; the engine and line-count entries were already written in Slice 2 |

## Scripts

**None.** The only repeated routine is building git fixtures, and that is runtime test code
(`multi-repo-harness.mjs` `makeTicketTopology` / `makeRepoFarm`), not a build-time edit. No
edit shape repeats across more than a handful of files.

## Slices

### Slice 0: S0 stress baseline (test-only, on today's main)

**Check:**
- `npm run test:stress -- multi-repo` → both scenarios `PASS` on unmodified product code.
- `##PERF##` rows printed.
- `docs/runs/2026-10-16-multi-repo-tracking/report.md` holds the baseline table.

**Parallel groups:** Serial: T0.1 · G1: T0.2 · G2: T0.3 · Serial: T0.4
**Claims (serial lane):** none

#### Task 0.1: git probe + topology harness

**Files:**
- Create: `test/e2e/git-probe.mjs`
- Create: `test/e2e/stress/multi-repo-harness.mjs`

**Interfaces — Produces:**
```js
// test/e2e/git-probe.mjs
export async function installGitProbe(app): Promise<void>;
// patches child_process.execFile in main via app.evaluate + process.getBuiltinModule('child_process');
// records {at:number, cwd:string (forward-slashed, lowercased), sub:string (args[0]), args:string[] (first 4)} for file matching /(^|[\\/])git(\.exe)?$/i; ring-capped at 200000
export async function resetGitProbe(app): Promise<void>;
export async function readGitProbe(app): Promise<Array<{at:number; cwd:string; sub:string; args:string[]}>>;
export function statusCalls(calls): typeof calls;          // sub==='status' && args includes '--untracked-files=all'
export function numstatCalls(calls): typeof calls;         // sub==='diff' && args includes '--numstat'
// test/e2e/stress/multi-repo-harness.mjs
export function makeRepoFarm(root: string, { repos: number, filesPerRepo: number }): string[];             // repo dirs, committed
export function makeTicketTopology(root: string, { repos=20, filesPerRepo=1500, tickets=4, worktreesPerTicket=4 } = {}):
  { workspace: string; repos: string[]; tickets: Array<{ dir: string; worktrees: Array<{ dir: string; main: string; branch: string }> }> };
// worktrees via `git -C <main> worktree add -b t<k>-<repo> <ticketDir>/<repoName>`; uses initGitRepo/gitCommitAll from harness-stress.mjs
export function startWriters(dirs: string[], { intervalMs = 200, durationMs = 10000 } = {}):
  Promise<Array<{ dir: string; name: string; at: number }>>;   // each tick: new untracked `agent-<i>-<seq>.txt` + append to `seed-0.txt`
export async function installChangeObserver(page): Promise<void>;
// subscribes via window.agentDeck.subscribe; for every `project` (msg.repoChanges[].changes[].path) or
// `repoDelta` (msg.repos[*].changes[].path) message records first-seen Date.now() per basename matching /^agent-\d+-\d+\.txt$/
// into window.__firstSeen[sessionId][name]; also records repoDelta refreshedAt per name in window.__refreshedAt
export async function readFirstSeen(page): Promise<Record<string, Record<string, number>>>;
export async function readRefreshedAt(page): Promise<Record<string, Record<string, number>>>;   // window.__refreshedAt
export function lagStats(writes, seenBySession, sessionId): { n: number; seen: number; p50: number; p95: number; max: number };
/** Spec §7 lag: refreshedAt(first repoDelta naming the file) − write time. Empty before the engine. */
export function refreshLagStats(writes, refreshedBySession, sessionId): { n: number; p95: number; max: number };
/** os.cpus() busy fraction sampled over `ms` before launch; idle = busy < maxBusy. */
export async function machineIdle({ ms = 2000, maxBusy = 0.3 } = {}): Promise<{ idle: boolean; busy: number }>;
/** Opens `sessionId` in the split pane via its card context menu "Open in split pane"
 *  (webview/app.tsx:2760), the path background-resources.e2e.mjs already drives. */
export async function openSplit(page, sessionId): Promise<void>;
export async function waitForFirstFill(page, sessionId, repoCount, { timeout = 120000 } = {}): Promise<number>;  // ms until repoGit has repoCount keys
```

**Steps:**
- [ ] No red test, because these are test infrastructure. Proof: T0.2 consumes them.
- [ ] Probe reads the same as the precedent at `test/e2e/nested-repo-resources.e2e.mjs:13-60`.
      `node --check` both files.

#### Task 0.2: ticket-topology scenario

**Files:** Create: `test/e2e/stress/multi-repo-tickets.stress.mjs`

**Interfaces — Consumes:** everything T0.1 produces. From `harness-stress.mjs`: `runStress`,
`openSession`, `startPerf`, `stopPerf`, `emitReport`, `assertInvariant`, `waitForShellReady`.

**Steps:**
- [ ] Build `makeTicketTopology(mkdtemp)`. Open 4 ticket sessions
      (`openSession({path: ticket.dir})`), then the parent (`openSession({path: workspace})`)
      last, so the parent is active and the tickets are background.
- [ ] Before launch, record `machineIdle()` as `idle`. Then wait for the parent's repo set to
      load: `window.__sessions` has the parent with `repos.length === 36`. Then
      `waitForFirstFill(page, parent, 36)`, recorded as `firstFillMs`.
- [ ] `installGitProbe`, `installChangeObserver`, **then** `resetGitProbe` after the first fill,
      so fill traffic never counts against `statusOutsideWritten`. Then `startPerf('tickets')`.
- [ ] Phase A, parent alone on screen:
  - Run 5 writers for 10 s: one per ticket, each in that ticket's first worktree, **plus one in
    a parent-owned main repo** (`repos[5]`, not a ticket worktree). The fifth writer exercises
    the covered-common-dir path and the loss path.
  - Settle 5 s, then read the probe → `phaseA`.
- [ ] Phase B, two visible sessions:
  - `openSplit(page, ticket0)` puts ticket 0 in the split pane beside the parent.
  - `resetGitProbe`, then rerun the same 5 writers for 10 s and settle 5 s → `phaseB`.
  - Record `statusPerRepoA` and `statusPerRepoB`: the max over written repos of `status` calls
    per cwd.
- [ ] `stopPerf`.
- [ ] Record via `emitReport('multi-repo-tickets', perf, extra)`:
  - `idle`, `firstFillMs`, `gitTotal`, `statusTotal`;
  - `statusPerRepoA`/`B` (max and the distinct cwd count);
  - `statusOutsideWritten`: status cwds that are not a written repo;
  - `lagP50`/`lagP95`/`lagMax` (arrival) and `refreshLagP95` (spec §7 definition) for the
    parent; `seenRatio`;
  - `idleGitAfter`: git calls in the last 3 s of settle.
- [ ] Commit-seen phase:
  1. Make ticket 0's session active by clicking its card.
  2. Wait until its observer shows that ticket's agent files.
  3. Run `git -C <wt> add -A` + `git commit -m x` from the test process.
  4. Poll up to 5 s for the next message for ticket 0 whose change list lacks the committed
     names, then record `commitSeenMs` (or `null`).
  - Today this is **advisory**: `emitReport` extra `commitSeen`. Do not assert it.
- [ ] Gating invariants that hold today:
  - the app is alive (`waitForShellReady` on the parent after load);
  - `seenRatio > 0` (the parent saw at least one agent file);
  - `idleGitAfter` does not keep growing: a second 3 s window after settle has ≤ the first.
    This catches a runaway loop. If it fails on main, that is a finding: record it, and keep
    it as a FAIL-on-baseline row in the report rather than weakening it.

#### Task 0.3: 200-repo cap scenario

**Files:** Create: `test/e2e/stress/multi-repo-cap.stress.mjs`

**Steps:**
- [ ] `makeRepoFarm(workspace, {repos: 200, filesPerRepo: 50})` in a non-git workspace.
      Open one session there.
- [ ] Record `idle` via `machineIdle()` before launch, and `firstFillMs` via
      `waitForFirstFill(page, sid, 200)`.
- [ ] After the fill, `resetGitProbe`. Then probe and perf for 4 writers × 10 s in 4 repos.
      Record `statusTotal`, `statusOutsideWritten`, `lagP95`, `refreshLagP95` and
      `idleGitAfter`.
- [ ] Gating invariants: alive; the session's `repos.length === 200` (cap respected); the
      idle-growth check as in T0.2.

#### Task 0.4: baseline run + report (orchestrator)

**Files:** Create: `docs/runs/2026-10-16-multi-repo-tracking/report.md`

**Steps:**
- [ ] Run `npm run test:stress -- multi-repo` on an idle machine. CLAUDE.md: a loaded machine
      fails PTY tests the way a broken PTY does.
- [ ] Write the S0 table: metric × scenario, baseline column.
- [ ] Resolve the §2 ASSUMED rows: fire refreshes all repos (`statusOutsideWritten > 0`), the
      parent includes worktrees (`repos.length === 36`), and stale-ticket (`commitSeen`).
- [ ] If a §2 claim measures false, record it in the report and append a `Decisions Needed`
      item to this plan (spec §6: "re-spec that part").
- [ ] Do not commit the stress lane's `docs/runs/2026-07-07-stress-load/baseline.json` rewrite
      unless the user asks. That file is pre-existing output of `run-stress.mjs:454-462`.
      Restore it with `git checkout`.

### Slice 1: Engine core (pure)

**Check:**
`npx vitest run test/unit/repo-path-map.test.ts test/unit/repo-refresh-scheduler.test.ts test/unit/repo-tracker.test.ts test/unit/git-info.test.ts test/unit/git-exec.test.ts test/unit/project-info-untracked.test.ts test/unit/project-info-line-counts.test.ts test/unit/project-info-resources.test.ts test/unit/git-changes-count.test.ts`
is green, then `npm run verify`.

**Parallel groups:** G1: T1.1 · G2: T1.2 · G3: T1.3 · G4: T1.4 · Serial: T1.5
**Claims (serial lane):** none. All files are disjoint, and `src/protocol.ts` is untouched in
this slice.

#### Task 1.1: `readRepoChanges` with gated line counts

**Files:**
- Modify: `src/git-exec.ts` (add `GitFailure` and `gitFailureOf` after `GitResult`, L11-26)
- Modify: `src/project-info.ts`:
  - split `gitChanges` (L152-277) into `readRepoChanges`;
  - make the local `run()` (L32-36) return `GitResult`;
  - `gitChanges` delegates.
- Test: `test/unit/project-info-untracked.test.ts`, `test/unit/git-exec.test.ts`

**Interfaces — Produces:** `GitFailure`, `gitFailureOf`, `RepoRead` and `readRepoChanges`,
exactly as in Contracts.

**Call sites:** `gitChanges` callers are unchanged in this slice (`src/project-info.ts:387`,
`electron/main.ts:2534`).

**Steps:**
- [ ] Failing test `'lines:false runs exactly one git process and leaves added/removed 0'`.
      Key assertion: a probe around `runGit` (injected via `vi.mock('../../src/git-exec')`
      passthrough) counts `1`, and every `c.added === 0 && c.removed === 0` for an untracked
      3-line file.
- [ ] Failing test `'status failure surfaces a reason'`: run in a non-repo temp dir →
      `{ok:false, reason:'failed'}`.
- [ ] Failing test `'trackedDirty ignores untracked-only'`: only `??` entries → `false`; one `M`
      → `true`.
- [ ] Failing test in `git-exec.test.ts`: `gitFailureOf` maps `timedOut`, `notFound` and `!ok`.
- [ ] Run → FAIL (the exports are missing). Implement. The existing project-info tests stay
      green.

#### Task 1.2: interrogation exposes git dirs

**Files:**
- Modify: `src/git-info.ts` (`GitInfoOptions` L34-41, `GitInterrogation` L132,
  `interrogateGit` L153-250)
- Test: `test/unit/git-info.test.ts`

**Steps:**
- [ ] Failing test `'linked worktree interrogation returns its own gitDir and the main commonDir'`.
      Key assertion: `gitDir.endsWith('/.git/worktrees/<wt>')` and `commonDir.endsWith('/.git')`,
      both with `/` separators.
- [ ] Failing test `'skipDirty omits the dirty status call'`: `info.dirty === undefined`, and the
      porcelain call is not made.
- [ ] Implement by returning the values already resolved at L166-199.

#### Task 1.3: `RepoPathMap`

**Files:** Create `src/repo-path-map.ts`, `test/unit/repo-path-map.test.ts`

**Interfaces — Produces:** `DirtyKind`, `RepoPaths`, `PathHit`, `RepoPathMap` and `META_FILES`,
as in Contracts.

**Steps — failing tests first (forward-slash fixtures):**
- [ ] `'working-tree file maps to the deepest repo'`: `/w/repoA/src/x.ts` →
      `[{key:'/w/repoa'…'tree'}]`. Use the actual `folderKey` output; don't hand-lowercase
      non-UNC paths.
- [ ] `'worktree index event maps to that worktree as tree'`:
      `/w/repoA/.git/worktrees/wt1/index` → `[{key: wt1Key, kind:'tree'}]`.
- [ ] `'worktree HEAD event maps to that worktree as meta'`:
      `/w/repoA/.git/worktrees/wt1/HEAD` → `[{key: wt1Key, kind:'meta'}]`.
- [ ] `'branch ref event maps to every worktree on that branch'`:
      `/w/repoA/.git/refs/heads/t1/repoA` → only repos with `branch==='t1/repoA'` and that
      commonDir.
- [ ] `'packed-refs maps to every repo of the common dir'`.
- [ ] `'objects and logs under .git map to nothing and are git metadata'`: `classify` → `[]`,
      `isGitMetadata` → `true`.
- [ ] `'loose file maps to nothing and is not git metadata'`.
- [ ] `'main repo .git/HEAD is meta for the main worktree only'`.
- [ ] Implement with ancestor-walk `Map` lookups.

#### Task 1.4: `RefreshScheduler`

**Files:** Create `src/repo-refresh-scheduler.ts`, `test/unit/repo-refresh-scheduler.test.ts`
(use `vi.useFakeTimers()`, injected `now`/`setTimer`)

**Interfaces — Produces:** as in Contracts.

**Steps — failing tests first:**
- [ ] `'a burst of marks runs once after settle'`: 50 marks in 200 ms → 1 `run` at
      t=300 ms.
- [ ] `'continuous marks run at most once per cooldown with a trailing run'`: marks every
      100 ms for 3 s, with each run taking 50 ms. Run starts are ≥1000 ms apart, there are
      ≤4 runs, and the last starts after the final mark.
- [ ] `'one in flight per key'`: a mark during a run does not start a second run until the
      first resolves.
- [ ] `'host-wide cap of 4'`: 10 keys marked `immediate` → at most 4 concurrent `run`s.
- [ ] `'priority orders ready jobs'`.
- [ ] `'ineligible key parks with no run; reconsider runs it'`.
- [ ] `'immediate skips settle and cooldown'`.
- [ ] `'forget drops pending and ignores a late completion'`.
- [ ] `'a rejected run does not wedge the key'`.
- [ ] Implement.

#### Task 1.5: `RepoTracker` core

**Files:** Create `src/repo-tracker.ts`, `test/unit/repo-tracker.test.ts`

**Interfaces — Consumes:**
- `readRepoChanges(cwd, {lines}) → RepoRead`, `GitFailure` (T1.1);
- `GitInterrogation{info, headPath?, gitDir?, commonDir?}` (T1.2);
- `RepoPathMap`, `DirtyKind` (T1.3);
- `createRefreshScheduler`, `REFRESH_*` (T1.4);
- `RepoInfo` (`src/repo-scan.ts:16`), `repoGitFingerprint` (`src/repo-git.ts`), `folderKey`,
  `isAncestorOf`.

**Produces:** `RepoSnapshot`, `TrackerUpdate`, `RepoTrackerDeps`, `RepoTracker` and
`createRepoTracker`, as in Contracts.

**Steps — failing tests first (fake deps, fake timers):**
- [ ] `'two sessions sharing a repo cause one readChanges and one publish listing both sessions'`.
- [ ] `'an edit dirties only its repo'`: 36 registered repos, one `onWatchedPath` →
      `readChanges` is called for exactly that root.
- [ ] `'repo contained only by hidden sessions runs no git; becoming visible runs it once'`.
- [ ] `'background session gets the snapshot via publish.sessions without its own run'`.
- [ ] `'lines follows demand; demand rise re-reads lines:false repos immediately'`.
- [ ] `'meta run arms one git-dir watch per uncovered commonDir, shared by worktrees; released on last removal'`.
- [ ] `'no own git-dir watch while a live root covers the commonDir; opened when that root goes, closed when it returns'`.
      This is the double-watch guard.
- [ ] `'worktree index event from the git-dir watch refreshes that worktree'`. This is the
      commit-seen path.
- [ ] `'lostFolders marks every repo under the folder (and every repo whose commonDir is under it) tree+meta'`.
      Dropped-event recovery.
- [ ] `'own git-dir watch onLost marks all repos of that commonDir tree+meta'`. Watch-loss
      recovery.
- [ ] `'covered→uncovered marks tree+meta; uncovered→covered marks tree'`.
- [ ] `'windowFocused: unknown commonDir → meta+tree immediate; refreshed > 30 s ago → tree at FOCUS_PRIORITY; fresh → nothing'`.
- [ ] `'snapshotsFor marks pending repos stale; a completed publish never carries stale'`.
- [ ] `'failure keeps last snapshot with error; next fire retries'`.
- [ ] `'git published only when fingerprint changes; tree run patches dirty from trackedDirty'`.
- [ ] `'first fill: home/attached before nested; nested by index mtime desc'`.
- [ ] `'refreshNow on an unregistered root is a no-op'`.
- [ ] Implement.

### Slice 2: `repoDelta` end to end (host wiring + renderer)

**Check:**
- `npm run verify` is green.
- `npm run e2e:remote -- --full` is green, including the new `repo-tracker-fanout`,
  `worktree-commit-seen` and `changes-line-demand`.
- The S-final `npm run test:stress -- multi-repo` run uses the engine invariants (T2.9).

**Parallel groups:** Serial: T2.0 · G1: T2.1 · G2: T2.2 · G3: T2.3 · G4: T2.4 · G5: T2.8 ·
Serial: T2.5 → T2.6 → T2.7 → T2.9

**Claims (serial lane):**
- `src/protocol.ts` (T2.0, then T2.6);
- `electron/main.ts` (T2.5, T2.6);
- `webview/app.tsx` (T2.7);
- `webview/bridge.ts` (T2.7).

#### Task 2.0: protocol additions

**Files:** Modify `src/protocol.ts`:
- `RepoChanges` (L103-109) gains `lines: boolean; refreshedAt: number; stale?: true; error?: GitFailure`;
- add the `repoDelta` member to `HostToWebview` (L388);
- add `changes:subscribe` and `repo:refresh` to `WebviewToHost` (L810).

`project` and `requestProject` stay untouched until T2.6.

**Steps:**
- [ ] No red test; these are types only (`src/protocol.ts` is fallow-ignored).
- [ ] `npm run typecheck`. The `RepoChanges.lines`/`refreshedAt` requirement breaks the producer
      in `src/repo-changes.ts` (the object built per repo): set `lines: true, refreshedAt: Date.now()`
      there. That file dies in T2.6.
- [ ] Also update the fake at `webview/bridge.ts:914-921` the same way. Both producers are
      touched only for this.

#### Task 2.1: watcher sinks (path, loss, liveness) + visible-session arming

**Files:**
- Modify `electron/project-watcher.ts`:
  - the constructor opts (L~40) gain `onPath`, `onLost` and `onLive`;
  - `onEvent` calls `onPath` after the `shouldIgnoreWatchPath` check, with the folderKey'd abs
    path;
  - the no-filename branch of `onEvent`, the `open()` onGone callback and the `open()` catch
    each call `onLost(folders)` next to the existing `onSuspect`;
  - `onLive([...this.watches.keys()])` runs after `setFolders`, after onGone, and after
    `stop()`.
- Modify `electron/session-folder-runtime.ts`: `SessionFolderRuntimeDeps` (L13), `arm()`
  (L119-127), and a new `visibilityChanged()`.
- Test: `test/unit/project-watcher.test.ts`, `test/unit/session-folder-runtime.test.ts`.

**Call sites:**
- `new ProjectWatcher(...)` at `electron/main.ts:2230-2231` (wired in T2.5);
- `new SessionFolderRuntime(...)` deps in `electron/main.ts` (T2.5);
- every `SessionFolderRuntime` construction in `test/unit/session-folder-runtime.test.ts` gains
  the `visibleSessionIds` dep.

**Steps:**
- [ ] Failing test `'onPath receives each non-ignored event path synchronously and nothing is retained'`.
      Key assertions: an ignored `node_modules/x` → no call; `src/a.ts` → one call with the
      folderKey'd abs path; the `touched` index semantics are unchanged.
- [ ] Failing test `'a no-filename event calls onLost with every folder under the watch'`.
      Dropped-event recovery.
- [ ] Failing test `'a vanished watch and a throwing open both call onLost, and the root drops out of onLive'`.
- [ ] Failing test `'onLive reports only successfully opened watch roots, not the requested set'`.
- [ ] Failing test `'arm unions visible sessions with window projects'`.
- [ ] Failing test `'visibilityChanged re-arms'`.
- [ ] Implement.

#### Task 2.2: batched GitInfo merge

**Files:** Modify `src/session-manager.ts` (next to `setRepoGit`, L322). Test:
`test/unit/session-manager.test.ts` (it already covers `setRepoGit`).

**Steps:**
- [ ] Failing test `'mergeRepoGit patches several sessions with a single emit and skips unchanged'`.
- [ ] Implement with `sameRepoGit` (`src/session-manager.ts:10`).

#### Task 2.3: tracker host shell

**Files:**
- Create `electron/repo-tracker-host.ts`
- Modify `src/session-resource-demand.ts`:
  - add `export type SessionResourceDemand = ReturnType<typeof createSessionResourceDemand>`;
  - add `visibleIds(): string[]` to the returned object: the union of the non-suspended
    windows' sets, in insertion order. T2.5 consumes it.
- Test: `test/unit/repo-tracker-host.test.ts`, plus `test/unit/session-resource-demand.test.ts`
  (`'visibleIds unions non-suspended windows'`)

**Interfaces — Consumes:**
- `createRepoTracker`, `RepoTracker`, `TrackerUpdate`, `RepoSnapshot` (T1.5);
- `readRepoChanges` (T1.1);
- `interrogateGit` (T1.2);
- `watchDirWhilePresent` (`electron/watch-dir.ts:91`);
- `shouldIgnoreWatchPath` (`src/watch-filter.ts:30`), always called with the `'.git/'` prefix;
- the protocol `repoDelta` (T2.0);
- `mergeRepoGit` (T2.2; typed via `Pick`, so it compiles against the T2.2 signature).

**Produces:** `RepoTrackerHostDeps`, `RepoTrackerHost` and `createRepoTrackerHost`, as in
Contracts. The constructor accepts `trackerDeps?: Partial<RepoTrackerDeps>` overrides for
tests only. The real defaults are built inside.

**Steps:**
- [ ] Failing test `'publish sends repoDelta only to windows where a containing session is visible'`.
- [ ] Failing test `'windowShown sends a full repoDelta from cache with no git'`.
- [ ] Failing test `'windowShown with the same window and the same ids sends full deltas again'`.
      This is the renderer-reload case: after `render-process-gone` the window keeps its id
      (`electron/main.ts:1088-1101`).
- [ ] Failing test `'line demand is per-window set-replace; dropWindow removes its refs'`.
- [ ] Failing test `'refresh rejects a root outside the session repos'`.
- [ ] Failing test `'common-dir objects/ab/cd, logs/HEAD, index.lock and refs/heads/x.lock never reach classify; refs/heads/x and worktrees/w/HEAD do'`.
      Inject a fake `watchDirWhilePresent` and spy on `tracker.onWatchedPath`.
- [ ] Failing test `'a null filename from the common-dir watch calls onLost'`.
- [ ] Implement.

#### Task 2.4: renderer pure adapters

**Files:**
- Modify `src/changes-view-model.ts`:
  - `applyRepoDelta`, `repoChangesOf`;
  - the `linesPending`, `lines` and `error` fields;
  - delete `acceptRepoChanges` (L9-16).
- Modify `webview/review-repos.ts` (`reviewRepoChangesFor` L160-176: drop the `changes` and
  `fallbackRoot` params; return `undefined` when repos are undefined and `[]` when empty).
- Modify `webview/file-tree.ts` (`buildRowChangeMap` L385: input
  `{ repoChanges: readonly RepoChanges[] | undefined }`).
- Tests: `test/unit/changes-view-model.test.ts`, `test/unit/review-repos.test.ts`,
  `test/unit/file-tree.test.ts`.

**Call sites:** `webview/app.tsx:655` (`acceptRepoChanges`), `:1959-1963`
(`reviewRepoChangesFor`) and `:1988-1995` (`buildRowChangeMap`) all move in T2.7. Until then
`app.tsx` will not typecheck. **This task's check is its own vitest files only**, and the slice
check covers the rest.

**Steps:**
- [ ] Failing tests:
  - `'applyRepoDelta full replaces, incremental merges, removed deletes, hidden sessions dropped'`;
  - `'repoChangesOf yields only repos with snapshots so missing ones read as loading'`;
  - `'linesPending when any loaded head has lines:false'`;
  - `'repoChangesOf carries stale and refreshedAt through to the head model'`;
  - `'reviewRepoChangesFor without fallback'`.
- [ ] Implement.

#### Task 2.5: main.ts — construct tracker, route IPC, delete the branch-chip path

**Files:** Modify `electron/main.ts`.

**Changes:**
- Construct `repoTrackerHost = createRepoTrackerHost({mgr, demand: gitDemand, windows, log})`
  after `gitDemand` (L1274-1308).
- `createWatcher` dep → `new ProjectWatcher(onFire, {…, onSuspect, onPath: (k) => repoTrackerHost.onWatchedPath(k), onLost: (f) => repoTrackerHost.lostFolders(f), onLive: (r) => repoTrackerHost.setLiveRoots(r)})`
  (L2230).
- `SessionFolderRuntime` deps gain `visibleSessionIds: () => gitDemand.visibleIds()` (produced
  by T2.3).
- `repoScanner.apply` (L1346): replace `scheduleGitRefresh` with
  `repoTrackerHost.tracker.setSessionRepos(sessionId, repos)`. It is called **whenever**
  `mgr.setRepos` returns true.
- `case 'visible'` (L3560): after `gitDemand.setVisible`, call
  `repoTrackerHost.windowShown(senderId, m.ids)` **unconditionally**, even when the set is
  unchanged, and then `folders.visibilityChanged()`.
- New `case 'changes:subscribe'` → `repoTrackerHost.setLinesDemand(senderId, m.sessionIds)`.
- New `case 'repo:refresh'` → `repoTrackerHost.refresh(m.sessionId, m.root)`.
- Window `onClosed` (L4713-4745) → `repoTrackerHost.dropWindow`.
- `before-quit` (L4690) → `repoTrackerHost.stop()`.
- `disposeSession` (L2587+) → `repoTrackerHost.tracker.dropSession(id)`.
- `onWindowFocus` (L2277-2280): replace `refreshAllGit()` with
  `repoTrackerHost.windowFocused()`.
- In-app git writes get **no** tracker call. The watches see their `index`/`HEAD`/`refs`
  writes (Contracts, host shell). `git:switch`'s `scheduleGitRefresh` (L3497) is deleted with
  the rest.
- **Delete:**
  - `createGitRefresher` wiring (L1428-1455), `syncHeadWatches`, `closeHeadWatches`,
    `sharedHeadWatches`, `gitWatchers`, `loggedWatchFailure` (L1312-1441);
  - `scheduleGitRefresh`, `refreshAllGit`, `teardownGitRefresh`, `gitTornDown`;
  - their call sites at L1565 (cwd change: nothing replaces it, because GitInfo is per repo),
    L1608 (exit: nothing; the session stays subscribed until dispose), L3514/3519
    (pin/unpin: nothing) and L4103 (term:start: nothing; registration fills);
  - the `runGitRefresh(ids)` call in the `gitDemand` run callback (L1311): replace it with
    `repoTrackerHost.tracker.visibilityChanged()`;
  - `src/repo-git-refresh.ts` and `test/unit/repo-git-refresh.test.ts`.

**Steps:**
- [ ] Red: `test/e2e/worktree-commit-seen.e2e.mjs` (T2.8) fails on the pre-T2.5 tree. The
      orchestrator runs it locally by exact name.
- [ ] Implement. `npm run typecheck` (renderer errors from T2.4 are expected until T2.7),
      `npm run check`, `npx fallow --skip health` (no dead exports left).

#### Task 2.6: main.ts — remove the pull-path git leg

**Files:**
- Modify `electron/main.ts` (`refreshProject` L2522-2541, `sendProject` L2543-2579,
  `case 'requestProject'` L2895).
- Modify `src/project-info.ts` (`getProjectInfo` L380-401 → files+customizations only; delete
  `gitChanges`).
- Modify `src/protocol.ts`: `project` loses `changes`/`repoChanges`; `requestProject` loses
  `changesRoot`.
- Delete `src/repo-changes.ts`, `test/unit/repo-changes.test.ts`.
- Modify today's `gitChanges` callers, measured with `rg -l gitChanges test/unit`:
  `test/unit/project-info-resources.test.ts`, `test/unit/project-info-untracked.test.ts` and
  `test/unit/git-porcelain-z.test.ts`. Move them to `readRepoChanges(cwd,{lines:true})` and
  assert `.ok`.

**Changes:**
- The `refreshProject` key becomes `JSON.stringify([folderKey(p), sessionId])`.
- The error path drops `repoChanges: []`.

**Steps:**
- [ ] Green proof: the existing suite plus the T2.8 e2e. No new unit test, since this is a
      deletion task.

#### Task 2.7: renderer — snapshot state, demand, consumers

**Files:**
- Modify `webview/app.tsx`, `webview/bridge.ts`, `webview/components/changes-view.tsx`,
  `webview/components/review-view.tsx`, `webview/components/right-pane.tsx` (thread
  `onRetryRepo`).
- Test: extend `test/unit/changes-view-model.test.ts` only if a new pure helper appears. None
  is planned.

**Changes in `webview/app.tsx`:**
- Replace `repoChanges` `useState` (L424) with `snapshots: SessionSnapshots`.
- Add `const visibleIdsRef = useRef<string[]>([])`, assigned in the existing effect that posts
  `visible` (L1517-1520).
- `msg.type === 'repoDelta'` (inside the once-registered `subscribe` at L645) →
  `setSnapshots(prev => applyRepoDelta(prev, msg, visibleIdsRef.current))`.
  - Read the ref, never the closed-over `activeId`/`splitId`, the same way the `project`
    handler reads `activeRef.current` (L655).
  - Then, for non-full deltas, `rereadOpenDiffs` on open diff docs under each delta root. This
    covers commits that fire no `fsChanged`.
- `repoChanges = useMemo(() => repoChangesOf(active?.repos, snapshots[activeId]), …)`. Every
  existing reader keeps its name: L1959, L1988, L2004-2047, L3216, L3387.
- The `project` handler (L648-656) drops the `setRepoChanges` line. `projectData.changes`
  readers are removed via the T2.4 signatures.
- Drop `changesRoot` from the 4 `requestProject` posts (L1721, L1758, L1828, L2194). Drop the
  `repoChanges` reset on session change (L1737-1740), because snapshots are per session.
- Line demand: an effect on `[activeId, paneTab, settings.explorerCollapsed, reviewDocOpen]`
  posts
  `{type:'changes:subscribe', sessionIds: activeId && (reviewDocOpen || (paneTab === 'changes' && !settings.explorerCollapsed)) ? [activeId] : []}`.
- Retry: pass `onRetryRepo(root)` → `post({type:'repo:refresh', sessionId: activeId, root})`
  to `ChangesView` via `RightPane`.

**Changes in `changes-view.tsx`:**
- When `!head.lines`, rows render a skeleton span in place of `+a −r`, and `HeaderSummary`
  does the same when `model.linesPending`.
- `head.error` renders `STR.gitError(reason)` inline under the header with a Retry button. Add
  these `STR` entries: `gitError: (r) => r === 'timeout' ? "Couldn't read git status — timed out" : "Couldn't read git status"`
  and `retry: 'Retry'`.
- The skeleton has `aria-label` `STR.countingLines` = `'Counting lines…'`.
- When `head.stale`, the repo head's sub-line shows `STR.asOf(time)` = `as of ${time}`, using
  `toLocaleTimeString` with `{hour:'2-digit', minute:'2-digit'}` on `head.refreshedAt`. It is
  dimmed (`--text-dim`), so a parked-dirty snapshot is never shown as current (spec §3). It
  clears on the next non-stale delta.
- Use existing tokens only (spec §11).

**Changes in `review-view.tsx`:** wherever per-file `added`/`removed` render (find them with
`rg -n "\.added|\.removed" webview/components/review-view.tsx`), show the same skeleton when
that file's repo has `lines:false`.

**Changes in `bridge.ts`:** the `requestProject` fake (L902-928) stops sending
`repoChanges`/`changes`. Add a fake for `visible` that emits
`{type:'repoDelta', sessionId, full:true, repos:{[home]: {changes: mockChanges, lines:true, refreshedAt: Date.now()}}}`
for each id.

**Steps:**
- [ ] `npm run typecheck` green across both tsconfigs, then `npm run verify`.
- [ ] Visual check (orchestrator): `npm run shots`. Compare the Changes tab in all 3 themes
      against a baseline captured **before** T2.7, i.e. `npm run shots` on the T2.6 tree.

#### Task 2.8: engine e2e scenarios

**Files:** Create `test/e2e/repo-tracker-fanout.e2e.mjs`, `test/e2e/worktree-commit-seen.e2e.mjs`,
`test/e2e/changes-line-demand.e2e.mjs`.
- Modify the existing readers of `repoChanges`/`project`/`changesRoot`, measured with
  `rg -l "repoChanges|type === 'project'|changesRoot" test/e2e`:
  `test/e2e/changes-multi-repo.e2e.mjs`, `test/e2e/multi-folder-model.e2e.mjs`,
  `test/e2e/multi-repo.e2e.mjs`, `test/e2e/nested-repo-resources.e2e.mjs`,
  `test/e2e/repo-rescan.e2e.mjs`, `test/e2e/review-multi-repo.e2e.mjs` and
  `test/e2e/short-path-root.e2e.mjs`.
  - Each reads changes from `repoDelta` (or the DOM) instead of `project.repoChanges`.
  - Any git-count assertion in `nested-repo-resources` is re-derived from the engine's
    contract, and never loosened to pass.

**Consumes:** `installGitProbe`, `resetGitProbe`, `readGitProbe`, `statusCalls`, `numstatCalls`
(T0.1); `runScenario`, `openSession`, `openChangesTab`, `assert` (`test/e2e/harness.mjs`).

**Scenarios:**
- **`repo-tracker-fanout`:**
  - Setup: a non-git workspace with repoA and repoB, plus a ticket folder holding a worktree of
    repoA. Open a ticket session (background) and a parent session (active, Changes shown).
  - Wait for the first fill to complete (both sessions' `repoGit` hold every repo, and the
    parent's Changes heads are out of "Loading…"). **Only then** call `resetGitProbe`.
  - Write one file in the worktree.
  - Assert exactly **1** `status` call with that worktree's cwd within 3 s, and **0** status
    calls for repoA/repoB.
  - Click the ticket card. Assert its Changes list shows the file within 1 s with **0** new
    status calls (rendered from cache).
  - Renderer reload: `page.reload()`, which takes the same path as the `render-process-gone`
    recovery and keeps the window id. Wait for the bridge. Assert the active session's Changes
    list shows the file again within 3 s with **0** new status calls (full delta from cache on
    the re-posted `visible`).
- **`worktree-commit-seen`:**
  - Setup: home = a ticket folder whose worktree's main repo is **outside** home. Changes tab
    shown with one untracked file listed.
  - Run `git add -A && git commit` from the test process. Assert the list clears within 3 s with
    no UI action.
  - Run `git checkout -b x` in the worktree. Assert the branch chip text becomes `x` within 3 s.
- **`changes-line-demand`:**
  - With the Files tab shown, write an untracked 3-line file. Assert `numstatCalls` stays 0 for
    3 s, while `status` ran.
  - Click the Changes tab. Assert the row shows `+3` within 3 s.

**Steps:**
- [ ] Red-first: these run against the pre-T2.5 tree (orchestrator, local exact name) and fail
      on the counts/commit assertions. Then they pass after T2.7.

#### Task 2.9: stress invariants flip + S-final run (orchestrator)

**Files:** Modify `test/e2e/stress/multi-repo-tickets.stress.mjs`,
`test/e2e/stress/multi-repo-cap.stress.mjs`, `docs/runs/2026-10-16-multi-repo-tracking/report.md`.

**Steps:**
- [ ] Promote these to `assertInvariant`:
  - `statusOutsideWritten === 0`. The probe was already reset after the first fill (T0.2/T0.3).
  - Per written repo, `status` calls ≤ `ceil(durationMs/1000) + 2`, in both Phase A and
    Phase B.
  - `statusPerRepoB ≤ statusPerRepoA + 1`. A second visible session (the split) adds no git:
    cross-session dedupe, proven end to end.
  - `commitSeenMs !== null`.
- [ ] Gate the spec §7 lag AC: `refreshLagP95 ≤ 1000` for the parent in the tickets scenario.
  - The gate applies **only when** `idle.idle` is true.
  - On a loaded machine, the scenario logs `lag gate SKIPPED: machine busy <busy%>` and records
    `lagGate:'skipped-loaded'` in `emitReport`.
  - It never weakens the threshold and never fails for load.
  - A skipped gate must be re-run on an idle machine before Slice 2 is reported done.
- [ ] Run `npm run test:stress -- multi-repo`. Add the S-final column and evaluate the spec §6
      revival trigger (p95 > 1 s or git busy > 70 %) in the report.

### Slice 3: Composite non-git file index (TS index + quick-open + search default)

**Check:** `npx vitest run test/unit/repo-file-index.test.ts test/unit/file-search.test.ts test/unit/repo-tracker.test.ts`,
then `npm run verify`, then `npm run e2e:remote -- --full` with the new `nonrepo-index`.

**Parallel groups:** G1: T3.1 · G2: T3.2 · G3: T3.4 · Serial: T3.3
**Claims (serial lane):** `electron/main.ts` (T3.3)

#### Task 3.1: tracker `onDirty` + `reposUnder`

**Files:** Modify `src/repo-tracker.ts`, `test/unit/repo-tracker.test.ts`.

**Produces:**
- `onDirty(listener: (key: string | null) => void): () => void`:
  - it fires `key` for every `tree` hit from `onWatchedPath` and from `lostFolders`;
  - it fires `null` when `classify` returns `[]` and `!isGitMetadata` (a loose path);
  - the returned function unsubscribes.
- `reposUnder(rootKey): Array<{key, root}>`, sorted by key.

**Steps:**
- [ ] Failing tests:
  - `'a loose path notifies null only'`;
  - `'a repo edit notifies that key only; meta-only events notify nothing'`;
  - `'reposUnder lists registered repos below a folder'`.

#### Task 3.2: `walkFilesAsync` prune + `RepoFileIndex`

**Files:**
- Modify `src/file-search.ts` (`walkFilesAsync`, `fileWalk`: skip a directory when
  `prune?.(abs)`).
- Create `src/repo-file-index.ts`.
- Tests: `test/unit/file-search.test.ts`, `test/unit/repo-file-index.test.ts`.

**Steps:**
- [ ] Failing tests:
  - `'prune skips repo dirs during the loose walk'`;
  - `'build unions repo listings with root-relative rels and loose files'`;
  - `'a repo is re-listed only after invalidateRepo(key)'`: the `listRepo` call count;
  - `'the loose walk re-runs only after invalidateLoose()'`;
  - `'entries for repos no longer under root are dropped'`.
- [ ] Implement with `mapWithConcurrency(…, 4)`. Paths use the forward-slash `IndexedFile`
      shape (`src/path-resolve.ts`).

#### Task 3.3: main.ts — composite in `projectFileIndexMeta`

**Files:** Modify `electron/main.ts` (`projectFileIndexMeta` L479-507, `fileIndexCache` L455-465).

**Changes:**
- The signature is unchanged in this slice.
- When `gitListedFiles(root)` is empty, it returns
  `{files: await repoFileIndex.build(root, tracker.reposUnder(folderKey(root))), fromGit: true}`.
  `fromGit:true` means the candidates are authoritative, so `contentSearch` passes them.
- The `walkFilesAsync(root, 20000)` branch is removed here, and T4.3 brings it back as
  `'everything'`.
- Construct `repoFileIndex = createRepoFileIndex({listRepo: gitListedFiles, walkLoose: walkFilesAsync})`
  and subscribe it with
  `repoTrackerHost.tracker.onDirty((k) => k === null ? repoFileIndex.invalidateLoose() : repoFileIndex.invalidateRepo(k))`.

**Steps:**
- [ ] Red: `nonrepo-index` (T3.4) fails before this task.

#### Task 3.4: `nonrepo-index` e2e

**Files:** Create `test/e2e/nonrepo-index.e2e.mjs`.

**Steps:**
- [ ] Setup: a non-git workspace with repoA (`.gitignore` with `dist/`, `dist/x.ts` present,
      `src/a.ts`) and a loose `notes.md`. Open a session and quick-open.
- [ ] Assert the corpus contains `repoA/src/a.ts` and `notes.md`, and not `repoA/dist/x.ts`.
- [ ] Edit `repoA/src/a.ts` (no new file). After the incremental index, assert the probe shows
      **0** `ls-files` calls for repos other than repoA.

### Slice 4: Search scope chip (v1)

**Check:** `npx vitest run test/unit/search-scope.test.ts`, then `npm run verify`, then
`npm run e2e:remote -- --full` with the new `search-scope`. `npm run shots` covers the chip in
3 themes, and `npm run text-fit` passes.

**Parallel groups:** G1: T4.1 → T4.2 (in order; T4.2 imports `SearchScope`) · G2: T4.5 ·
Serial: T4.3 → T4.4 → T4.6
**Claims (serial lane):** `src/protocol.ts` (T4.3), `electron/main.ts` (T4.3),
`webview/app.tsx` (T4.4), `CHANGELOG.md` (T4.6)

#### Task 4.1: `search-scope` pure model

**Files:** Create `src/search-scope.ts`, `test/unit/search-scope.test.ts`.

**Produces:** `SearchScope`, `scopeChipFolders`, `searchTargets`, as in Contracts.
Target scopes are typed `'tracked' | 'everything'` inline. T4.3 defines `IndexScope` as the
same union, and T4.4 replaces the inline union with an import of it. This keeps G1 off the
claimed protocol file.

**Steps:**
- [ ] Failing tests:
  - `'a folder inside a repo is not a chip folder'`;
  - `'repo scope targets only the active repo'`;
  - `'everything marks only chip folders'`;
  - `'no active repo: repo scope yields no targets'`.

#### Task 4.2: chip component

**Files:** Create `webview/components/search-scope-chip.tsx`, modelled on
`webview/components/review-repo-chip.tsx`: Popover plus `ContextMenu` radio items and
`menuToggleIntent`.

**Interfaces:**
```ts
export interface SearchScopeChipProps {
  scope: SearchScope;
  repoLabel: string | undefined;   // active repo display name; undefined disables "This repo"
  onPick: (scope: SearchScope) => void;
}
```

**Spec:**
- `STR` labels: `tracked: 'Tracked repos'`, `repo: (n) => n`,
  `everything: 'Everything (may be slow)'`, and a chip suffix `▾` rendered as an icon, not text.
- ARIA: a `button` with `aria-haspopup="menu"`, and `menuitemradio` items (spec §9).
- Keyboard: Enter/↓ opens; arrows and Enter pick (ContextMenu behaviour).

**Steps:**
- [ ] No pure logic beyond T4.1. Proof: T4.6 e2e plus `npm run shots`.

#### Task 4.3: host honours `scope`

**Files:** Modify `src/protocol.ts` and `electron/main.ts`.

**Changes in `src/protocol.ts`:** add `export type IndexScope = 'tracked' | 'everything'`.
`searchFiles` (L990) and `contentSearch` (L993) gain `scope?: IndexScope`.

**Changes in `electron/main.ts`:**
- `projectFileIndexMeta(root, opts: { fresh?: boolean; scope?: IndexScope })`.
- For a non-git root with `'everything'`, it returns today's `walkFilesAsync(root, 20000)` with
  `fromGit:false`.
- The cache key becomes `` `${root}\0${scope ?? 'tracked'}` ``.
- The `searchFiles` (L3872) and `contentSearch` (L3893) handlers pass `{scope: m.scope}`.

**Steps:**
- [ ] Red: `search-scope` (T4.5) fails on the Everything assertion before this task.

#### Task 4.4: renderer wiring

**Files:** Modify `webview/app.tsx`, `webview/components/right-pane.tsx`,
`webview/components/files-view.tsx` (L677) and `webview/components/search-pane.tsx` (L217-234,
L367).

**Changes:**
- app.tsx holds `searchScopeBySession: Record<string, SearchScope>`, in memory, default
  `'tracked'`, and threads `scope`, `onScope`, `chipFolders` and `activeRepo` to `SearchPane`.
- `SearchPane` renders the chip only when `chipFolders.length > 0` (spec edge "1 repo, 0
  nested: identical to today").
- `SearchPane` posts one `contentSearch` per `searchTargets(...)` entry with its `scope`.
- Quick-open stays on the default index (Decisions).

#### Task 4.5: `search-scope` e2e

**Files:** Create `test/e2e/search-scope.e2e.mjs`.

**Steps:**
- [ ] Setup: the spec §7 fixture, a non-git root with repoA whose `.gitignore`d `dist/out.js`
      contains `NEEDLE_42`, plus `src/a.ts` containing `NEEDLE_42`.
- [ ] Under Tracked repos: 1 hit (`src/a.ts`), no `dist/`.
- [ ] Switch the chip to Everything: the `dist/out.js` hit appears.
- [ ] Switch session and back: the chip still reads Everything (remembered per session).
- [ ] Keyboard: open the chip with Enter and pick with arrows and Enter.

#### Task 4.6: CHANGELOG

**Files:** Modify `CHANGELOG.md`, under Unreleased. One entry each for:
- engine (only changed repos refresh; ticket sessions see commits);
- line counts deferred while Changes is hidden;
- gitignore-aware search in folders of repos with the scope chip.

## Execution order

```
Slice 0 → Slice 1 → Slice 2 → Slice 3 → Slice 4
```

Slices 2–4 all touch `electron/main.ts`, and Slices 2 and 4 touch `src/protocol.ts`. Slice 3
re-opens `src/repo-tracker.ts`. The slices are serial. Inside a slice, the parallel groups are file-disjoint, which was checked
against each task's Files list. The serial lane runs after its groups.

## Verification

- **Per task:** the named vitest files, then `npm run verify:quick`.
- **Per slice:** `npm run verify`, with its exit code captured directly and never piped through
  `tail`. Then the slice's e2e via `npm run e2e:remote` (`--full` whenever `electron/main.ts`
  changed). Run it serially.
- **Slices 0 and 2:** `npm run test:stress -- multi-repo` locally, by the orchestrator, on an
  idle machine.
- **Before each commit:** `git status` shows only the task's files. Never commit the stress
  lane's `docs/runs/2026-07-07-stress-load/baseline.json` rewrite.
- **Feature flag / rollback:** none. Host and renderer ship together in one build, and the old
  paths are deleted rather than kept switchable. A flag would mean two producers of change lists
  with divergent invariants. Rollback is reverting the slice's commits. Slice 2 lands as one
  logical change, because `project`/`repoDelta` cross the IPC seam.

## Deviation rule

If a task's assumption turns out wrong (the piece it builds on is misaligned, or a locked
signature doesn't fit reality), that task **stops**, and fixing the misaligned piece becomes the
work. Never route around it with a shim, a second copy, a special case, a widened type, a
fallback, or an override patched in place of its semantic source. The report leads with the fix
that keeps the locked decision.

## Decisions Needed

- **[normal]** Window focus no longer re-runs every visible repo immediately (`windowFocused`).
  - It re-marks repos that were never interrogated (`meta`+`tree`, immediate) and repos last
    refreshed more than 30 s ago (`tree`, low priority, still cooldown-bound).
  - Why: a full immediate wave recreates the 36-repo storm on every alt-tab, while the 30 s
    sweep bounds staleness from any loss that raised no signal.
  - Explicit loss signals are handled separately by `onLost` (critique blocker 1).
- **[normal]** Loss (a no-filename event, or a vanished, failed or recovered watch) marks the
  affected repos `tree`+`meta`, not just `tree`.
  - Why: a dropped event can hide a checkout, and losses are rare enough that one interrogation
    per affected repo is cheap.
- **[normal]** `index` changes classify as `tree`. `HEAD`, refs, `packed-refs` and operation
  markers classify as `meta`. A commit therefore costs one status run plus one interrogation
  (from its ref move).
- **[normal]** There is no imperative `touch` after in-app git writes. The watches see every
  write's `index`/`HEAD`/`refs` change, and Retry (`repo:refresh`) is the only imperative
  refresh.
  - Risk: a repo whose common dir is neither covered nor watchable refreshes only on the focus
    sweep.
- **[normal]** GitInfo stays on the `state` broadcast and is not folded into `repoDelta`. After
  a checkout, the chip can trail the list by one `postState` tick. Accepted: folding it in would
  create a second channel for every `Session.repoGit` consumer.
- **[normal]** Own git-dir watches open only for common dirs that no live working-tree watch
  covers. With the parent visible, the typical topology needs zero extra handles.
- **[normal]** Line-demand trigger = Changes tab visible (`paneTab==='changes' && !explorerCollapsed`)
  or the Review doc open.
  - Diff tabs don't count, because they read their own diff and never show list line counts.
- **[normal]** The change list is always present (status only). Only line counts are gated.
  This deviates from spec §3 "`changes?` absent" because of the Explorer dots and hunk host.
  See Spec staleness.
- **[normal]** The tracker keys by `folderKey(RepoInfo.root)`, not realpath. The same repo via
  a junction and via its real path gets two entries. Realpath dedupe joins the parked
  persistence work.
- **[normal]** Exited sessions stay subscribed until disposed. Today `runGitRefresh` skips
  them, but their Changes still refresh via `requestProject`.
- **[normal]** One recursive `watchDirWhilePresent` per uncovered main repo's common git dir.
  - It covers every linked worktree's `index`/`HEAD` and `refs/heads` with one self-re-arming
    handle, instead of the spec's per-worktree index+HEAD plus a separate refs watch.
  - Events under `objects/`/`logs/` and `*.lock` are dropped by
    `shouldIgnoreWatchPath('.git/' + rel)`. The prefix is required (see Contracts, host shell).
- **[normal]** The §7 lag AC gates in T2.9 only on an idle machine (CPU pre-check). Under load
  it reports SKIPPED rather than failing or loosening the threshold, and it must be re-run idle
  before Slice 2 is reported done.
- **[normal]** Cooldown was 1 s, as spec'd; lowered to 800 ms after the S2 stress (spec §13).
- **[normal]** Search scope is remembered per session **in renderer memory**. It resets to
  Tracked repos on restart.
- **[normal]** Quick-open always uses the default (tracked) index; the chip applies to content
  search only.
  - In a non-git root, gitignored files leave Mod+P. That matches git-root behaviour today.
- **[normal]** Stress fixture sizes:
  - tickets: 20 repos × 1500 files (matches the spec's measurement);
  - cap: 200 repos × 50 files, to keep fixture time inside the 420 s scenario timeout.
- **[normal]** Commit-seen is advisory in S0 and gated from T2.9 on. It is expected to fail on
  today's main.
- **[normal]** Git writes made by agents in terminals rely on the watches and the focus sweep,
  with no PTY-driven refresh. This is the same rule as for in-app writes.
- **[normal]** No feature flag (see Verification).
