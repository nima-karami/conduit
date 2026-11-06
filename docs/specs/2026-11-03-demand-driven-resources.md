---
status: active
date: 2026-11-03
tier: FULL
---

# Feature Spec: Demand-driven resources (watchers and git follow what is on screen)

**Tier:** FULL · **Type:** host resource lifecycle (main process), no new UI · **Rev:** 2 (see Revision log)

**Supersedes:** the clause in multi-repo-tracking §2 that background sessions stay subscribed, cited at `electron/session-folder-runtime.ts:138-140`. That spec's engine, union rule and tracked set stay.

**Related:** ADR 0007, `2026-10-16-multi-repo-tracking.md`, `archive/2026-10-08-language-coverage.md` §2.6 (LSP residency), `.autoloop/mem-*.md`.

## 1. Problem and scope

The app is becoming a set of views. A terminal view attaches to a PTY the server holds, and an editor view attaches to a file. Files, Changes/Review and git have not caught up. A session nobody is looking at still holds recursive OS watches, and those keep feeding the repo engine. With N background agents writing, the main process pays for N trees that nothing renders.

**Direction (decided by the user):**
- If no view is attached, nothing is watched.
- A hidden session holds **no file watch** and runs **no git**.
- Its git state refreshes **when its agent finishes a turn**.
- Showing it runs **one short catch-up**.
- A minimized window counts as hidden.
- Home directories and drive roots are never watched recursively.

**Phasing (decided):**
- **Phase 1 (this MVP):** gate the **existing** watchers inside the app's main process. No new watch service.
- **Phase 2:** a single shared, ref-counted watch and git service **inside the Conduit server**, so the app is purely a view (§9).

**Evidence:**
- **(code)** means read in this tree at the cited `file:line`.
- **ASSUMED** means not verified.
- Nothing was executed; §8 is the measurement plan.

## 2. Current behaviour (inventory, code)

### 2.1 Watch creation sites

`watchDir` / `watchDirWhilePresent` are at `electron/watch-dir.ts:49,91`. A missing dir is polled every 2 s (`:16,114-119`).

| # | Watch (created at) | Lifetime | Hidden session |
|---|---|---|---|
| W1 | ProjectWatcher, recursive per root, nested folders folded (`electron/project-watcher.ts:74,100`; `main.ts:1775`) | `watchEntries()` (`electron/session-folder-runtime.ts:127-149`) = window's requested project (`:128-133`, even minimized) ∪ visible sessions (`:134-137`) ∪ **every session with repos, visible or not** (`:141-147`) | **Watched** if it has repos |
| W2 | git-dir watch on a repo's common `.git` when no W1 covers it (`src/repo-tracker.ts:161-178` → `electron/repo-tracker-host.ts:107-123`) | Every registered repo, **no eligibility check** (`:162-165`) | Watched when the main `.git` is outside its folders |
| W3 | LSP root watch, recursive (`electron/lsp-watcher.ts:89`; `electron/lsp-manager.ts:911-922`) | Server process life (`:258,981,1021`): ≤ 10 min hidden (`DORMANT_MS`), or evicted 60 s after hide over cap (`src/lsp-residency.ts:6-9,33-39`) | Watched while resident; a second OS watch on W1's root |
| W4 | OpenFileWatcher, parent dir of each open file (`electron/open-file-watcher.ts:61-94`) | **Every** file tab in the window (`webview/app.tsx:2180-2189`). `setPaths` **replaces** one global set (`:58-61`) per window's post (`main.ts:2898-2903`), so with two windows the last poster wins (runtime impact ASSUMED) | Watched |
| W5 | PlanWatcher, non-recursive `.conduit/plans/` (`main.ts:1736-1742`; `electron/plan-watcher.ts:68-72`) | One per opened project; dropped with its last session (`main.ts:2251-2259`) | Watched (tiny) |
| W6 | Board / Proposal / Notes (`main.ts:3673`, `:2107`, `:3140`) | One active project | n/a |

### 2.2 Git, scans, indexes

