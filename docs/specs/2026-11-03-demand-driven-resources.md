---
status: active
date: 2026-11-03
tier: FULL
---

# Feature Spec: Demand-driven resources (watchers and git follow what is on screen)

**Tier:** FULL   **Feature type:** host resource lifecycle (main process), no new UI
**Supersedes:** multi-repo-tracking §2 "background subscribers… hidden too" (`electron/session-folder-runtime.ts:138-140` cites it). That rule kept hidden sessions watched; this spec drops it.
**Related:** ADR 0007 (three processes), `2026-10-16-multi-repo-tracking.md` (repo engine), `archive/2026-10-08-language-coverage.md` §2.6 (LSP residency), memory audits `.autoloop/mem-*.md`.

## 1. Problem and scope

The app is turning into a set of views: a terminal view attaches to a PTY the server holds, and an editor view attaches to a file. Files, Changes/Review and git work don't follow that yet. A session nobody is looking at still holds recursive OS watches, and those watches keep feeding the repo engine. With N background agents writing, the main process pays for N file trees that nothing renders.

**Direction (decided by the user):** if no view is attached, there is nothing to watch.
- A hidden session holds **no file watch and runs no git**.
- Its git state refreshes **once each time its agent finishes a turn**.
- Showing it runs **one short catch-up** (git status of its repos, file-tree re-read).
- A minimized window counts as hidden.
- Home directories and drive roots are never watched recursively. A parallel fix lane is adding that guard in `electron/session-folder-runtime.ts`. This spec calls the guard; it does not redesign it.

**Phasing (decided):**
- **Phase 1 (this MVP):** inside today's architecture, so watchers stay in the app's main process. One shared, ref-counted watch service gives one OS watch per folder. Its subscribers are on-screen surfaces. A watch is released when it has no subscribers.
- **Phase 2:** the watch and git service moves into the Conduit server, so the app is purely a view. Named and scoped in §9, not designed.

Evidence convention: **(code)** = read in this tree at the cited `file:line`. **ASSUMED** = not verified. Nothing in this spec was executed. §8 is the measurement plan.

## 2. Current behaviour (inventory)

### 2.1 Every watch creation site

`watchDir` / `watchDirWhilePresent` live in `electron/watch-dir.ts:49,91`. A missing dir is polled every 2 s (`:16,114-119`).

