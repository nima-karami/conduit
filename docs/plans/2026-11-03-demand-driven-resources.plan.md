# Demand-driven resources, Phase 1: implementation plan

**Spec:** `docs/specs/2026-11-03-demand-driven-resources.md` (rev 2, approved). **Tier:** FULL.
Phase 1 only: gate the existing main-process watchers and git by demand. Phase 2 (§9, the server
watch service) is out of scope.

## Goal
A hidden session holds no file watch and runs no git. Its repos refresh, without line counts, when
its reporting agent finishes a turn. Showing it runs one catch-up, and its snapshots read stale
until that catch-up lands.

## Architecture
Every gate keys on one predicate, `gitDemand.isVisible(id)` (`src/session-resource-demand.ts`).
That predicate becomes hidden-by-default (S2). The pure engine (`src/repo-tracker.ts` +
`src/repo-refresh-scheduler.ts`) learns three things:
- "unshown" repos: `unshownSince`, stale, and dirty never downgraded;
- background entries that run while ineligible: turn-end refresh and the D3 meta fill;
- `sessionShown`: catch-up marks.

The Electron shells (`session-folder-runtime`, `repo-tracker-host`, `open-file-watcher`) drop
hidden-only watches. `electron/main.ts` is the only composition point, and the lead owns it.

## Data flow
```
renderer visible post (app.tsx:1817-1821) ─┐  minimize/restore (main.ts:4610-4618)
                                           ▼
                     gitDemand.setVisible / setSuspended   (single demand input; Phase-2 compat #3)
             onHidden (sync) ─────────────┬──────────── run (150 ms after a show)
   folders.visibilityChanged()  ◄─────────┤             folders.visibilityChanged()   ← G2, first
   tracker.visibilityChanged()  ◄─────────┘             fsChanged(all present roots) → showing window
      ├ unshownSince = now for repos with no shown session    tracker.visibilityChanged()
      ├ reconcileWatches(): W2 only for shown repos (G3)
      └ scheduler.reconsider()
'visible' handler: setVisible → folders.visibilityChanged → host.windowShown(ids):
      tracker.sessionShown(ids) → marks meta+tree immediate for unshown repos
      sendFull (cached, stale:true) → tracker.visibilityChanged()
server list → AppSessionStore.applyServer → SessionDiff[] incl. {kind:'turnEnded'}
      → main.sessionsApplied → (hidden) tracker.sessionTurnEnded(id)
      → scheduler.mark(background) → runJob(lines:false) → publish → mergeRepoGit → `state`
renderer watchFiles (shown sessions' file tabs only) → main → OpenFileWatcher.setWindowPaths(windowId)
      → union over non-suspended windows → setPaths
```
State lives in:
- the demand: windows, suspended;
- the tracker: `Repo.unshownSince`, snapshots;
- the scheduler: `Entry.background`;
- `OpenFileWatcher`: per-window paths, suspended windows.

Nothing new persists.

## Settled decisions (carried from the spec; do not re-litigate)
**Phasing and gates**
- Phase 1 gates the existing watchers. No new watch service and no grace period (D4 is Phase 2).
- Shown(session) ≡ `gitDemand.isVisible(id)`. Before any report, nothing is shown (S2).
- A minimized window is hidden. An occluded window is visible (D11).
- G6: a resident LSP keeps its root watch while hidden (≤ `DORMANT_MS`). W5/W6 are unchanged (D7).

**Turn end**
- `turnEnded` fires when:
  - `completions` increases **and** `runtime.reportedStatus !== null`; or
  - `status` goes `running → exited`.
- A decrease is never an edge. Plain shells are in the idle bucket (D12 = no).
- It does not refresh on `blocked` (D1). Rescans run on show only, never at turn end (D2).
- D3 = yes: a staggered meta-only startup fill for hidden repos.
- `BACKGROUND_COOLDOWN_MS` = 10 s, with a trailing run (D5). Background priority = `FOCUS_PRIORITY + 1`.

**Show and staleness**
- On show, every repo with `unshownSince` is marked unconditionally, with no skip (D8). The order
  follows first fill.
- While a repo is unshown, its snapshot reads `stale`. A published `dirty` never goes `true → false`.
- `watchFiles` covers all tabs of the shown sessions (D10).

**Out of plan**
- D6 and D9 are left to the measurement report.

## Spec staleness (measured; how the plan proceeds)
1. **Worktree base.** `docs/demand-resources` (f0a72b50) is based on **e777cb3f**, not main
   7f4c6250: main is 24 commits ahead (`git merge-base main docs/demand-resources`). Every
   `file:line` in this plan is cited against **main 7f4c6250**. **C1 step 0:** rebase the
   docs-only branch onto main.