- **Repo engine:** runs only for repos with a visible session (`eligible`, `src/repo-tracker.ts:123-128`, `src/repo-refresh-scheduler.ts:88-91`). For hidden sessions, W1/W2 events still **mark** and classify paths (`repo-tracker.ts:134-139,276-286`). The marks are parked, so that work has no result.
- **Coverage:** regaining it marks `tree` and invalidates the file index (`:371-375,380`); losing it marks `tree,meta` (`:376`). `snapshotOf` reports `stale` only while marks are pending (`:180-181`).
- **Fan-out:** `publish` → `mergeRepoGit` updates `Session.repoGit` for every session of the repo (`repo-tracker-host.ts:86-95`). `repoDelta` goes only to windows showing the session (`:79-83`). `windowShown` is `sendFull`, then `visibilityChanged()` (`:164-167`).
- **Already deferred while hidden:** rescans (`main.ts:1415-1419`, run on show `:1296-1297,1466`), `fsChanged` via `pendingFsByWindow` (`:1748-1768`, replayed `:1299-1312`), auto project requests (`:2112-2127`), TS indexing (`:3567-3585`).
- **Quick-open index:** invalidated on every watched path, "not gated on visibility" (`repo-tracker.ts:74-76`, `main.ts:1371-1375`).
- **Renderer re-reads (already exist):** when a tab becomes visible (`app.tsx:2244-2253`), on focus or visibility (`:2422-2447`), and a session's diff tabs when it becomes active (`:2472-2474`).

### 2.3 How "visible" is known

- The renderer posts `visible` with its active and split ids (`app.tsx:1793-1797`). Main sends them to presence (`main.ts:3454-3456`, `ui.presence` `:2185-2200`), to `gitDemand.setVisible` (`:3458-3463`) and to `folders.visibilityChanged()` (`:3465`). That is the **only** `visibilityChanged()` call site, so minimize never re-arms folders.
- `src/session-resource-demand.ts`: a session is visible iff a non-suspended window lists it (`:12-15`). **Before the first report, everything counts as visible** (`:13`, `!reported ||`), so app start arms every session.
- Minimize → `setSuspended` (`main.ts:4610-4618`). Suspending fires `onHidden` synchronously (`session-resource-demand.ts:55-63` → `main.ts:1332-1337`). Restoring wakes `run` after 150 ms (`:17-25` → `main.ts:1296-1330`).
- Conduit never calls `BrowserWindow.hide()`. E2E windows are `show:false` (`main.ts:994`) and never minimize. An occluded window counts as visible (D11).

### 2.4 Turn-end signal (exists)

- `ServerAttention` adds one to `completions` per run end (`server/attention/index.ts:246-248`). A run ends either by a **reported** OSC 7501 `working → done|idle` (`:212-220`), or by a **heuristic** run end detected in `sweep` for programs that don't report (`:131-141`). The count resets on server restart (sidebar-agent-tree §4).
- The app gets `SessionView.completions` (`src/types.ts:113-114`) next to `runtime.reportedStatus` (`src/contracts/server-protocol.ts:105-110`, `src/contracts/session-identity.ts:96-97`). Today `applyServer` (`electron/app-session-store.ts:68-90`) diffs only home, cwd and roots.
- **Attention is file-system-free.** Its imports are runtime, last-line, activity and terminal-output only (`server/attention/index.ts:1-14`), and its inputs are runtime events (`:145-156`).

### 2.5 Memory-audit cross-references

This spec fixes `mem-main-server` #6 (hidden recursive watches), scales #2 (event floods) to what is shown, and leaves #5 (snapshots for every repo) to D9. Renderer memory is out of scope.

## 3. Target model (Phase 1)

### 3.1 Demand

**Shown(session)** ≡ `gitDemand.isVisible(id)`: listed by at least one non-minimized window. It is the single source for every gate below.

**Change (S2):** a window that has **not reported yet** contributes nothing. Before any report, nothing is shown: drop `!reported ||` at `session-resource-demand.ts:13,35,39`. App start arms nothing until the renderer's first `visible` post, which happens on mount (`app.tsx:1793-1797`). D3's staggered meta-only fill is the only git that runs at startup.

### 3.2 Gates on the existing watchers

**G1 — W1, hidden sessions.**
- Delete the `tracking` block (`session-folder-runtime.ts:141-147`). Replace the comment at `:138-140` with one line: `// Hidden sessions hold no watch (spec 2026-11-03-demand-driven-resources §3.2).`
- `projectsByWindow` entries count only while their window is not suspended. `SessionFolderRuntimeDeps` gains `isWindowSuspended(windowId)`, backed by a new `isSuspended` on `SessionResourceDemand`.
- `armsFor` (`:120-125`) uses the same rule.