| # | Watch | Created at (code) | Scope / lifetime today | Hidden session today |
|---|---|---|---|---|
| W1 | **ProjectWatcher**: recursive, one per root folder; nested folders fold into an ancestor | `electron/project-watcher.ts:74,100`; built at `electron/main.ts:1775` | Folder set = `SessionFolderRuntime.watchEntries()` (`electron/session-folder-runtime.ts:127-149`), made of three parts: each window's requested project (`:128-133`, kept even while the window is minimized); visible sessions (`:134-137`); **every session with registered repos, visible or not** (`:141-147`) | **Watched** if it has repos (nearly every session) |
| W2 | **Repo-tracker git-dir watch**: recursive on a repo's common `.git` when no W1 watch covers it | `src/repo-tracker.ts:161-178` → `electron/repo-tracker-host.ts:107-123` | Every registered repo, with **no visibility check** (`repo-tracker.ts:164-165`) | **Watched** when outside the session's folders (worktrees whose main `.git` is elsewhere) |
| W3 | **LSP root watch**: recursive, per language-server root | `electron/lsp-watcher.ts:89`; armed at `electron/lsp-manager.ts:911-922` | Lives as long as the server process: closed on stop or crash (`lsp-manager.ts:258,981,1021`). A hidden server lives up to `DORMANT_MS` = 10 min, or until evicted 60 s after it is hidden when over the cap (`src/lsp-residency.ts:6-9,33-39`) | Watched while its server is resident. This is a **second** OS watch on the same root as W1 |
| W4 | **OpenFileWatcher**: non-recursive watch on each open file's parent dir | `electron/open-file-watcher.ts:61-94` | Paths = **every** file tab in the window, across all sessions (`webview/app.tsx:2180-2189`). `setPaths` **replaces** the global set (`:58-61`) and is called once per sender window (`electron/main.ts:2898-2903`), so with two windows the last one to post wins. That is a multi-window bug: the other window's open files go unwatched (code; runtime impact ASSUMED) | Watched (hidden session's tabs included) |
| W5 | **PlanWatcher**: `.conduit/plans/`, one per opened project | `electron/main.ts:1736-1742`, `electron/plan-watcher.ts:68-72` via `ConduitDirWatch` (`electron/conduit-dir-watch.ts:52`) | Reconciled against session homes. Dropped when a project's last session goes (`main.ts:2251-2259`) | Watched (non-recursive, small) |
| W6 | **Board / Proposal / Notes** watchers | `main.ts:3673` (board), `:2107` (proposal), `:3140` (notes) | One active project or root at a time | n/a (already follows demand) |

### 2.2 Git, scans and indexes

| Flow | Today (code) | Hidden session today |
|---|---|---|
| Repo engine runs (`git status`, `interrogateGit`) | A run happens only if some session of the repo is visible: the scheduler's `eligible` check (`src/repo-tracker.ts:123-128`). The window-focus sweep covers visible sessions only (`:392-400`) | **No git**. Watch events (W1/W2) still **mark** the repo pending and wake the scheduler; it holds the marks until the session is visible (`:134-139`). So CPU goes to event handling and classification (`:276-286`) with no result |
| Coverage catch-up | Regaining W1 coverage marks `tree` and invalidates the file index (`repo-tracker.ts:371-375,380`). Losing coverage marks `tree,meta` (`:376`) | n/a today (always covered) |
| Snapshot fan-out | `publish` → `mergeRepoGit` updates `Session.repoGit` for **all** sessions of the repo (`repo-tracker-host.ts:86-95`). `repoDelta` goes only to windows showing the session (`:79-83`). Show → `sendFull` from cache (`:146-156,164-170`) | Cache holds the last snapshot. Its `stale` flag is set while marks are pending (`repo-tracker.ts:180-181`) |
| Repo (re)scan | Deferred for a hidden session that already has repos (`main.ts:1415-1419`). Run on show (`:1296-1297,1466`) | Deferred |
| `fsChanged` to the renderer | Held in `pendingFsByWindow` for windows not showing the session (`main.ts:1748-1768`). Replayed on show (`:1299-1312`) | Held |
| Quick-open file index | `tracker.onDirty` invalidates on **every** watched path, "not gated on visibility" (`repo-tracker.ts:74-76`, `main.ts:1371-1375`) | Invalidated by hidden writes |
| TS source index | `indexProject` deferred when no owner is visible (`main.ts:3567-3585`) | Deferred |
| Project request (arm + rescan) | An auto request is deferred when the session is hidden (`main.ts:2112-2127`) | Deferred |
| Open editor tabs | Re-read when a tab becomes visible (`webview/app.tsx:2244-2253`) and on focus or visibility (`:2422-2447`). Diff tabs re-read when their session becomes active (`:2472-2474`) | Catch-up already exists |

### 2.3 How "visible" is known

- The renderer posts `visible` with its active and split session ids (`webview/app.tsx:1793-1797`).
- Main forwards it to presence for the server (`main.ts:3454-3456`, `ui.presence` `:2185-2200`) and to `gitDemand.setVisible` (`:3458-3463`). It also calls `folders.visibilityChanged()` (`:3465`).
- `src/session-resource-demand.ts` is the union across windows: a session is visible iff some window that isn't suspended lists it (`:12-15`). Before the first report everything counts as visible (`:13`).
- **Minimize** suspends the window (`main.ts:4610-4618`); LSP gets the same signal (`lsp-manager.ts:238-244`).
- Conduit never calls `BrowserWindow.hide()` (grep of `electron/main.ts`). E2E windows are created with `show:false` (`main.ts:994`) and never minimize, so they count as visible. An occluded window also counts as visible.

### 2.4 Turn-end signal (exists)

- The server's `ServerAttention` increments `completions[sessionId]` once per run end (code):
  - a reported OSC 7501 status going `working → done|idle` (`server/attention/index.ts:212-220`);
  - or, for programs that don't report, a heuristic run-end in `sweep` (`:131-141`).
- The count increases monotonically while one server runs and resets on server restart (`docs/specs/2026-11-02-sidebar-agent-tree.md` §4, line 53).
- It reaches the app on each `SessionView` as `Session.completions` (`src/types.ts:113-114`). The app reads it in `AppSessionStore.applyServer` (`electron/app-session-store.ts:68`) and then in `sessionsApplied` (`main.ts:2270`, `folders.applied` at `:2295`).
- **Attention does not depend on file watching.** `server/attention/index.ts` imports only terminal-runtime, last-line, session-activity and terminal-output (`:1-14`), and its inputs are runtime events (`:145-156`). This spec must not add a file-system input to it.

### 2.5 Memory-audit cross-refs

- `mem-main-server` #2: recursive watches include `node_modules`, and the filter runs only in the JS callback. That is event floods (W1, W3).
- `mem-main-server` #5: snapshots are kept for every repo of every session.
- `mem-main-server` #6: recursive watches on hidden sessions (W1, `:120-152`).

This spec fixes #6, makes #2 scale with what is shown, and leaves #5 to D9. Renderer memory (xterm rings, TS index, the `files`/`diffs` maps) is out of scope; the mem lanes own it.

## 3. Target model (Phase 1)

### 3.1 Demand

**Shown(session)** ≡ `gitDemand.isVisible(id)` (`src/session-resource-demand.ts:12`): listed by at least one window that isn't minimized. This is the single source for every consumer below. "Hidden" is the opposite. No new visibility notion is added.

### 3.2 One shared watch service

New `src/watch-service.ts`, a pure core. Its `open` function is injected; the main process supplies `watchDir`/`watchDirWhilePresent`. There are no Electron imports (needed for Phase 2).

```ts
export type WatchEvent =
  | { kind: 'path'; event: 'rename' | 'change'; rel: string } // relative to the SUBSCRIBED dir
  | { kind: 'rescan' }; // events may have been lost: re-read everything under the dir
export interface WatchRequest {
  dir: string;
  recursive: boolean;
  owner: WatchOwner;
  /** Re-arm across delete/recreate (watchDirWhilePresent semantics); else gone is final. */
  whilePresent?: boolean;
}
export type WatchOwner = 'session-folders' | 'git-dir' | 'lsp' | 'open-files' | 'conduit-dir';
export interface WatchService {
  subscribe(req: WatchRequest, onEvent: (e: WatchEvent) => void, onGone?: (err?: Error) => void): { close(): void };
  stats(): { osWatches: number; subscriptions: number; byOwner: Record<WatchOwner, number> };
  stop(): void;
}
```

Rules:
1. **One OS watch per folder.** Key = `folderKey(dir)`. A recursive watch on an ancestor serves every subscriber below it, recursive or not:
   - `rel` is rewritten relative to the subscriber's dir;
   - events outside that dir are dropped;
   - a non-recursive subscriber gets only depth-1 entries.

   This uses the same ancestor folding as `project-watcher.ts:74`.
2. **Ref-counted release.** When a key's last subscriber closes, its OS watch closes after `RELEASE_GRACE_MS` (default 5 s, D4), so a quick A→B→A switch or a move between windows doesn't churn handles.
   - If the covering ancestor goes away, the descendants each get their own OS watch and receive one `rescan`. Events may have fallen into the gap.
   - A new covering ancestor absorbs descendants silently.
3. **Filtering stays with the subscriber.** The service delivers raw names. `shouldIgnoreWatchPath` and the LSP globs keep running where they run today (`project-watcher.ts:154`, `lsp-watcher.ts:94`).
4. **Gone / deleted** (the CLAUDE.md `watchDir` hazard). `watchDir` already closes the handle on the self-`rename` loop (`watch-dir.ts:36-41,67-77`). The service fans that one `gone` out to every subscriber of the key, exactly once.
   - `whilePresent` subscribers get the existing 2 s exists-poll. It runs **only while subscribed**.
   - When no subscriber is left there is no poll and no handle.
5. **Refusal.** Any recursive request for a home directory or drive root is refused centrally, using the predicate from the parallel guard lane (`electron/session-folder-runtime.ts` on that branch; name ASSUMED). The refusal surfaces as `onGone(err)` with a logged reason, once per key. This one gate covers every owner, including an LSP root that resolves to home.
6. **Inspectable.** `stats()` is logged once a minute at debug level and exposed through the e2e hooks. §8 needs it.

### 3.3 Subscribers (who holds what)

| Consumer | Phase 1 subscription | When hidden | Replaced by |
|---|---|---|---|
| Files tree, Changes/Review, git decorations (W1) | `SessionFolderRuntime` subscribes `watchFoldersFor(home, s)` (`src/session-folders.ts:11-14`) for **shown sessions only**. A window's requested project counts only while that window isn't minimized. The `tracking` block (`session-folder-runtime.ts:138-147`) is **deleted** | Nothing held | Turn-end refresh (§3.4) and catch-up on show (§3.5) |
| Repo engine git-dir (W2) | Only for repos with ≥1 shown session, and only when W1 doesn't cover them | Nothing held. Today's `reconcileWatches` would **open** a git-dir watch exactly when a hidden session loses W1 coverage. That must be gated, or Phase 1 trades one watch for another | Same as above |
| Repo engine runs | Unchanged: still only for shown sessions (`repo-tracker.ts:125-128`) | No git, **and no marks** (no watch means no events) | Turn-end refresh; catch-up |
| Quick-open index (`onDirty`) | Fed by shown sessions' watches | Not invalidated | Coverage regain already invalidates (`repo-tracker.ts:373-375,380`). Turn-end invalidates the session's repos |
| Open editor tabs (W4) | Per-window sets, unioned by the host (fixes last-writer-wins). Each window reports the file tabs of the **sessions it shows** (D10). A minimized window's set is dropped | Not watched | The existing re-read when a tab becomes visible, on focus or on visibility (`app.tsx:2244-2253,2422-2447`) |
| LSP (W3) | `watchServerRoot` subscribes through the service. It shares W1's handle when both exist | Kept while the server process is resident: ≤ 10 min hidden, or evicted earlier over the cap (D6) | n/a. The server dies with its watch |
| Plans / board / proposal / notes (W5, W6) | Through the service (owner `conduit-dir`). Demand unchanged (D7) | W5 kept for open projects (non-recursive, tiny) | n/a |

### 3.4 Turn-end refresh (hidden sessions)

- **Producer.** The app's server-list apply. In `sessionsApplied` (`main.ts:2270`), compare each session's `completions` with the last value seen.
  - An **increase** is a turn end.
  - A decrease (server restart) only resets the baseline and is never an edge.
  - A transition into `exited` also counts as a turn end.
  - The edge is ignored when the session is shown: its live watch already covers it.
- **Consumer.** New `RepoTracker.sessionTurnEnded(sessionId)`. For each repo of the session that has **no shown session**:
  - mark `meta` + `tree` with a new `MarkOptions.background: true`;
  - the scheduler treats a background mark as eligible exactly once, ignoring `eligible()`, at priority behind every shown repo (`FOCUS_PRIORITY + 1`);
  - `lines:false` holds, because nobody shows line counts;
  - call `notifyDirty(repo.key)`.

  The run then follows the normal path. `publish` → `mergeRepoGit` updates `Session.repoGit`, so the sidebar branch and session-icon `review` (`src/session-icon.ts:14,45`) update through the existing `state` broadcast. The snapshot lands in the cache for the next `sendFull`.
- **Coalescing.** At most one background run per repo per `BACKGROUND_MIN_INTERVAL_MS` (default 10 s, D5), with a guaranteed trailing run. A repo shared by several hidden sessions runs once (the engine is already keyed by repo). The engine-wide `REFRESH_CONCURRENCY` = 4 and the 10 s git timeout (`src/repo-refresh-scheduler.ts:10`, `src/git-exec.ts:7`) both still apply.
- **Not at turn end:** no repo rescan (D2), no file-tree work, no source index.

### 3.5 Catch-up on show

Showing a session runs one bounded pass:
1. Its W1 subscriptions arm. The tracker sees coverage regained.
2. Each repo of the session that had no shown session gets **one** `meta` + `tree` mark at `immediate`, ordered like the first fill (`repo-tracker.ts:257-274`): home and attached repos first, then nested repos by index mtime. Today coverage regain marks `tree` only (`:373-375`); it becomes `tree,meta` when the repo was hidden, because a branch switch could have happened (D8 may skip this).
3. The existing show work runs as today: deferred repo scans, deferred project requests, deferred indexes, and the `pendingFsByWindow` replay (`main.ts:1295-1330,1466`).
4. **New:** one `fsChanged` for the session's present roots goes to the showing window, so FilesView re-reads the directories it has loaded. Whether it re-reads only expanded directories is ASSUMED; the e2e in §8 verifies it.
5. Open file and diff tabs re-read through the existing renderer paths (§2.2, last row).

**What the user sees:**
- Changes/Review renders the cached snapshot **immediately** (`sendFull`, `repo-tracker-host.ts:146-156`) with `stale: true` while the catch-up is pending (`repo-tracker.ts:180-181`). The existing stale label in Changes (`webview/components/changes-view.tsx:334`) shows it.
- There is no new spinner and no empty flash.
- Targets: fresh in ≤ 500 ms p50 and ≤ 1.5 s p95 for a 10k-file repo.
- Hard bound: the 10 s git timeout per repo. After that comes the existing error state with Retry (`repo:refresh`, `main.ts:3471-3473`).
- If the agent finished before the show, the turn-end refresh has already filled the cache, so the catch-up only confirms it.

### 3.6 States and transitions (per session)

`shown` ⇄ `hidden`. A watch is held only in `shown`. Within `shown`, a session is `live` (watch armed) or `catching-up` (pending marks after a show). Within `hidden`, it is `quiet` or `refreshing` (a background run in flight).

| Transition | Effect |
|---|---|
| shown → hidden (tab switch, close split, minimize, move to another window that's minimized) | Subscriptions close. The OS watch is released after grace unless another shown session covers it. Pending marks are kept (the scheduler holds them) |
| hidden → shown | §3.5 catch-up |
| Window minimize / restore | `setSuspended` (`main.ts:4610-4618`) applies the same as above to every session that window alone shows. Restore → `windowRestored` re-sends full snapshots (`repo-tracker-host.ts:168-170`) plus §3.5 |
| Same session shown in two windows | Visible iff either window isn't minimized (union, `session-resource-demand.ts:12-15`). One subscription per session, not per window, so there are no double watches. Hiding it in one window changes nothing |
| Agent finishes a turn while hidden | §3.4 |
| Agent starts a turn while hidden | Nothing (no work at turn start) |
| Session closed | `forgetSession` (`main.ts:2251-2267`) also closes its subscriptions. The repo is dropped when its last session goes (`repo-tracker.ts:316-326`) |
| Repo appears while hidden (agent runs `git init` or `worktree add`) | Not seen until show, where the deferred rescan runs (D2) |
| Repo disappears while hidden | The turn-end or catch-up run fails into the repo's existing error state. The rescan on show drops it |
| Folder deleted while watched | Rule 3.2-4: one `gone` per subscriber. `SessionFolderRuntime.suspect` notifies the server (`session-folder-runtime.ts:168-189`). A whilePresent subscriber polls at 2 s only while subscribed |
| Folder deleted while hidden | Nothing is watched, so nothing loops. The server's own health checks or the show-time check see it (ASSUMED as today) |
| App start | Restored shown sessions arm as today. Hidden sessions get no watch. Branch chips for hidden sessions: D3 |
| Server restart (completions reset) | Baseline reset; no burst |

## 4. Edge cases

- **Huge repos (≥100k files).**
  - The catch-up costs one `git status --porcelain -z --untracked-files=all` (`src/project-info.ts:163`), capped at 10 s and 8 MB of output (`:37`).
  - The concurrency cap of 4 and the ordering in §3.5 keep the home repo first.
  - At turn end the cost is the same `status` without numstat.
  - A repo that times out keeps its last good snapshot with an error (`repo-tracker.ts:225-229`). It is retried only on the next edge or show; it never loops.
- **Nested repos.** One W1 watch on the ancestor serves them all, as today. The catch-up marks each nested repo once.
- **Worktrees.**
  - A W2 git-dir watch is held only while a shown session needs the main `.git` and no W1 covers it.
  - A turn-end refresh in one worktree session also refreshes the other hidden worktrees of the same main repo only if they share the session. Others wait for their own edge or show.
- **Network drives.** A recursive `fs.watch` there may fail or drop events silently (ASSUMED). A failure is `gone` → lost → today's focus-refresh fallback (`project-watcher.ts:114`). Turn-end and catch-up need no watch, so a network-drive session that is hidden is unaffected.
- **LSP that needs workspace watching.** Servers keep `didChangeWatchedFiles` for as long as they live (D6). Without that, a resident server's index rots while its session is hidden. Dropping the watch would force a server restart on show.
- **Linux/macOS recursive watch cost.** Node emulates recursion there by walking the tree, so the cost of re-arming is O(dirs) (ASSUMED). The grace period limits churn. Windows (`ReadDirectoryChangesW`) is the primary target. CI is ubuntu, so unit tests inject `open`.
- **Many short turns.** An agent with sub-10-s turns gets one background run per 10 s plus a trailing run, not one per turn.
- **Agent writes inside a shown session's tree from a hidden session** (a shared repo). The shown session's watch catches the writes, and the repo runs because a shown session tracks it. That is correct and costs nothing extra.

## 5. Producer / consumer contract (changed flows)

| Flow | Producer | Consumer | Change |
|---|---|---|---|
| Sidebar branch, session-icon `review` | `RepoTracker.publish` → `mergeRepoGit` (`repo-tracker-host.ts:86-95`) | `state` broadcast → `src/agent-tree.ts:264-267`, `src/session-icon.ts` | A hidden session updates at turn end instead of never (today: no runs while hidden) |
| Changes / Review lists, header Changes badge | `repoDelta` (`repo-tracker-host.ts:72-84,146-156`) | `changes-view.tsx`, `review-view.tsx` | Shown: unchanged. On show: cache, then one catch-up |
| Status bar branch | Active session's `repoGit` | `webview/components/status-bar.tsx:37-40` | The active session is always shown, so nothing changes |
| Files tree | `fsChanged` (`main.ts:1748-1768`) | FilesView | Hidden: none. Show: one catch-up `fsChanged` |
| Open file tabs | `fileChanged` (`main.ts:1895`) | `app.tsx` | Per-window union; shown sessions only |
| Quick open | `fileIndexChanged` (`main.ts:1362-1375`) | Palette | Hidden writes no longer invalidate; coverage regain and turn end do |
| Attention / "needs you" / Done | `ServerAttention` (PTY + OSC 7501) | Sidebar | **Unchanged and must stay file-system-free** (AC-9) |
| Turn-end edge | `Session.completions` via `applyServer` | `RepoTracker.sessionTurnEnded` | New |

## 6. Scope

**MVP (Phase 1):**
- `src/watch-service.ts` and its host wiring.
- W1 to W5 moved onto the service; the `tracking` block deleted.
- W2 gated on shown sessions.
- `watchFiles` per window with shown-session scope.
- `MarkOptions.background` and `sessionTurnEnded`.
- Turn-end detection in `sessionsApplied`.
- Show catch-up: `meta,tree` for repos that were hidden, plus the `fsChanged` replay.
- `stats()`.
- Unit tests:
  - service: folding, grace, gone fan-out, refusal, rescan on handoff;
  - tracker: background mark, coalescing, no marks while hidden;
  - `session-folder-runtime`: invert the tests at `test/unit/session-folder-runtime.test.ts:169,198`.
- e2e `test/e2e/demand-watch.e2e.mjs`, using the OSC 7501 helper from `test/e2e/sidebar-done-seen.e2e.mjs`.
- Stress `test/e2e/stress/hidden-sessions-idle.stress.mjs`.
- A `CHANGELOG.md` line.

**Phase 2 (named, not designed):** see §9.

**Out of scope:**
- Renderer memory for hidden sessions: mounted xterms with a 10k-line scrollback, the TS index, the `files`/`diffs`/commit caches (`mem-unbounded` #1-4, `mem-renderer`). The mem lanes own these.
- The web-tab guests of the shown session.
- Moving anything into the server.
- New UI.
- Tracked/paused repo controls (multi-repo-tracking).

## 7. Acceptance criteria

**EARS**

- **AC-1:** While a session is hidden, the host shall hold no OS watch whose only subscribers belong to that session.
- **AC-2:** While a session is hidden, the host shall spawn no git for its repos, except a background run triggered by AC-4 or an explicit Retry.
- **AC-3:** While every session is hidden and agents write files, the repo engine shall record no marks and invalidate no file index for those sessions' repos.
- **AC-4:** When a hidden session's `completions` increases or its process exits, the host shall refresh each of its repos that has no shown session once, without line counts, within 2 s plus git time. It shall run at most one such refresh per repo per 10 s, with a trailing one.
- **AC-5:** When a session becomes shown, the host shall send its cached snapshots immediately, marked stale where pending. It shall then run one `meta`+`tree` refresh per repo that was hidden and send one `fsChanged` for its roots.
- **AC-6:** When a window is minimized, the host shall treat the sessions shown only in that window as hidden. When it is restored, it shall treat them as just shown (AC-5).
- **AC-7:** When two subscribers ask for the same folder, or one asks for a descendant of a watched folder, the host shall keep exactly one OS watch for them.
- **AC-8:** When a watched folder is deleted, the host shall close its OS watch and notify each subscriber once. It shall not re-poll for that folder after its last subscriber is gone.
- **AC-9:** The server's attention (needs-you, done, completions) shall produce the same results with every watch disabled.
- **AC-10:** If a recursive watch is requested for a home directory or drive root, the host shall refuse it and log the refusal once.
- **AC-11:** When two windows report open files, the host shall watch the union of both sets.
- **AC-12:** While a language server is resident, its root shall stay subscribed. When it stops, the subscription shall be released.

**Gherkin**

```gherkin
Scenario: Hidden agent finishes a turn
  Given sessions A (shown) and B (hidden) each own a git repo
  And B's agent edits 3 files and reports OSC 7501 working then done
  Then no OS watch is held for B's folder
  And exactly one git status ran for B's repo after the done report
  And B's sidebar row shows its branch and the Review state without B being opened

Scenario: Catch-up on show
  Given B is hidden and its agent wrote files without finishing a turn
  When the user opens B
  Then the Changes list renders the cached snapshot at once, labelled stale
  And within 1.5 s it shows the new files and the stale label clears

Scenario: Minimize hides
  Given window W shows only session A
  When W is minimized and A's agent writes a file
  Then no fsChanged, mark or git run happens for A
  When W is restored
  Then A runs one catch-up and its Files tree shows the new file

Scenario: Two windows, one session
  Given windows W1 and W2 both show session A and W1 is minimized
  Then A stays shown and holds one subscription, not two
```

## 8. Measurement plan (before vs after on the same build flags)

**Scenario S-idle.**
- 10 sessions. Each home is a repo with 5k tracked files.
- 1 session shown, 9 hidden.
- In 3 of the hidden sessions, a script writes 20 files/s outside `node_modules` for 120 s. That is the agent-like load, with no turn end.
- Then each of those 3 emits OSC 7501 working→done once.

Scenario S-show: open each hidden session in turn, at repo sizes 1k, 10k and 100k files.

| Metric | How | Target (after) |
|---|---|---|
| M1 OS watch handles | `watchService.stats().osWatches` via the e2e hook; cross-checked with `process.getActiveResourcesInfo()` counting `FSEventWrap` (ASSUMED name) | Independent of hidden-session count: ≤ shown folders + shown open-file dirs + live LSP roots + `.conduit` dirs |
| M2 git spawns | Count `runGitBin` calls tagged repo-tracker over the 120 s window | 0 while hidden. ≤ 1 per repo per turn end |
| M3 main CPU | `app.getAppMetrics()` `type:'Browser'` `cpu.percentCPUUsage`, sampled at 1 Hz, mean over 120 s | ≤ 1 % mean under S-idle (ASSUMED target; the "before" number sets the bar) |
| M4 main RSS | `process.memoryUsage().rss` at the end of S-idle | No growth with hidden write volume |
| M5 catch-up latency | Time from show to `refreshedAt > shownAt` for every repo of the session | p50 ≤ 500 ms, p95 ≤ 1.5 s at 10k; ≤ 10 s hard at 100k |
| M6 turn-end latency | Time from OSC 7501 `done` to the renderer `state` carrying the new `repoGit` | ≤ 2 s at 10k |

- Harness: the new stress scenario on `test/e2e/stress/multi-repo-harness.mjs`, run remotely (`npm run e2e:remote`).
- Results are recorded in `docs/runs/<date>-demand-resources/report.md`.
- If M3's "before" number turns out already under 1 %, the CPU claim was wrong; the report says so and M1 and M2 become the headline.

## 9. Phase 2 (named): move watch and git into the Conduit server

**Scope:**
- The watch service, the repo engine and repo scanning run in the server.
- The app only subscribes to `repoDelta`, `fsChanged` and `repoGit` over C2.
- Visibility comes from the `ui.presence` the server already receives (`main.ts:2185-2200`).
- Turn-end comes straight from `ServerAttention.complete` (`server/attention/index.ts:246-248`) or hc's counter (`src/contracts/hc.ts:186`), not from a SessionView diff.

**What Phase 1 must keep compatible:**
1. `src/watch-service.ts` and `src/repo-tracker.ts` stay pure, with no Electron imports and injected `open`/timers. That lets them run unmodified in the server's Node.
2. Subscriptions are keyed by `(owner, sessionId)`, never by a `webContents` or window id. A window maps to sessions only at the edge (`gitDemand`).
3. Demand input is the same shape as `ui.presence`: per-window visible ids plus a minimized flag. Phase 1 must not add a second visibility channel.
4. The turn-end handler takes a session id and nothing app-specific, so its producer can move from the `sessionsApplied` diff to `ServerAttention`.
5. `repoDelta`, `RepoSnapshot` and `fsChanged` stay JSON-serializable, with no functions and no Maps, so they can cross C2 unchanged.
6. Open-file and LSP watches can stay app-side in Phase 2 (they serve app-only state). The service API must allow two instances, one per process, without shared globals.

## 10. Decisions Needed

| # | Sev | Question | Recommendation (default if unanswered) |
|---|---|---|---|
| D1 | MED | Should entry into `blocked` (the agent asking for approval mid-turn) also trigger a hidden refresh? | **No.** Blocked is not a completion (sidebar spec §4), and the user will open the session to answer it, which triggers the catch-up |
| D2 | MED | Rescan for new repos or worktrees at turn end (agents running `git worktree add` in lanes)? | **No** in the MVP; rescan on show. Revisit if the sidebar must list new worktrees of hidden sessions |
| D3 | MED | At app start, run a meta-only interrogation (2 s timeout, `GIT_TIMEOUT.metadata`) for hidden sessions, so their sidebar branch is filled before their first turn end or show? | **Yes**, staggered at the concurrency cap and low priority. Without it a restored hidden session shows no branch until opened (code: hidden repos never run, `repo-tracker.ts:125-128`; whether persisted `repoGit` fills the gap is ASSUMED) |
| D4 | LOW | `RELEASE_GRACE_MS` | 5 s |
| D5 | LOW | `BACKGROUND_MIN_INTERVAL_MS` per repo | 10 s, with a trailing run |
| D6 | MED | A hidden but resident LSP keeps its root watch for up to 10 min (`DORMANT_MS`). Shorten the hidden lifetime instead? | **Keep.** Correctness of the server's index beats one shared handle. Revisit with M1 data |
| D7 | LOW | Plans watcher (W5): keep per open project, or limit to shown sessions and open plan tabs? | **Keep** (non-recursive, 1 handle per project). Agents edit plans in background projects, and whether the plan store re-reads on show is unverified |
| D8 | LOW | Skip the show-time `meta` when the repo was refreshed after the session's last output? | **Not in the MVP.** The app lacks `lastOutputAt` (it lives in the server); add it in Phase 2 |
| D9 | LOW | Evict cached snapshot `changes` for repos with no shown session (`mem-main-server` #5)? | Out of MVP. Follow-up once M4 has numbers |
| D10 | LOW | `watchFiles` scope: all file tabs of shown sessions, or only each group's active tab? | **All tabs of shown sessions.** A dirty background tab still needs its conflict signal |