2. **G5 already landed** as lane F (9fdf8b40). The predicate is
   `isBroadWatchRoot(dir, homeDir)` in `src/watch-scope.ts:13`, which is already pure in `src/`
   (Phase-2 compat #6).
   - W1 (`electron/project-watcher.ts:120`) and W3 (`electron/lsp-watcher.ts:94` on main) already
     open a broad root **top-level only**. They do not refuse it.
   - `electron/session-folder-runtime.ts:173-184` gives each repo inside a broad root its own
     recursive watch.
   - The plan keeps lane F's semantics for W1 and W3. That satisfies "never watched recursively",
     so it is not redesigned.
   - It adds the missing third site: W2 refuses in `electron/repo-tracker-host.ts`, logged once per
     dir. See Decisions Needed #1.
3. **Line references** that moved on main:

   | Spec cites | On main |
   |---|---|
   | `session-folder-runtime.ts:127-149` (`watchEntries`) | `:145-166` |
   | `:141-147` (the tracking block) | `:160-164` |
   | `:138-140` (the comment) | `:157-159` |
   | `:120-125` (`armsFor`) | `:137-142` |
   | `test/unit/session-folder-runtime.test.ts:169,198` | `:177` and `:206`, plus `:281` (a third test that asserts the hidden-with-repos rule) |
   | `app.tsx:1793-1797` (the `visible` post) | `:1817-1821` |
   | `app.tsx:2180-2189` (`watchFiles`) | `:2201-2213` |

   `main.ts`, `repo-tracker*.ts`, `repo-refresh-scheduler.ts`, `session-resource-demand.ts`,
   `app-session-store.ts` and `open-file-watcher.ts` are byte-identical between the branch and
   main, so the spec's citations into them hold.
4. **The OSC 7501 helper** is `report(page, sid, state)` in
   `test/e2e/attention-footer-helpers.mjs:46`, not in `sidebar-done-seen.e2e.mjs`. It posts
   `term:input` (`test/e2e/harness.mjs:1418`), so it works for a hidden session.
5. **`runJob` always runs `readChanges`**, whatever the pending kinds (`src/repo-tracker.ts:210-214`),
   so a "meta-only" run does not exist today. D3 needs one. The plan adds it, for **unshown repos
   only**, so a shown repo's `meta` classify hit keeps today's behaviour (Slice E).
6. **`publish` sends `repo.snapshot` raw** (`src/repo-tracker.ts:233-239`), and the host forwards
   deltas to minimized windows (`electron/repo-tracker-host.ts:82-83`). Without a change, a hidden
   run's delta would claim to be current. The plan publishes `stale: true` while the repo is
   unshown.
7. **Adding `turnEnded` to `SessionFolderDiff`** would be read as a removal: `applied`'s `else`
   branch treats any non-added, non-changed kind as removed (`session-folder-runtime.ts:66-71`). The
   plan adds a separate union member and an explicit skip in C1.
8. **The `run` callback replays only `pendingFsByWindow` roots** (`main.ts:1305-1312`). With G1,
   hidden sessions raise no fires, so that set stays empty. To get the spec's "one `fsChanged` on
   show", the callback sends all present roots of the shown ids (I1).
9. **The stress lane does not run remotely.** It is local Windows only
   (`test/e2e/stress/run-stress.mjs:2-5`, `npm run test:stress`), and `tools/e2e-remote.mjs` has no
   stress path. M1–M6 are measured locally on an idle machine. The e2e scenarios run remotely.
10. **A hidden session's first repo detection still runs at startup.** `scheduleRepoScan` defers
    only once `repos` is known (`main.ts:1415-1422`). It counts with D3 as startup git under AC-2.

## Global constraints
- **Repo rules.** Read `CLAUDE.md` first.
  - Comments say WHY only. When the why is in the spec, use a one-line pointer: `// see spec 2026-11-03-demand-driven-resources §3.4`.
  - No `as any`, `@ts-ignore`, swallowed errors, or shims.
  - Git spawns only via `runGitBin`. Watches only via `watchDir` / `watchDirWhilePresent`.
- **Names.** Files are kebab-case. Unit tests are `test/unit/<module>.test.ts` (Vitest). E2E is
  `test/e2e/<name>.e2e.mjs`, stress is `test/e2e/stress/<name>.stress.mjs`.
- **Ubuntu CI.**
  - Unit tests inject `watch`, timers and git: use `vi.useFakeTimers()`, the harnesses' `trackerDeps` / `watchDirWhilePresent` / `createWatcher` fakes, and `vi.mock('../../electron/watch-dir')` as `test/unit/open-file-watcher.test.ts:7` does.
  - Paths in tests are posix (`/w/a`, `/home/u`). Never `C:`, `\`, `process.platform` or `os.homedir()`; pass `homeDir`.
- **Pure-core boundary (Phase-2 compat #1, #2, #4).**
  - `src/repo-tracker.ts`, `src/repo-refresh-scheduler.ts` and `src/session-resource-demand.ts` import no Electron and no `node:fs`.
  - New tracker entry points take session ids only.
  - Window ids appear only in the demand, the folder runtime's `projectsByWindow` and `OpenFileWatcher`.
- **Per-lane check:** `npm run test:unit -- <the lane's test files>`, then `npm run verify:quick`.
  Capture exit codes directly. Never pipe `verify` output through `tail`.
- **Claims.** A lane edits only its claimed paths. `electron/main.ts`, `CHANGELOG.md`,
  `electron/server-events.ts` and `src/protocol.ts` are the lead's: C1 and I1 only. `src/protocol.ts`
  needs **no** change, because `watchFiles` keeps its shape and the window is the sender.
- **Lanes never break another file's compile.** Every signature that `main.ts` or another lane
  calls is pinned and landed in C1.
- **Test cadence** (memory): related units plus `verify:quick` while building; full `npm run verify`
  and remote e2e once, after integration.

## Out of scope
- Phase 2 (§9).
- Renderer memory.
- Web-tab guests.
- Tracked or paused repo controls.
- New UI.
- LSP residency changes (D6).
- Evicting cached `changes` (D9).
- Plans, board, proposal and notes watchers (D7).
- Redesigning lane F's broad-root handling.

## Contracts

All of these are landed by **C1** (lead) and are the only thing any lane may assume about another.

```ts
// src/session-resource-demand.ts — returned object gains:
/** The window is minimized (its own set is kept, but it shows nothing). */
isSuspended(windowId: number): boolean;            // C1: real body, `suspended.has(windowId)`

// src/repo-tracker.ts — interface RepoTracker gains:
/** These sessions just went on screen: catch-up marks for their repos that had no shown session
 *  (spec §3.5). Called after the demand reports them visible, before the full send. */
sessionShown(sessionIds: readonly string[]): void;  // C1 body: no-op; G-ENGINE implements
/** A hidden session's reporting program finished a turn, or its process exited (spec §3.4). */
sessionTurnEnded(sessionId: string): void;          // C1 body: no-op; G-ENGINE implements

// electron/app-session-store.ts
export interface SessionTurnEndedDiff {
  sessionId: string;
  kind: 'turnEnded';
}
export type SessionDiff = SessionFolderDiff | SessionTurnEndedDiff;   // SessionFolderDiff unchanged
applyServer(views: SessionView[]): SessionDiff[];   // C1: type only; G-TURN emits turnEnded

// electron/server-events.ts — ServerEventRouterDeps
sessionsApplied(diffs: SessionDiff[]): void;

// electron/session-folder-runtime.ts
interface SessionFolderRuntimeDeps { /* existing */ isWindowSuspended: (windowId: number) => boolean; }
applied(diffs: readonly SessionDiff[]): void;       // C1: `turnEnded` → `continue` (never a removal)
```

**Owned by one group each, so they are not C1** (the consumer is the lead's I1, after merge):

```ts
// electron/open-file-watcher.ts (G-OPENFILES)
setWindowPaths(windowId: number, paths: readonly string[]): void;
setWindowSuspended(windowId: number, suspended: boolean): void;
dropWindow(windowId: number): void;
// setPaths(paths) stays public until I1 makes it private (its one external call, main.ts:2902, moves to setWindowPaths)

// electron/repo-tracker-host.ts (G-HOST)
interface RepoTrackerHostDeps { /* existing */ homeDir?: string; }  // default os.homedir(); tests pass '/home/u'

// src/repo-refresh-scheduler.ts (G-ENGINE)
export const BACKGROUND_COOLDOWN_MS = 10_000;
interface MarkOptions { immediate?: boolean; priority?: number; background?: boolean; }
// src/repo-tracker.ts (G-ENGINE)
export const BACKGROUND_PRIORITY = FOCUS_PRIORITY + 1;

// webview/watched-files.ts (G-OPENFILES, new)
export function shownFilePaths(
  docs: readonly Pick<OpenDoc, 'kind' | 'path' | 'sessionId'>[],
  shownIds: readonly string[],
): string[];   // file docs whose sessionId ∈ shownIds; deduped; sorted
```

**Invariants:**
- I-1: `sessionShown` and `sessionTurnEnded` ignore unknown ids and never throw.
- I-2: no watch-driven mark (`onWatchedPath`, `lostFolders`, the git-dir `onLost`, `setLiveRoots`)
  is recorded for a repo with no shown session. `notifyDirty` stays ungated
  (`test/unit/repo-tracker.test.ts:688` keeps passing).
- I-3: published `GitInfo.dirty` for a repo whose run **started** unshown is
  `read.trackedDirty ? true : prev === true ? true : undefined`. The key is omitted when undefined.
- I-4: a published or sent snapshot carries `stale: true` while `unshownSince !== undefined`.
  `snapshotsFor` also reports `stale` while `pending`, as today.
- I-5: `unshownSince` is set when a repo registered or visibility-reconsidered has no shown
  session. It clears only when a run that **started** shown completes `read.ok` and the repo is
  still shown.

## Producer/consumer map
| Behavior changed | Produced by | Consumed by | Sides touched |
|---|---|---|---|
| Hidden before first report (S2) | `src/session-resource-demand.ts` | `main.ts:1416` scans, `:1754` fsChanged, `:2119` project requests, `:3570` indexing, `:1300`; `repo-tracker-host.ts` `isShownInWindow` (`:83`); folder runtime `visibleSessionIds` (`main.ts:1785`) | both: demand (G-DEMAND); consumers unchanged by design (they already defer until shown) |
| Folder arm set (G1) | `SessionFolderRuntime.watchEntries` | `ProjectWatcher.setFolders` → `onLive` → `tracker.setLiveRoots` (`main.ts:1774-1781`) | both: runtime (G-FOLDERS); `setLiveRoots` coverage marks gated (G-ENGINE) |
| Minimize re-arm (G2) | demand `onHidden` / `run` (`main.ts:1296-1337`), restore (`:4614-4618`) | `folders.visibilityChanged`, `tracker.visibilityChanged`, `host.windowRestored` | lead I1 (all in main.ts) |
| W2 git-dir watch (G3) | `reconcileWatches` (`repo-tracker.ts:161-178`) | `deps.watchGitDir` → `repo-tracker-host.ts:309-325` | both: G-ENGINE (gate), G-HOST (refusal) |
| `turnEnded` | `AppSessionStore.applyServer` | `server-events.ts:127-128` → `main.sessionsApplied` → `tracker.sessionTurnEnded`; `SessionFolderRuntime.applied` (skips) | all: G-TURN, C1 (routing + skip), G-ENGINE (consumer) |
| Background mark / cooldown | `RepoTracker` (`sessionTurnEnded`, D3 fill) | `RefreshScheduler` | both, one group (G-ENGINE) |
| Stale / dirty | `snapshotOf`, `runJob` publish | `repo-tracker-host` `sendDelta`/`sendFull` → renderer `changes-view.tsx:334`; `mergeRepoGit` → `src/session-icon.ts`, `src/agent-tree.ts` | producer only. The consumers already render `stale` and treat absent `dirty` as not dirty; that `undefined` shows not-review is accepted by spec §3.5 |
| Show marks | `host.windowShown` / `windowRestored` | `tracker.sessionShown` | both: G-HOST (call order), G-ENGINE (marks) |
| fsChanged on show | demand `run` (`main.ts:1298-1313`) | renderer FilesView | producer (I1). The renderer re-read on `fsChanged` exists; e2e verifies it |
| Open-file watch (G4) | renderer `watchFiles` (`app.tsx:2201-2213`) | `main.ts:2898-2904` → `OpenFileWatcher` | all: G-OPENFILES (renderer + watcher), I1 (main) |
| Attention (AC-9) | `server/attention/index.ts` | unchanged | guard test only (G-E2E). Imports measured fs-free at `server/attention/index.ts:1-14` |

## File map
| Path | Action | Owner | Responsibility |
|---|---|---|---|
| `src/session-resource-demand.ts` | modify | C1, then G-DEMAND | `isSuspended` (C1); hidden-before-report (G-DEMAND) |
| `src/repo-tracker.ts` | modify | C1, then G-ENGINE | interface shells (C1); unshown, stale, dirty, gates, `sessionShown`, `sessionTurnEnded`, D3 |
| `src/repo-refresh-scheduler.ts` | modify | G-ENGINE | `background` entries, `BACKGROUND_COOLDOWN_MS` |
| `electron/app-session-store.ts` | modify | C1, then G-TURN | `SessionDiff` type (C1); `turnEnded` detection |
| `electron/server-events.ts` | modify | C1 | `sessionsApplied(diffs: SessionDiff[])` |
| `electron/session-folder-runtime.ts` | modify | C1, then G-FOLDERS | dep and skip (C1); G1 arm rule |
| `electron/repo-tracker-host.ts` | modify | G-HOST | show/restore order; W2 refusal |
| `electron/open-file-watcher.ts` | modify | G-OPENFILES, then I1 | per-window union; I1 makes `setPaths` private |
| `webview/watched-files.ts` | create | G-OPENFILES | the pure shown-file-tab selector |
| `webview/app.tsx` | modify | G-OPENFILES | `watchFiles` effect, scoped to the shown sessions |
| `electron/main.ts` | modify | C1, then I1 | all composition |
| `CHANGELOG.md` | modify | I1 | the `[Unreleased]` line |
| `test/unit/session-resource-demand.test.ts` | modify | C1, then G-DEMAND | |
| `test/unit/repo-tracker.test.ts` | modify | G-ENGINE | |
| `test/unit/repo-refresh-scheduler.test.ts` | modify | G-ENGINE | |
| `test/unit/app-session-store.test.ts` | modify | G-TURN | |
| `test/unit/session-folder-runtime.test.ts` | modify | C1, then G-FOLDERS | |
| `test/unit/repo-tracker-host.test.ts` | modify | G-HOST | |
| `test/unit/open-file-watcher.test.ts` | modify | G-OPENFILES | |
| `test/unit/watched-files.test.ts` | create | G-OPENFILES | |
| `test/unit/attention-fs-free.test.ts` | create | G-E2E | AC-9 import-graph guard |
| `test/e2e/demand-watch.e2e.mjs` | create | G-E2E | AC-1–6, 13 scenario |
| `test/e2e/stress/hidden-sessions-idle.stress.mjs` | create | G-E2E | §8 S-idle / S-show measurements |
| `test/unit/demand-resources.test.ts` | create | I1 | cross-module: real demand + host + engine |
| `docs/runs/2026-11-03-demand-resources/report.md` | create | I1 (after the stress runs) | M1–M6 before/after |

## Scripts
**None.** No edit repeats across more than a handful of files. The e2e instrumentation (patching
`fs.watch` and `cp.execFile` in main) is copied from `test/e2e/background-resources.e2e.mjs:24-49`.
It is used by exactly two files, so it is not extracted.

## Groups

| Group | Tier | Claims | Depends on |
|---|---|---|---|
| **C1** contracts (lead, serial, first) | T2 | 9 | none |
| **G-ENGINE** | **T1** | 4 | C1 |
| **G-HOST** | T2 | 2 | C1 |
| **G-FOLDERS** | T2 | 2 | C1 |
| **G-DEMAND** | T3 | 2 | C1 |
| **G-TURN** | T3 | 2 | C1 |
| **G-OPENFILES** | T2 | 5 | C1 |
| **G-E2E** (authoring; runs at I1) | T2 | 3 | C1 |
| **I1** integration (lead, serial, last) | T1 | 5 (+ `open-file-watcher.ts` post-merge) | all |

The seven lanes have pairwise disjoint claims. No lane touches `main.ts`, `server-events.ts`,
`protocol.ts` or `CHANGELOG.md`.

## Slices

### Slice C1: Contracts (lead, serial; commit before any lane starts)

**Check:** `npm run test:unit -- test/unit/session-resource-demand.test.ts test/unit/session-folder-runtime.test.ts test/unit/app-session-store.test.ts test/unit/server-events.test.ts test/unit/repo-tracker.test.ts`, then `npm run verify` (pre-commit). Behaviour is unchanged: every existing test is green.

**Claims:** `src/session-resource-demand.ts`, `src/repo-tracker.ts`, `electron/app-session-store.ts`,
`electron/server-events.ts`, `electron/session-folder-runtime.ts`, `electron/main.ts`,
`test/unit/session-resource-demand.test.ts`, `test/unit/session-folder-runtime.test.ts`, `docs/` (rebase).

Why the C1 tests are green, not red: `npm run verify` is the pre-commit gate (CLAUDE.md), so a red
test cannot be committed. C1's compat tests pin the seams and are green on commit. Each lane writes
its own behaviour tests red-first, inside the lane.

#### Task C1.0: Rebase
- `git rebase main` on `docs/demand-resources` (docs-only commits 5d4c7165 and f0a72b50; no conflicts expected).
- Confirm `src/watch-scope.ts` exists.

#### Task C1.1: Demand `isSuspended`
**Files:** Modify `src/session-resource-demand.ts` (the returned object). Test `test/unit/session-resource-demand.test.ts`.
- Produces: `isSuspended(windowId: number): boolean`.
- [ ] Test `'isSuspended reports a minimized window until it is restored or dropped'`. Key assertions:
  - after `setSuspended(1, true)`: `isSuspended(1) === true`;
  - after `setSuspended(1, false)`: `false`;
  - after suspend, then `dropWindow(1)`: `false`.

#### Task C1.2: Tracker shells
**Files:** Modify `src/repo-tracker.ts`. Add the two `RepoTracker` members with the doc comments
under Contracts, and `sessionShown() {}` / `sessionTurnEnded() {}` in the returned object.
- Produces: `sessionShown(sessionIds: readonly string[]): void`, `sessionTurnEnded(sessionId: string): void`.
- No test: they are no-ops until G-ENGINE.

#### Task C1.3: `SessionDiff` and its routing
**Files:**
- Modify `electron/app-session-store.ts`: export `SessionTurnEndedDiff` and `SessionDiff`; `applyServer` returns `SessionDiff[]`. The body is unchanged.
- Modify `electron/server-events.ts:12,29`: import and use `SessionDiff`.
- Modify `electron/session-folder-runtime.ts:12,63-72`: `applied(diffs: readonly SessionDiff[])`, with an explicit `if (d.kind === 'turnEnded') continue;` before the removed branch.
- Modify `electron/main.ts:207,2270-2294`:
  - import `SessionDiff`;
  - `sessionsApplied = (diffs: SessionDiff[])`;
  - first statement in the loop: `if (d.kind === 'turnEnded') { if (!gitDemand.isVisible(d.sessionId)) repoTrackerHost.tracker.sessionTurnEnded(d.sessionId); continue; }`.

**Test:** `test/unit/session-folder-runtime.test.ts`.
- [ ] `'a turnEnded diff is neither a removal nor a folder change'`. Key assertions after `applied([{ sessionId: 's1', kind: 'turnEnded' }])`:
  - `reconcilePlans` not called;
  - `scheduleRepoScan` not called;
  - a later health change for `s1` still rescans (the health baseline was kept).

#### Task C1.4: `isWindowSuspended` dependency
**Files:**
- Modify `electron/session-folder-runtime.ts:15-30`: add the `isWindowSuspended: (windowId: number) => boolean` dep. It is unused in logic until G-FOLDERS.
- Modify `electron/main.ts:1744-1787`: pass `isWindowSuspended: (windowId) => gitDemand.isSuspended(windowId)`.
- Modify `test/unit/session-folder-runtime.test.ts`: the fake-deps builder (`:20-58` region) passes `isWindowSuspended` from a `suspended: Set<number>` it returns.

Commit message: `feat(demand): contracts for demand-driven resources (spec 2026-11-03 Phase 1)`.

---

### Slice E: G-ENGINE (T1): scheduler background entries and tracker demand model

**Check:** `npm run test:unit -- test/unit/repo-refresh-scheduler.test.ts test/unit/repo-tracker.test.ts`, then `npm run verify:quick`.

**Claims:** `src/repo-refresh-scheduler.ts`, `src/repo-tracker.ts`,
`test/unit/repo-refresh-scheduler.test.ts`, `test/unit/repo-tracker.test.ts`.

**Consumes (C1):** `RepoTracker.sessionShown(sessionIds: readonly string[]): void` and
`sessionTurnEnded(sessionId: string): void`, currently no-op bodies in `src/repo-tracker.ts`.
Replace them.

**Why T1:** single-flight, cooldown and trailing-run timing; ordering between visibility, marks and
in-flight runs; the dirty and stale invariants across hide/show races.

#### Task E.1: Scheduler `background`
**Files:** Modify `src/repo-refresh-scheduler.ts`. Test `test/unit/repo-refresh-scheduler.test.ts`.
- Produces:
  - `export const BACKGROUND_COOLDOWN_MS = 10_000`;
  - `MarkOptions.background?: boolean`, doc comment: "Runs while ineligible; while ineligible its cooldown is `BACKGROUND_COOLDOWN_MS` (spec 2026-11-03-demand-driven-resources §3.4)."
- Rules:
  - `Entry` gains `background: boolean`, initialised `false`.
  - `mark` sets `e.background = true` when `opts.background`, **before** the `running` / `queued` early return (`:171`), so a mark during a run makes the trailing run background.
  - `fire` (`:88`) and `drain` (`:123`) park only when `!deps.eligible(key) && !e.background`.
  - `armAfterSettle` (`:78-84`): the cooldown is `e.background && !deps.eligible(key) ? BACKGROUND_COOLDOWN_MS : REFRESH_COOLDOWN_MS`.
  - `start` (`:131`) sets `e.background = false`.
  - `reconsider` is unchanged.
- [ ] Failing tests:
  - `'pins the locked tuning'` (`:72`) also asserts `BACKGROUND_COOLDOWN_MS === 10_000`.
  - `'a background mark runs while ineligible after the settle'`. With `eligible` false and `mark(k,'tree',{background:true})`: one run at 300 ms.
  - `'a background key runs at most once per 10 s, with one trailing run'`. Run 1 at 300 ms. Marks at 1 s, 2 s and 5 s while ineligible. Exactly one more run, at `lastStart + 10 000`, and no third.
  - `'a non-background mark on an ineligible key still parks'`. The existing `:190` stays green.
  - `'a background entry that becomes eligible uses the normal cooldown'`. Mark background, run, flip eligible, mark: the next run is at `lastStart + 800`.
- [ ] Run, expect FAIL (no export, no flag). Implement.

#### Task E.2: Tracker unshown state, gates, stale and dirty
**Files:** Modify `src/repo-tracker.ts`. Test `test/unit/repo-tracker.test.ts`.

**Produces (internal):**
- `export const BACKGROUND_PRIORITY = FOCUS_PRIORITY + 1`.
- `Repo.unshownSince?: number`.
- `const isShown = (repo: Repo) => [...repo.sessions].some((s) => deps.isSessionVisible(s))`. The scheduler's `eligible` (`:125-128`) uses it.

**Rules:**
- `setSessionRepos` (`:306-314`): a new repo gets `unshownSince: deps.now()` when `!isShown` (after its session is added).
- `visibilityChanged()` (`:383`):
  1. for each repo: `if (!isShown(repo) && repo.unshownSince === undefined) repo.unshownSince = deps.now()`;
  2. `reconcileWatches()`;
  3. `scheduler.reconsider()`.
- G3, `reconcileWatches` (`:161-165`): wants `repo.commonDir` only when `isShown(repo) && !isCovered(repo.commonDir)`.
- I-2 gates. Each of these skips `mark` unless `isShown(repo)`; every `notifyDirty` call stays:
  - `onWatchedPath` (`:276-286`);
  - `lostFolders` (`:352-364`);
  - `onLostCommonDir` (`:155-158`);
  - both branches of `setLiveRoots` (`:373-376`).

  `repo.covered` updates unconditionally.
- I-4: `snapshotOf` (`:180-181`) returns stale when `repo.pending || repo.unshownSince !== undefined`.

**`runJob` (`:185-249`):**
- `const shownAtStart = isShown(repo)` before the first await.
- D3: when `!kinds.tree && !shownAtStart`, the job interrogates as today, then publishes `{ key, root, sessions, git }` if the fingerprint changed, and returns **without** `readChanges`.
- I-3: after an ok read, `info = shownAtStart ? withDirty(info, read.trackedDirty) : withDirty(info, unshownDirty(info.dirty, read.trackedDirty))`, where:
  - `function unshownDirty(prev: boolean | undefined, read: boolean): true | undefined`;
  - `withDirty(info: GitInfo, dirty: boolean | undefined)` omits the `dirty` key when `undefined`.
- The published snapshot is `repo.unshownSince !== undefined ? { ...repo.snapshot, stale: true } : repo.snapshot`. `pending` still never stales a publish (`:502` stays green).
- I-5: after an ok read, `if (shownAtStart && isShown(repo)) repo.unshownSince = undefined` — done before computing the published snapshot.

**Tests:**
- [ ] Failing tests:
  - `'a repo of hidden sessions only records no watch-driven mark'`. `onWatchedPath`, `lostFolders` and the git-dir `onLost` cause no `readChanges` or `interrogate` after 5 s with `isSessionVisible` false. **Inverts** `:178`, which now becomes a `sessionShown` test (below).
  - `'no git-dir watch for a repo with no shown session; opened when one is shown and visibilityChanged runs'` (G3).
  - `'covered→uncovered marks tree+meta only while shown'`: the existing `:458`, extended with a hidden repo that gets no run.
  - `'a hidden repo snapshot is stale and a hidden clean read never downgrades dirty'`. Run shown with dirty → `dirty: true`. Hide, then `visibilityChanged()`. A turn-end run reading clean publishes git with `dirty` absent, never `false`, and its snapshot has `stale: true`.
  - `'unshownSince clears only after a run that started shown lands ok'`.
- [ ] Run, expect FAIL. Implement.

#### Task E.3: `sessionTurnEnded`, `sessionShown`, D3 fill
**Files:** same as E.2.

**Rules:**
- `sessionTurnEnded(id)`: for each `ri` of `sessionRepos.get(id) ?? []`, with `repo = repos.get(folderKey(ri.root))`. If `repo && !isShown(repo)`:
  - `mark(repo, ['meta', 'tree'], { background: true, priority: BACKGROUND_PRIORITY })`;
  - `notifyDirty(repo.key)`.

  Unknown ids are a no-op.
- `sessionShown(ids)`: take the repos that have a session in `ids` and `unshownSince !== undefined`. Pair each with its `RepoInfo` from that session's `sessionRepos` entry, then call `markRanked(pairs)`.
  - `markRanked` is extracted from `firstFill` (`:257-274`).
  - Home and attached repos: `mark(['meta','tree'], { immediate: true, priority: 0 })`.
  - Nested repos: ranked by `deps.indexMtime` descending, `priority: i + 1`.
  - Each repo is marked once even if two ids share it.
- `firstFill(added)`:
  - shown repos → `markRanked`, as today;
  - unshown repos → `mark(repo, ['meta'], { background: true, priority: BACKGROUND_PRIORITY })`. That is D3: interrogate only (`interrogateGit` with `skipDirty`, `GIT_TIMEOUT.metadata`), staggered by the cap of 4 and the settle.

**Tests:**
- [ ] Failing tests:
  - `'turn end on a hidden session refreshes its repos once, lines:false, behind shown work'`. One `readChanges` with `lines: false` within 300 ms + git time. Sessions published.
  - `'a turn end for a repo that has a shown session does nothing extra'`.
  - `'turn ends 1 s apart while hidden: one run then one trailing at 10 s'`.
  - `'sessionShown marks unshown repos immediately; home/attached first, nested by index mtime'`.
  - `'sessionShown for a repo that never went unshown runs no git'`.
  - `'a hidden first fill interrogates only: no readChanges, git published, no snapshot'`.
  - `'a meta-only mark on a SHOWN repo still reads changes'`: today's behaviour, pinned.
- [ ] Run, expect FAIL. Implement.

**Call sites:** `sessionShown` is called by G-HOST (`electron/repo-tracker-host.ts`). `sessionTurnEnded` is called by `electron/main.ts`, `sessionsApplied` (C1). There are no other callers.

---

### Slice H: G-HOST (T2): show/restore ordering and W2 refusal

**Check:** `npm run test:unit -- test/unit/repo-tracker-host.test.ts`, then `npm run verify:quick`.

**Claims:** `electron/repo-tracker-host.ts`, `test/unit/repo-tracker-host.test.ts`.

**Consumes (C1):** `tracker.sessionShown(sessionIds: readonly string[]): void`. It is a no-op at
C1, so the tests spy on it (`vi.spyOn(h.host.tracker, 'sessionShown')`) and never assert its
effects.

**Rules:**
- `windowShown(windowId, ids)` (`:366-369`): `tracker.sessionShown(ids)`; `sendFull(windowId, ids)`; `tracker.visibilityChanged()`. Spec §3.5 order.
- `windowRestored(windowId)` (`:370-372`): `const ids = owned(windowId, demand.shownIn(windowId))`; `tracker.sessionShown(ids)`; `sendFull(windowId, ids)`; `tracker.visibilityChanged()`.
- Deps gain `homeDir?: string` (default `os.homedir()`, read once). The `watchGitDir` wrapper (`:309-325`):
  - if `isBroadWatchRoot(commonDir, homeDir)` (`src/watch-scope.ts:13`), it returns `{ close() {} }` without calling `watchWhilePresent`;
  - it logs `log.warn('repo-tracker', 'git dir watch refused: home or filesystem root', { commonDir })` once per `folderKey(commonDir)`, held in a host-level `Set<string>`.

**Tests:**
- [ ] Failing tests:
  - `'windowShown calls sessionShown, then sends full, then reconsiders'`. Use a shared call log, spying on `sessionShown` and `visibilityChanged` and recording `send`. Expect `['sessionShown:s1', 'full:s1', 'visibilityChanged']`.
  - `'windowRestored runs sessionShown for the window's own shown sessions before the full send'`. Window 1 owns `s1`. `shownIn(1)` also lists `s9`, owned by window 2. `sessionShown` is called with `['s1']`.
  - `'a git-dir watch on the home folder or a filesystem root is refused and logged once'`:
    - harness with `homeDir: '/home/u'`;
    - interrogate returns `commonDir: '/home/u'` for one repo and `'/'` for another;
    - the session is **shown** (so the test also holds after G-ENGINE's G3 gate);
    - two meta runs;
    - result: no fake watch for either dir, and exactly one warn per dir.
  - Existing `:146`, `:163` and `:275` stay green unchanged. Their repo is shared with a shown session, so no catch-up applies.
- [ ] Run, expect FAIL. Implement.

---

### Slice F: G-FOLDERS (T2): G1, hidden sessions hold no folder watch

**Check:** `npm run test:unit -- test/unit/session-folder-runtime.test.ts`, then `npm run verify:quick`.

**Claims:** `electron/session-folder-runtime.ts`, `test/unit/session-folder-runtime.test.ts`.

**Consumes (C1):** `deps.isWindowSuspended: (windowId: number) => boolean`, and `applied(diffs: readonly SessionDiff[])` with its `turnEnded` skip. Keep both.

**Rules:**
- `watchEntries` (main `:145-166`):
  - delete the `tracking` block (`:160-164`);
  - replace the comment `:157-159` with exactly `// Hidden sessions hold no watch (spec 2026-11-03-demand-driven-resources §3.2).`;
  - `projects` iterates only the `projectsByWindow` entries whose `!this.deps.isWindowSuspended(windowId)`.
- `reposUnderBroad(armed)` is unchanged; it now sees only shown sessions.
- `armsFor(sessionId)` (`:137-142`): `visibleSessionIds().includes(sessionId) || [...projectsByWindow].some(([w, p]) => p.sessionId === sessionId && !isWindowSuspended(w))`. Update its doc comment to "shown in a window".
- `recheck` uses `watchEntries`, so a hidden session is never asked to recheck. That is intended.

**Tests:**
- [ ] Failing tests:
  - **Invert** `:177` → `'onSuspect skips a hidden session even when it holds registered repos'`.
  - **Invert** `:206` → `'a hidden session with registered repos is not armed; reposChanged does not arm it'`.
  - **Invert** `:281` → `'a session in no window does not re-arm on foldersChanged, repos or not'`.
  - New `'a suspended window's requested project is released and re-armed by visibilityChanged after restore'`: the armed set drops `p` when `suspended.add(1)` + `visibilityChanged()`, and returns after `delete` + `visibilityChanged()`.
  - New (AC-12) `'with no visible sessions and no requested project, nothing is armed'`: last `setFolders` is `[]`.
- [ ] Run, expect FAIL. Implement.

---

### Slice D: G-DEMAND (T3): hidden before the first report (S2)

**Check:** `npm run test:unit -- test/unit/session-resource-demand.test.ts`, then `npm run verify:quick`.

**Claims:** `src/session-resource-demand.ts`, `test/unit/session-resource-demand.test.ts`.

**Consumes (C1):** `isSuspended(windowId: number): boolean`. Keep it.

**Rules:**
- Drop `!reported ||` at `:13`, `:35` and `:39`.
- `setVisible`'s `newlyVisible` (`:49`) becomes `ids.filter((id) => !visible(id))`.
- Delete `reported` (`:10`, `:50`); it is now unused.
- No other behaviour change.

**Tests:**
- [ ] Failing test `'before any window reports, nothing is visible or shown'`. With a fresh demand:
  - `isVisible('a') === false`;
  - `visibleIds()` is `[]`;
  - `isVisibleInWindow(1, 'a') === false`;
  - `isShownInWindow(1, 'a') === false`;
  - `schedule('a')` + 200 ms → `run` not called.
- [ ] Test `'the first report wakes exactly the reported ids'`: `setVisible(1, ['a'])` + 150 ms → `run` called once with `['a']`.
- [ ] Existing tests `:6–:92` stay green. If one relied on pre-report visibility, fix the test's setup, not the rule.

---

### Slice T: G-TURN (T3): `turnEnded` producer

**Check:** `npm run test:unit -- test/unit/app-session-store.test.ts`, then `npm run verify:quick`.

**Claims:** `electron/app-session-store.ts`, `test/unit/app-session-store.test.ts`.

**Consumes (C1):** `SessionTurnEndedDiff { sessionId: string; kind: 'turnEnded' }`, `SessionDiff = SessionFolderDiff | SessionTurnEndedDiff`, and `applyServer(views: SessionView[]): SessionDiff[]`.

**Rules:**
- In `applyServer`'s per-view loop (`:71-86`), for an existing `prev`, push `{ sessionId: v.id, kind: 'turnEnded' }` after any folder diff for that view, when either:
  - `(v.completions > prev.completions && v.runtime.reportedStatus !== null)`; or
  - `(prev.status === 'running' && v.status === 'exited')`.
- At most one `turnEnded` per view per call.
- Added views never emit one.
- A decrease emits nothing, and the next increase compares against the new, lower value. That needs no extra state, because `prev` is the last view.

**Tests:**
- [ ] Failing tests:
  - `'completions rising on a reporting program is one turnEnded'`.
  - `'completions rising with reportedStatus null emits nothing'` (the idle bucket).
  - `'running → exited emits turnEnded even without a report'`.
  - `'a server restart (completions 5 → 0) emits nothing; then 0 → 1 with a report emits one'`.
  - `'a new session emits added only'`.
  - `'a cwd change and a turn end in one list emit both diffs, folder diff first'`.
- [ ] Run, expect FAIL. Implement.

---

### Slice O: G-OPENFILES (T2): G4, the open-file watch follows shown sessions

**Check:** `npm run test:unit -- test/unit/open-file-watcher.test.ts test/unit/watched-files.test.ts`, then `npm run verify:quick`.

**Claims:** `electron/open-file-watcher.ts`, `test/unit/open-file-watcher.test.ts`,
`webview/watched-files.ts`, `test/unit/watched-files.test.ts`, `webview/app.tsx`.

**Consumes:** nothing new from C1. `visibleSessionIds(activeId, splitId)` from `src/attention.ts:30`, and `OpenDoc` from `webview/docs.ts:49-72`.

#### Task O.1: Watcher per-window union
**Rules:**
- New private state: `byWindow = new Map<number, readonly string[]>()` and `suspendedWindows = new Set<number>()`.
- `setWindowPaths`, `setWindowSuspended` and `dropWindow` each update that state, then call `this.setPaths(union)`. The union is the paths of non-suspended windows, deduped in first-seen order.
- `setPaths` stays as is. I1 makes it private.

**Tests:**
- [ ] Failing tests (with the existing `vi.mock('../../electron/watch-dir')`, recording opened and closed dirs):
  - `'two windows' sets are watched as a union'` (AC-11).
  - `'a window's later post replaces only its own set'`: no last-writer-wins.
  - `'a suspended window's paths are released and return on unsuspend'`.
  - `'dropWindow releases its paths but keeps a path another window also has'`.
- [ ] Run, expect FAIL. Implement.

#### Task O.2: Renderer
**Files:** Create `webview/watched-files.ts` with `shownFilePaths`. Its comment is the one-line pointer to spec §3.2 G4 / D10.

**Modify `webview/app.tsx:2201-2213`:**
- `openFilePathsKey = useMemo(() => shownFilePaths(docState.docs, visibleSessionIds(activeId, splitId)).join('\n'), [docState.docs, activeId, splitId])`.
- The effect posting `watchFiles` is unchanged.
- Update the comment above it to say "the shown sessions' file tabs".
- `visibleSessionIds` is already imported (`:15`).

**Tests:**
- [ ] Failing tests `test/unit/watched-files.test.ts`:
  - `'only file docs of shown sessions, deduped and sorted'`. Diff, review and web docs are excluded, and so is a hidden session's file doc.
  - `'empty when nothing is shown'`.
- [ ] Run, expect FAIL. Implement.

---

### Slice X: G-E2E (T2): scenario, stress and the AC-9 guard (authored in parallel; run at I1)

**Check (lane):**
- `npm run test:unit -- test/unit/attention-fs-free.test.ts` (green from the start; it is a guard);
- `npm run verify:quick`;
- `node --check test/e2e/demand-watch.e2e.mjs test/e2e/stress/hidden-sessions-idle.stress.mjs`.

The scenarios are **run by the lead at I1**, against the integrated tree.

**Claims:** `test/e2e/demand-watch.e2e.mjs`, `test/e2e/stress/hidden-sessions-idle.stress.mjs`,
`test/unit/attention-fs-free.test.ts`.

#### Task X.1: AC-9 guard
- `test/unit/attention-fs-free.test.ts` walks the relative-import graph from `server/attention/index.ts` (`join(__dirname, '..', '..', 'server', 'attention', 'index.ts')`). It resolves `.ts` and skips `import type` lines.
- It asserts that no reached module imports `node:fs`, `fs`, `node:child_process`, `child_process`, `chokidar`, or any path matching `/watch-dir|git-exec|project-watcher/`.
- `'the attention engine reaches no file-system or git module'`.

#### Task X.2: `test/e2e/demand-watch.e2e.mjs`
**Scaffold.** Use `runScenario('demand-watch', …)` with `tapBridge`, `openSession`, `revealSessionRow`, `openChangesTab`, `showRightView` and `assert` from `./harness.mjs`, and `report` from `./attention-footer-helpers.mjs`.

**Setup:**
- Make three temp git repos A, B and C with a seed commit, as `background-resources.e2e.mjs:8-23` does.
- Instrument main as `background-resources.e2e.mjs:24-49` does, keyed per repo: live `fs.watch` handles whose path is the repo or inside it, and `git` `execFile` calls whose `cwd` is the repo, with their args.
- Also subscribe in the page to `fsChanged` and `repoDelta` messages (`window.agentDeck.subscribe`).

**Switching.** Open sessions A, B and C (`shell:cmd`). Switch sessions **only by clicking the row** `[data-agent-tree] .session[data-sessionid="…"]` after `revealSessionRow`, so the renderer produces `visible`.

**Steps:**
1. Show A. Wait 1 s. Assert:
   - `handles(B) === 0` and `handles(C) === 0` (AC-1);
   - `handles(A) >= 1`.
2. Zero the counters. Modify `B/seed.txt` and write 2 new files. Wait 2 s. `git(B) === 0` (AC-2, AC-3).
3. In B, `report(page, B, 'working')`, then `report(page, B, 'done')`. Wait for `window.__sessions` to show B's `completions` incremented. Then, within 3 s:
   - **exactly one** `status` call for B;
   - `handles(B) === 0` still;
   - the session view for B carries `repoGit` for B's root with a branch and `dirty: true` (AC-4).
4. In hidden C, `typeLine` 10 `echo n` commands. Wait 3 s. `git(C) === 0` (AC-13).
5. Write `B/late.txt`. Click B's row and `openChangesTab`. Then:
   - the first full `repoDelta` for B carries `stale: true`, and `.repo-head__stale` is attached;
   - within 1.5 s a delta for B lists `late.txt` without `stale`, and `.repo-head__stale` detaches;
   - at least one `fsChanged` whose `folders` include B's root reached the page (AC-5).
6. Show A only. Minimize with the technique at `timed-messages-concurrency.e2e.mjs:329-338` (show then minimize, because a `show:false` window cannot iconify). Then:
   - within 1 s `handles(A) === 0` (AC-6);
   - write `A/while-min.txt`, wait 2 s: `git(A) === 0` and no `fsChanged` for A.

   Then `restore()` and immediately `hide()`, so no visible window remains:
   - within 2 s `git(A) >= 1` and `handles(A) >= 1`;
   - `showRightView(page, 'files')` shows `.filerow__name` `while-min.txt`.
7. Delete B's folder while B is hidden (A shown). Wait 2 s. `handles(B) === 0` and no new `fs.watch` call for B (AC-8 with G1).

**Exit:** only through the `runScenario` teardown.

#### Task X.3: `test/e2e/stress/hidden-sessions-idle.stress.mjs`
**Scaffold.** Use `runStress('hidden-sessions-idle', …)`, `emitReport` and `assertInvariant` (`harness-stress.mjs`), and `makeManyFiles` / `startWriters` / `installChangeObserver` / `readRefreshedAt` (`multi-repo-harness.mjs`).

**S-idle (spec §8):**
- Ten `shell:cmd` sessions, each homed in its own repo of 5 000 files. One is shown and nine are hidden.
- One hidden repo has a `tsconfig.json` + `a.ts` opened in an editor tab before it is hidden, for the G6 share.
- Three hidden repos are written at 20 files/s (`startWriters(dirs, { intervalMs: 50, durationMs: 120000 })`), outside `node_modules`.
- Then each reports `working` → `done` once.
- Sample at 1 Hz:
  - M1: live `fs.watch` handles, total and per repo;
  - M2: git calls per repo;
  - M3: `app.getAppMetrics()` `type === 'Browser'` `cpu.percentCPUUsage`;
  - M4: `process.memoryUsage().rss` at the end;
  - M6: from `done` to the page `state` carrying the new `repoGit`.

**S-show:** three more hidden sessions with repos of 1 000, 10 000 and 100 000 files, shown in turn. M5 is show → `refreshedAt > shownAt` for every repo of the session.

**Invariants (exit 1):**
- the hidden repos' handles are 0 throughout, excluding the G6 LSP root, which is reported separately;
- the hidden repos' git calls during the write window are 0;
- after `done`, each written repo has ≤ 2 git `status` calls in the 12 s window.

**Advisory:** the timings (M3–M6).

---

### Slice I1: Integration (lead, serial, after all lanes merge by reviewed SHA)

**Check:**
- `npm run test:unit -- test/unit/demand-resources.test.ts`, then `npm run verify` (the full gate);
- `npm run e2e -- demand-watch` (one local scenario);
- `npm run e2e:remote -- demand-watch background-resources changes-multi-repo changes-line-demand timed-messages-concurrency sidebar-done-seen files-follow-tab`, then `npm run e2e:remote -- --full` once.

**Claims:** `electron/main.ts`, `CHANGELOG.md`, `test/unit/demand-resources.test.ts`,
`electron/open-file-watcher.ts` (post-merge), `docs/runs/2026-11-03-demand-resources/report.md`.

#### Task I1.1: G2 and show wiring in `electron/main.ts`
1. **Demand `run` callback** (`:1296-1331`):
   - First statement: `folders.visibilityChanged();`.
   - Replace the `stale`-only replay (`:1305-1312`): for each window, send one `fsChanged` with `root: shown[0]` and `folders: [...new Set(shown)]` when `shown` is non-empty, and delete those roots from `pendingFsByWindow`.
   - `repoTrackerHost.tracker.visibilityChanged()` stays last.
2. **Demand `onHidden` callback** (`:1332-1337`): after the loop, `folders.visibilityChanged(); repoTrackerHost.tracker.visibilityChanged();`.
3. **`case 'visible'`** (`:3453-3467`), reordered to:
   1. `presence.setVisible`;
   2. `schedulePresence()`;
   3. `gitDemand.setVisible(senderId, ownIds)`;
   4. `folders.visibilityChanged()`;
   5. `repoTrackerHost.windowShown(senderId, ownIds)`;
   6. the deferred-scan loop.

   The old `folders.visibilityChanged()` at `:3465` moves to step 4.
4. **Minimize** (`:4610-4613`): add `openFileWatcher.setWindowSuspended(w.id, true)`.
5. **Restore** (`:4614-4618`), in this order:
   1. `gitDemand.setSuspended(w.id, false)`;
   2. `folders.visibilityChanged()`;
   3. `openFileWatcher.setWindowSuspended(w.id, false)`;
   4. `repoTrackerHost.windowRestored(w.id)`;
   5. `lspManager.setWindowMinimized(wcId, false)`.
6. **`onClosed`** (`:4581-4600`): add `openFileWatcher.dropWindow(windowId)`.
7. **`case 'watchFiles'`** (`:2898-2904`): `openFileWatcher.setWindowPaths(senderId, m.paths)`.
8. **`electron/open-file-watcher.ts`:** `setPaths` becomes `private`. Its only external caller was `main.ts:2902`.

#### Task I1.2: Cross-module test `test/unit/demand-resources.test.ts`
Build a real `createSessionResourceDemand` (fake timers), a real `createRepoTrackerHost` with
`trackerDeps` fakes (as in `test/unit/repo-tracker-host.test.ts:26-128`), and wire the demand's
`run` / `onHidden` to `tracker.visibilityChanged`, as `main.ts` now does.
- [ ] `'hidden from start: no git until shown; the first visible runs the catch-up after a stale full send'`. Registers repos before any report. Only the D3 interrogate runs, with 0 `readChanges`. `setVisible` + `windowShown` gives a full delta with `stale: true`, then one `readChanges` within 50 ms.
- [ ] `'turn end while hidden refreshes once with lines:false and publishes git without opening the session'`.
- [ ] `'minimize then restore: no run while minimized; restore marks, sends full stale, runs once'`.

#### Task I1.3: Changelog and runs
- `CHANGELOG.md` `[Unreleased]`, under `### Changed`: **"Sessions you aren't looking at no longer watch their folders or run git."** Their branch and change count update when the agent finishes a turn. Opening one shows its last state and catches up in about a second.
- Stress, locally on an idle machine, serially (memory: no fan-out):
  1. "Before": run `node test/e2e/stress/run-stress.mjs hidden-sessions` on the G-E2E lane's tree (C1 plus the test files, so it has the old behaviour).
  2. "After": run it again on the integrated tree.
- Write `docs/runs/2026-11-03-demand-resources/report.md`. It contains:
  - M1–M6 before and after;
  - G6's share;
  - the list of agent CLIs observed reporting OSC 7501 (D12).

## Verification
| When | What |
|---|---|
| Per lane task | the lane's `npm run test:unit -- <files>`; then `npm run verify:quick` |
| Lane done | lane check green; review by a different harness before merge (multi-agent loop); merge by reviewed SHA |
| After C1 | `npm run verify` (pre-commit), committed before lanes are dispatched |
| I1 | `npm run verify`; `npm run e2e -- demand-watch` locally (one scenario only); `npm run e2e:remote` with the named scenarios; then `--full` once; stress locally |

Acceptance mapping:

| AC | Unit coverage | E2E / stress coverage |
|---|---|---|
| AC-1 | F inversions, E.2 G3 | X.2 steps 1, 3, 6; stress M1 |
| AC-2 | E.2, E.3 | X.2 steps 2–4; stress M2 |
| AC-3 | E.2 | X.2 step 2 |
| AC-4 | E.1, E.3, T, I1.2 | X.2 step 3; M6 |
| AC-5 | E.3, H, I1.2 | X.2 step 5; M5 |
| AC-6 | F, H, I1.2 | X.2 step 6 |
| AC-7 | E.2 | n/a |
| AC-8 | existing `project-watcher.test.ts` + F | X.2 step 7 |
| AC-9 | X.1 | n/a |
| AC-10 | H for W2; lane F's `watch-scope.test.ts`, `project-watcher.test.ts`, `lsp-watcher.test.ts` for W1 and W3 | n/a |
| AC-11 | O.1 | n/a |
| AC-12 | D, F | I1.2 |
| AC-13 | T idle bucket | X.2 step 4 |

## Deviation rule
If a task's assumption turns out wrong (a cited line moved, a pinned signature doesn't fit, an
existing test encodes a rule this plan didn't list), that task **stops**, and fixing the misaligned
piece becomes the work. That rules out:
- a shim, a second copy, a special case or a widened type;
- an optional parameter added to dodge a call site;
- a lane editing another lane's or the lead's claimed file.

A lane that needs a contract change reports to the lead, who amends C1 for every lane. The report
leads with the fix that keeps the locked decision.

## Decisions Needed
- [normal] **#1 AC-10 wording vs lane F.**
  - The spec says refuse and log once at all three sites. Main already downgrades W1 and W3 to a
    top-level watch (9fdf8b40), without a refusal log.
  - Default taken: keep lane F's semantics for W1 and W3 (never recursive, which is the decided
    direction), and refuse plus log once at W2 only.
  - Flip it only if a user-visible log per refused root is wanted.
- [normal] **#2 D3 meta-only.**
  - Default taken: a hidden repo's startup fill and any `meta`-only run that **started** unshown
    skip `readChanges`. Shown repos keep today's "meta implies status" behaviour.
  - The alternative (always status) costs one `status --untracked-files=all` per hidden repo at
    launch.

## Self-review
#1 Coverage: ok. AC-1–13, G1–G6, S1–S6, D1–D12, §3.5 order and §6 scope each map to a slice (table above).
#2 Placeholder scan: ok. Errors, logs, test names and key assertions are named; the e2e selectors come from existing scenarios.
#3 Signature consistency: ok. `sessionShown(sessionIds: readonly string[])`, `sessionTurnEnded(sessionId: string)`, `SessionDiff`, `isSuspended(windowId: number)`, `isWindowSuspended: (windowId: number) => boolean` and `setWindowPaths(windowId: number, paths: readonly string[])` are identical in Contracts, the slices and I1.
#4 Placement: ok. Two new source files: `webview/watched-files.ts` (sibling of `webview/docs.ts`) and the tests under `test/unit` / `test/e2e`. Every path is in the file map.
#5 Caller scan: fixed. `BACKGROUND_COOLDOWN_MS`, `MarkOptions.background` and the `OpenFileWatcher` methods moved out of C1 into the groups that first use them, so no C1 export lacks a caller (fallow gate). The C1 tracker shells have callers in C1 (`main.ts`) and G-HOST.
#6 Producer/consumer: ok. Every row names both sides; one-sided rows give the measured reason.
#7 Handoff arithmetic: ok. Nine slices (C1, E, H, F, D, T, O, X, I1); seven parallel groups; the claims below are counted from the slice headers.