**G2 — minimize wiring (B2).**
- `folders.visibilityChanged()` is also called from the demand's `onHidden` callback (`main.ts:1332-1337`). That runs synchronously on minimize, hide or drop, so the watch is released.
- It is also called from the `run` callback (`main.ts:1296-1330`) **before** `repoTrackerHost.tracker.visibilityChanged()`. That re-arms on restore or show, and the order means watches are live before any catch-up git starts.
- With G1, this makes AC-6 hold: a minimized window's sessions are neither in `visibleIds()` nor in `projectsByWindow`.

**G3 — W2.**
- `reconcileWatches` (`repo-tracker.ts:162-165`) adds a git-dir watch only for a repo that has a shown session (`[...repo.sessions].some(deps.isSessionVisible)`) and is not covered.
- It is re-run on `visibilityChanged()` (`:383-385`). Without this, dropping W1 for a hidden worktree session would **open** a W2 watch in its place.

**G4 — W4.**
- `watchFiles` gains window scope. The host keeps `Map<windowId, paths>` and calls `setPaths` with the union.
- A window's set is dropped on suspend and on close.
- The renderer reports only the file tabs of the sessions it shows: active plus split, from `docState.docs` filtered by `sessionId` (D10). This also fixes last-writer-wins.

**G5 — home and drive-root refusal.**
- One predicate, `isUnwatchableRoot(dir)`, is called before every **recursive** open: `ProjectWatcher.open` (`project-watcher.ts:98-100`), `watchServerRoot` (`lsp-watcher.ts:88-89`) and the host's `watchGitDir` (`repo-tracker-host.ts:107-108`).
- A refusal takes the existing failure path: lost, suspect, and the server's folder health. It is logged once per key.
- The predicate is the one the parallel lane F guard adds in `electron/session-folder-runtime.ts`. This spec moves it to a shared module only if the lane hasn't (exact name ASSUMED until that lane lands). It does not redesign it.

**G6 — W3 (S3), an accepted exception.**
- A resident LSP keeps its root watch while hidden, for at most `DORMANT_MS` (10 min), or less when evicted.
- Closing it on hide is **not** trivially safe. The server would miss `didChangeWatchedFiles` and hold a stale index. The only repair is restarting the server on show, which costs a cold start for rust-analyzer, clangd and the like.
- So AC-1 excludes it explicitly. M1 and M3 measure its cost. D6 may shorten the residency.

**W5 / W6:** unchanged (D7).

### 3.3 What replaces watching for a hidden session

| Surface | Shown | Hidden | Becomes current by |
|---|---|---|---|
| Changes / Review, header badge | W1 + engine | nothing | catch-up (§3.5) |
| Sidebar branch, session-icon `review` (`src/session-icon.ts:14,45`) | engine `publish` | nothing | turn-end (§3.4) and catch-up |
| Files tree | W1 → `fsChanged` | nothing | catch-up `fsChanged` |
| Open file / diff tabs | W4 | nothing | existing renderer re-reads (§2.2) |
| Quick open | `onDirty` | not invalidated | coverage regain (`repo-tracker.ts:373-375,380`) and turn-end `notifyDirty` |
| LSP | W3 | W3 (G6) | n/a |
| Attention / Done / Needs you | server, PTY-driven | unchanged | must stay file-system-free (AC-9) |

### 3.4 Turn-end refresh (hidden sessions)

**Producer (S5).**
- `applyServer` adds a diff kind, `{ sessionId, kind: 'turnEnded' }`. It is emitted when:
  - `completions` increased **and** `runtime.reportedStatus !== null` (the program reports OSC 7501); or
  - `status` changed `running → exited`.
- Plain shells and other non-reporting programs complete only heuristically. They are in the **idle bucket**: no turn-end refresh, so a run of shell commands cannot storm git. They catch up on show. D12 covers agents that don't report.
- A decrease of `completions` (server restart) resets the baseline and is never an edge.
- `sessionsApplied` (`main.ts:2270`) routes `turnEnded` to `repoTrackerHost.tracker.sessionTurnEnded(id)` when `!gitDemand.isVisible(id)`. A shown session's live watch already covers it.

**Consumer (S6).**
- `sessionTurnEnded` marks `meta` + `tree` with `MarkOptions.background: true` for each repo of the session that has no shown session. It also calls `notifyDirty(repo.key)`.
- The scheduler's `Entry` gains one flag, `background`. No separate timer is added; the existing `fire`, settle and cooldown paths honour it:
  - **fire:** `eligible(key) || e.background` decides whether the entry queues or parks (`repo-refresh-scheduler.ts:88-91`);
  - **cooldown:** while the repo is not eligible, a background entry's cooldown is `BACKGROUND_COOLDOWN_MS` = 10 s instead of 800 ms, so a mark inside the window arms at `lastStart + 10 s`. That is the trailing run (D5);
  - **priority:** `FOCUS_PRIORITY + 1`, behind every shown repo;
  - the flag clears when the run starts.
- `lines:false` holds, since no one has subscribed to line counts.
- Results take the normal path. `publish` → `mergeRepoGit` → `state` broadcast updates the sidebar branch and the `review` icon. The snapshot is cached for the next `sendFull`.
- The existing caps still apply: `REFRESH_CONCURRENCY` = 4 and the 10 s git timeout (`src/git-exec.ts:7`).
- Not done at turn end: rescans (D2), tree work, indexing.

### 3.5 Staleness and catch-up on show

**Stale (S1).**
- `Repo` gains `unshownSince?: number`. It is set when the repo loses its last shown session and cleared when one returns.
- `snapshotOf` reports `stale: true` when `repo.pending` **or** `unshownSince !== undefined`. While a repo has no shown session, its snapshot is always "as of `refreshedAt`" and never claims to be current, even right after a turn-end refresh: the agent may already be writing again.
- **The badge must not claim clean.** While `unshownSince` is set, a published `GitInfo` keeps `dirty: true` once it has been true. A hidden refresh that reads clean publishes `dirty` as `undefined` (unknown) instead of `false`, so no surface downgrades a dirty repo to clean while unwatched. The next shown refresh publishes the truth.

**Catch-up (S4).**
- Phase 1 has no grace window. A repo's watch is closed for the whole hidden interval, and anything written then raised no event. There is also a small gap between the `visible` post and the arm.
- So on show **every** repo with `unshownSince` set is marked `meta` + `tree`, `immediate`, **unconditionally**: no "nothing changed" skip in the MVP (D8). Ordering follows first fill (`repo-tracker.ts:257-274`): home and attached repos first, then nested repos by index mtime.

**Order of operations in `windowShown` (`repo-tracker-host.ts:164-167`):**
1. `tracker.sessionShown(ids)` marks the repos above. `unshownSince` stays set until a shown run lands, so they read stale.
2. `sendFull`. The cached snapshots arrive with `stale: true`.
3. `visibilityChanged()`.

Folders are already re-armed by G2 before `run` reaches the tracker.

**Other surfaces on show:**
- One `fsChanged` for the session's present roots goes to the showing window. FilesView re-reads what it has loaded; that it re-reads only expanded dirs is ASSUMED, and the e2e verifies it.
- Existing show work runs unchanged: deferred scans, project requests, indexes, the `pendingFsByWindow` replay, and the renderer's tab and diff re-reads.

**What the user sees:**
- The cached Changes/Review list appears at once with the existing stale label (`webview/components/changes-view.tsx:334`). It turns fresh in ≤ 500 ms p50 and ≤ 1.5 s p95 at 10k files.
- The bound is 10 s per repo, then the existing error with Retry (`main.ts:3471-3473`).
- No new UI. No empty flash.

### 3.6 States and transitions (per session)

| Transition | Effect |
|---|---|
| shown → hidden (tab switch, split closed, minimize, moved into a minimized window) | G2 releases the folders and G3 the git-dir watch. `unshownSince` is set on repos with no shown session left |
| hidden → shown | §3.5 |
| Window minimize / restore | `onHidden` / `run` (G2). `windowRestored` re-sends full snapshots (`repo-tracker-host.ts:168-170`) after the §3.5 marks |
| Same session shown in two windows | Union (`session-resource-demand.ts:12-15`). Folders are a deduped set (`session-folder-runtime.ts:151-153`), so there is one watch |
| Turn ends while hidden (reporting program) | §3.4 |
| Turn starts while hidden, or a plain shell finishes a command | Nothing |
| Session closed | `forgetSession` (`main.ts:2251-2267`). The repo drops with its last session (`repo-tracker.ts:316-326`) |
| Repo appears while hidden | Seen on show via the deferred rescan (D2) |
| Repo disappears while hidden | The turn-end or catch-up run hits the existing error path. The show rescan drops it |
| Folder deleted while watched | `watchDir` closes the handle on its self-rename loop (`watch-dir.ts:36-41,67-77`) → lost → `suspect` to the server (`session-folder-runtime.ts:168-189`). No poll runs once nothing requests the folder |
| Folder deleted while hidden | Nothing is watched, so nothing loops. Seen on show or by the server's health checks (ASSUMED as today) |
| App start | Nothing is armed before the first report (S2). Hidden sessions get only D3's meta fill |
| Server restart | Baseline reset. No `turnEnded` burst |

## 4. Edge cases

- **Huge repos.**
  - The catch-up is one `git status --porcelain -z --untracked-files=all` per repo (`src/project-info.ts:163`), capped at 10 s and 8 MB (`:37`), four at a time, home repo first.
  - A timeout keeps the last good snapshot plus an error (`repo-tracker.ts:225-229`). It is retried only on the next edge or show; there is no loop.
- **Nested repos.** One W1 watch on the ancestor serves them all, as today. The catch-up marks each repo once.
- **Worktrees.** G3 holds a W2 watch on the main `.git` only while a shown session needs it.
- **Network drives.** A watch may fail or drop events silently (ASSUMED). A failure falls back to the existing focus refresh (`project-watcher.ts:114`). Turn-end and catch-up need no watch.
- **Linux / macOS.** Node's recursive watch walks the tree there (ASSUMED). Without grace, a quick A→B→A switch re-arms. Windows is the primary target, so this is accepted in Phase 1. Phase 2's service adds grace. Unit tests inject `watch`, because CI runs on ubuntu.
- **Shared repo, one session shown and one hidden.** The shown session's watch and eligibility cover it. `unshownSince` is never set.

## 5. Producer / consumer changes

| Flow | Producer → consumer | Contract |
|---|---|---|
| `turnEnded` | `AppSessionStore.applyServer` → `sessionsApplied` → `tracker.sessionTurnEnded` | New diff kind, keyed by session id |
| Background mark | `RepoTracker` → `RefreshScheduler` | `MarkOptions.background`, `Entry.background`, `BACKGROUND_COOLDOWN_MS` |
| Stale / dirty | `snapshotOf`, `publish` → `changes-view.tsx:334`, `session-icon.ts`, `agent-tree.ts:264-267` | `stale` while unshown; `dirty` never downgraded while unshown |
| Show marks | `repoTrackerHost.windowShown` / `windowRestored` → tracker | `sessionShown(ids)` runs before `sendFull` |
| Folder arm | demand `onHidden` / `run`, and `visible` → `SessionFolderRuntime` | `visibilityChanged()` from all three; `isWindowSuspended` dependency |
| Open files | renderer `watchFiles` (per window, shown sessions only) → host per-window union → `OpenFileWatcher.setPaths` | `watchFiles` gains window scope |
| Attention | server | Unchanged |

## 6. Scope

**MVP (Phase 1):**
- G1–G6, S2, §3.4, §3.5.
- **Unit tests:**
  - invert `test/unit/session-folder-runtime.test.ts:169,198`;
  - tracker: no marks while hidden, the background flag, cooldown and trailing run, `unshownSince` stale and dirty, show marks before `sendFull`;
  - demand: hidden before the first report;
  - G5 refusal at all three call sites.
- **e2e** `test/e2e/demand-watch.e2e.mjs`, using the OSC 7501 helper from `test/e2e/sidebar-done-seen.e2e.mjs`.
- **Stress** `test/e2e/stress/hidden-sessions-idle.stress.mjs`.
- **`CHANGELOG.md`** line.

**Phase 2:** §9.

**Out of scope:**
- renderer memory (xterm rings, TS index, `files`/`diffs` caches; the mem lanes own these);
- web-tab guests;
- tracked/paused repo controls;
- new UI.

## 7. Acceptance criteria

**EARS**
- **AC-1:** While a session is hidden, the host shall hold no OS watch that exists only for it. The exceptions are a resident language server's root watch (G6, for at most `DORMANT_MS`) and W5.
- **AC-2:** While a session is hidden, the host shall spawn no git for its repos. The exceptions are AC-4 refreshes, D3's startup fill and an explicit Retry.
- **AC-3:** While a repo has no shown session, the repo engine shall record no watch-driven marks for it.
- **AC-4:** When a hidden session's reporting program finishes a turn, or its process exits, the host shall refresh each of its repos that has no shown session, without line counts, within 2 s plus git time. It shall run at most one such refresh per repo per 10 s, plus a trailing one.
- **AC-5:** When a session becomes shown, the host shall:
  - mark each of its repos that had no shown session;
  - send the cached snapshots with `stale: true`;
  - run one `meta` + `tree` refresh per such repo;
  - send one `fsChanged` for its roots.
- **AC-6:** When a window is minimized, the host shall release the watches of sessions shown only in that window, including its requested project. When it is restored, the host shall apply AC-5 to them.
- **AC-7:** While a repo has no shown session, no published `GitInfo` shall change its `dirty` from `true` to `false`.
- **AC-8:** When a watched folder is deleted, the host shall close its OS watch, mark it lost and poll it only while it is still requested.
- **AC-9:** The server's attention (Needs you, Done, `completions`) shall be identical with every watcher disabled.
- **AC-10:** If a recursive watch is requested on a home directory or drive root, the host shall refuse it at all three call sites and log the refusal once.
- **AC-11:** When two windows report open files, the host shall watch the union of their shown sessions' tabs.
- **AC-12:** Before any window has reported visibility, the host shall arm no session folders.
- **AC-13:** When a plain shell's command finishes in a hidden session, the host shall run no git.

**Gherkin**

```gherkin
Scenario: Hidden agent finishes a turn
  Given A is shown and B is hidden, each owning a repo
  And B's agent edits 3 files and reports OSC 7501 working then done
  Then no OS watch is held for B's folder
  And exactly one git status runs for B's repo after the done report
  And B's sidebar shows its branch and the Review state without opening B

Scenario: Catch-up on show
  Given B is hidden and its agent is still writing
  When the user opens B
  Then Changes renders the cached list at once, labelled stale
  And within 1.5 s it lists the new files and the label clears

Scenario: Minimize hides, restore catches up
  Given window W shows only session A
  When W is minimized and A's agent writes a file
  Then no fsChanged, mark or git run happens for A
  When W is restored
  Then A runs one catch-up and its Files tree shows the new file

Scenario: Plain shell does not storm git
  Given hidden session S runs a plain shell that runs 20 short commands
  Then no git runs for S's repos until S is shown
```

## 8. Measurement plan (before vs after, same build)

**S-idle.**
- 10 sessions, each home a repo of 5k files.
- 1 shown, 9 hidden.
- 3 hidden sessions write 20 files/s outside `node_modules` for 120 s; then each reports OSC 7501 working→done once.
- One hidden session has a live LSP (to measure G6).

**S-show.** Open each hidden session in turn, with repos of 1k, 10k and 100k files.

| Metric | How | Target (after) |
|---|---|---|
| M1 OS watches | count of `FSEventWrap` in `process.getActiveResourcesInfo()` (name ASSUMED), plus the watchers' own counts via an e2e hook | Independent of hidden count: shown folders + shown open-file dirs + resident LSP roots + W5. G6's share reported separately |
| M2 git spawns | `runGitBin` calls tagged repo-tracker | 0 while hidden; ≤ 1 per repo per turn end |
| M3 main CPU | `app.getAppMetrics()` `Browser` `cpu.percentCPUUsage`, 1 Hz, mean over 120 s | ≤ 1 % (ASSUMED bar, set by the "before" run). G6 measured on/off |
| M4 main RSS | `process.memoryUsage().rss` at the end | No growth with hidden write volume |
| M5 catch-up | show → `refreshedAt > shownAt` for all repos of the session | p50 ≤ 500 ms, p95 ≤ 1.5 s at 10k; ≤ 10 s at 100k |
| M6 turn-end | OSC 7501 done → the renderer `state` carries the new `repoGit` | ≤ 2 s at 10k |

- Run remotely (`npm run e2e:remote`), on `test/e2e/stress/multi-repo-harness.mjs`.
- Report in `docs/runs/<date>-demand-resources/report.md`.
- If the M3 "before" number is already ≤ 1 %, the report says so, and M1 and M2 become the headline.

## 9. Phase 2 (named, not designed): one watch and git service in the server

**Scope:**
- A single shared, ref-counted watch service, the user's "one file watcher instance", runs **inside the Conduit server**:
  - one OS watch per folder, with ancestor folding;
  - a release grace;
  - one `gone` fan-out;
  - the G5 refusal in one place;
  - `stats()`.
- **Owner set:** session folders (Files, Changes/Review), git dirs, and `.conduit` dirs (plans, board, proposal, notes). Open-file and LSP watches stay in the app, because they serve app-only state; they may later subscribe over C2.
- The repo engine and scans move with it.
- The app only receives `repoDelta`, `fsChanged` and `repoGit` over C2.
- **Inputs:**
  - demand from the `ui.presence` the server already receives (`main.ts:2185-2200`);
  - turn-end straight from `ServerAttention.complete` (`server/attention/index.ts:246-248`) or hc's counter (`src/contracts/hc.ts:186`).

**Phase 1 must keep compatible:**
1. `src/repo-tracker.ts` and `src/repo-refresh-scheduler.ts` stay pure: injected deps, no Electron imports.
2. Gates key on session ids and the demand object, never on `webContents`. Windows map to sessions only inside `SessionResourceDemand`.
3. Demand has a single input with the same shape as `ui.presence` (per-window ids plus suspended). No second visibility channel.
4. `sessionTurnEnded(id)` and `sessionShown(ids)` take session ids only, so their producers can move into the server.
5. `RepoSnapshot`, `repoDelta` and `fsChanged` stay plain JSON.
6. The G5 predicate is a pure function in `src/`, so the server can import it.

## 10. Decisions Needed

| # | Sev | Question | Recommendation (default) |
|---|---|---|---|
| D1 | MED | Refresh on entry into `blocked` mid-turn? | **No.** It is not a completion, and the user opens the session to answer, which triggers the catch-up |
| D2 | MED | Rescan for new repos or worktrees at turn end? | **No.** Rescan on show |
| D3 | MED | Staggered meta-only (`GIT_TIMEOUT.metadata`, 2 s) interrogation at startup for hidden sessions, so the sidebar branch is filled? | **Yes.** It is the only startup git (S2). Whether a persisted `repoGit` already fills the gap is ASSUMED |
| D5 | LOW | `BACKGROUND_COOLDOWN_MS` | 10 s, with a trailing run |
| D6 | MED | Shorten hidden LSP residency (now 10 min) to cut G6's cost? | Keep until M1 and M3 have numbers |
| D7 | LOW | Plans watcher scope: open projects (today) or shown sessions only? | **Keep.** Non-recursive, and agents edit plans in background projects |
| D8 | LOW | Skip the show catch-up when the repo was refreshed after the session's last output? | **Not in the MVP.** `lastOutputAt` lives in the server; revisit in Phase 2 |
| D9 | LOW | Evict cached `changes` for unshown repos (`mem-main-server` #5)? | Follow-up after M4 |
| D10 | LOW | `watchFiles` scope: all tabs of shown sessions, or each group's active tab only? | **All tabs of shown sessions.** A dirty background tab needs its conflict signal |
| D11 | LOW | An occluded (covered, not minimized) window counts as **visible** | **Keep.** Electron reports no occlusion on Windows without polling, and an occluded window is one Alt-Tab from view, so an instant catch-up matters more than the saving. Minimize is the explicit "not looking" signal |
| D12 | MED | Agents that don't report OSC 7501 fall into the idle bucket, so they get no turn-end refresh. Allow heuristic completions for non-shell launchers? | **No in the MVP.** Which CLIs report is unverified (ASSUMED: Claude Code via Conduit). List them in the run report; revisit if a common agent is silent |

(D4, grace period, moved to Phase 2.)

## Revision log

- **Rev 2 (2026-11-03), after the architecture review (verdict REVISE):**
  - B1: Phase 1 gates the existing watchers (G1–G6); the shared watch service moves to Phase 2 inside the server. B2: minimize wired through the demand's `onHidden`/`run`; `projectsByWindow` filtered by suspension.
  - S1: stale while unshown, marks before `sendFull`, `dirty` never downgraded. S2: hidden before the first report. S3: G6 is an accepted LSP exception. S4: unconditional show marks. S5: `turnEnded` diff, shells in the idle bucket. S6: one `background` entry flag.
  - N1: supersession comment. N2: D11.
- **Rev 1 (2026-11-03):** initial spec (5d4c7165).
